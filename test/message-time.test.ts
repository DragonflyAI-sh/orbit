import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ZONE } from "../src/time.ts";
import { pageHtml } from "../src/server.ts";

// Message times (the msgtime block in src/web/index.html): the label beside the sender's name and the full date, time and
// zone, from the time ORBIT stored with the message, on the configured zone's calendar days. Every case here uses a fixed
// clock and a fixed zone, so it does not depend on when or where the test runs. The page in a real browser (both surfaces,
// the day rollover, hover, focus and tap) is in message-layout-browser.test.ts.

const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
const grab = (name: string) => html.match(new RegExp(`// <${name}>([\\s\\S]*?)// </${name}>`))?.[1] ?? "";

type Stamp = { iso?: string; label: string; full: string; provisional?: boolean };
const lib = new Function(`${grab("msgtime")}; return { msgTime, msgStamp, msgZoneOk };`)() as {
  msgTime: (at: unknown, nowMs: number, zone: string) => { iso: string; label: string; full: string } | null;
  msgStamp: (state: string, at: unknown, role: string, nowMs: number, zone: string) => Stamp;
  msgZoneOk: (zone: unknown) => boolean;
};
const LA = "America/Los_Angeles";
const at = (iso: string) => Date.parse(iso);
const label = (stored: string, now: string, zone = LA) => lib.msgTime(stored, at(now), zone)?.label;

test("the msgtime block sits inside the threads block, so every loader of the message parts has it", () => {
  const threads = grab("threads");
  assert.ok(threads.includes("// <msgtime>") && threads.includes("function msgTime("));
  assert.ok(grab("msgtime").length > 0);
});

test("today shows the time only; yesterday says Yesterday; older days show month and day; other years add the year", () => {
  const now = "2026-11-17T22:30:00Z"; // Tuesday, November 17, 2026, 2:30 PM PST
  assert.equal(label("2026-11-17T21:04:00Z", now), "1:04 PM");
  assert.equal(label("2026-11-17T08:00:00Z", now), "12:00 AM", "local midnight is today");
  assert.equal(label("2026-11-17T07:59:59Z", now), "Yesterday at 11:59 PM", "one second before local midnight is yesterday");
  assert.equal(label("2026-11-16T08:00:00Z", now), "Yesterday at 12:00 AM");
  assert.equal(label("2026-11-16T07:59:00Z", now), "Nov 15 at 11:59 PM", "two calendar days back is a date");
  assert.equal(label("2026-11-03T20:15:00Z", now), "Nov 3 at 12:15 PM");
  assert.equal(label("2026-01-01T08:00:00Z", now), "Jan 1 at 12:00 AM");
  assert.equal(label("2025-12-31T23:00:00Z", now), "Dec 31, 2025 at 3:00 PM", "a previous year includes the year");
  assert.equal(label("2019-02-28T18:30:00Z", now), "Feb 28, 2019 at 10:30 AM");
});

test("the full text names the weekday, the date, the time to the second, the zone's abbreviation and the zone", () => {
  const t = lib.msgTime("2026-11-17T08:05:09.123Z", at("2026-11-17T22:30:00Z"), LA)!;
  assert.equal(t.full, "Tuesday, November 17, 2026 at 12:05:09 AM PST (America/Los_Angeles)");
  assert.equal(t.iso, "2026-11-17T08:05:09.123Z", "the machine-readable time is the stored instant");
  assert.equal(lib.msgTime("2026-11-17T00:05:09-08:00", at("2026-11-17T22:30:00Z"), LA)!.iso, "2026-11-17T08:05:09.000Z", "an offset time is the same instant");
});

test("calendar days are the configured zone's, not UTC's and not the test machine's", () => {
  const now = "2026-11-17T22:30:00Z";
  // 03:00 UTC on the 17th is 7:00 PM on the 16th in Los Angeles.
  assert.equal(label("2026-11-17T03:00:00Z", now, LA), "Yesterday at 7:00 PM");
  assert.equal(label("2026-11-17T03:00:00Z", now, "UTC"), "3:00 AM");
  assert.equal(label("2026-11-17T03:00:00Z", now, "Asia/Tokyo"), "Yesterday at 12:00 PM", "now is already the 18th in Tokyo");
  assert.match(lib.msgTime("2026-11-17T03:00:00Z", at(now), "Asia/Tokyo")!.full, /\(Asia\/Tokyo\)$/);
});

test("midnight, a new year and the reader's clock just past midnight", () => {
  // Just after local midnight on January 1, 2027.
  const now = "2027-01-01T08:00:30Z";
  assert.equal(label("2027-01-01T08:00:10Z", now), "12:00 AM");
  assert.equal(label("2027-01-01T07:59:50Z", now), "Yesterday at 11:59 PM", "yesterday wins over the year change");
  assert.equal(label("2026-12-30T20:00:00Z", now), "Dec 30, 2026 at 12:00 PM", "two days back across the year shows the year");
  // A stored time later than the reader's clock (clock skew between devices) is shown as a date, never as "today" of a different day.
  assert.equal(label("2027-01-02T20:00:00Z", now), "Jan 2 at 12:00 PM");
});

