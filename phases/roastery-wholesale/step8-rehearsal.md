# Step 8 — live bring-up rehearsal harness

Pre-computed expectations so the attended run is a checklist, not an improvisation.
Nothing here writes. Fill the **Actual** columns as you go — a check you did not run is a
check that failed.

## ⏰ Run this on or before **Sunday 2026-09-06**

`wholesalePull` pulls the last 8 completed ISO weeks *as of the run date*. Verified against
`lastCompletedWeeks_`:

| Run date | Window | Comparable to `prod-probe.md`? |
|---|---|---|
| 2026-09-04 → 2026-09-06 | **W28 (07-06) … W35 (08-24)** | ✅ the exact 8 weeks the probe measured |
| 2026-09-07 onward | W29 (07-13) … W36 (08-31) | ⚠️ W28 drops off, **W36 has no baseline** |

Run inside the window and every figure below is a 1:1 diff. After it, W36 is new money you
cannot check against anything.

## (b) Dry run — `wholesalePull({dryRun:true})`

Read the **return value**; these pulls log little. `byBucket` is in **dollars, summed
across all 8 weeks** (per-week figures go to `Logger.log`, one line per week).

| Return field | Expected (from `prod-probe.md` 8-week totals) | Actual |
|---|---|---|
| `byBucket.wholesale` | **18910.10** | |
| `byBucket.internal` | **107095.09** | |
| `byBucket.ambiguous` | **1179.87** | |
| `byBucket.unknown` | **0** | |
| `weeksRequested` | 8 | |
| `weeksFetched` | 8 | |
| `weeksWritten` | 8 | |
| `failedWeeks` / `crossFootFailures` / `splitWeeks` | all `[]` | |
| `dryRun` | `true` | |
| `datesHealed` | 0 (nothing has ever been written) | |

Per-week `Logger.log` lines should match the probe's `external`/`internal` columns:
W28 2,599.90 · W29 1,211.70 · W30 3,746.30 · W31 4,887.40 · W32 1,397.15 · W33 1,200.30 ·
W34 1,595.65 · W35 2,271.70.

**Any discrepancy means the upstream changed since 2026-09-03 — explain it before (c).**

### Why `splitWeeks` is expected to be empty

`ARCHIVE_RETENTION_DAYS = 183` (`Code.gs:33`), so the archive cutoff as of the run is
roughly **2026-03-05**. The oldest week in the window (W28, 2026-07-06) is ~60 days old —
comfortably inside retention, so nothing in it should have been purged to `_archive`.

This is a *derived* expectation, not a measured one: I could not read the live `_archive`
tab. If `splitWeeks` comes back non-empty, do **not** treat it as a bug — it means that
week genuinely has archived rows, the guard correctly wrote nothing for it, and
`weeksWritten` will be below 8 by exactly that count.

## (c) Wet run — `wholesalePull()`

> **The strongest assertion available: wet-run `rowsAdded` must equal dry-run `rowsAdded`.**
> The dry run simulates `upsertRows_` against a copy of the real snapshot, so it predicts
> the wet run exactly. A divergence means something changed between the two calls.

| Field | Expected | Actual |
|---|---|---|
| `rowsAdded` | == dry run's `rowsAdded` (≈ `ordersFetched`; probe saw `matched` 5–7/week) | |
| `rowsUpdated` | 0 | |
| `duplicatesSkipped` | 0 | |
| `weeksResummarized` | 5 (the `GREENBEAN_RESUM_CAP`) | |
| `weeksQueued` | 3 (8 affected − cap 5) — drains over the next runs | |
| `heartbeatStamped` | **false** — see below. This is expected on run 1. | |

### ⚠️ Run 1 will NOT stamp a heartbeat — and that is correct

The resummarize cap drains **oldest-first**: with all 8 window weeks affected, `toSummarize`
takes W28–W32 and the **newest week (W35) lands in the overflow queue**. The heartbeat's
`newestResumOk` condition therefore cannot be satisfied, so `heartbeatStamped` is `false`
even though every week wrote cleanly.

Verified by test, not by reasoning — `test_code.js` case20b asserts exactly this, and
isolates it (all other heartbeat conditions pass in that fixture).

**It self-corrects on run 2**, when the 3 queued weeks drain (3 < cap 5) and the newest
week gets summarized. So:

