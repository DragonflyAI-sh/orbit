import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// The web page's Markdown rendering, overflow containment, button states and navigation. The script blocks are loaded on
// their own against a tiny fake DOM; the CSS and markup are checked as text. None of this is visual proof: layout is
// checked in a real browser separately (see the job summary), not here.

const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
const grab = (name: string) => html.match(new RegExp(`// <${name}>([\\s\\S]*?)// </${name}>`))?.[1] ?? "";
const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));

// Text can only arrive as a string child or textContent; any attempt to parse HTML throws.
class Fake {
  tag: string;
  kids: (Fake | string)[] = [];
  props: Record<string, unknown> = {};
  constructor(tag: string, props: Record<string, unknown> = {}) {
    this.tag = tag;
    for (const [k, v] of Object.entries(props)) {
      if (/^(innerHTML|outerHTML|srcdoc)$/.test(k)) throw new Error(`${k} must never be set`);
      if (k === "textContent") this.kids.push(String(v));
      else this.props[k] = v;
    }
  }
  append(...k: (Fake | string)[]) {
    this.kids.push(...k);
  }
  text(): string {
    return this.kids.map((k) => (typeof k === "string" ? k : k.text())).join("");
  }
  all(): Fake[] {
    return [this, ...this.kids.flatMap((k) => (typeof k === "string" ? [] : k.all()))];
  }
  find(tag: string): Fake[] {
    return this.all().filter((n) => n.tag === tag);
  }
}
type Mk = (tag: string, props?: Record<string, unknown>, ...kids: (Fake | string)[]) => Fake;
const mk: Mk = (tag, props, ...kids) => {
  const f = new Fake(tag, props);
  f.append(...kids);
  return f;
};
const lib = new Function(`${grab("notes")}; ${grab("markdown")}; ${grab("threads")}; return { renderMarkdown, safeHref, renderStoredMessage };`)() as {
  renderMarkdown: (t: string, m: Mk) => Fake;
  safeHref: (u: string) => string | null;
  renderStoredMessage: (m: unknown, mk: Mk) => Fake;
};
const md = (t: string) => lib.renderMarkdown(t, mk);
const tags = (n: Fake) => n.all().map((x) => x.tag);
// Every element the renderer may create. Nothing else (img, script, iframe, style, svg, form, input...) ever appears.
const ALLOWED = new Set(["div", "p", "h3", "h4", "h5", "h6", "strong", "em", "del", "code", "pre", "a", "ul", "ol", "li", "blockquote", "hr", "table", "thead", "tbody", "tr", "th", "td"]);

// ---- Markdown -----------------------------------------------------------------------------------------------------------

test("markdown: paragraphs, headings, emphasis, inline code and line breaks", () => {
  const n = md("# Title\n\nFirst line\nsecond line with **bold**, *em*, _also em_, ~~gone~~ and `a <b> c`.\n\n### Small");
  const [h1, p, h3] = n.kids as Fake[];
  assert.equal(h1!.tag, "h3", "a top-level heading stays below the page's own heading levels");
  assert.equal(h1!.text(), "Title");
  assert.equal(p!.tag, "p");
  assert.ok(p!.text().startsWith("First line\nsecond line"), "single newlines are kept (CSS shows them)");
  assert.equal(p!.find("strong")[0]!.text(), "bold");
  assert.deepEqual(p!.find("em").map((e) => e.text()), ["em", "also em"]);
  assert.equal(p!.find("del")[0]!.text(), "gone");
  assert.equal(p!.find("code")[0]!.text(), "a <b> c", "code is text, never markup");
  assert.equal(h3!.tag, "h5");
});

test("markdown: identifiers and URLs with underscores or asterisks are not mangled", () => {
  const n = md("call snake_case_name and 2 * 3 * 4, see https://github.com/o/r/blob/main/a_b_c.md");
  assert.equal(n.find("em").length, 0);
  assert.equal(n.text(), "call snake_case_name and 2 * 3 * 4, see https://github.com/o/r/blob/main/a_b_c.md");
  assert.deepEqual(n.find("a").map((a) => a.props.href), ["https://github.com/o/r/blob/main/a_b_c.md"]);
});