test("daylight saving: spring forward (a 23-hour day) and fall back (a 25-hour day, the repeated hour told apart by zone)", () => {
  // March 8, 2026: 2:00 AM PST becomes 3:00 AM PDT (10:00 UTC).
  const spring = "2026-03-08T19:00:00Z"; // 12:00 PM PDT
  assert.equal(label("2026-03-08T09:59:00Z", spring), "1:59 AM");
  assert.equal(label("2026-03-08T10:00:00Z", spring), "3:00 AM");
  assert.match(lib.msgTime("2026-03-08T09:59:00Z", at(spring), LA)!.full, /1:59:00 AM PST/);
  assert.match(lib.msgTime("2026-03-08T10:00:00Z", at(spring), LA)!.full, /3:00:00 AM PDT/);
  assert.equal(label("2026-03-08T08:00:00Z", spring), "12:00 AM", "the day's own midnight (PST) is today");
  // 23 h 45 min earlier, but two calendar days back: a 24-hour rule would wrongly say "Yesterday".
  assert.equal(label("2026-03-08T07:45:00Z", "2026-03-09T07:30:00Z"), "Mar 7 at 11:45 PM");
  // November 1, 2026: 2:00 AM PDT becomes 1:00 AM PST (09:00 UTC), so 1:30 AM happens twice.
  const twice = ["2026-11-01T08:30:00Z", "2026-11-01T09:30:00Z"].map((s) => lib.msgTime(s, at("2026-11-17T22:30:00Z"), LA)!);
  assert.deepEqual(twice.map((t) => t.label), ["Nov 1 at 1:30 AM", "Nov 1 at 1:30 AM"]);
  assert.match(twice[0]!.full, /1:30:00 AM PDT/);
  assert.match(twice[1]!.full, /1:30:00 AM PST/);
  // 24 h 15 min earlier, but the same calendar day: a 24-hour rule would wrongly say "Yesterday".
  assert.equal(label("2026-11-01T07:15:00Z", "2026-11-02T07:30:00Z"), "12:15 AM");
  assert.equal(label("2026-11-01T06:59:00Z", "2026-11-02T07:30:00Z"), "Yesterday at 11:59 PM");
});

test("a missing, malformed or ambiguous stored time is never guessed: it is reported as unknown", () => {
  const now = at("2026-11-17T22:30:00Z");
  for (const bad of [undefined, null, "", "t", "2026", "2026-11-17", "2026-11-17 08:00:00", "2026-11-17T08:00:00", "2026-13-40T25:61:00Z", "Tue Nov 17 2026", 1763366400000, {}, ["2026-11-17T08:00:00Z"]]) {
    assert.equal(lib.msgTime(bad, now, LA), null, `rejected: ${JSON.stringify(bad)}`);
    const s = lib.msgStamp("stored", bad, "assistant", now, LA);
    assert.deepEqual(s, { label: "Time unknown", full: "No valid time was recorded for this message.", provisional: true });
  }
  assert.equal(lib.msgTime("2026-11-17T08:00:00Z", Number.NaN, LA), null, "no clock, no relative label");
  assert.equal(lib.msgTime("2026-11-17T08:00:00Z", now, "Not/AZone"), null, "an unknown zone is not guessed at");
  assert.equal(lib.msgZoneOk("Not/AZone"), false);
  assert.equal(lib.msgZoneOk(LA), true);
});

test("rows ORBIT has not stored show their state, never a time; stored rows say what the time means", () => {
  const now = at("2026-11-17T22:30:00Z");
  for (const [state, text] of [["sending", "Sending…"], ["waiting", "Waiting…"], ["unsaved", "Not saved"]] as const) {
    const s = lib.msgStamp(state, "2026-11-17T21:00:00Z", "user", now, LA);
    assert.equal(s.label, text);
    assert.equal(s.iso, undefined, `${state}: no machine-readable time, even when one is passed`);
    assert.equal(s.provisional, true);
    assert.doesNotMatch(s.full, /\d{1,2}:\d{2}/, `${state}: no clock time in the details`);
  }
  const sent = lib.msgStamp("stored", "2026-11-17T21:04:00Z", "user", now, LA);
  assert.deepEqual(sent, { iso: "2026-11-17T21:04:00.000Z", label: "1:04 PM", full: "Sent Tuesday, November 17, 2026 at 1:04:00 PM PST (America/Los_Angeles)" });
  const reply = lib.msgStamp("stored", "2026-11-16T21:04:00Z", "assistant", now, LA);
  assert.equal(reply.label, "Yesterday at 1:04 PM");
  assert.equal(reply.full, "Reply started Monday, November 16, 2026 at 1:04:00 PM PST (America/Los_Angeles)");
});

