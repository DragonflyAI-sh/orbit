import assert from "node:assert/strict";
import { execFile as execFileCb, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { promisify } from "node:util";
import { createServer as createNetServer } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildIngress } from "../src/ingress.ts";
import { jobs as jobRegistry, NOT_STARTED_AFTER_MS, RESEARCH_TTL_MS } from "../src/jobs.ts";
import type { Job } from "../src/jobs.ts";
import { dispatchEvidence, launchTracker } from "../src/launch-evidence.ts";
import { notifier } from "../src/notify.ts";
import type { Notification } from "../src/notify.ts";
import { BOOTSTRAP_CATEGORIES, BOOTSTRAP_MAX_ATTEMPTS } from "../src/research-bootstrap.ts";
import type { ResearchTool } from "../src/research.ts";
import { jsonStore } from "../src/store.ts";
import { watcher } from "../src/watch.ts";
import type { WatchState } from "../src/watch.ts";

// The research runner's bootstrap (deploy/routines/orbit-research.md, step 2), run EXACTLY as the prompt writes it: the script is cut out of
// the routine document, only its four placeholder values are filled in, and it talks to ORBIT's real job listener over local HTTPS with a
// throwaway self-signed certificate. Everything is synthetic: a test HMAC secret, generated job ids, a fake tool. No production token, no
// network beyond 127.0.0.1. `sleep` is a shim that records the backoff instead of waiting; a `curl` shim logs every argument list (to prove
// the token is never in one) and can fake a curl exit code for the tool download; otherwise the real curl does the work.
//
// Limitation, stated once: this proves the script's behaviour against a local listener. It cannot establish the research environment's
// network policy, its proxy's behaviour or the cause of any past failure: a build-environment probe is not evidence about that environment.

const doc = readFileSync(new URL("../deploy/routines/orbit-research.md", import.meta.url), "utf8");
const promptText = doc.slice(doc.indexOf("## Prompt"), doc.indexOf("## If the form requires a repository"));
const scriptLines = (() => {
  const lines = promptText.split("\n");
  const from = lines.findIndex((l) => l.startsWith("   (job='"));
  const to = lines.findIndex((l, i) => i > from && l === "   exit 1)");
  assert.ok(from > 0 && to > from, "the bootstrap script is in the prompt");
  return lines.slice(from, to + 1).map((l) => {
    assert.ok(l.startsWith("   "), `every script line is indented as a prompt step: ${l}`);
    return l.slice(3);
  });
})();
const SCRIPT = scriptLines.join("\n");
const realCurl = execFileSync("bash", ["-c", "command -v curl"], { encoding: "utf8" }).trim();
const SECRET = Buffer.alloc(32, 9);

// ---- fixtures -------------------------------------------------------------------------------------------------------------------------

