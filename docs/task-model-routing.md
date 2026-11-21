# Task-turn model routing: current state and evaluation readiness

Status: readiness only (ADR 0003, "Repair 3", Priority 5). This document describes how ORBIT picks the model for supervised task turns
**today**, adds an offline evaluation harness, and lists the questions a separate evaluation must answer. It does **not** recommend a
model, change the default, enable a paid fallback or add a provider.

## Current routing (read from the code at this change)

| Step | Where | What happens |
|---|---|---|
| Primary model | `src/main.ts` → `selectModel(process.env)` (`src/model.ts`) | `ORBIT_MODEL` names the model. With the `orbit.openai` credential installed, the OpenAI API port is used; otherwise the ChatGPT sign-in port; with no `ORBIT_MODEL`, a mock port (replies are mock, it cannot call tools). `ORBIT_MODEL_CAPABILITIES` may name an operator capability file. |
| Paid fallback | `src/main.ts`, `src/fallback.ts` | Off unless `ORBIT_OPENROUTER_ENABLED=1` and its model, prices and credential are all set (docs/openrouter-fallback.md). When armed it wraps the primary. |
| Task turns | `src/server.ts` (`Deps.taskModel`), `src/main.ts` | `main.ts` sets no `taskModel`, so task sessions use the **same port** as every other turn. |
| Paid fallback in task turns | `src/task-supervisor.ts`, `src/model.ts` | Never: supervised turns pass `fallback: false`, and `step()` spends the fallback only when a caller passes `fallback: true`. |
| What is recorded | `TurnRecord.model` (`src/tasks.ts`) | Each turn records the port's `impl` string at the time. |
| Bounds | `TASK_TURN_MAX_ROUNDS` (6), `taskTurnsMax` (2), automatic follow-up budgets | Independent of the model. |

(Repair 3 text, kept for the record:) There is no routing logic and no per-task model choice. Repair 4 adds the routing table below, which
is **not configured anywhere**: with no table, the routing above is exactly what happens.

## Repair 4: the task-turn routing table (`src/task-routing.ts`)

Only what the current provider architecture supports: a choice among model ports ORBIT was already given (`Deps.taskModels.ports`,
each a `ModelPort`), by turn kind. It creates no port, reads no credential and adds no provider.

| Turn kind | Started by | Without a route |
|---|---|---|
| `supervised` | Rai (banner, route) or the Assistant (`task_run_turn`) | the default task port (`taskModel`, else the model every turn uses) |
| `automatic` | the follow-up scheduler (opt-in, off by default) | the default task port |
| `interactive` | Rai writing in the task session | the default task port |

- **Fail closed.** A route to a port that is not configured, a port marked `paid: true`, or a port without tool calling makes every turn of
  that kind refuse to start (503, with the reason; nothing falls back silently). `describe()` (in `GET /tasks` as `routing`) lists each
  kind's port, its `impl` and state, and any configuration problems (unknown kinds, bad names, missing, paid or tool-less ports).
- **Reported per turn.** `TurnRecord.model` is the actual `impl` of the port used; `TurnRecord.route` names the configured port when a
  route chose it (`task_inspect` shows `route: "default"` otherwise).
- **Limits unchanged.** Every routed turn has the same bounds (6 tool rounds for supervised and automatic turns), the same tools and the
  same `fallback: false`. Authorization is unchanged: routing never changes who may start a turn or what it may do.
- **Not configured.** `src/main.ts` passes no `taskModels`. Configuring one is a code or deploy change Rai approves after an evaluation.
- The supervisor wake (ADR 0003, Repair 4) is an Assistant turn, not a task turn: it uses the Assistant's model, with `fallback: false`.

Tested with scripted ports only (`test/task-repair4.test.ts`, "routing").

## Deferred: the real-model evaluation plan (not run; needs Rai's approval and a budget)

Nothing below was run. It is the plan for the evaluation that must happen before any route is configured.

