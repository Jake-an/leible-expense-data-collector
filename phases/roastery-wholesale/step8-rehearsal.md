# Step 8 — live bring-up rehearsal harness

Pre-computed expectations so the attended run is a checklist, not an improvisation.
Nothing here writes. Fill the **Actual** columns as you go — a check you did not run is a
check that failed.

## ⏰ REBASELINED 2026-09-09 — the original window expired

The first draft of this file said "run on or before Sunday 2026-09-06" so the window would
match `prod-probe.md` exactly. **That date passed.** Rather than run blind against a stale
baseline, the producer was re-probed live on **2026-09-09** and every expectation below is
now sourced from that probe, not from `prod-probe.md`.

`wholesalePull` pulls the last 8 completed ISO weeks *as of the run date*:

| Run date | Window | Baseline |
|---|---|---|
| ~~2026-09-04 → 09-06~~ | ~~W28 … W35~~ | expired |
| **2026-09-09 → 09-13** | **W29 (07-13) … W36 (08-31)** | ✅ the table below (probed 09-09) |
| 2026-09-14 onward | W30 (07-20) … W37 (09-07) | ⚠️ **W29 drops off — its $1,211.70 is then uncollectable without a backfill** |

> **Run before Monday 2026-09-14.** Not for baseline reasons any more — the baseline is
> fresh either way — but because W29 leaves the 8-week window that morning, taking
> $1,211.70 of external revenue with it.

### The live 09-09 probe — all 8 weeks `ok:true`, all five diagnostics `true`

| week | label | external | internal | ambiguous | unknown | all | orders |
|---|---|---:|---:|---:|---:|---:|---:|
| 2026-07-13 | W29 | 1,211.70 | 12,665.83 | 388.60 | 0.00 | 14,266.13 | 6 |
| 2026-07-20 | W30 | 3,746.30 | 14,053.80 | 0.00 | 0.00 | 17,800.10 | 8 |
| 2026-07-27 | W31 | 4,887.40 | 13,399.77 | 373.19 | 0.00 | 18,660.36 | 8 |
| 2026-08-03 | W32 | 1,397.15 | 15,312.77 | 0.00 | 0.00 | 16,709.92 | 6 |
| 2026-08-10 | W33 | 1,200.30 | 12,895.79 | 418.08 | 0.00 | 14,514.17 | 7 |
| 2026-08-17 | W34 | 1,595.65 | 13,323.35 | 0.00 | 0.00 | 14,919.00 | 7 |
| 2026-08-24 | W35 | 2,271.70 | 13,980.20 | 0.00 | 0.00 | 16,251.90 | 5 |
| 2026-08-31 | W36 | **0.00** | **0.00** | 0.00 | 0.00 | **0.00** | **0** |
| | **total** | **16,310.20** | **95,631.51** | **1,179.87** | **0.00** | **113,121.58** | **47** |

### ⚠️ W36 is genuinely empty — not a fetch failure

W36 returns `ok:true`, `rowsScanned:166`, `positiveControlCount:22` and all five
diagnostics `true`, with `orderCount:0` in every bucket. The producer filters to
`Finalized`/`Archived`; the week closed 2026-09-06 and those orders have not been
finalized yet. This is exactly the settlement lag `WHOLESALE_REPULL_WEEKS = 8` exists to
absorb — a later run picks the money up. **Do not chase it, and do not treat
`weeksWritten: 7` as a failure.**

## (b) Dry run — `runWholesalePullDryRun()`

Read the **return value**; these pulls log little. `byBucket` is in **dollars, summed
across all 8 weeks** (per-week figures go to `Logger.log`, one line per week).

> ⚠️ **Use `runWholesalePullDryRun()`, not `wholesalePull({dryRun:true})`.** The editor's
> Run dropdown calls the selected function with **no arguments**, so the form step8.md
> asks for is unreachable from the UI — selecting `wholesalePull` there would silently
> run a **wet** pull. The zero-arg wrapper (`orderapp.gs`) makes the identical dry call
> and logs one line per bucket and per week.

| Return field | Expected (live probe, 2026-09-09) | Actual |
|---|---|---|
| `byBucket.wholesale` | **16310.20** | |
| `byBucket.internal` | **95631.51** | |
| `byBucket.ambiguous` | **1179.87** | |
| `byBucket.unknown` | **0** | |
| `weeksRequested` | 8 | |
| `weeksFetched` | 8 | |
| `weeksWritten` | **7** — W36 is empty, see above | |
| `ordersFetched` | **47** | |
| `failedWeeks` / `crossFootFailures` / `splitWeeks` | all `[]` | |
| `dryRun` | `true` | |
| `datesHealed` | 0 (nothing has ever been written) | |

Per-week `Logger.log` lines should match the `external`/`internal` columns above:
W29 1,211.70 · W30 3,746.30 · W31 4,887.40 · W32 1,397.15 · W33 1,200.30 ·
W34 1,595.65 · W35 2,271.70 · W36 0.00.

**Any discrepancy means the upstream changed since 2026-09-09 — explain it before (c).**

### Why `splitWeeks` is expected to be empty

`ARCHIVE_RETENTION_DAYS = 183` (`Code.gs:33`), so the archive cutoff as of the run is
roughly **2026-03-09**. The oldest week in the window (W29, 2026-07-13) is ~58 days old —
comfortably inside retention, so nothing in it should have been purged to `_archive`.

This is a *derived* expectation, not a measured one: I could not read the live `_archive`
tab. If `splitWeeks` comes back non-empty, do **not** treat it as a bug — it means that
week genuinely has archived rows, the guard correctly wrote nothing for it, and
`weeksWritten` will be below **7** by exactly that count.

## (c) Wet run — `wholesalePull()`