function tlsPair(dir: string) {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  return { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")), ca: join(dir, "cert.pem") };
}

// A tool that would leave a mark if anything ever ran it.
function fakeTool(): ResearchTool {
  const text = '#!/usr/bin/env bash\ntouch "$HOME/TOOL-WAS-RUN"\necho synthetic research tool\n';
  return { text, sha256: createHash("sha256").update(text).digest("hex") };
}

type Rig = Awaited<ReturnType<typeof rig>>;
async function rig(opts: { tool?: ResearchTool | null; dir?: string } = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "orbit-boot-"));
  const tls = tlsPair(dir);
  let t = Date.parse("2026-11-18T08:00:00Z");
  const now = () => new Date(t);
  const notify = notifier(jsonStore<Notification[]>(undefined, `n${Math.random()}`, []));
  const store = jsonStore<Job[]>(join(dir, "state"), "jobs", []);
  const jobs = jobRegistry(store, SECRET, notify, now);
  const tool = opts.tool === null ? undefined : (opts.tool ?? fakeTool());
  const ingress = buildIngress(jobs, () => t, tool ? { researchTool: tool } : {});
  const https = createHttpsServer({ key: tls.key, cert: tls.cert }, (req, res) => ingress.emit("request", req, res));
  // Every TCP connection passes through here first: `resets` connections are reset before the TLS handshake (as a "connection reset by
  // peer" mid-handshake looks to curl), the rest go to the real HTTPS listener.
  let resets = 0;
  let connections = 0;
  const front = createNetServer((socket: Socket) => {
    connections++;
    if (resets > 0) {
      resets--;
      socket.resetAndDestroy();
      return;
    }
    https.emit("connection", socket);
  });
  await new Promise<void>((r) => front.listen(0, "127.0.0.1", r));
  const api = `https://127.0.0.1:${(front.address() as AddressInfo).port}`;

  const home = join(dir, "home");
  const shim = join(dir, "shim");
  const log = join(dir, "log");
  mkdirSync(home, { recursive: true });
  mkdirSync(shim, { recursive: true });
  mkdirSync(log, { recursive: true });
  writeFileSync(join(shim, "sleep"), `#!/bin/sh\necho "$1" >> "${log}/sleeps"\n`);
  writeFileSync(
    join(shim, "curl"),
    [
      "#!/bin/bash",
      `printf '%s\\n' "--- call" "$@" >> "${log}/curl-argv"`,
      'last="${!#}"',
      // FAKE_TOOL_EXIT: the tool download fails with this curl exit code and no HTTP answer (a timeout, say), without touching the network.
      'if [ -n "${FAKE_TOOL_EXIT:-}" ] && [[ $last == */tool ]]; then printf 000; echo "curl: ($FAKE_TOOL_EXIT) synthetic failure" >&2; exit "$FAKE_TOOL_EXIT"; fi',
      // FAKE_HANG: the download hangs (for the interrupted-step test).
      `if [ -n "\${FAKE_HANG:-}" ] && [[ $last == */tool ]]; then touch "${log}/hanging"; /bin/sleep 20; exit 28; fi`,
      `exec "${realCurl}" "$@"`,
    ].join("\n") + "\n",
  );
  chmodSync(join(shim, "sleep"), 0o755);
  chmodSync(join(shim, "curl"), 0o755);

  const research = (id: string) => {
    const r = jobs.register(id, RESEARCH_TTL_MS, { research: { brief: "Synthetic brief." } });
    if ("error" in r) throw new Error(r.error);
    jobs.setLaunch(id, { routine: "research", at: now().toISOString() });
    return r.token;
  };
  const env = (extra: Record<string, string> = {}) => ({ HOME: home, PATH: `${shim}:/usr/bin:/bin`, CURL_CA_BUNDLE: tls.ca, LANG: "C", ...extra });
  const script = (v: { job: string; api?: string; sha?: string; token: string }) =>
    SCRIPT.replace("'<job id>'", `'${v.job}'`).replace("'<API>'", `'${v.api ?? api}'`).replace("'<tool sha256>'", `'${v.sha ?? tool?.sha256 ?? "0".repeat(64)}'`).replace("'<token>'", `'${v.token}'`);
  // Runs the prompt's script in its own fresh shell, as a runner's shell step would.
  const boot = (v: { job: string; api?: string; sha?: string; token: string }, extra: Record<string, string> = {}) =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      const p = spawn("bash", ["-c", script(v)], { env: env(extra) });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (out += d));
      p.on("close", (code) => resolve({ code, out }));
    });
  const sleeps = () => (existsSync(join(log, "sleeps")) ? readFileSync(join(log, "sleeps"), "utf8").trim().split("\n").filter(Boolean) : []);
  const curlArgv = () => (existsSync(join(log, "curl-argv")) ? readFileSync(join(log, "curl-argv"), "utf8") : "");
  const leftovers = () => readdirSync(home).filter((f) => f.startsWith(".orbit-research-boot"));
  const installed = join(home, ".local/bin/orbit-research");
  return {
    dir, home, api, jobs, notify, tool, ca: tls.ca, research, boot, script, env, sleeps, curlArgv, leftovers, installed, log, store,
    advance: (ms: number) => void (t += ms),
    now,
    reset: (n: number) => void (resets = n),
    connections: () => connections,
    close: () => (front.close(), https.close()),
  };
}

const lines = (out: string) => out.split("\n").filter((l) => l.startsWith("orbit-research-bootstrap: "));
function noSecrets(r: Rig, token: string, out: string) {
  assert.ok(!out.includes(token), "the token is never printed");
  assert.ok(!r.curlArgv().includes(token), "the token is in no curl argument list");
  assert.deepEqual(r.leftovers(), [], "the private work directory (and the header file in it) is gone");
  assert.ok(!existsSync(join(r.home, "TOOL-WAS-RUN")), "the bootstrap never runs the downloaded file");
}

