# OpenRouter spend caps: daily, monthly and lifetime

This is the operator reference for the local spend caps of the paid OpenRouter fallback. It changes no production setting by itself:
nothing here is applied, deployed or activated by this change. The fallback stays off until Rai enables it (`docs/openrouter-activation-runbook.md`).

## The three caps

| Setting | Period | Resets | Default | Accepted values |
| --- | --- | --- | --- | --- |
| `ORBIT_OPENROUTER_DAILY_CAP_USD` | UTC calendar day | at 00:00 UTC every day | `5` | a positive number of USD, at most 10000 |
| `ORBIT_OPENROUTER_MONTHLY_CAP_USD` | UTC calendar month | at 00:00 UTC on the 1st of each month | none (not enforced) | a positive number of USD, at most 10000 |
| `ORBIT_OPENROUTER_TOTAL_CAP_USD` | **lifetime** of the ledger | **never** | `150`, but only when no monthly cap is set | a positive number of USD, at most 10000, or `off` (only together with a monthly cap) |

`ORBIT_OPENROUTER_TOTAL_CAP_USD` is and stays the **lifetime** cap. It is not reinterpreted as monthly. The new monthly cap is a separate setting.

Rules checked at startup (a violation makes the fallback `unavailable` with the reason in `/status`; nothing is spent):
- **Nesting**: daily <= monthly <= lifetime, for whichever of them are set.
- **Always a cap beyond one day**: at least one of monthly and lifetime is in force. `TOTAL=off` without a monthly cap is refused.
- **No silent lifetime cutoff**: when `ORBIT_OPENROUTER_MONTHLY_CAP_USD` is set, `ORBIT_OPENROUTER_TOTAL_CAP_USD` must be set explicitly (a number or `off`). Left unset it would fall back to the old 150 USD lifetime default, which would stop a 150/month budget for good after the first month; that combination is refused with a message saying so.
- **Zero is not a value.** `0` (also `0.0`, `000`) is refused for every cap, with a message. It never means "unlimited" and never means "spend nothing". To make no paid call at all, set `ORBIT_OPENROUTER_ENABLED=0`; to have no lifetime cap, use `off` with a monthly cap.
- **Malformed values are refused**, never defaulted: negative numbers, `NaN`, `Infinity`, hex (`0x10`), units or separators (`5 USD`, `1,5`) and empty-looking garbage. A blank or absent setting is "unset" (its default applies, or for monthly: no monthly cap).
- The daily cap must still be at least the reservation for the largest request (unchanged).

## Proposed production settings (Rai's stated budget: 5 USD/day, 150 USD/month, no lifetime cutoff)

In `/opt/orbit/orbit.env`, by hand (these keys are not in the ops config allowlist, and this change does not add them):

```
ORBIT_OPENROUTER_DAILY_CAP_USD=5
ORBIT_OPENROUTER_MONTHLY_CAP_USD=150
ORBIT_OPENROUTER_TOTAL_CAP_USD=off
```

If Rai also wants a long-term backstop, set a lifetime number at or above the monthly cap instead of `off`, for example `ORBIT_OPENROUTER_TOTAL_CAP_USD=1800` (twelve months at 150). A lifetime cap below 150 with a 150 monthly cap is refused (the lifetime cap would always bind first).

`/status` (model port) then reads, for example:
`$0.4000 spent today of $5 (resets 2026-11-14T00:00:00.000Z), $12.3000 spent in UTC month 2026-11 of $150 (resets 2026-12-01T00:00:00.000Z), $12.3000 lifetime (no lifetime cap), $0.0000 reserved for calls in flight (counted against every cap until settled); $4.6000 can still be reserved now.`
When a cap is used up it adds: `Every paid call is refused for now: the monthly cap is used up.`

The key-side credit limit on OpenRouter remains the only provider-enforced ceiling (runbook section 3). `docs/openrouter-preactivation-evidence.md` records that a key limit is either lifetime or rolling (`limit_reset`) and suggested a lifetime key limit of at most 150 USD. **Owner decision, not made here:** a 150 USD *lifetime* key limit would itself stop the fallback after 150 USD in total, which contradicts a 150/month budget; a rolling (monthly) key limit would match it. Check the options in the dashboard before choosing; this was not verified from the job environment. The local monthly cap does not replace the key-side limit.

## How spend is counted

