import { PR_INSPECT_TOOL_NAMES } from "./pr-inspect.ts";
import { MAX_RESET_MS, ProviderError, RATE_PAUSE_MS, USAGE_PAUSE_MS } from "./chatgpt.ts";
import type { FallbackInfo, Item, Message, ModelPort, Step, ToolDef } from "./model.ts";
import { BALANCE_EVERY_MS, openrouterClient } from "./openrouter.ts";
import type { OpenRouterClient, OpenRouterConfig } from "./openrouter.ts";
import { SpendError } from "./spend-ledger.ts";
import type { SpendLedger } from "./spend-ledger.ts";
import type { PortStatus } from "./ports.ts";

// The fallback model: ChatGPT token sharing stays primary; OpenRouter answers only while ChatGPT is limited.
//
// When it answers: the primary threw a typed ProviderError of kind usage_limit or rate_limit (including ORBIT's own pause refusal).
// Never for authentication, overload, incomplete or any other error: those are reported as they are.
// How long: until the primary's reset time, or, when it gave none, ORBIT's own estimated pause. The primary is not called before
// then. After it, the next call goes to the primary, and only a successful primary call counts as recovered.
// What it may do: the tools below, filtered on the way in and checked on the way out, so a model that names another tool gets nothing run.

// Read-only tools plus job_launch, which only creates a proposal Rai must confirm. Everything else (notify, job_steer, vault writes,
// every ops_propose_*, ops_sys_cancel_reboot) is refused here, in code, whatever the prompt says. A tool not listed is not allowed.
export const FALLBACK_TOOLS: ReadonlySet<string> = new Set([
  "memory_search",
  "memory_read",
  "github_repo_status",
  "orbit_config_view",
  "ops_orbit_status",
  "ops_orbit_logs",
  "ops_deploy_state",
  "ops_host_health",
  "ops_tailscale_status",
  "ops_vault_sync",
  "ops_credentials",
  "ops_admin_operations",
  "ops_sys_operations",
  "jobs_list",
  "job_status",
  "vault_policy",
  "job_launch",
  ...PR_INSPECT_TOOL_NAMES,
]);

type Limit = { kind: "usage_limit" | "rate_limit"; until: number; estimated: boolean };

export type FallbackModel = ModelPort & {
  // Test and status view of the fallback's own state.
  fallbackState(): { limit?: { kind: string; until: string; estimated: boolean }; usingFallback: boolean; recoveredAt?: string };
};

export type FallbackOptions = {
  primary: ModelPort;
  config: OpenRouterConfig;
  ledger?: SpendLedger;
  fetcher?: typeof fetch;
  now?: () => number;
  // A client made elsewhere (tests).
  client?: OpenRouterClient;
};

const isLimit = (err: unknown): err is ProviderError => err instanceof ProviderError && (err.kind === "usage_limit" || err.kind === "rate_limit");
const iso = (ms: number) => new Date(ms).toISOString();

