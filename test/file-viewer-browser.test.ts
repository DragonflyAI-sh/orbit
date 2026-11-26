import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { proposals as newProposals } from "../src/agent.ts";
import { cloneMemory } from "../src/memory.ts";
import { vaultEdits } from "../src/vault/tools.ts";
import { rig } from "./threads-fixture.ts";
import { git, makeFixture, SEED } from "./vault-fixture.ts";

// The file viewer (docs/file-viewer.md) in Chromium against the REAL server (buildServer, the real index.html and files.js) over a
// real vault clone: a throwaway bare git repository with a synthetic token (test/vault-fixture.ts). Clicking a file in the sidebar
// opens it in the centre pane; Markdown has Edit and Preview; Save commits through the vault pipeline and the remote is read back;
// the open file is marked in the sidebar; Close returns to the conversation. The other viewers (code, text, PDF, image) are driven
// on the same page with a second viewer whose reads are scripted, since the vault listing holds Markdown notes only. Skipped,
// saying so, without Playwright.

/* eslint-disable @typescript-eslint/no-explicit-any */
let playwright: any;
try { playwright = createRequire(import.meta.url)("playwright"); } catch { /* skipped below */ }
const skip = playwright ? false : "Playwright is not installed here; file viewer browser checks skipped";

let browser: any;
before(async () => { if (!skip) browser = await playwright.chromium.launch(); });
after(async () => { await browser?.close(); });

async function served() {
  const fx = makeFixture(SEED);
  const clone = fx.make();
  const memory = cloneMemory(clone, undefined);
  await memory.refresh!(0);
  let proposals: ReturnType<typeof newProposals> | undefined;
  const r = rig({ extra: (ctx) => ((proposals = ctx.proposals), { memory, vaultEdits: vaultEdits({ clone, memory, proposals: ctx.proposals }) }) });
  await r.api("/status");
  const base = `http://127.0.0.1:${(r.server.address() as { port: number }).port}`;
  const remote = (path: string) => git(fx.root, "--git-dir", fx.remote, "show", `main:${path}`);
  return { r, fx, base, remote, proposals: () => proposals! };
}

async function openPage(base: string, opts: { width?: number; height?: number; colorScheme?: string; phone?: boolean } = {}) {
  const ctx = await browser.newContext({ viewport: { width: opts.width ?? 1280, height: opts.height ?? 800 }, deviceScaleFactor: 1, colorScheme: opts.colorScheme ?? "light", ...(opts.phone ? { isMobile: true, hasTouch: true } : {}) });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.goto(`${base}/#assistant`);
  await page.waitForFunction(() => document.querySelectorAll("#navfiles .navfile").length > 0);
  return { page, ctx, errors };
}
const visible = (page: any, sel: string) => page.evaluate((s: string) => { const e = document.querySelector(s) as HTMLElement | null; return Boolean(e && e.getClientRects().length && getComputedStyle(e).visibility !== "hidden"); }, sel);
const fileButton = (path: string) => `#navfiles .navfile[data-path="${path}"]`;
const marked = (page: any) => page.$$eval("#navfiles .navfile.open", (es: HTMLElement[]) => es.map((e) => [e.dataset.path, e.getAttribute("aria-current")]));
const msg = (page: any) => page.textContent("#fileview .fmsg");

