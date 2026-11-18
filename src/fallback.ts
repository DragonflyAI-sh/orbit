import { MAX_RESET_MS, ProviderError, RATE_PAUSE_MS, USAGE_PAUSE_MS } from "./chatgpt.ts";
import { replySource } from "./model.ts";
import type { FallbackInfo, ImageSupport, Item, Message, ModelPort, Reply, ReplyOptions, Step, ToolDef, ToolRounds } from "./model.ts";
import { FALLBACK_NO_PHOTOS, withoutPhotos } from "./photo-context.ts";
import { BALANCE_EVERY_MS, openrouterClient, reservationUsd } from "./openrouter.ts";
import type { OpenRouterClient, OpenRouterConfig } from "./openrouter.ts";
import { SpendError, toMicro, toUsd } from "./spend-ledger.ts";
import type { SpendLedger } from "./spend-ledger.ts";
import type { FallbackRoute, ModelAvailability, PortStatus } from "./ports.ts";

// The fallback model: ChatGPT token sharing stays primary; OpenRouter answers only while ChatGPT is limited.
//
// When it answers: the primary threw a typed ProviderError of kind usage_limit or rate_limit (including ORBIT's own pause refusal).
// Never for authentication, overload, incomplete or any other error: those are reported as they are.
// How long: until the primary's reset time, or, when it gave none, ORBIT's own estimated pause. The primary is not called before
// then. After it, the next call goes to the primary, and only a successful primary call counts as recovered.
// What it may do: exactly what the primary may do in the same reply. The fallback is offered the caller's whole tool list, unchanged
// (docs/openrouter-fallback.md, "Tools"). Every safeguard that matters is model-independent and lives where the tool runs, not here:
// the owner check and the tool list are decided by the caller (the owner's chat), each tool keeps its own policy checks, and a call to
// a tool that was not offered runs nothing (runChat answers "No tool named ..."), whichever model asked. Proposal tools (job_launch,
// job_steer, research_launch, every ops_propose_*) only open a card that waits for Rai. Not everything is a card: the vault write tools
// and research_save_to_vault commit and push at once where the vault's AGENTS.md section 3 allows a direct write (only section 4
// protected changes become a card), notify sends at once, ops_sys_cancel_reboot cancels a confirmed reboot at once, and the photo
// observation tools write ORBIT's own observation store, each under its existing owner, policy and audit checks, exactly as on the
// primary. What stays different is only what the route really cannot do or must not spend: no photos are sent to it (it is not given
// images in this build), background callers never spend it, and every paid call is admitted by the spend ledger and its caps.
//
// Availability (status()): a configured fallback is not evidence that it answers. While the primary's limit is in force the port is
// `down` (available false) when no paid call can be admitted OR the latest paid call in this limit window failed, `degraded` with
// available true only after a paid call in this window succeeded, and `degraded` with available null (not known) before any.
// "Latest" is the latest to START among the calls of this window that have finished: a call keeps the window (generation) it started
// in, and a call that finishes after a new window began, after the primary recovered, or after a newer call finished, writes nothing.
// Refusals that sent nothing and say nothing about the route are not evidence either: one "busy" ledger lock collision, and a cap
// refusal of a request larger than one that already succeeded in this window while a request of that size still fits. A second
// consecutive "busy", and a cap refusal with no smaller request known to fit, are evidence (failed). After the limit time has passed
// the primary's own state decides: a primary that is down or a mock is never reported available.

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
  // The outcome of the latest paid fallback call in the current limit window: the only evidence that the fallback answers. Cleared
  // when a new limit window starts and when the primary recovers. Not touched by refusals that are not about the route (a background
  // caller, photos on the newest message) or by an unusable configuration, which status reads directly.
  // `seq` is the call's start order, so an older call finishing late cannot replace a newer call's outcome.
  let lastCall: { ok: boolean; at: string; seq: number } | undefined;
  // The evidence window. Bumped whenever the evidence is reset (a new limit window, a primary recovery); every call captures it when
  // it starts, and a call from an earlier window writes no evidence (and a primary call from an earlier window recovers nothing).
  let gen = 0;
  let started = 0;
  // The smallest spend bound of a paid call that succeeded in this window: a request of that size is known to be admitted and answered.
  let fitsMicro: number | undefined;
  // Consecutive "busy" refusals in this window: one is a transient collision, a second in a row is treated as the route not working.
  let busyStreak = 0;
  const resetEvidence = () => {
    gen++;
    lastCall = undefined;
    lastFallbackError = undefined;
    fitsMicro = undefined;
    busyStreak = 0;
  };
  // Evidence from a finished paid call that started in window `g` as call number `seq`.
  const record = (g: number, seq: number, ok: boolean, error?: string) => {
    if (g !== gen || (lastCall && lastCall.seq > seq)) return;
    lastCall = { ok, at: iso(now()), seq };
    lastFallbackError = ok ? undefined : error;
    busyStreak = 0;
  };
  // Headroom under every cap right now, from a read-only look at the ledger (undefined when it cannot be read).
  const headroomMicro = (): number | undefined => {
    try {
      const seen = ledger?.inspect();
      return seen?.state === "ok" ? toMicro(seen.view.remainingTodayUsd) : undefined;
    } catch {
      return undefined;
    }
  };
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
    // A new window (no limit in force before): evidence from an earlier window says nothing about the fallback now.
    if (!limit || limit.until <= t) resetEvidence();
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

  const viaFallback = async (cause: ProviderError | undefined, input: Item[], limits: string[], notes: string | undefined, tools: ToolDef[], paidOk = true, rounds?: ToolRounds): Promise<Step> => {
    const l = limit!;
    // The window and start order of this call, taken before anything is awaited.
    const g = gen;
    const seq = ++started;
    const stand = cause ?? new ProviderError(l.kind, `${why(l)}.`, l.estimated ? undefined : iso(l.until));
    // Background callers never spend the paid fallback: they get the limit as it is.
    if (!paidOk) throw stand;
    const problem = refusal();
    if (problem) throw augment(stand, problem, []);
    // Photos (docs/photos.md): the paid fallback is not given images in this build. Photos on the newest user message refuse the turn,
    // so they are never silently dropped; older photos in the history are replaced by a note the model sees and the owner is told.
    const photos = withoutPhotos(input);
    if (photos.current) throw augment(stand, FALLBACK_NO_PHOTOS, []);
    input = photos.items;
    // The fallback is told who it is and why it answers, so attribution stays honest; it gets the same tools as the primary would.
    const told = [
      ...limits,
      `you are the OpenRouter fallback model (${client!.model}), answering because ${why(l)}. Say so if asked which model you are. You have the same ORBIT tools as the primary model in this reply, under the same owner, policy and confirmation checks: a proposal still waits for Rai's confirmation, and a refused call did nothing. You are not given images in this build: you cannot see any photo, so never describe one; if a tool says images were blocked, say so.`,
    ];
    let paid;
    try {
      paid = await client!.step(input, told, notes, tools, rounds);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof SpendError) {
        // "ledger": it could not be read or written. "busy" (another process holds the lock) and the caps refused this one call before
        // anything was charged or sent: nothing is uncertain, so nothing latches.
        if (err.code === "ledger") latch("the spend ledger refused a paid call");
        // Admission refusals that sent nothing and say nothing about the route: shown in the detail, not recorded as evidence. One
        // "busy" is a lock collision; a cap refusal while a request of a size that already succeeded in this window still fits is
        // about this request's size. Everything else (a repeated "busy", a cap refusal with no smaller request known to fit, a
        // ledger fault) is evidence that no reply is known to work.
        const cap = err.code === "daily_cap" || err.code === "monthly_cap" || err.code === "total_cap";
        const room = cap && fitsMicro !== undefined ? headroomMicro() : undefined;
        const notEvidence = g === gen && ((err.code === "busy" && busyStreak === 0) || (cap && fitsMicro !== undefined && room !== undefined && room >= fitsMicro));
        if (notEvidence) {
          lastFallbackError = message;
          if (err.code === "busy") busyStreak++;
        } else record(g, seq, false, message);
        throw augment(stand, err.message, []);
      }
      // A provider, network or timeout failure is evidence the fallback is not answering now.
      record(g, seq, false, message);
      // A failed paid call whose outcome the ledger could not record is as uncertain as a billed answer that could not be recorded.
      const unrecorded = err instanceof ProviderError ? (err.accounting ?? []) : [];
      if (unrecorded.length) latch("the ledger could not record the outcome of a paid call");
      throw augment(stand, err instanceof ProviderError ? err.base : message, unrecorded);
    }
    record(g, seq, true);
    if (g === gen && paid.reservedMicro !== undefined) fitsMicro = Math.min(fitsMicro ?? paid.reservedMicro, paid.reservedMicro);
    // A billed answer whose ledger write failed is returned (never discarded), but the ledger is then not trustworthy.
    if (paid.accounting?.length) latch("the ledger could not record a paid call");
    lastUse = { at: iso(now()), ...(paid.costUsd !== undefined ? { costUsd: paid.costUsd } : {}) };
    const info: FallbackInfo = {
      provider: "openrouter",
      model: paid.model,
      reason: l.kind,
      primaryLimit: { until: iso(l.until), estimated: l.estimated },
      ...(paid.costUsd !== undefined ? { costUsd: paid.costUsd } : {}),
    };
    const incomplete = [...(paid.incomplete ?? []), ...(photos.removed ? [`The OpenRouter fallback answered without seeing ${photos.removed} earlier photo(s): it is not given photos in this build.`] : [])];
    return { text: paid.text, calls: paid.calls, fallback: info, ...(paid.accounting?.length ? { accounting: paid.accounting } : {}), ...(incomplete.length ? { incomplete } : {}) };
  };

  // One model turn: the primary unless its limit is still in force.
  const turn = async (input: Item[], limits: string[], notes: string | undefined, tools: ToolDef[], viaPrimary: () => Promise<Step>, paidOk = true, rounds?: ToolRounds): Promise<Step> => {
    if (active()) return viaFallback(undefined, input, limits, notes, tools, paidOk, rounds);
    const g = gen;
    try {
      const step = await viaPrimary();
      // The pause or reset has passed and the primary answered: only now is it recovered. A primary call that started before the
      // current window began (a limit reported while it was in flight) does not end that window.
      if (limit && g === gen) {
        limit = undefined;
        resetEvidence();
        recoveredAt = iso(now());
      }
      return step;
    } catch (err) {
      if (!isLimit(err)) throw err;
      noteLimit(err);
      return viaFallback(err, input, limits, notes, tools, paidOk, rounds);
    }
  };

  // Tool-using turns never spend the paid fallback unless the caller says so (`fallback: true`); a caller that says nothing, or a
  // background one, gets the limit as it is. reply() is the other way round (see ReplyOptions in model.ts).
  const step = async (input: Item[], limits: string[], notes: string | undefined, tools: ToolDef[], opts?: ReplyOptions): Promise<Step> => {
    if (!primary.step) throw new Error("This model cannot call tools.");
    const pass = { ...(opts?.signal ? { signal: opts.signal } : {}), ...(opts?.rounds ? { rounds: opts.rounds } : {}) };
    return turn(input, limits, notes, tools, () => primary.step!(input, limits, notes, tools, Object.keys(pass).length ? pass : undefined), opts?.fallback === true, opts?.rounds);
  };

  // What status() may say about the paid fallback. READ-ONLY: it looks at the ledger file (never creates, repairs or writes it), at what
  // this process has already seen, and at the clock. It sends no provider request, balance or otherwise, so polling it spends nothing.
  // "armed" is claimed only when the config is complete AND the ledger was read and validated just now. The key, model and prices come
  // from configuration; nothing here has been verified with OpenRouter.
  // `usable` is whether a paid call could be attempted at all (false: config missing, the ledger is known bad, or a spend cap is used
  // up, so the ledger refuses every call until it resets). `off` says why, for the status line, when it is false.
  const paidState = (): { armed: boolean; usable: boolean; text: string; off?: string } => {
    if (config.state === "disabled") return { armed: false, usable: false, text: "" };
    const off = unavailable();
    if (off) return { armed: false, usable: false, off: "No fallback is available", text: ` OpenRouter fallback unavailable: ${off}` };
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
        off: "No fallback is available",
        text: ` OpenRouter fallback NOT armed, no paid call will be made: the spend ledger has not been provisioned${seen.requested ? " (a provision request is waiting and is applied when ORBIT next starts)" : ""}. It is never created by a status check or by a first call; see docs/openrouter-ledger-integrity.md.`,
      };
    }
    if (seen.state === "failed") {
      return { armed: false, usable: false, off: "No fallback is available", text: ` OpenRouter fallback NOT armed, no paid call will be made: ${seen.reason}. The ledger is never reset automatically; fix or restore it by hand.` };
    }
    if (ledgerFault) {
      return { armed: false, usable: false, off: "No fallback is available", text: ` OpenRouter fallback NOT armed, no paid call will be made: ${ledgerFault}. Check the spend ledger, then restart ORBIT; polling this status never clears it, and a restart charges the unrecorded call at its upper bound.` };
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
    // Headroom above zero but below the reservation of the smallest possible request (an empty body) refuses every call too. This is a
    // lower bound: a real request reserves more, and a refusal of a larger one is caught by `lastCall` instead.
    const smallest = config.state === "ready" ? toMicro(reservationUsd(0, config.priceIn, config.priceOut, config.outputBoundTokens)) : 0;
    const headroom = Math.round(v.remainingTodayUsd * 1_000_000);
    const tooLittle = !v.exhausted.length && headroom < smallest;
    const short = tooLittle ? ` Every paid call is refused for now: $${v.remainingTodayUsd.toFixed(4)} is left under the caps, less than the $${toUsd(smallest).toFixed(4)} the smallest possible call reserves.` : "";
    const offWhy = v.exhausted.length
      ? `The OpenRouter fallback's ${v.exhausted.join(" and ")} spend cap${v.exhausted.length > 1 ? "s are" : " is"} used up`
      : tooLittle
        ? `The OpenRouter fallback's remaining allowance is below the smallest possible call's reservation`
        : undefined;
    // A used-up cap refuses every paid call until it resets: armed (configured, ledger sound) but not usable now.
    return { armed: true, usable: !offWhy, ...(offWhy ? { off: offWhy } : {}), text: ` OpenRouter fallback armed: ${client!.model}, used only while ChatGPT is limited.${allowance}${spent}${short}${unverified}${bal}` };
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

    // Photos go to the primary only. While its limit is in force every reply comes from the fallback, which takes none.
    images(): ImageSupport {
      const own = primary.images?.() ?? { ok: false, detail: "the connected model does not take photos" };
      const l = active();
      // The model's own capability stays in the answer (resolution), and the block says it is the fallback's, not the model's.
      if (own.ok && l) return { ok: false, capability: own.capability, ...(own.resolution ? { resolution: own.resolution } : {}), detail: `ORBIT blocked the photos locally, before any request: ${why(l)}; until then replies come from the OpenRouter fallback, which is not given photos in this build (the configured model itself takes photos: ${own.detail})` };
      return own;
    },

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
        const failed = lastCall && !lastCall.ok;
        const callWord: FallbackRoute["lastCall"] = !lastCall ? "none" : lastCall.ok ? "succeeded" : "failed";
        // While the limit is in force:
        //   down, available false: no paid call can be admitted, or the latest one in this window failed. Neither model replies.
        //   degraded, available true: the latest paid call in this window succeeded. Replies come from the fallback.
        //   degraded, available null: usable, but not tried yet in this window. A configured fallback is not evidence.
        // After the limit time and before a primary call succeeds the next call goes to the primary, so the primary's own state
        // decides. Live or degraded: degraded and available as the primary's own "not confirmed" (amber); the fallback still takes
        // over if it is limited again. Down (for example signed out, or every call since the reset failed with a non-limit error,
        // which the fallback never answers) or mock: that state, available false, red. Anything else: that state, not known.
        const primaryUp = base.state === "live" || base.state === "degraded";
        const primaryOff = base.state === "down" || base.state === "mock";
        const answering = !passed && !off && callWord === "succeeded";
        const state = passed ? (primaryUp ? "degraded" : base.state) : off || failed ? "down" : "degraded";
        const usableText = `Replies come from OpenRouter ${client?.model} (fallback, paid; same tools and confirmations as ChatGPT; no photos) until then; ChatGPT is not called.`;
        const text = passed
          ? primaryUp
            ? `The ${why(l)} has passed. ORBIT will try ChatGPT on the next call; it is not confirmed recovered until one succeeds.`
            : `The ${why(l)} has passed, so replies go to ChatGPT again, and ChatGPT is ${base.state}: ${base.detail} The OpenRouter fallback answers only ChatGPT usage or rate limits, so it does not answer for this.`
          : off
            ? `${why(l)}. ${paid.off ?? "No fallback is available"}, so replies fail until then.`
            : failed
              ? `${why(l)}. The latest OpenRouter fallback call (${lastCall!.at}) failed, so no reply is known to work until one succeeds; ChatGPT is not called until then.`
              : callWord === "succeeded"
                ? `${why(l)}. ${usableText}`
                : `${why(l)}. The OpenRouter fallback (${client?.model}) is configured but has not been called since the limit began, so whether it answers is not known. ${usableText}`;
        const availability: ModelAvailability = passed
          ? primaryUp
            ? { available: true, via: "primary", reason: "ChatGPT's limit has passed; it is expected to answer but not confirmed until a call succeeds." }
            : primaryOff
              ? { available: false, via: "none", reason: base.state === "mock" ? "The model is a mock: its answers are not real." : "ChatGPT's limit has passed but ChatGPT is down for another reason, which the OpenRouter fallback does not answer: no reply can come from either model." }
              : { available: null, via: "unknown", reason: "ChatGPT's limit has passed and its own state could not be read, so whether a model can reply is not known." }
          : off
            ? { available: false, via: "none", reason: `ChatGPT is limited and ${(paid.off ?? "no fallback is available").replace(/^The /, "the ")}: no reply can come from either model.` }
            : failed
              ? { available: false, via: "none", reason: "ChatGPT is limited and the latest OpenRouter fallback call failed: no reply is known to work from either model." }
              : callWord === "succeeded"
                ? { available: true, via: "fallback", reason: "ChatGPT is limited; the OpenRouter fallback answered the latest call." }
                : { available: null, via: "unknown", reason: "ChatGPT is limited and the OpenRouter fallback has not been tried since, so whether it answers is not known." };
        const route: FallbackRoute | undefined = client ? { provider: "openrouter", model: client.model, answering, reason: l.kind, until: iso(l.until), estimated: l.estimated, lastCall: callWord } : undefined;
        return { ...base, state, detail: `${text}${armed}${lastFallbackError ? ` Last fallback error: ${lastFallbackError}` : ""}`, ...(route ? { fallback: route } : {}), availability };
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