export function fallbackModel(o: FallbackOptions): FallbackModel {
  const { primary, config } = o;
  const now = o.now ?? Date.now;
  let client: OpenRouterClient | undefined = o.client;
  if (!client && config.state === "ready" && o.ledger) client = openrouterClient(config, o.ledger, o.fetcher);
  const ledger = o.ledger;

  let limit: Limit | undefined;
  let recoveredAt: string | undefined;
  let lastUse: { at: string; costUsd?: number } | undefined;
  let lastFallbackError: string | undefined;
  let balance: { at: string; text: string } | undefined;
  let balanceTried = 0;

  const unavailable = (): string | undefined => {
    if (config.state !== "ready") return config.reason;
    if (!client || !ledger) return "The spend ledger is not configured.";
    return undefined;
  };

  const noteLimit = (err: ProviderError) => {
    const kind = err.kind as Limit["kind"];
    const t = now();
    const given = err.resetsAt ? Date.parse(err.resetsAt) : NaN;
    const reliable = Number.isFinite(given) && given > t && given - t <= MAX_RESET_MS;
    const next: Limit = { kind, until: reliable ? given : t + (kind === "usage_limit" ? USAGE_PAUSE_MS : RATE_PAUSE_MS), estimated: !reliable };
    // A limit in force is never shortened by a later report; a provider reset replaces an estimate.
    if (limit && limit.until > t && next.until <= limit.until && !(limit.estimated && !next.estimated)) return;
    limit = next;
    recoveredAt = undefined;
  };

  const active = (): Limit | undefined => (limit && limit.until > now() ? limit : undefined);

  const why = (l: Limit) =>
    `ChatGPT ${l.kind === "usage_limit" ? "usage limit" : "rate limit"}, ${l.estimated ? `no reset time given, ORBIT's own pause (an estimate) until ${iso(l.until)}` : `resets at ${iso(l.until)}`}`;

  // The original refusal, with what the fallback could not do, so the caller sees both and nothing is hidden.
  const augment = (err: ProviderError, detail: string) =>
    new ProviderError(err.kind, `${err.message.replace(/\s*$/, "")} The OpenRouter fallback did not answer: ${detail}`, err.resetsAt, err.code);

  const viaFallback = async (cause: ProviderError | undefined, input: Item[], limits: string[], notes: string | undefined, tools: ToolDef[]): Promise<Step> => {
    const l = limit!;
    const stand = cause ?? new ProviderError(l.kind, `${why(l)}.`, l.estimated ? undefined : iso(l.until));
    const problem = unavailable();
    if (problem) throw augment(stand, problem);
    const allowed = tools.filter((t) => FALLBACK_TOOLS.has(t.name));
    const names = new Set(allowed.map((t) => t.name));
    const told = [
      ...limits,
      `you are the OpenRouter fallback model (${client!.model}), answering because ${why(l)}. Say so if asked which model you are. You may only use the tools offered in this reply; everything else is refused by ORBIT.`,
    ];
    let paid;
    try {
      paid = await client!.step(input, told, notes, allowed);
    } catch (err) {
      lastFallbackError = err instanceof Error ? err.message : String(err);
      if (err instanceof SpendError) throw augment(stand, err.message);
      throw augment(stand, lastFallbackError);
    }
    lastFallbackError = undefined;
    const outside = paid.calls.find((c) => !names.has(c.name));
    if (outside) {
      throw augment(stand, `it asked for the tool ${JSON.stringify(outside.name.slice(0, 60))}, which fallback mode does not allow. Nothing was run.`);
    }
    lastUse = { at: iso(now()), ...(paid.costUsd !== undefined ? { costUsd: paid.costUsd } : {}) };
    const info: FallbackInfo = {
      provider: "openrouter",
      model: paid.model,
      reason: l.kind,
      primaryLimit: { until: iso(l.until), estimated: l.estimated },
      ...(paid.costUsd !== undefined ? { costUsd: paid.costUsd } : {}),
    };
    return { text: paid.text, calls: paid.calls, fallback: info };
  };

  // One model turn: the primary unless its limit is still in force.
  const turn = async (input: Item[], limits: string[], notes: string | undefined, tools: ToolDef[], viaPrimary: () => Promise<Step>): Promise<Step> => {
    if (active()) return viaFallback(undefined, input, limits, notes, tools);
    try {
      const step = await viaPrimary();
      if (limit) {
        // The pause or reset has passed and the primary answered: only now is it recovered.
        limit = undefined;
        recoveredAt = iso(now());
      }
      return step;
    } catch (err) {
      if (!isLimit(err)) throw err;
      noteLimit(err);
      return viaFallback(err, input, limits, notes, tools);
    }
  };

  const step = async (input: Item[], limits: string[], notes: string | undefined, tools: ToolDef[]): Promise<Step> => {
    if (!primary.step) throw new Error("This model cannot call tools.");
    return turn(input, limits, notes, tools, () => primary.step!(input, limits, notes, tools));
  };

  const spend = (): string => {
    if (!ledger) return "";
    try {
      const v = ledger.view();
      return ` Local OpenRouter allowance (UTC ${v.day}): $${v.spentTodayUsd.toFixed(4)} spent today of $${v.caps.dailyUsd}, $${v.lifetimeUsd.toFixed(4)} of $${v.caps.totalUsd} lifetime, $${v.reservedUsd.toFixed(4)} reserved for calls in flight${v.uncertainRequests ? `, ${v.uncertainRequests} request(s) charged at their upper bound because the cost was unknown` : ""}.`;
    } catch (err) {
      return ` Spend ledger problem: ${err instanceof SpendError ? err.message : "unreadable"}`;
    }
  };

  const wrapper: FallbackModel = {
    ...(primary.maintain || config.state === "ready"
      ? {
          async maintain() {
            await primary.maintain?.();
            // The balance is free to read and never spends. Best effort, at most every ten minutes.
            if (config.state !== "ready" || !client || now() - balanceTried < BALANCE_EVERY_MS) return;
            balanceTried = now();
            try {
              const b = await client.balance();
              const usd = (v: number | null) => (v === null ? "unknown" : `$${v.toFixed(2)}`);
              balance = { at: iso(now()), text: `OpenRouter key (account side, not the local allowance): limit ${b.limitUsd === null ? "none" : usd(b.limitUsd)}, remaining ${usd(b.remainingUsd)}, used ${usd(b.usedUsd)}, read ${iso(now())}.` };
            } catch (err) {
              balance = { at: iso(now()), text: `OpenRouter key balance unavailable: ${err instanceof Error ? err.message : "failed"}.` };
            }
          },
        }
      : {}),

    step: primary.step ? step : undefined,

    async reply(messages: Message[], limits: string[], notes?: string) {
      const items: Item[] = messages;
      const asText = (s: Step) => {
        if (!s.text) throw new Error("response had no text");
        return s;
      };
      let used: FallbackInfo | undefined;
      const result = await turn(items, limits, notes, [], async () => {
        const r = await primary.reply(messages, limits, notes);
        return { text: r.value, calls: [] };
      }).then((s) => {
        used = s.fallback;
        return asText(s);
      });
      return used
        ? { value: result.text, provenance: "live" as const, source: `model/openrouter/${(used as FallbackInfo).model}`, fallback: used as FallbackInfo }
        : { value: result.text, provenance: "live" as const, source: `model/${primary.status().impl}` };
    },

    status(): PortStatus {
      const base = primary.status();
      const l = limit;
      const off = unavailable();
      const armed = config.state === "disabled" ? "" : off ? ` OpenRouter fallback unavailable: ${off}` : ` OpenRouter fallback armed: ${client?.model}, used only while ChatGPT is limited.${spend()}${balance ? ` ${balance.text}` : ""}`;
      if (l) {
        const passed = l.until <= now();
        const state = passed ? "degraded" : off ? "down" : "degraded";
        const text = passed
          ? `The ${why(l)} has passed. ORBIT will try ChatGPT on the next call; it is not confirmed recovered until one succeeds.`
          : `${why(l)}. ${off ? "No fallback is available, so replies fail until then." : `Replies come from OpenRouter ${client?.model} (fallback, paid, restricted tools) until then; ChatGPT is not called.`}`;
        return { ...base, state, detail: `${text}${armed}${lastFallbackError ? ` Last fallback error: ${lastFallbackError}` : ""}` };
      }
      const recovered = recoveredAt ? ` ChatGPT recovered at ${recoveredAt} (a primary call succeeded).` : "";
      return armed || recovered ? { ...base, detail: `${base.detail}${recovered}${armed}` } : base;
    },

    fallbackState() {
      const l = active();
      return { ...(limit ? { limit: { kind: limit.kind, until: iso(limit.until), estimated: limit.estimated } } : {}), usingFallback: Boolean(l), ...(recoveredAt ? { recoveredAt } : {}) };
    },
  };
  // The primary's own extras (the ChatGPT sign-in routes, stop) stay reachable.
  for (const [k, v] of Object.entries(primary)) {
    if (!(k in wrapper) && typeof v === "function") (wrapper as Record<string, unknown>)[k] = v.bind(primary);
  }
  return wrapper;
}
