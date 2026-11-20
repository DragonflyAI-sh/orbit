// Before/after screenshots of the app shell with synthetic content (test/helpers/shell-fixture.ts), for review.
//   node test/helpers/shell-screens.ts <out-dir> [<before-index.html>]
// SHELL_SCREENS_SMALL=1 writes the side-by-side images as 1x JPEGs (small enough to keep in docs/web-shell/).
// SHELL_SCREENS_SET=design shoots the desktop design set instead (kept in docs/design-system/).
// With a second argument, each scenario is shot with that page too and the two are put side by side ("before" left).
// Playwright's Chromium with phone-sized viewports and touch emulation: not iOS Safari, no real keyboard or toolbar.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { shellServer, type ShellOpts } from "./shell-fixture.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
const [out, beforePath] = process.argv.slice(2);
if (!out) { console.error("usage: node test/helpers/shell-screens.ts <out-dir> [<before-index.html>]"); process.exit(2); }
mkdirSync(out, { recursive: true });
const pw = createRequire(import.meta.url)("playwright");
const before = beforePath ? readFileSync(beforePath, "utf8") : null;
const small = process.env.SHELL_SCREENS_SMALL === "1";

type Shot = { name: string; width: number; height: number; route: string; data: ShellOpts; dark?: boolean; act?: (page: any) => Promise<void> };
const shots: Shot[] = [
  { name: "375-assistant-long", width: 375, height: 667, route: "/#assistant", data: { exchanges: 24, card: true } },
  { name: "320-sessions-long", width: 320, height: 568, route: "/sessions", data: { exchanges: 24, card: true, pending: true } },
  { name: "390-multiline-composer", width: 390, height: 844, route: "/#assistant", data: { exchanges: 24 },
    act: async (p) => { await p.fill("#ainput", Array.from({ length: 12 }, (_, i) => `Draft line ${i + 1} of a long message`).join("\n")); } },
  { name: "320-session-picker", width: 320, height: 568, route: "/sessions", data: { exchanges: 8 },
    act: async (p) => { await p.waitForFunction(() => !document.getElementById("sesswrap")!.hidden); await p.click("#sessbtn"); } },
  { name: "568x320-landscape-panels", width: 568, height: 320, route: "/#assistant", data: { exchanges: 8, notes: 12 },
    act: async (p) => { await p.click("#notesbtn"); await p.click("#health"); } },
  { name: "430-dark-assistant", width: 430, height: 932, route: "/#assistant", data: { exchanges: 24, card: true }, dark: true },
  { name: "1280-desktop", width: 1280, height: 800, route: "/#assistant", data: { exchanges: 24, card: true } },
];

