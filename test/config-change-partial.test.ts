import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { proposals as newProposals, runChat } from "../src/agent.ts";
import type { ChatTool } from "../src/agent.ts";
import { chatTools } from "../src/chat-tools.ts";
import { chatgptModel, tokenFile } from "../src/chatgpt.ts";
import type { Tokens } from "../src/chatgpt.ts";
import { vaultMemory } from "../src/memory.ts";
import { openaiModel, responsesTools, strictSchema } from "../src/model.ts";
import type { ModelPort, ToolDef } from "../src/model.ts";
import { notifier } from "../src/notify.ts";
import { adminOps, type LedgerEntry } from "../src/ops-admin.ts";
import type { AdminClient, AdminReply } from "../src/ops-admin-client.ts";
import { ADMIN_CONFIG, type AdminConfig, type AdminEnv, type Exec, type Probe } from "../src/ops/admin-core.ts";
import { handle } from "../src/ops/admin-helper.ts";
import { CONFIG_KEYS, digestOf, parseAdminRequest, proposedConfigChanges } from "../src/ops/admin-protocol.ts";
import { runOperation } from "../src/ops/admin-run.ts";
import { jsonStore } from "../src/store.ts";
import { toolbox } from "../src/tools.ts";

// Model-only (partial) configuration proposals, from the schema a model is given through the proposal, the owner's confirmation and
// the privileged helper's runner on a synthetic host. The bug this guards: ops_propose_config_change reached the Responses API with
// optional settings and no strict flag; strict function schemas (the provider's documented default) make every property required,
// so a model asked to change only ORBIT_MODEL had to fill all five settings, and the "" it put in the others was refused. The fix
// sends an explicit strict schema whose settings are required-and-nullable (null = unchanged) and validates every absence form.
// Synthetic fixtures only: no production config is read or written, nothing is restarted, no model is called, and "gpt-6.2-sol" is
// just a well-formed name here (whether a provider serves it is not tested or claimed).

/* eslint-disable @typescript-eslint/no-explicit-any */

const part = (...p: string[]) => p.join("");
const TRIG = part("trig", "_", "abcdef123456");
const TRIG2 = part("trig", "_", "zyxwvu987654");
const SECRET_VALUE = part("sk", "-proj-", "Q".repeat(26));
const SHA_A = "a".repeat(40);
const MODEL = "gpt-6.2-sol";
const OTHERS = CONFIG_KEYS.filter((k) => k !== "ORBIT_MODEL");
const ALL_NULL = Object.fromEntries(CONFIG_KEYS.map((k) => [k, null]));
const MODEL_ONLY_STRICT = { changes: { ...ALL_NULL, ORBIT_MODEL: MODEL } };

// Every line a model-only change must leave alone: the four other settings (one holding trigger ids), HOST/PORT, an unrelated
// credential-shaped line, a comment and a blank line.
const ENV = [
  "# orbit.env (synthetic)",
  "HOST=127.0.0.1",
  "PORT=8790",
  "ORBIT_MODEL=gpt-6-astra",
  `ORBIT_ROUTINES=orbit=${TRIG},research=${TRIG2}`,
  "ORBIT_ROUTINE_REPOS=orbit=DragonflyAI-sh/orbit",
  "ORBIT_PUBLIC_JOB_URL=https://orbit-jobs.tail0000.ts.net",
  "ORBIT_INGRESS_PORT=8791",
  "",
  `ORBIT_SOMETHING_ELSE=${SECRET_VALUE}`,
  "",
].join("\n");