// ---- the script's own contract -----------------------------------------------------------------------------------------------------------

test("the prompt's bootstrap never disables TLS checks, never follows redirects and retries only the listed transport categories", () => {
  assert.doesNotMatch(SCRIPT, /(^|\s)(-k|--insecure|-L|--location|--retry-all-errors|--proxy-insecure)(\s|$)/m);
  assert.doesNotMatch(SCRIPT, /\bcurl\b[^\n]*\|\s*(ba)?sh/, "nothing is piped into a shell");
  // Every category the script can print is documented on the ORBIT side, and the retried set is exactly the documented one.
  const printed = new Set([...SCRIPT.matchAll(/cat=([a-z-]+)/g)].map((m) => m[1]!).filter((c) => c !== "none" && c !== "ok"));
  printed.add("invalid-input");
  for (const c of printed) assert.ok(c === "invalid-input" || Object.hasOwn(BOOTSTRAP_CATEGORIES, c), `${c} is a documented category`);
  for (const c of Object.keys(BOOTSTRAP_CATEGORIES)) assert.ok(printed.has(c), `${c} can be printed by the script`);
  const retried = /case \$cat in ([a-z|-]+)\) ;; \*\) break ;; esac/.exec(SCRIPT)![1]!.split("|").sort();
  assert.deepEqual(retried, Object.entries(BOOTSTRAP_CATEGORIES).filter(([, v]) => v.retried).map(([k]) => k).sort());
  for (const never of ["auth-denied", "tls-verify", "digest-mismatch", "not-found", "proxy-denied"]) assert.ok(!retried.includes(never), `${never} is never retried`);
  assert.match(SCRIPT, /--connect-timeout 10 --max-time 20 /, "each download attempt has a connection and a total time limit");
  assert.match(SCRIPT, /\[ "\$n" -lt 4 \]/);
  assert.equal(BOOTSTRAP_MAX_ATTEMPTS, 4);
  assert.match(promptText, /give it 300000 ms/, "the runner is told to give the step more than the default shell timeout");
});

test("invalid input is refused before anything is sent", async () => {
  const r = await rig();
  try {
    const token = r.research("research-boot-in1");
    for (const v of [
      { job: "research-boot-in1", token, api: `${r.api}/elsewhere` },
      { job: "research-boot-in1", token, sha: "A".repeat(64) },
      { job: "research-boot-in1", token: `other-job.${"x".repeat(43)}` },
      { job: "../etc", token },
    ]) {
      const res = await r.boot(v);
      assert.equal(res.code, 2);
      assert.match(res.out, /FAILED category=invalid-input attempts=0 \(nothing was sent\)/);
    }
    assert.equal(r.curlArgv(), "", "curl never ran");
    assert.equal(r.connections(), 0);
  } finally {
    r.close();
  }
});

// ---- outcomes against the real listener --------------------------------------------------------------------------------------------------

test("success: the tool is downloaded with the job's token, verified, installed 0755 and not run; ORBIT records that it sent it", async () => {
  const r = await rig();
  try {
    const id = "research-boot-ok";
    const token = r.research(id);
    const res = await r.boot({ job: id, token });
    assert.equal(res.code, 0, res.out);
    assert.deepEqual(lines(res.out), ["orbit-research-bootstrap: attempt 1: ok (curl exit 0, HTTP 200)", "orbit-research-bootstrap: ok: tool verified (sha256 matches) and installed after 1 attempt(s)"]);
    assert.equal(readFileSync(r.installed, "utf8"), r.tool!.text);
    assert.equal((statSync(r.installed).mode & 0o777).toString(8), "755");
    assert.deepEqual(r.sleeps(), []);
    assert.match(r.curlArgv(), /^-H\n@.*\/\.orbit-research-boot\.[^/]+\/auth$/m, "curl reads the Authorization header from the private file");
    noSecrets(r, token, res.out);
    const job = r.jobs.get(id)!;
    assert.equal(job.research?.toolServed?.count, 1);
    assert.equal(job.research?.toolServed?.sha256, r.tool!.sha256);
    assert.deepEqual([job.state, job.events.length], ["registered", 0], "downloading the tool is not a runner event");
  } finally {
    r.close();
  }
});