> **The strongest assertion available: wet-run `rowsAdded` must equal dry-run `rowsAdded`.**
> The dry run simulates `upsertRows_` against a copy of the real snapshot, so it predicts
> the wet run exactly. A divergence means something changed between the two calls.

| Field | Expected | Actual |
|---|---|---|
| `rowsAdded` | == dry run's `rowsAdded` (**≈ 47**; probe saw 5–8 orders/week, W36 zero) | |
| `rowsUpdated` | 0 | |
| `duplicatesSkipped` | 0 | |
| `weeksResummarized` | 5 (the `GREENBEAN_RESUM_CAP`) | |
| `weeksQueued` | **2** (7 affected − cap 5) — W36 wrote nothing, so it is not affected | |
| `heartbeatStamped` | **false** — see below. Expected on EVERY run this week, not just run 1. | |

### ⚠️ NO run this week will stamp a heartbeat — corrected 2026-09-09

The original note here said the heartbeat fails on run 1 (resummarize cap, oldest-first)
and **self-corrects on run 2**. With the shifted window that is no longer true, and the
real reason is different and stronger.

`heartbeatStamped` is gated on the **newest** week in the window (`orderapp.gs:1683-1697`).
That week is now **W36, which is genuinely empty**, so two of its six conditions are
structurally false:

| condition | source | W36 value | passes? |
|---|---|---|---|
| `newestWroteRows` | `mapped.rows.length > 0` (`:1624`) | `0 > 0` | ❌ |
| `newestGrossOk` | wholesale cents ≥ `WHOLESALE_GROSS_FLOOR` 800 (`:1690`) | `0 ≥ 80000` | ❌ |

Nothing a re-run can do changes either one — the upstream week is empty. So:

> **`heartbeatStamped: false` is the expected result of EVERY run from 2026-09-09 through
> Sunday 2026-09-13, including a completely successful one.** Do not read it as a failed
> pull, and do not re-run trying to make it stamp.

**First real chance to stamp: the armed Monday 2026-09-14 06:00 trigger**, when W37
(09-07–09-13) becomes the newest completed week. Every non-empty week probed clears the
$800 floor comfortably (lowest: W33 at $1,200.30), so a normal W37 stamps.

**Consequence for (f):** the `coffee_order_app` "never seen" staleness alert **will keep
firing daily until that Monday run**, because the never-seen short-circuit fires before any
threshold (see the hazard note below). A successful bring-up does not silence it this week.

### ⚠️ Two expected-but-alarming things

1. **A data-quality calendar alert WILL fire on the first run.** `ambiguousTotal > 0`
   (W29 $388.60, W31 $373.19, W33 $418.08) and `classificationConflicts` names
   `Leible Taiwan` in W29/W31/W33. Both feed `dqTriggered`. This is the connector working,
   not failing — a human resolves SHOPS in the Order app. It is signature-gated, so it
   will not re-alert every run while the condition is unchanged.
2. **The DQ alert does NOT suppress the heartbeat.** `heartbeatStamped` is gated only on
   the newest week's own conditions; `ambiguous` is not one of them. So the alert is not
   the reason the heartbeat is missing this week — the empty W36 is. Do not conflate them.

### doGet verification

Token via `base_connector.get_credential` — **never** a `.env` grep (a grepped value
carries stray whitespace). Bare `curl -sL`; do not add `-X` or a `Content-Type` header
(they produce a misleading 411/404 on a healthy endpoint).

```bash
# wholesale revenue rows across the pulled window
curl -sL "$EXEC_URL?token=$TOK&fn=summary&from=2026-07-13&to=2026-08-31&department=Roastery"
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

**Mitigation (superseded 2026-09-09):** step 7 is already closed and its scopes are live,
so the gap is open right now — the alert has been firing daily since 2026-09-07. **No run
this week closes it**, because the heartbeat cannot stamp while the empty W36 is the newest
week (see the corrected heartbeat section above). Expect the alert through Sunday
2026-09-13 and do not chase it; the armed Monday 2026-09-14 06:00 trigger is what clears
it.

## (g) Orphan sweep — `runSummaryOrphanSweepDryRun()` — ⚠️ SKIP THIS WEEK

**Recommend skipping (g) during this bring-up.** Two facts found 2026-09-09 that step8.md
predates:

1. **Its orphan detection has a known-RED test.** `test_code.js` FIX1b — *"a week past the
   purge line yields ZERO candidates, not 'every row is an orphan'"* — **fails on `main`
   today** (2374 passed / 1 failed, the only failure in the suite). The owning phase,
   `summary-self-heal`, is still `status: "error"`. So the dry run is expected to report a
   large set of **false** orphan candidates — potentially every non-pull-owned Summary row
   for every purged week.
2. **The destructive half is NOT frozen.** `SUMMARY_HEAL_FROZEN_ = false`
   (`Code.gs:169`, lifted in commit `652bf38`), so `runSummaryOrphanSweep()` will delete.
   And the dry run is not inert — it *records the candidate set as approved* into
   `SUMMARY_ORPHAN_SWEEP_APPROVED_PROP_`, which is exactly the gate the apply checks.

Running (g) therefore arms a bogus approval set against a live delete path, for zero
benefit to the wholesale bring-up. It gates nothing here. **Skip it, and note the skip.**
If you do run it: read the candidates, and do **not** run `runSummaryOrphanSweep()`.

## Rollback reality

`upsertRows_` (`Code.gs:712`) is insert/update only — **no delete path**. A code rollback
reverts code, never data. The snapshot tabs from (a) are reference-only: a wholesale
copy-back is **prohibited**, because restoring a whole tab deletes rows other producers
wrote after the snapshot froze (`shopify_orderapp` writes `Summary` directly, `Labour`
comes from an external sheet). Recovery is row-by-row, guided by the snapshot.