// A small JSON Schema checker for the subset these schemas use (type incl. "null" unions, required, additionalProperties,
// minimum/maximum): whether a model's arguments conform to the schema a transport sent.
function conforms(schema: any, v: unknown, path = "$"): string[] {
  const types: string[] = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const kind = v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v;
  if (types.length && !types.includes(kind) && !(kind === "integer" && types.includes("number"))) return [`${path}: ${kind} is not ${types.join("|")}`];
  const out: string[] = [];
  if (kind === "object") {
    const o = v as Record<string, unknown>;
    for (const r of schema.required ?? []) if (!(r in o)) out.push(`${path}.${r}: required`);
    for (const [k, x] of Object.entries(o)) {
      if (schema.properties?.[k]) out.push(...conforms(schema.properties[k], x, `${path}.${k}`));
      else if (schema.additionalProperties === false) out.push(`${path}.${k}: not allowed`);
    }
  }
  if (kind === "integer" || kind === "number") {
    if (schema.minimum !== undefined && (v as number) < schema.minimum) out.push(`${path}: below minimum`);
    if (schema.maximum !== undefined && (v as number) > schema.maximum) out.push(`${path}: above maximum`);
  }
  return out;
}

// ---- a synthetic host on disk (real temp directories, fake systemd and /status, fake clock), as the helper sees it ----

type Host = { root: string; cfg: AdminConfig; env: AdminEnv; served: { commit: string | undefined }; restarts: () => number; envText(): string; audit: object[]; onRestart?: (n: number) => void };

function host(envText = ENV): Host {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "orbit-partial-config-")));
  const root = join(base, "opt-orbit");
  const stateDir = join(base, "var-lib");
  for (const d of [join(root, "state"), join(root, "releases", SHA_A), stateDir]) mkdirSync(d, { recursive: true });
  writeFileSync(join(root, "releases", SHA_A, "COMMIT"), `${SHA_A}\n`);
  symlinkSync(join(root, "releases", SHA_A), join(root, "current"));
  writeFileSync(join(root, "orbit.env"), envText);
  chmodSync(join(root, "orbit.env"), 0o640);
  let t = Date.parse("2026-11-21T10:00:00Z");
  let restarts = 0;
  const cfg: AdminConfig = { ...ADMIN_CONFIG, root, stateDir, expectedUid: process.getuid!(), healthWindowMs: 10_000, healthIntervalMs: 1000, staleAfterMs: 30_000 };
  const h: Host = {
    root,
    cfg,
    served: { commit: SHA_A },
    audit: [],
    restarts: () => restarts,
    envText: () => readFileSync(join(root, "orbit.env"), "utf8"),
    env: {
      exec: async (file: string, args: string[]): Promise<Exec> => {
        if (file.endsWith("systemctl") && args[0] === "restart") {
          restarts++;
          h.onRestart?.(restarts);
        }
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      },
      probe: async (_host: string, _port: number, path: string): Promise<Probe> =>
        path === "/status" ? (h.served.commit ? { reachable: true, httpStatus: 200, commit: h.served.commit } : { reachable: false }) : { reachable: true, httpStatus: 401 },
      sleep: async (ms: number) => void (t += ms),
      now: () => new Date(t),
    },
  };
  return h;
}

// ORBIT's admin client, but connected straight to the real helper front (handle) instead of the socket: the request is validated
// exactly as adminClient does before it leaves ORBIT, and the helper's answer comes back as the client would return it.
function bridge(h: Host) {
  const requests: string[] = [];
  const client: AdminClient = {
    call: async (action, opId, changes): Promise<AdminReply> => {
      const request = JSON.stringify({ action, opId, ...(changes ? { changes } : {}) });
      parseAdminRequest(request);
      requests.push(request);
      const res = JSON.parse(await handle(request, h.env, () => {}, h.cfg));
      return res.ok ? { ok: true, data: res.data } : { ok: false, code: res.error.code, message: res.error.message };
    },
  };
  return { client, requests, mutations: () => requests.map((r) => JSON.parse(r)).filter((r) => r.action !== "op_status") };
}

