import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { instructions } from "./model.ts";
import type { Message, ModelPort } from "./model.ts";
import type { PortStatus } from "./ports.ts";

// Same sign-in OpenClaw uses: the Codex CLI's ChatGPT device-code flow. ORBIT keeps its own login,
// because each refresh replaces the token and a shared one would break whichever client refreshed second.
const AUTH = "https://auth.openai.com";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEVICE_CALLBACK = `${AUTH}/deviceauth/callback`;
const VERIFY_URL = `${AUTH}/codex/device`;
const RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const DEVICE_TIMEOUT_MS = 15 * 60 * 1000;
const REFRESH_EARLY_MS = 5 * 60 * 1000;

export type Tokens = { access: string; refresh: string; expires: number; accountId?: string };
export type Login =
  | { state: "signed-out" }
  | { state: "pending"; userCode: string; verificationUrl: string; expiresAt: string }
  | { state: "signed-in"; accountId?: string; since: string }
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

export function accountIdOf(access: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(access.split(".")[1], "base64url").toString("utf8"));
    return payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
  } catch {
    return undefined;
  }
}

const json = { "content-type": "application/json", accept: "application/json", originator: "codex_cli_rs" };

async function tokenRequest(fetcher: Fetch, form: Record<string, string>): Promise<Tokens> {
  const res = await fetcher(`${AUTH}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: unknown };
  if (!res.ok || !body.access_token) {
    const code = typeof body.error === "string" ? body.error : (body.error as { code?: string })?.code;
    throw new Error(`token ${form.grant_type} failed: HTTP ${res.status}${code ? ` ${code}` : ""}`);
  }
  return {
    access: body.access_token,
    refresh: body.refresh_token ?? form.refresh_token,
    expires: Date.now() + (body.expires_in ?? 3600) * 1000,
    accountId: accountIdOf(body.access_token),
  };
}

type ResponsesEvent = { type?: string; delta?: string; response?: { output?: { type: string; content?: { type: string; text: string }[] }[] } };

// The Codex endpoint streams server-sent events; collect the text.
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
};

export type ChatGPTOptions = { fetcher?: Fetch; now?: () => number; pollMs?: number };

export function chatgptModel(model: string, file: TokenFile, options: ChatGPTOptions = {}): ChatGPTModel {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  let login: Login = file.read() ? { state: "signed-in", accountId: file.read()?.accountId, since: new Date(now()).toISOString() } : { state: "signed-out" };
  let lastOk: string | undefined;
  let lastError: { at: string; detail: string } | undefined;
  let refreshing: Promise<Tokens> | undefined;
  const impl = `chatgpt/${model}`;

  // One refresh at a time: a second concurrent refresh would reuse a token the first just replaced.
  const fresh = async (force = false): Promise<Tokens> => {
    const tokens = file.read();
    if (!tokens) throw new Error("not signed in to ChatGPT");
    if (!force && tokens.expires - REFRESH_EARLY_MS > now()) return tokens;
    refreshing ??= tokenRequest(fetcher, { grant_type: "refresh_token", refresh_token: tokens.refresh, client_id: CLIENT_ID })
      .then((t) => {
        file.write(t);
        return t;
      })
      .finally(() => (refreshing = undefined));
    return refreshing;
  };

  const call = async (tokens: Tokens, body: string) =>
    fetcher(RESPONSES_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.access}`,
        ...(tokens.accountId ? { "chatgpt-account-id": tokens.accountId } : {}),
        "content-type": "application/json",
        accept: "text/event-stream",
        "openai-beta": "responses=experimental",
        originator: "codex_cli_rs",
      },
      body,
    });

  return {
    login: () => login,

    async startLogin(): Promise<Login> {
      if (login.state === "pending" && new Date(login.expiresAt).getTime() > now()) return login;
      const res = await fetcher(`${AUTH}/api/accounts/deviceauth/usercode`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ client_id: CLIENT_ID }),
      });
      if (!res.ok) throw new Error(`device code request failed: HTTP ${res.status}`);
      const body = (await res.json()) as { device_auth_id?: string; user_code?: string; usercode?: string; interval?: number };
      const userCode = body.user_code ?? body.usercode;
      if (!body.device_auth_id || !userCode) throw new Error("device code response was incomplete");
      const deadline = now() + DEVICE_TIMEOUT_MS;
      login = { state: "pending", userCode, verificationUrl: VERIFY_URL, expiresAt: new Date(deadline).toISOString() };
      const interval = options.pollMs ?? Math.max(3, body.interval ?? 5) * 1000;
      const deviceAuthId = body.device_auth_id;

      // Waits for Rai to enter the code, in the background.
      void (async () => {
        try {
          while (now() < deadline) {
            await new Promise((r) => setTimeout(r, interval));
            const poll = await fetcher(`${AUTH}/api/accounts/deviceauth/token`, {
              method: "POST",
              headers: json,
              body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
            });
            if (poll.status === 403 || poll.status === 404) continue;
            if (!poll.ok) throw new Error(`device authorization failed: HTTP ${poll.status}`);
            const grant = (await poll.json()) as { authorization_code?: string; code_verifier?: string };
            if (!grant.authorization_code || !grant.code_verifier) throw new Error("device authorization was incomplete");
            const tokens = await tokenRequest(fetcher, {
              grant_type: "authorization_code",
              code: grant.authorization_code,
              redirect_uri: DEVICE_CALLBACK,
              client_id: CLIENT_ID,
              code_verifier: grant.code_verifier,
            });
            file.write(tokens);
            login = { state: "signed-in", accountId: tokens.accountId, since: new Date(now()).toISOString() };
            return;
          }
          login = { state: "failed", detail: "The code expired before it was entered.", at: new Date(now()).toISOString() };
        } catch (err) {
          login = { state: "failed", detail: err instanceof Error ? err.message : String(err), at: new Date(now()).toISOString() };
        }
      })();
      return login;
    },

    status(): PortStatus {
      const at = new Date(now()).toISOString();
      if (login.state === "pending") {
        return { port: "model", state: "down", impl, detail: `Waiting for sign-in: enter ${login.userCode} at ${login.verificationUrl}.`, verifiedAt: at };
      }
      if (!file.read()) {
        const why = login.state === "failed" ? ` Last sign-in failed: ${login.detail}` : "";
        return { port: "model", state: "down", impl, detail: `Not signed in to ChatGPT. Sign in from the web page.${why}`, verifiedAt: at };
      }
      if (lastError && (!lastOk || lastError.at > lastOk)) {
        return { port: "model", state: "down", impl, detail: `Last call failed: ${lastError.detail}`, verifiedAt: lastError.at };
      }
      if (lastOk) return { port: "model", state: "live", impl, detail: "Answering through your ChatGPT subscription.", verifiedAt: lastOk };
      return { port: "model", state: "degraded", impl, detail: "Signed in, not exercised yet.", verifiedAt: new Date(0).toISOString() };
    },

    async reply(messages: Message[], limits: string[], notes?: string) {
      const at = new Date(now()).toISOString();
      const body = JSON.stringify({
        model,
        instructions: instructions(limits, notes),
        input: messages.map((m) => ({
          type: "message",
          role: m.role,
          content: [{ type: m.role === "user" ? "input_text" : "output_text", text: m.content }],
        })),
        stream: true,
        store: false,
      });
      try {
        let res = await call(await fresh(), body);
        if (res.status === 401) res = await call(await fresh(true), body);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = textFromStream(await res.text());
        if (!text) throw new Error("response had no text");
        lastOk = at;
        return { value: text, provenance: "live" as const, source: `model/${impl}` };
      } catch (err) {
        lastError = { at, detail: err instanceof Error ? err.message : String(err) };
        throw err;
      }
    },
  };
}