- **Reservations first.** A call reserves its upper bound before it is sent. Every outstanding reservation counts against the daily, the monthly and the lifetime cap until it is settled, whichever day or month it was made in. A call in flight across midnight or across a month boundary therefore still occupies budget in the new period: a rollover never frees money a pending call may still spend.
- **Charged once, to its own day.** When a call settles (with the provider's cost, or at its whole bound when the cost is unknown), or is charged at its bound as orphaned after its process died, the charge goes to the UTC day the reservation was made on, and through it to that day's month. Nothing is charged twice; the reservation is removed in the same locked write.
- **Monthly total = the sum of the month's days** in the ledger's day table, plus the opening balance where it belongs (see Migration). It is recomputed from the file on every check, so it survives restarts and needs no new counter.
- **Uncertain charges** (unknown cost, timeout, 5xx, orphaned) count in full against their day, month and lifetime, as before.
- **Locking, atomicity, rollback detection, provisioning and loss handling** are unchanged (`docs/openrouter-ledger-integrity.md`). The monthly check runs inside the same critical section as the daily and lifetime checks, so competing processes cannot jointly exceed the monthly cap.

## Lowering a cap, or a cap below what is already spent

Lowering any cap takes effect at the next start. If the new cap is at or below what is already spent (plus what is reserved), every paid call is refused with `daily_cap`, `monthly_cap` or `total_cap`, `/status` shows 0 remaining and names the cap that is used up. **Nothing is deleted or rewritten**: the ledger file is not touched by a cap change, the spend figures are shown as they are (not clamped to the cap), and history stays for later months. A daily or monthly refusal ends at the next UTC day or month; a lifetime refusal ends only if the lifetime cap is raised.

## Migration of an existing ledger

No file change and no manual step is needed: the ledger keeps its format (schema 2), and the monthly total is rebuilt from what is already there. What to know:

1. **Existing settled spend** is in the per-day table and counts in its own month. Before this change the daily check counted only reservations made on the same day; now every outstanding reservation counts against today too (more conservative, never less).
2. **The opening balance** declared at provisioning (or at a recovery after loss) is the only spend not in the day table. ORBIT cannot know in which months it was spent, only that it was spent at or before the ledger was created. It is therefore counted **in full in the ledger's creation month** (UTC), and in no later month. In the creation month this can over-count (the month may look fuller than it really was); it never under-counts. From the next UTC month on it has no effect.
3. **New provisioning or recovery** may split the opening balance with an optional `openingMonthUsd`: how much of the lifetime spend falls in the current UTC month (at least `openingTodayUsd`, at most `openingLifetimeUsd`). The rest is recorded (`priorMonthsMicro` in the ledger) as spent in earlier months. Example, figures read from the OpenRouter dashboard and rounded up:
   `{"openingLifetimeUsd": 40, "openingTodayUsd": 1, "openingMonthUsd": 6, "note": "dashboard on <date>"}`
   An invalid split (not a number, below today, above lifetime) refuses provisioning, like any other bad provision file.
4. **Fail closed when it cannot be reconstructed.** If the day table adds up to more than the lifetime total, the stored split is larger than the opening balance or invalid, or the creation time is unreadable while there is an opening balance, the monthly total cannot be trusted. With a monthly cap configured every paid call is then refused (`ledger` error, the fallback latches as untrusted) and `/status` says "NOT armed ... the spend ledger's monthly total cannot be reconstructed (...)". Without a monthly cap (lifetime-only configuration) nothing changes and the month is shown as unknown. The file is never repaired or rewritten automatically: fix or restore it by hand as for any invalid ledger.
5. **Rolling back to an older ORBIT** keeps working: older code ignores the optional `priorMonthsMicro` field and enforces daily and lifetime caps only. An older ORBIT does not understand `TOTAL=off` (it would refuse it as an invalid number, making the fallback unavailable), so restore a numeric `ORBIT_OPENROUTER_TOTAL_CAP_USD` before rolling back.

## Tests

`test/openrouter-monthly-caps.test.ts` (configuration and validation, daily and monthly enforcement on their own, month and year rollover, reservations in flight across a boundary, uncertain and orphaned charges across rollover, restart, migration and its fail-closed cases, lowered caps, lifetime compatibility, status text), the monthly race in `test/spend-ledger-multiprocess.test.ts`, and the smoke-test refusals in `test/openrouter-smoke.test.ts`. All offline with fake providers.