test("a request with no credentials gets the same 401 JSON as a wrong token, and changes nothing", async () => {
  const r = await rig();
  try {
    const id = "research-boot-401";
    r.research(id);
    const get = (path: string, headers: Record<string, string> = {}, method = "GET", body?: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const u = new URL(r.api);
        const req = httpsRequest({ host: u.hostname, port: u.port, path, method, headers, ca: readFileSync(r.ca) }, (res) => {
          let b = "";
          res.on("data", (d) => (b += d));
          res.on("end", () => resolve({ status: res.statusCode!, body: b }));
        });
        req.on("error", reject);
        req.end(body);
      });
    const anon = await get(`/v1/jobs/${id}/tool`);
    assert.deepEqual([anon.status, JSON.parse(anon.body)], [401, { error: "Unauthorized" }]);
    const unknown = await get(`/v1/jobs/research-boot-nobody/tool`);
    assert.equal(unknown.body, anon.body, "an unknown job reads exactly like a missing token");
    const forged = await get(`/v1/jobs/${id}/events`, { "content-type": "application/json" }, "POST", JSON.stringify({ type: "bootstrap", category: "timeout", attempts: 1, curlExit: 28, http: 0 }));
    assert.equal(forged.status, 401, "an unauthenticated bootstrap report is refused");
    const job = r.jobs.get(id)!;
    assert.deepEqual([job.state, job.events.length, job.research?.toolServed], ["registered", 0, undefined]);
  } finally {
    r.close();
  }
});

test("a wrong token and an expired token are denied once, never retried, and no failure report is sent", async () => {
  const r = await rig();
  try {
    const id = "research-boot-deny";
    const token = r.research(id);
    const wrong = `${id}.${"A".repeat(43)}`;
    const a = await r.boot({ job: id, token: wrong });
    assert.equal(a.code, 1);
    assert.deepEqual(lines(a.out), [
      "orbit-research-bootstrap: attempt 1: auth-denied (curl exit 0, HTTP 401)",
      "orbit-research-bootstrap: FAILED category=auth-denied attempts=1 curl_exit=0 http=401",
      "orbit-research-bootstrap: failure report: not sent (ORBIT would refuse it, or it could not be verified, the same way)",
    ]);
    noSecrets(r, wrong, a.out);
    r.advance(RESEARCH_TTL_MS + 1000);
    const b = await r.boot({ job: id, token });
    assert.match(b.out, /FAILED category=auth-denied attempts=1 curl_exit=0 http=401/);
    noSecrets(r, token, b.out);
    assert.deepEqual(r.sleeps(), []);
    assert.ok(!existsSync(r.installed));
    assert.equal(r.curlArgv().split("--- call").length - 1, 2, "one request each: no retry and no report");
    assert.deepEqual(r.jobs.get(id)!.events, []);
  } finally {
    r.close();
  }
});

test("lane isolation: a build job's own valid token cannot fetch the research tool (404, not retried)", async () => {
  const r = await rig();
  try {
    const reg = r.jobs.register("build-boot-1");
    assert.ok(!("error" in reg));
    const res = await r.boot({ job: "build-boot-1", token: reg.token });
    assert.match(res.out, /attempt 1: not-found \(curl exit 0, HTTP 404\)/);
    assert.match(res.out, /FAILED category=not-found attempts=1/);
    assert.deepEqual(r.sleeps(), []);
    assert.ok(!existsSync(r.installed));
    noSecrets(r, reg.token, res.out);
  } finally {
    r.close();
  }
});