// SHELL_SCREENS_SET=design: the desktop design pass (docs/design-system.md): laptop widths, the header menu and panels,
// the conversation with a confirmation card, dark mode, and the phone layout for comparison.
const picker = async (p: any) => { await p.waitForFunction(() => !document.getElementById("sesswrap")!.hidden); await p.click("#sessbtn"); };
const designShots: Shot[] = [
  { name: "1280-assistant", width: 1280, height: 800, route: "/#assistant", data: { exchanges: 24, card: true } },
  { name: "1440-assistant-panels", width: 1440, height: 900, route: "/#assistant", data: { exchanges: 24, card: true, notes: 5 },
    act: async (p) => { await p.click("#notesbtn"); await p.click("#health"); } },
  { name: "1280-session-picker", width: 1280, height: 800, route: "/sessions", data: { exchanges: 24, card: true }, act: picker },
  { name: "1280-dark-sessions", width: 1280, height: 800, route: "/sessions", data: { exchanges: 24, card: true, pending: true }, dark: true },
  { name: "390-assistant", width: 390, height: 844, route: "/#assistant", data: { exchanges: 24, card: true } },
  { name: "390-session-picker", width: 390, height: 844, route: "/sessions", data: { exchanges: 8 }, act: picker },
  // The theme menu does not exist before this change; the "before" side shows the same page without it.
  { name: "1280-theme-menu", width: 1280, height: 800, route: "/#assistant", data: { exchanges: 24, card: true },
    act: async (p) => { if (await p.$("#themebtn")) await p.click("#themebtn"); } },
  { name: "1280-dark-assistant", width: 1280, height: 800, route: "/#assistant", data: { exchanges: 24, card: true }, dark: true },
  { name: "390-dark-assistant", width: 390, height: 844, route: "/#assistant", data: { exchanges: 24, card: true }, dark: true },
];
// SHELL_SCREENS_SET=panel: the desktop menu and side panel pass (docs/design-system.md, "Side panel"), kept in
// docs/side-panel/: the side panel populated with long content in both themes, the session menu with a hovered row, the
// phone header panels (unchanged) and the phone composer after Return.
const notesOpen = async (p: any) => { await p.click("#notesbtn"); await p.click("#inbox .showall"); await p.click("#inbox .note button:not(.x)"); };
const hoverMenu = async (p: any) => { await picker(p); await p.hover("#sesslist li:nth-child(2) .sitem"); };
const panelShots: Shot[] = [
  { name: "1280-side-notes", width: 1280, height: 800, route: "/#assistant", data: { exchanges: 24, card: true, notes: 14, longNotes: true }, act: notesOpen },
  { name: "1280-dark-side-notes", width: 1280, height: 800, route: "/#assistant", data: { exchanges: 24, card: true, notes: 14, longNotes: true }, dark: true, act: notesOpen },
  { name: "1440-side-status", width: 1440, height: 900, route: "/#assistant", data: { exchanges: 24, card: true, notes: 5 }, act: async (p) => { await p.click("#health"); } },
  { name: "1280-dark-side-status", width: 1280, height: 800, route: "/sessions", data: { exchanges: 24, card: true, notes: 5, pending: true }, dark: true, act: async (p) => { await p.click("#health"); } },
  { name: "1024-side-notes", width: 1024, height: 700, route: "/sessions", data: { exchanges: 24, card: true, notes: 6 }, act: async (p) => { await p.click("#notesbtn"); } },
  { name: "1280-session-menu", width: 1280, height: 800, route: "/sessions", data: { exchanges: 24, card: true }, act: hoverMenu },
  { name: "1280-dark-session-menu", width: 1280, height: 800, route: "/sessions", data: { exchanges: 24, card: true }, dark: true, act: hoverMenu },
  { name: "390-panels", width: 390, height: 844, route: "/#assistant", data: { exchanges: 24, card: true, notes: 6, longNotes: true }, act: async (p) => { await p.click("#notesbtn"); await p.click("#health"); } },
  { name: "390-dark-panels", width: 390, height: 844, route: "/#assistant", data: { exchanges: 24, card: true, notes: 6, longNotes: true }, dark: true, act: async (p) => { await p.click("#notesbtn"); await p.click("#health"); } },
  // Before: Return sent the first line (the box is empty again). After: three lines in the box, nothing sent.
  { name: "390-composer-return", width: 390, height: 844, route: "/#assistant", data: { exchanges: 24 },
    act: async (p) => { await p.focus("#ainput"); for (const [i, l] of ["First line", "Second line", "Third line"].entries()) { if (i) await p.keyboard.press("Enter"); await p.keyboard.type(l); } } },
];
if (process.env.SHELL_SCREENS_SET === "design") shots.splice(0, shots.length, ...designShots);
if (process.env.SHELL_SCREENS_SET === "panel") shots.splice(0, shots.length, ...panelShots);

const browser = await pw.chromium.launch();
async function shoot(html: string | undefined, s: Shot): Promise<Buffer> {
  const srv = shellServer({ ...s.data, ...(html ? { html } : {}) });
  const url = await srv.start();
  const phone = s.width < 1000;
  const ctx = await browser.newContext({ viewport: { width: s.width, height: s.height }, deviceScaleFactor: 2, colorScheme: s.dark ? "dark" : "light", ...(phone ? { isMobile: true, hasTouch: true } : {}) });
  const page = await ctx.newPage();
  await page.goto(url + s.route);
  await page.waitForFunction((id: string) => document.getElementById(id)!.querySelectorAll(".msg").length > 0, s.route.includes("sessions") ? "log" : "alog");
  await page.waitForTimeout(400);
  if (s.act) await s.act(page);
  await page.waitForTimeout(250);
  const png = await page.screenshot();
  await ctx.close();
  srv.close();
  return png;
}
for (const s of shots) {
  const after = await shoot(undefined, s);
  if (!before) { writeFileSync(join(out, `${s.name}.png`), after); continue; }
  const prior = await shoot(before, s);
  // Side by side: before (left), after (right), labelled.
  const ctx = await browser.newContext({ viewport: { width: s.width * 2 + 48, height: s.height + 40 }, deviceScaleFactor: small ? 1 : 2 });
  const page = await ctx.newPage();
  const img = (b: Buffer) => `data:image/png;base64,${b.toString("base64")}`;
  await page.setContent(`<body style="margin:0;background:#888;font:600 14px system-ui;display:flex;gap:16px;padding:8px 16px">${
    [["Before (main)", prior], ["After", after]].map(([l, b]) => `<figure style="margin:0"><figcaption style="height:24px;color:#fff">${l}</figcaption><img style="width:${s.width}px;height:${s.height}px;display:block" src="${img(b as Buffer)}"></figure>`).join("")}</body>`);
  if (small) writeFileSync(join(out, `${s.name}.jpg`), await page.screenshot({ type: "jpeg", quality: 72 }));
  else writeFileSync(join(out, `${s.name}.png`), await page.screenshot());
  await ctx.close();
}
await browser.close();
console.log(`wrote ${shots.length} screenshot(s) to ${out}`);
