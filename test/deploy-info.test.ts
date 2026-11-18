import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { isPagePath } from "./helpers/sessions-ui.ts";
import { pageHtml } from "../src/server.ts";

// The running release in the expanded status line (the deployinfo block in src/web/index.html): "Deployed" is the time
// deploy/pull-deploy.sh recorded for the running commit (/status deploy.lastDeployed.at), "Commit" is the commit the process
// runs (/status commit), shortened to 7 characters with the full one on hover and in its accessible name. The pure helpers run
// with a fixed zone; the page runs in a real browser (Playwright's Chromium) against a scripted fake of ORBIT's routes, and is
// skipped, saying so, where Playwright is not installed. Offline: no model, no real ORBIT.

const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
const grab = (name: string) => html.match(new RegExp(`// <${name}>([\\s\\S]*?)// </${name}>`))?.[1] ?? "";
type Row = { na: string } | { iso: string; label: string; full: string } | { short: string; full: string };
type Info = { deployed: Row; commit: Row };
const lib = new Function(`${grab("msgtime")}; ${grab("deployinfo")}; return { deployInfo, deployTime, deployCommit, deployInstant };`)() as {
  deployInfo(s: unknown, zone: string): Info;
  deployTime(at: unknown, zone: string): { iso: string; label: string; full: string } | null;
  deployCommit(c: unknown): { short: string; full: string } | null;
  deployInstant(at: unknown): number | null;
};
const LA = "America/Los_Angeles";
const SHA = "2d2228b4dc8b7d2bdb10ea98da716cbfa5ebcad4";
const OTHER = "eba4fd5aa1b2c3d4e5f60718293a4b5c6d7e8f90";
const status = (commit: unknown, lastDeployed?: unknown) => ({ commit, deploy: lastDeployed === undefined ? {} : { lastDeployed }, ports: [] });
const na = (r: Row) => ("na" in r ? r.na : null);

// ---- pure helpers -----------------------------------------------------------------------------------------------------

test("deploy time: an absolute date and time with the zone's abbreviation, in the configured zone, never raw ISO", () => {
  const t = lib.deployTime("2026-11-17T22:04:09Z", LA)!;
  assert.equal(t.label, "Nov 17, 2026, 2:04 PM PST");
  assert.equal(t.iso, "2026-11-17T22:04:09.000Z", "the machine-readable instant is the recorded one");
  assert.equal(t.full, "Tuesday, November 17, 2026 at 2:04:09 PM PST (America/Los_Angeles) · 2026-11-17T22:04:09Z");
  assert.doesNotMatch(t.label, /T\d{2}:|Z$|Invalid/);
  // Daylight time and other zones: the abbreviation follows the date, and the calendar day is the zone's, not UTC's.
  assert.equal(lib.deployTime("2026-07-04T03:30:00Z", LA)!.label, "Jul 3, 2026, 8:30 PM PDT");
  assert.equal(lib.deployTime("2026-07-04T03:30:00Z", "UTC")!.label, "Jul 4, 2026, 3:30 AM UTC");
  assert.match(lib.deployTime("2026-07-04T03:30:00Z", "Asia/Tokyo")!.full, /\(Asia\/Tokyo\) · 2026-07-04T03:30:00Z$/);
  // An offset or fractional seconds is the same instant; the full text keeps milliseconds only when there are some.
  assert.equal(lib.deployTime("2026-11-17T14:04:09-08:00", LA)!.iso, "2026-11-17T22:04:09.000Z");
  assert.match(lib.deployTime("2026-11-17T22:04:09.250Z", LA)!.full, / · 2026-11-17T22:04:09\.250Z$/);
  // Midnight and noon read as people say them.
  assert.equal(lib.deployTime("2026-11-18T08:00:00Z", LA)!.label, "Nov 18, 2026, 12:00 AM PST");
  assert.equal(lib.deployTime("2026-11-18T20:00:00Z", LA)!.label, "Nov 18, 2026, 12:00 PM PST");
});

