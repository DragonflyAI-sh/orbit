import { readFileSync } from "node:fs";
import type { ChatTool } from "./agent.ts";
import type { Ops } from "./ops-client.ts";
import { ADMIN_ACTIONS } from "./ops/admin-protocol.ts";
import { IDENTITY_PROPS, INVENTORY_SCHEMA, SANDBOX_PROPS, SOCKET_PROPS, SPEC } from "./ops/inventory.ts";
import { ACTIONS, INVENTORY_DISABLED_MESSAGE, INVENTORY_UNSUPPORTED_MESSAGE } from "./ops/protocol.ts";
import { SYS_ACTIONS } from "./ops/sys-protocol.ts";
import type { Result } from "./ports.ts";

// ORBIT's side of the read-only host inventory (docs/host-inventory.md): one owner-only chat tool, `ops_host_inventory`, over the
// existing orbit-ops transport (src/ops-client.ts, socket group orbit-ops). It is offered only when ORBIT_HOST_INVENTORY=enabled is set
// in orbit.env (by hand; it is not a setting the tier 2 config proposal can change), and the helper itself answers only after the host
// has been activated separately. Off by default on both sides.
//
// The tool sends no arguments to the helper: `section` and `part` only choose which part of the one fixed answer the model sees, so
// the answer fits the chat transport. Each call asks the helper afresh; every part carries its own observation time.

export const HOST_INVENTORY_TOOL = "ops_host_inventory";
export const HOST_INVENTORY_FLAG = "ORBIT_HOST_INVENTORY";
export const SECTIONS = ["serviceIdentities", "groups", "sandbox", "helperBoundaries", "paths", "mounts", "deploymentSeparation", "declaredVsLoaded"] as const;
export type SectionName = (typeof SECTIONS)[number];
// Each part's items stay under this many characters, so a part reaches the model whole (src/agent.ts MAX_OUTPUT_CHARS is 8000).
export const PART_BUDGET_CHARS = 5000;
export const MAX_PARTS = 40;

// Exactly "enabled". Anything else, including unset, "1" and "true", leaves the tool off.
export const hostInventoryEnabled = (env: Record<string, string | undefined>): boolean => env[HOST_INVENTORY_FLAG] === "enabled";

type Section = { origin: string; source: string; observedAt: string; complete: boolean; unavailable: string[]; warnings: string[]; items: unknown[] };
type Inventory = { schema: string; observedAt: string; scope: string; sections: Record<string, Section>; notObserved: string[] };

// ---- what the repository declares: the unit files of the release ORBIT is running, fixed units and fixed properties only ----

const BOOL = new Map([["yes", "yes"], ["true", "yes"], ["on", "yes"], ["1", "yes"], ["no", "no"], ["false", "no"], ["off", "no"], ["0", "no"]]);
const LIST_PROPS = new Set(["SupplementaryGroups", "CapabilityBoundingSet", "AmbientCapabilities", "RestrictAddressFamilies", "ReadWritePaths", "ReadOnlyPaths", "StateDirectory"]);
export const COMPARED_PROPS: string[] = [...IDENTITY_PROPS.filter((p) => !["LoadState", "ActiveState", "SubState", "UID", "GID"].includes(p)), ...SANDBOX_PROPS, ...SOCKET_PROPS];

export type Declared = Map<string, Record<string, string>>;

// systemd unit syntax, for the fixed properties only: later assignments of a list setting append, an empty one resets it.
export function parseUnitFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";") || line.startsWith("[")) continue;
    const i = line.indexOf("=");
    if (i < 1) continue;
    const key = line.slice(0, i).trim();
    if (!COMPARED_PROPS.includes(key)) continue;
    const value = line.slice(i + 1).trim();
    out[key] = LIST_PROPS.has(key) && value && out[key] ? `${out[key]} ${value}` : value;
  }
  return out;
}