test("browser 1280px: a Markdown note opens in the centre pane, edits and previews, saves to the vault, and Close goes back", { skip }, async () => {
  const s = await served();
  const { page, ctx, errors } = await openPage(s.base);
  try {
    assert.deepEqual(await page.$$eval("#navfiles .navfile", (es: HTMLElement[]) => es.map((e) => e.dataset.path)), ["now.md", "Projects/alpha.md", "Projects/secret-rai.md"]);
    assert.equal(await visible(page, "#fileview"), false);
    await page.click(fileButton("Projects/alpha.md"));
    await page.waitForFunction(() => (document.querySelector("#fileview .fta") as HTMLTextAreaElement | null)?.value.includes("step one"));
    // The centre pane: the conversation and composer are hidden, the viewer shows the path and the note.
    assert.equal(await visible(page, "#fileview"), true);
    assert.equal(await visible(page, "#alog"), false);
    assert.equal(await visible(page, "#aform"), false);
    assert.equal(await page.textContent("#fileview .ftitle"), "alpha.md");
    assert.equal(await page.textContent("#fileview .fdir"), "Projects/");
    assert.equal(await page.textContent("#fileview .fkind"), "Markdown");
    assert.equal(await page.inputValue("#fileview .fta"), SEED["Projects/alpha.md"]);
    // Line numbers, a monospace font, Edit selected first.
    const lines = SEED["Projects/alpha.md"]!.split("\n").length;
    assert.equal((await page.textContent("#fileview .fnums")).trim().split("\n").length, lines);
    assert.match(await page.$eval("#fileview .fta", (e: Element) => getComputedStyle(e).fontFamily), /mono|Menlo|Consolas/i);
    assert.equal(await page.getAttribute("#fmode-edit", "aria-selected"), "true");
    assert.equal(await visible(page, "#fileview .fsave"), true);
    assert.equal(await page.isDisabled("#fileview .fsave"), true, "nothing to save yet");
    // The sidebar marks the open file.
    assert.deepEqual(await marked(page), [["Projects/alpha.md", "true"]]);
    // Preview: rendered Markdown, the front matter shown apart.
    await page.click("#fmode-preview");
    assert.equal(await visible(page, "#fileview .fmd"), true);
    assert.equal(await visible(page, "#fileview .fed"), false);
    assert.equal(await page.textContent("#fileview .fmd h1"), "Alpha");
    assert.deepEqual(await page.$$eval("#fileview .fmd h2", (es: Element[]) => es.map((e) => e.textContent)), ["Notes", "Plan"]);
    assert.deepEqual(await page.$$eval("#fileview .fmd li", (es: Element[]) => es.map((e) => e.textContent)), ["first", "step one"]);
    assert.match(await page.textContent("#fileview .fmd pre.ffront"), /status: active/);
    // Back to Edit, change it, Save.
    await page.click("#fmode-edit");
    await page.click("#fileview .fta");
    await page.keyboard.press("Control+End");
    await page.keyboard.type("- step two from the browser\n");
    assert.equal(await page.isDisabled("#fileview .fsave"), false);
    // The preview follows the edit.
    await page.click("#fmode-preview");
    assert.deepEqual(await page.$$eval("#fileview .fmd li", (es: Element[]) => es.map((e) => e.textContent)), ["first", "step one", "step two from the browser"]);
    await page.click("#fmode-edit");
    await page.click("#fileview .fsave");
    await page.waitForFunction(() => /^Saved to the vault \(commit [0-9a-f]{7}\)\.$/.test(document.querySelector("#fileview .fmsg")?.textContent ?? ""));
    const expected = `${SEED["Projects/alpha.md"]}- step two from the browser\n`;
    assert.equal(s.remote("Projects/alpha.md"), expected, "the remote holds exactly the editor's text");
    assert.equal(await page.isDisabled("#fileview .fsave"), true, "saved: nothing left to save");
    // Ctrl+S saves too.
    await page.click("#fileview .fta");
    await page.keyboard.press("Control+End");
    await page.keyboard.type("- and a third\n");
    assert.equal(await msg(page), "", "an edit clears the last save message");
    await page.keyboard.press("Control+s");
    await page.waitForFunction(() => /^Saved to the vault/.test(document.querySelector("#fileview .fmsg")?.textContent ?? "") && (document.querySelector("#fileview .fsave") as HTMLButtonElement).disabled);
    assert.equal(s.remote("Projects/alpha.md"), `${expected}- and a third\n`);
    // A second file opens beside it; clicking the first again switches to it (no duplicate); the sidebar mark follows.
    await page.click(fileButton("now.md"));
    await page.waitForFunction(() => document.querySelector("#fileview .ftitle")?.textContent === "now.md");
    assert.deepEqual(await page.$$eval("#fileview .ftab", (es: HTMLElement[]) => es.map((e) => e.dataset.path)), ["Projects/alpha.md", "now.md"]);
    assert.deepEqual(await marked(page), [["now.md", "true"]]);
    await page.click(fileButton("Projects/alpha.md"));
    assert.deepEqual(await page.$$eval("#fileview .ftab", (es: HTMLElement[]) => es.map((e) => e.dataset.path)), ["Projects/alpha.md", "now.md"]);
    assert.equal(await page.textContent("#fileview .ftitle"), "alpha.md");
    assert.match(await page.inputValue("#fileview .fta"), /and a third/, "the switched-to file keeps its state");
    assert.deepEqual(await marked(page), [["Projects/alpha.md", "true"]]);
    // A page tab hides the viewer and keeps the files; the file comes back from the sidebar.
    await page.click("#sessionstab");
    await page.waitForFunction(() => !document.documentElement.dataset.file);
    assert.equal(await visible(page, "#fileview"), false);
    assert.deepEqual(await marked(page), []);
    await page.click("#assistanttab");
    await page.click(fileButton("now.md"));
    await page.waitForFunction(() => document.querySelector("#fileview .ftitle")?.textContent === "now.md");
    assert.equal(await page.$$eval("#fileview .ftab", (es: Element[]) => es.length), 2);
    // Close: one file at a time, then back to the conversation.
    await page.click("#fileview .fclose");
    assert.equal(await page.textContent("#fileview .ftitle"), "alpha.md");
    await page.click("#fileview .fclose");
    await page.waitForFunction(() => !document.documentElement.dataset.file);
    assert.equal(await visible(page, "#fileview"), false);
    assert.equal(await visible(page, "#alog"), true);
    assert.equal(await visible(page, "#aform"), true);
    assert.deepEqual(await marked(page), []);
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
    s.r.close();
  }
});