test("markdown: bullet, ordered and nested lists, with loose items as paragraphs", () => {
  const n = md("Steps:\n- one\n- two with `code`\n  - nested a\n  - nested b\n- three\n\n3. third\n4. fourth\n\n- loose a\n\n- loose b");
  const [p, ul, ol, loose] = n.kids as Fake[];
  assert.equal(p!.tag, "p", "a list may start right after a paragraph line");
  assert.equal(ul!.tag, "ul");
  assert.deepEqual((ul!.kids as Fake[]).map((li) => li.tag), ["li", "li", "li"]);
  const nested = (ul!.kids[1] as Fake).find("ul")[0]!;
  assert.deepEqual((nested.kids as Fake[]).map((li) => li.text()), ["nested a", "nested b"]);
  assert.equal((ul!.kids[0] as Fake).find("p").length, 0, "tight items are not wrapped in paragraphs");
  assert.equal(ol!.tag, "ol");
  assert.equal(ol!.props.start, 3);
  assert.equal(loose!.find("p").length, 2);
});

test("markdown: fenced code keeps its text exactly and scrolls in a keyboard-focusable region", () => {
  const code = "const x = '<script>alert(1)</script>';\n    indented   spaces\n" + "y".repeat(400);
  const n = md("Before\n\n```js\n" + code + "\n```\nAfter");
  const region = n.kids[1] as Fake;
  assert.equal(region.props.className, "scrollx");
  assert.equal(region.props.tabIndex, 0, "keyboard users can focus it and scroll with the arrow keys");
  assert.equal(region.props.role, "region");
  assert.equal(region.props.ariaLabel, "Code (js)");
  const c = region.find("code")[0]!;
  assert.equal(c.text(), code);
  assert.equal(c.props.className, "lang-js");
  assert.equal(n.find("script").length, 0);
  assert.equal((n.kids[2] as Fake).text(), "After");
});

test("markdown: an unclosed fence (a reply cut short) still shows everything as code", () => {
  const n = md("Start\n```\nline 1\nline 2");
  assert.equal(n.find("code")[0]!.text(), "line 1\nline 2");
  const lang = md("```js\"onmouseover=alert(1)\nx\n```").find("code")[0]!;
  assert.match(String(lang.props.className ?? ""), /^lang-[\w+-]*$/, "the language label cannot inject attributes");
});

test("markdown: tables with header, alignment and ragged rows, inside a scroll region", () => {
  const n = md("| Name | Count | Note |\n|:-----|------:|:----:|\n| a | 1 | **x** |\n| b \\| c | 2 |\n\nafter");
  const region = n.kids[0] as Fake;
  assert.equal(region.props.className, "scrollx");
  assert.equal(region.props.tabIndex, 0);
  assert.equal(region.props.ariaLabel, "Table");
  const table = region.find("table")[0]!;
  assert.deepEqual(table.find("th").map((t) => t.text()), ["Name", "Count", "Note"]);
  assert.deepEqual(table.find("th").map((t) => t.props.className), [undefined, "al-right", "al-center"]);
  const rows = table.find("tbody")[0]!.find("tr");
  assert.deepEqual(rows.map((r) => r.find("td").map((td) => td.text())), [["a", "1", "x"], ["b | c", "2", ""]]);
  assert.equal(rows[0]!.find("strong").length, 1);
  assert.equal((n.kids[1] as Fake).text(), "after");
});

test("markdown: block quotes and rules", () => {
  const n = md("> quoted **text**\n> more\n\n---\n\nend");
  assert.deepEqual((n.kids as Fake[]).map((k) => k.tag), ["blockquote", "hr", "p"]);
  assert.equal(n.find("blockquote")[0]!.find("strong")[0]!.text(), "text");
});

// ---- Untrusted content --------------------------------------------------------------------------------------------------