export function readDeclared(read: (unit: string) => string = (u) => readFileSync(new URL(`../deploy/systemd/${u}`, import.meta.url), "utf8")): { declared: Declared; unreadable: string[] } {
  const declared: Declared = new Map();
  const unreadable: string[] = [];
  for (const unit of [...SPEC.services, ...SPEC.sockets.map((s) => s.unit)]) {
    try {
      declared.set(unit, parseUnitFile(read(unit)));
    } catch {
      unreadable.push(unit);
    }
  }
  return { declared, unreadable };
}

const norm = (prop: string, v: unknown): string | undefined => {
  if (v === null || v === undefined) return undefined;
  if (Array.isArray(v)) return v.map((x) => String(x).toLowerCase()).sort().join(" ");
  const s = String(v).trim();
  if (LIST_PROPS.has(prop)) return s.split(/\s+/).filter(Boolean).map((x) => x.toLowerCase()).sort().join(" ");
  if (prop === "SocketMode") return s.replace(/^0+/, "");
  return BOOL.get(s.toLowerCase()) ?? s.toLowerCase();
};

// Per unit: which declared settings systemd has loaded unchanged, which differ (drift is a finding, not fixed), which the repository
// leaves at systemd's default, and which could not be observed. Values that failed the helper's shape check are never a match.
export function compareDeclared(inv: Inventory, d: { declared: Declared; unreadable: string[] }): Section {
  const sandbox = inv.sections.sandbox?.items ?? [];
  const identities = inv.sections.serviceIdentities?.items ?? [];
  const sockets = (inv.sections.helperBoundaries?.items ?? []).filter((x) => (x as { kind?: string }).kind === "socket");
  const loadedOf = (unit: string): Record<string, unknown> | undefined => {
    const a = sandbox.find((x) => (x as { unit?: string }).unit === unit) as Record<string, unknown> | undefined;
    const b = identities.find((x) => (x as { unit?: string }).unit === unit) as Record<string, unknown> | undefined;
    const c = (sockets.find((x) => (x as { unit?: string }).unit === unit) as { unitSettings?: Record<string, unknown> } | undefined)?.unitSettings;
    return a || b || c ? { ...a, ...b, ...c } : undefined;
  };
  const items: unknown[] = [];
  let complete = d.unreadable.length === 0;
  for (const [unit, decl] of d.declared) {
    const loaded = loadedOf(unit);
    const isSocket = unit.endsWith(".socket");
    const props = COMPARED_PROPS.filter((p) => (isSocket ? (SOCKET_PROPS as readonly string[]).includes(p) : !(SOCKET_PROPS as readonly string[]).includes(p)));
    const drift: { prop: string; declared: string; loaded: unknown }[] = [];
    const notObserved: string[] = [];
    let match = 0;
    for (const p of props) {
      if (!Object.hasOwn(decl, p)) continue;
      const lv = loaded?.[p];
      if (!loaded || lv === undefined || lv === null || lv === "[unrecognised]") {
        notObserved.push(p);
        continue;
      }
      if (norm(p, decl[p]) === norm(p, lv)) match++;
      else drift.push({ prop: p, declared: decl[p]!, loaded: lv });
    }
    if (!loaded || notObserved.length) complete = false;
    items.push({ unit, declaredSettings: Object.keys(decl).length, match, drift, notObserved, notDeclared: props.filter((p) => !Object.hasOwn(decl, p)).length });
  }
  for (const unit of d.unreadable) items.push({ unit, state: "unavailable", reason: "the repository unit file could not be read from ORBIT's release" });
  return {
    origin: "repo-declared vs systemd-loaded",
    source: "deploy/systemd/<unit> in the release ORBIT runs, compared with the helper's systemd-loaded settings (fixed units and properties)",
    observedAt: inv.observedAt,
    complete,
    unavailable: d.unreadable.map((u) => `${u}: repository unit file unreadable`),
    warnings: [
      "Drift is reported, never fixed. A match means systemd loaded what the repository declares; it is still configuration, not proof of enforcement.",
      "Settings the repository does not declare are counted as notDeclared (systemd's defaults apply) and are not compared.",
    ],
    items,
  };
}