test("deploy time: missing, malformed or impossible times and bad zones give null, never Invalid Date or a rolled-over date", () => {
  for (const at of [undefined, null, "", 0, 1763417049000, {}, "unknown", "2026-11-17", "2026-11-17 22:04:09Z", "2026-11-17T22:04:09",
    "Tue Nov 17 2026", "2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z", "2026-11-31T00:00:00Z", "2026-11-17T24:00:00Z",
    "2026-11-17T22:60:00Z", "2026-11-17T22:04:61Z", "2026-11-17T22:04:09+25:00", "2026-11-17T22:04:09Z\n", " 2026-11-17T22:04:09Z"]) {
    assert.equal(lib.deployInstant(at), null, String(JSON.stringify(at)));
    assert.equal(lib.deployTime(at, LA), null, String(JSON.stringify(at)));
  }
  assert.equal(lib.deployTime("2024-02-29T12:00:00Z", LA)!.label, "Feb 29, 2024, 4:00 AM PST", "a real leap day is kept");
  for (const zone of ["", "Not/AZone", null]) assert.equal(lib.deployTime("2026-11-17T22:04:09Z", zone as string), null, String(zone));
});

test("commit: shortened to 7 characters with the full commit kept; anything that is not a commit id is refused", () => {
  assert.deepEqual(lib.deployCommit(SHA), { short: "2d2228b", full: SHA });
  assert.deepEqual(lib.deployCommit(SHA.toUpperCase()), { short: "2d2228b", full: SHA }, "case does not matter");
  assert.deepEqual(lib.deployCommit("2d2228b"), { short: "2d2228b", full: "2d2228b" }, "an already short id stays as it is");
  const sha256 = "a".repeat(64);
  assert.deepEqual(lib.deployCommit(sha256), { short: "aaaaaaa", full: sha256 });
  for (const c of [undefined, null, "", "unknown", "2d2228", "a".repeat(65), `${SHA} `, "g".repeat(40), "drill-20261117T000000Z-1", 42, {}]) {
    assert.equal(lib.deployCommit(c), null, String(JSON.stringify(c)));
  }
});

test("deploy info: the running commit and its own deploy time", () => {
  const info = lib.deployInfo(status(SHA, { commit: SHA, at: "2026-11-17T22:04:09Z" }), LA);
  assert.deepEqual(info.commit, { short: "2d2228b", full: SHA });
  assert.equal("label" in info.deployed && info.deployed.label, "Nov 17, 2026, 2:04 PM PST");
});

test("deploy info: a deploy record for another commit is never shown as the running release's time", () => {
  // e.g. a deploy recorded for a newer commit that is not what this process runs, or a stale record after a manual switch.
  const info = lib.deployInfo(status(SHA, { commit: OTHER, at: "2026-11-17T22:04:09Z" }), LA);
  assert.deepEqual(info.commit, { short: "2d2228b", full: SHA }, "the commit is still the running one");
  assert.equal(na(info.deployed), "The last recorded deploy is of eba4fd5, not the running release, so its time is not shown.");
  assert.equal(na(lib.deployInfo(status(SHA, { commit: "unknown", at: "2026-11-17T22:04:09Z" }), LA).deployed), "The deploy record names no valid commit, so its time is not shown.");
});