function orbit(client?: AdminClient) {
  const store = jsonStore<LedgerEntry[]>(undefined, "ops-admin", []);
  const sent: string[] = [];
  const notify = notifier(jsonStore(undefined, "n", []));
  const send = notify.send.bind(notify);
  notify.send = (text: string, urgent?: boolean) => (sent.push(text), send(text, urgent));
  const proposals = newProposals();
  const admin = adminOps({ client, store, notify, proposals });
  const tools = chatTools({ memory: vaultMemory(mkdtempSync(join(tmpdir(), "v-"))), toolbox: toolbox([]), admin, notify, proposals: newProposals(), launchable: () => ({ routines: [] }) });
  const tool = tools.find((t) => t.name === "ops_propose_config_change")!;
  return { admin, store, proposals, tools, tool, sent };
}
const defOf = (t: ChatTool): ToolDef => ({ name: t.name, description: t.description, parameters: t.parameters, ...(t.strict ? { strict: true } : {}) });
const proposeVia = async (tool: ChatTool, args: Record<string, unknown>) => (await tool.run(args)).value as { proposalId: string; summary: string; settings: Record<string, string>; unchanged: string[]; digest: string; executed: boolean };
const runToEnd = (h: Host, opId: string) => runOperation(opId, "ops", h.env, h.cfg, (l) => h.audit.push(l));

// ---------------------------------------------------------------- the model-facing schema, per transport

test("schema: the canonical form names settings optionally; the strict Responses form makes each one required and nullable", () => {
  const { tool, tools } = orbit(bridge(host()).client);
  assert.equal(tool.strict, true, "sent as an explicit strict schema, not left to the provider's default");
  const canonical = tool.parameters as any;
  assert.deepEqual(canonical.required, ["changes"]);
  assert.equal(canonical.additionalProperties, false);
  assert.deepEqual(canonical.properties.changes.required, [], "no setting is required in the canonical form");
  assert.equal(canonical.properties.changes.additionalProperties, false, "unknown keys are not part of the schema");
  assert.deepEqual(Object.keys(canonical.properties.changes.properties), [...CONFIG_KEYS], "exactly the five allowlisted settings");

  const [sent] = responsesTools([defOf(tool)]) as any[];
  assert.equal(sent.strict, true);
  assert.deepEqual(sent.parameters.required, ["changes"]);
  const changes = sent.parameters.properties.changes;
  assert.equal(changes.type, "object", "`changes` itself stays required and not nullable");
  assert.deepEqual(changes.required, [...CONFIG_KEYS], "strict mode: every setting is listed in required…");
  assert.equal(changes.additionalProperties, false);
  for (const k of OTHERS.filter((k) => k !== "ORBIT_INGRESS_PORT")) assert.deepEqual(changes.properties[k].type, ["string", "null"], k);
  assert.deepEqual(changes.properties.ORBIT_MODEL.type, ["string", "null"], "…and nullable, so null is how a model says unchanged");
  assert.deepEqual(changes.properties.ORBIT_INGRESS_PORT.type, ["integer", "null"]);
  assert.equal(changes.properties.ORBIT_INGRESS_PORT.minimum, 1024);
  assert.equal(changes.properties.ORBIT_INGRESS_PORT.maximum, 65535);
  assert.deepEqual((tool.parameters as any).properties.changes.required, [], "serializing does not mutate the canonical schema");

  // What a model may send under each form. Under strict, a model-only change MUST carry the other four (that is the reported
  // failure); with null they conform. The canonical form takes the settings left out.
  assert.deepEqual(conforms(sent.parameters, MODEL_ONLY_STRICT), []);
  assert.notDeepEqual(conforms(sent.parameters, { changes: { ORBIT_MODEL: MODEL } }), []);
  assert.deepEqual(conforms(canonical, { changes: { ORBIT_MODEL: MODEL } }), []);
  // The canonical form has no null type (a transport using it leaves settings out); the validator accepts null all the same.
  assert.notDeepEqual(conforms(canonical, MODEL_ONLY_STRICT), []);
  assert.deepEqual(proposedConfigChanges(MODEL_ONLY_STRICT.changes), proposedConfigChanges({ ORBIT_MODEL: MODEL }));
  assert.notDeepEqual(conforms(sent.parameters, { changes: null }), []);
  assert.notDeepEqual(conforms(sent.parameters, { changes: { ...ALL_NULL, ORBIT_OWNER: "x" } }), []);

  // The metadata says how partial changes work and what health does not prove.
  assert.match(tool.description, /every setting left out or null stays exactly as it is/);
  assert.match(tool.description, /Never send "" or a masked value/);
  assert.match(tool.description, /not that a new ORBIT_MODEL can answer/);
  assert.match(tool.description, /does NOT do it/);
  for (const k of CONFIG_KEYS) assert.match(changes.properties[k].description, /Null or left out: unchanged/, k);

  // Every tool ORBIT offers still serializes (no strict schema is left half-converted).
  assert.doesNotThrow(() => responsesTools(tools.map(defOf)));
});

