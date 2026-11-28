// The instance's identity: who this agent is, whose it is, how it looks and where it listens by default. The platform code
// has no identity of its own; everything personal lives in a persona directory, loaded once at startup:
//
//   persona/persona.json   id, name, expansion, owner, ownerPronouns, protectedTag, zone, port, ingressPort, url, themeColor, discord, vault
//   persona/personality.md the model's identity and voice (the first lines of every system prompt)
//   persona/avatar.png     the page's logo and icon
//   persona/theme.css      optional CSS layered over the base palette (custom properties such as --accent)
//
// The directory is PERSONA_DIR if set, otherwise ./persona at the repository root. A missing or unreadable field falls back to
// the default below, so an instance always starts; an invalid value is refused (startup fails) rather than half-applied.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Persona = {
  // Lowercase slug naming the instance's systemd credentials (<id>.discord-bot, ...).
  id: string;
  name: string;
  expansion?: string;
  owner: string;
  // How the platform's model-facing text refers to the owner (it was written about Rai as "he"); unset leaves it as written.
  ownerPronouns?: "she" | "he" | "they";
  // The vault tag that marks a note as protected (#rai for ORBIT): changing such a note needs the owner's confirmation.
  protectedTag: string;
  zone: string;
  port: number;
  ingressPort?: number;
  url?: string;
  themeColor: { dark: string; light: string };
  // Discord as a chat channel (src/discord.ts): the channel and the only account whose messages are run.
  discord?: { channelId?: string; ownerUserId?: string };
  // The instance's own vault repository (src/vault/clone.ts): written with the <id>.github-vault credential.
  vault?: { remote: string };
  personality: string;
  avatar?: Buffer;
  themeCss: string;
  dir: string;
};

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const HEX = /^#[0-9a-fA-F]{6}$/;

export const DEFAULT_PERSONA: Omit<Persona, "dir"> = {
  id: "agent",
  name: "Agent",
  owner: "the owner",
  protectedTag: "owner",
  zone: "America/Los_Angeles",
  port: 8790,
  themeColor: { dark: "#080a1a", light: "#f4f2fb" },
  personality: "",
  themeCss: "",
};

function fail(dir: string, why: string): never {
  throw new Error(`persona at ${dir}: ${why}`);
}

export function personaDir(env: NodeJS.ProcessEnv = process.env): string {
  const d = env.PERSONA_DIR;
  if (d) return isAbsolute(d) ? d : resolve(ROOT, d);
  return join(ROOT, "persona");
}