test("browser: unsaved changes ask before closing; a protected note needs confirmation; a note changed elsewhere is not overwritten", { skip }, async () => {
  const s = await served();
  const { page, ctx, errors } = await openPage(s.base);
  try {
    await page.click(fileButton("now.md"));
    await page.waitForFunction(() => (document.querySelector("#fileview .fta") as HTMLTextAreaElement | null)?.value === "# Now\n");
    await page.click("#fileview .fta");
    await page.keyboard.press("Control+End");
    await page.keyboard.type("- draft");
    let asked = "";
    page.once("dialog", (d: any) => { asked = d.message(); void d.dismiss(); });
    await page.click("#fileview .fclose");
    assert.match(asked, /Close now\.md\? Its unsaved changes will be lost\./);
    assert.equal(await visible(page, "#fileview"), true, "dismissed: still open with the draft");
    assert.equal(await page.inputValue("#fileview .fta"), "# Now\n- draft");
    // Someone else changes the note on GitHub: the save is refused and their text stands.
    git(s.fx.work, "pull", "-q", "origin", "main");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${s.fx.work}/now.md`, "# Now\n- theirs\n");
    git(s.fx.work, "commit", "-qam", "theirs");
    git(s.fx.work, "push", "-q", "origin", "main");
    await page.click("#fileview .fsave");
    await page.waitForFunction(() => document.querySelector("#fileview .fmsg")?.classList.contains("err"));
    assert.match(await msg(page), /NOT saved \(precondition_failed\).*changed since it was opened/);
    assert.equal(await page.getAttribute("#fileview .fmsg", "role"), "alert");
    assert.equal(s.remote("now.md"), "# Now\n- theirs\n");
    page.once("dialog", (d: any) => void d.accept());
    await page.click("#fileview .fclose");
    await page.waitForFunction(() => !document.documentElement.dataset.file);
    // A note tagged #rai: the save becomes a confirmation card, nothing is written.
    await page.click(fileButton("Projects/secret-rai.md"));
    await page.waitForFunction(() => (document.querySelector("#fileview .fta") as HTMLTextAreaElement | null)?.value.includes("#rai"));
    await page.click("#fileview .fta");
    await page.keyboard.press("Control+End");
    await page.keyboard.type("edited\n");
    await page.click("#fileview .fsave");
    await page.waitForFunction(() => document.querySelector("#fileview .fmsg")?.classList.contains("warn"));
    assert.match(await msg(page), /^Not saved yet: this change needs your confirmation \(note is tagged #rai\)\. Confirm it under “Waiting for your click” on the Jobs page/);
    assert.equal(s.remote("Projects/secret-rai.md"), SEED["Projects/secret-rai.md"]);
    assert.equal(s.proposals().list().length, 1);
    assert.equal(await page.isDisabled("#fileview .fsave"), false, "the draft is kept and can be saved again");
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
    s.r.close();
  }
});

test("browser: code is highlighted with line numbers, text is a plain editor, PDFs and images are view-only, all without a Save button", { skip }, async () => {
  const s = await served();
  const { page, ctx, errors } = await openPage(s.base);
  try {
    // A second viewer on the same pane, with scripted reads (the vault listing has Markdown notes only).
    await page.evaluate(() => {
      const files: Record<string, string> = {
        "src/app.ts": 'import { a } from "./b.ts";\n// a comment\nexport function run(n: number): string {\n  return n > 1 ? "many" : `one ${a}`;\n}\n',
        "notes/server.log": "line one\nline two\n",
      };
      (window as any).saved = [];
      (window as any).v2 = (window as any).OrbitFiles.createViewer(document, document.getElementById("fileview"), {
        load: async (p: string) => (p in files ? { ok: true, text: files[p], editable: true, sha: "f".repeat(64) } : { ok: false, error: "not here" }),
        save: async (p: string, sha: string, text: string) => { (window as any).saved.push([p, sha, text]); files[p] = text; return { ok: true, status: "committed", commit: "abcdef1234" }; },
        fileUrl: (p: string) => (p.endsWith(".pdf") ? "/files/paper.pdf" : "/avatar.png"),
      });
    });
    await page.evaluate(() => (window as any).v2.open("src/app.ts"));
    await page.waitForSelector("#fileview .fed.hl .fhl .tk-keyword");
    assert.equal(await page.textContent("#fileview .fkind"), "JavaScript / TypeScript");
    assert.equal(await visible(page, "#fileview .fmodes"), false, "no Edit/Preview for code");
    const kinds = await page.$$eval("#fileview .fhl span", (es: Element[]) => [...new Set(es.map((e) => e.className))].sort());
    for (const k of ["tk-comment", "tk-fn", "tk-keyword", "tk-number", "tk-string"]) assert.ok(kinds.includes(k), `${k} in ${kinds}`);
    assert.equal(await page.textContent("#fileview .fhl"), `${await page.inputValue("#fileview .fta")}\n`, "the highlighted copy is the text");
    assert.equal((await page.textContent("#fileview .fnums")).trim().split("\n").length, 6);
    // The textarea and the highlighted copy share every metric, so the caret sits on the coloured text.
    const metrics = await page.evaluate(() => {
      const pick = (e: Element) => { const c = getComputedStyle(e); return [c.fontFamily, c.fontSize, c.lineHeight, c.paddingTop, c.paddingLeft, c.letterSpacing, c.tabSize, c.whiteSpace].join("|"); };
      return [pick(document.querySelector("#fileview .fta")!), pick(document.querySelector("#fileview .fhl")!)];
    });
    assert.equal(metrics[0], metrics[1]);
    // Typing re-highlights; scrolling moves the copy and the numbers with the text.
    await page.click("#fileview .fta");
    await page.keyboard.press("Control+End");
    await page.keyboard.type(Array.from({ length: 60 }, (_, i) => `const v${i} = ${i};`).join("\n"));
    await page.waitForFunction(() => document.querySelector("#fileview .fhl")!.textContent!.includes("const v59 = 59;"));
    assert.equal((await page.textContent("#fileview .fnums")).trim().split("\n").length, 65);
    // The editor stays inside the window and scrolls inside itself; it never grows with the text.
    const box = await page.evaluate(() => { const b = document.querySelector("#fileview .fed")!.getBoundingClientRect(); const t = document.querySelector("#fileview .fta") as HTMLTextAreaElement; return { bottom: b.bottom, vh: window.innerHeight, scrollable: t.scrollHeight > t.clientHeight }; });
    assert.ok(box.bottom <= box.vh, JSON.stringify(box));
    assert.equal(box.scrollable, true);
    await page.$eval("#fileview .fta", (e: HTMLTextAreaElement) => { e.scrollTop = 200; e.dispatchEvent(new Event("scroll")); });
    const moved = await page.evaluate(() => [(document.querySelector("#fileview .fhl") as HTMLElement).style.transform, (document.querySelector("#fileview .fnums") as HTMLElement).style.transform]);
    assert.match(moved[0], /translate\(0px, -200px\)/);
    assert.equal(moved[1], "translateY(-200px)");
    await page.click("#fileview .fsave");
    await page.waitForFunction(() => (window as any).saved.length === 1);
    assert.match(await msg(page), /Saved to the vault \(commit abcdef1\)\./);
    // Plain text: no highlighting, still numbered and monospace, editable.
    await page.evaluate(() => (window as any).v2.open("notes/server.log"));
    await page.waitForFunction(() => (document.querySelector("#fileview .fta") as HTMLTextAreaElement | null)?.value === "line one\nline two\n");
    assert.equal(await page.$$eval("#fileview .fhl", (es: Element[]) => es.length), 0);
    assert.equal(await page.textContent("#fileview .fkind"), "Text");
    assert.equal(await visible(page, "#fileview .fsave"), true);
    // PDF: an embedded, sandboxed viewer, no editor, no Save.
    await page.evaluate(() => (window as any).v2.open("Resources/paper.pdf"));
    assert.equal(await page.getAttribute("#fileview iframe.fpdf", "src"), "/files/paper.pdf");
    assert.equal(await page.getAttribute("#fileview iframe.fpdf", "sandbox"), "");
    assert.equal(await visible(page, "#fileview .fsave"), false);
    assert.equal(await page.$$eval("#fileview .fta", (es: Element[]) => es.length), 0);
    assert.equal(await page.textContent("#fileview .fkind"), "PDF · read-only");
    // Image: shown, no Save.
    await page.evaluate(() => (window as any).v2.open("Resources/photo.png"));
    await page.waitForFunction(() => (document.querySelector("#fileview img.fimg") as HTMLImageElement | null)?.complete);
    assert.equal(await page.getAttribute("#fileview img.fimg", "alt"), "Resources/photo.png");
    assert.equal(await visible(page, "#fileview .fsave"), false);
    // A file that cannot be read says so.
    await page.evaluate(() => (window as any).v2.open("missing.txt"));
    await page.waitForSelector("#fileview .fnote.err");
    assert.equal(await page.textContent("#fileview .fnote.err"), "not here");
    assert.equal(await visible(page, "#fileview .fsave"), false);
    assert.equal(await page.$$eval("#fileview .ftab", (es: Element[]) => es.length), 5);
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
    s.r.close();
  }
});

test("browser: Markdown never runs as HTML, and syntax colours keep AA contrast in Light and Dark", { skip }, async () => {
  const s = await served();
  for (const colorScheme of ["light", "dark"]) {
    const { page, ctx, errors } = await openPage(s.base, { colorScheme });
    try {
      // Markdown that tries to be HTML or script stays text; only http(s) links are links.
      const result = await page.evaluate(() => {
        const box = document.createElement("div");
        box.append((window as any).OrbitFiles.renderMarkdown(document, '<img src=x onerror="window.pwned=1"> [x](javascript:window.pwned=1) <script>window.pwned=1</script>\n\n[ok](https://example.com)'));
        return { imgs: box.querySelectorAll("img, script").length, links: [...box.querySelectorAll("a")].map((a) => a.getAttribute("href")), text: box.textContent };
      });
      assert.equal(result.imgs, 0);
      assert.deepEqual(result.links, ["https://example.com"]);
      assert.match(result.text, /<img src=x onerror=/);
      assert.equal(await page.evaluate(() => (window as any).pwned), undefined);
      // Every syntax colour against the editor's background.
      const ratios = await page.evaluate(() => {
        const host = document.createElement("div");
        host.className = "fed";
        document.body.append(host);
        const bg = getComputedStyle(host).backgroundColor;
        const lum = (c: string) => { const [r, g, b] = c.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!; };
        const out: Record<string, number> = {};
        for (const k of ["comment", "keyword", "string", "number", "literal", "fn", "type", "property", "tag", "meta", "var"]) {
          const s = document.createElement("span");
          s.className = `tk-${k}`;
          host.append(s);
          const a = lum(getComputedStyle(s).color), b = lum(bg);
          out[k] = Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
        }
        host.remove();
        return out;
      });
      for (const [k, ratio] of Object.entries(ratios as Record<string, number>)) assert.ok(ratio >= 4.5, `${colorScheme} ${k}: ${ratio}`);
      assert.deepEqual(errors, []);
    } finally {
      await ctx.close();
    }
  }
  s.r.close();
});

test("browser 390px phone: opening a file from the drawer closes it, shows the file full width, and nothing scrolls sideways", { skip }, async () => {
  const s = await served();
  const { page, ctx, errors } = await openPage(s.base, { width: 390, height: 780, phone: true });
  try {
    await page.click("#navbtn");
    await page.waitForFunction(() => document.getElementById("nav")!.getClientRects().length > 0 && !document.getElementById("navscrim")!.hidden);
    await page.click(fileButton("Projects/alpha.md"));
    await page.waitForFunction(() => (document.querySelector("#fileview .fta") as HTMLTextAreaElement | null)?.value.includes("step one"));
    assert.equal(await page.evaluate(() => document.getElementById("navscrim")!.hidden), true, "the drawer closed");
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("ftitle")), true, "focus is on the file's name");
    const g = await page.evaluate(() => { const b = document.getElementById("fileview")!.getBoundingClientRect(); return { left: b.left, right: b.right, vw: document.documentElement.clientWidth, sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth }; });
    assert.equal(g.sideways, false);
    assert.ok(g.left <= 1 && g.right >= g.vw - 60, JSON.stringify(g));
    assert.equal(await visible(page, "#fileview .fsave"), true);
    assert.equal(await visible(page, "#fileview .fclose"), true);
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
    s.r.close();
  }
});