test("connection reset during the TLS handshake, then success: retried with 2 s and 4 s backoff", async () => {
  const r = await rig();
  try {
    const id = "research-boot-reset";
    const token = r.research(id);
    r.reset(2);
    const res = await r.boot({ job: id, token });
    assert.equal(res.code, 0, res.out);
    const l = lines(res.out);
    assert.match(l[0]!, /^orbit-research-bootstrap: attempt 1: (tls-connect \(curl exit 35|connection-reset \(curl exit (52|56)), HTTP 000\)$/);
    assert.match(l[1]!, /attempt 2: (tls-connect|connection-reset)/);
    assert.equal(l[2], "orbit-research-bootstrap: attempt 3: ok (curl exit 0, HTTP 200)");
    assert.deepEqual(r.sleeps(), ["2", "4"]);
    assert.equal(readFileSync(r.installed, "utf8"), r.tool!.text);
    noSecrets(r, token, res.out);
    assert.deepEqual(r.jobs.get(id)!.events, []);
  } finally {
    r.close();
  }
});

test("resets that never stop: 4 attempts (2, 4, 8 s backoff), then FAILED with curl's own detail; the report cannot get through either", async () => {
  const r = await rig();
  try {
    const id = "research-boot-exhaust";
    const token = r.research(id);
    r.reset(1000);
    const res = await r.boot({ job: id, token });
    assert.equal(res.code, 1);
    const l = lines(res.out);
    assert.equal(l.filter((x) => / attempt \d: /.test(x)).length, 4);
    assert.deepEqual(r.sleeps(), ["2", "4", "8"]);
    assert.match(res.out, /FAILED category=(tls-connect|connection-reset) attempts=4 curl_exit=(35|52|56) http=000/);
    assert.match(res.out, /detail: curl: \((35|52|56)\) /, "curl's message is kept for diagnosis");
    assert.match(res.out, /failure report: NOT delivered \(curl exit (35|52|56), HTTP 000\); ORBIT will show this job as not checked in/);
    assert.ok(!existsSync(r.installed));
    noSecrets(r, token, res.out);
    const job = r.jobs.get(id)!;
    assert.deepEqual([job.state, job.events.length, job.research?.toolServed], ["registered", 0, undefined], "nothing reached ORBIT, and its record says only that");
    r.advance(NOT_STARTED_AFTER_MS + 60_000);
    assert.equal(r.jobs.health(job), "not-started", "the silent job is shown as not checked in after the deadline, not as failed");
  } finally {
    r.close();
  }
});

test("timeouts are retried (bounded), then reported: ORBIT records the runner's bootstrap failure as failed, with fixed text", async () => {
  const r = await rig();
  try {
    const id = "research-boot-timeout";
    const token = r.research(id);
    const res = await r.boot({ job: id, token }, { FAKE_TOOL_EXIT: "28" });
    assert.equal(res.code, 1);
    assert.deepEqual(r.sleeps(), ["2", "4", "8"]);
    assert.match(res.out, /FAILED category=timeout attempts=4 curl_exit=28 http=000/);
    assert.match(res.out, /failure report: delivered to ORBIT/);
    noSecrets(r, token, res.out);
    const job = r.jobs.get(id)!;
    assert.equal(job.state, "failed");
    assert.equal(job.events.length, 1);
    const ev = job.events[0]!;
    assert.deepEqual([ev.type, ev.status, ev.bootstrap], ["bootstrap", "timeout", { category: "timeout", attempts: 4, curlExit: 28, http: 0 }]);
    assert.equal(ev.text, "the runner reported a bootstrap failure before its tool ran: timeout after 4 attempt(s) (curl exit 28, HTTP none): the connection or the transfer ran past its time limit (curl 28).");
    assert.equal(r.jobs.health(job), "finished");
    const d = dispatchEvidence(job, { inFlight: launchTracker() });
    assert.equal(d.state, "runner-reported");
    assert.match(d.basis, /bootstrap failure \(timeout\).*before its tool started.*runner-reported, unverified/);
    assert.ok(r.notify.recent().some((n) => n.text.startsWith(`Research job ${id}: the runner reported a bootstrap failure`)));
    // The finished job's token no longer works, so a second report cannot change it.
    const again = await r.boot({ job: id, token }, { FAKE_TOOL_EXIT: "28" });
    assert.match(again.out, /failure report: NOT delivered \(curl exit 0, HTTP 401\)/);
    assert.equal(r.jobs.get(id)!.events.length, 1);
    // Each attempt had a connection and a total time limit.
    const calls = r.curlArgv().split("--- call\n").filter(Boolean).filter((c) => c.trimEnd().endsWith("/tool"));
    assert.ok(calls.length >= 4 && calls.every((c) => /--connect-timeout\n10\n--max-time\n20\n/.test(c)));
  } finally {
    r.close();
  }
});

test("a certificate that cannot be verified fails at once: never retried, never bypassed, nothing sent", async () => {
  const r = await rig();
  try {
    const id = "research-boot-tls";
    const token = r.research(id);
    const res = await r.boot({ job: id, token }, { CURL_CA_BUNDLE: "/nonexistent-ca.pem", SSL_CERT_FILE: "/nonexistent-ca.pem", SSL_CERT_DIR: "/nonexistent" });
    assert.equal(res.code, 1);
    assert.match(res.out, /attempt 1: tls-verify \(curl exit (60|77), HTTP 000\)/);
    assert.match(res.out, /FAILED category=tls-verify attempts=1/);
    assert.match(res.out, /failure report: not sent/);
    assert.deepEqual(r.sleeps(), []);
    assert.ok(!existsSync(r.installed));
    noSecrets(r, token, res.out);
    assert.equal(r.jobs.get(id)!.research?.toolServed, undefined);
  } finally {
    r.close();
  }
});

test("a digest mismatch is never retried, never installed, never run; the download is deleted and the failure reported", async () => {
  const r = await rig();
  try {
    const id = "research-boot-digest";
    const token = r.research(id);
    const res = await r.boot({ job: id, token, sha: "f".repeat(64) });
    assert.equal(res.code, 1);
    assert.deepEqual(lines(res.out).slice(0, 2), ["orbit-research-bootstrap: attempt 1: ok (curl exit 0, HTTP 200)", "orbit-research-bootstrap: FAILED category=digest-mismatch attempts=1 curl_exit=0 http=200"]);
    assert.match(res.out, /failure report: delivered to ORBIT/);
    assert.deepEqual(r.sleeps(), []);
    assert.ok(!existsSync(r.installed));
    assert.ok(!existsSync(`${r.installed}.download`));
    noSecrets(r, token, res.out);
    const job = r.jobs.get(id)!;
    assert.deepEqual([job.state, job.events[0]?.bootstrap?.category, job.research?.toolServed?.count], ["failed", "digest-mismatch", 1]);
  } finally {
    r.close();
  }
});

test("a 503 (no tool on this ORBIT) is retried as a server error, bounded, then reported", async () => {
  const r = await rig({ tool: null });
  try {
    const id = "research-boot-503";
    const token = r.research(id);
    const res = await r.boot({ job: id, token, sha: "e".repeat(64) });
    assert.equal(res.code, 1);
    assert.equal((res.out.match(/attempt \d: server-error \(curl exit 0, HTTP 503\)/g) ?? []).length, 4);
    assert.match(res.out, /failure report: delivered to ORBIT/);
    assert.equal(r.jobs.get(id)!.events[0]?.bootstrap?.category, "server-error");
    noSecrets(r, token, res.out);
  } finally {
    r.close();
  }
});

test("an interrupted step (the shell step killed mid-download) still removes the header file", async () => {
  const r = await rig();
  try {
    const id = "research-boot-kill";
    const token = r.research(id);
    const p = spawn("bash", ["-c", r.script({ job: id, token })], { env: r.env({ FAKE_HANG: "1" }), detached: true, stdio: "ignore" });
    for (let i = 0; i < 100 && !existsSync(join(r.log, "hanging")); i++) await new Promise((x) => setTimeout(x, 50));
    assert.ok(existsSync(join(r.log, "hanging")), "the download started");
    assert.equal(r.leftovers().length, 1, "the private work directory exists while it runs");
    const auth = join(r.home, r.leftovers()[0]!, "auth");
    assert.equal((statSync(auth).mode & 0o777).toString(8), "600");
    assert.equal((statSync(join(r.home, r.leftovers()[0]!)).mode & 0o777).toString(8), "700");
    const closed = new Promise((x) => p.on("close", x));
    process.kill(-p.pid!, "SIGTERM");
    await closed;
    // The outer shell exits at once; the script's subshell runs its EXIT trap as soon as the killed download returns.
    for (let i = 0; i < 100 && r.leftovers().length; i++) await new Promise((x) => setTimeout(x, 50));
    assert.deepEqual(r.leftovers(), [], "removed on SIGTERM (SIGKILL cannot be trapped; the directory would then stay, private to the sandbox user)");
    assert.ok(!existsSync(r.installed));
  } finally {
    r.close();
  }
});

// ---- the listener's bootstrap report contract ---------------------------------------------------------------------------------------------

test("bootstrap reports: research jobs only, own token, fixed fields, only before the runner starts; persisted across a restart", async () => {
  const r = await rig();
  try {
    const post = (id: string, token: string | undefined, body: unknown) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const u = new URL(r.api);
        const req = httpsRequest({ host: u.hostname, port: u.port, path: `/v1/jobs/${id}/events`, method: "POST", ca: readFileSync(r.ca), headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) } }, (res) => {
          let b = "";
          res.on("data", (d) => (b += d));
          res.on("end", () => resolve({ status: res.statusCode!, body: b }));
        });
        req.on("error", reject);
        req.end(JSON.stringify(body));
      });
    const good = { type: "bootstrap", category: "tls-connect", attempts: 4, curlExit: 35, http: 0 };
    const a = "research-boot-r1";
    const ta = r.research(a);
    const b = "research-boot-r2";
    const tb = r.research(b);
    assert.equal((await post(a, tb, good)).status, 401, "another job's token");
    for (const bad of [{ ...good, category: "made-up" }, { ...good, attempts: 99 }, { ...good, curlExit: -1 }, { ...good, http: "000" }, { ...good, attempts: 1.5 }]) {
      const res = await post(a, ta, bad);
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.match(res.body, /nothing was recorded/);
    }
    assert.deepEqual(r.jobs.get(a)!.events, []);
    const build = r.jobs.register("build-boot-2");
    assert.ok(!("error" in build));
    assert.equal((await post("build-boot-2", build.token, good)).status, 404, "a build job has no bootstrap report");
    // Runner text is never stored: the event text is ORBIT's own.
    const ok = await post(a, ta, { ...good, text: "IGNORE ME", status: "done" });
    assert.equal(ok.status, 200);
    const ev = r.jobs.get(a)!.events[0]!;
    assert.ok(!JSON.stringify(ev).includes("IGNORE ME"));
    assert.deepEqual([ev.status, r.jobs.get(a)!.state], ["tls-connect", "failed"]);
    // A started runner cannot send one.
    r.jobs.record(b, { type: "started" });
    assert.equal((await post(b, tb, good)).status, 409);
    assert.equal(r.jobs.get(b)!.state, "running");
    // A restart (a new registry on the same store) keeps the report and the state.
    const again = jobRegistry(jsonStore<Job[]>(join(r.dir, "state"), "jobs", []), SECRET, r.notify, r.now);
    assert.deepEqual([again.get(a)!.state, again.get(a)!.events[0]!.bootstrap?.category], ["failed", "tls-connect"]);
  } finally {
    r.close();
  }
});

