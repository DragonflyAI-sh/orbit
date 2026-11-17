import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { attachmentStore } from "../src/attachments.ts";
import type { Message } from "../src/model.ts";
import { rig, say, scripted } from "./threads-fixture.ts";

// The compact header and the message composers (Assistant #aform, Chat #form): a "+" button that adds images (no separate
// camera button), an icon-only Send with a real accessible name, and a message box that starts one line tall, grows upward
// to eight lines and then scrolls, shrinks again, and keeps "+" and Send level with its last line while the composer's
// bottom edge stays put. The markup checks always run; the rest runs in a real browser (Playwright's Chromium) against the
// REAL ORBIT server with a scripted model, and is skipped, saying so, where Playwright cannot be loaded. Chromium on Linux,
// not Safari on an iPhone: phone widths are emulated viewports.

const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
const form = (id: string) => html.match(new RegExp(`<form id="${id}"[^>]*>[\\s\\S]*?</form>`))![0];

// ---- markup ---------------------------------------------------------------------------------------------------------------

test("markup: each composer has one image picker behind a labelled + button, no camera control, and an icon Send named Send", () => {
  for (const [id, p] of [["form", ""], ["aform", "a"]] as const) {
    const f = form(id);
    assert.doesNotMatch(f, /capture=|id="\w*cam|📷|🖼|Take a photo/, `${id}: no camera input or button, no emoji icons`);
    assert.equal(f.match(/<input type="file"/g)?.length, 1, `${id}: a single file input`);
    assert.match(f, new RegExp(`<input type="file" id="${p}pick" accept="image/\\*" multiple hidden>`), `${id}: images only, several at once`);
    const plus = f.match(new RegExp(`<button type="button" class="phbtn" id="${p}pickbtn"[^>]*>([\\s\\S]*?)</button>`))!;
    assert.match(plus[0], /aria-label="Add image"/);
    assert.match(plus[0], /title="Add image/);
    assert.match(plus[1]!, /^<svg class="ico"[^>]*aria-hidden="true"[^>]*><path d="M12 5v14 M5 12h14"\/><\/svg>$/, `${id}: the + is a decorative inline icon`);
    const send = f.match(new RegExp(`<button id="${p}send"[^>]*>([\\s\\S]*?)</button>`))!;
    assert.match(send[0], /aria-label="Send"/);
    assert.match(send[0], /title="Send"/);
    assert.match(send[1]!, /^<svg class="ico"[^>]*aria-hidden="true"[^>]*>[\s\S]*<\/svg>$/, `${id}: Send shows only a decorative icon`);
    assert.doesNotMatch(send[1]!.replace(/<[^>]+>/g, ""), /\S/, `${id}: no visible Send text`);
    assert.match(f, new RegExp(`<textarea id="${p}input" rows="1"`), `${id}: the box starts one line tall`);
  }
});

// ---- the page in a real browser -------------------------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
let playwright: any;
try { playwright = createRequire(import.meta.url)("playwright"); } catch { /* skipped below */ }
const skip = playwright ? false : "Playwright is not installed here; browser composer tests skipped";

let browser: any;
before(async () => { if (!skip) browser = await playwright.chromium.launch(); });
after(async () => { await browser?.close(); });

// A minimal PNG (RGB, no filter) for a synthetic picked image.
function png(w: number, h: number): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h, 0x80);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// The model answers "echo: <text>" once `gate` is open (open by default), so a test can hold a reply to see the busy state.
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "orbit-composer-"));
  let gate: Promise<void> = Promise.resolve();
  let release = () => {};
  const hold = () => { gate = new Promise<void>((r) => { release = r; }); };
  const model = Object.assign(scripted(async (seen) => {
    await gate;
    const m = seen.input.at(-1) as Message;
    return say(`echo: ${m.content.split("\n").length} line(s), ${m.images?.length ?? 0} photo(s)`);
  }), { images: () => ({ ok: true, detail: "test" }) });
  const r = rig({ dir, model, extra: () => ({ assistantDir: join(dir, "assistant"), attachments: attachmentStore(join(dir, "attachments")) }) });
  return { r, model, hold, release: () => release() };
}
async function base(r: ReturnType<typeof rig>) {
  await r.api("/status");
  return `http://127.0.0.1:${(r.server.address() as AddressInfo).port}`;
}
async function openPage(url: string, size: { width: number; height: number }, phone = false) {
  const ctx = await browser.newContext({ viewport: size, deviceScaleFactor: 1, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
  const page = await ctx.newPage();
  await page.goto(url);
  return { page, ctx };
}
const assistantReady = (page: any) => page.waitForFunction(() => !(document.getElementById("apickbtn") as HTMLButtonElement).disabled);

// Geometry of one composer: the box, its line count, whether it scrolls inside, and where "+", Send and the form sit.
type Geo = { h: number; lines: number; overflow: string; scrolls: boolean; boxBottom: number; plusBottom: number; sendBottom: number; formBottom: number; formTop: number; vh: number; plus: { w: number; h: number; left: number; right: number }; send: { w: number; h: number; left: number; right: number }; pageOverflow: boolean };
const geo = (page: any, p: "" | "a"): Promise<Geo> => page.evaluate((p: string) => {
  const box = (id: string) => document.getElementById(id)!.getBoundingClientRect();
  const ta = document.getElementById(`${p}input`) as HTMLTextAreaElement;
  const cs = getComputedStyle(ta);
  const line = parseFloat(cs.lineHeight), chrome = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  const t = box(`${p}input`), pl = box(`${p}pickbtn`), s = box(`${p}send`), f = box(p ? "aform" : "form");
  return {
    h: t.height, lines: Math.round((t.height - chrome) / line), overflow: cs.overflowY, scrolls: ta.scrollHeight > ta.clientHeight + 1,
    boxBottom: t.bottom, plusBottom: pl.bottom, sendBottom: s.bottom, formBottom: f.bottom, formTop: f.top, vh: window.innerHeight,
    plus: { w: pl.width, h: pl.height, left: pl.left, right: pl.right }, send: { w: s.width, h: s.height, left: s.left, right: s.right },
    pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  };
}, p);
const near = (a: number, b: number, msg: string, tol = 1) => assert.ok(Math.abs(a - b) <= tol, `${msg} (${a} vs ${b})`);

test("browser: Send and + have accessible names, a visible keyboard focus ring, and Send really sends (click and Enter), busy while waiting", { skip }, async () => {
  const { r, model, hold, release } = setup();
  const { page, ctx } = await openPage(`${await base(r)}/#assistant`, { width: 900, height: 700 });
  await assistantReady(page);
  const send = page.getByRole("button", { name: "Send", exact: true });
  const plus = page.getByRole("button", { name: "Add image", exact: true });
  assert.equal(await send.count(), 1, "one visible Send button in the Assistant (Chat's is hidden)");
  assert.equal(await plus.count(), 1);
  assert.equal(await send.getAttribute("title"), "Send");
  assert.equal((await send.textContent()).trim(), "", "no visible Send text, the icon carries it");
  assert.equal(await page.locator("#asend svg").count(), 1);
  // Keyboard focus (Tab and Shift+Tab from the box, so :focus-visible applies) shows a ring on both icon buttons.
  for (const [key, id] of [["Shift+Tab", "apickbtn"], ["Tab", "asend"]] as const) {
    await page.focus("#ainput");
    await page.keyboard.press(key);
    assert.equal(await page.evaluate(() => document.activeElement!.id), id);
    const ring = await page.evaluate((id: string) => { const cs = getComputedStyle(document.getElementById(id)!); return { style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) }; }, id);
    assert.equal(ring.style, "solid", `${id} shows a focus ring`);
    assert.ok(ring.width >= 2, `${id} focus ring is at least 2px`);
  }
  // Empty: nothing is sent.
  await send.click();
  assert.equal(model.seen.length, 0, "an empty box sends nothing");
  // Click: sent, Send disabled (still named Send) while the reply is held, then the box is empty and one line again.
  hold();
  await page.fill("#ainput", "first line");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("second line");
  assert.equal((await geo(page, "a")).lines, 2, "Shift+Enter adds a line, not a send");
  assert.equal(model.seen.length, 0);
  await send.click();
  await page.waitForFunction(() => (document.getElementById("asend") as HTMLButtonElement).disabled);
  assert.equal(await page.getByRole("button", { name: "Send", exact: true }).isDisabled(), true, "busy: disabled, still named Send");
  assert.equal(await page.inputValue("#ainput"), "");
  assert.equal((await geo(page, "a")).lines, 1, "the box is one line again right after sending");
  release();
  await page.waitForFunction(() => document.getElementById("alog")!.textContent!.includes("echo: 2 line(s), 0 photo(s)"));
  await page.waitForFunction(() => !(document.getElementById("asend") as HTMLButtonElement).disabled);
  assert.equal((model.seen.at(-1)!.input.at(-1) as Message).content, "first line\nsecond line");
  // Enter sends too.
  await page.fill("#ainput", "by enter");
  await page.press("#ainput", "Enter");
  await page.waitForFunction(() => document.getElementById("alog")!.textContent!.includes("echo: 1 line(s), 0 photo(s)"));
  assert.equal((model.seen.at(-1)!.input.at(-1) as Message).content, "by enter");
  await ctx.close();
});

test("browser: + opens the image picker (several images, no forced camera), the preview shows, and the image is sent", { skip }, async () => {
  const { r, model } = setup();
  const { page, ctx } = await openPage(`${await base(r)}/#assistant`, { width: 390, height: 844 }, true);
  await assistantReady(page);
  assert.equal(await page.locator("#acam, #acambtn, input[capture]").count(), 0, "no camera control anywhere");
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click("#apickbtn")]);
  assert.equal(chooser.isMultiple(), true);
  assert.equal(await chooser.element().getAttribute("id"), "apick");
  await chooser.setFiles([{ name: "a.png", mimeType: "image/png", buffer: png(64, 48) }]);
  await page.waitForFunction(() => document.querySelectorAll('#atray .ph[data-status="ready"]').length === 1);
  // Validation still applies: a non-image is refused with its message.
  await page.setInputFiles("#apick", [{ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") }]);
  await page.waitForFunction(() => document.querySelectorAll('#atray .ph[data-status="failed"]').length === 1);
  await page.click('#atray .ph[data-status="failed"] .phx');
  await page.fill("#ainput", "what is this?");
  await page.click("#asend");
  // (The server adds a line about the attached photo to what the model gets, so only the photo count is checked.)
  await page.waitForFunction(() => /echo: \d+ line\(s\), 1 photo\(s\)/.test(document.getElementById("alog")!.textContent!));
  assert.equal((model.seen.at(-1)!.input.at(-1) as Message).images?.length, 1);
  assert.equal(await page.locator("#atray .ph").count(), 0, "the tray is empty after sending");
  await ctx.close();
});

test("browser: the box grows upward with newlines, wrapping and paste to eight lines, then scrolls; + and Send stay bottom-aligned", { skip }, async () => {
  const { r } = setup();
  const { page, ctx } = await openPage(`${await base(r)}/#assistant`, { width: 900, height: 700 });
  await assistantReady(page);
  const one = await geo(page, "a");
  assert.equal(one.lines, 1, "starts one line tall");
  assert.equal(one.overflow, "hidden");
  near(one.formBottom, one.vh, "the composer sits on the bottom edge");
  const check = async (want: number, what: string) => {
    const g = await geo(page, "a");
    assert.equal(g.lines, want, `${what}: ${want} line(s)`);
    near(g.formBottom, one.formBottom, `${what}: the composer's bottom edge does not move`);
    near(g.boxBottom, one.boxBottom, `${what}: the box grows upward`);
    near(g.plusBottom, g.boxBottom, `${what}: + is level with the box's bottom`);
    near(g.sendBottom, g.boxBottom, `${what}: Send is level with the box's bottom`);
    assert.ok(g.formTop <= one.formTop - (want - 1) * 20, `${what}: the composer's top moved up`);
    return g;
  };
  // Typed newlines, one at a time.
  await page.focus("#ainput");
  await page.keyboard.type("1");
  for (let i = 2; i <= 5; i++) { await page.keyboard.press("Shift+Enter"); await page.keyboard.type(String(i)); }
  await check(5, "five typed lines");
  // Paste-like insertion of many lines: capped at eight, then it scrolls inside, showing the end where the caret is.
  await page.keyboard.insertText("\n6\n7\n8\n9\n10\n11\n12");
  const capped = await check(8, "twelve lines (capped)");
  assert.equal(capped.overflow, "auto");
  assert.equal(capped.scrolls, true, "past eight lines the box scrolls");
  assert.equal(await page.evaluate(() => { const t = document.getElementById("ainput")!; return t.scrollHeight - t.scrollTop - t.clientHeight < 2; }), true, "scrolled to the caret at the end");
  // Deleting shrinks it again.
  for (let i = 0; i < "\n8\n9\n10\n11\n12".length; i++) await page.keyboard.press("Backspace");
  await check(7, "after deleting back to seven lines");
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  const back = await check(1, "emptied");
  assert.equal(back.overflow, "hidden");
  near(back.h, one.h, "back to the starting height");
  // Long text with no newline wraps and grows the box.
  await page.keyboard.insertText("word ".repeat(60).trim());
  const wrapped = await geo(page, "a");
  assert.ok(wrapped.lines >= 2 && wrapped.lines <= 8, `wrapped text grows the box (${wrapped.lines} lines)`);
  // A wider window wraps less: the box shrinks; a narrower one wraps more: it grows.
  await page.setViewportSize({ width: 1400, height: 700 });
  await page.waitForFunction((n: number) => document.getElementById("ainput")!.getBoundingClientRect().height < n, wrapped.h);
  await page.setViewportSize({ width: 600, height: 700 });
  await page.waitForFunction((n: number) => document.getElementById("ainput")!.getBoundingClientRect().height > n, wrapped.h);
  const g = await geo(page, "a");
  near(g.formBottom, g.vh, "after resizing the composer is still on the bottom edge");
  // An empty box fits its placeholder, and is refitted when the page changes the placeholder.
  await page.fill("#ainput", "");
  assert.equal((await geo(page, "a")).lines, 1);
  await page.evaluate(() => { (document.getElementById("ainput") as HTMLTextAreaElement).placeholder = "a long placeholder ".repeat(12); });
  await page.waitForFunction(() => document.getElementById("ainput")!.getBoundingClientRect().height > 50);
  await page.evaluate(() => { (document.getElementById("ainput") as HTMLTextAreaElement).placeholder = "Message the Assistant"; });
  await page.waitForFunction(() => document.getElementById("ainput")!.getBoundingClientRect().height < 50);
  near(g.sendBottom, g.boxBottom, "after resizing Send is still level with the box's bottom");
  await ctx.close();
});

test("browser: text the page puts back (a refused send) is measured; switching to Chat and back keeps each box's height right", { skip }, async () => {
  const { r } = setup();
  const { page, ctx } = await openPage(`${await base(r)}/#assistant`, { width: 900, height: 700 });
  await assistantReady(page);
  await page.route("**/assistant/messages", (route: any) => route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "refused for the test" }) }));
  await page.fill("#ainput", "a\nb\nc");
  await page.press("#ainput", "Enter");
  await page.waitForFunction(() => (document.getElementById("ainput") as HTMLTextAreaElement).value === "a\nb\nc");
  assert.equal((await geo(page, "a")).lines, 3, "the restored three lines are shown");
  await page.unroute("**/assistant/messages");
  // Chat's composer was hidden; once shown it measures its own text.
  await page.evaluate(() => { location.hash = "#chat"; });
  await page.waitForFunction(() => !document.getElementById("form")!.hidden);
  await page.fill("#input", "x\ny");
  assert.equal((await geo(page, "")).lines, 2);
  await page.evaluate(() => { location.hash = "#assistant"; });
  await page.waitForFunction(() => !document.getElementById("aform")!.hidden);
  assert.equal((await geo(page, "a")).lines, 3, "the Assistant box kept its three lines across the switch");
  await ctx.close();
});