test("deploy info: absent or invalid metadata says Unavailable, with the reason, and nothing is invented", () => {
  assert.deepEqual(lib.deployInfo(null, LA), { deployed: { na: "ORBIT's status could not be read." }, commit: { na: "ORBIT's status could not be read." } });
  // ORBIT_COMMIT unset: /status says "unknown". No time can be matched to an unknown release.
  const unknown = lib.deployInfo(status("unknown", { commit: SHA, at: "2026-11-17T22:04:09Z" }), LA);
  assert.match(na(unknown.commit)!, /not known/);
  assert.match(na(unknown.deployed)!, /not known/);
  // No deploy state configured, or none recorded yet.
  assert.equal(na(lib.deployInfo({ commit: SHA, deploy: { state: "unknown", detail: "No deploy state file is configured." } }, LA).deployed), "No deploy is recorded for the running release.");
  assert.equal(na(lib.deployInfo({ commit: SHA }, LA).deployed), "No deploy is recorded for the running release.");
  assert.equal(na(lib.deployInfo(status(SHA, "yes"), LA).deployed), "No deploy is recorded for the running release.");
  // A record for the running commit without a usable time.
  for (const at of [undefined, "", "not a date", "2026-02-30T00:00:00Z"]) {
    assert.equal(na(lib.deployInfo(status(SHA, { commit: SHA, at }), LA).deployed), "The deploy record has no valid time.", String(at));
  }
  // None of the fallbacks ever show a time made up from something else.
  for (const s of [null, status("unknown"), status(SHA), status(SHA, { commit: SHA })]) {
    assert.doesNotMatch(JSON.stringify(lib.deployInfo(s, LA)), /Invalid|NaN|\d{4}-\d{2}-\d{2}T/);
  }
});

test("the markup: the deployment rows are a labelled list inside the status line, after the pills and the /status link", () => {
  const line = html.match(/<div id="statusline"[^>]*>[\s\S]*?<\/dl><\/div>/)?.[0] ?? "";
  assert.match(line, /<div id="ports"><\/div><a id="statusopen"[\s\S]*?<\/a><dl id="deployinfo" aria-label="Running release"><dt>Deployed<\/dt><dd id="deployedat">[\s\S]*?<\/dd><dt>Commit<\/dt><dd id="deploycommit">/);
  assert.doesNotMatch(grab("deployinfo"), /Date\.now|new Date\(\)|performance\.now|mtime|lastModified/, "no time from the page's clock or a file");
});

// ---- the page in a real browser ---------------------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
let playwright: any;
try { playwright = createRequire(import.meta.url)("playwright"); } catch { /* skipped below */ }
const skip = playwright ? false : "Playwright is not installed here; browser-level deployment info checks skipped";

const page0 = pageHtml(html, LA);
let answer: { code: number; body: unknown } = { code: 200, body: {} };
const ports = [{ port: "model", state: "live", detail: "model detail" }, { port: "memory", state: "live", detail: "memory detail" }];
const server = createServer((req, res) => {
  const url = new URL(req.url!, "http://x");
  const json = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (isPagePath(url.pathname)) { res.writeHead(200, { "content-type": "text/html" }); return res.end(page0); }
  if (url.pathname === "/status") return json(answer.code, answer.body);
  if (url.pathname === "/notifications") return json(200, { inbox: [], current: [] });
  if (url.pathname === "/model/login") return json(403, { error: "no" });
  if (url.pathname === "/chat/proposals") return json(200, { proposals: [] });
  if (url.pathname === "/jobs") return json(200, { jobs: [] });
  if (url.pathname === "/threads") return json(200, { threads: [], notice: null });
  if (url.pathname === "/assistant") return json(200, { assistant: { session: { id: "assistant" }, title: "Assistant", persisted: true, problems: [], busy: false, rev: 1, archivedChunks: 0, chunks: [], next: { included: [], omitted: [], historyChars: 0 }, budgets: {} } });
  if (url.pathname === "/assistant/history") return json(200, { chunks: [], more: false });
  json(404, { error: "not found" });
});

let browser: any, context: any, page: any, base = "";
before(async () => {
  if (skip) return;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  browser = await playwright.chromium.launch();
});
after(async () => { await browser?.close(); server.close(); });

const good = () => ({ commit: SHA, deploy: { lastDeployed: { commit: SHA, at: "2026-11-17T22:04:09Z" } }, ports });
async function open(opts: { width?: number; colorScheme?: string; wait?: string } = {}) {
  await context?.close();
  context = await browser.newContext({ viewport: { width: opts.width ?? 900, height: 700 }, colorScheme: opts.colorScheme ?? "light", timezoneId: "Asia/Tokyo" });
  page = await context.newPage();
  await page.goto(base);
  await page.waitForFunction(() => document.readyState === "complete");
  await page.waitForFunction((w: string) => !document.getElementById("deployedat")!.textContent!.includes(w), opts.wait ?? "Not read yet");
}
const visible = (sel: string) => page.evaluate((s: string) => { const e = document.querySelector(s) as HTMLElement | null; return Boolean(e && e.offsetParent !== null); }, sel);
// What each row shows on screen.
const rows = () => page.$$eval("#deployinfo > *", (es: HTMLElement[]) => es.map((e) => `${e.tagName}:${e.textContent}`));

