import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PERSONA, identityLines, loadPersona, personaPage, personaText } from "../src/persona.ts";

const dir = (files: Record<string, string>) => {
  const d = mkdtempSync(join(tmpdir(), "persona-"));
  for (const [k, v] of Object.entries(files)) writeFileSync(join(d, k), v);
  return d;
};
const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");

test("an empty persona directory gives the neutral defaults", () => {
  const p = loadPersona(dir({}));
  assert.equal(p.name, DEFAULT_PERSONA.name);
  assert.equal(p.port, 8790);
  assert.equal(p.avatar, undefined);
  assert.deepEqual(identityLines(p), ["You are Agent, the owner's personal assistant.", "Be concise and technical. Never present a guess as fact."]);
});

test("persona.json and personality.md set identity, port and zone", () => {
  const p = loadPersona(dir({ "persona.json": JSON.stringify({ name: "Nova", owner: "Rai", port: 8792, zone: "Europe/Berlin", themeColor: { dark: "#101010" } }), "personality.md": "You are Nova.\nBe warm.\n" }));
  assert.equal(p.name, "Nova");
  assert.equal(p.port, 8792);
  assert.equal(p.zone, "Europe/Berlin");
  assert.equal(p.themeColor.dark, "#101010");
  assert.equal(p.themeColor.light, DEFAULT_PERSONA.themeColor.light);
  assert.deepEqual(identityLines(p), ["You are Nova.", "Be warm."]);
});

test("invalid values refuse to start instead of half-applying", () => {
  assert.throws(() => loadPersona(dir({ "persona.json": "{" })), /not valid JSON/);
  assert.throws(() => loadPersona(dir({ "persona.json": JSON.stringify({ port: 80 }) })), /port/);
  assert.throws(() => loadPersona(dir({ "persona.json": JSON.stringify({ zone: "Mars/Olympus" }) })), /time zone/);
  assert.throws(() => loadPersona(dir({ "persona.json": JSON.stringify({ name: "<script>" }) })), /name/);
  assert.throws(() => loadPersona(dir({ "persona.json": JSON.stringify({ themeColor: { dark: "red" } }) })), /themeColor/);
});

test("the page carries the persona's name, colors and theme, and nothing else changes for ORBIT", () => {
  const orbit = loadPersona(new URL("../persona", import.meta.url).pathname);
  if (orbit.name === "ORBIT" && !orbit.themeCss) assert.equal(personaPage(html, orbit), html, "ORBIT's persona leaves the page byte-for-byte as it was");
  const nova = loadPersona(dir({ "persona.json": JSON.stringify({ name: "Nova", themeColor: { dark: "#0a0f1e", light: "#f7f3ea" } }), "theme.css": ":root { --accent: #ff7a59; }</style><script>" }));
  const page = personaPage(html, nova);
  assert.match(page, /<title>Nova<\/title>/);
  assert.match(page, /<span class="wordmark">Nova<\/span>/);
  assert.match(page, /aria-label="Nova: Refresh page"/);
  assert.match(page, /<meta name="theme-color" content="#0a0f1e" media="\(prefers-color-scheme: dark\)">/);
  assert.match(page, /<style id="persona-theme">\n:root \{ --accent: #ff7a59; \}<\\\/style><script>\n<\/style>\n<\/head>/, "theme CSS cannot close its own style element");
});

test("another persona's name and owner replace ORBIT and Rai in the page text, never ORBIT_ settings", () => {
  const nova = loadPersona(dir({ "persona.json": JSON.stringify({ name: "Nova", owner: "Sam" }) }));
  assert.equal(personaText(`Message ORBIT · ORBIT's owner Rai · ORBIT_COMMIT · orbit.theme · Raise`, nova), `Message Nova · Nova's owner Sam · ORBIT_COMMIT · orbit.theme · Raise`);
  const page = personaPage(html, nova);
  assert.doesNotMatch(page.replace(/ORBIT_/g, ""), /\bORBIT\b/);
  const orbit = loadPersona(dir({ "persona.json": JSON.stringify({ name: "ORBIT", owner: "Rai" }) }));
  assert.equal(personaText(html, orbit), html);
  assert.throws(() => loadPersona(dir({ "persona.json": JSON.stringify({ owner: "O'Brien" }) })), /owner/, "an apostrophe could end a script string");
});
