# The Assistant: how it works (diagrams)

This page shows how the Assistant works as implemented, in two diagrams: how the page and the server stay in sync (including across restarts), and how the rolling conversation is stored and turned into model context. The full reference (budgets, routes, crash behaviour, tests) is `docs/assistant.md`. Both diagrams come from the code at the commit that added this page, and name the source files they rely on.

Source files:

- `src/assistant-store.ts`: the chunk store, rotation, the archive, crash recovery, and the restart-safe revision (`REV_STRIDE`, `epoch.json`).
- `src/assistant-context.ts`: the context bound (`boundChunk`, `planContext`) and the budgets.
- `src/server.ts`: the routes (`/assistant`, `/assistant/history`, `/assistant/messages`), `assistantView()`, `prepare()` (vault excerpts, devices, tools), and the wiring of the Assistant's `threadService`.
- `src/thread-service.ts`: the shared turn code (model rounds, tools, proposal cards, deadlines). The Assistant uses it with `compact: false` and no rolling recent-work note.
- `src/web/index.html`: the Assistant section of the page (`aload`, `asend`, `drawAssistant`, the 10-second poller) and the `<assistant-order>` block (`aNewer`), which decides whether an answer may replace what is drawn.

## 1. Page and server: loading, sending, polling, restarts

### Endpoints

All are owner only (403 for anyone else, before anything is read or changed). POSTs are also subject to the existing cross-site refusal.

| Endpoint | Used by the page | Returns |
|---|---|---|
| `GET /assistant` | on load, every 10 s while the Assistant is showing and the page is visible (`makePoller`), after an unanswered send, after a card is confirmed or cancelled | `{ assistant: view }` |
| `POST /assistant/messages {text, requestId}` | Send | `{ assistant: view }` after the turn (200, or 502 if the model failed); 409 with the view if busy or a repeat of a send already started |
| `GET /assistant/history?before=<seq>&limit=<1-20>` | "Load earlier messages" (10 at a time) | `{ chunks, more }`: archived chunks only, never put in the model's context |

The view (`assistantView()` in `src/server.ts`) contains `session` (always `id: "assistant"`), `busy`, `rev`, `epoch`, the active `chunks`, `archivedChunks`, `next` (what the next turn would be sent), `budgets`, `persisted` and `problems`.

### Revisions across restarts

The page draws an answer only if `aNewer(shown, incoming)` holds, that is, if the answer's `rev` is not below the `rev` it shows. So a slow poll, a poll overtaken by a send's answer, or a late answer never rolls the conversation back. `aload` also drops a poll answer if a later poll's answer has already been drawn (`aloadSeq`/`ashownSeq`). Before this fix, `rev` was a counter in memory that started at 1 in every process. After a restart or deploy, an open tab holding, say, `rev` 400 ignored every answer from the new process until that process had made 400 changes. The tab looked frozen and only a reload fixed it.

Now `rev = epoch × 2^20 + n` (`src/assistant-store.ts`):

- `n` counts changes in this process, starting at 1. Every stored change adds one: a new turn, a reply or tool call, a card state change, a rotation.
- `epoch` is raised every time the store is opened (each process start), to `max(stored epoch + 1, wall clock in whole seconds)`. It is written to `<state>/assistant/epoch.json` before the process serves any revision from it. If more than 2^20 changes happen in one process, the epoch is raised again.

So every revision from a later process is above every revision from an earlier one. A delayed answer from a process that has since stopped still compares lower and is ignored. The comparison is the same `>=` the page already used, so:

