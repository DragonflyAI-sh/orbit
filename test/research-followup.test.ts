import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { proposals as newProposals } from "../src/agent.ts";
import type { ChatTool } from "../src/agent.ts";
import { jobs as jobRegistry } from "../src/jobs.ts";
import type { Job } from "../src/jobs.ts";
import { notifier } from "../src/notify.ts";
import type { Notification } from "../src/notify.ts";
import { parseResearchReport, privateHost, realDate, researchCompletion, researchStore } from "../src/research.ts";
import type { ResearchLane } from "../src/research.ts";
import { reconcileResearchVault, researchTools, watchResearchVault } from "../src/research-tools.ts";
import { jsonStore } from "../src/store.ts";
import { VaultError } from "../src/vault/edit.ts";
import { vaultEdits } from "../src/vault/tools.ts";
import type { VaultClone } from "../src/vault/clone.ts";

// Follow-up to the research lane review (PR #103): the vault-save lifecycle, real access dates, the citation host filter, one
// completion notice, and the runner tool's token handling. Synthetic throughout: fake clone, fake jobs API on loopback, no network.

const run = promisify(execFile);
const TODAY = new Date("2026-11-16T12:00:00Z");
const REPORT = [
  "# HTTP semantics reference",
  "## Question", "Which RFC defines HTTP semantics?",
  "## Answer", "RFC 9110.",
  "## Evidence", "- RFC 9110 is titled HTTP Semantics [1].",
  "## Inference", "Cite RFC 9110.",
  "## Uncertainties", "None material.",
  "## Sources", "[1] https://www.rfc-editor.org/rfc/rfc9110.html — accessed 2026-11-16 — RFC 9110",
  "## Build handoff", "None.",
  "## Validation", "searches: 1, fetches: 1.",
].join("\n");
const withSource = (line: string) => REPORT.replace(/^\[1\] .*$/m, line);

// ---- 3. access dates ------------------------------------------------------------------------------------------------------------