// ---- the rendered parts, against a small fake DOM that refuses HTML parsing ---------------------------------------------

class Fake {
  tag: string;
  kids: (Fake | string)[] = [];
  props: Record<string, unknown> = {};
  dataset: Record<string, string> = {};
  [k: string]: unknown;
  constructor(tag: string, props: Record<string, unknown> = {}) {
    this.tag = tag;
    for (const [k, v] of Object.entries(props)) {
      if (/^(innerHTML|outerHTML|srcdoc)$/.test(k)) throw new Error(`${k} must never be set`);
      if (k === "textContent") this.kids.push(String(v));
      else { this.props[k] = v; this[k] = v; }
    }
  }
  append(...k: (Fake | string)[]) { this.kids.push(...k); }
  replaceChildren(...k: (Fake | string)[]) { this.kids = [...k]; }
  text(): string { return this.kids.map((k) => (typeof k === "string" ? k : k.text())).join(""); }
  all(): Fake[] { return [this, ...this.kids.flatMap((k) => (typeof k === "string" ? [] : k.all()))]; }
  find(tag: string): Fake[] { return this.all().filter((n) => n.tag === tag); }
  cls(c: string): Fake[] { return this.all().filter((n) => String(n.className ?? n.props.className ?? "").split(" ").includes(c)); }
}
const mk = (tag: string, props?: Record<string, unknown>, ...kids: (Fake | string)[]) => { const n = new Fake(tag, props); n.append(...kids); return n; };

// The page's zone comes from its meta tag; the rendering below runs with a fixed clock.
const fakeDocument = { querySelector: (s: string) => (s === 'meta[name="orbit-time-zone"]' ? { getAttribute: () => LA } : null) };
const page = new Function("document", `${grab("notes")}; ${grab("markdown")}; ${grab("threads")}; ${grab("assistant-parts")}; return { renderStoredMessage, messageParts, assistantParts, localMessage, msgZone };`)(fakeDocument) as {
  renderStoredMessage: (m: unknown, mk: unknown) => Fake;
  messageParts: (m: unknown, mk: unknown) => { key: string; sig: string; build: () => Fake }[];
  assistantParts: (m: unknown, mk: unknown, cardSpec: unknown, chunk: unknown, form: unknown) => { key: string; sig: string; build: () => Fake }[];
  localMessage: (mk: unknown, role: string, owner: boolean, state: string, text: string) => Fake;
  msgZone: () => string;
};
function at2(fixed: string, fn: () => void) {
  const real = Date.now;
  Date.now = () => Date.parse(fixed);
  try { fn(); } finally { Date.now = real; }
}

test("a stored message row: icon, name, a <time> with the stored instant, and the full time in the control's name", () => {
  assert.equal(page.msgZone(), LA, "the zone is the page's configured one");
  at2("2026-11-17T22:30:00Z", () => {
    const user = page.renderStoredMessage({ id: "1", role: "user", at: "2026-11-17T21:04:00Z", text: "hello" }, mk);
    const reply = page.renderStoredMessage({ id: "2", role: "assistant", at: "2025-06-01T16:00:00Z", text: "**hi**", status: "done", provenance: "live", source: "m" }, mk);
    for (const [row, name, iso, lbl, full] of [
      [user, "Rai", "2026-11-17T21:04:00.000Z", "1:04 PM", "Sent Tuesday, November 17, 2026 at 1:04:00 PM PST (America/Los_Angeles)"],
      [reply, "ORBIT", "2025-06-01T16:00:00.000Z", "Jun 1, 2025 at 9:00 AM", "Reply started Sunday, June 1, 2025 at 9:00:00 AM PDT (America/Los_Angeles)"],
    ] as const) {
      assert.equal(row.kids[0] instanceof Fake && (row.kids[0] as Fake).props.className, "mavatar", "the icon comes first");
      assert.equal((row.kids[1] as Fake).props.className, "mhead", "then the name and time line");
      assert.equal(row.cls("mname")[0]!.text(), name);
      const time = row.find("time");
      assert.equal(time.length, 1);
      assert.equal(time[0]!.props.dateTime, iso);
      assert.equal(time[0]!.text(), lbl);
      const b = row.find("button")[0]!;
      assert.equal(b.props.type, "button");
      assert.equal(b.ariaLabel, `${lbl}. ${full}`, "screen readers get the full date, time and zone");
      assert.equal(b.ariaExpanded, "false");
      assert.equal(row.cls("mtip")[0]!.text(), full, "the tip shown on hover, focus and tap says the same");
      assert.equal(row.cls("mtip")[0]!.props.ariaHidden, "true", "and is not read twice");
      assert.deepEqual({ ...b.dataset }, { state: "stored", at: iso.replace(".000Z", "Z"), role: name === "Rai" ? "user" : "assistant" }, "what the clock tick needs to relabel it");
    }
    assert.equal(user.cls("mavatar")[0]!.tag, "span");
    assert.equal(user.cls("mavatar")[0]!.text(), "R", "Rai's icon is an initial, not an image or an outside avatar service");
    assert.equal(reply.cls("mavatar")[0]!.tag, "img");
    assert.equal(reply.cls("mavatar")[0]!.props.src, "/avatar.png", "ORBIT's icon is its own local image");
    assert.equal(reply.find("strong")[0]!.text(), "hi", "the reply is still Markdown");
  });
});