test("browser: Chat composer sends multi-line text with the icon button and resets to one line", { skip }, async () => {
  const { r, model } = setup();
  const t = await r.create("Alpha");
  const { page, ctx } = await openPage(`${await base(r)}/#chat/${t.id}`, { width: 900, height: 700 });
  await page.waitForFunction((id: string) => (document.getElementById("threadsel") as HTMLSelectElement)?.value === id && !(document.getElementById("send") as HTMLButtonElement).disabled, t.id);
  assert.equal(await page.getByRole("button", { name: "Send", exact: true }).count(), 1);
  assert.equal(await page.getByRole("button", { name: "Add image", exact: true }).count(), 1);
  await page.fill("#input", "one\ntwo\nthree");
  assert.equal((await geo(page, "")).lines, 3);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.waitForFunction(() => document.getElementById("log")!.textContent!.includes("echo: 3 line(s), 0 photo(s)"));
  assert.equal((model.seen.at(-1)!.input.at(-1) as Message).content, "one\ntwo\nthree");
  assert.equal(await page.inputValue("#input"), "");
  assert.equal((await geo(page, "")).lines, 1);
  await ctx.close();
});

test("browser: compact header and composer fit desktop and narrow phones with no sideways scroll and usable targets", { skip }, async () => {
  const { r } = setup();
  const url = `${await base(r)}/#assistant`;
  for (const [size, phone] of [[{ width: 1280, height: 800 }, false], [{ width: 390, height: 844 }, true], [{ width: 320, height: 640 }, true]] as const) {
    const { page, ctx } = await openPage(url, size, phone);
    await assistantReady(page);
    const w = size.width;
    const header = await page.evaluate(() => {
      const h = document.querySelector("header")!, cs = getComputedStyle(h), b = getComputedStyle(document.getElementById("health")!), n = getComputedStyle(document.getElementById("notesbtn")!);
      return { top: parseFloat(cs.paddingTop), left: parseFloat(cs.paddingLeft), hbtn: [parseFloat(b.paddingLeft), parseFloat(n.paddingLeft)], btnH: [document.getElementById("health")!.getBoundingClientRect().height, document.getElementById("notesbtn")!.getBoundingClientRect().height] };
    });
    assert.ok(header.top <= 6 && header.left <= 12, `${w}px: tight header padding (${header.top}/${header.left})`);
    assert.ok(header.hbtn.every((x: number) => x <= 8), `${w}px: tight header button padding`);
    assert.ok(header.btnH.every((x: number) => x >= 28), `${w}px: header buttons stay at least 28px tall`);
    const form = await page.evaluate(() => { const cs = getComputedStyle(document.getElementById("aform")!); return { top: parseFloat(cs.paddingTop), left: parseFloat(cs.paddingLeft), bottom: parseFloat(cs.paddingBottom) }; });
    assert.ok(form.top <= 6 && form.left <= 12 && form.bottom >= 6, `${w}px: compact composer padding (${JSON.stringify(form)})`);
    await page.fill("#ainput", "line\n".repeat(11) + "x".repeat(300));
    const g = await geo(page, "a");
    assert.equal(g.lines, 8, `${w}px: capped at eight lines`);
    assert.equal(g.pageOverflow, false, `${w}px: no horizontal scroll`);
    for (const [name, b] of [["+", g.plus], ["Send", g.send]] as const) {
      assert.ok(b.w >= 40 && b.h >= 40, `${w}px: ${name} is at least 40×40 (${b.w}×${b.h})`);
      assert.ok(b.left >= 0 && b.right <= w, `${w}px: ${name} is on screen`);
    }
    near(g.formBottom, g.vh, `${w}px: the composer is on the bottom edge`);
    near(g.plusBottom, g.boxBottom, `${w}px: + bottom-aligned`);
    near(g.sendBottom, g.boxBottom, `${w}px: Send bottom-aligned`);
    // The header panels still open on their own and do not push anything sideways.
    await page.click("#health");
    assert.equal(await page.getAttribute("#health", "aria-expanded"), "true");
    assert.equal(await page.getAttribute("#notesbtn", "aria-expanded"), "false", "panels stay independent");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, `${w}px: no horizontal scroll with the status line open`);
    await ctx.close();
  }
});