test("strictSchema converts nested objects recursively and refuses a nested object it cannot make strict", () => {
  const nested = { type: "object", properties: { o: { type: "object", properties: { a: { type: "string" }, b: { type: "integer" } }, required: ["a"], additionalProperties: false }, p: { type: "object", properties: { c: { type: "boolean" } }, additionalProperties: false } }, required: ["o"], additionalProperties: false };
  const s = strictSchema("t", nested) as any;
  assert.deepEqual(s.required, ["o", "p"]);
  assert.equal(s.properties.o.type, "object");
  assert.deepEqual(s.properties.o.required, ["a", "b"]);
  assert.equal(s.properties.o.properties.a.type, "string", "a required inner property is unchanged");
  assert.deepEqual(s.properties.o.properties.b.type, ["integer", "null"]);
  assert.deepEqual(s.properties.p.type, ["object", "null"], "an optional nested object is nullable");
  assert.deepEqual(s.properties.p.required, ["c"]);
  assert.throws(() => strictSchema("t", { type: "object", properties: { o: { type: "object", properties: { a: { type: "string" } } } }, additionalProperties: false }), /property o: a strict schema must be an object with additionalProperties false/);
  assert.throws(() => strictSchema("t", { type: "object", properties: { o: { type: "object", properties: { a: {} }, additionalProperties: false } }, additionalProperties: false }), /property o\.a has no type/);
});

// ---------------------------------------------------------------- through the real adapters and runChat

