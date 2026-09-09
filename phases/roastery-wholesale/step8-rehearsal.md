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
absorb — a later run picks the money up. **Do not chase it.** Note it still counts
toward `weeksWritten` (which is 8, not 7 — the counter is not guarded by a row check);
what an empty week does change is `heartbeatStamped`, see (c).

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
| `weeksWritten` | **8** — an empty week still counts as written (no `continue` guards the counter at `orderapp.gs:1594`); CORRECTED 2026-09-09, the pre-run estimate of 7 was wrong | |
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
`weeksWritten` will be below **8** by exactly that count.

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
| `duplicatesSkipped` | **47** (== run 1's `rowsAdded`) | |
| `Revenue` row count | unchanged | |
| `weeksResummarized` | **2** — the drained queue, see below | |
| `weeksQueued` | **0** | |
| Summary `summarized_at` on W29–W32, W35 | unchanged | |
| Summary rows for **W33 + W34** | **newly created** — see below | |

`duplicatesSkipped` rising to match the first run's `rowsAdded` is the positive signal —
it proves the dedup key is doing its job, rather than nothing having happened.

### ⚠️ Idempotent on `Revenue`, NOT on `Summary` — corrected 2026-09-09

Run 1 wrote all 47 `Revenue` rows across 7 weeks, but the `GREENBEAN_RESUM_CAP` of 5 meant
only 5 of them reached `Summary`: **W29, W30, W31, W32 and W35** (the four oldest plus the
newest — the newest slot is reserved by the F2 starvation fix, commit `c7ccfef`). Run 1's
own log named the remainder:

```
wholesalePull: 2 affected week(s) still queued beyond the 5/run cap (oldest: 2026-08-10)
```

So **W33 (08-10) and W34 (08-17) have Revenue rows but no Summary rows yet.** Confirmed by
`doGet` immediately after run 1 — both weeks read `$0.00` at `location:'wholesale'` and
`location:'internal'` while the other five matched the producer to the cent.

> **Run (d) is what drains that queue.** Expect W33 and W34 to gain Summary rows, carrying
> $1,200.30 + $1,595.65 external and $12,895.79 + $13,323.35 internal. That is the fix
> landing, **not** an idempotency failure. Only the five weeks summarized in run 1 should
> have unchanged `summarized_at` stamps.

`heartbeatStamped` stays `false` on run (d) as well — the newest week is still the empty
W36, and draining the queue does not change that.

## (e) Negative auth

Expect `{noToken:true}`, zero writes, and a *skip* (not a failure) in the run accounting.

> ⚠️ **RENAME the property key — do NOT delete the value and retype it.**
> `getOrderAppToken_()` (`orderapp.gs:145-152`) only asks
> `getProperty('ORDER_APP_COST_TOKEN')` and treats any falsy result as `noToken`. So
> editing the **key** to `ORDER_APP_COST_TOKEN_BAK` takes the `noToken` path just as well
> as deleting it — and the secret never leaves the store, never reaches the clipboard,
> and never has to be retyped. Rename it back afterwards.
>
> This matters because the GAS Script Properties UI clips long values on paste
> (see [[token-mismatch-rotate-typed-not-debug-clipboard]]): a delete-and-restore risks
> silently truncating a token that three pulls share. The readers are exactly the
> `getOrderAppToken_()` call sites in `orderapp.gs` — `shopifyWeeklyPull` (:628),
> `greenBeanPull` (:1034) and `wholesalePull` (:1402), plus `orderAppFetch_` (:198).
> shopSpend is NOT one of them: it holds its own `SHOPSPEND_TOKEN_PROD`.
>
> While it is renamed those four skip. Midweek that is free: the triggers are Mon 05:00 /
> Mon 06:00 / Mon 07:00 / Tue 05:00, so nothing is due. Still, keep the window short.

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

   > **CORRECTION 2026-09-09 (post-hoc).** Point 1 was wrong about the cause, and
   > therefore wrong about the consequence. `FIX1b` was a **fixture** defect: the test
   > built its dates from the real clock while asserting inside
   > `withMockNow('2026-08-25')`, so its cutoff sat 15 days ahead of the implementation's
   > and `outsideWeek` landed exactly ON the mock cutoff, where the guard's strict `<`
   > stops biting. `summaryOrphanSweep_`'s purge-line guard was never broken — mutation
   > check (guard deleted) reds FIX1b and only FIX1b. The dry run would **not** have
   > reported false orphans for purged weeks. Suite now 2377/0. Skipping (g) was still a
   > defensible call on the evidence available at the time, but the risk it avoided did
   > not exist.
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

---

# Run record — 2026-09-09 (Jake at the keyboard, Apps Script editor)

## (b) dry run — 12:21 — ✅ PASS

`runWholesalePullDryRun()`. Every per-week line and every bucket matched the 09-09
baseline exactly:

```
weeks requested/fetched/written: 8/8/8
orders fetched: 47
would add/update/skip rows: 47/0/0
dates that would be healed: 0
BUCKET wholesale  $16310.199999999997      (float artifact of 16,310.20)
BUCKET internal   $95631.51
BUCKET ambiguous  $1179.87
BUCKET unknown    $0
```

Only deviation from the pre-run estimate: `weeksWritten` was **8**, not the predicted 7
— an empty week still increments the counter. Estimate corrected in this file.

## (c) wet run — 12:22 — ✅ PASS

47 `Revenue` rows written across 7 weeks. The 5/run resummarize cap summarized
**W29, W30, W31, W32 and W35** — the four oldest plus the newest, the newest slot being
reserved by the F2 starvation fix (`c7ccfef`). Run log:

```
wholesalePull: 2 affected week(s) still queued beyond the 5/run cap (oldest: 2026-08-10)
```

`doGet` immediately after: those five weeks matched the producer to the cent on **both**
the `wholesale` and `internal` channels; W33 and W34 read `$0.00` (Revenue written,
Summary pending); W36 correctly `$0.00`.

## (d) idempotency + queue drain — 12:35 — ✅ PASS

`rowsAdded` 0 on `Revenue` (all 47 keys already present), and the 2 queued weeks drained:
`weeklySummarize` ran for 2026-08-10 and 2026-08-17, no "still queued" line emitted.

The signature gate on the data-quality alert also proved itself:

```
orderAppRaiseDataQualityAlert_: coffee_order_app condition unchanged (nmd5cg) — alert suppressed
```

— i.e. the `Leible Taiwan` ambiguous-bucket alert fired once on run 1 and did **not**
re-alert on run 2, which is the designed behaviour.

### Final reconciliation — `doGet` vs the 09-09 producer probe, ALL 7 weeks

| week | hub `wholesale` | producer `external` | Δ | hub `internal` | producer `internal` | Δ |
|---|---:|---:|---:|---:|---:|---:|
| 2026-07-13 | 1,211.70 | 1,211.70 | **0.00** | 12,665.83 | 12,665.83 | **0.00** |
| 2026-07-20 | 3,746.30 | 3,746.30 | **0.00** | 14,053.80 | 14,053.80 | **0.00** |
| 2026-07-27 | 4,887.40 | 4,887.40 | **0.00** | 13,399.77 | 13,399.77 | **0.00** |
| 2026-08-03 | 1,397.15 | 1,397.15 | **0.00** | 15,312.77 | 15,312.77 | **0.00** |
| 2026-08-10 | 1,200.30 | 1,200.30 | **0.00** | 12,895.79 | 12,895.79 | **0.00** |
| 2026-08-17 | 1,595.65 | 1,595.65 | **0.00** | 13,323.35 | 13,323.35 | **0.00** |
| 2026-08-24 | 2,271.70 | 2,271.70 | **0.00** | 13,980.20 | 13,980.20 | **0.00** |
| 2026-08-31 | 0.00 | 0.00 | **0.00** | 0.00 | 0.00 | **0.00** |
| **total** | **16,310.20** | **16,310.20** | **0.00** | | | |

`supplier` on every `wholesale` row is a real customer name — KiKi Dessert, Lane cove,
63 Do, ADCO, ADCO Leppington, O3. Revenue locations present: `wholesale`, `internal`,
`ambiguous`, `online`. The pre-existing `shopify_orderapp` online rows are untouched at
$13,166.15 over the same window.

**Roastery wholesale income is in the hub for the first time.**

## (e) negative auth — 12:47 — ✅ PASS

Key renamed to `ORDER_APP_COST_TOKEN_BAK`; the value was never touched. `wholesalePull`
took the fail-closed path and wrote nothing:

```
orderapp: ORDER_APP_COST_TOKEN not set — skipping
orderapp: coffee_order_app skipped (not armed) — failcount reset, no heartbeat
```

Note it registered as a **skip**, not a failure — `orderAppRunSkipped_` reset the
failcount rather than incrementing it, which is the correct accounting for "not armed".

Key renamed back at 12:48 and the restore was **verified by re-running**, not assumed: all
eight weeks fetched with figures identical to runs 1 and 2, so the token survived intact.
That run also emitted no `weeklySummarize` lines at all — no week needed resummarizing,
which is idempotency confirmed a second time — and the DQ signature gate suppressed the
repeat alert again (`nmd5cg`).

## (f) alerting — 12:54 — ✅ PASS

```
checkIngestStaleness: checked=8, stale=1, eventsCreated=0
```

`eventsCreated=0` is **dedup, not failure** — asserted the way the step requires, by
confirming the event EXISTS rather than by reading the counter. Verified against the
calendar itself:

| field | value |
|---|---|
| title | `LEIBLE expense stale: coffee_order_app` |
| created | `2026-09-09T01:02:49Z` (11:02 Sydney — the watchdog's own earlier run) |
| body | "Last successful ingest for \"coffee_order_app\": never seen since the watchdog was installed." |

So the alert for today already existed before the 12:54 manual run, and the title-keyed
idempotency correctly declined to create a second one. CalendarApp reaching the calendar
at all is also the live proof that step 7's declared `calendar` scope is in effect.

`stale=1` of 8 checked — `coffee_order_app` is the **only** stale source; every other feed
is healthy. That alert is expected to keep firing daily until the Mon 2026-09-14 06:00 run
stamps the first heartbeat (empty W36 blocks it until then).

## (h) arm the triggers — 12:53 — ✅ PASS (confirmed on the Triggers page)

```
installOrderAppTriggers: shopifyWeeklyPull Monday 05:00 + greenBeanPull Tuesday 05:00 +
wholesalePull Monday 06:00 + wholesalePullRetry Monday 07:00 (Australia/Sydney) installed
```

That log line is not acceptance — the function is delete-then-create across all four
handler names. **Verified by reading the Apps Script Triggers page**, which shows 8
time-based triggers, all owned by Me, all on Head:

| function | last run | note |
|---|---|---|
| `wholesalePull` | — | ✅ new |
| `wholesalePullRetry` | — | ✅ new |
| `shopifyWeeklyPull` | — | ✅ survived (recreated — see below) |
| `greenBeanPull` | — | ✅ survived (recreated — see below) |
| `mayersDailyPull` | 9 Sept 06:32:05 | untouched |
| `weeklySummarize` | 7 Sept 04:35:28 | untouched |
| `checkIngestStaleness` | 9 Sept 11:02:46 | untouched |
| `squareDailyPull` | 9 Sept 03:55:11 | untouched |

Both halves of the contract hold: the four orderapp handlers exist, **and** the four
unrelated triggers were not swept — `installOrderAppTriggers` deletes only its own handler
names, as documented.

### ⚠️ `shopifyWeeklyPull` showing "last run: —" is EXPECTED, not a lost trigger

`shopifyWeeklyPull` and `greenBeanPull` both read `—` in the Last run column even though
shopifyWeeklyPull demonstrably ran on 2026-09-07 (it wrote the W36 Summary row at 05:56).
That is the delete-then-create working as designed: the recreated trigger is a **new
trigger object** with no execution history. The schedule is unchanged. Do not read a blank
Last run as a broken trigger — check Executions for the real history.

## Final state — step 8 COMPLETE

(a) ✅ · (b) ✅ · (c) ✅ · (d) ✅ · (e) ✅ · (f) ✅ · (g) **skipped, deliberately** · (h) ✅

**(g) was skipped, not passed.** `runSummaryOrphanSweepDryRun()`'s FIX1b test is RED on
main, its owning phase (`summary-self-heal`) is still `error`, and
`SUMMARY_HEAL_FROZEN_ = false` in the live script — so its dry run would have armed a
bogus approval set against an unfrozen delete path, for no benefit to this bring-up. It
gates nothing here. Tracked as an open item in `TODO.md`, not as a passed check.

> **CORRECTION 2026-09-09.** FIX1b is now GREEN (2377 passed / 0 failed) and was a
> fixture defect, not a bug in the sweep — see the correction under (g) above. The
> approval set the dry run records was never going to be bogus. (g) is still *skipped,
> not passed*: it has not been run. `summary-self-heal` remains `status: "error"` on its
> own (unrelated) `revise` verdict.

### Carried forward — both expected, neither a defect

1. `heartbeatStamped` is `false` and stays false until the **Mon 2026-09-14 06:00** run.
   The newest window week (W36) is genuinely empty upstream, so `newestWroteRows` and
   `newestGrossOk` cannot be satisfied by any re-run.
2. Consequently the `coffee_order_app` "never seen" staleness alert keeps firing **daily
   until that Monday**. The Monday 06:00 trigger is now armed and is what clears both.