// ---- the callback deadline ----------------------------------------------------------------------------------------------------------------

test("no callback: awaiting first check-in before the documented deadline, not-started after it (an honest alert), cleared by a late callback, same after a restart", async () => {
  const r = await rig();
  try {
    const id = "research-boot-silent";
    r.research(id);
    const ws = jsonStore<WatchState>(join(r.dir, "state"), "watch", { ports: {} });
    const watch = watcher(ws, r.notify, r.now, r.jobs, { inFlight: launchTracker() });
    r.advance(NOT_STARTED_AFTER_MS - 60_000);
    assert.equal(r.jobs.health(r.jobs.get(id)!), "awaiting-first-checkin");
    watch.tick();
    r.advance(2 * 60_000);
    assert.equal(r.jobs.health(r.jobs.get(id)!), "not-started");
    watch.tick();
    const alerts = r.notify.recent().filter((n) => n.text.startsWith(`Job ${id} is not started`));
    assert.equal(alerts.length, 1);
    assert.match(alerts[0]!.text, /not checked in, which is not proof that it failed or never launched/);
    assert.match(alerts[0]!.text, /Dispatch: dispatch-unknown/);
    // A restart: a new registry and watch on the same stores. The reading is recomputed from stored times; the alert is not repeated.
    const jobs2 = jobRegistry(jsonStore<Job[]>(join(r.dir, "state"), "jobs", []), SECRET, r.notify, r.now);
    assert.equal(jobs2.health(jobs2.get(id)!), "not-started");
    watcher(jsonStore<WatchState>(join(r.dir, "state"), "watch", { ports: {} }), r.notify, r.now, jobs2, { inFlight: launchTracker() }).tick();
    assert.equal(r.notify.recent().filter((n) => n.text.startsWith(`Job ${id} is not started`)).length, 1);
    // A late callback, even past the deadline, is accepted and clears it.
    jobs2.record(id, { type: "started" });
    assert.equal(jobs2.health(jobs2.get(id)!), "ok");
    // Past the token's lifetime a silent job stays not-started: ORBIT does not invent an outcome for it.
    const silent = "research-boot-silent2";
    r.research(silent);
    r.advance(RESEARCH_TTL_MS + 60_000);
    const j3 = jobRegistry(jsonStore<Job[]>(join(r.dir, "state"), "jobs", []), SECRET, r.notify, r.now);
    assert.deepEqual([j3.health(j3.get(silent)!), j3.get(silent)!.state], ["not-started", "registered"]);
  } finally {
    r.close();
  }
});

