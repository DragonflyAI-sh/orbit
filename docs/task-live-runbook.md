# Supervised tasks: live acceptance and activation runbook (Repair 4)

For a person to run later on a test host. **Nothing in this document was run on a host by the change that wrote it**; everything it
describes was tested only in simulation (docs/adr/0003-supervised-tasks.md, "Repair 4", acceptance matrix). Do not run it on the
production ORBIT without Rai's go-ahead. It makes no vault write except to the throwaway note named below, and launches only jobs Rai
confirms on their cards.

## Preconditions

- An ORBIT built from the change under test, deployed to a **test** host, Rai signed in as the owner.
- A model port that can call tools (`ORBIT_MODEL` set; check `/status`).
- `ORBIT_TASK_FOLLOWUPS` and `ORBIT_SUPERVISOR_WAKE` **unset** at first (both features off). They are set only in steps 6 and 7, on the
  test host only, and unset again in step 12.
- A throwaway vault note `Tasks/orbit-acceptance.md` containing a `## Status` heading and one line written by Rai.
- A build routine (fake or a sandbox repository) and, for step 5, a configured research lane (docs/research-lane.md). Without the lane,
  step 5 checks only that a research request can be declined and that no build is substituted.
- Record for every step: what the page showed, what the Assistant said, and the `GET /tasks/<id>` excerpt. Any mismatch is a defect.

## Steps

1. **Create and link.** Ask the Assistant to create two synthetic tasks (A and B) in one project. Open both session links. Sessions lists
   both; neither shows "needs attention".
2. **Steer.** Write an instruction in A's session; ask the Assistant to relay another. Ask "what's new on my tasks?": it quotes your
   instruction as yours and says whether the task has seen it.
3. **Concurrency and dependency.** Make B depend on A. Start a turn on A and, while it runs, one on B: if `taskTurnsMax` is 1, B is refused
   (429), nothing queued. A reverse dependency is refused as a cycle.
4. **Blocker and delivery.** Get A to file a blocker. The Sessions tab shows "(1)", A's row says "1 needs attention (1 new)", the Assistant
   page strip lists A with a link. Send the Assistant a message: after its reply, the strip no longer says "not yet given to the
   Assistant", but A still needs attention (delivered is not answered). Have the Assistant answer: the badge clears.
   - Delivery on failure (optional): stop the model port (or make it time out) and send a message; after the error the item still says
     "not yet given". Restore the port and send again: delivered.
5. **Build and research lifecycles.** Get B to request a build job: the Assistant proposes it (`job_launch`), links it; the card waits.
   Cancel the card: the request shows not-confirmed. Re-propose, link, Confirm: running, then result. With the research lane, get A to
   request research: the Assistant proposes with `research_launch` (a build proposal is refused if tried), you confirm, it runs on the
   research routine. In both cases the task stays active and any evidence the task adds is "claimed".
6. **Automatic follow-up (test host only).** Set `ORBIT_TASK_FOLLOWUPS=on`, restart. Opt A in with perDay 1, set a follow-up a minute
   ahead: one automatic turn starts. Set another: `budget-task` and a budget attention item. Keep every turn slot busy for 30 minutes with
   a due follow-up: a `capacity-wait` attention item appears, attempts stay 0, and the turn starts when a slot frees.
7. **Supervisor wake (test host only).** Set `ORBIT_SUPERVISOR_WAKE=on`, restart. The Assistant page strip shows "Supervisor wake: off".
   Click "Allow supervisor wake". Make a task file a request and wait (up to a minute): one Assistant turn appears, authored "ORBIT
   supervisor wake", with a summary for you; it answered or proposed nothing it was not allowed to, and any card waits for your Confirm.
   Send a message while a wake turn runs: refused (409); send again after. Pause it from the strip: no further wakes. Check the budget
   line counts the wake.
8. **Pause and resume.** Pause A during a running turn: the turn ends with an error and an attention item; acknowledging it resolves it.
9. **Restart and interruption.** Restart ORBIT during a running task turn (and, if step 7 ran, during a wake turn): the task turn shows
   `interrupted` with an attention item, the wake shows `interrupted` in `GET /tasks/wake`; nothing re-runs by itself; what the wake was
   shown is still "not yet given".
10. **Vault sync and recovery.** Link A to `Tasks/orbit-acceptance.md` / `## Status` and sync: `current`, one line appended, Rai's line
    untouched. Change A's next action: `stale`. Sync again: one more line. (The `unconfirmed` recovery path needs a write failure after the
    push; it is covered by tests and is not provoked on a host.)
11. **Cancellation.** With one of B's jobs running and another card open, cancel B: the answer lists the open card as `card-withdrawn` and
    the running job as `continuing` ("NOT stopped: ORBIT cannot cancel a cloud job"). The job keeps running in the Jobs page until it ends
    by itself.
12. **Completion and switch-off.** Attest A's criteria yourself and mark it done (refused before you attest). Unset
    `ORBIT_TASK_FOLLOWUPS` and `ORBIT_SUPERVISOR_WAKE`, restart: the strip shows no wake control; opted-in tasks show `scheduler-off`.

## Activation (after the steps pass; each is a separate decision by Rai)

| Feature | Default | To activate | To stop |
|---|---|---|---|
| Automatic follow-up | off (two levels) | `ORBIT_TASK_FOLLOWUPS=on` in the service environment, then Rai opts each task in | unset and restart; or turn a task's follow-up off; or pause the task |
| Supervisor wake | off (two levels) | `ORBIT_SUPERVISOR_WAKE=on`, then Rai clicks "Allow supervisor wake" (perDay 1-12, default 4) | "Pause" or "Stop supervisor wake" on the Assistant page; or unset and restart |
| Task-turn routing | none configured | a reviewed code/deploy change setting `taskModels`, after the evaluation in docs/task-model-routing.md | remove the table |
| Vault sync | manual, only where the vault clone exists | unchanged | unlink the note |

No new credential, provider or paid feature is introduced by any of these.
