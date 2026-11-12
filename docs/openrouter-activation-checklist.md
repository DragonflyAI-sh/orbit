# OpenRouter fallback: activation checklist

Status: **not activated, not production-ready.** Everything below was tested only with fakes. Model choice and activation are Rai's decisions.
Approved parameters: ChatGPT primary, fallback only on typed usage/rate limits, $5/day (UTC), $150 total.

## Fixed in PR59 (each has a regression test in `test/openrouter-fallback.test.ts`)
- Mock replies were relabelled "live" when the fallback wrapper was on: the primary's own result now passes through untouched.
- Non-tool fallback replies now carry the labelled "(FALLBACK, paid: ...)" source.
- Background callers (thread compaction, rolling note, scheduled runs) pass `{ fallback: false }`: while ChatGPT is limited they fail with the limit and never spend OpenRouter.
- Caps above 10,000 USD make the fallback `unavailable` with a reason; a ledger that cannot be built no longer crashes startup (`main.ts` reports it as unavailable).
- A failing ledger write on an error path no longer hides the provider error, leaks a file path, or discards a billed answer (it is returned with an accounting note).
- A non-JSON `/key` body is reported without echoing it.

## Fixed in the follow-up change (regression tests at the end of `test/openrouter-fallback.test.ts`; 9 of them fail on the previous main)
- **Tool-using turns are opt-in for the paid fallback.** `step()` never spends OpenRouter unless called with `{ fallback: true }`; `runChat` passes it only when its caller sets `fallback: true`. Callers audited (`grep runChat|\.step(` over `src/`): only `server.ts` `/chat` and `thread-service.ts` (interactive owner chat) call `runChat`, and both opt in. Any new caller gets the limit as it is. `reply()` keeps its opt-out (`fallback: false`) and the three background callers still use it. Tests count requests on a fake provider: zero for default, `{}`, `false` and background paths.
- **Accounting diagnostics are structured data**: `Step.accounting` / `Reply.accounting` / `ProviderError.accounting` (string list). No parenthesis stripping or text concatenation. They are never added to model text or to any model request. Owner sees them on `/chat` (`reply.accounting`), on the stored thread message (`accounting`, masked, capped) and rendered in the page; a failed later round keeps earlier diagnostics in the error text.
- **A billed tool-call-only reply with empty text keeps its calls and reports a failed ledger settle**, as does a billed reply that is then refused (no text, over the call limit, cut off mid tool call).
- Provider error plus ledger error: both reported, no path or key in the text.
- Unchanged: confirmation gates for tools, `FALLBACK_TOOLS` allowlist, no new fallback permissions, disabled by default.

## Still open (not changed by this work; reconciled against current code, none marked complete)
Definitions are from `docs/reviews/openrouter-fallback-audit.md` (backlog IDs B6-B14); the audit's F/N findings map as shown.
- B6 key-side credit limit and documentation of cost components outside `max_price` (F4/N4). **Open, owner step**: the only hard cap is a key credit limit set in the dashboard. A single reported cost of any size is recorded in full; the cap can be exceeded by one call.
- B7 single-writer lock (F5). **Open.** Two processes sharing the ledger can corrupt it (fails closed, denial not bypass).
- B8 ledger anchoring (N5). **Open.** Deleting the ledger file resets spend to $0 until a key-side limit stops it.
- B9 disallowed-tool behaviour (N3) and `job_launch` card text. **Open.** A disallowed tool call fails the turn and the paid call is still charged.
- B10 price rehearsal. **Open**, blocked on verified public prices.
- B11 byte-counted streamed reading (F3). **Open, low.** Body is read fully before the size check.
- B12 side-effect-free `status()` (F6a) and "armed" shown while the ledger failed (N7). **Open.**
- B14 truncated-reply marker. **Open.**
Restart durability, concurrency inside one process, caps and UTC rollover have passing tests (fakes only).

## Public model and pricing findings (UNVERIFIED)
- openrouter.ai was **not reachable** from this session, rechecked 2026-11-12 (curl: proxy 403 to CONNECT for /api/v1/models and the docs; WebFetch: ENOTFOUND). Status: **BLOCKED**, nothing was inferred. Official docs, `/api/v1/models` and `provider.max_price`/`usage.cost` semantics were **not verified**. openrouter.ai must be allowed in the session network settings.
- Secondary evidence only (web search, 2026-11-12), conflicting across mirrors:
  - Candidate: `deepseek/deepseek-v4-flash` family, tool calling listed (`tools`, `tool_choice`). Snapshot pages: `deepseek-v4-flash-20260423` (about $0.0679 in / $0.168 out per M tokens), `deepseek-v4-flash-20260731` (OpenRouter page reportedly $0.04 / $0.08; a third-party calculator lists $0.64 out). A distinct `deepseek-v4.1-flash` lists $0.30 / $1.20. Sources: https://openrouter.ai/models/deepseek/deepseek-v4-flash-20260423 , https://openrouter.ai/deepseek/deepseek-v4-flash-20260731 , https://openrouter.ai/models/deepseek/deepseek-v4.1-flash
  - Output prices differ about 8x between sources: **do not set prices from this list.** Rai must read the exact pinned slug's page, confirm `tools` in supported_parameters, and set `ORBIT_OPENROUTER_PRICE_*` from it (use a dated slug, not a "latest" alias).

## Gates before any paid use (all required)
1. **Two independent security reviews** of the fallback, ledger and tool allowlist: **not done**; this change has had none, and PR review plus mocks are not a substitute.
2. Owner configuration: pinned model id, verified prices, `ORBIT_OPENROUTER_ENABLED=1`; credential `orbit.openrouter` installed by Rai (typed into SSH, not via `!`). Agents never read it.
3. OpenRouter key credit limit at or below $150 set and verified in the dashboard (the only hard cap); account funded minimally.
4. Rai approves tool scope (incl. `job_launch`) and the data flow (conversation, memory, tool results leave the host).
5. Deployment by Rai's normal process (not done here); confirm `/status` shows "armed" with the right model and a sane ledger.
6. Smoke checks against a fake provider on the real host layout: forced limit is served and labelled; a background call during a limit does not spend; cap refusal message; startup with an oversized cap still boots.
7. Rollback drill: `ORBIT_OPENROUTER_ENABLED=0` + restart returns the untouched primary; confirm ledger file preserved.
8. Break-glass: how to disable fast (unset flag, remove credential, revoke key in dashboard), who does it, and how to repair a corrupt ledger (never reset automatically).
9. Single ORBIT process owns the state directory (no second writer).
