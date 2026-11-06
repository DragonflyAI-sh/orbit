import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { instructions, parseOutput, responsesTools } from "./model.ts";
import type { Item, Message, ModelPort, Step, ToolDef } from "./model.ts";
import type { PortStatus } from "./ports.ts";

// "Sign in with ChatGPT" token sharing, the method OpenClaw's OpenAI plugin uses: ChatGPT authorizes eligible
// Responses API calls on the subscription. ORBIT registers and keeps its own login, because every refresh
// replaces the token and a shared one would break whichever client refreshed second.
const ISSUER = "https://auth.openai.com";
const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const RESOURCE = "https://api.openai.com/v1";
const RESPONSES_URL = `${RESOURCE}/responses`;
const REDIRECT_URI = "http://localhost:8080/auth/callback";
const REGISTER_CLIENT = "dynamic_agent_client";
const SCOPE = "openid email profile resource.invoke chatgpt.tokens.use.direct offline_access";
const SHARING_SCOPES = ["chatgpt.tokens.use.direct", "chatpass.enable.request.direct"];
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const REFRESH_EARLY_MS = 5 * 60 * 1000;

export type Tokens = {
  access: string;
  refresh: string;
  expires: number;
  idToken: string;
  clientId: string;
  subject: string;
  email?: string;
  scope?: string;
};

export type Login =
  | { state: "signed-out" }
  | { state: "pending"; authorizeUrl: string; expiresAt: string }
  | { state: "signed-in"; email?: string; since: string }
  | { state: "failed"; detail: string; at: string };

type Fetch = typeof fetch;

export type TokenFile = { read(): Tokens | undefined; write(t: Tokens): void; persisted: boolean };

// Owner-only file in the service's private state directory.
export function tokenFile(dir: string | undefined): TokenFile {
  if (!dir) {
    let value: Tokens | undefined;
    return { read: () => value, write: (t) => void (value = t), persisted: false };
  }
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "chatgpt-auth.json");
  return {
    read: () => {
      try {
        return JSON.parse(readFileSync(file, "utf8")) as Tokens;
      } catch {
        return undefined;
      }
    },
    write: (t) => {
      writeFileSync(`${file}.new`, JSON.stringify(t), { mode: 0o600 });
      renameSync(`${file}.new`, file);
    },
    persisted: true,
  };
}

const b64url = (bytes: Buffer) => bytes.toString("base64url");
const decodePart = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; id_token?: string; token_type?: string; scope?: string; error?: unknown };

async function tokenRequest(fetcher: Fetch, form: Record<string, string>): Promise<TokenResponse> {
  const res = await fetcher(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok) {
    throw new Error(body.error === "invalid_grant" ? "ChatGPT connection expired or was revoked; sign in again" : `ChatGPT token ${form.grant_type} failed: HTTP ${res.status}`);
  }
  return body;
}

type Jwk = { kid?: string; kty: string; n?: string; e?: string };

// Verifies the ID token's RS256 signature against OpenAI's published keys, then its claims.
export async function verifyIdToken(fetcher: Fetch, idToken: string, clientId: string, nonce: string | undefined, now: number) {
  const [h, p, s] = idToken.split(".");
  if (!h || !p || !s) throw new Error("ChatGPT returned a malformed identity token");
  const header = decodePart(h) as { alg?: string; kid?: string };
  if (header.alg !== "RS256") throw new Error("ChatGPT identity token uses an unexpected algorithm");
  const keys = ((await (await fetcher(JWKS_URL)).json()) as { keys?: Jwk[] }).keys ?? [];
  const jwk = keys.find((k) => k.kid === header.kid) ?? (keys.length === 1 ? keys[0] : undefined);
  if (!jwk) throw new Error("No OpenAI signing key matches the identity token");
  const ok = verify("RSA-SHA256", Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(s, "base64url"));
  if (!ok) throw new Error("ChatGPT identity token signature is invalid");
  const claims = decodePart(p) as { iss?: string; aud?: string | string[]; azp?: string; sub?: string; exp?: number; nonce?: string; email?: string };
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== ISSUER || !audiences.includes(clientId) || (claims.azp && claims.azp !== clientId)) {
    throw new Error("ChatGPT identity token was not issued to ORBIT");
  }
  if (!claims.sub || !claims.exp || claims.exp * 1000 < now) throw new Error("ChatGPT identity token is expired or has no subject");
  if (nonce !== undefined && claims.nonce !== nonce) throw new Error("ChatGPT identity token nonce does not match this sign-in");
  return claims;
}