// ---- the tool ----

type Status = "ok" | "disabled" | "unsupported" | "unavailable";
const answer = (value: Record<string, unknown>): Result<unknown> => ({ value, provenance: "live", source: "ops/host_inventory" });

// An error from the transport or the helper, mapped to an explicit status. Never a fallback, never a guess.
export function classify(err: unknown): { status: Exclude<Status, "ok">; reason: string } {
  const m = err instanceof Error ? err.message : String(err);
  if (m.includes(INVENTORY_DISABLED_MESSAGE)) return { status: "disabled", reason: "The orbit-ops helper on the host has not been activated for host inventory (no valid activation marker). Activation is a separate, owner-run step: docs/host-inventory.md." };
  if (m.includes(INVENTORY_UNSUPPORTED_MESSAGE)) return { status: "unsupported", reason: "The installed orbit-ops helper knows host_inventory, but the inventory module is not installed (or is not safely root-owned) next to it." };
  if (/Unknown action/.test(m)) return { status: "unsupported", reason: "The installed orbit-ops helper predates host_inventory. Nothing else was tried." };
  if (/is not available/.test(m)) return { status: "unavailable", reason: "The orbit-ops helper is not installed or not running (no socket)." };
  if (/refused access/.test(m)) return { status: "unavailable", reason: "ORBIT may not connect to the orbit-ops socket (group membership not in effect)." };
  if (/did not answer in time/.test(m)) return { status: "unavailable", reason: "The orbit-ops helper did not answer in time. Nothing is known about the host from this call." };
  return { status: "unavailable", reason: `The orbit-ops helper could not answer: ${m.slice(0, 160)}` };
}

const isInventory = (v: unknown): v is Inventory => {
  const o = v as Inventory | undefined;
  return !!o && o.schema === INVENTORY_SCHEMA && typeof o.observedAt === "string" && !!o.sections && typeof o.sections === "object" && Array.isArray(o.notObserved);
};