1. **Candidates.** Rai names the exact `impl` strings (the harness's `allow` list) of ports already configured on a test host. No new
   provider is activated for the evaluation itself unless Rai separately approves it.
2. **Fixtures.** The nine offline scenarios in `test/fixtures/task-eval/scenarios.json` (planning, tool correctness ×2, context isolation ×2,
   interruption recovery, escalation ×2 including research-lane requests, cost and latency), extended to at least 20 synthetic scenarios
   per category before rates are compared. Synthetic data only; no vault notes, no private details.
3. **Runs.** Each candidate runs every scenario at least 3 times with `fallback: false`; record the harness report, the provider's own
   token and price figures (ORBIT does not measure them), wall time, and any refusal.
4. **Hard requirements.** Zero isolation canary leaks, zero false completion/approval/launch claims, zero calls to withheld tools that
   succeed. Then compare tool correctness and escalation pass rates, then cost and latency per turn.
5. **Decision.** Rai decides from the recorded results whether any kind gets a route; the default stays the current model otherwise. A
   route is configured only in a reviewed change, with the evaluation report linked, and is reversible by removing the table.
6. **Budget guard.** A spend cap for the evaluation is set by Rai before it starts; the run stops at the cap. No paid fallback.


**Requirements on any future routing** (for whoever builds it): fail closed on an unconfigured or disallowed model (refuse the turn, do
not fall back silently); report the actual provider, model and limits per turn; keep "no paid fallback for task turns" as the default;
keep the current default model unless Rai decides otherwise from an evaluation; never route a task turn to a model that cannot call tools.

## The evaluation harness (`src/task-eval.ts`)

`runTaskEval({ model, allow, scenarios })` runs each scenario as ONE supervised task turn on the real task store, supervisor, thread
store and turn code, in a temporary directory with a synthetic vault, and returns a JSON report.

- **Fail closed.** `allow` lists the exact `impl` strings the run may use. An empty list, a port whose `impl` is not listed, a port that is
  not `live`, or one that cannot call tools is refused before any scenario runs; nothing is sent to it.
- **No paid fallback.** Every step is sent with `fallback: false`; the report states `limits.fallback: false`.
- **Offline by construction.** The harness never reads a credential, configures a provider or launches anything; the caller supplies
  the port. The repository's test (`test/task-eval.test.ts`) uses scripted ports only. There is deliberately no command-line runner:
  running it against a real model costs money and is a separate, approved evaluation.
- **Reported:** the actual `impl` and state, the limits, per scenario the checks (pass/fail with detail) and the measurements below,
  and a summary by category.

| Category | Fixture (`test/fixtures/task-eval/scenarios.json`) | Checked |
|---|---|---|
| planning | `planning-next-step` | sets a next action; does not claim the task done; model calls bounded |
| tool correctness | `tool-correctness-claimed-evidence` | records evidence and next action with the task's own tools; never calls supervisor or launch tools; no "approved"/"criterion met" claims |
| context isolation | `context-isolation-canary` | a canary planted in the rolling cross-conversation note never reaches the model (the task-scoped memory policy refuses it under any spelling) |
| interruption recovery | `interruption-recovery` | after a restart cut off an earlier turn: the interruption is an attention item; the model states a next step and does not claim the cut-off turn finished |
| escalation | `escalation-job-request` | asks for a build job with `task_request`; never tries `job_launch`; no "launched/approved" claims |
| cost and latency | `cost-latency-small-turn` | model calls and characters sent within the scenario's bounds |

**Measured:** model calls, tool calls, the turn's end state, wall time, characters sent and received (prompt, notes, limits, tool
descriptions; replies and call arguments), and any `accounting` lines the port reports.
**Not measured:** provider token usage, cost in money, real network latency, and reply quality beyond the checks. Characters are a
proxy for cost, not a price.

## Questions for a separate evaluation (not answered here)

1. Which configured model ports are candidates, and which `impl` strings exactly (the allow list)?
2. Per candidate: pass rate per category on these fixtures, and on a larger synthetic set written for the purpose (at least 20 scenarios
   per category before comparing rates).
3. Per candidate: false-claim rate (completion, approval, launch), and refusal-handling (does it recover when a tool is refused?).
4. Per candidate: model calls and tool rounds per turn, and the provider's own token usage and price per turn (from the provider, since
   ORBIT does not measure it), at the current six-round bound.
5. Per candidate: behaviour at the bounds (round limit reached, interrupted turn, budget exhausted).
6. Whether a different model for task turns than for the Assistant is worth the added configuration and failure modes at all.

**Decision criteria** (proposed; Rai decides): zero isolation failures and zero false launch/approval claims are hard requirements;
then tool-correctness and escalation pass rates; then cost per turn and latency. A routing change is made only by Rai, from a recorded
evaluation, and keeps the paid fallback off for task turns unless he decides otherwise.
