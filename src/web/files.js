// ORBIT's file viewer and editor (docs/file-viewer.md). A file chosen in the sidebar opens in the centre of the page: its path at
// the top, then an editor or a viewer that fits its type, with Save (editable files) and Close. No framework and no download:
// the editor is a textarea laid over a highlighted copy of the same text, with line numbers beside it, so it needs nothing from
// a CDN and runs wherever the page does. Everything a file says is set as text (textContent) or built as DOM nodes, never as
// HTML, and a link leaves the page only for http(s) or mailto.
(function (global) {
  "use strict";

  // ---- File types, by extension (the whole name for dotfiles such as .env).
  const MARKDOWN = new Set(["md", "markdown"]);
  const PDF = new Set(["pdf"]);
  const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp"]);
  const LANG = {
    ts: "js", tsx: "js", js: "js", jsx: "js", mjs: "js", cjs: "js", mts: "js", cts: "js",
    py: "python", rs: "rust", go: "go", c: "c", h: "c", css: "css", html: "html", htm: "html",
    sh: "shell", bash: "shell", zsh: "shell", yml: "yaml", yaml: "yaml", json: "json",
  };
  const TEXT = new Set(["txt", "log", "csv", "tsv", "toml", "env", "ini", "conf", "cfg"]);
  const LANG_NAMES = { js: "JavaScript / TypeScript", python: "Python", rust: "Rust", go: "Go", c: "C", css: "CSS", html: "HTML", shell: "Shell", yaml: "YAML", json: "JSON" };

  function extOf(path) {
    const name = String(path || "").split("/").pop() || "";
    const dot = name.lastIndexOf(".");
    if (dot < 0) return "";
    return name.slice(dot + 1).toLowerCase();
  }
  // { kind, lang, editable, label }: kind is markdown | pdf | image | code | text | other. PDFs and images are view-only.
  function fileKind(path) {
    const ext = extOf(path);
    if (MARKDOWN.has(ext)) return { kind: "markdown", lang: "", editable: true, label: "Markdown" };
    if (PDF.has(ext)) return { kind: "pdf", lang: "", editable: false, label: "PDF" };
    if (IMAGE.has(ext)) return { kind: "image", lang: "", editable: false, label: "Image" };
    if (LANG[ext]) return { kind: "code", lang: LANG[ext], editable: true, label: LANG_NAMES[LANG[ext]] };
    if (TEXT.has(ext)) return { kind: "text", lang: "", editable: true, label: "Text" };
    return { kind: "other", lang: "", editable: true, label: "File" };
  }

  // ---- Syntax highlighting. One pass per language over an ordered list of token rules; what no rule matches is plain text.
  // The tokens always join back to exactly the input, so the highlighted copy lines up with the textarea character for character.
  const words = (s) => new Set(s.split(/\s+/).filter(Boolean));
  const KEYWORDS = {
    js: words("break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new return super switch this throw try typeof var void while with yield async await of static get set as from type interface enum implements private protected public readonly declare namespace abstract keyof satisfies"),
    python: words("and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case self"),
    rust: words("as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while"),
    go: words("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var"),
    c: words("auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while bool"),
    shell: words("if then else elif fi for while until do done case esac in function return local export readonly set unset shift exit break continue echo source"),
  };
  const LITERALS = {
    js: words("true false null undefined NaN Infinity"), python: words("True False None"), rust: words("true false None Some Ok Err"),
    go: words("true false nil iota"), c: words("NULL true false"), shell: words("true false"), json: words("true false null"), yaml: words("true false null yes no on off ~"),
  };
  const R = {
    dq: String.raw`"(?:[^"\\\n]|\\.)*"?`,
    sq: String.raw`'(?:[^'\\\n]|\\.)*'?`,
    bt: String.raw`\x60(?:[^\x60\\]|\\[\s\S])*\x60?`,
    slash: String.raw`\/\/[^\n]*`,
    block: String.raw`\/\*[\s\S]*?(?:\*\/|(?![\s\S]))`,
    hash: String.raw`(?<![^\s])#[^\n]*`,
    num: String.raw`\b(?:0[xX][\da-fA-F_]+|0[bBoO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)[a-zA-Z]{0,3}\b`,
    word: String.raw`[A-Za-z_$][\w$]*`,
  };
  const RULES = {
    js: [["comment", R.slash], ["comment", R.block], ["string", R.bt], ["string", R.dq], ["string", R.sq], ["number", R.num], ["word", R.word]],
    python: [["comment", R.hash], ["string", String.raw`[rRbBfFuU]{0,2}"""[\s\S]*?(?:"""|(?![\s\S]))`], ["string", String.raw`[rRbBfFuU]{0,2}'''[\s\S]*?(?:'''|(?![\s\S]))`], ["string", R.dq], ["string", R.sq], ["meta", String.raw`@[A-Za-z_][\w.]*`], ["number", R.num], ["word", R.word]],
    rust: [["comment", R.slash], ["comment", R.block], ["string", R.dq], ["string", String.raw`'(?:[^'\\\n]|\\.)'`], ["meta", String.raw`#!?\[[^\]\n]*\]`], ["number", R.num], ["word", String.raw`[A-Za-z_][\w]*!?`]],
    go: [["comment", R.slash], ["comment", R.block], ["string", String.raw`\x60[^\x60]*\x60?`], ["string", R.dq], ["string", R.sq], ["number", R.num], ["word", R.word]],
    c: [["comment", R.slash], ["comment", R.block], ["meta", String.raw`^[ \t]*#[ \t]*[A-Za-z]+`], ["string", R.dq], ["string", R.sq], ["number", R.num], ["word", R.word]],
    shell: [["comment", R.hash], ["string", R.dq], ["string", String.raw`'[^']*'?`], ["var", String.raw`\$\{[^}\n]*\}?|\$[A-Za-z_]\w*|\$[0-9#?@*$!-]`], ["number", String.raw`\b\d+\b`], ["word", String.raw`[A-Za-z_][\w-]*`]],
    css: [["comment", R.block], ["string", R.dq], ["string", R.sq], ["keyword", String.raw`@[\w-]+`], ["number", String.raw`#[\da-fA-F]{3,8}\b`], ["property", String.raw`[\w-]+(?=[ \t]*:[^:\n{]*[;}\n])`], ["number", String.raw`-?(?:\d*\.)?\d+(?:px|em|rem|%|vh|vw|dvh|ch|s|ms|deg|fr|pt)?\b`]],
    html: [["comment", String.raw`<!--[\s\S]*?(?:-->|(?![\s\S]))`], ["tag", String.raw`<\/?[A-Za-z][\w:-]*|\/?>`], ["property", String.raw`(?<=<[A-Za-z][^<>]*\s)[A-Za-z_:@][\w:.-]*(?=\s*=)`], ["string", String.raw`(?<==\s*)(?:"[^"]*"?|'[^']*'?)`], ["meta", String.raw`&[#\w]+;`]],
    json: [["property", String.raw`"(?:[^"\\\n]|\\.)*"(?=\s*:)`], ["string", R.dq], ["number", String.raw`-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b`], ["word", String.raw`[A-Za-z]+`]],
    yaml: [["comment", R.hash], ["meta", String.raw`^(?:---|\.\.\.)[ \t]*$`], ["property", String.raw`(?<=^[ \t]*(?:-[ \t]+)?)[^\s:#'"\-[\]{}][^:\n#]*?(?=:(?:[ \t]|$))`], ["string", R.dq], ["string", R.sq], ["number", String.raw`(?<![\w.])-?\d+(?:\.\d+)?(?![\w.])`], ["word", String.raw`[A-Za-z~]+`]],
  };
  const compiled = {};
  function ruleSet(lang) {
    if (compiled[lang]) return compiled[lang];
    const rules = RULES[lang];
    if (!rules) return null;
    compiled[lang] = { types: rules.map((r) => r[0]), re: new RegExp(rules.map((r) => `(${r[1]})`).join("|"), "gm") };
    return compiled[lang];
  }
  // [{ type, text }]: type is "" for plain text, else comment | string | number | keyword | literal | type | fn | property | tag | meta | var.
  function tokenize(code, lang) {
    const src = String(code);
    const set = ruleSet(lang);
    const out = [];
    const push = (type, text) => {
      if (!text) return;
      const last = out[out.length - 1];
      if (last && last.type === type) last.text += text;
      else out.push({ type, text });
    };
    if (!set) { push("", src); return out; }
    const re = set.re;
    re.lastIndex = 0;
    let at = 0;
    let m;
    while ((m = re.exec(src))) {
      if (m[0] === "") { re.lastIndex++; continue; }
      push("", src.slice(at, m.index));
      let i = 1;
      while (m[i] === undefined) i++;
      let type = set.types[i - 1];
      if (type === "word") {
        const w = m[0].replace(/!$/, "");
        const next = src.slice(re.lastIndex).match(/^[ \t]*(\(|<[\w, ]*>\s*\()?/);
        if (KEYWORDS[lang] && KEYWORDS[lang].has(w)) type = "keyword";
        else if (LITERALS[lang] && LITERALS[lang].has(w)) type = "literal";
        else if (m[0].endsWith("!") || (next && next[1])) type = "fn";
        else if (/^[A-Z][a-z0-9]\w*$/.test(w) && lang !== "shell" && lang !== "json" && lang !== "yaml") type = "type";
        else type = "";
      }
      push(type, m[0]);
      at = re.lastIndex;
    }
    push("", src.slice(at));
    return out;
  }
  // Fills `node` with the highlighted text, one span per token (as text, never HTML).
  function paintTokens(doc, node, code, lang) {
    const frag = doc.createDocumentFragment();
    for (const t of tokenize(code, lang)) {
      if (!t.type) { frag.append(doc.createTextNode(t.text)); continue; }
      const s = doc.createElement("span");
      s.className = `tk-${t.type}`;
      s.textContent = t.text;
      frag.append(s);
    }
    node.replaceChildren(frag);
  }

  // ---- Markdown, as blocks and inline nodes (plain data, so it is testable without a browser), then built as DOM.
  const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)[^\n]*$/;
  const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
  const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
  const ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*)|[ \t]*$)/;
  const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
  const indentOf = (line) => { let n = 0; for (const ch of line) { if (ch === " ") n++; else if (ch === "\t") n += 4; else break; } return n; };
  const dedent = (line, n) => { let i = 0, w = 0; while (i < line.length && w < n && (line[i] === " " || line[i] === "\t")) { w += line[i] === "\t" ? 4 : 1; i++; } return line.slice(i); };
  const startsBlock = (line) => FENCE.test(line) || HEADING.test(line) || RULE.test(line) || ITEM.test(line) || QUOTE.test(line);

  function parseMarkdown(text, nested) {
    const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
    const blocks = [];
    let i = 0;
    if (!nested && lines[0] === "---") {
      const end = lines.indexOf("---", 1);
      const dots = lines.indexOf("...", 1);
      const close = end > 0 && (dots < 0 || end < dots) ? end : dots;
      if (close > 0) { blocks.push({ type: "frontmatter", text: lines.slice(1, close).join("\n") }); i = close + 1; }
    }
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      let m;
      if ((m = FENCE.exec(line))) {
        const mark = m[1];
        const body = [];
        i++;
        while (i < lines.length && !new RegExp(`^ {0,3}${mark[0] === "`" ? "`" : "~"}{${mark.length},}[ \\t]*$`).test(lines[i])) body.push(lines[i++]);
        i++;
        blocks.push({ type: "code", lang: m[2].toLowerCase(), text: body.join("\n") });
        continue;
      }
      if ((m = HEADING.exec(line))) { blocks.push({ type: "heading", level: m[1].length, inline: parseInline(m[2] || "") }); i++; continue; }
      if (RULE.test(line)) { blocks.push({ type: "hr" }); i++; continue; }
      if (QUOTE.test(line)) {
        const body = [];
        while (i < lines.length && lines[i].trim() && (m = QUOTE.exec(lines[i]) || (body.length && !startsBlock(lines[i]) ? [null, lines[i]] : null))) { body.push(m[1]); i++; }
        blocks.push({ type: "quote", blocks: parseMarkdown(body.join("\n"), true) });
        continue;
      }
      if ((m = ITEM.exec(line))) {
        const base = indentOf(m[1]);
        const ordered = /\d/.test(m[2]);
        const list = { type: "list", ordered, start: ordered ? parseInt(m[2], 10) : 1, items: [] };
        while (i < lines.length) {
          const im = ITEM.exec(lines[i]);
          if (!im || indentOf(im[1]) !== base || /\d/.test(im[2]) !== ordered) break;
          const contentAt = base + im[2].length + 1;
          const body = [im[3] || ""];
          i++;
          while (i < lines.length) {
            const l = lines[i];
            if (!l.trim()) {
              // A blank line ends the item unless the next line is indented under it.
              if (i + 1 < lines.length && lines[i + 1].trim() && indentOf(lines[i + 1]) > base) { body.push(""); i++; continue; }
              break;
            }
            if (indentOf(l) > base) { body.push(dedent(l, contentAt)); i++; continue; }
            if (startsBlock(l)) break;
            body.push(l.trim()); i++; // a lazy continuation of the paragraph
          }
          let task = null;
          const tm = /^\[([ xX])\][ \t]+/.exec(body[0]);
          if (tm) { task = tm[1] !== " "; body[0] = body[0].slice(tm[0].length); }
          list.items.push({ task, blocks: parseMarkdown(body.join("\n"), true) });
          if (i < lines.length && !lines[i].trim()) {
            // Keep the list going across a blank line when the next item continues it.
            let j = i; while (j < lines.length && !lines[j].trim()) j++;
            const nm = j < lines.length ? ITEM.exec(lines[j]) : null;
            if (nm && indentOf(nm[1]) === base && /\d/.test(nm[2]) === ordered) i = j;
          }
        }
        blocks.push(list);
        continue;
      }
      const para = [];
      while (i < lines.length && lines[i].trim() && !(para.length && startsBlock(lines[i]))) para.push(lines[i++].trim());
      blocks.push({ type: "para", inline: parseInline(para.join("\n")) });
    }
    return blocks;
  }

  const INLINE = new RegExp([
    String.raw`(?<code>(\x60+)(?<codeText>[\s\S]*?[^\x60])\2(?!\x60))`,
    String.raw`(?<wiki>\[\[(?<wikiTarget>[^\]|\n]+)(?:\|(?<wikiLabel>[^\]\n]+))?\]\])`,
    String.raw`(?<image>!\[(?<imageAlt>[^\]\n]*)\]\((?<imageUrl>[^)\s]+)(?:\s+"[^"\n]*")?\))`,
    String.raw`(?<link>\[(?<linkText>[^\]\n]+)\]\((?<linkUrl>[^)\s]+)(?:\s+"[^"\n]*")?\))`,
    String.raw`(?<auto><(?<autoUrl>(?:https?:\/\/|mailto:)[^\s<>]+)>)`,
    String.raw`(?<bare>(?<![\w/])https?:\/\/[^\s<>()\[\]]*[^\s<>()\[\].,;:!?'"])`,
    String.raw`(?<strong>\*\*(?=\S)(?<strongText>[\s\S]*?\S)\*\*|__(?=\S)(?<strongText2>[\s\S]*?\S)__(?!\w))`,
    String.raw`(?<strike>~~(?=\S)(?<strikeText>[\s\S]*?\S)~~)`,
    String.raw`(?<em>\*(?=[^\s*])(?<emText>[^*]*?[^\s*])\*|(?<![\w])_(?=[^\s_])(?<emText2>[^_]*?[^\s_])_(?![\w]))`,
    String.raw`(?<br>[ \t]*\n)`,
  ].join("|"), "g");
  // Inline nodes: { t: "text" | "code" | "strong" | "em" | "del" | "link" | "wiki" | "br", ... }.
  function parseInline(text) {
    const out = [];
    const src = String(text);
    const re = new RegExp(INLINE.source, "g");
    let at = 0;
    let m;
    const text_ = (s) => { if (!s) return; const last = out[out.length - 1]; if (last && last.t === "text") last.text += s; else out.push({ t: "text", text: s }); };
    while ((m = re.exec(src))) {
      text_(src.slice(at, m.index));
      at = re.lastIndex;
      const g = m.groups;
      if (g.code) out.push({ t: "code", text: g.codeText.replace(/^ (.*) $/s, "$1") });
      else if (g.wiki) out.push({ t: "wiki", target: g.wikiTarget.trim(), text: (g.wikiLabel || g.wikiTarget.split("#")[0].split("/").pop()).trim() });
      else if (g.image) out.push({ t: "link", href: g.imageUrl, kids: [{ t: "text", text: g.imageAlt ? `Image: ${g.imageAlt}` : "Image" }] });
      else if (g.link) out.push({ t: "link", href: g.linkUrl, kids: parseInline(g.linkText) });
      else if (g.auto) out.push({ t: "link", href: g.autoUrl, kids: [{ t: "text", text: g.autoUrl }] });
      else if (g.bare) out.push({ t: "link", href: g.bare, kids: [{ t: "text", text: g.bare }] });
      else if (g.strong) out.push({ t: "strong", kids: parseInline(g.strongText ?? g.strongText2) });
      else if (g.strike) out.push({ t: "del", kids: parseInline(g.strikeText) });
      else if (g.em) out.push({ t: "em", kids: parseInline(g.emText ?? g.emText2) });
      else if (g.br !== undefined) text_(" ");
    }
    text_(src.slice(at));
    return out;
  }
  // Only links that leave for the web or mail are followed; anything else (javascript:, data:, a vault path) stays text.
  const safeHref = (href) => (/^(https?:\/\/|mailto:)/i.test(String(href)) ? String(href) : null);

  function buildInline(doc, nodes, parent) {
    for (const n of nodes) {
      if (n.t === "text") parent.append(doc.createTextNode(n.text));
      else if (n.t === "code") { const c = doc.createElement("code"); c.textContent = n.text; parent.append(c); }
      else if (n.t === "wiki") { const s = doc.createElement("span"); s.className = "fwiki"; s.title = n.target; s.textContent = n.text; parent.append(s); }
      else if (n.t === "link") {
        const href = safeHref(n.href);
        const a = doc.createElement(href ? "a" : "span");
        if (href) { a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer"; } else { a.className = "flink"; a.title = String(n.href); }
        buildInline(doc, n.kids, a);
        parent.append(a);
      } else {
        const e = doc.createElement(n.t);
        buildInline(doc, n.kids, e);
        parent.append(e);
      }
    }
    return parent;
  }
  function buildBlocks(doc, blocks, parent) {
    for (const b of blocks) {
      if (b.type === "heading") parent.append(buildInline(doc, b.inline, doc.createElement(`h${b.level}`)));
      else if (b.type === "para") parent.append(buildInline(doc, b.inline, doc.createElement("p")));
      else if (b.type === "hr") parent.append(doc.createElement("hr"));
      else if (b.type === "code" || b.type === "frontmatter") {
        const pre = doc.createElement("pre");
        const code = doc.createElement("code");
        if (b.type === "frontmatter") { pre.className = "ffront"; pre.setAttribute("aria-label", "Front matter"); paintTokens(doc, code, b.text, "yaml"); }
        else { const lang = LANG[b.lang] || (RULES[b.lang] ? b.lang : ""); if (lang) { code.dataset.lang = lang; paintTokens(doc, code, b.text, lang); } else code.textContent = b.text; }
        pre.append(code);
        parent.append(pre);
      } else if (b.type === "quote") parent.append(buildBlocks(doc, b.blocks, doc.createElement("blockquote")));
      else if (b.type === "list") {
        const list = doc.createElement(b.ordered ? "ol" : "ul");
        if (b.ordered && b.start !== 1) list.start = b.start;
        for (const it of b.items) {
          const li = doc.createElement("li");
          // A one-paragraph item reads as a line, not a paragraph with margins.
          const kids = it.blocks.length && it.blocks[0].type === "para" ? [buildInline(doc, it.blocks[0].inline, doc.createElement("span")), it.blocks.slice(1)] : [null, it.blocks];
          if (it.task !== null) {
            li.className = "ftask";
            const box = doc.createElement("input");
            box.type = "checkbox"; box.checked = it.task; box.disabled = true;
            box.setAttribute("aria-label", it.task ? "Done" : "Not done");
            li.append(box, " ");
          }
          if (kids[0]) li.append(kids[0]);
          buildBlocks(doc, kids[1], li);
          list.append(li);
        }
        parent.append(list);
      }
    }
    return parent;
  }
  function renderMarkdown(doc, text) {
    return buildBlocks(doc, parseMarkdown(text), doc.createDocumentFragment());
  }

  // ---- The editor: line numbers, a monospace textarea, and (for code) the highlighted copy under it, scrolled together.
  function createEditor(doc, opts) {
    const o = opts || {};
    const lang = o.lang && RULES[o.lang] ? o.lang : "";
    const root = doc.createElement("div");
    root.className = `fed${lang ? " hl" : ""}`;
    const gutter = doc.createElement("div");
    gutter.className = "fgutter";
    gutter.setAttribute("aria-hidden", "true");
    const nums = doc.createElement("div");
    nums.className = "fnums";
    gutter.append(nums);
    const area = doc.createElement("div");
    area.className = "farea";
    const ta = doc.createElement("textarea");
    ta.className = "fta";
    ta.spellcheck = false;
    ta.wrap = "off";
    ta.setAttribute("autocapitalize", "off");
    ta.setAttribute("autocomplete", "off");
    ta.setAttribute("autocorrect", "off");
    ta.setAttribute("aria-label", o.label || "File text");
    if (o.readOnly) { ta.readOnly = true; ta.setAttribute("aria-readonly", "true"); }
    let pre = null, code = null;
    if (lang) {
      pre = doc.createElement("pre");
      pre.className = "fhl";
      pre.setAttribute("aria-hidden", "true");
      code = doc.createElement("code");
      pre.append(code);
      area.append(pre);
    }
    area.append(ta);
    root.append(gutter, area);
    root.dataset.lang = lang || "plain";

    let lineCount = 0;
    let painted = null;
    let frame = 0;
    const raf = (doc.defaultView && doc.defaultView.requestAnimationFrame) ? (f) => doc.defaultView.requestAnimationFrame(f) : (f) => setTimeout(f, 16);
    function renumber() {
      const n = ta.value.split("\n").length;
      if (n === lineCount) return;
      lineCount = n;
      let s = "";
      for (let k = 1; k <= n; k++) s += `${k}\n`;
      nums.textContent = s;
      root.style.setProperty("--fgutter-ch", String(Math.max(2, String(n).length)));
    }
    function paint() {
      frame = 0;
      if (!code || painted === ta.value) return;
      painted = ta.value;
      // A trailing newline keeps the copy as tall as the textarea when the text ends in an empty line.
      paintTokens(doc, code, `${ta.value}\n`, lang);
    }
    function sync() {
      const x = ta.scrollLeft, y = ta.scrollTop;
      nums.style.transform = `translateY(${-y}px)`;
      if (pre) pre.style.transform = `translate(${-x}px, ${-y}px)`;
    }
    ta.addEventListener("input", () => {
      renumber();
      if (code && !frame) frame = raf(paint);
      if (o.onChange) o.onChange(ta.value);
    });
    ta.addEventListener("scroll", sync);
    ta.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s") { e.preventDefault(); if (o.onSave) o.onSave(); }
    });
    const api = {
      root,
      textarea: ta,
      lang,
      get value() { return ta.value; },
      set value(v) { ta.value = String(v); renumber(); paint(); sync(); },
      focus() { ta.focus(); },
      refresh() { renumber(); paint(); sync(); },
    };
    api.value = o.value || "";
    return api;
  }

  // ---- The viewer: open files as tabs in the centre pane. `deps` gives the page's own ways to read and save a file:
  //   load(path)          -> { ok, text, editable, sha, why } | { ok: false, error }
  //   save(path, sha, t)  -> { ok, status, commit, error, reasons } (the server's answer)
  //   fileUrl(path)       -> a same-origin URL for a PDF or image, or null when ORBIT cannot serve that file
  //   onChange(path|null) -> told which file is showing (the sidebar marks it), null when the viewer is hidden
  function createViewer(doc, root, deps) {
    const d = deps || {};
    const files = new Map(); // path -> entry
    const order = [];
    let active = null;
    let shown = false;
    const mk = (tag, props, ...kids) => { const e = Object.assign(doc.createElement(tag), props || {}); e.append(...kids.filter((k) => k !== null && k !== undefined)); return e; };

    const tabs = mk("div", { className: "ftabs", role: "tablist" });
    tabs.setAttribute("aria-label", "Open files");
    const name = mk("span", { className: "fname" });
    const dir = mk("span", { className: "fdir" });
    const kindChip = mk("span", { className: "fkind" });
    const pathBox = mk("div", { className: "fpath" }, mk("h2", { className: "ftitle" }, name), dir, kindChip);
    const modes = mk("div", { className: "fmodes", role: "tablist" });
    modes.setAttribute("aria-label", "Markdown view");
    const editTab = mk("button", { type: "button", role: "tab", className: "fmode", id: "fmode-edit", textContent: "Edit" });
    const previewTab = mk("button", { type: "button", role: "tab", className: "fmode", id: "fmode-preview", textContent: "Preview" });
    modes.append(editTab, previewTab);
    const saveBtn = mk("button", { type: "button", className: "fsave", textContent: "Save", title: "Save to the vault (Ctrl+S)" });
    const closeBtn = mk("button", { type: "button", className: "fclose btn-secondary", textContent: "Close", title: "Close this file" });
    const actions = mk("div", { className: "factions" }, modes, saveBtn, closeBtn);
    const head = mk("div", { className: "fhead" }, pathBox, actions);
    const msg = mk("p", { className: "fmsg", role: "status" });
    msg.setAttribute("aria-live", "polite");
    const body = mk("div", { className: "fbody" });
    root.replaceChildren(tabs, head, msg, body);

    const dirty = (f) => f.editable && f.editor && f.editor.value !== f.text;
    const say = (f, text, kind) => { f.msg = { text, kind: kind || "" }; if (f === files.get(active)) paintMsg(f); };
    function paintMsg(f) {
      msg.textContent = f.msg ? f.msg.text : "";
      msg.className = `fmsg${f.msg && f.msg.kind ? ` ${f.msg.kind}` : ""}`;
      msg.setAttribute("role", f.msg && f.msg.kind === "err" ? "alert" : "status");
      msg.hidden = !msg.textContent;
    }

    function paintTabs() {
      tabs.replaceChildren(...order.map((p) => {
        const f = files.get(p);
        const t = mk("button", { type: "button", role: "tab", className: "ftab", title: p }, mk("span", { textContent: p.split("/").pop() }), dirty(f) ? mk("span", { className: "fdirty", textContent: " ●", title: "Unsaved changes" }) : null);
        t.setAttribute("aria-selected", String(p === active));
        t.tabIndex = p === active ? 0 : -1;
        t.dataset.path = p;
        t.addEventListener("click", () => open(p));
        const x = mk("button", { type: "button", className: "ftabx", textContent: "×", title: `Close ${p}` });
        x.setAttribute("aria-label", `Close ${p}`);
        x.addEventListener("click", () => close(p));
        return mk("div", { className: `ftabwrap${p === active ? " on" : ""}` }, t, x);
      }));
      tabs.hidden = order.length < 2;
    }
    tabs.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const i = order.indexOf(active);
      if (i < 0) return;
      const next = order[(i + (e.key === "ArrowRight" ? 1 : order.length - 1)) % order.length];
      open(next);
      const t = tabs.querySelector(`.ftab[aria-selected="true"]`);
      if (t) t.focus();
      e.preventDefault();
    });

    function paintHead(f) {
      const parts = f.path.split("/");
      name.textContent = parts.pop();
      dir.textContent = parts.length ? `${parts.join("/")}/` : "";
      pathBox.title = f.path;
      kindChip.textContent = f.ready && !f.editable ? `${f.type.label} · read-only` : f.type.label;
      const md = f.type.kind === "markdown" && f.ready && !f.error;
      modes.hidden = !md;
      editTab.setAttribute("aria-selected", String(f.mode === "edit"));
      previewTab.setAttribute("aria-selected", String(f.mode === "preview"));
      editTab.tabIndex = f.mode === "edit" ? 0 : -1;
      previewTab.tabIndex = f.mode === "preview" ? 0 : -1;
      saveBtn.hidden = !(f.ready && f.editable);
      saveBtn.disabled = f.saving || !dirty(f);
      saveBtn.textContent = f.saving ? "Saving…" : "Save";
    }

    function bodyOf(f) {
      if (f.view) return f.view;
      const view = mk("div", { className: `fview k-${f.type.kind}` });
      f.view = view;
      if (f.error) { view.append(mk("p", { className: "fnote err", role: "alert", textContent: f.error })); return view; }
      if (f.type.kind === "pdf" || f.type.kind === "image") {
        const src = d.fileUrl ? d.fileUrl(f.path) : null;
        if (!src) { view.append(mk("p", { className: "fnote", textContent: `ORBIT cannot show this ${f.type.label === "PDF" ? "PDF" : "image"} here: only Markdown notes are read from the vault for now.` })); return view; }
        if (f.type.kind === "pdf") {
          const frame = mk("iframe", { className: "fpdf", src, title: `PDF: ${f.path}` });
          // A PDF shown by the browser's own viewer; it runs no script of the page and cannot reach it.
          frame.setAttribute("sandbox", "");
          view.append(frame, mk("p", { className: "fnote" }, mk("a", { href: src, target: "_blank", rel: "noopener noreferrer", textContent: "Open the PDF in a new tab" })));
        } else view.append(mk("div", { className: "fimgbox" }, mk("img", { className: "fimg", src, alt: f.path })));
        return view;
      }
      const editor = createEditor(doc, {
        value: f.text,
        lang: f.type.kind === "code" ? f.type.lang : "",
        readOnly: !f.editable,
        label: `${f.editable ? "Edit" : "Read"} ${f.path}`,
        onChange: () => { paintHead(f); paintTabs(); if (f.msg && f.msg.kind !== "err") say(f, ""); },
        onSave: () => saveFile(f),
      });
      f.editor = editor;
      if (f.type.kind === "markdown") {
        f.preview = mk("div", { className: "fmd", tabIndex: 0 });
        f.preview.setAttribute("aria-label", `Preview of ${f.path}`);
        view.append(editor.root, f.preview);
      } else view.append(editor.root);
      return view;
    }
    function paintMode(f) {
      if (!f.editor || !f.preview) return;
      const preview = f.mode === "preview";
      f.editor.root.hidden = preview;
      f.preview.hidden = !preview;
      if (preview && f.previewOf !== f.editor.value) { f.previewOf = f.editor.value; f.preview.replaceChildren(renderMarkdown(doc, f.editor.value)); }
    }
    function setMode(mode) {
      const f = files.get(active);
      if (!f || f.type.kind !== "markdown") return;
      f.mode = mode;
      paintHead(f);
      paintMode(f);
      if (mode === "edit" && f.editor) f.editor.refresh();
    }
    editTab.addEventListener("click", () => setMode("edit"));
    previewTab.addEventListener("click", () => setMode("preview"));
    modes.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const f = files.get(active);
      if (!f) return;
      setMode(f.mode === "edit" ? "preview" : "edit");
      (f.mode === "edit" ? editTab : previewTab).focus();
      e.preventDefault();
    });

    function paint() {
      const f = files.get(active);
      paintTabs();
      if (!f) { body.replaceChildren(); return; }
      paintHead(f);
      paintMsg(f);
      if (!f.ready) { body.replaceChildren(mk("p", { className: "fnote", textContent: "Reading the file…" })); return; }
      body.replaceChildren(bodyOf(f));
      paintMode(f);
      if (f.editor) f.editor.refresh();
    }

    function show() {
      if (!shown) { shown = true; root.hidden = false; doc.documentElement.dataset.file = "open"; }
      if (d.onChange) d.onChange(active);
    }
    function hide() {
      if (!shown) return;
      shown = false;
      root.hidden = true;
      delete doc.documentElement.dataset.file;
      if (d.onChange) d.onChange(null);
    }

    async function load(f) {
      let r;
      try { r = d.load ? await d.load(f.path) : { ok: false, error: "This page cannot read files." }; } catch { r = { ok: false, error: "ORBIT could not be reached for this file." }; }
      if (!files.has(f.path) || files.get(f.path) !== f) return;
      f.ready = true;
      if (!r || !r.ok) { f.error = (r && r.error) || "The file could not be read."; f.editable = false; }
      else {
        f.text = typeof r.text === "string" ? r.text : "";
        f.sha = r.sha || null;
        f.editable = Boolean(f.type.editable && r.editable && f.sha);
        if (!f.editable && f.type.editable && r.why) say(f, r.why);
      }
      if (f.path === active) paint();
    }

    function open(path) {
      const p = String(path);
      let f = files.get(p);
      if (!f) {
        const type = fileKind(p);
        f = { path: p, type, ready: type.kind === "pdf" || type.kind === "image", text: "", sha: null, editable: false, mode: "edit", msg: null, saving: false };
        files.set(p, f);
        order.push(p);
        if (!f.ready) load(f);
      }
      active = p;
      paint();
      show();
      return f;
    }

    function close(path) {
      const p = path || active;
      const f = files.get(p);
      if (!f) return true;
      if (dirty(f) && !(doc.defaultView && doc.defaultView.confirm(`Close ${p}? Its unsaved changes will be lost.`))) return false;
      files.delete(p);
      order.splice(order.indexOf(p), 1);
      if (active === p) active = order.length ? order[order.length - 1] : null;
      if (!active) { paint(); hide(); return true; }
      paint();
      if (shown && d.onChange) d.onChange(active);
      return true;
    }
    closeBtn.addEventListener("click", () => close(active));
    saveBtn.addEventListener("click", () => { const f = files.get(active); if (f) saveFile(f); });

    async function saveFile(f) {
      if (!f.editable || f.saving || !d.save) return;
      if (!dirty(f)) { say(f, "No changes to save."); return; }
      const text = f.editor.value;
      f.saving = true;
      if (f.path === active) paintHead(f);
      say(f, "Saving to the vault…");
      let r;
      try { r = await d.save(f.path, f.sha, text); } catch { r = { ok: false, error: "ORBIT could not be reached. Nothing was saved." }; }
      f.saving = false;
      if (r && r.ok && r.status === "committed") {
        // Read the note back: the editor's text becomes the saved text only when the vault now holds exactly that.
        let back = null;
        try { back = d.load ? await d.load(f.path) : null; } catch { back = null; }
        if (back && back.ok && back.text === text && back.sha) { f.text = text; f.sha = back.sha; say(f, `Saved to the vault${r.commit ? ` (commit ${String(r.commit).slice(0, 7)})` : ""}.`, "ok"); }
        else {
          f.text = text;
          f.editable = false;
          if (f.editor) { f.editor.textarea.readOnly = true; f.editor.textarea.setAttribute("aria-readonly", "true"); }
          say(f, `Saved${r.commit ? ` (commit ${String(r.commit).slice(0, 7)})` : ""}, but the vault's copy now differs from this editor, so editing is paused. Close and reopen the file to see the vault's text.`, "warn");
        }
      } else if (r && r.ok && r.status === "unchanged") { f.text = text; say(f, "The note already says this; nothing was written.", "ok"); }
      else if (r && r.ok && r.status === "pending-confirmation") {
        const why = Array.isArray(r.reasons) && r.reasons.length ? ` (${r.reasons.join("; ")})` : "";
        say(f, `Not saved yet: this change needs your confirmation${why}. Confirm it under “Waiting for your click” on the Jobs page; nothing is written until then.`, "warn");
      } else say(f, (r && r.error) || "The file could not be saved. Nothing was written.", "err");
      if (files.get(f.path) === f) { paintTabs(); if (f.path === active) paintHead(f); }
    }

    return {
      open,
      close,
      hide,
      show() { if (active) { paint(); show(); } },
      get active() { return shown ? active : null; },
      get openPaths() { return order.slice(); },
      isOpen: (p) => files.has(p),
      dirty: () => order.some((p) => dirty(files.get(p))),
      save: () => { const f = files.get(active); return f ? saveFile(f) : undefined; },
    };
  }

  const api = Object.freeze({ fileKind, tokenize, parseMarkdown, parseInline, safeHref, renderMarkdown, createEditor, createViewer, paintTokens });
  global.OrbitFiles = api;
})(typeof window !== "undefined" ? window : globalThis);
