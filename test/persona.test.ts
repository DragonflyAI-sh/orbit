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

test("id and discord settings are validated; Discord ids must be strings of 17-20 digits", () => {
  const p = loadPersona(dir({ "persona.json": JSON.stringify({ id: "nova", discord: { channelId: "1575982468467531787" } }) }));
  assert.equal(p.id, "nova");
  assert.deepEqual(p.discord, { channelId: "1575982468467531787", ownerUserId: undefined });
  assert.equal(loadPersona(dir({})).discord, undefined);
  assert.throws(() => loadPersona(dir({ "persona.json": JSON.stringify({ discord: { channelId: 1575982468467531787 } }) })), /discord.channelId/, "a number loses precision");
  assert.throws(() => loadPersona(dir({ "persona.json": JSON.stringify({ id: "Nova!" }) })), /id is not valid/);
});

test("vault.remote must be a GitHub https URL", () => {
  assert.deepEqual(loadPersona(dir({ "persona.json": JSON.stringify({ vault: { remote: "https://github.com/DragonflyAI-sh/nova-vault.git" } }) })).vault, { remote: "https://github.com/DragonflyAI-sh/nova-vault.git" });
  assert.equal(loadPersona(dir({})).vault, undefined);
  for (const remote of ["git@github.com:a/b.git", "https://evil.example/a/b.git", "https://github.com/a/b.git --upload-pack=x", "--upload-pack=x"]) {
    assert.throws(() => loadPersona(dir({ "persona.json": JSON.stringify({ vault: { remote } }) })), /vault.remote/, remote);
  }
});

test("each instance has its own vault credential, repository, log file, machine note and commit author", async () => {
  const { execFileSync } = await import("node:child_process");
  const nova = dir({ "persona.json": JSON.stringify({ id: "nova", name: "Nova", vault: { remote: "https://github.com/DragonflyAI-sh/nova-vault.git" } }) });
  const none = dir({ "persona.json": JSON.stringify({ id: "plain" }) });
  const probe = `
    const c = await import("./src/vault/clone.ts"); const e = await import("./src/vault/edit.ts"); const g = await import("./src/vault/git.ts");
    console.log(JSON.stringify({ cred: c.CREDENTIAL_NAME, remote: c.DEFAULT_REMOTE ?? null, novaLog: e.isOrbitLog("Log/2026/2026-11-27-nova.md"), orbitLog: e.isOrbitLog("Log/2026/2026-11-27-orbit.md"), machine: e.areaOf("Machines/nova.md").area, author: g.GIT_AUTHOR }));`;
  const run = (d: string) => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", probe], { cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, PERSONA_DIR: d }, encoding: "utf8" }));
  assert.deepEqual(run(nova), { cred: "nova.github-vault", remote: "https://github.com/DragonflyAI-sh/nova-vault.git", novaLog: true, orbitLog: false, machine: "direct", author: { name: "Nova", email: "nova@users.noreply.github.com" } });
  assert.equal(run(none).remote, null, "no vault repository unless the persona names one: never another instance's");
});
