import { PR_INSPECT_TOOL_NAMES } from "./pr-inspect.ts";
import { MAX_RESET_MS, ProviderError, RATE_PAUSE_MS, USAGE_PAUSE_MS } from "./chatgpt.ts";
import { replySource } from "./model.ts";
import type { FallbackInfo, Item, Message, ModelPort, Reply, ReplyOptions, Step, ToolDef } from "./model.ts";
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
  // Fail-closed latch. Set when a paid call showed the ledger cannot be trusted: it refused to admit a call, or it could not record a
  // call's outcome (billed answer, failed call, unreadable body, timeout). While it is set NO paid call is admitted (unavailable()),
  // and status says so. Nothing in this process clears it: not polling status, not a later call (none is made), not time. The way out is
  // a restart after the ledger has been checked: the ledger then charges the unrecorded call at its upper bound (the owner process
  // is gone), so uncertain spend is kept, never dropped. The first reason is kept.
  let ledgerFault: string | undefined;
  const latch = (reason: string) => void (ledgerFault ??= reason);
  let balance: { at: string; text: string } | undefined;
  let balanceTried = 0;

  const unavailable = (): string | undefined => {
    if (config.state !== "ready") return config.reason;
    if (!client || !ledger) return "The spend ledger is not configured.";
    return undefined;
  };
  // Actual admission of a paid call: configuration complete AND the ledger not latched as untrusted.
  const refusal = (): string | undefined => unavailable() ?? (ledgerFault ? `the spend ledger is latched as untrusted (${ledgerFault}); no paid call is admitted until ORBIT is restarted after the ledger is checked` : undefined);

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
  // `accounting` is the structured spend diagnostic of the failed paid call, kept as data on the error.
  // `accounting` is passed explicitly by every caller (an empty list when the failed step had none): nothing is inherited implicitly.
  // `detail` is the bare reason; ProviderError names the accounting once, so it is never part of the text built here.
  const augment = (err: ProviderError, detail: string, accounting: readonly string[]) =>
    new ProviderError(err.kind, `${err.base.replace(/\s*$/, "")} The OpenRouter fallback did not answer: ${detail}`, err.resetsAt, err.code, [...accounting], err);

  const viaFallback = async (cause: ProviderError | undefined, input: Item[], limits: string[], notes: string | undefined, tools: ToolDef[], paidOk = true): Promise<Step> => {
    const l = limit!;
    const stand = cause ?? new ProviderError(l.kind, `${why(l)}.`, l.estimated ? undefined : iso(l.until));
    // Background callers never spend the paid fallback: they get the limit as it is.
    if (!paidOk) throw stand;
    const problem = refusal();
    if (problem) throw augment(stand, problem, []);
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
      if (err instanceof SpendError) {
        // "ledger": it could not be read or written. "busy" (another process holds the lock) and the caps refused this one call before
        // anything was charged or sent: nothing is uncertain, so nothing latches.
        if (err.code === "ledger") latch("the spend ledger refused a paid call");
        throw augment(stand, err.message, []);
      }
      // A failed paid call whose outcome the ledger could not record is as uncertain as a billed answer that could not be recorded.
      const unrecorded = err instanceof ProviderError ? (err.accounting ?? []) : [];
      if (unrecorded.length) latch("the ledger could not record the outcome of a paid call");
      throw augment(stand, err instanceof ProviderError ? err.base : lastFallbackError, unrecorded);
    }
    lastFallbackError = undefined;
    // A billed answer whose ledger write failed is returned (never discarded), but the ledger is then not trustworthy.
    if (paid.accounting?.length) latch("the ledger could not record a paid call");
    const outside = paid.calls.find((c) => !names.has(c.name));
    if (outside) {
      throw augment(stand, `it asked for the tool ${JSON.stringify(outside.name.slice(0, 60))}, which fallback mode does not allow. Nothing was run.`, paid.accounting ?? []);
    }
    lastUse = { at: iso(now()), ...(paid.costUsd !== undefined ? { costUsd: paid.costUsd } : {}) };
    const info: FallbackInfo = {
      provider: "openrouter",
      model: paid.model,
      reason: l.kind,
      primaryLimit: { until: iso(l.until), estimated: l.estimated },
      ...(paid.costUsd !== undefined ? { costUsd: paid.costUsd } : {}),
    };
    return { text: paid.text, calls: paid.calls, fallback: info, ...(paid.accounting?.length ? { accounting: paid.accounting } : {}), ...(paid.incomplete?.length ? { incomplete: paid.incomplete } : {}) };
  };

  // One model turn: the primary unless its limit is still in force.
  const turn = async (input: Item[], limits: string[], notes: string | undefined, tools: ToolDef[], viaPrimary: () => Promise<Step>, paidOk = true): Promise<Step> => {
    if (active()) return viaFallback(undefined, input, limits, notes, tools, paidOk);
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
      return viaFallback(err, input, limits, notes, tools, paidOk);
    }
  };

  // Tool-using turns never spend the paid fallback unless the caller says so (`fallback: true`); a caller that says nothing, or a
  // background one, gets the limit as it is. reply() is the other way round (see ReplyOptions in model.ts).
  const step = async (input: Item[], limits: string[], notes: string | undefined, tools: ToolDef[], opts?: ReplyOptions): Promise<Step> => {
    if (!primary.step) throw new Error("This model cannot call tools.");
    return turn(input, limits, notes, tools, () => primary.step!(input, limits, notes, tools, opts?.signal ? { signal: opts.signal } : undefined), opts?.fallback === true);
  };

  // What status() may say about the paid fallback. READ-ONLY: it looks at the ledger file (never creates, repairs or writes it), at what
  // this process has already seen, and at the clock. It sends no provider request, balance or otherwise, so polling it spends nothing.
  // "armed" is claimed only when the config is complete AND the ledger was read and validated just now. The key, model and prices come
  // from configuration; nothing here has been verified with OpenRouter.
  // `usable` is whether a paid call could be attempted at all (false: config missing, or the ledger is known bad).
  const paidState = (): { armed: boolean; usable: boolean; text: string } => {
    if (config.state === "disabled") return { armed: false, usable: false, text: "" };
    const off = unavailable();
    if (off) return { armed: false, usable: false, text: ` OpenRouter fallback unavailable: ${off}` };
    let seen: ReturnType<SpendLedger["inspect"]>;
    try {
      seen = ledger!.inspect();
    } catch {
      seen = { state: "failed", reason: "the spend ledger could not be checked" };
    }
    if (seen.state === "unprovisioned") {
      return {
        armed: false,
        usable: false,
        text: ` OpenRouter fallback NOT armed, no paid call will be made: the spend ledger has not been provisioned${seen.requested ? " (a provision request is waiting and is applied when ORBIT next starts)" : ""}. It is never created by a status check or by a first call; see docs/openrouter-ledger-integrity.md.`,
      };
    }
    if (seen.state === "failed") {
      return { armed: false, usable: false, text: ` OpenRouter fallback NOT armed, no paid call will be made: ${seen.reason}. The ledger is never reset automatically; fix or restore it by hand.` };
    }
    if (ledgerFault) {
      return { armed: false, usable: false, text: ` OpenRouter fallback NOT armed, no paid call will be made: ${ledgerFault}. Check the spend ledger, then restart ORBIT; polling this status never clears it, and a restart charges the unrecorded call at its upper bound.` };
    }
    const unverified = ` Model ${client!.model}, key and prices come from ORBIT's configuration; they have not been verified with OpenRouter.`;
    const bal = !balance
      ? " The OpenRouter key balance has not been read yet."
      : now() - Date.parse(balance.at) > 2 * BALANCE_EVERY_MS
        ? ` STALE (last read ${balance.at}): ${balance.text}`
        : ` ${balance.text}`;
    const v = seen.view;
    const month = v.caps.monthlyUsd === null
      ? `no monthly cap${v.spentMonthUsd === null ? "" : ` ($${v.spentMonthUsd.toFixed(4)} spent in UTC month ${v.month})`}`
      : `$${(v.spentMonthUsd ?? 0).toFixed(4)} spent in UTC month ${v.month} of $${v.caps.monthlyUsd} (resets ${v.resets.monthlyAt})`;
    const life = v.caps.totalUsd === null ? `$${v.lifetimeUsd.toFixed(4)} lifetime (no lifetime cap)` : `$${v.lifetimeUsd.toFixed(4)} of $${v.caps.totalUsd} lifetime (never resets)`;
    const allowance = ` Local OpenRouter allowance as last written (UTC ${v.day}): $${v.spentTodayUsd.toFixed(4)} spent today of $${v.caps.dailyUsd} (resets ${v.resets.dailyAt}), ${month}, ${life}, $${v.reservedUsd.toFixed(4)} reserved for calls in flight (counted against every cap until settled)${v.uncertainRequests ? `, ${v.uncertainRequests} request(s) charged at their upper bound because the cost was unknown` : ""}; $${v.remainingTodayUsd.toFixed(4)} can still be reserved now. This is ORBIT's own count, not a hard spending ceiling.`;
    const spent = v.exhausted.length ? ` Every paid call is refused for now: the ${v.exhausted.join(" and ")} cap${v.exhausted.length > 1 ? "s are" : " is"} used up.` : "";
    return { armed: true, usable: true, text: ` OpenRouter fallback armed: ${client!.model}, used only while ChatGPT is limited.${allowance}${spent}${unverified}${bal}` };
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
              balance = { at: iso(now()), text: `OpenRouter key balance unavailable: ${err instanceof ProviderError ? err.message : "lookup failed"}.` };
            }
          },
        }
      : {}),

    step: primary.step ? step : undefined,

    async reply(messages: Message[], limits: string[], notes?: string, opts?: ReplyOptions): Promise<Reply> {
      const items: Item[] = messages;
      let primaryReply: Reply | undefined;
      const s = await turn(
        items,
        limits,
        notes,
        [],
        async () => {
          primaryReply = await primary.reply(messages, limits, notes, opts?.signal ? { signal: opts.signal } : undefined);
          return { text: primaryReply.value, calls: [] };
        },
        opts?.fallback !== false,
      );
      // The primary answered: its own result (value, provenance, source) passes through untouched, so a mock stays a mock.
      if (primaryReply) return primaryReply;
      if (!s.text) throw new Error("response had no text");
      const used = s.fallback!;
      return { value: s.text, provenance: "live" as const, source: replySource(primary.status().impl, used), fallback: used, ...(s.accounting?.length ? { accounting: s.accounting } : {}), ...(s.incomplete?.length ? { incomplete: s.incomplete } : {}) };
    },

    status(): PortStatus {
      const base = primary.status();
      const l = limit;
      const paid = paidState();
      const armed = paid.text;
      // No replies can come from the fallback unless a paid call could be attempted. "Configured but not verified" (ledger not created
      // yet) can; it is still never called armed.
      const off = !paid.usable;
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