test("markdown XSS: raw HTML is shown as text and never becomes an element", () => {
  const evil = [
    `<img src=x onerror=alert(1)>`,
    `<script>alert(document.cookie)</script>`,
    `<iframe srcdoc="<script>alert(1)</script>"></iframe>`,
    `<a href="javascript:alert(1)" onclick="alert(2)">click</a>`,
    `<svg onload=alert(1)><style>*{display:none}</style>`,
    `<details open ontoggle=alert(1)>`,
    `**<b onmouseover=alert(1)>bold</b>**`,
    `| <img src=x onerror=alert(1)> | b |\n|---|---|\n| <script>x</script> | ok |`,
  ].join("\n\n");
  const n = md(evil);
  for (const node of n.all()) {
    assert.ok(ALLOWED.has(node.tag), `unexpected element <${node.tag}>`);
    for (const k of Object.keys(node.props)) assert.ok(!/^on/i.test(k), `event handler prop ${k}`);
  }
  for (const literal of ["<img src=x onerror=alert(1)>", "<script>alert(document.cookie)</script>", `<a href="javascript:alert(1)" onclick="alert(2)">click</a>`, "<b onmouseover=alert(1)>bold</b>"]) {
    assert.ok(n.text().includes(literal), `shown literally: ${literal}`);
  }
  assert.equal(n.find("a").length, 0, "no link came out of any of it");
});

test("markdown: unsafe URL schemes never become links, in links, autolinks or images", () => {
  const bad = [
    "javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "java%0ascript:alert(1)", "javascript&#58;alert(1)",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==", "vbscript:msgbox(1)", "file:///etc/passwd",
    "http://plain.example/x", "//evil.example/x", "/status", "#frag", "mailto:a@example.com", "https:/evil.example", "https://",
  ];
  for (const url of bad) {
    assert.equal(lib.safeHref(url), null, url);
    const n = md(`[click me](${url}) and ![pic](${url}) and <${url}>`);
    assert.equal(n.find("a").length, 0, `no anchor for ${url}`);
    assert.ok(n.text().includes("click me"), "the label survives as text");
  }
  // A link whose URL was dropped still shows the URL as text, so nothing is hidden from the reader.
  assert.ok(md("[x](javascript:alert(1))").text().includes("javascript:alert(1)"));
});

test("markdown: https links open safely; images are never loaded", () => {
  const n = md("[the PR](https://github.com/o/r/pull/7 \"title\") and <https://claude.ai/code/x> and ![chart](https://tracker.example/p.png)");
  const anchors = n.find("a");
  assert.deepEqual(anchors.map((a) => a.props.href), ["https://github.com/o/r/pull/7", "https://claude.ai/code/x", "https://tracker.example/p.png"]);
  for (const a of anchors) {
    assert.equal(a.props.rel, "noopener noreferrer");
    assert.equal(a.props.target, "_blank");
    assert.equal(a.props.referrerPolicy, "no-referrer");
  }
  assert.equal(anchors[2]!.text(), "Image: chart", "an image is a plain link the reader may choose to open");
  assert.equal(n.find("img").length, 0, "no <img>: the browser never fetches it on its own");
  assert.equal(md("![alt only](http://tracker.example/p.png)").text(), "alt only");
});

test("markdown: link text never nests a second link", () => {
  const n = md("[see https://claude.ai/a and **bold**](https://github.com/o/r)");
  assert.equal(n.find("a").length, 1);
  assert.equal(n.find("a")[0]!.all().slice(1).filter((k) => k.tag === "a").length, 0);
  assert.equal(n.find("a")[0]!.find("strong").length, 1);
});

test("markdown: hostile nesting and unmatched delimiters render quickly and keep all the text", () => {
  const cases = ["> ".repeat(500) + "deep", "[".repeat(20000), "*a ".repeat(20000), "`` ` ".repeat(5000), "- ".repeat(2000) + "x", "|".repeat(5000) + "\n" + "|-".repeat(2000)];
  for (const c of cases) {
    const t0 = performance.now();
    const n = md(c);
    const ms = performance.now() - t0;
    assert.ok(ms < 2000, `rendered in ${Math.round(ms)} ms`);
    assert.ok(n.all().length < 20000);
  }
  assert.ok(md("> ".repeat(500) + "deep").text().includes("deep"));
  assert.equal(md("[".repeat(100)).text(), "[".repeat(100));
});