- Do **not** read a missing heartbeat on run 1 as a failed pull.
- Do **not** re-run repeatedly trying to make it stamp — run (d) idempotency is that
  second run, and it is what clears the queue.
- `checkIngestStaleness()` in (f) watches `coffee_order_app` at 168h — but see the
  never-seen hazard below, which the 168h override does **not** protect against.

### ⚠️ Two expected-but-alarming things

1. **A data-quality calendar alert WILL fire on the first run.** `ambiguousTotal > 0`
   (W29 $388.60, W31 $373.19, W33 $418.08) and `classificationConflicts` names
   `Leible Taiwan` in W29/W31/W33. Both feed `dqTriggered`. This is the connector working,
   not failing — a human resolves SHOPS in the Order app. It is signature-gated, so it
   will not re-alert every run while the condition is unchanged.
2. **The DQ alert does NOT suppress the heartbeat.** `heartbeatStamped` is gated only on
   the newest week's five conditions; `ambiguous` is not one of them. Expect an alert
   **and** a stamped heartbeat together.

### doGet verification

Token via `base_connector.get_credential` — **never** a `.env` grep (a grepped value
carries stray whitespace). Bare `curl -sL`; do not add `-X` or a `Content-Type` header
(they produce a misleading 411/404 on a healthy endpoint).

```bash
# wholesale revenue rows across the pulled window
curl -sL "$EXEC_URL?token=$TOK&fn=summary&from=2026-07-06&to=2026-08-24&department=Roastery"
```

Confirm in the payload:
- `kind:'revenue'` rows at `location:'wholesale'`, `supplier` = the **customer** name
  (one row per customer per week)
- separate rows at `location:'internal'` — these are inter-company transfers, **not income**
- the `wholesale` figures reconcile to the probe's `external` column

## (d) Idempotency — re-run `wholesalePull()`

| Assertion | Expected | Actual |
|---|---|---|
| `rowsAdded` | 0 | |
| `rowsUpdated` | 0 | |
| `duplicatesSkipped` | == the first run's `rowsAdded` | |
| `Revenue` row count | unchanged | |
| Summary `summarized_at` stamps | unchanged | |

`duplicatesSkipped` rising to match the first run's `rowsAdded` is the positive signal —
it proves the dedup key is doing its job, rather than nothing having happened.

## (e) Negative auth

Clear `ORDER_APP_COST_TOKEN` → expect `{noToken:true}`, zero writes, and a *skip* (not a
failure) in the run accounting. **Restore the token afterwards.**

## (f) Alerting — `checkIngestStaleness()`

Assert the calendar event **EXISTS** (title `LEIBLE expense stale: <source>`).
`eventsCreated:0` is dedup, not failure — check the event's `created` timestamp to tell
which version you are looking at.

### ⚠️ Never-seen hazard — the gap between step 7 and step 8

`staleness.gs:259` short-circuits **before** any threshold is applied:

```js
if (seen === null) { out.push({ ..., stale: true, ... }); continue; }
```

A source with no heartbeat is `stale: true` **immediately** — the 168h override protects a
*stale* heartbeat, not a *missing* one. Step 5 already armed `coffee_order_app` in
`STALENESS_SOURCES`, but only step 8 ever stamps its first heartbeat. So:

> **From the moment step 7's push lands until step 8's wet run succeeds,
> `checkIngestStaleness` will alert `coffee_order_app` as "never seen since the watchdog
> was installed" on every run.**

This is exactly the false-alarm the original `staleness.gs` comment warned about — it was
correct, and arming ahead of the writer re-opened it for the duration of the gap.

**Mitigation: run step 7 and step 8 in the same sitting.** If they must be split, expect
the alert and do not chase it. Note run 1 does not clear it either — the heartbeat only
stamps once the newest week is resummarized, i.e. run 2 (see the run-1 note above).

## (g) Orphan sweep — `runSummaryOrphanSweepDryRun()`

Read-only. Record the candidates it reports; do not act on them in this step.

## Rollback reality

`upsertRows_` (`Code.gs:712`) is insert/update only — **no delete path**. A code rollback
reverts code, never data. The snapshot tabs from (a) are reference-only: a wholesale
copy-back is **prohibited**, because restoring a whole tab deletes rows other producers
wrote after the snapshot froze (`shopify_orderapp` writes `Summary` directly, `Labour`
comes from an external sheet). Recovery is row-by-row, guided by the snapshot.