// ---- the runner tool's own reads ----------------------------------------------------------------------------------------------------------

test("orbit-research: a GET retries a reset connection (bounded) and reports curl's error; a 401 is never retried; a POST never is", async () => {
  const r = await rig();
  // The tool talks plain HTTP to loopback in tests (it refuses http anywhere else). Same front: N resets, then the real listener.
  const tool = readFileSync(new URL("../tools/orbit-research/orbit-research", import.meta.url), "utf8");
  const toolPath = join(r.dir, "orbit-research");
  writeFileSync(toolPath, tool);
  chmodSync(toolPath, 0o755);
  const jobsIngress = buildIngress(r.jobs, () => r.now().getTime(), { researchTool: r.tool! });
  let resets = 0;
  const front = createNetServer((socket: Socket) => {
    if (resets > 0) {
      resets--;
      socket.resetAndDestroy();
      return;
    }
    jobsIngress.emit("connection", socket);
  });
  await new Promise<void>((x) => front.listen(0, "127.0.0.1", x));
  const base = `http://127.0.0.1:${(front.address() as AddressInfo).port}`;
  const run = (args: string[], extra: Record<string, string> = {}) =>
    promisify(execFileCb)(toolPath, args, { env: r.env({ ORBIT_RESEARCH_HOME: join(r.home, ".orbit-research"), ...extra }) }).then((x) => x.stdout + x.stderr, (e: { stdout: string; stderr: string; code: number }) => `EXIT ${e.code}\n${e.stdout}${e.stderr}`);
  try {
    const id = "research-tool-retry";
    const token = r.research(id);
    resets = 1;
    const start = await run(["start", "--job", id, "--api", base], { ORBIT_RESEARCH_TOKEN: token });
    assert.match(start, /GET \/v1\/jobs\/research-tool-retry\/brief attempt 1 failed \(curl exit (52|56), HTTP 000\); retrying in 2s/);
    assert.match(start, /ok api=sent \(started\)/);
    assert.deepEqual(r.sleeps(), ["2"]);
    assert.ok(!start.includes(token));
    // Every read reset: 3 attempts, then a FAILED line that names curl's exit code.
    resets = 1000;
    const steers = await run(["steers"]);
    assert.match(steers, /FAILED: could not read steers \(network error \(curl exit (52|56) after 3 attempt\(s\)\): curl: \((52|56)\) /);
    assert.deepEqual(r.sleeps(), ["2", "2", "4"]);
    // A POST is never retried: one attempt, reported as failed.
    const ci = await run(["checkin", "x"]);
    assert.match(ci, /FAILED api=failed/);
    assert.deepEqual(r.sleeps(), ["2", "2", "4"]);
    resets = 0;
    // A denial is not retried: the finished job's token reads 401 once.
    r.jobs.record(id, { type: "summary", status: "failed", text: "stopping" });
    const denied = await run(["steers"]);
    assert.match(denied, /FAILED: could not read steers \(401\)/);
    assert.deepEqual(r.sleeps(), ["2", "2", "4"]);
    assert.deepEqual(readdirSync(join(r.home, ".orbit-research", id)).filter((f) => f.startsWith("auth.")), [], "header files are removed");
  } finally {
    front.close();
    r.close();
  }
});