test("browser: collapsed shows only the indicator; expanded shows Deployed and Commit under the pills, in the configured zone", { skip }, async () => {
  answer = { code: 200, body: good() };
  await open();
  assert.equal(await page.getAttribute("#health", "aria-expanded"), "false");
  assert.equal(await visible("#deployinfo"), false, "collapsed: no deployment rows");
  assert.equal(await page.textContent("#health .label"), "All live", "the collapsed indicator is unchanged");
  await page.click("#health");
  assert.equal(await visible("#deployinfo"), true);
  // The browser is in Tokyo; the page uses ORBIT's configured zone, as message times do.
  assert.deepEqual(await rows(), ["DT:Deployed", "DD:Nov 17, 2026, 2:04 PM PST", "DT:Commit", "DD:2d2228b"]);
  const time = await page.$eval("#deployedat time", (t: HTMLTimeElement) => ({ dt: t.dateTime, title: t.title }));
  assert.deepEqual(time, { dt: "2026-11-17T22:04:09.000Z", title: "Tuesday, November 17, 2026 at 2:04:09 PM PST (America/Los_Angeles) · 2026-11-17T22:04:09Z" });
  const code = await page.$eval("#deploycommit code", (c: HTMLElement) => ({ text: c.textContent, title: c.title, font: getComputedStyle(c).fontFamily }));
  assert.equal(code.text, "2d2228b");
  assert.equal(code.title, SHA, "the full commit on hover");
  assert.match(code.font, /monospace/);
  // Screen readers get the labels and the full commit; the full commit is not drawn.
  const snap = await page.locator("#deployinfo").ariaSnapshot();
  assert.match(snap, /Deployed/);
  assert.match(snap, /Nov 17, 2026, 2:04 PM PST/);
  assert.match(snap, new RegExp(`full commit ${SHA}`));
  assert.equal(await page.getAttribute("#deploycommit code", "aria-label"), `2d2228b (full commit ${SHA})`);
  assert.equal(await page.getAttribute("#deployinfo", "aria-label"), "Running release");
  // The labels line up in one column and the values in another.
  const x = await page.$$eval("#deployinfo dt, #deployinfo dd", (es: HTMLElement[]) => es.map((e) => Math.round(e.getBoundingClientRect().left)));
  assert.equal(x[0], x[2], "labels aligned");
  assert.equal(x[1], x[3], "values aligned");
  // It sits below the pills, not beside them.
  const below = await page.evaluate(() => document.getElementById("deployinfo")!.getBoundingClientRect().top >= document.getElementById("ports")!.getBoundingClientRect().bottom);
  assert.equal(below, true);
  // Collapsing hides it again.
  await page.click("#health");
  assert.equal(await visible("#deployinfo"), false);
});