test("the markdown and message code never parses HTML or loads images", () => {
  const block = grab("markdown");
  assert.ok(block.length > 2000);
  assert.doesNotMatch(block, /innerHTML|outerHTML|insertAdjacentHTML|DOMParser|createContextualFragment|document\.write|eval\(|new Function|"img"|srcset/);
  const add = html.slice(html.indexOf("function add(role"), html.indexOf("// ---- Threads"));
  assert.doesNotMatch(add, /innerHTML/);
});

// ---- Messages: stored (restored), pending and live ----------------------------------------------------------------------

test("a stored reply renders as Markdown; the user's own text, pending and error messages stay plain", () => {
  const reply = lib.renderStoredMessage({ id: "1", role: "assistant", at: "t", text: "## Done\n\n- **one**\n- two", status: "done", provenance: "live", source: "model/x" }, mk);
  assert.equal(reply.find("div").some((d) => d.props.className === "md"), true);
  assert.equal(reply.find("h4")[0]!.text(), "Done");
  assert.equal(reply.find("li").length, 2);
  assert.equal(reply.find("span").at(-1)!.text(), "live · model/x", "the provenance tag is still shown");
  const user = lib.renderStoredMessage({ id: "2", role: "user", at: "t", text: "**not bold** <i>x</i>", status: "done" }, mk);
  assert.equal(user.find("strong").length, 0);
  assert.equal(user.text(), "**not bold** <i>x</i>");
  const pending = lib.renderStoredMessage({ id: "3", role: "assistant", at: "t", text: "# partial", status: "pending" }, mk);
  assert.equal(pending.text(), "Working…");
  assert.equal(pending.find("h3").length, 0);
  const failed = lib.renderStoredMessage({ id: "4", role: "assistant", at: "t", text: "", status: "error", error: "provider **down**" }, mk);
  assert.equal(failed.find("strong").length, 0);
  assert.match(failed.text(), /error: provider \*\*down\*\*/);
});

test("the legacy chat renders a model reply as Markdown and errors as text", () => {
  const add = html.slice(html.indexOf("function add(role"), html.indexOf("// ---- Threads"));
  assert.match(add, /if \(extra\?\.reply\) node\.append\(renderMarkdown\(text, el\)\); else node\.textContent = text;/);
});

// ---- Overflow containment (CSS) -----------------------------------------------------------------------------------------

const rule = (selector: string) => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`(?:^|[}\\s,])${esc}\\s*\\{([^}]*)\\}`, "m"))?.[1] ?? "";
};

test("message cards wrap long prose and URLs and never widen the page", () => {
  const msg = rule(".msg");
  assert.match(msg, /max-width:\s*min\(720px,\s*100%\)/);
  assert.match(msg, /min-width:\s*0/);
  assert.match(msg, /overflow-wrap:\s*anywhere/);
  assert.match(rule(".card"), /min-width:\s*0/);
  assert.match(rule(".proposal pre"), /max-height:\s*240px/);
  assert.match(rule(".proposal pre"), /overflow-wrap:\s*anywhere/);
});

test("wide code and tables scroll inside a bounded region; nothing is clipped without a scrollbar", () => {
  const sx = rule(".scrollx");
  assert.match(sx, /max-width:\s*100%/);
  assert.match(sx, /max-height:\s*60vh/);
  assert.match(sx, /overflow:\s*auto/);
  assert.match(rule(".md pre"), /white-space:\s*pre;/);
  assert.match(rule(".compact pre"), /overflow:\s*auto/);
  assert.doesNotMatch(css, /overflow(-x|-y)?:\s*hidden/, "no content is hidden by clipping");
  assert.doesNotMatch(css, /text-overflow:\s*ellipsis/);
  // Scroll regions are reachable by keyboard: the job summary and card briefs are focusable too.
  assert.match(html, /mdScroll\(el\("pre", \{ textContent: j\.summary\.text \}\), "Full summary", el\)/);
  assert.match(html, /brief\.tabIndex = 0;/);
  assert.match(html, /mk\("pre", \{ tabIndex: 0, textContent: s\.text \}\)/);
});

// ---- Buttons ------------------------------------------------------------------------------------------------------------

