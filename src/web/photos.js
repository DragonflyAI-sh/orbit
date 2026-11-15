// ORBIT photo attachments in the browser (docs/photos.md). Every photo is decoded and re-encoded HERE, before anything is uploaded:
// orientation is applied, the image is drawn on a canvas and saved as a new JPEG, so EXIF, GPS and every other piece of original
// metadata is left behind, and the original file is never sent. If the browser cannot decode a file, the user gets a format error
// and nothing is uploaded; there is no fallback that sends the original. The server checks and normalizes the result again.
(function (global) {
  "use strict";

  const LIMITS = Object.freeze({
    maxPhotos: 10,              // per message; the server enforces the same number
    maxEdge: 1600,              // longest edge of the processed photo, in pixels (never upscaled)
    quality: 0.8,               // first JPEG quality tried
    targetBytes: 500 * 1024,    // aim per photo
    hardBytes: 1048576,         // never uploaded above this (the server's hard limit)
    maxInputBytes: 60 * 1024 * 1024,  // a selected file larger than this is refused before decoding
    maxSourcePixels: 100e6,     // decoded size bound (a 12 MP phone photo is 12e6; 48 MP modes are 48e6)
  });
  // Bounded attempts: up to 4 sizes x 3 qualities, stopping at the first result within targetBytes.
  const EDGES = [1, 0.8, 0.64, 0.5];
  const QUALITIES = [0.8, 0.68, 0.56];

  function sniff(b) {
    const at = (i, ...v) => v.every((x, k) => b[i + k] === x);
    const ascii = (i, s) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));
    if (at(0, 0xff, 0xd8, 0xff)) return "jpeg";
    if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "png";
    if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "webp";
    if (ascii(0, "GIF8")) return "gif";
    if (ascii(4, "ftyp")) {
      const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
      if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand)) return "heic";
      if (/^avi[fs]$/.test(brand)) return "avif";
      return "iso-media";
    }
    if (ascii(0, "%PDF")) return "pdf";
    const head = new TextDecoder().decode(b.subarray(0, 200)).replace(/^﻿/, "").trimStart().toLowerCase();
    if (head.startsWith("<")) return "svg";
    return "unknown";
  }

  // Pixel size from the file header, without decoding, so a huge image is refused before it is decoded. Null when not found.
  function headerSize(b, kind) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    try {
      if (kind === "png" && b.length >= 24) return { w: dv.getUint32(16), h: dv.getUint32(20) };
      if (kind === "gif" && b.length >= 10) return { w: dv.getUint16(6, true), h: dv.getUint16(8, true) };
      if (kind === "webp" && b.length >= 30) {
        const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
        if (chunk === "VP8X") return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
        if (chunk === "VP8L") { const v = dv.getUint32(21, true); return { w: 1 + (v & 0x3fff), h: 1 + ((v >> 14) & 0x3fff) }; }
        if (chunk === "VP8 ") return { w: dv.getUint16(26, true) & 0x3fff, h: dv.getUint16(28, true) & 0x3fff };
      }
      if (kind === "jpeg") {
        let p = 2;
        while (p + 9 < b.length && b[p] === 0xff) {
          const m = b[p + 1];
          const len = dv.getUint16(p + 2);
          if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: dv.getUint16(p + 5), w: dv.getUint16(p + 7) };
          p += 2 + len;
        }
      }
    } catch { /* not found */ }
    return null;
  }

  class PhotoError extends Error {}

  const FORMAT_HELP = {
    heic: "This photo is HEIC/HEIF and this browser cannot convert it. On iPhone, pick it from the Photos library with this button (iOS normally hands the page a JPEG copy), or set Settings > Camera > Formats to Most Compatible. Nothing was uploaded.",
    avif: "This browser cannot decode this AVIF image. Save it as JPEG or PNG and attach that. Nothing was uploaded.",
    svg: "SVG and other markup files are not accepted as photos. Nothing was uploaded.",
    pdf: "PDF files are not accepted as photos. Attach a JPEG, PNG or WebP image. Nothing was uploaded.",
    unknown: "This file is not an image this page can read. Attach a JPEG, PNG or WebP photo. Nothing was uploaded.",
  };

  // Decodes with the EXIF orientation applied. createImageBitmap honours orientation by default in current browsers; the explicit
  // option is passed for those that read it. The <img> path is the fallback where createImageBitmap is missing or refuses the file.
  async function decode(file) {
    if (typeof createImageBitmap === "function") {
      try {
        const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
        return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close && bmp.close() };
      } catch { /* try <img> below */ }
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    try {
      await img.decode();
    } catch {
      URL.revokeObjectURL(url);
      return null;
    }
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => { img.src = ""; URL.revokeObjectURL(url); } };
  }

  function canvasFor(w, h) {
    if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(w, h);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  }
  async function encode(canvas, q) {
    if (canvas.convertToBlob) return canvas.convertToBlob({ type: "image/jpeg", quality: q });
    return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new PhotoError("The browser could not encode the photo."))), "image/jpeg", q));
  }

  // Turns one selected file into an upload-ready JPEG Blob. Throws PhotoError with a message for the user.
  async function processFile(file, opts = {}) {
    const L = Object.assign({}, LIMITS, opts);
    if (!file || !file.size) throw new PhotoError("The file is empty. Nothing was uploaded.");
    if (file.size > L.maxInputBytes) throw new PhotoError(`The file is ${(file.size / 1048576).toFixed(0)} MB; files over ${L.maxInputBytes / 1048576} MB are not processed. Nothing was uploaded.`);
    const head = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
    const kind = sniff(head);
    if (kind === "svg" || kind === "pdf" || kind === "unknown") throw new PhotoError(FORMAT_HELP[kind]);
    const hs = headerSize(head, kind);
    if (hs && hs.w * hs.h > L.maxSourcePixels) throw new PhotoError(`The image is ${hs.w}×${hs.h} pixels, larger than this page decodes (${L.maxSourcePixels / 1e6} megapixels). Nothing was uploaded.`);
    const img = await decode(file);
    if (!img || !img.width || !img.height) throw new PhotoError(FORMAT_HELP[kind] || `This browser could not decode the ${kind.toUpperCase()} file. Save it as JPEG and attach that. Nothing was uploaded.`);
    let canvas = null;
    try {
      if (img.width * img.height > L.maxSourcePixels) throw new PhotoError(`The image is ${img.width}×${img.height} pixels, larger than this page decodes. Nothing was uploaded.`);
      const longest = Math.max(img.width, img.height);
      const base = Math.min(1, L.maxEdge / longest); // never upscale
      let best = null;
      let attempts = 0;
      for (const f of EDGES) {
        const scale = base * f;
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        if (canvas) { canvas.width = 0; canvas.height = 0; }
        canvas = canvasFor(w, h);
        const ctx = canvas.getContext("2d", { alpha: false });
        // Transparent PNG/WebP areas become white rather than black.
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, w, h);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img.source, 0, 0, w, h);
        for (const q of QUALITIES) {
          const blob = await encode(canvas, q);
          attempts++;
          if (!best || blob.size < best.blob.size) best = { blob, width: w, height: h, quality: q };
          if (blob.size <= L.targetBytes) return finish({ blob, width: w, height: h, quality: q }, attempts, file, img);
        }
        if (Math.max(w, h) <= 400) break;
      }
      if (!best || best.blob.size > L.hardBytes) throw new PhotoError(`The photo is still ${best ? Math.round(best.blob.size / 1024) : "?"} KB after shrinking, above the ${Math.round(L.hardBytes / 1024)} KB limit. Nothing was uploaded.`);
      return finish(best, attempts, file, img);
    } finally {
      if (canvas) { canvas.width = 0; canvas.height = 0; }
      img.close();
    }
  }
  async function finish(r, attempts, file, img) {
    const head = new Uint8Array(await r.blob.slice(0, 3).arrayBuffer());
    if (r.blob.type !== "image/jpeg" || head[0] !== 0xff || head[1] !== 0xd8) throw new PhotoError("The browser did not produce a JPEG. Nothing was uploaded.");
    return { blob: r.blob, width: r.width, height: r.height, quality: r.quality, attempts, inputBytes: file.size, sourceWidth: img.width, sourceHeight: img.height };
  }

  // A small worker pool: at most `n` tasks at once.
  function pool(n) {
    let running = 0;
    const queue = [];
    const next = () => {
      if (running >= n || !queue.length) return;
      running++;
      const { task, resolve, reject } = queue.shift();
      Promise.resolve().then(task).then(resolve, reject).finally(() => { running--; next(); });
    };
    return (task) => new Promise((resolve, reject) => { queue.push({ task, resolve, reject }); next(); });
  }
  // One photo is decoded at a time (memory); two uploads run at once.
  const processing = pool(1);
  const uploading = pool(2);

  // The tray of photos waiting to be sent with one message. `uploadUrl()` names the conversation's upload route (or null when
  // there is none). `scope()` names the conversation; photos uploaded into one are never sent into another.
  function createTray({ root, uploadUrl, scope, onChange, mk }) {
    let items = [];
    let seq = 0;
    let note = "";
    const changed = () => { render(); if (onChange) onChange(); };
    const statusText = (it) => it.status === "processing" ? "Processing…" : it.status === "queued" ? "Waiting…" : it.status === "uploading" ? "Uploading…" : it.status === "ready" ? "Ready" : `Failed: ${it.error}`;
    function render() {
      root.hidden = !items.length && !note;
      const nodes = items.map((it, i) => {
        const label = `Photo ${i + 1} of ${items.length}`;
        const thumb = it.preview ? mk("img", { className: "phthumb", src: it.preview, alt: label }) : mk("div", { className: "phthumb phwait", textContent: "…", ariaLabel: label });
        const kids = [thumb, mk("span", { className: `phstatus ${it.status === "failed" ? "bad" : ""}`, textContent: statusText(it), title: it.status === "failed" ? it.error : "" })];
        if (it.status === "failed") kids.push(mk("button", { type: "button", className: "phretry", textContent: "Retry", ariaLabel: `Retry ${label}`, onclick: () => retry(it) }));
        kids.push(mk("button", { type: "button", className: "phx", textContent: "×", title: "Remove", ariaLabel: `Remove ${label}`, onclick: () => remove(it) }));
        const box = mk("div", { className: `ph ${it.status}` }, ...kids);
        box.dataset.status = it.status;
        return box;
      });
      if (note) nodes.push(mk("div", { className: "phnote", role: "status", textContent: note }));
      root.replaceChildren(...nodes);
    }
    async function upload(it) {
      const url = uploadUrl();
      if (!url) { it.status = "failed"; it.error = "No conversation is open to attach to."; changed(); return; }
      it.scope = scope();
      it.status = "uploading";
      changed();
      let res, data = {};
      try {
        res = await uploading(() => fetch(url, { method: "POST", headers: { "content-type": "image/jpeg" }, body: it.blob }));
        try { data = await res.json(); } catch { /* not JSON */ }
      } catch { res = null; }
      if (!items.includes(it)) return;
      if (res && res.ok && data.attachment && typeof data.attachment.id === "string") {
        it.id = data.attachment.id;
        it.status = "ready";
      } else {
        it.status = "failed";
        it.stage = "upload";
        it.error = (data && data.error) || (res ? `upload failed (HTTP ${res.status})` : "no connection");
      }
      changed();
    }
    async function work(it) {
      it.status = "queued";
      changed();
      try {
        const out = await processing(async () => {
          if (!items.includes(it)) return null;
          it.status = "processing";
          changed();
          return processFile(it.file);
        });
        if (!out || !items.includes(it)) return;
        it.blob = out.blob;
        it.width = out.width;
        it.height = out.height;
        if (it.preview) URL.revokeObjectURL(it.preview);
        it.preview = URL.createObjectURL(out.blob);
      } catch (e) {
        if (!items.includes(it)) return;
        it.status = "failed";
        it.stage = "process";
        it.error = e instanceof PhotoError ? e.message : "The photo could not be processed. Nothing was uploaded.";
        changed();
        return;
      }
      await upload(it);
    }
    function retry(it) {
      if (it.stage === "upload" && it.blob) upload(it); else work(it);
    }
    function remove(it) {
      items = items.filter((x) => x !== it);
      if (it.preview) URL.revokeObjectURL(it.preview);
      it.blob = null;
      it.file = null;
      note = "";
      changed();
    }
    return {
      add(fileList) {
        const files = Array.from(fileList || []);
        const room = LIMITS.maxPhotos - items.length;
        const take = files.slice(0, Math.max(0, room));
        note = files.length > take.length ? `At most ${LIMITS.maxPhotos} photos per message: ${files.length - take.length} not added.` : "";
        for (const file of take) {
          const it = { key: ++seq, file, status: "queued" };
          items.push(it);
          work(it);
        }
        changed();
      },
      setNote(text) { note = text || ""; changed(); },
      count: () => items.length,
      readyCount: () => items.filter((it) => it.status === "ready").length,
      // Ready to send: every retained photo is uploaded into the current conversation.
      ready: () => items.length > 0 && items.every((it) => it.status === "ready" && it.scope === scope()),
      busy: () => items.some((it) => it.status !== "ready" && it.status !== "failed"),
      failed: () => items.filter((it) => it.status === "failed").length,
      foreign: () => items.some((it) => it.status === "ready" && it.scope !== scope()),
      ids: () => items.map((it) => it.id),
      previews: () => items.map((it) => it.preview),
      clear() {
        for (const it of items) { if (it.preview) URL.revokeObjectURL(it.preview); it.blob = null; it.file = null; }
        items = [];
        note = "";
        changed();
      },
    };
  }

  global.OrbitPhotos = { LIMITS, sniff, headerSize, processFile, createTray, PhotoError };
})(window);