test("browser: missing, mismatched or unreadable metadata shows a quiet Unavailable with the reason on hover", { skip }, async () => {
  answer = { code: 200, body: { commit: "unknown", deploy: { state: "unknown", detail: "No deploy state file is configured." }, ports } };
  await open();
  await page.click("#health");
  assert.deepEqual(await rows(), ["DT:Deployed", "DD:Unavailable", "DT:Commit", "DD:Unavailable"]);
  assert.match(await page.getAttribute("#deploycommit .na", "title"), /not known/);
  answer = { code: 200, body: { ...good(), deploy: { lastDeployed: { commit: OTHER, at: "2026-11-17T22:04:09Z" } } } };
  await page.evaluate("refreshStatus()");
  await page.waitForFunction(() => document.querySelector("#deploycommit code") !== null);
  assert.deepEqual(await rows(), ["DT:Deployed", "DD:Unavailable", "DT:Commit", "DD:2d2228b"]);
  assert.match(await page.getAttribute("#deployedat .na", "title"), /eba4fd5, not the running release/);
  answer = { code: 200, body: { ...good(), deploy: { lastDeployed: { commit: SHA, at: "garbage" } } } };
  await page.evaluate("refreshStatus()");
  await page.waitForFunction(() => document.getElementById("deployedat")!.textContent === "Unavailable" && document.querySelector("#deployedat .na")!.getAttribute("title") === "The deploy record has no valid time.");
  assert.doesNotMatch(await page.textContent("#deployinfo"), /Invalid|NaN|garbage/);
  // A failed read later keeps the last release ORBIT reported, as the pills do.
  answer = { code: 200, body: good() };
  await page.evaluate("refreshStatus()");
  await page.waitForFunction(() => document.querySelector("#deployedat time") !== null);
  answer = { code: 500, body: { error: "x" } };
  await page.evaluate("refreshStatus()");
  await page.waitForFunction(() => document.getElementById("health")!.className === "bad");
  assert.deepEqual(await rows(), ["DT:Deployed", "DD:Nov 17, 2026, 2:04 PM PST", "DT:Commit", "DD:2d2228b"]);
});

test("browser: a page whose first status read fails says Unavailable, not a time", { skip }, async () => {
  answer = { code: 500, body: { error: "x" } };
  await open({ wait: "Not read yet" });
  await page.click("#health");
  assert.deepEqual(await rows(), ["DT:Deployed", "DD:Unavailable", "DT:Commit", "DD:Unavailable"]);
  assert.equal(await page.getAttribute("#deployedat .na", "title"), "ORBIT's status could not be read.");
});

test("browser: phone and desktop widths, light and dark: no sideways scroll, nothing clipped, readable contrast", { skip }, async () => {
  answer = { code: 200, body: { ...good(), ports: [...ports, { port: "a-very-long-port-name-that-should-wrap-rather-than-overflow", state: "degraded", detail: "d" }] } };
  for (const colorScheme of ["light", "dark"]) {
    for (const width of [320, 390, 900]) {
      await open({ width, colorScheme });
      await page.click("#health");
      const m = await page.evaluate(() => {
        const box = document.getElementById("deployinfo")!.getBoundingClientRect();
        const line = document.getElementById("statusline")!.getBoundingClientRect();
        const kids = [...document.querySelectorAll("#deployinfo dt, #deployinfo dd")].map((e) => { const r = e.getBoundingClientRect(); return r.right <= box.right + 0.5 && r.left >= box.left - 0.5; });
        const dd = getComputedStyle(document.getElementById("deployedat")!);
        return { page: document.documentElement.scrollWidth <= document.documentElement.clientWidth, inside: box.right <= line.right + 0.5 && box.left >= line.left - 0.5, kids: kids.every(Boolean), fg: dd.color, bg: getComputedStyle(document.body).backgroundColor, oneLine: document.getElementById("deployedat")!.getBoundingClientRect().height < 30, linkBeside: document.getElementById("statusopen")!.getBoundingClientRect().top < document.getElementById("ports")!.getBoundingClientRect().bottom };
      });
      assert.equal(m.page, true, `no horizontal overflow at ${width}px ${colorScheme}`);
      assert.equal(m.inside, true, `rows inside the status line at ${width}px ${colorScheme}`);
      assert.equal(m.kids, true, `every label and value inside the list at ${width}px ${colorScheme}`);
      assert.equal(m.oneLine, true, `the date fits one line at ${width}px ${colorScheme}`);
      assert.equal(m.linkBeside, true, `the /status link stays beside the pills at ${width}px ${colorScheme}`);
      assert.notEqual(m.fg, m.bg);
      if (process.env.ORBIT_SCREENSHOTS) await page.locator("header").screenshot({ path: `${process.env.ORBIT_SCREENSHOTS}/deploy-${colorScheme}-${width}.png` });
    }
  }
});