test("a tap on the time toggles its details; leaving it closes them", () => {
  at2("2026-11-17T22:30:00Z", () => {
    const row = page.renderStoredMessage({ id: "1", role: "user", at: "2026-11-17T21:04:00Z", text: "x" }, mk);
    const b = row.find("button")[0]!;
    (b.onclick as () => void)();
    assert.equal(b.ariaExpanded, "true");
    (b.onclick as () => void)();
    assert.equal(b.ariaExpanded, "false");
    (b.onclick as () => void)();
    (b.onblur as () => void)();
    assert.equal(b.ariaExpanded, "false");
  });
});

test("missing and invalid stored times say so on both surfaces; pending replies keep their stored start time", () => {
  at2("2026-11-17T22:30:00Z", () => {
    for (const bad of [undefined, "", "garbage"]) {
      const parts = page.messageParts({ id: "1", role: "assistant", ...(bad === undefined ? {} : { at: bad }), text: "x", status: "done" }, mk);
      const head = parts.find((p) => p.key === "head")!.build();
      assert.equal(head.find("time").length, 0, "no <time> element for a time that is not known");
      assert.match(head.text(), /^ORBITTime unknownNo valid time was recorded for this message\.$/);
    }
    const pending = { id: "p", role: "assistant", at: "2026-11-17T22:29:00Z", text: "", status: "pending", calls: [] };
    const done = { ...pending, status: "done", text: "Finished.", provenance: "live", source: "m" };
    const sig = (m: unknown) => page.messageParts(m, mk).filter((p) => p.key === "avatar" || p.key === "head").map((p) => [p.key, p.sig]);
    assert.deepEqual(sig(pending), sig(done), "finishing a reply never rebuilds its icon or its time");
    const head = page.messageParts(pending, mk).find((p) => p.key === "head")!.build();
    assert.equal(head.find("time")[0]!.text(), "2:29 PM");
    const a = page.assistantParts(pending, mk, () => null, null, "full").map((p) => p.key);
    assert.deepEqual(a.slice(0, 3), ["avatar", "head", "body"], "the Assistant shows the same icon and time line first");
  });
});

test("the page's own rows (sending, waiting, not saved) use the same layout and carry no time at all", () => {
  at2("2026-11-17T22:30:00Z", () => {
    for (const [role, state, owner, name, text] of [["user", "sending", true, "Rai", "Sending…"], ["assistant", "waiting", true, "ORBIT", "Waiting…"], ["assistant", "unsaved", false, "ORBIT", "Not saved"], ["user", "unsaved", false, "You", "Not saved"]] as const) {
      const row = page.localMessage(mk, role, owner, state, "body <b>text</b>");
      assert.equal(row.props.className, `msg ${role === "user" ? "user" : "orbit"}`);
      assert.equal(row.find("time").length, 0, `${state}: no <time>`);
      assert.equal(row.cls("mname")[0]!.text(), name);
      assert.equal(row.find("button")[0]!.find("span")[0]!.text(), text);
      assert.equal(row.find("b").length, 0, "the text stays text");
      assert.equal(row.cls("body")[0]!.text(), "body <b>text</b>");
    }
  });
});

test("the server writes ORBIT's configured zone into the page, and nothing else", () => {
  assert.match(html, /<meta name="orbit-time-zone" content="America\/Los_Angeles">/, "the file's default is the configured zone");
  assert.match(pageHtml(html, ZONE), new RegExp(`<meta name="orbit-time-zone" content="${ZONE.replace("/", "\\/")}">`));
  assert.match(pageHtml(html, "Europe/Berlin"), /<meta name="orbit-time-zone" content="Europe\/Berlin">/);
  const hostile = pageHtml(html, `UTC"><script>alert(1)</script>`);
  assert.match(hostile, /<meta name="orbit-time-zone" content="UTCscriptalert1\/script">/, "only zone-name characters get through");
  assert.equal(pageHtml(html, ZONE).length - html.length, ZONE.length - "America/Los_Angeles".length, "nothing else in the page changes");
});
