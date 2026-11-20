import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { shellServer } from "./helpers/shell-fixture.ts";

// What Return/Enter does in the message boxes (docs/design-system.md, "Composer keys"): on a touch-first device (coarse
// primary pointer, no fine pointer anywhere) Return inserts a new line and only Send sends; elsewhere Enter sends and
// Shift+Enter inserts a new line; Ctrl/Cmd+Enter sends everywhere; nothing sends while an input method is composing.
// The pure <composer-keys> block always runs; the page runs in Playwright's Chromium (phone = isMobile + hasTouch
// emulation, which is not a real phone keyboard) against the synthetic fixture, and is skipped, saying so, without it.

const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
const block = html.match(/\/\/ <composer-keys>([\s\S]*?)\/\/ <\/composer-keys>/)![1]!;
type Key = { key: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; isComposing?: boolean; keyCode?: number };
const lib = new Function(`${block}; return { touchFirst, enterAction };`)() as {
  touchFirst(mq: (q: string) => { matches: boolean }): boolean;
  enterAction(k: Key, touch: boolean): "send" | null;
};

test("touch-first: a coarse primary pointer and no fine pointer anywhere; any mouse or trackpad makes it a keyboard device", () => {
  const mq = (coarse: boolean, anyFine: boolean) => (q: string) => ({ matches: q === "(pointer: coarse)" ? coarse : q === "(any-pointer: fine)" ? anyFine : false });
  assert.equal(lib.touchFirst(mq(true, false)), true, "phone, tablet without trackpad");
  assert.equal(lib.touchFirst(mq(true, true)), false, "tablet with a trackpad or mouse attached");
  assert.equal(lib.touchFirst(mq(false, true)), false, "laptop, desktop, touch laptop (fine primary pointer)");
  assert.equal(lib.touchFirst(mq(false, false)), false, "no pointer at all (keyboard only): Enter sends");
  assert.equal(lib.touchFirst(() => { throw new Error("no matchMedia"); }), false, "unknown: the old behaviour");
  assert.doesNotMatch(block.replace(/\/\/[^\n]*/g, ""), /innerWidth|clientWidth|max-width|min-width/, "the key behaviour never depends on the viewport width");
});

test("Enter: sends on keyboard devices; adds a line on touch-first ones; Shift adds a line; Ctrl/Cmd sends; IME never sends", () => {
  const E = (k: Partial<Key> = {}) => ({ key: "Enter", keyCode: 13, ...k });
  const rows: [Key, boolean, "send" | null][] = [
    [E(), false, "send"], [E(), true, null],
    [E({ shiftKey: true }), false, null], [E({ shiftKey: true }), true, null],
    [E({ ctrlKey: true }), true, "send"], [E({ metaKey: true }), true, "send"], [E({ ctrlKey: true }), false, "send"],
    [E({ isComposing: true }), false, null], [E({ isComposing: true, ctrlKey: true }), false, null],
    [E({ keyCode: 229 }), false, null], [E({ keyCode: 229, metaKey: true }), true, null],
    [{ key: "a", keyCode: 65 }, false, null], [{ key: "Tab" }, false, null],
  ];
  for (const [k, touch, want] of rows) assert.equal(lib.enterAction(k, touch), want, `${JSON.stringify(k)} touch=${touch}`);
});

/* eslint-disable @typescript-eslint/no-explicit-any */
let playwright: any;
try { playwright = createRequire(import.meta.url)("playwright"); } catch { /* skipped below */ }
const skip = playwright ? false : "Playwright is not installed here; composer key browser checks skipped";

let chromium: any;
const fixture = shellServer({ exchanges: 2, notes: 0 });
let url = "";
before(async () => { if (skip) return; url = await fixture.start(); chromium = await playwright.chromium.launch(); });
after(async () => { await chromium?.close(); fixture.close(); });

async function open(route: string, phone: boolean) {
  const ctx = await chromium.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 800 }, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
  const page = await ctx.newPage();
  const sends: string[] = [];
  page.on("request", (r: any) => { if (r.method() === "POST" && /\/messages$/.test(new URL(r.url()).pathname)) sends.push(r.postData() ?? ""); });
  await page.goto(url + route);
  const conv = route.includes("sessions") ? "log" : "alog";
  await page.waitForFunction((id: string) => document.getElementById(id)!.querySelectorAll(".msg").length > 0, conv);
  if (conv === "log") await page.waitForFunction(() => !(document.getElementById("send") as HTMLButtonElement).disabled);
  return { page, ctx, sends };
}
const settle = (page: any) => page.waitForTimeout(250);