const event = (e: unknown) => `data: ${JSON.stringify(e)}\n\n`;
function adapter(kind: "chatgpt" | "openai", calls: unknown[]) {
  const bodies: any[] = [];
  let i = 0;
  const answer = () => {
    const args = calls[i++];
    return args === undefined ? [{ type: "message", content: [{ type: "output_text", text: "Done." }] }] : [{ type: "function_call", call_id: `call_${i}`, name: "ops_propose_config_change", arguments: JSON.stringify(args) }];
  };
  if (kind === "openai") {
    const fetcher = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ output: answer() }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    return { model: openaiModel("gpt-6-astra", ["test", "key", "x".repeat(8)].join("-"), fetcher), bodies };
  }
  const file = tokenFile(undefined);
  const tokens: Tokens = { access: "access-0", refresh: "refresh-0", expires: Date.now() + 36_000_000, idToken: `h.${Buffer.from(JSON.stringify({ sub: "user-1" })).toString("base64url")}.s`, clientId: "oaiapp_x", subject: "user-1", scope: "openid resource.invoke chatgpt.tokens.use.direct offline_access" };
  file.write(tokens);
  const fetcher = (async (url: string, init: RequestInit) => {
    if (!String(url).endsWith("/responses")) return new Response("", { status: 404 });
    bodies.push(JSON.parse(String(init.body)));
    return new Response(event({ type: "response.completed", response: { output: answer() } }), { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return { model: chatgptModel("gpt-6-astra", file, { fetcher }) as ModelPort, bodies };
}
const outputsOf = (body: any) => body.input.filter((x: any) => x.type === "function_call_output").map((x: any) => JSON.parse(x.output));

for (const kind of ["chatgpt", "openai"] as const) {
  test(`tool loop (${kind}, strict Responses schema): a model-only change with null for the rest proposes ORBIT_MODEL alone; "" and masked values are refused`, async () => {
    const h = host();
    const b = bridge(h);
    const o = orbit(b.client);
    const variants = [
      MODEL_ONLY_STRICT,
      { changes: { ...ALL_NULL, ORBIT_MODEL: MODEL, ORBIT_ROUTINES: "" } },
      { changes: { ...ALL_NULL, ORBIT_MODEL: MODEL, ORBIT_ROUTINES: "orbit=trig_…3456" } },
      { changes: ALL_NULL },
    ];
    const a = adapter(kind, variants);
    const out = await runChat({ model: a.model, messages: [{ role: "user", content: "switch ORBIT to gpt-6.2-sol" }], limits: [], tools: [o.tool] });
    assert.equal(out.text, "Done.");
    const wire = a.bodies[0].tools.find((t: any) => t.name === "ops_propose_config_change");
    assert.equal(wire.strict, true, "the wire carried the strict schema the arguments were generated against");
    for (const v of variants) assert.deepEqual(conforms(wire.parameters, v), [], JSON.stringify(v));
    const outs = outputsOf(a.bodies.at(-1));
    assert.equal(outs.length, variants.length);
    const [ok, empty, masked, none] = outs;
    assert.equal(ok.ok, true, ok.error);
    assert.deepEqual(ok.result.settings, { ORBIT_MODEL: MODEL });
    assert.deepEqual(ok.result.unchanged, OTHERS);
    assert.equal(ok.result.executed, false);
    assert.equal(empty.ok, false);
    assert.match(empty.error, /ORBIT_ROUTINES is empty.*leave it out or send null/);
    assert.equal(masked.ok, false);
    assert.match(masked.error, /ORBIT_ROUTINES looks like a masked display value/);
    assert.equal(none.ok, false);
    assert.match(none.error, /Nothing to change/);
    assert.equal(o.proposals.peek(ok.result.proposalId)?.kind, "ops_admin", "exactly the valid request became a proposal");
    assert.equal(b.requests.length, 0, "proposing never reaches the helper");
    assert.equal(h.envText(), ENV);
  });
}

// ---------------------------------------------------------------- proposal semantics

test("omitted and null mean the same thing: same validated changes, same digest, same preview", () => {
  const omitted = proposedConfigChanges({ ORBIT_MODEL: MODEL });
  const nulled = proposedConfigChanges({ ...ALL_NULL, ORBIT_MODEL: MODEL });
  assert.deepEqual(omitted, { ORBIT_MODEL: MODEL });
  assert.deepEqual(nulled, omitted);
  assert.ok(!Object.values(nulled).includes(null as never), "no null reaches the digest, the ledger or the helper");
  assert.equal(digestOf("apply_config", { changes: nulled }), digestOf("apply_config", { changes: omitted }));
  const { admin } = orbit();
  const p = admin.propose("apply_config", { changes: { ...ALL_NULL, ORBIT_MODEL: MODEL } });
  assert.equal(
    p.summary,
    `Change orbit.env: ORBIT_MODEL=${MODEL}. Unchanged: ORBIT_ROUTINES, ORBIT_ROUTINE_REPOS, ORBIT_PUBLIC_JOB_URL, ORBIT_INGRESS_PORT. Every other line of orbit.env is kept byte for byte. The old file is backed up, ORBIT restarts, and /status must be healthy within 60 seconds or the backup is restored. A healthy /status shows ORBIT restarted, not that the new model answers: check that separately with a real reply.`,
  );
  assert.deepEqual(p.display, { ORBIT_MODEL: MODEL });
});

test("empty and no-change requests are refused with a clear message and create nothing", async () => {
  const b = bridge(host());
  const o = orbit(b.client);
  for (const changes of [{}, ALL_NULL, { ORBIT_MODEL: null }]) {
    assert.throws(() => o.admin.propose("apply_config", { changes }), /Nothing to change: every setting was left out or null\. No proposal was made\./);
    await assert.rejects(() => o.tool.run({ changes }), /Nothing to change/);
  }
  for (const changes of [undefined, null, [], "ORBIT_MODEL=x", 5]) assert.throws(() => o.admin.propose("apply_config", { changes }), /changes must be an object/);
  await assert.rejects(() => o.tool.run({}), /changes must be an object/);
  assert.equal(b.requests.length, 0);
  assert.deepEqual(o.store.read(), []);
});

test('empty strings, blanks and masked placeholders are never "unchanged": each is refused, saying how to keep the setting', () => {
  const { admin } = orbit();
  for (const k of OTHERS.filter((k) => k !== "ORBIT_INGRESS_PORT")) {
    for (const v of ["", "   ", "\t"]) assert.throws(() => admin.propose("apply_config", { changes: { ORBIT_MODEL: MODEL, [k]: v } }), new RegExp(`${k} is empty\\. An empty value never means "unchanged"`), `${k}=${JSON.stringify(v)}`);
  }
  assert.throws(() => admin.propose("apply_config", { changes: { ORBIT_MODEL: "" } }), /ORBIT_MODEL is empty/);
  assert.throws(() => admin.propose("apply_config", { changes: { ORBIT_MODEL: MODEL, ORBIT_INGRESS_PORT: "" } }), /ORBIT_INGRESS_PORT is empty/);
  for (const v of ["orbit=trig_…3456", "orbit=trig_...3456", "orbit=***", "[redacted]", "orbit=[REDACTED]"]) {
    assert.throws(() => admin.propose("apply_config", { changes: { ORBIT_MODEL: MODEL, ORBIT_ROUTINES: v } }), /ORBIT_ROUTINES looks like a masked display value/, v);
  }
  // What orbit_config_view and a card show for ORBIT_ROUTINES can never be sent back as a value.
  const shown = admin.propose("apply_config", { changes: { ORBIT_ROUTINES: `orbit=${TRIG}` } }).display!.ORBIT_ROUTINES!;
  assert.ok(!shown.includes(TRIG));
  assert.throws(() => admin.propose("apply_config", { changes: { ORBIT_ROUTINES: shown } }), /masked display value/);
});

test("malformed model names are refused; well-formed ones are accepted as names, not as evidence a provider serves them", () => {
  const { admin } = orbit();
  for (const v of ["gpt 6", "gpt-6;reboot", "-gpt", ".gpt", "a".repeat(65), "gpt-6\n", `${MODEL}\nORBIT_OWNER=x`, "gpt/6", "gpt$6", "gpt-6#x", "gpt-6.2-sól"]) {
    assert.throws(() => admin.propose("apply_config", { changes: { ORBIT_MODEL: v } }), /ORBIT_MODEL/, JSON.stringify(v));
  }
  for (const v of [5, true, {}, ["gpt-5"]]) assert.throws(() => admin.propose("apply_config", { changes: { ORBIT_MODEL: v } }), /ORBIT_MODEL/, JSON.stringify(v));
  for (const v of [MODEL, "gpt-5", "vendor:model-1.2_x", "a".repeat(64)]) assert.deepEqual(proposedConfigChanges({ ORBIT_MODEL: v }), { ORBIT_MODEL: v });
});

test("unknown keys are refused, even when null, and even when every known setting is valid", () => {
  const { admin } = orbit();
  for (const changes of [{ ORBIT_MODEL: MODEL, HOST: null }, { ...ALL_NULL, ORBIT_MODEL: MODEL, ORBIT_OWNER: "x" }, { orbit_model: MODEL }, JSON.parse(`{"ORBIT_MODEL":"${MODEL}","__proto__":null}`), { ORBIT_MODEL: MODEL, ORBIT_MODEL_CAPABILITIES: null }]) {
    assert.throws(() => admin.propose("apply_config", { changes }), /is not a setting this action may change/, JSON.stringify(changes));
  }
});

test("a mixed request with one invalid value is refused as a whole: nothing is proposed, dispatched or written", async () => {
  const h = host();
  const b = bridge(h);
  const o = orbit(b.client);
  for (const changes of [
    { ...ALL_NULL, ORBIT_MODEL: MODEL, ORBIT_INGRESS_PORT: 80 },
    { ORBIT_MODEL: MODEL, ORBIT_ROUTINE_REPOS: "orbit=../etc" },
    { ORBIT_MODEL: MODEL, ORBIT_PUBLIC_JOB_URL: "http://orbit-jobs.tail0000.ts.net" },
    { ORBIT_MODEL: MODEL, ORBIT_ROUTINES: "" },
    { ORBIT_MODEL: "bad model", ORBIT_ROUTINE_REPOS: "orbit=DragonflyAI-sh/orbit" },
  ]) {
    await assert.rejects(() => o.tool.run({ changes }), Error, JSON.stringify(changes));
  }
  assert.equal(b.requests.length, 0);
  assert.deepEqual(o.store.read(), []);
  assert.equal(h.envText(), ENV);
});

// ---------------------------------------------------------------- through confirmation and the helper, on a synthetic host

test("end to end: a model-only change leaves routine ids, repositories, URL, port and every other line intact, and is verified after the restart", async () => {
  const h = host();
  const b = bridge(h);
  const o = orbit(b.client);
  const v = await proposeVia(o.tool, MODEL_ONLY_STRICT);
  assert.deepEqual(v.settings, { ORBIT_MODEL: MODEL });
  assert.equal(b.requests.length, 0, "nothing reaches the helper before the owner confirms");
  assert.equal(h.envText(), ENV);

  const res = await o.admin.confirm(o.proposals.take(v.proposalId) as any);
  assert.equal(res.code, 202);
  assert.equal((res.body as any).verified, false, "a dispatch is not a verification");
  assert.equal(b.mutations().length, 1);
  assert.deepEqual(b.mutations()[0].changes, { ORBIT_MODEL: MODEL }, "the helper receives only the changed setting: no null, no empty, no masked value");

  const rec = (await runToEnd(h, b.mutations()[0].opId))!;
  assert.equal(rec.state, "verified", rec.summary);
  assert.equal(h.envText(), ENV.replace("ORBIT_MODEL=gpt-6-astra", `ORBIT_MODEL=${MODEL}`), "only the ORBIT_MODEL line changed");
  for (const line of ENV.split("\n").filter((l) => !l.startsWith("ORBIT_MODEL="))) assert.ok(h.envText().split("\n").includes(line), line);
  assert.equal(readFileSync(join(h.root, "state", `env-backup-${rec.opId.slice(0, 12)}.env`), "utf8"), ENV, "the backup is the old file byte for byte");
  assert.equal(h.restarts(), 1);

  await o.admin.refresh();
  const [entry] = o.store.read();
  assert.equal(entry!.state, "verified");
  assert.equal(o.sent.length, 1, "the outcome is reported once");
  const everything = JSON.stringify([o.store.read(), o.sent, rec, h.audit, res, v]);
  for (const s of [TRIG, TRIG2, SECRET_VALUE]) assert.ok(!everything.includes(s), "trigger ids and unrelated values never leave orbit.env");
});

test("confirmation is required: an unconfirmed or altered proposal changes nothing on the host", async () => {
  const h = host();
  const b = bridge(h);
  const o = orbit(b.client);
  const v = await proposeVia(o.tool, MODEL_ONLY_STRICT);
  const forged = await o.admin.confirm({ ...o.proposals.take(v.proposalId)!, digest: "0".repeat(64) } as any);
  assert.equal(forged.code, 409);
  const w = await proposeVia(o.tool, MODEL_ONLY_STRICT);
  const widened = await o.admin.confirm({ ...o.proposals.take(w.proposalId)!, digest: digestOf("apply_config", { changes: { ORBIT_MODEL: MODEL, ORBIT_ROUTINE_REPOS: "orbit=x/y" } }) } as any);
  assert.equal(widened.code, 409, "a digest for a wider change than the one validated is refused");
  assert.equal(b.requests.length, 0);
  assert.equal(h.envText(), ENV);
  assert.equal(h.restarts(), 0);
});

test("end to end: a real multi-key change still works and changes exactly the named settings", async () => {
  const h = host();
  const b = bridge(h);
  const o = orbit(b.client);
  const v = await proposeVia(o.tool, { changes: { ...ALL_NULL, ORBIT_MODEL: MODEL, ORBIT_ROUTINE_REPOS: "orbit=DragonflyAI-sh/orbit,research=DragonflyAI-sh/orbit-work", ORBIT_INGRESS_PORT: 8792 } });
  assert.deepEqual(v.unchanged, ["ORBIT_ROUTINES", "ORBIT_PUBLIC_JOB_URL"]);
  assert.match(v.summary, /^Change orbit\.env: ORBIT_MODEL=gpt-6\.2-sol, ORBIT_ROUTINE_REPOS=orbit=DragonflyAI-sh\/orbit,research=DragonflyAI-sh\/orbit-work, ORBIT_INGRESS_PORT=8792\. Unchanged: ORBIT_ROUTINES, ORBIT_PUBLIC_JOB_URL\./);
  await o.admin.confirm(o.proposals.take(v.proposalId) as any);
  const rec = (await runToEnd(h, b.mutations()[0].opId))!;
  assert.equal(rec.state, "verified", rec.summary);
  assert.equal(
    h.envText(),
    ENV.replace("ORBIT_MODEL=gpt-6-astra", `ORBIT_MODEL=${MODEL}`).replace("ORBIT_ROUTINE_REPOS=orbit=DragonflyAI-sh/orbit", "ORBIT_ROUTINE_REPOS=orbit=DragonflyAI-sh/orbit,research=DragonflyAI-sh/orbit-work").replace("ORBIT_INGRESS_PORT=8791", "ORBIT_INGRESS_PORT=8792"),
  );
});

test("end to end: when /status is unhealthy after a model-only change, the old file is restored byte for byte and reported", async () => {
  const h = host();
  const b = bridge(h);
  const o = orbit(b.client);
  h.onRestart = (n) => void (h.served.commit = n === 1 ? undefined : SHA_A); // down after the change, up again after the restore
  const v = await proposeVia(o.tool, MODEL_ONLY_STRICT);
  await o.admin.confirm(o.proposals.take(v.proposalId) as any);
  const rec = (await runToEnd(h, b.mutations()[0].opId))!;
  assert.equal(rec.state, "restored", rec.summary);
  assert.equal(h.envText(), ENV, "the previous orbit.env is back, every setting and line included");
  assert.equal(h.restarts(), 2);
  await o.admin.refresh();
  assert.equal(o.store.read()[0]!.state, "restored");
  assert.match(o.sent[0]!, /restored/);
});

test("end to end: proposing the model already configured is no_change at the helper and ORBIT is not restarted", async () => {
  const h = host();
  const b = bridge(h);
  const o = orbit(b.client);
  const v = await proposeVia(o.tool, { changes: { ...ALL_NULL, ORBIT_MODEL: "gpt-6-astra" } });
  await o.admin.confirm(o.proposals.take(v.proposalId) as any);
  const rec = (await runToEnd(h, b.mutations()[0].opId))!;
  assert.equal(rec.state, "no_change");
  assert.equal(h.restarts(), 0);
  assert.equal(h.envText(), ENV);
});