test("buttons have hover, pressed, keyboard focus and disabled states, and respect reduced motion", () => {
  assert.match(rule("button:not(:disabled):hover"), /box-shadow:/);
  assert.match(rule("button:not(:disabled):active"), /transform:/);
  assert.match(css, /button:focus-visible[^{]*\{\s*outline:\s*2px solid/);
  const disabled = rule("button:disabled");
  assert.match(disabled, /cursor:\s*not-allowed/);
  assert.match(disabled, /opacity:\s*\.5/);
  assert.match(disabled, /transform:\s*none/);
  // The hover and pressed looks never apply to a disabled button.
  assert.doesNotMatch(css, /button:hover|button:active/);
  const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.ok(reduced.length > 20, "a reduced-motion block exists");
  assert.match(reduced, /transition:\s*none !important/);
  assert.match(reduced, /transform:\s*none/);
  // Link-style buttons (inbox "more", "×", "show all") get a visible hover too, not just the gradient buttons.
  assert.match(css, /\.note button:not\(:disabled\):hover[^{]*\{[^}]*background:/);
});

test("Send is disabled while a message is in flight, while the thread is archived and while a thread is opening", () => {
  assert.match(html, /<button id="send">Send<\/button>/);
  assert.match(html, /sendButton\.disabled = true;/);
  // Afterwards the owner's bar decides (it knows about a pending navigation); the stateless chat re-enables directly.
  assert.match(html, /finally \{\s*sending = false;\s*if \(threadMode === "server"\) renderBar\(\); else sendButton\.disabled = input\.disabled;/);
  assert.match(html, /document\.getElementById\("send"\)\.disabled = input\.disabled \|\| sending \|\| Boolean\(pending\);/);
  // Enter or Send during a pending navigation sends nothing and keeps the text (chat-browser.test.ts checks it for real).
  // An archived thread takes nothing either, even from a submit that bypasses the disabled controls; both checks come
  // before the box is cleared.
  assert.match(html, /if \(threadMode === "server" && pending\) \{ renderBar\(\); return; \}\s*(\/\/[^\n]*\n\s*)?if \(threadMode === "server" && current\?\.archived\) \{ renderBar\(\); return; \}\s*input\.value = "";/);
});

// ---- Navigation ---------------------------------------------------------------------------------------------------------

const nav = html.match(/<nav id="tabs"[^>]*>([\s\S]*?)<\/nav>/)?.[0] ?? "";
const links = [...nav.matchAll(/<a ([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({ attrs: m[1]!, href: m[1]!.match(/href="([^"]*)"/)?.[1] ?? "", label: m[2]!.replace(/<[^>]+>/g, "").trim() }));

test("navigation is real links to the page's views and the status endpoint, nothing invented", () => {
  assert.match(nav, /aria-label="ORBIT pages"/);
  assert.deepEqual(links.map((l) => l.href), ["/#assistant", "/#chat", "/#jobs", "/status"]);
  assert.equal(nav.includes("<button"), false, "no button pretends to be navigation");
  // Each destination is a GET route the server really has: "/" serves this page (Chat and Jobs are its views), and
  // "/status" answers with JSON, which the link says.
  assert.match(server, /req\.method === "GET" && url\.pathname === "\/"\)/);
  assert.match(server, /req\.method === "GET" && url\.pathname === "\/status"\)/);
  assert.match(server, /url\.pathname === "\/jobs" && req\.method === "GET"/, "the Jobs view has its owner-only data route");
  const status = links.find((l) => l.href === "/status")!;
  assert.match(status.label, /Status\s*JSON/);
  assert.match(status.attrs, /title="[^"]*JSON/);
  // No API or state-changing endpoint is offered as a link.
  for (const l of links) assert.doesNotMatch(l.href, /\/(chat\/proposals|jobs\/launch|threads|notifications|schedule|model|ops|runs|tools|nodes|ports)\b|\/steer|\/confirm|\/cancel/);
});

test("the Jobs link shows only for the owner and the views follow the address", () => {
  const jobs = links.find((l) => l.href === "/#jobs")!;
  assert.match(jobs.attrs, /\bhidden\b/, "hidden until the owner check passes");
  // The Assistant is the first link and the default page (docs/assistant.md); test/assistant-page.test.ts checks the routing itself.
  assert.match(links.find((l) => l.href === "/#assistant")!.attrs, /aria-current="page"/);
  assert.match(html, /jobsTab\.hidden = !pr\.ok;/);
  assert.match(html, /const tabFromHash = \(\) => pageFor\(location\.hash, !jobsTab\.hidden, !assistantTab\.hidden\);/);
  assert.match(html, /window\.addEventListener\("hashchange", \(\) => setTab\(tabFromHash\(\)\)\);/);
  assert.match(html, /if \(a\.dataset\.tab === next\) a\.setAttribute\("aria-current", "page"\); else a\.removeAttribute\("aria-current"\);/);
});