- **Tabs that were already open at the deploy** (still running the PR #83 page code, `rev < aview.rev` means ignore) resume on their next poll with no reload and no send, because the new process's first `rev` (about 1.9 × 10^15) is far above any plain counter the old process reached. `test/assistant-restart.test.ts` checks this against the old rule.
- **Tabs with the new page** use `aNewer`, the same order, and also apply it to the answer of their own send, so a late send answer can never roll back a newer poll.
- **Stored data is not touched.** No chunk, the session identity or the archive is rewritten, reset or deleted. `epoch.json` holds only a number. A missing `epoch.json` (a store written before this change) is normal. An unreadable one is reported in `problems` and replaced by a new epoch taken from the clock.

```mermaid
sequenceDiagram
    autonumber
    participant A as Tab A (index.html)
    participant B as Tab B / other device
    participant S as Server (server.ts, owner auth)
    participant T as Turn service (thread-service.ts) + tools + model
    participant D as Store (assistant-store.ts, STATE/assistant)

    Note over S,D: Process start: assistantStore() loads session.json and active/ chunks, closes any open chunk (pending reply becomes interrupted, nothing re-run), raises epoch in epoch.json, rotates
    A->>S: GET /assistant
    S->>D: active chunks, rev, epoch
    S-->>A: view (rev = epoch x 2^20 + n)
    A->>A: aNewer(null, view): draw

    A->>S: POST /assistant/messages {text, requestId}
    S->>S: owner check, 409 if busy or requestId already seen
    S->>D: appendUser: new chunk active/SEQ.json written (state open) before any model call
    S->>T: turn(assistant, text, vault excerpts, tools)
    T->>D: plan(): bounded context from complete active chunks
    T->>T: model rounds, tool calls under policy, proposals become cards (never run without Confirm)
    T->>D: addCall / patchMessage / addCard: each change written (atomic), n += 1
    B->>S: GET /assistant (poll during the turn)
    S-->>B: view busy=true (Send paused on B)
    T->>D: end(): chunk complete, rotate() (older chunks renamed to archive/)
    S-->>A: 200 view (rev r2)
    A->>A: aNewer(shown, view): draw (a poll answered earlier, with a lower rev, is ignored if it arrives later)
    B->>S: GET /assistant (next 10 s poll)
    S-->>B: view rev r2 or later: B shows A's turn
```

```mermaid
sequenceDiagram
    autonumber
    participant A as Open tab (shows rev R1 from epoch E1)
    participant S1 as Old process (epoch E1)
    participant S2 as New process (epoch E2, above E1)
    participant D as Store (STATE/assistant)
    participant P as Other device

    A->>S1: GET /assistant
    Note over S1: process stops (restart / deploy) before or after answering
    S2->>D: assistantStore(): read epoch.json (E1), write E2 = max(E1+1, clock seconds)
    S2->>D: load chunks, interrupt an open turn (shown as interrupted, not retried), rotate
    A->>S2: GET /assistant (next poll, same URL)
    S2-->>A: view rev E2 x 2^20 + n, always above R1
    A->>A: accepted at once, without reload or sending
    S1--)A: late answer from the old process (rev from E1)
    A->>A: rev below what is shown: ignored, no roll-back
    P->>S2: POST /assistant/messages
    S2->>D: new chunk, reply, rev rises within E2
    A->>S2: GET /assistant (poll)
    S2-->>A: higher rev: the other device's turn is shown
    Note over A,S2: Repeated restarts: E3 above E2 above E1, so the same holds every time
```

What this does not do (unchanged from PR #83):

- An unanswered send is never resent. The page says "ORBIT did not answer. Your message may or may not have been received" and reloads. A send cut off by the restart is either stored (and shown as interrupted after the restart) or was never received. `requestId` lets the server refuse a browser's silent repeat of a send that started a turn.
- A turn in progress at a restart is not resumed or re-run. Its reply is marked `interrupted`.
- Approval controls do not change. Proposal cards are confirmed only through `POST /chat/proposals/:id/confirm`, single use. A card whose proposal was lost in the restart shows `expired`.

## 2. The rolling memory: storage, context, archive

```mermaid
flowchart TD
    subgraph DISK["STATE_DIRECTORY/assistant/ (0700 dirs, 0600 files, memory only without STATE_DIRECTORY)"]
        SES["session.json<br/>identity id=assistant, written once"]
        EP["epoch.json<br/>revision epoch, raised each start"]
        ACT["active/SEQ.json<br/>one chunk per turn"]
        ARC["archive/SEQ.json<br/>kept, never deleted"]
    end

    SEND["POST /assistant/messages"] --> BUSY{"busy, or requestId<br/>already seen?"}
    BUSY -- yes --> R409["409: nothing stored, nothing queued"]
    BUSY -- no --> NEW["appendUser: chunk seq N, state open,<br/>user text masked, capped at 20,000 chars,<br/>written atomically (temp, fsync, rename)"]
    NEW --> ACT
    NEW --> PLAN["plan(): complete active chunks only<br/>(the open chunk is never history)"]
    PLAN --> WALK["planContext: newest first, each chunk in its bounded form,<br/>stop at the first that does not fit<br/>budget 52,000 chars = history + new message"]
    WALK --> BOUND{"boundChunk:<br/>chunk over 12,000 chars?"}
    BOUND -- no --> FULL["full"]
    BOUND -- yes --> CLIP["clipped: outputs to 1,500, texts to 4,000"]
    CLIP -- "still over" --> OMIT["calls-omitted: tool call+result pairs removed together,<br/>replaced by a note (a call is never sent without its result)"]
    OMIT -- "still over" --> PH["placeholder: one note for the turn"]
    FULL --> CTX
    CLIP --> CTX
    OMIT --> CTX
    PH --> CTX
    CTX["Model input: contiguous newest run + new message<br/>+ bounded notes (vault excerpts, devices: max 12,000)<br/>+ up to 20 proposal-card lines. Recorded on the chunk as context"]
    CTX --> TURN["turn: model rounds and tools (shared runChat limits),<br/>each call, card and the reply written to chunk N"]
    TURN --> END["end(): chunk complete, a reply still pending becomes interrupted"]
    END --> ROT{"rotate(): keep newest complete chunks whose<br/>bounded sizes fit 32,000 chars"}
    ROT -- "older chunk, complete, no confirmable card" --> MV["rename active/ to archive/ (one rename each), fsync both dirs"]
    MV --> ARC
    ROT -- "open chunk, or a card that can still be confirmed" --> STOP["stop: that chunk and later stay active until decided or expired"]

    ARC --> HIST["GET /assistant/history?before=&limit=1..20<br/>reads only that page of files"]
    HIST --> UI["Visible transcript on the page:<br/>active chunks + archived pages loaded on request,<br/>archived/over-budget turns dimmed as not sent"]
    ACT --> UI
    ARC -. "never sent to the model automatically" .-> NOAUTO["Archive: not model input<br/>(no summary, no retrieval)"]

    START["Process start"] --> REC["load chunks, pending reply becomes interrupted, open becomes complete,<br/>unreadable file reported in problems, left as is, seq never reused,<br/>a chunk in both dirs: archived copy used"]
    REC --> EP
    REC --> ROT

    subgraph OTHER["Not the Assistant's conversation store"]
        CHAT["Chat session memory: STATE_DIRECTORY/threads/UUID.json,<br/>compaction summary at 48,000 chars, rolling recent-work note.<br/>Not read or written by the Assistant"]
        VAULT["Long-term vault memory: memory.search excerpts per message<br/>(read, 2,000 chars per note, bounded to 12,000).<br/>Vault writes only through the vault tools and their policy,<br/>the chunk store never writes to the vault"]
    end
    VAULT -. "excerpts" .-> CTX
```

How to read it, using what the code does:

- **Visible transcript, bounded model context, chat session memory and vault memory are four separate things.** The page shows every active chunk and any archived pages the reader loads. The model is sent only the newest complete active chunks that fit, each in its bounded form, plus the new message (`planContext`, at most 52,000 characters of conversation). Chat threads (`<state>/threads/`, with compaction and the recent-work note) are a separate store. The Assistant neither reads nor refreshes them. The vault is searched for each message, the same way chat does it (`prepare()`), and its excerpts arrive as bounded reference notes. Nothing from the archive is ever added to the model input automatically. There is no summarization of the archive and no retrieval from it.
- **Durable writes.** Every chunk change is a synchronous read, modify and write of a copy, written atomically before it replaces the copy in memory. Archiving is one `rename` per chunk, so a chunk is always in exactly one directory, even after a crash in the middle of a rotation.
- **What blocks rotation.** Rotation stops at an open chunk (a turn in progress) and at a chunk with a proposal card that can still be confirmed (the proposal is present and has not expired). Meanwhile the active window can exceed 32,000 characters, but the 52,000 prompt bound still holds, because `planContext` leaves out what does not fit.
- **Recovery.** At start the store closes an open chunk (its pending reply becomes `interrupted`, and nothing is re-run). It reports unreadable files without touching them, never reuses their sequence numbers, raises the revision epoch and then rotates.

## Manual two-tab restart acceptance (not performed by the job that wrote this)

On a deployed ORBIT, as the owner, with the Assistant tab showing (the poller runs only while the tab is visible):

1. Open `/` in two browser tabs (or a tab and a phone) and send a few messages from tab 1 so both show them.
2. Restart ORBIT (`systemctl restart` or a deploy). Do not reload either tab, and do not send.
3. From a third device (or after the restart, from tab 2), send "after restart 1".
4. Within about 10 seconds, both untouched tabs show "after restart 1". Check that nothing above it disappeared or was duplicated.
5. Repeat steps 2 to 4 at least twice more ("after restart 2", "after restart 3").
6. Restart while a reply is in progress: after the restart, every tab shows that reply as interrupted, Send works again, and the message was not answered twice.
7. Check `<state>/assistant/epoch.json` exists and its `epoch` grew with each restart. Check `session.json` is unchanged and no chunk file was removed.
8. Open `/#chat`: threads behave as before.

## Limits

- Ordering between processes relies on the persisted epoch (or, without a state directory, on the wall clock). If `epoch.json` is lost and the clock is also set back, a new process can start below an old one. The page then ignores the new process until a reload. Without a state directory the conversation itself is lost at a restart anyway.
- The page ignores a lower revision for good. If an operator restores `<state>/assistant/` from a backup together with an older `epoch.json`, open tabs need a reload. Restoring a backup is not something ORBIT does.
- Two processes on one state directory at once are still not supported.