type StreamItem = { type: string; content?: { type: string; text: string }[]; call_id?: string; name?: string; arguments?: string };
type ResponsesEvent = { type?: string; delta?: string; item?: StreamItem; response?: { output?: StreamItem[] } };

// Text and function calls from a streamed response. Calls come from the completed response, or from per-item
// events when the stream ends without one.
export function stepFromStream(raw: string): Step {
  let deltas = "";
  let completed: StreamItem[] | undefined;
  const items: StreamItem[] = [];
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    let event: ResponsesEvent;
    try {
      event = JSON.parse(line.slice(5).trim());
    } catch {
      continue;
    }
    if (event.type === "response.output_text.delta" && event.delta) deltas += event.delta;
    if (event.type === "response.output_item.done" && event.item) items.push(event.item);
    if (event.type === "response.completed") completed = event.response?.output;
  }
  const calls = parseOutput(completed?.length ? completed : items).calls;
  return { text: textFromStream(raw) || deltas, calls };
}


// The Responses API streams server-sent events; collect the text.
export function textFromStream(raw: string): string {
  let deltas = "";
  let final = "";
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    let event: ResponsesEvent;
    try {
      event = JSON.parse(line.slice(5).trim());
    } catch {
      continue;
    }
    if (event.type === "response.output_text.delta" && event.delta) deltas += event.delta;
    if (event.type === "response.completed") {
      final = (event.response?.output ?? [])
        .filter((o) => o.type === "message")
        .flatMap((o) => o.content ?? [])
        .filter((c) => c.type === "output_text")
        .map((c) => c.text)
        .join("");
    }
  }
  return final || deltas;
}

export type ChatGPTModel = ModelPort & {
  login(): Login;
  startLogin(): Promise<Login>;
  finishLogin(callbackUrl: string): Promise<Login>;
};

export type ChatGPTOptions = { fetcher?: Fetch; now?: () => number };

