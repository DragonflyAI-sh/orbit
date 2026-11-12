# OpenRouter spend ledger: multiprocess protection (B7) and loss handling (B8)

Status: **implemented and tested with fakes and temporary directories only. Not activated. Not a security review, not production verification.** Nothing here was run against a live ledger, a real key or the network. The ledger is still ORBIT's *own* count, never a provider-enforced hard ceiling (see "What this does not solve").

Code: `src/spend-ledger.ts`. Tests: `test/spend-ledger-multiprocess.test.ts` (real competing child processes, `test/helpers/ledger-worker.ts`), `test/spend-ledger-provisioning.test.ts`, plus the updated `test/openrouter-*.test.ts`.

## B7: who may write the ledger, and how

### The unit of protection: one critical section per ledger step
Admit and reserve, settle, release, orphan recovery and startup open are each **one critical section**: take the lock, read the file, check it, change it, write it, release the lock. Nothing slow runs inside a section. The provider call happens *between* two sections and is covered by the persisted reservation, not by the lock, so a lock is held for milliseconds. Two processes can therefore never both read the same state and both write: lost updates, double admission near a cap and torn files are impossible while the lock works.

### The lock
- **What it is.** `<state>/openrouter-spend.lock`, created atomically by `link(2)` of a fully written, fsynced private file, so the lock never exists half-written. Its content is the owner: pid, host name, boot id, pid namespace, process start time and a random token.
- **Who owns it.** The process that created it, identified by that content. It is released by deleting it, only after re-reading it and confirming the token is still its own. Before every rename of the ledger file the writer re-checks that it still holds the lock; if the lock was taken over, it writes nothing, throws, and that ledger instance stays out of service until ORBIT restarts (test "lost-update prevention").
- **Waiting.** A caller that finds the lock taken polls (2 ms growing to 40 ms) for at most `lockWaitMs` (3 s). Then the call is **refused** (`SpendError "busy"`): nothing is reserved, nothing is charged, nothing is sent, and the fallback does not latch a fault for it. The wait is synchronous (`Atomics.wait`), which blocks ORBIT's event loop for at most that long while a competitor holds the lock.
- **A timeout never takes the lock.** Test "a lock held by a LIVE process is never taken".