for (const [route, box, send] of [["/#assistant", "#ainput", "#asend"], ["/sessions", "#input", "#send"]] as const) {
  test(`browser phone (${route}): Return adds a line and sends nothing; Send sends the whole multi-line draft`, { skip }, async () => {
    const { page, ctx, sends } = await open(route, true);
    assert.equal(await page.getAttribute(box, "enterkeyhint"), "enter", "the on-screen key says return, not send");
    await page.focus(box);
    await page.keyboard.type("first line");
    await page.keyboard.press("Enter");
    await page.keyboard.type("second line");
    await page.keyboard.press("Enter");
    await page.keyboard.type("third");
    await settle(page);
    assert.deepEqual(sends, [], "no network submit from Return");
    assert.equal(await page.inputValue(box), "first line\nsecond line\nthird", "the draft keeps every line");
    const h = await page.$eval(box, (t: HTMLElement) => t.getBoundingClientRect().height);
    assert.ok(h > 60, `the box grew for the new lines (${h}px)`);
    await page.click(send);
    for (let i = 0; !sends.length && i < 100; i++) await page.waitForTimeout(20);
    assert.equal(sends.length, 1, "Send sends");
    assert.match(sends[0]!, /first line\\nsecond line\\nthird/, "multi-line text intact");
    await ctx.close();
  });
}

test("browser phone: Ctrl/Cmd+Enter sends (a hardware keyboard on a tablet without a trackpad)", { skip }, async () => {
  const { page, ctx, sends } = await open("/#assistant", true);
  await page.fill("#ainput", "via keyboard");
  await page.press("#ainput", "Control+Enter");
  for (let i = 0; !sends.length && i < 100; i++) await page.waitForTimeout(20);
  assert.equal(sends.length, 1);
  await page.fill("#ainput", "via cmd");
  await page.press("#ainput", "Meta+Enter");
  for (let i = 0; sends.length < 2 && i < 100; i++) await page.waitForTimeout(20);
  assert.equal(sends.length, 2);
  await ctx.close();
});

test("browser desktop: Enter sends, Shift+Enter adds a line, the key hint says send", { skip }, async () => {
  const { page, ctx, sends } = await open("/#assistant", false);
  assert.equal(await page.getAttribute("#ainput", "enterkeyhint"), "send");
  await page.focus("#ainput");
  await page.keyboard.type("one");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("two");
  await settle(page);
  assert.deepEqual(sends, []);
  assert.equal(await page.inputValue("#ainput"), "one\ntwo");
  await page.keyboard.press("Enter");
  for (let i = 0; !sends.length && i < 100; i++) await page.waitForTimeout(20);
  assert.equal(sends.length, 1, "Enter sends");
  assert.match(sends[0]!, /one\\ntwo/);
  await page.waitForFunction(() => (document.getElementById("ainput") as HTMLTextAreaElement).value === "");
  await ctx.close();
});

test("browser desktop: Enter during an input-method composition never sends (real Chromium composition and Safari's keyCode 229)", { skip }, async () => {
  const { page, ctx, sends } = await open("/#assistant", false);
  await page.focus("#ainput");
  // A real composition through Chromium's input-method interface: the Enter that confirms it arrives with isComposing.
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "にほん", selectionStart: 3, selectionEnd: 3 });
  await page.keyboard.press("Enter");
  await cdp.send("Input.insertText", { text: "日本" });
  await settle(page);
  assert.deepEqual(sends, [], "the confirming Enter did not send");
  assert.match(await page.inputValue("#ainput"), /^日本/);
  // Safari: compositionend first, then the confirming Enter with isComposing false but keyCode 229.
  await page.evaluate(() => {
    const t = document.getElementById("ainput")!;
    t.dispatchEvent(new CompositionEvent("compositionstart"));
    t.dispatchEvent(new CompositionEvent("compositionend", { data: "語" }));
    t.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true, cancelable: true } as KeyboardEventInit));
  });
  // A composition still open (compositionstart seen, no end yet) with a plain Enter: not sent either.
  await page.evaluate(() => {
    const t = document.getElementById("ainput")!;
    t.dispatchEvent(new CompositionEvent("compositionstart"));
    t.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true, cancelable: true }));
    t.dispatchEvent(new CompositionEvent("compositionend", { data: "" }));
  });
  await settle(page);
  assert.deepEqual(sends, [], "no send during composition");
  // After the composition, Enter sends as usual.
  await page.keyboard.press("Enter");
  for (let i = 0; !sends.length && i < 100; i++) await page.waitForTimeout(20);
  assert.equal(sends.length, 1);
  await ctx.close();
});

test("browser: the on-screen key hint is \"enter\" on a touch-first phone and \"send\" on a desktop, for both boxes", { skip }, async () => {
  const { page, ctx } = await open("/sessions", true);
  assert.equal(await page.getAttribute("#ainput", "enterkeyhint"), "enter");
  assert.equal(await page.getAttribute("#input", "enterkeyhint"), "enter");
  await ctx.close();
  const d = await open("/#assistant", false);
  assert.equal(await d.page.getAttribute("#ainput", "enterkeyhint"), "send");
  assert.equal(await d.page.getAttribute("#input", "enterkeyhint"), "send");
  await d.ctx.close();
});