export function chatgptModel(model: string, file: TokenFile, options: ChatGPTOptions = {}): ChatGPTModel {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const saved = file.read();
  let login: Login = saved ? { state: "signed-in", email: saved.email, since: new Date(now()).toISOString() } : { state: "signed-out" };
  let pending: { state: string; nonce: string; verifier: string; deadline: number } | undefined;
  let lastOk: string | undefined;
  let lastError: { at: string; detail: string } | undefined;
  let refreshing: Promise<Tokens> | undefined;
  const impl = `chatgpt-token-sharing/${model}`;
  const at = () => new Date(now()).toISOString();

  const credential = async (body: TokenResponse, clientId: string, nonce: string | undefined, previous?: Tokens): Promise<Tokens> => {
    const idToken = body.id_token ?? previous?.idToken;
    const refresh = body.refresh_token ?? previous?.refresh;
    if (!body.access_token || !refresh || !idToken || body.token_type?.toLowerCase() !== "bearer") {
      throw new Error("ChatGPT did not return a complete renewable login");
    }
    const claims = body.id_token ? await verifyIdToken(fetcher, idToken, clientId, nonce, now()) : decodePart(idToken.split(".")[1]);
    if (previous && claims.sub !== previous.subject) throw new Error("ChatGPT account changed during refresh; sign in again");
    const scope = body.scope ?? previous?.scope;
    const granted = new Set(scope?.split(/\s+/) ?? []);
    if (!granted.has("resource.invoke") || !SHARING_SCOPES.some((s) => granted.has(s))) {
      throw new Error("ChatGPT sign-in worked but token sharing was not granted; sign in again and allow it");
    }
    return {
      access: body.access_token,
      refresh,
      expires: now() + (body.expires_in ?? 3600) * 1000,
      idToken,
      clientId,
      subject: claims.sub,
      email: claims.email ?? previous?.email,
      scope,
    };
  };

  // One refresh at a time: a second concurrent refresh would reuse a token the first just replaced.
  const fresh = async (force = false): Promise<Tokens> => {
    const tokens = file.read();
    if (!tokens) throw new Error("not signed in to ChatGPT");
    if (!force && tokens.expires - REFRESH_EARLY_MS > now()) return tokens;
    refreshing ??= tokenRequest(fetcher, { grant_type: "refresh_token", client_id: tokens.clientId, refresh_token: tokens.refresh, resource: RESOURCE })
      .then((body) => credential(body, tokens.clientId, undefined, tokens))
      .then((t) => {
        file.write(t);
        return t;
      })
      .finally(() => (refreshing = undefined));
    return refreshing;
  };

  const call = (tokens: Tokens, body: string) =>
    fetcher(RESPONSES_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.access}`,
        "content-type": "application/json",
        accept: "text/event-stream",
        // OpenClaw sends this on token-sharing requests.
        "x-openai-chatpass-test": "codex-direct",
      },
      body,
    });

  // Before any call has been made: what can be checked on this machine alone, with no request to OpenAI. It says
  // the saved login looks complete and usable, never that the model answered. verifiedAt is when this local check
  // ran, not an inference time, so it never stands in for lastOk.
  const readiness = (): PortStatus => {
    const t = file.read();
    const checked = at();
    const down = (detail: string): PortStatus => ({ port: "model", state: "down", impl, detail, verifiedAt: checked });
    if (!t || typeof t.access !== "string" || !t.access || typeof t.refresh !== "string" || !t.refresh || !t.clientId || !t.idToken || !Number.isFinite(t.expires)) {
      return down("Saved ChatGPT login is incomplete; sign in again from the web page.");
    }
    const granted = new Set(t.scope?.split(/\s+/) ?? []);
    if (!granted.has("resource.invoke") || !SHARING_SCOPES.some((s) => granted.has(s))) {
      return down("Saved ChatGPT login lacks token sharing; sign in again from the web page.");
    }
    if (t.expires - REFRESH_EARLY_MS <= now()) {
      return { port: "model", state: "degraded", impl, detail: "Signed in; the access token has expired or is about to. It will be renewed on the next call, which has not been tried, so ChatGPT is unconfirmed.", verifiedAt: checked };
    }
    return { port: "model", state: "live", impl, detail: "Signed in: saved ChatGPT login is complete and unexpired (checked locally). No model call has been made yet, so ChatGPT has not been contacted.", verifiedAt: checked };
  };

  return {
    login: () => login,

    // Starts a sign-in: a PKCE authorization link that also registers ORBIT as its own ChatGPT client.
    async startLogin(): Promise<Login> {
      if (login.state === "pending" && pending && pending.deadline > now()) return login;
      const verifier = b64url(randomBytes(32));
      pending = {
        verifier,
        state: b64url(randomBytes(24)),
        nonce: b64url(randomBytes(24)),
        deadline: now() + LOGIN_TIMEOUT_MS,
      };
      const url = new URL(AUTHORIZE_URL);
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: REGISTER_CLIENT,
        redirect_uri: REDIRECT_URI,
        resource: RESOURCE,
        scope: SCOPE,
        code_challenge: b64url(createHash("sha256").update(verifier).digest()),
        code_challenge_method: "S256",
        state: pending.state,
        nonce: pending.nonce,
        agent_name_hint: "ORBIT",
      }).toString();
      login = { state: "pending", authorizeUrl: url.toString(), expiresAt: new Date(pending.deadline).toISOString() };
      return login;
    },

    // Takes the localhost:8080 address the browser landed on after approving.
    async finishLogin(callbackUrl: string): Promise<Login> {
      try {
        if (!pending || pending.deadline < now()) throw new Error("No sign-in is in progress, or it expired. Start again.");
        let url: URL;
        try {
          url = new URL(callbackUrl.trim());
        } catch {
          throw new Error("That is not a URL. Paste the full address from the browser's address bar.");
        }
        const q = url.searchParams;
        if (q.get("state") !== pending.state) throw new Error("That address is from a different sign-in. Start again.");
        if (q.get("error")) throw new Error(q.get("error") === "access_denied" ? "ChatGPT authorization was declined." : `ChatGPT authorization failed: ${q.get("error")}`);
        const code = q.get("code");
        const ids = q.getAll("client_id");
        if (!code) throw new Error("The address has no authorization code.");
        if (ids.length !== 1 || !/^oaiapp_[A-Za-z0-9_-]+$/.test(ids[0])) throw new Error("ChatGPT returned an invalid client registration.");
        const body = await tokenRequest(fetcher, {
          grant_type: "authorization_code",
          client_id: ids[0],
          code,
          code_verifier: pending.verifier,
          redirect_uri: REDIRECT_URI,
          resource: RESOURCE,
        });
        const tokens = await credential(body, ids[0], pending.nonce);
        file.write(tokens);
        pending = undefined;
        login = { state: "signed-in", email: tokens.email, since: at() };
      } catch (err) {
        login = { state: "failed", detail: err instanceof Error ? err.message : String(err), at: at() };
      }
      return login;
    },

    status(): PortStatus {
      if (login.state === "pending") {
        return { port: "model", state: "down", impl, detail: "Waiting for sign-in: approve on ChatGPT, then paste the localhost address into ORBIT.", verifiedAt: at() };
      }
      if (!file.read()) {
        const why = login.state === "failed" ? ` Last sign-in failed: ${login.detail}` : "";
        return { port: "model", state: "down", impl, detail: `Not signed in to ChatGPT. Sign in from the web page.${why}`, verifiedAt: at() };
      }
      if (lastError && (!lastOk || lastError.at > lastOk)) {
        return { port: "model", state: "down", impl, detail: `Last call failed: ${lastError.detail}`, verifiedAt: lastError.at };
      }
      if (lastOk) return { port: "model", state: "live", impl, detail: "Answering through your ChatGPT subscription.", verifiedAt: lastOk };
      return readiness();
    },

    async step(input: Item[], limits: string[], notes: string | undefined, tools: ToolDef[]): Promise<Step> {
      const started = at();
      const body = JSON.stringify({
        model,
        instructions: instructions(limits, notes, tools.map((t) => `${t.name}: ${t.description}`)),
        input,
        ...(tools.length ? { tools: responsesTools(tools) } : {}),
        stream: true,
        store: false,
      });
      try {
        let res = await call(await fresh(), body);
        if (res.status === 401) res = await call(await fresh(true), body);
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          throw new Error(`HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
        }
        const step = stepFromStream(await res.text());
        if (!step.text && !step.calls.length) throw new Error("response had no text");
        lastOk = started;
        return step;
      } catch (err) {
        lastError = { at: started, detail: err instanceof Error ? err.message : String(err) };
        throw err;
      }
    },

    async reply(messages: Message[], limits: string[], notes?: string) {
      const started = at();
      const body = JSON.stringify({
        model,
        instructions: instructions(limits, notes),
        input: messages.map((m) => ({ role: m.role, content: m.content })),
        stream: true,
        store: false,
      });
      try {
        let res = await call(await fresh(), body);
        if (res.status === 401) res = await call(await fresh(true), body);
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          throw new Error(`HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
        }
        const text = textFromStream(await res.text());
        if (!text) throw new Error("response had no text");
        lastOk = started;
        return { value: text, provenance: "live" as const, source: `model/${impl}` };
      } catch (err) {
        lastError = { at: started, detail: err instanceof Error ? err.message : String(err) };
        throw err;
      }
    },
  };
}