// Greedy split of a section's items into parts that each fit PART_BUDGET_CHARS. An item larger than the budget is replaced by a
// marker (none is expected: every value is shape-checked and capped by the helper).
export function partsOf(items: unknown[]): unknown[][] {
  const parts: unknown[][] = [];
  let cur: unknown[] = [];
  let size = 0;
  for (const raw of items) {
    let item = raw;
    let n = JSON.stringify(item).length + 1;
    if (n > PART_BUDGET_CHARS) {
      item = { state: "omitted", reason: "this item exceeded the per-part output bound" };
      n = JSON.stringify(item).length + 1;
    }
    if (cur.length && size + n > PART_BUDGET_CHARS) {
      parts.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(item);
    size += n;
  }
  if (cur.length || !parts.length) parts.push(cur);
  return parts.slice(0, MAX_PARTS);
}

function overview(inv: Inventory, cmp: Section) {
  const sections: Record<string, unknown> = {};
  for (const name of SECTIONS) {
    const s = name === "declaredVsLoaded" ? cmp : inv.sections[name];
    if (!s) {
      sections[name] = { state: "missing from the helper's answer", complete: false };
      continue;
    }
    sections[name] = { origin: s.origin, observedAt: s.observedAt, complete: s.complete, items: s.items.length, parts: partsOf(s.items).length, unavailable: s.unavailable.slice(0, 3), warnings: s.warnings.length };
  }
  const drift = cmp.items.flatMap((x) => ((x as { drift?: { prop: string }[]; unit: string }).drift ?? []).map((d) => ({ unit: (x as { unit: string }).unit, ...d })));
  const separation = (inv.sections.deploymentSeparation?.items ?? []).map((x) => ({ path: (x as { path: string }).path, orbitServiceWrite: (x as { orbitServiceWrite: string }).orbitServiceWrite }));
  return {
    status: "ok" as const,
    observedAt: inv.observedAt,
    scope: inv.scope,
    howToRead:
      "Each section says where it came from (origin), when, whether it is complete, and why anything is unavailable. Missing or unavailable evidence is NOT a passed check. 'systemd-loaded' is configuration, not proof of enforcement; only 'host-observed' facts were seen on the host; 'derived' combines them and names its inputs. Read a section with {section, part}.",
    sections,
    driftFindings: drift.slice(0, 12),
    driftCount: drift.length,
    deploymentSeparation: separation,
    helperActionsDeclaredInRepository: { "orbit-ops": [...ACTIONS], "orbit-ops-admin": [...ADMIN_ACTIONS], "orbit-ops-sys": [...SYS_ACTIONS] },
    notObserved: inv.notObserved,
  };
}

export function hostInventoryTool(d: { ops: Ops; declared?: () => { declared: Declared; unreadable: string[] } }): ChatTool {
  const declared = d.declared ?? (() => readDeclared());
  return {
    name: HOST_INVENTORY_TOOL,
    readOnly: true,
    description:
      "Read-only inventory of how ORBIT is deployed on its server, from the orbit-ops root helper: service identities (UID/GID while running), sandbox settings as systemd loaded them, helper socket and root-code ownership, owner/mode of a fixed list of ORBIT paths, mount flags for those paths, deployment separation, and drift from the repository's unit files. Fixed queries only: it takes no paths, units or commands. Without arguments it returns an overview; {section, part} returns one section page. Each section has origin, observedAt, complete, unavailable and warnings: missing evidence is not a pass, and configured is not enforced. If the status is disabled, unsupported or unavailable, say exactly that; nothing else was tried.",
    parameters: {
      type: "object",
      properties: {
        section: { type: "string", enum: [...SECTIONS], description: "Optional. One section to read in full, a page at a time." },
        part: { type: "integer", minimum: 1, maximum: MAX_PARTS, description: "Optional. Which page of the section (default 1)." },
      },
      required: [],
      additionalProperties: false,
    },
    run: async (a) => {
      const extra = Object.keys(a).filter((k) => k !== "section" && k !== "part");
      if (extra.length) throw new Error("Only {section?, part?} is accepted; this tool takes no paths, units or commands.");
      const section = a.section ?? null;
      const part = a.part ?? null;
      if (section !== null && (typeof section !== "string" || !(SECTIONS as readonly string[]).includes(section))) throw new Error(`section must be one of: ${SECTIONS.join(", ")}.`);
      if (part !== null && (typeof part !== "number" || !Number.isInteger(part) || part < 1 || part > MAX_PARTS)) throw new Error(`part must be an integer from 1 to ${MAX_PARTS}.`);
      if (part !== null && section === null) throw new Error("part needs a section.");
      let raw: Result<unknown>;
      try {
        raw = await d.ops.call("host_inventory");
      } catch (err) {
        return answer({ ...classify(err), observedAt: null, note: "No host facts were obtained. Do not describe the host's configuration from this call." });
      }
      if (!isInventory(raw.value)) return answer({ status: "unavailable", reason: "The helper's answer did not have the expected inventory shape; it is not shown.", observedAt: null });
      const inv = raw.value;
      const cmp = compareDeclared(inv, declared());
      if (section === null) return answer(overview(inv, cmp));
      const s = section === "declaredVsLoaded" ? cmp : inv.sections[section];
      if (!s) return answer({ status: "unavailable", section, reason: "This section is missing from the helper's answer.", observedAt: inv.observedAt });
      const parts = partsOf(s.items);
      const n = (part as number | null) ?? 1;
      if (n > parts.length) throw new Error(`part ${n} does not exist; this section has ${parts.length} part(s) in this observation.`);
      return answer({
        status: "ok",
        section,
        origin: s.origin,
        source: s.source,
        observedAt: s.observedAt,
        complete: s.complete,
        unavailable: s.unavailable,
        warnings: s.warnings,
        part: n,
        parts: parts.length,
        note: parts.length > 1 ? "Each part is a fresh observation; compare observedAt across parts." : undefined,
        items: parts[n - 1],
      });
    },
  };
}