export function loadPersona(dir = personaDir()): Persona {
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f)) : undefined);
  let json: Record<string, unknown> = {};
  const raw = read("persona.json");
  if (raw) {
    try {
      json = JSON.parse(raw.toString("utf8"));
    } catch {
      fail(dir, "persona.json is not valid JSON");
    }
  }
  const str = (k: string, re?: RegExp): string | undefined => {
    const v = json[k];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "string" || !v.trim() || (re && !re.test(v))) fail(dir, `${k} is not valid`);
    return v.trim();
  };
  const port = (k: string): number | undefined => {
    const v = json[k];
    if (v === undefined || v === null) return undefined;
    if (!Number.isInteger(v) || (v as number) < 1024 || (v as number) > 65535) fail(dir, `${k} must be an integer from 1024 to 65535`);
    return v as number;
  };
  const tc = (json.themeColor ?? {}) as Record<string, unknown>;
  const color = (k: "dark" | "light") => {
    const v = tc[k];
    if (v === undefined) return DEFAULT_PERSONA.themeColor[k];
    if (typeof v !== "string" || !HEX.test(v)) fail(dir, `themeColor.${k} must be #rrggbb`);
    return v;
  };
  const zone = str("zone") ?? DEFAULT_PERSONA.zone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    fail(dir, `zone ${zone} is not a time zone`);
  }
  const dc = json.discord;
  if (dc !== undefined && (typeof dc !== "object" || dc === null || Array.isArray(dc))) fail(dir, "discord must be an object");
  const snowflake = (k: "channelId" | "ownerUserId"): string | undefined => {
    const v = (dc as Record<string, unknown> | undefined)?.[k];
    if (v === undefined || v === null || v === "") return undefined;
    if (typeof v !== "string" || !/^[0-9]{17,20}$/.test(v)) fail(dir, `discord.${k} must be a Discord id (17-20 digits, as a string)`);
    return v;
  };
  const discord = { channelId: snowflake("channelId"), ownerUserId: snowflake("ownerUserId") };
  const vj = json.vault;
  if (vj !== undefined && (typeof vj !== "object" || vj === null || Array.isArray(vj))) fail(dir, "vault must be an object");
  const vr = (vj as Record<string, unknown> | undefined)?.remote;
  if (vr !== undefined && (typeof vr !== "string" || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?(\.git)?$/.test(vr))) fail(dir, "vault.remote must be https://github.com/<owner>/<repo>.git");
  const owner = str("owner", /^[\p{L}\p{N} ._-]{1,60}$/u) ?? DEFAULT_PERSONA.owner;
  const pronouns = str("ownerPronouns", /^(she|he|they)$/) as Persona["ownerPronouns"];
  const tagGuess = owner.toLowerCase().replace(/[^a-z0-9-]/g, "");
  const protectedTag = str("protectedTag", /^[a-z][a-z0-9-]{0,30}$/) ?? (/^[a-z][a-z0-9-]{0,30}$/.test(tagGuess) && owner !== DEFAULT_PERSONA.owner ? tagGuess : DEFAULT_PERSONA.protectedTag);
  return {
    ...(pronouns ? { ownerPronouns: pronouns } : {}),
    protectedTag,
    id: str("id", /^[a-z][a-z0-9-]{0,30}$/) ?? DEFAULT_PERSONA.id,
    ...(discord.channelId || discord.ownerUserId ? { discord } : {}),
    ...(typeof vr === "string" ? { vault: { remote: vr } } : {}),
    name: str("name", /^[\p{L}\p{N} ._-]{1,40}$/u) ?? DEFAULT_PERSONA.name,
    expansion: str("expansion"),
    owner,
    zone,
    port: port("port") ?? DEFAULT_PERSONA.port,
    ingressPort: port("ingressPort"),
    url: str("url", /^https?:\/\/[^\s"<>]+$/),
    themeColor: { dark: color("dark"), light: color("light") },
    personality: (read("personality.md")?.toString("utf8") ?? "").trim(),
    avatar: read("avatar.png"),
    themeCss: (read("theme.css")?.toString("utf8") ?? "").replace(/<\/style/gi, "<\\/style"),
    dir,
  };
}

export const PERSONA: Persona = loadPersona();

// The model's opening lines: the persona's own personality text, or a plain identity line built from its fields.
export function identityLines(p: Persona = PERSONA): string[] {
  if (p.personality) return p.personality.split("\n");
  return [`You are ${p.name}${p.expansion ? ` (${p.expansion})` : ""}, ${p.owner}'s personal assistant.`, "Be concise and technical. Never present a guess as fact."];
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Applies the persona to the page: title, wordmark and labels, theme-color, and the persona's CSS after the base styles.
export function personaPage(html: string, p: Persona = PERSONA): string {
  const n = esc(p.name);
  let out = html
    .replace(/<title>[^<]*<\/title>/, `<title>${n}</title>`)
    .replace(/<span class="wordmark">[^<]*<\/span>/, `<span class="wordmark">${n}</span>`)
    .replace(/aria-label="ORBIT: Refresh page"/, `aria-label="${n}: Refresh page"`)
    .replace(/aria-label="ORBIT pages"/, `aria-label="${n} pages"`)
    .replace(/<meta name="theme-color" content="#[0-9a-fA-F]{6}" media="\(prefers-color-scheme: dark\)">/, `<meta name="theme-color" content="${p.themeColor.dark}" media="(prefers-color-scheme: dark)">`)
    .replace(/<meta name="theme-color" content="#[0-9a-fA-F]{6}" media="\(prefers-color-scheme: light\)">/, `<meta name="theme-color" content="${p.themeColor.light}" media="(prefers-color-scheme: light)">`);
  if (p.themeCss) out = out.replace("</head>", `<style id="persona-theme">\n${p.themeCss}\n</style>\n</head>`);
  return personaText(out, p);
}

// The page and its scripts were written for ORBIT and Rai: for another persona, every whole-word "ORBIT" (not ORBIT_*
// settings) and "Rai" in them is that persona's name and owner. Both are validated to letters, digits, space, . _ -, so the
// result is safe inside HTML text, attributes and JavaScript strings. ORBIT's own persona is left byte-for-byte unchanged.
export function personaText(text: string, p: Persona = PERSONA): string {
  let out = text;
  if (p.name !== "ORBIT") out = out.replace(/\bORBIT\b(?!_)/g, p.name);
  if (p.owner !== "Rai") out = out.replace(/\bRai\b/g, p.owner);
  return out;
}

// Model-facing platform text (system instructions, status lines, tool descriptions) was written for ORBIT and Rai ("he").
// For another persona: whole-word ORBIT (never ORBIT_* settings) becomes its name, Rai its owner, #rai its protected tag,
// and, when ownerPronouns differs from "he", he/him/his/himself the owner's pronouns. Never applied to what people wrote:
// messages, notes, vault excerpts and tool results reach the model as they are. ORBIT's own persona changes nothing.
const PRONOUNS: Record<"she" | "they", Record<string, string>> = {
  she: { he: "she", him: "her", his: "her", himself: "herself" },
  they: { he: "they", him: "them", his: "their", himself: "themselves" },
};
export function personaModelText(text: string, p: Persona = PERSONA): string {
  let out = text;
  if (p.name !== "ORBIT") out = out.replace(/\bORBIT\b(?!_)/g, p.name);
  if (p.owner !== "Rai") out = out.replace(/\bRai\b/g, p.owner);
  if (p.protectedTag !== "rai") out = out.replace(/#rai\b/g, `#${p.protectedTag}`);
  const map = p.ownerPronouns && p.ownerPronouns !== "he" ? PRONOUNS[p.ownerPronouns] : undefined;
  if (map) out = out.replace(/\b(he|him|his|himself|He|Him|His|Himself)\b/g, (w) => {
    const r = map[w.toLowerCase()]!;
    return w[0] === w[0]!.toUpperCase() ? r[0]!.toUpperCase() + r.slice(1) : r;
  });
  return out;
}

// The same for a tool's JSON schema: every "description" string inside it.
export function personaModelSchema<T>(schema: T, p: Persona = PERSONA): T {
  if (p.name === "ORBIT" && p.owner === "Rai" && p.protectedTag === "rai" && (!p.ownerPronouns || p.ownerPronouns === "he")) return schema;
  const walk = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(walk) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "description" && typeof x === "string" ? personaModelText(x, p) : walk(x)])) : v;
  return walk(schema) as T;
}