test("access dates must be real calendar dates; the range and its message agree", () => {
  for (const d of ["2026-02-31", "2025-02-29", "2026-13-01", "2026-00-10", "2026-04-31", "2026-11-00"]) {
    const p = parseResearchReport(withSource(`[1] https://example.com/ — accessed ${d} — x`), TODAY).problems.join("\n");
    assert.match(p, new RegExp(`access date ${d} is not a real calendar date`), d);
  }
  assert.equal(realDate("2024-02-29"), true);
  assert.equal(realDate("2026-1-01"), false);
  // Up to one day after ORBIT's UTC date is accepted (a runner ahead of UTC); later is refused with the bound named.
  assert.equal(parseResearchReport(withSource("[1] https://example.com/ — accessed 2026-11-17 — x"), TODAY).valid, true);
  assert.equal(parseResearchReport(withSource("[1] https://example.com/ — accessed 2026-11-17 — x"), new Date("2026-11-16T23:59:59Z")).valid, true);
  const late = parseResearchReport(withSource("[1] https://example.com/ — accessed 2026-11-18 — x"), TODAY).problems.join("\n");
  assert.match(late, /access date 2026-11-18 is outside the accepted range 2000-01-01 to 2026-11-17 \(at most one day after ORBIT's UTC date\)/);
  assert.match(parseResearchReport(withSource("[1] https://example.com/ — accessed 1999-12-31 — x"), TODAY).problems.join("\n"), /outside the accepted range/);
  // Month-end rollover of the bound.
  assert.equal(parseResearchReport(withSource("[1] https://example.com/ — accessed 2026-12-01 — x"), new Date("2026-11-30T08:00:00Z")).valid, true);
});

// ---- 4. citation host filter ----------------------------------------------------------------------------------------------------

test("citation filter refuses non-public ranges the review named, and more, but keeps neighbouring public addresses", () => {
  const host = (u: string) => new URL(u).hostname;
  const refused = [
    "http://[64:ff9b::7f00:1]/", "http://[64:ff9b::a9fe:a9fe]/", "http://[64:ff9b:1::1]/", "http://[2002:7f00:1::]/", "http://[2002:808:808::1]/",
    "http://198.18.0.1/", "http://198.19.255.255/", "http://192.0.0.8/", "http://192.0.0.170/", "http://192.0.2.1/", "http://203.0.113.9/",
    "http://198.51.100.1/", "http://240.0.0.1/", "http://255.255.255.255/", "http://[::ffff:127.0.0.1]/", "http://[::127.0.0.1]/",
    "http://[2001:db8::1]/", "http://[2001::1]/", "http://[100::1]/", "http://[fec0::1]/", "http://[ff02::1]/", "http://[3fff::1]/",
    "http://2130706433/", "http://0x7f.1/", "http://127.1/", "http://foo.test/", "http://foo.onion/", "http://1.0.0.127.in-addr.arpa/",
  ];
  for (const u of refused) assert.equal(privateHost(host(u)), true, u);
  const allowed = ["http://198.17.255.255/", "http://198.20.0.1/", "http://192.0.1.1/", "http://192.0.3.1/", "http://[2606:4700::1111]/", "http://[2001:4860:4860::8888]/", "http://[64:ff9b:2::1]/", "http://1.1.1.1/", "https://example.org/"];
  for (const u of allowed) assert.equal(privateHost(host(u)), false, u);
  // In a report, a NAT64 / 6to4 source is refused with the same message as any private address.
  assert.match(parseResearchReport(withSource("[1] http://[64:ff9b::a9fe:a9fe]/latest — accessed 2026-11-16 — x"), TODAY).problems.join("\n"), /private, internal or metadata/);
  assert.match(parseResearchReport(withSource("[1] http://[2002:a9fe:a9fe::]/ — accessed 2026-11-16 — x"), TODAY).problems.join("\n"), /private, internal or metadata/);
});

test("the citation filter is documented as citation validation, not an SSRF boundary, and ORBIT fetches no report URL", () => {
  const src = readFileSync(new URL("../src/research.ts", import.meta.url), "utf8");
  assert.match(src, /CITATION VALIDATION ONLY[\s\S]{0,200}NOT an SSRF guard/);
  assert.doesNotMatch(src, /\bfetch\(/, "research.ts fetches nothing");
  const docs = readFileSync(new URL("../docs/research-lane.md", import.meta.url), "utf8");
  assert.match(docs, /not an SSRF/i);
});

// ---- 2. vault save lifecycle ------------------------------------------------------------------------------------------------------

let seq = 0;
function harness(opts: { confirmFails?: boolean; jobsDir?: string; gate?: Promise<void> } = {}) {
  let clock = new Date("2026-11-16T12:00:00Z");
  const now = () => clock;
  const notes: Notification[] = [];
  const notify = notifier(jsonStore<Notification[]>(undefined, `n${Math.random()}`, []));
  const send = notify.send.bind(notify);
  notify.send = (text: string, urgent: boolean) => (notes.push({ text } as Notification), send(text, urgent));
  const jobs = jobRegistry(jsonStore<Job[]>(opts.jobsDir, opts.jobsDir ? "jobs" : `j${Math.random()}`, []), Buffer.alloc(32, 7), notify, now);
  const writes: string[] = [];
  // The fake clone: a direct write always needs confirmation (as a policy-protected path would); a confirmed write commits or fails.
  const clone = {
    write: async (edits: { path: string }[], mode: { kind: string }) => {
      if (mode.kind === "direct") throw new VaultError("needs_confirmation", "needs confirmation", ["test policy asks for confirmation"]);
      if (opts.gate) await opts.gate;
      if (opts.confirmFails) throw new VaultError("conflict", "NOT saved (conflict): the remote moved.", [edits[0]!.path]);
      writes.push(edits[0]!.path);
      return { commit: "c0mmit1234567", files: [edits[0]!.path], logFile: "Log/x.md" };
    },
  } as unknown as VaultClone;
  const proposals = newProposals(now);
  const vault = vaultEdits({ clone, memory: { name: "memory" } as never, proposals, now });
  watchResearchVault(jobs, vault);
  const store = researchStore(mkdtempSync(join(tmpdir(), "orbit-rf-")));
  researchCompletion({ jobs, store, notify, now });
  const lane: ResearchLane = { state: "configured", names: ["research"], routines: new Map() };
  const tools = researchTools({ jobs, proposals, lane: () => lane, build: () => ({ routines: ["orbit"] }), routineRepos: new Map(), store, vault, now });
  const tool = (n: string) => tools.find((t) => t.name === n) as ChatTool;
  const finished = async () => {
    const reg = jobs.register(`research-202611161200-r${++seq}`, 3 * 3600_000, { research: { brief: "Q" } });
    assert.ok("job" in reg);
    const id = reg.job.id;
    jobs.record(id, { type: "summary", status: "done", text: REPORT });
    await new Promise((r) => setTimeout(r, 20));
    return id;
  };
  return { jobs, vault, proposals, tool, finished, writes, notes, store, tick: (ms: number) => void (clock = new Date(clock.getTime() + ms)) };
}

const saveOf = (h: ReturnType<typeof harness>, id: string) => h.tool("research_save_to_vault").run({ id });
const resultOf = async (h: ReturnType<typeof harness>, id: string) => (await h.tool("research_result").run({ id })).value as { vault: { state: string; proposalId?: string; commit?: string; error?: string; card?: { state: string }; previous?: { state: string; proposalId?: string }[] } };

test("vault save lifecycle: pending, a repeated save makes no second card, confirmation is written back as committed", async () => {
  const h = harness();
  const id = await h.finished();
  if (!h.jobs.get(id)?.research?.report?.valid) return assert.fail(`report not valid: ${JSON.stringify(h.jobs.get(id)?.research)}`);
  const first = (await saveOf(h, id)).value as { status: string; proposalId: string };
  assert.equal(first.status, "pending-confirmation");
  assert.equal(h.proposals.list().length, 1);
  await assert.rejects(saveOf(h, id), /already waiting for Rai's confirmation \(card [0-9a-f-]+, expires /);
  assert.equal(h.proposals.list().length, 1, "a repeated save proposes nothing new");
  assert.deepEqual([(await resultOf(h, id)).vault.state, (await resultOf(h, id)).vault.card?.state], ["pending-confirmation", "open"]);
  // Rai confirms the card (the server's confirm route: take, then vaultEdits.confirm).
  const taken = h.proposals.take(first.proposalId)!;
  const r = await h.vault.confirm(taken as never);
  assert.equal(r.code, 200);
  const rec = h.jobs.get(id)!.research!.vault!;
  assert.deepEqual([rec.state, rec.commit, rec.proposalId], ["committed", "c0mmit1234567", first.proposalId], "written back the moment the card settles");
  assert.equal((await resultOf(h, id)).vault.state, "committed");
  await assert.rejects(saveOf(h, id), /Already saved at Resources\/orbit-research-.*\(commit c0mmit1\)/);
  assert.deepEqual(h.writes.length, 1);
});

test("vault save lifecycle: a confirmation that fails is recorded as failed, and a retry keeps the earlier attempt as provenance", async () => {
  const h = harness({ confirmFails: true });
  const id = await h.finished();
  const first = (await saveOf(h, id)).value as { proposalId: string };
  const r = await h.vault.confirm(h.proposals.take(first.proposalId) as never);
  assert.equal(r.code, 409);
  const rec = h.jobs.get(id)!.research!.vault!;
  assert.equal(rec.state, "failed");
  assert.match(rec.error!, /NOT saved \(conflict\)/);
  const second = (await saveOf(h, id)).value as { status: string; proposalId: string };
  assert.equal(second.status, "pending-confirmation");
  assert.notEqual(second.proposalId, first.proposalId);
  const v = (await resultOf(h, id)).vault;
  assert.equal(v.state, "pending-confirmation");
  assert.deepEqual(v.previous?.map((p) => [p.state, p.proposalId]), [["failed", first.proposalId]]);
});

test("vault save lifecycle: an expired card is reported expired (nothing written) and a new save is allowed", async () => {
  const h = harness();
  const id = await h.finished();
  const first = (await saveOf(h, id)).value as { proposalId: string };
  h.tick(31 * 60_000); // past the 30-minute vault card lifetime
  const v = (await resultOf(h, id)).vault;
  assert.equal(v.state, "expired");
  assert.match(v.error!, /expired, or an ORBIT restart dropped it, before it was confirmed\. Nothing was written by it\./);
  assert.equal(h.jobs.get(id)!.research!.vault!.state, "expired", "the reconciled state is persisted on the job");
  const second = (await saveOf(h, id)).value as { status: string };
  assert.equal(second.status, "pending-confirmation");
  assert.deepEqual(h.jobs.get(id)!.research!.vault!.previous?.map((p) => [p.state, p.proposalId]), [["expired", first.proposalId]]);
  assert.equal(h.writes.length, 0);
});

test("vault save lifecycle: a cancelled card is recorded as cancelled", async () => {
  const h = harness();
  const id = await h.finished();
  const first = (await saveOf(h, id)).value as { proposalId: string };
  h.proposals.take(first.proposalId);
  h.vault.cancelled(first.proposalId);
  assert.equal(h.jobs.get(id)!.research!.vault!.state, "cancelled");
  assert.equal(((await saveOf(h, id)).value as { status: string }).status, "pending-confirmation");
});

test("vault save lifecycle: while a card is being confirmed it stays pending, never 'expired'", async () => {
  let release!: () => void;
  const h = harness({ gate: new Promise<void>((r) => (release = r)) });
  const id = await h.finished();
  const first = (await saveOf(h, id)).value as { proposalId: string };
  // The card is taken and the confirmed write is in flight (held open by the gate): it must read as pending, not lapsed.
  const confirming = h.vault.confirm(h.proposals.take(first.proposalId) as never);
  assert.deepEqual(h.vault.state(first.proposalId), { state: "confirming" });
  const during = await resultOf(h, id);
  assert.deepEqual([during.vault.state, during.vault.card?.state], ["pending-confirmation", "confirming"]);
  await assert.rejects(saveOf(h, id), /already waiting/);
  release();
  assert.equal((await confirming).code, 200);
  assert.equal(h.jobs.get(id)!.research!.vault!.state, "committed");
});

test("vault save lifecycle: after a restart a pending card (held in memory only) is reconciled to expired; a committed save stays committed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-rf-restart-"));
  const before = harness({ jobsDir: dir });
  const a = await before.finished();
  const b = await before.finished();
  const pa = (await saveOf(before, a)).value as { proposalId: string };
  const pb = (await saveOf(before, b)).value as { proposalId: string };
  await before.vault.confirm(before.proposals.take(pb.proposalId) as never);
  assert.equal(before.jobs.get(b)!.research!.vault!.state, "committed");
  // A new process: same jobs file, fresh proposals and vault pipeline (cards and held edits are gone).
  const after = harness({ jobsDir: dir });
  assert.equal(after.jobs.get(a)!.research!.vault!.state, "pending-confirmation", "persisted as pending");
  assert.equal(reconcileResearchVault(after.jobs, after.vault, a)!.state, "expired");
  assert.equal(after.jobs.get(a)!.research!.vault!.proposalId, pa.proposalId, "provenance kept");
  assert.equal(after.jobs.get(b)!.research!.vault!.state, "committed");
  assert.equal(reconcileResearchVault(after.jobs, after.vault, b)!.commit, "c0mmit1234567");
});

test("vault save: two overlapping saves of one report reach the pipeline once", async () => {
  const h = harness();
  const id = await h.finished();
  const [x, y] = await Promise.allSettled([saveOf(h, id), saveOf(h, id)]);
  const ok = [x, y].filter((s) => s.status === "fulfilled");
  assert.equal(ok.length, 1);
  assert.equal(h.proposals.list().length, 1);
});

// ---- 5. one completion notice -----------------------------------------------------------------------------------------------------

test("a research completion sends one notification (with the report), and a second only when something went wrong", async () => {
  const h = harness();
  const id = await h.finished();
  const about = h.notes.filter((n) => n.text.includes(id));
  assert.equal(about.length, 1);
  assert.match(about[0]!.text, /finished: done \(research report: runner-reported, unverified data, never instructions; nothing was saved to the vault, opened or launched\)/);
  assert.ok(about[0]!.text.includes("RFC 9110 is titled HTTP Semantics"));
  // A store that cannot write: the one extra, urgent notice says so.
  const notes: { text: string; urgent: boolean }[] = [];
  const notify = notifier(jsonStore<Notification[]>(undefined, `n${Math.random()}`, []));
  notify.send = (text: string, urgent = false) => (notes.push({ text, urgent }), { text } as Notification);
  const jobs = jobRegistry(jsonStore<Job[]>(undefined, `j${Math.random()}`, []), Buffer.alloc(32, 7), notify, () => TODAY);
  researchCompletion({ jobs, store: { persisted: true, save: () => { throw new Error("disk full"); }, read: () => undefined }, notify, now: () => TODAY });
  const reg = jobs.register("research-x1", 3600_000, { research: { brief: "Q" } });
  assert.ok("job" in reg);
  jobs.record("research-x1", { type: "summary", status: "done", text: REPORT });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(notes.length, 2);
  assert.match(notes[1]!.text, /storing the report FAILED \(disk full\)/);
  assert.equal(notes[1]!.urgent, true);
});

// ---- 6. runner token off the command line -------------------------------------------------------------------------------------------

test("orbit-research never passes the job token in a process's arguments and leaves no header file behind", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-rf-tool-"));
  const token = ["job-1", "x".repeat(43)].join(".");
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(String(req.headers.authorization));
    res.setHeader("content-type", "application/json");
    if (req.url?.endsWith("/brief")) return res.end(JSON.stringify({ brief: "Q", budget: {}, reportSections: [] }));
    res.end(JSON.stringify({ ok: true, steers: [] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // A curl shim on PATH that records its own arguments, then runs the real curl.
  const bin = join(dir, "bin");
  const log = join(dir, "argv.log");
  const realCurl = (await run("bash", ["-c", "command -v curl"])).stdout.trim();
  await run("mkdir", ["-p", bin]);
  writeFileSync(join(bin, "curl"), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >>"${log}"\nexec "${realCurl}" "$@"\n`, { mode: 0o755 });
  const home = join(dir, "home");
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, ORBIT_RESEARCH_HOME: join(home, ".orbit-research"), ORBIT_RESEARCH_TOKEN: token };
  const tool = new URL("../tools/orbit-research/orbit-research", import.meta.url).pathname;
  try {
    const out = await run(tool, ["start", "--job", "job-1", "--api", base], { env }).then((r) => r.stdout + r.stderr, (e: { stdout: string; stderr: string }) => e.stdout + e.stderr);
    assert.ok(!out.includes(token), "never printed");
    await run(tool, ["checkin", "working"], { env }).catch(() => undefined);
    assert.ok(seen.length >= 2 && seen.every((h) => h === `Bearer ${token}`), `the server got the header: ${seen.length}`);
    const argv = readFileSync(log, "utf8");
    assert.ok(argv.includes("-H @"), "curl reads the header from a file");
    assert.ok(!argv.includes(token), "the token is in no curl argument");
    const jobDir = join(home, ".orbit-research", "job-1");
    assert.deepEqual(readdirSync(jobDir).filter((f) => f.startsWith("auth.")), [], "header files are removed");
    assert.equal((statSync(jobDir).mode & 0o777).toString(8), "700");
  } finally {
    server.close();
  }
});

test("the documented routine prompt keeps the token out of curl's arguments and says what the digest proves", () => {
  const doc = readFileSync(new URL("../deploy/routines/orbit-research.md", import.meta.url), "utf8");
  const prompt = doc.slice(doc.indexOf("## Prompt"), doc.indexOf("## If the form requires a repository"));
  assert.doesNotMatch(prompt, /-H "Authorization: Bearer/);
  assert.match(prompt, /-H @"\$HOME\/\.orbit-research-auth"/);
  assert.match(prompt, /rm -f ~\/\.orbit-research-auth/);
  assert.match(prompt, /ORBIT_RESEARCH_TOKEN='<token>' ~\/\.local\/bin\/orbit-research start/);
  assert.doesNotMatch(prompt, /--token <token>/);
  const lane = readFileSync(new URL("../docs/research-lane.md", import.meta.url), "utf8");
  assert.match(lane, /What the tool digest proves[\s\S]{0,600}not\*\* independent evidence of where the tool came from/);
});
