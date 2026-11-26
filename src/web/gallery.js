// ORBIT's photo gallery page (docs/photo-gallery.md): the centre-pane view the sidebar's Images section opens. Read-only. It reads
// GET /gallery/photos (one page at a time), /gallery/search?q= and /gallery/photos/<ref> (owner only, src/photo-gallery.ts), and loads
// every image through the Assistant's display route, /assistant/photos/<ref>, which the page builds itself from a validated ref; no
// stored or returned value ever becomes a URL. Captions, titles, observations and corrections are untrusted text and are only ever
// set as text. Nothing here edits, deletes or sends a photo.
(function (global) {
  "use strict";

  const REF = /^ph_[0-9a-f]{32}$/;
  const LINK = /^#(?:assistant|chat\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  const MONTH = /^\d{4}-\d{2}$/;
  const PAGE = 24;
  const str = (v, max = 300) => (typeof v === "string" ? v.slice(0, max) : "");
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const srcOf = (ref) => `/assistant/photos/${ref}`;

  // ---- pure helpers (also used by test/photo-gallery.test.ts) ------------------------------------------------------------------
  // Short names for where a search word was found, as the match notes say them.
  const KIND_NAME = {
    caption: "caption",
    "conversation-title": "conversation title",
    "visual-observation": "AI observation",
    "user-correction": "Rai's correction",
    "discussion-context": "Rai's next message",
  };
  // "matched caption: 'garden'", "matched AI observation: 'bookshelves'", "similar to AI observation (0.62)".
  function hitNote(h) {
    if (!h || typeof h !== "object") return "";
    const where = KIND_NAME[h.kind] || "stored text";
    const terms = Array.isArray(h.terms) ? h.terms.filter((t) => typeof t === "string").slice(0, 8) : [];
    if (terms.length) return `matched ${where}: ${terms.map((t) => `'${t.slice(0, 40)}'`).join(", ")}`;
    if (typeof h.similarity === "number") return `similar in meaning to ${where} (${h.similarity.toFixed(2)})`;
    return "";
  }
  function matchNotes(m) {
    if (!m || !Array.isArray(m.hits)) return [];
    return [...new Set(m.hits.slice(0, 8).map(hitNote).filter(Boolean))];
  }
  // A day ("2026-11-26") or month ("2026-11") as a header, read as a calendar date (no time zone shift: the server already gave the
  // day in ORBIT's configured zone).
  function groupLabel(key) {
    if (DAY.test(key)) return new Date(`${key}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
    if (MONTH.test(key)) return new Date(`${key}-15T12:00:00Z`).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
    return "Unknown date";
  }
  // Consecutive photos of the same day (or month) as one group, in the order given (newest first).
  function groupPhotos(items, by) {
    const groups = [];
    for (const it of items) {
      const p = it.photo || it;
      const key = by === "month" ? (MONTH.test(p.month) ? p.month : "") : DAY.test(p.day) ? p.day : "";
      const last = groups.at(-1);
      if (last && last.key === key) last.items.push(it);
      else groups.push({ key, label: groupLabel(key), items: [it] });
    }
    return groups;
  }
  const kb = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
  // What the page may use of one listed photo; anything that does not fit is dropped.
  function safePhoto(p) {
    if (!p || !REF.test(p.ref)) return null;
    const c = p.conversation || {};
    const m = p.message && typeof p.message === "object" ? p.message : null;
    return {
      ref: p.ref,
      ok: p.status === "ok",
      sentLocal: str(p.sentLocal, 40),
      day: DAY.test(p.day) ? p.day : "",
      month: MONTH.test(p.month) ? p.month : "",
      caption: str(p.caption, 280),
      conversation: { kind: c.kind === "chat" ? "chat" : "assistant", title: str(c.title, 100), archived: c.archived === true },
      message: m ? { photo: num(m.photo), of: num(m.of) } : null,
      link: typeof p.link === "string" && LINK.test(p.link) ? p.link : "",
      image: { width: num(p.image && p.image.width), height: num(p.image && p.image.height), bytes: num(p.image && p.image.bytes), type: str(p.image && p.image.type, 40) },
      ai: { observations: num(p.ai && p.ai.observations), corrections: num(p.ai && p.ai.corrections) },
    };
  }

  // ---- the page -----------------------------------------------------------------------------------------------------------------
  // opts: { root: the #gallery section, pageLink(link): the page address of "#assistant" / "#chat/<id>", onTitle(text) }
  function create(opts) {
    const root = opts.root;
    const mk = (tag, props = {}, ...kids) => {
      const e = document.createElement(tag);
      for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === "className") e.className = v;
        else if (k === "textContent") e.textContent = v;
        else if (k === "onclick") e.addEventListener("click", v);
        else if (k === "hidden") e.hidden = true;
        else e.setAttribute(k, v === true ? "" : String(v));
      }
      e.append(...kids.filter((x) => x !== null && x !== undefined && x !== false));
      return e;
    };
    // State: the listing (pages loaded so far) or one search's matches.
    const st = { list: [], cursor: null, total: 0, loaded: false, loading: false, error: "", query: "", search: null, by: readGroup(), gen: 0 };
    let light = null;

    const input = mk("input", { type: "search", id: "gsearchq", name: "q", maxlength: "200", autocomplete: "off", placeholder: "Search captions, titles, observations, corrections", "aria-label": "Search photos" });
    const clear = mk("button", { type: "button", className: "gclear", hidden: true, textContent: "Clear" });
    const form = mk("form", { className: "gsearch", role: "search", "aria-label": "Search photos" }, input, mk("button", { type: "submit", textContent: "Search" }), clear);
    const groupSel = mk("select", { id: "ggroup", "aria-label": "Group photos by" }, mk("option", { value: "day", textContent: "By day" }), mk("option", { value: "month", textContent: "By month" }));
    groupSel.value = st.by;
    const status = mk("p", { className: "gstatus", role: "status", "aria-live": "polite" });
    const info = mk("div", { className: "gsearchinfo", hidden: true });
    const grid = mk("div", { className: "gbody" });
    const more = mk("button", { type: "button", className: "gmore", hidden: true, textContent: "Load more photos" });
    root.replaceChildren(mk("div", { className: "gwrap" },
      mk("div", { className: "gtop" }, mk("h2", { className: "gh", textContent: "Photos" }), groupSel),
      form, status, info, grid, more));

    form.addEventListener("submit", (e) => { e.preventDefault(); search(input.value); });
    clear.addEventListener("click", () => { input.value = ""; search(""); input.focus(); });
    groupSel.addEventListener("change", () => { st.by = groupSel.value === "month" ? "month" : "day"; writeGroup(st.by); draw(); });
    more.addEventListener("click", () => loadMore());

    async function getJson(url) {
      let res;
      try { res = await fetch(url, { headers: { accept: "application/json" } }); } catch { return { ok: false, error: "ORBIT could not be reached for the photos." }; }
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      if (!res.ok) return { ok: false, status: res.status, error: res.status === 403 ? "The photo gallery is for ORBIT's owner; this sign-in cannot read it." : str(body && body.error) || `The photos could not be read (HTTP ${res.status}).` };
      return body && typeof body === "object" ? { ok: true, body } : { ok: false, error: "ORBIT's answer for the photos could not be read." };
    }

    let first = null;
    // The first page, read once at a time: callers that arrive while it is being read wait for the same read.
    function loadFirst() {
      if (!first) first = readFirst().finally(() => { first = null; });
      return first;
    }
    async function readFirst() {
      const gen = ++st.gen;
      st.loading = true;
      status.textContent = "Reading the photos…";
      const r = await getJson(`/gallery/photos?limit=${PAGE}`);
      if (gen !== st.gen) return;
      st.loading = false;
      if (!r.ok || !Array.isArray(r.body.photos)) { st.error = r.error || "ORBIT's answer for the photos could not be read."; st.loaded = true; draw(); return; }
      st.error = "";
      st.list = r.body.photos.map(safePhoto).filter(Boolean);
      st.cursor = typeof r.body.nextCursor === "string" ? r.body.nextCursor : null;
      st.total = num(r.body.total);
      st.loaded = true;
      draw();
    }
    async function loadMore() {
      if (!st.cursor || st.loading) return false;
      const gen = st.gen;
      st.loading = true;
      more.disabled = true;
      const r = await getJson(`/gallery/photos?limit=${PAGE}&cursor=${encodeURIComponent(st.cursor)}`);
      st.loading = false;
      more.disabled = false;
      if (gen !== st.gen) return false;
      if (!r.ok || !Array.isArray(r.body.photos)) { status.textContent = r.error || "More photos could not be read."; return false; }
      const have = new Set(st.list.map((p) => p.ref));
      st.list.push(...r.body.photos.map(safePhoto).filter((p) => p && !have.has(p.ref)));
      st.cursor = typeof r.body.nextCursor === "string" ? r.body.nextCursor : null;
      st.total = num(r.body.total) || st.total;
      draw();
      return true;
    }
    async function search(q) {
      const query = String(q || "").trim().slice(0, 200);
      input.value = query;
      st.query = query;
      clear.hidden = !query;
      if (!query) { st.search = null; draw(); if (!st.loaded) loadFirst(); return; }
      const gen = ++st.gen;
      status.textContent = `Searching for “${query}”…`;
      const r = await getJson(`/gallery/search?q=${encodeURIComponent(query)}`);
      if (gen !== st.gen) return;
      if (!r.ok || !Array.isArray(r.body.matches)) { st.search = { error: r.error || "The search could not be read.", matches: [] }; draw(); return; }
      const b = r.body;
      st.search = {
        terms: Array.isArray(b.terms) ? b.terms.filter((t) => typeof t === "string").slice(0, 8) : [],
        mode: b.mode === "hybrid" ? "hybrid" : "keyword",
        degraded: str(b.degraded, 200),
        rule: str(b.rule, 400),
        caveat: str(b.caveat, 400),
        total: num(b.total),
        more: num(b.more),
        coverage: b.coverage || {},
        matches: b.matches.map((m) => {
          const p = safePhoto(m && m.photo);
          if (!p) return null;
          const hits = (Array.isArray(m.hits) ? m.hits : []).slice(0, 8).map((h) => ({ kind: KIND_NAME[h && h.kind] ? h.kind : "", label: str(h && h.label, 160), terms: Array.isArray(h && h.terms) ? h.terms.filter((t) => typeof t === "string").map((t) => t.slice(0, 40)) : [], snippet: str(h && h.snippet, 200), ...(typeof (h && h.similarity) === "number" ? { similarity: h.similarity } : {}) }));
          return { photo: p, via: Array.isArray(m.via) ? m.via.filter((v) => v === "keyword" || v === "semantic") : [], contextOnly: m.contextOnly === true, hits };
        }).filter(Boolean),
      };
      draw();
    }

    // The items the grid shows now, in order: search matches, or the listing.
    const shownItems = () => (st.search ? st.search.matches : st.list.map((p) => ({ photo: p })));

    function badge(p) {
      const kids = [];
      if (p.ai.observations) kids.push(mk("span", { className: "gbadge ai", title: `${p.ai.observations} saved AI observation${p.ai.observations === 1 ? "" : "s"}`, "aria-label": `Has ${p.ai.observations} AI observation${p.ai.observations === 1 ? "" : "s"}` }, mk("span", { "aria-hidden": "true", textContent: "AI" })));
      if (p.ai.corrections) kids.push(mk("span", { className: "gbadge fix", title: `${p.ai.corrections} correction${p.ai.corrections === 1 ? "" : "s"} by Rai`, "aria-label": `Has ${p.ai.corrections} correction${p.ai.corrections === 1 ? "" : "s"} by Rai`, textContent: "✎" }));
      return kids.length ? mk("span", { className: "gbadges" }, ...kids) : null;
    }
    function card(it, index) {
      const p = it.photo;
      const where = p.conversation.kind === "assistant" ? "Assistant" : `“${p.conversation.title || "chat thread"}”${p.conversation.archived ? " (archived)" : ""}`;
      const label = `${p.caption || "Photo"} · ${where} · sent ${p.sentLocal}`;
      const thumb = p.ok ? mk("img", { src: srcOf(p.ref), alt: p.caption || `Photo sent ${p.sentLocal}`, loading: "lazy", decoding: "async" }) : mk("span", { className: "gmissing", textContent: "Stored file missing or damaged" });
      const notes = it.hits ? matchNotes(it) : [];
      return mk("li", { className: "gcell", "data-ref": p.ref },
        mk("button", { type: "button", className: "gcard", "aria-label": `Open photo: ${label}`, title: label, onclick: () => openAt(index) }, thumb, badge(p)),
        mk("p", { className: "gcap" }, mk("span", { className: "gwhen", textContent: p.sentLocal.slice(11) || p.sentLocal }), p.caption ? mk("span", { className: "gtext", textContent: ` ${p.caption.slice(0, 80)}` }) : null),
        notes.length ? mk("p", { className: "gmatch", textContent: `${notes.join("; ")}${it.contextOnly ? " (only with conversation context)" : ""}` }) : null);
    }
    function draw() {
      const items = shownItems();
      more.hidden = Boolean(st.search) || !st.cursor;
      info.hidden = !st.search;
      if (st.search) {
        const s = st.search;
        if (s.error) {
          status.textContent = s.error;
          info.replaceChildren();
        } else {
          status.textContent = s.total ? `${s.total} photo${s.total === 1 ? "" : "s"} match “${st.query}”${s.more ? ` (the first ${s.matches.length} are shown)` : ""}.` : `No stored text matched “${st.query}”.`;
          info.replaceChildren(...[
            mk("p", { textContent: `${s.mode === "hybrid" ? "Keyword and meaning search." : "Keyword search."} ${s.rule}` }),
            mk("p", { className: "gcaveat", textContent: s.total ? s.caveat : "That says nothing about what the photos show: image content is never searched. Try other words." }),
            s.degraded ? mk("p", { className: "gcaveat", textContent: `Meaning search was not used: ${s.degraded}` }) : null,
            num(s.coverage.olderPhotosNotSearched) ? mk("p", { className: "gcaveat", textContent: `${num(s.coverage.olderPhotosNotSearched)} older photos were not searched.` }) : null].filter(Boolean));
        }
      } else if (st.error) status.textContent = st.error;
      else if (!st.loaded) status.textContent = "Reading the photos…";
      else status.textContent = st.total ? `${st.total} photo${st.total === 1 ? "" : "s"}${st.list.length < st.total ? `, ${st.list.length} shown` : ""}.` : "No photos sent yet.";
      let index = 0;
      grid.replaceChildren(...groupPhotos(items, st.by).map((g) => mk("section", { className: "ggroup", "aria-label": g.label },
        mk("h3", { className: "gday", textContent: g.label }),
        mk("ul", { className: "ggrid" }, ...g.items.map((it) => card(it, index++))))));
      if (light) light.sync();
    }

    // ---- the enlarged view and its metadata panel ------------------------------------------------------------------------------
    function openAt(index) {
      const items = shownItems();
      if (!items[index]) return;
      if (!light) light = lightbox();
      light.show(index);
    }
    function lightbox() {
      const prior = document.activeElement;
      let index = 0;
      let item = null;
      let gen = 0;
      const img = mk("img", { className: "glimg", alt: "" });
      const missing = mk("p", { className: "gmissing", hidden: true, textContent: "This photo's stored file is missing or damaged, so it is not shown." });
      const count = mk("p", { className: "glcount", "aria-live": "polite" });
      const prev = mk("button", { type: "button", className: "glnav glprev", "aria-label": "Previous photo", title: "Previous photo (←)", textContent: "‹" });
      const next = mk("button", { type: "button", className: "glnav glnext", "aria-label": "Next photo", title: "Next photo (→)", textContent: "›" });
      const shut = mk("button", { type: "button", className: "glclose", "aria-label": "Close photo", title: "Close (Esc)", textContent: "✕" });
      const meta = mk("div", { className: "glmeta", tabindex: "0", "aria-label": "Photo details" });
      const box = mk("div", { className: "glight", role: "dialog", "aria-modal": "true", "aria-label": "Photo" },
        mk("div", { className: "glstage" }, img, missing, prev, next, count), meta, shut);
      const inerted = [];
      const onKey = (e) => {
        if (e.key === "Escape") { e.preventDefault(); close(); }
        else if (e.key === "ArrowLeft" && !e.target.closest("input, select, textarea")) { e.preventDefault(); go(-1); }
        else if (e.key === "ArrowRight" && !e.target.closest("input, select, textarea")) { e.preventDefault(); go(1); }
        else if (e.key === "Tab") {
          const f = [...box.querySelectorAll("button:not([disabled]), a[href], [tabindex='0']")].filter((x) => x.getClientRects().length);
          if (!f.length) return;
          if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); }
          else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
        }
      };
      prev.addEventListener("click", () => go(-1));
      next.addEventListener("click", () => go(1));
      shut.addEventListener("click", () => close());
      box.addEventListener("keydown", onKey);
      async function go(step) {
        let items = shownItems();
        let to = index + step;
        if (to >= items.length && !st.search && st.cursor && (await loadMore())) items = shownItems();
        if (to < 0 || to >= items.length) return;
        show(to);
      }
      function close() {
        box.remove();
        for (const c of inerted) c.removeAttribute("inert");
        inerted.length = 0;
        light = null;
        const back = item && root.querySelector(`.gcell[data-ref="${item.photo.ref}"] .gcard`);
        (back || (prior && document.contains(prior) ? prior : null) || input).focus();
        if (opts.onClose) opts.onClose();
      }
      function show(i) {
        const items = shownItems();
        index = Math.max(0, Math.min(i, items.length - 1));
        item = items[index];
        if (!box.isConnected) {
          for (const c of document.body.children) if (c !== box && c.tagName !== "SCRIPT" && !c.hasAttribute("inert")) { c.setAttribute("inert", ""); inerted.push(c); }
          document.body.append(box);
          shut.focus();
        }
        const p = item.photo;
        box.setAttribute("aria-label", `Photo ${index + 1} of ${items.length}${p.caption ? `: ${p.caption.slice(0, 80)}` : ""}`);
        img.hidden = !p.ok;
        missing.hidden = p.ok;
        if (p.ok) { img.src = srcOf(p.ref); img.alt = p.caption || `Photo sent ${p.sentLocal}`; } else img.removeAttribute("src");
        sync();
        renderMeta(null);
        const g = ++gen;
        getJson(`/gallery/photos/${p.ref}`).then((r) => { if (g === gen && box.isConnected) renderMeta(r); });
      }
      function sync() {
        const items = shownItems();
        if (item) {
          const at = items.findIndex((x) => x.photo.ref === item.photo.ref);
          if (at >= 0) index = at;
        }
        count.textContent = `${index + 1} of ${items.length}${!st.search && st.cursor ? "+" : ""}`;
        prev.disabled = index <= 0;
        next.disabled = index >= items.length - 1 && (Boolean(st.search) || !st.cursor);
      }
      const dl = (rows) => mk("dl", { className: "glfacts" }, ...rows.filter(Boolean).flatMap(([k, v]) => [mk("dt", { textContent: k }), mk("dd", {}, v)]));
      const section = (title, ...kids) => mk("section", { className: "glsec" }, mk("h3", { textContent: title }), ...kids);
      function convLink(c, link, text) {
        return link && LINK.test(link) ? mk("a", { href: opts.pageLink(link), textContent: text || "Open conversation", "data-gallery-link": "" }) : null;
      }
      function renderMeta(r) {
        const p = item.photo;
        const where = p.conversation.kind === "assistant" ? "Assistant" : `${p.conversation.title || "Chat thread"}${p.conversation.archived ? " (archived)" : ""}`;
        const kids = [];
        kids.push(section("File",
          dl([
            ["Photo", document.createTextNode(`${p.image.type === "image/jpeg" ? "JPEG" : p.image.type || "Image"} · ref ${p.ref}`)],
            ["Sent", document.createTextNode(p.sentLocal || "unknown")],
            ["Taken", document.createTextNode("Not known: the capture date and the original file name are removed before upload.")],
            ["Size", document.createTextNode(`${p.image.width}×${p.image.height} px · ${kb(p.image.bytes)}`)],
          ])));
        kids.push(section("Source",
          dl([
            ["Conversation", document.createTextNode(where)],
            p.message ? ["Message", document.createTextNode(`photo ${p.message.photo} of ${p.message.of}`)] : null,
          ]),
          convLink(p.conversation, p.link, p.conversation.kind === "assistant" ? "Open the Assistant" : "Open this conversation")));
        kids.push(section("Caption", mk("p", { className: p.caption ? "glcaption" : "glnone", textContent: p.caption || "No message text was sent with this photo." })));
        if (item.hits) {
          kids.push(section("Search match",
            mk("p", { textContent: `Search: “${st.query}”${item.contextOnly ? ". Matched only with Rai's next message (conversation context, not a description of the photo)." : ""}` }),
            mk("ul", { className: "glhits" }, ...item.hits.map((h) => mk("li", {},
              mk("strong", { textContent: hitNote(h) || "matched stored text" }),
              h.snippet ? mk("q", { textContent: h.snippet }) : null))),
            mk("p", { className: "gcaveat", textContent: "A match means the words are in ORBIT's stored text about this photo, not that the photo shows them." })));
        }
        if (!r) kids.push(mk("p", { className: "glnone", textContent: "Reading what ORBIT saved about this photo…" }));
        else if (!r.ok) kids.push(mk("p", { className: "glerr", role: "alert", textContent: r.error || "What ORBIT saved about this photo could not be read." }));
        else kids.push(...recordSections(r.body));
        meta.replaceChildren(...kids);
      }
      function recordSections(b) {
        const obs = Array.isArray(b.observations) ? b.observations : [];
        const fixes = Array.isArray(b.corrections) ? b.corrections : [];
        const byId = new Map(obs.map((o) => [str(o && o.id, 40), o]));
        const out = [];
        const lines = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 12).map((x) => x.slice(0, 300)) : []);
        const corrector = new Map();
        for (const c of fixes) for (const id of lines(c && c.supersedes)) corrector.set(id, c);
        out.push(section("AI observations",
          obs.length
            ? mk("ol", { className: "globs" }, ...obs.map((o) => {
              const sup = o.state === "superseded";
              const fix = corrector.get(str(o.id, 40));
              const via = o.inspection ? `${o.inspection.via === "photos_inspect" ? "looked at with photos_inspect" : "sent with the message"}${o.inspection.model ? ` · model ${str(o.inspection.model, 80)}` : ""}` : "";
              return mk("li", { className: sup ? "superseded" : "" },
                mk("p", { className: "glwhen", textContent: `Observed ${str(o.atLocal, 40)}${via ? ` · ${via}` : ""}` }),
                mk("ul", { className: "globl" }, ...lines(o.observations).map((t) => mk("li", {}, sup ? mk("s", { textContent: t }) : document.createTextNode(t)))),
                lines(o.limitations).length ? mk("div", { className: "gllim" }, mk("span", { textContent: "Limitations noted: " }), document.createTextNode(lines(o.limitations).join("; "))) : null,
                o.scope ? mk("p", { className: "glscope", textContent: `Inspecting for: ${str(o.scope, 240)}` }) : null,
                mk("p", { className: "glctx" }, document.createTextNode(`Context: ${o.source && o.source.conversation && o.source.conversation.kind === "chat" ? `“${str(o.source.conversation.title, 100)}”` : "Assistant"} `), convLink(null, o.source && o.source.link, "open")),
                sup ? mk("p", { className: "glsup", textContent: fix ? `Superseded: Rai corrected this (${str(fix.atLocal, 40)}).` : `Superseded${o.supersededAt ? " by a later record" : ""}; not reused by default.` }) : null);
            }))
            : mk("p", { className: "glnone", textContent: "No saved AI observation. Nothing was saved about this photo that the Assistant can reuse; that says nothing about what it shows." }),
          mk("p", { className: "gcaveat", textContent: str(b.labels && b.labels.observation, 300) || "What a model said it saw, not a verified fact." })));
        if (fixes.length) out.push(section("Corrections",
          mk("ol", { className: "glfix" }, ...fixes.map((c) => mk("li", { className: c.state === "superseded" ? "superseded" : "" },
            mk("p", {}, mk("strong", { textContent: "Rai corrected: " }), document.createTextNode(str(c.correction, 320))),
            mk("p", { className: "glwhen", textContent: `${str(c.atLocal, 40)} · Rai's correction, relayed from Rai's message; not a visual inspection.` }),
            ...lines(c.supersedes).map((id) => {
              const o = byId.get(id);
              return o ? mk("p", { className: "glorig" }, mk("span", { textContent: "Original observation: " }), mk("s", { textContent: lines(o.observations).join("; ") })) : null;
            }),
            mk("p", { className: "glctx" }, document.createTextNode("Context: "), convLink(null, c.source && c.source.link, c.source && c.source.conversation && c.source.conversation.kind === "chat" ? `“${str(c.source.conversation.title, 100)}”` : "Assistant")))))));
        const nr = b.notReusable || {};
        const left = [num(nr.olderImageVersion) && `${num(nr.olderImageVersion)} about an older version of the image`, num(nr.sourceGone) && `${num(nr.sourceGone)} whose conversation is gone`, num(nr.forgotten) && `${num(nr.forgotten)} forgotten`].filter(Boolean);
        if (left.length) out.push(mk("p", { className: "gcaveat", textContent: `Not shown: ${left.join(", ")}.` }));
        return out;
      }
      return { show, sync, close, get open() { return box.isConnected; } };
    }

    return {
      // Called when the gallery page opens: reads the first page once (and again on a later open after a minute).
      show(opts2 = {}) {
        if (typeof opts2.query === "string") return search(opts2.query);
        if (!st.search && (!st.loaded || Date.now() - (st.at || 0) > 60_000)) { st.at = Date.now(); return loadFirst(); }
        return Promise.resolve();
      },
      search,
      // Opens one photo enlarged: from the loaded items when it is there, otherwise from the listing once it is read.
      async open(ref) {
        if (!REF.test(ref || "")) return false;
        let items = shownItems();
        let at = items.findIndex((x) => x.photo.ref === ref);
        if (at < 0 && st.search) { await search(""); items = shownItems(); at = items.findIndex((x) => x.photo.ref === ref); }
        if (at < 0 && (!st.loaded || first)) { await loadFirst(); items = shownItems(); at = items.findIndex((x) => x.photo.ref === ref); }
        while (at < 0 && st.cursor && (await loadMore())) { items = shownItems(); at = items.findIndex((x) => x.photo.ref === ref); }
        if (at < 0) return false;
        openAt(at);
        return true;
      },
      close() { if (light) light.close(); },
      get state() { return st; },
    };
  }
  function readGroup() { try { return global.localStorage.getItem("orbit.gallery.group") === "month" ? "month" : "day"; } catch { return "day"; } }
  function writeGroup(v) { try { global.localStorage.setItem("orbit.gallery.group", v); } catch { /* a per-device convenience only */ } }

  global.OrbitGallery = { create, matchNotes, hitNote, groupPhotos, groupLabel, safePhoto, KIND_NAME };
})(typeof window !== "undefined" ? window : globalThis);