### Stale-lock policy
A lock is removed by another process **only if its owner is proven dead**. "Proven" means all of: same host name, same boot id (or a *different* boot id, which proves the owner's whole boot is gone), same pid namespace, and either the pid no longer exists, it is a zombie, or the process now using that pid has a different start time (pid reuse). Everything else is treated as held, and the caller fails closed with `busy`: another host, no `/proc` (non-Linux), a live pid, an unreadable or garbled lock file. The proof uses Linux `/proc`; on another OS nothing is ever provable, which is the safe direction.

Removal itself races, so it is serialised by a momentary guard file (`openrouter-spend.lock.break`, same creation method): under the guard the breaker re-reads the lock, confirms it is still the same dead owner's, deletes it, removes the guard. The guard is only created while the dead owner's lock is in place, and nobody else can change that file in the meantime (the owner is dead, other breakers are excluded), so the check and the delete cannot straddle a new owner.

**Residual cases that need a person.** (1) A process killed exactly while it holds the break guard leaves the guard behind: every call is then refused (`busy`) until someone looks. (2) A lock whose owner cannot be proven gone (other host, shared storage) stays. In both cases the status shows the problem after the lock is over a minute old (`inspect()` reports it, never breaks it). Recovery: confirm with `ps`/`systemctl` that no ORBIT process other than the intended one runs, then delete `openrouter-spend.lock` and `openrouter-spend.lock.break` (and leave `openrouter-spend.json` alone). Tests: "killed while breaking a dead lock", "cannot be shown to be gone".

### Crash and restart behaviour
- **Crash anywhere inside a section.** The ledger is replaced by writing a unique temp file, `fsync`, `rename`, then `fsync` of the directory. A reader or the next writer sees the old file or the new one, never a mixture. Tests kill a real child with SIGKILL at `locked`, `loaded`, `tmp-written` (file unchanged, byte for byte) and `renamed`, `written` (change complete). The dead process's lock is cleared by the next caller under the stale-lock policy above; stray `*.new.*` temp files (only a dead or failed writer makes them) are removed at the next startup.
- **Reservations record their owner.** At every section, reservations whose owner is proven dead (same proof as for the lock) are charged at their bound as `orphaned` and kept in `uncertain`; they count against both caps until then. Reservations of a live owner, or of one that cannot be proven gone, **stay reserved** and keep counting, so a second process cannot bypass a cap by "adopting" a live process's request, and a crashed process's request cannot be forgotten. A process that exits without settling is a dead owner.
- **A ledger written by the previous version** (schema 1, no owners) is read, upgraded to schema 2 at its next write, and its ownerless reservations are treated as orphans (the previous version could not have a live second process; deployment restarts ORBIT).

### Atomicity, durability, and what is not claimed
Durable against process crash and (with the two fsyncs) power loss on a local filesystem that honours them. **Not** claimed: correctness on NFS or other filesystems with weak `link`/`rename`/`fsync` semantics; protection from a writer that ignores the lock (a human editing the file, another program); protection against the lock directory being deleted by hand while a section runs (detected as "lock lost" at the next write, but the window between check and rename is not zero).

### Fault latch (PR64 follow-ups 1 and 2)
`src/fallback.ts` keeps one fail-closed fault state, used by status and by admission alike. It is set when a paid call hit `SpendError "ledger"` (unreadable, corrupt, lost, rolled back, lock lost, write failed at reserve) **or** when the outcome of a call could not be recorded: a billed answer, an HTTP error, a timeout or an unreadable body whose settle/release failed. While set, **no paid call is admitted** and status says "NOT armed, no paid call will be made". `busy` and cap refusals do not set it (nothing is uncertain). Nothing in the process clears it: not status polling, not time, not a repaired disk. **Recovery is a restart of ORBIT after the ledger has been checked**: the unrecorded call is still on disk as a reservation owned by the process that is now gone, so it is charged at its bound as an orphan. Uncertain spend is kept, never dropped. There is deliberately no in-process "clear fault" route: that would be a new owner-facing control (a policy surface), and a restart is the explicit act.

## B8: a missing ledger is not a fresh budget

### Design (narrow, local, no new store, no privileges)
- The ledger is created **only** by ORBIT's startup step (`SpendLedger.open()`, called from `src/main.ts`), and only if the owner has deliberately asked: a hand-made one-shot file `<state>/openrouter-spend.provision`. Status polls and paid calls never create it; a missing ledger makes every path refuse and status say "not provisioned".
- At creation a random **epoch** is written into the ledger and into a separate marker file `openrouter-spend.marker`. The ledger is written first, then the marker, then the request is retired (renamed to `openrouter-spend.provision.used-<epoch>`), so a crash never leaves a marker without a ledger.
- A **marker without a ledger** means one existed and is gone: all spending stops, the ledger is never recreated. A ledger whose epoch differs from the marker (replaced or restored from another install) stops spending. A lost marker alone loses no spend: the ledger is authoritative and the marker is written again from it. A process that has already seen a write counter or lifetime total refuses a file that is lower (rolled back underneath it).
- Existing spend is never overwritten: the request is ignored and retired if a ledger exists.

### What the markers can and cannot prove
They catch: deleting or replacing the ledger file alone (a typical "repair" that removes the corrupt file), restoring another install's file, rolling the file back under a running process. They **cannot** prove continuity after **all local state is deleted or rolled back together**: wiping the state directory (a redeploy that recreates it, a snapshot restore, `rm -rf`) removes the ledger, marker and provision history alike, and an older but self-consistent copy of the directory passes every check. This is **not** a solution to B8 and the local ledger is **not** a hard financial ceiling. The ledger must not be described as one without independent evidence.

### Procedures for Rai (documented, **not run** by this change)
Replace `<state>` with `STATE_DIRECTORY` (the orbit service's state directory, `StateDirectory=orbit`). Run as the service user, never with root-only steps.

1. **First provisioning** (no ledger, no marker). `printf '{}' > <state>/openrouter-spend.provision`, then restart ORBIT. Check `/status`: it must say "OpenRouter fallback armed" and the spend figures must read $0. Optionally state a known opening spend: `{"openingLifetimeUsd": 0, "openingTodayUsd": 0, "note": "first provisioning"}`.
2. **Ledger missing but a marker exists (loss).** `/status` says "NOT armed ... missing although a history marker shows one existed". Do not delete the marker. First look for the file: a backup, or a copy moved aside. If found and its epoch matches the marker, put it back and restart. If it is gone, find the real spend (OpenRouter dashboard for this key: lifetime and today, UTC) and write a recovery request: `{"acknowledgeLoss": true, "openingLifetimeUsd": <lifetime so far>, "openingTodayUsd": <today>, "note": "<where the numbers came from>"}`, then restart. ORBIT cannot know these numbers; a too-low value is a silent under-count, so read them from the provider, and round up. The opening is recorded under `uncertain` as owner-declared, a new epoch is created, and the old one is kept in the retired request name.
3. **Ledger and marker disagree, or the file is rolled back.** Do not edit either. Move both aside (keep them), then follow step 2 as for a loss, with the provider's numbers.
4. **Corrupt ledger.** Unchanged from before: never reset by ORBIT; restore from a backup if one exists, otherwise treat as step 3.
5. **Migration from the previous version.** A schema 1 ledger is read as it is, upgraded at its next write, and gets its marker; nothing needs doing. (The fallback has not been activated, so none is expected to exist.)

### Decision for Rai: independent continuity (not implemented, out of scope)
Reliable continuity needs something that outlives the host's local state. Options, none built here:
- **Provider-side cross-check (smallest).** At startup and in `maintain()`, compare the key's account-side usage (`GET /api/v1/key`, already read for the balance display) with the local lifetime total, and refuse paid calls if the provider's usage exceeds local lifetime by more than a stated tolerance. It needs the endpoint's fields to be verified (they were not verifiable from the job environment) and treats other uses of the same key as a mismatch (fail closed, which is intended). It needs a policy decision on the tolerance and on what happens when the endpoint is down. **This and the key-side credit limit are the only things in this list that bound loss when local state is gone.**
- **Key-side hard credit limit (B6, owner step).** Already the only hard cap; set it at or below $150 and verify in the dashboard.
- **An append-only copy elsewhere** (a second host, the vault, a remote store) of the spend counter: needs a new external store, credentials and a policy change. Not built.
- **Root/host features** (an immutable file attribute, a separate root-owned state area, a helper that refuses to recreate the ledger): needs root privileges or a deployment unit. Not built; no privileged helper was added.

Until one of these is decided and built, losing the whole state directory still resets the local count to zero, and the first provisioning after that cannot be told from the very first one.

## What this does not solve
The gates in `docs/openrouter-activation-checklist.md` stay open: key-side hard credit ceiling and the local overshoot by a single reported cost, verified provider pricing and model metadata, charged rejected tool turns (B9), activation rehearsal on the real host layout, and two independent security reviews before any merge. This implementation is not a security review.
