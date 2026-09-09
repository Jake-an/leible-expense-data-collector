# TODO — LEIBLE Expense Data Collector

## Done — at a glance
- Project scaffolded (git, gitignore, CLAUDE.md, docs, harness framework)
- Scaffold revised to the two-tab schema (`Suppliers` + `Sales`); Order-app `.claude` hook suite + team-share `.gitignore` adopted
- **Phase 0 GAS hub LIVE** — Sheet, GAS project, doPost, dedup, deploy pipeline all operational (proven by FDCo + Ordermentum + Square data in production)
- Playwright base + 4 portal skeletons scaffolded
- **Food and Dairy Co connector built + live-tested 2026-06-18** (326 invoices, dedup verified)
- **Ordermentum connector live-tested 2026-06-18** — Butterboy fix verified (tradingName match), 114 rows (74 Tuga + 40 Butterboy); cleanup deployed to relabel "Wholesale Cookies PTY LTD" → "Butterboy" and delete out-of-filter suppliers
- **Fresh and Chill connector built + live-tested 2026-06-22** — Zupply web app (not WhatsApp); York 36 orders, dedup verified; 3 shops left to seed
- **Read API + weekly summary built 2026-06-22** — token-gated `doGet`, `weeklySummarize()` with 6-month archive/purge
- **Summary dedup bug found + fixed + live-repaired 2026-07-17** — `String(week_start)` never matched a Sheet's
  Date, so every run re-appended the whole week (06-15 written 4×; `doGet` over-reported spend 4×). Fixed at all
  3 dedup sites, live tab repaired (24 dupes deleted, 2 weeks backfilled, verified 0 remaining), weekly trigger
  installed. **237 tests green** — the mock now coerces dates on write, which is what had hidden it under 209 green tests.
- **Phases 7 + 8 fully closed 2026-07-17** — `API_READ_TOKEN` + `LABOUR_SHEET_ID` set, weekly trigger live,
  one-shots removed. The hub is end-to-end operational.

## Active

### ✅ Roastery wholesale income connector — LIVE 2026-09-09 (phase `roastery-wholesale`, PRD-14 built)

**Runbook receipt — live bring-up 2026-09-09, Jake at the keyboard.** Steps 0-8 all
closed; PRD-14 flipped to `built`. Full evidence:
`phases/roastery-wholesale/step8-rehearsal.md` § "Run record".

Roastery wholesale income reaches the hub for the first time. Final `doGet`
reconciliation against a same-day producer probe — **all 7 non-empty weeks match to
the cent on BOTH channels, delta $0.00**:

| | 7-week total (W29…W35) |
|---|---:|
| `location='wholesale'` (genuine external income) | **$16,310.20** |
| `location='internal'` (inter-company transfers — NOT income) | $95,631.51 |
| `location='ambiguous'` (`Leible Taiwan`, unresolved) | $1,179.87 |

Supplier names are real customers (KiKi Dessert, Lane cove, 63 Do, ADCO,
ADCO Leppington, O3). Pre-existing `shopify_orderapp` online rows untouched at
$13,166.15. Triggers confirmed **on the Triggers page**: `wholesalePull` Mon 06:00 +
`wholesalePullRetry` Mon 07:00, alongside the surviving `shopifyWeeklyPull` Mon 05:00
and `greenBeanPull` Tue 05:00.

Two things that were wrong in the plan and are worth remembering:

- **step8.md's `wholesalePull({dryRun:true})` was unrunnable.** The Apps Script editor's
  Run dropdown passes **no arguments**, so following it literally would have run a WET
  pull instead of the preview — through a one-way door. Fixed by adding the zero-arg
  `runWholesalePullDryRun()`.
- **The rehearsal's expected figures had expired** (window was W28…W35, actual run window
  W29…W36). Rebaselined off a live 2026-09-09 probe before the wet run.

⚠ **Still true, carried:** the `roastery` feed is a different thing entirely — it writes
**SPEND**, not income. Don't debug it for wholesale revenue.

- [ ] **Carried: no heartbeat until Mon 2026-09-14.** `heartbeatStamped` is gated on the
      newest window week, and W36 (Aug 31–Sep 6) is genuinely empty upstream — the
      producer filters to Finalized/Archived and the week hasn't settled. So
      `newestWroteRows` and `newestGrossOk` are both structurally false and **no re-run
      can stamp**. Consequence: the `coffee_order_app` "never seen" staleness alert fires
      **daily until the Mon 09-14 06:00 run**. Expected, not a defect — but if it is
      still firing on Tue 09-15, that IS a defect and needs looking at.
- [ ] **Step 8(g) was deliberately SKIPPED, not passed** — but the reason it was
      skipped turned out to be wrong. **RESOLVED 2026-09-09: `FIX1b` was a FIXTURE
      defect, not an implementation bug.** `summaryOrphanSweep_`'s purge-line guard
      (`summary_audit.gs`, `rowWeek < purgeCutoff`) was never broken. The test derived
      its fixture dates from the REAL clock while every assertion ran inside
      `withMockNow('2026-08-25')`, putting the fixture's cutoff 15 days ahead of the
      one the implementation computes; as the real clock advanced, `outsideWeek` crawled
      onto the mock cutoff exactly — the one point where the guard's strict `<` stops
      biting — so the case went permanently RED from 2026-09-08. Fixture now derives
      from the pinned instant, plus two precondition asserts so a future drift onto the
      boundary fails loudly instead of silently inverting the case. Suite **2377 passed,
      0 failed**; mutation check (guard removed) reds FIX1b and only FIX1b.

      **The "armed delete path" concern recorded here was therefore not real** — the
      sweep does skip past-purge weeks, so a dry run cannot record a whole-history
      candidate set into `SUMMARY_ORPHAN_SWEEP_APPROVED_PROP_`. `SUMMARY_HEAL_FROZEN_`
      remains `false` (Code.gs:169) by deliberate choice, not by oversight.

      **8(g) RUN AND PASSED, live, 2026-09-09 15:21** (Jake, Apps Script editor):
      `runSummaryOrphanSweepDryRun()` -> **`found 0 orphan candidate(s)`**, nothing
      written, execution completed clean. This is the live confirmation of the analysis
      above: a broken purge guard would have reported false orphans across every purged
      week. 8(g) is now **passed, not skipped** - the earlier "deliberately SKIPPED"
      framing is superseded.

      **CONFIRMED CLEAN 2026-09-09 15:32, re-run on GAS v49 with the new accounting:**
      `weeks in Summary 28 | evaluated 25 | skipped past purge line 3 | skipped SPLIT 0`
      -> `found 0 orphan candidate(s) (out of 25 week(s) actually evaluated)`. The zero is
      **genuine, not blind** - 25 of the 28 weeks Summary holds were actually recomputed.

      Reconciles exactly against known history: Summary spans `2026-02-23` (the oldest
      week the 2026-08-25 drift repair wrote) through `2026-08-31` (last completed week;
      W36 has not settled) = **28 weeks**, of which `2026-02-23`, `2026-03-02` and
      `2026-03-09` fall before the `2026-03-10` purge cutoff = **3 skipped**, leaving
      **25 evaluated**. Model and live agree on all three numbers.

      *Correcting my own earlier note in this item:* I wrote that the zero "is NOT a
      census of all ~169 weeks", implying Summary holds ~169 weeks and the sweep skips
      most of them. **That was wrong about the mechanism.** Nothing prunes Summary - there
      is no retention purge on it, so 28 weeks is everything it has ever held. The ~169
      weeks are **Suppliers** weeks after the accidental backfill; ~141 of them have **no
      Summary row at all**. That is the $436k drift, and it is *missing* data, the exact
      inverse of what an orphan sweep looks for (Summary rows with no source). **The
      orphan sweep is structurally incapable of seeing the drift** - a clean sweep is not
      evidence about it in either direction. Do not read one as reassurance about the
      other.
- [x] **RESOLVED 2026-09-09 (commit `ec4822e`, GAS v49): the orphan-sweep dry run now
      reports its week accounting.** `summaryOrphanSweep_` returns `weeksTotal` /
      `weeksEvaluated` / `weeksSkippedPurge` / `weeksSkippedSplit`; the dry run logs the
      split, appends *"(out of N week(s) actually evaluated)"* to the candidate count,
      and emits a loud WARNING when `weeksEvaluated === 0` with weeks present — the one
      case where 0 candidates must not be read as clean. Additive only; the gated apply
      path reads `report.candidates` alone and is untouched. 12 assertions written
      test-first (RED 2380/12 on `undefined`, GREEN 2392/0), mutation-checked three ways.
      **Next 8(g) re-run will show the accounting** — that is what turns the earlier
      `found 0` into a provable clean result rather than a possibly-blind one.

      *Original problem, for the record:*
      `runSummaryOrphanSweepDryRun()` logs only `found N orphan candidate(s)`
      (`summary_audit.gs:632`). It never reports how many weeks it **evaluated** vs
      **skipped** (past-purge / SPLIT), so a 0 from "checked 26 weeks, all clean" and a 0
      from "skipped everything" are byte-identical in the log - same class as the
      map-driven-gate-is-blind-not-red memory. Fix: have `summaryOrphanSweep_` return
      `weeksEvaluated` / `weeksSkippedPurge` / `weeksSkippedSplit` and log the split.
      Small and safe, but it touches a `.gs` so it needs a deploy - its own step.
      **Remaining after that:** close out phase `summary-self-heal` (still
      `status: error`, on an unrelated `revise` verdict about
      `restoreWeekFromHealBackup_` whose tests are now green).

- [ ] **ACTIONABLE: week `2026-08-31` is stale by $1,563.62 and will never self-heal.**
      `auditSummaryDrift()` run live 2026-09-09 15:38: `weeks audited 241 | clean 27 |
      DRIFTED 214`, net under-reported **$353,485.43**. That headline is 99.6%
      historical — **213 of the 214 drifted weeks are past the purge line**
      ($351,921.81, spanning 2022-01-24 -> 2026-02-16, almost all "NO — archived only").
      **Exactly one drifted week is inside the window:** `2026-08-31`, with **0 missing
      rows but 7 STALE amounts**, $1,563.62 under-reported, source present in
      `Suppliers`.

      It will **not** fix itself: the weekly trigger summarizes only the *last completed*
      week, so on Mon 2026-09-14 it writes `2026-09-07` and never revisits `2026-08-31`.
      This is the classic "Summary written once, never revisited" mechanism.

      Safe to re-summarize — verified, not assumed: the week is 9 days old, far inside
      `ARCHIVE_RETENTION_DAYS=183`, so it cannot have `_archive` rows and cannot be SPLIT
      (independently confirmed by the same-day orphan sweep reporting `skipped SPLIT 0`).
      That clears the [[resummarize-split-week-understates]] hazard.

      **Cross-check that both tools agree:** drift audit's 27 clean + 1 in-window drifted
      = 28 weeks carrying Summary rows, which is exactly the `weeks in Summary 28` the
      orphan sweep reported the same afternoon. The two independent tools reconcile.

- [x] **RESOLVED 2026-09-09 (commit pending, GAS v50): both commands are now reachable.**
      Added `resummarizeWeekFromProperty()` (reads `SUMMARY_RESUMMARIZE_WEEK`) and gave
      `auditSummaryDriftDetail()` optional `SUMMARY_AUDIT_MIN_WEEK` scoping. 23 assertions
      written test-first (RED: 3 failures + a `ReferenceError`; GREEN 2415/0),
      mutation-checked per guard.

      **Correcting my own claim in the original item below:** I wrote that detail "cannot
      be reached either". Wrong — `auditSummaryDriftDetail()` already existed and was
      already zero-arg and deployed. What it lacked was *scoping*, so at 214 drifted weeks
      it emits ~800 lines. Only `weeklySummarize(week)` was genuinely unreachable.

      **Also corrected:** the wrapper's SPLIT guard is **defense-in-depth, not the only
      protection** — `weeklySummarize`'s own guarded write path already skip-splits
      (`Code.gs:2728`). The mutation check proved this: deleting the wrapper's guard does
      not let a split week through. It earns its place by failing fast with a readable
      reason before taking the script lock, not by being load-bearing.

      *Original item, for the record:* The audit's closing advice is
      `weeklySummarize('<week_start>')` and "read the detail first" — but
      `weeklySummarize(weekStartOverride)` (`Code.gs:2972`) takes an argument and
      `auditSummaryDrift()` (`summary_audit.gs:943`) hard-codes `auditSummaryDrift_(false)`,
      so detail (and its `minWeek` scoping) cannot be reached either. The GAS editor Run
      button passes **no arguments** — the exact gotcha already hit on step 8 with
      `wholesalePull({dryRun:true})`. Fix with the established zero-arg + script-property
      pattern `restoreSummaryWeekFromBackup()` already uses:
      - `auditSummaryDriftDetail()` -> `auditSummaryDrift_(true, <SUMMARY_AUDIT_MIN_WEEK>)`
        — property-scoped so it does not dump detail for 214 weeks into a truncating log
        (see [[gas-editor-log-truncates-one-big-blob]]).
      - `resummarizeWeekFromProperty()` -> `weeklySummarize(<SUMMARY_RESUMMARIZE_WEEK>)`,
        refusing loudly on an unset/invalid property, mirroring the restore wrapper.

- [ ] **Observation, low priority: archive ordering looks inverted.** In the audit table
      the OLDEST weeks (2022-01 -> 2023-05) report `srcInSuppliers: yes` while everything
      from 2023-06 on reports `NO — archived only`. Both are far past the 183-day cutoff,
      so the 2022 rows should already have been archived. Most likely they were
      re-ingested by the recent backfill after the last scheduled `archiveAndPurge_` and
      will sweep on the next scheduled run — harmless either way, since the audit merges
      `_archive`. Worth a glance if it persists past the next Monday run.

- [ ] **Known limit (not a bug): the orphan sweep's blind tail grows one week every
      Monday.** `weeksSkippedPurge` was 3 on 2026-09-09 and rises by exactly 1 per week
      as `auditPurgeCutoff_` advances; those weeks can never be orphan-checked again.
      Two things found while confirming this, both recorded in `summary_audit.gs`'s
      guard comment:
      - The guard's original rationale — *"past that line NEITHER tab holds the source
        rows"* — is **false**. `archiveAndPurge_` deletes from `Suppliers` only;
        `_archive` is append-only and never pruned (verified: no delete/clear touches
        `ARCHIVE_TAB` anywhere). Since FIX 1a added the `_archive` merge, a past-purge
        recompute is no longer structurally empty. The comment described pre-merge code.
      - **The guard should stay anyway**, on the conservative argument instead: it feeds
        a DELETE path, and `_archive`'s completeness for deep history is unverified
        (`INVOICE_PAGE_LIMIT` truncation, pre-dedup duplicate copies). An incomplete
        recompute understates a week and turns live rows into deletion candidates.
        Relaxing it needs proof `_archive` is complete for those weeks first — being
        blind costs detection coverage, being wrong costs data.

- [ ] **Follow-up: split a dedicated `COST_API_TOKEN`.** The producer doc §12
      flags that `?api=wholesaleSales` newly exposes order-level revenue for
      every Leible cafe on a token shared with three other consumers —
      `ORDER_APP_COST_TOKEN` today carries more blast radius than this read
      needs. Out of scope for this phase (touches the Order-app repo); raise
      with Jake next time app-side work is open.
- [ ] **Follow-up: `greenBeanPull` (Tue 05:00) also misses the Monday 08:00
      consumer read.** `LEIBLE_GM_COST_MONITOR` reads the hub every Monday
      08:00 (`docs/api.md`); greenbean spend for the just-completed week isn't
      pulled until the following day, so that Monday read is a day stale on
      the greenbean figure specifically. Not new to this phase — worth a look
      whenever `orderapp.gs` triggers are next touched.

**2. ~~Calendar OAuth scope is missing → EVERY alert is blind.~~ ✅ RESOLVED 2026-09-07.**
`checkIngestStaleness()` now runs clean and WRITES events:
`checked=8, stale=1, eventsCreated=1`. No consent prompt appeared, so the grant
already carried Calendar — this item's premise was stale. Corroborated by a live
`LEIBLE expense stale: food_dairy_co` calendar event created 2026-09-01, i.e.
alerting has worked since that revoke + re-consent, not from today.
The real defect was elsewhere and is fixed in `a903db2`: appsscript.json omitted
`.../auth/documents` while `mayers.gs:284` calls `DocumentApp.openById`, and
test_code.js's `SYMBOL_SCOPES` had no `DocumentApp` entry so the scope gate was
BLIND rather than red. Deployed v46 (`--push-only` → authorize → full deploy).
The one live alert is `coffee_order_app` "never seen" — CORRECT, not a fault:
its writer is `wholesalePull`, still parked at roastery-wholesale steps 7+8.
Why this week's 3-night outage raised nothing: at the 07/09 check food_dairy_co
was ~80h stale against the 96h threshold — correctly silent, would have fired 08/09.

**ORIGINAL DIAGNOSIS (kept for context):**
`raiseCalendarAlert_` fires correctly and then dies at the calendar boundary:
`stalenessCalendar_: getCalendarById/getDefaultCalendar failed — script does not
have permission … Required permissions: …/auth/calendar`. A clean run logs nothing,
so silence has been reading as health.
**Diagnosed 2026-09-01:** running `checkIngestStaleness()` threw the permission
error with **no authorization prompt** — if consent were merely outstanding, Apps
Script would have asked. Calendar is therefore NOT in the statically-inferred scope
set. `installStalenessTrigger()` does NOT grant it either (it only calls
`ScriptApp.*`), so the comment at `staleness.gs:421` is **wrong** — fix it as part
of this work.
**STATUS 2026-09-07:** the explicit `oauthScopes` array was staged in `c722a06`
and is now DEPLOYED (v45) — this item's "currently declares NONE" was stale.
The declared list was INCOMPLETE: `https://www.googleapis.com/auth/documents`
was missing although `mayers.gs:284` calls `DocumentApp.openById` (the whole OCR
path). It shipped missing because test_code.js's `SYMBOL_SCOPES` map had no
`DocumentApp` entry, so BOTH directions of the scope gate were blind to it.
Both are fixed and the gate now reds without the scope. The stale comments at
`staleness.gs:18/277/446` were already corrected in `c722a06`.
**STILL TO DO — Jake at the keyboard:** the `documents` addition is a scope
change, so per `staleness.gs:31` it must ship as `deploy.sh --push-only` →
authorize in the editor → full `deploy.sh`, then re-run `checkIngestStaleness()`
to confirm Calendar alerts finally fire. Until then the DEPLOYED manifest still
omits `documents`; OCR keeps working only on the older, broader grant.

**Original fix note:** declare `oauthScopes` explicitly in `connectors/gas/appsscript.json`. Risk to plan around: the list must cover every scope
the project uses — Sheets, Gmail (read + label), Drive **plus** the Drive advanced
service, `script.external_request`, `script.scriptapp`, Calendar — and a single
omission silently breaks a working connector. It also forces a re-authorization on
the next run. Related: `orderapp.gs:176,212` call `CalendarApp.EventColor` directly,
so `staleness.gs` is not the sole source of that scope despite its comment at
`:18`/`:277`.

**3. Stale ingest feeds — closed, no longer 3.**
- `food_dairy_co` — **RESOLVED 2026-09-02.** Cognito session died 2026-07-18; 46
  runs exited BLOCKED. Re-authed, 22 invoices ($3,025.34) ingested, 6 weeks
  re-summarized and reconciled against the portal to the cent. The two bugs that
  made `--attended` a no-op are fixed (`b2110a9`).
- `roastery` + `recurring` — **unwatched 2026-09-01** (`59bee04`), with a
  NOT_YET_ARMED test bucket pinning their re-add conditions. `checked` went 9 → 7.
  Neither is a live alert; do not re-open them as "3 stale feeds".

**4. Minor, carried: $1.87 stale Summary row in week 2026-08-24 — verify, don't assume.**
`checkSummaryDrift()` 2026-09-01 reported 1 drifted week, net **−$1.87**.
Week 2026-08-24 was re-summarized on 2026-09-02 as part of the FDCo backfill, and
that run logged `duplicatesSkipped=8, summariesUpdated=0` — i.e. every pre-existing
row already matched, which is **consistent with the drift being gone but does not
prove it**. Re-run `checkSummaryDrift()` to confirm before spending time on it.

### Summary drift — SELF-HEALING GUARDS LIVE (phase `summary-self-heal`, 2026-08-26)

**Policy (Jake, 2026-08-25):** everything past the 183-day purge line —
**$288,852.51 across 143 weeks** — is a **deliberate write-off**, not pending
work. Do not "discover" this as an unaddressed bug in a future session; it is
a closed decision, not an omission.

**Two guards now in place**, built in `phases/summary-self-heal/` against the
plan at `C:/Users/mioja/.claude/plans/graceful-brewing-piglet.md`:
- **4-week self-heal window** — `weeklySummarize()` re-heals the last
  `SUMMARY_HEAL_WEEKS` (Script Property, default 4) completed weeks on every
  scheduled run, through the one shared guarded write path `healWeeks_`/
  `healWeek_` (`Code.gs`): snapshot-once backup, SPLIT-week refusal,
  duplicate-key refusal, correction alert, orphan detection — shared by the
  scheduled run and every override (incl. `greenBeanPull_`). Armed by
  `SUMMARY_HEAL_ENABLED` (Script Property, default **off**).
- **`checkSummaryDrift()` weekly alert** — read-only, windowed audit out to the
  183-day purge line; raises at most one Calendar alert per week and
  suppresses SPLIT weeks (they need the archive-aware repair below, not a
  false alarm). Installed via `installSummaryDriftTrigger()` (Monday 07:00
  Australia/Sydney, after `weeklySummarize` 04:00 and clear of the staleness
  watchdog 11:00).

**Genuinely open, out of scope for this phase:**
- [ ] Clean up the **253 redundant `_archive` rows** (113 invoices, up to 7
      copies each) — must happen before any archive-aware repair of the SPLIT
      weeks below.
- [x] **CLOSED (8b1f1bf), 2026-09-07:** Raise or paginate past
      `INVOICE_PAGE_LIMIT = 40`. Pagination was never the bug (the connector
      already followed every page); the cap was. Raised 40 → 60 and a breach
      now raises `PageLimitBreachError` from `run()` *after* the rows read have
      been POSTed — non-zero exit, no data lost, fails every run until dealt
      with, instead of a `print` nobody reads in an unattended job.
- [ ] **Re-measure `INVOICE_PAGE_LIMIT` headroom — the 60 was justified on a
      stale number.** 8b1f1bf's message calls 60 "3.3x the largest measured
      history: Tuga North at 18 pages", but the item it closed had already
      recorded supplier `b180d945` at venue `73cb4dc6` (Leible York) reporting
      **60 pages**. Real headroom is therefore ~1.0x, not 3.3x: the guard is
      `total_pages > INVOICE_PAGE_LIMIT`, so 60 pages passes by exactly one
      page and that venue's history is complete today — but page 61 breaches
      and the nightly run starts failing. Action: re-measure max `totalPages`
      across all supplier+venue pairs (`--list-venues` first — note there are
      two North Sydney accounts and one is dead), then set the cap from the
      real maximum and correct the comment at `connectors/playwright/ordermentum.py:88-102`.
- [ ] The **24 SPLIT weeks — $92,885.74** — still NOT repairable by
      `weeklySummarize` (reads `Suppliers` only, would understate them);
      needs an archive-aware aggregate, blocked on the `_archive` cleanup above.
- [x] **CLOSED (step 9, FIX6), 2026-09-07:** `scripts/execute.py` now has
      `LEGAL_TDD_STATES = {"red_done"}` and `_normalize_tdd_state()`, called at
      the top of `_execute_single_step` for every `tdd:true` step: an illegal
      `tdd_state` (e.g. hand-written `"green_done"`) with real RED evidence on
      record is repaired to `"red_done"` in place (skips a wasteful, sometimes
      impossible RED re-confirmation); without RED evidence the field is
      dropped so RED runs clean. Hand-repaired the 3 live `green_done`
      occurrences found at audit time (`phases/fix-silent-ingest-failures/index.json`
      steps 1/2, `phases/shopspend/index.json` step 8) to `red_done` — all had
      `status: completed` plus both `tdd_evidence.red` and `.green`. Pinned by
      `TestNormalizeTddState` + `TestRunTddGreenViaExecuteSingleStep::test_illegal_tdd_state_with_red_evidence_repairs_to_red_done_and_skips_red`
      in `scripts/test_execute.py`, mutation-checked (fail without the fix).

**Post-verification action:** flip `PRD-12`/`PRD-13` to `built` in
`docs/PRD.md` **only after Jake's live verification** of the self-heal window
and drift guard passes — the same rule `PRD-9`/`10`/`11` followed. Green tests
alone are not that verification.

**Rollback facts an operator needs at 3am:**
- **Kill switch:** `SUMMARY_HEAL_ENABLED` (Script Property, default **off**) —
  controls the WINDOW SIZE only: OFF/default = 1 week (today's single-week
  behaviour, always guarded), ON = `SUMMARY_HEAL_WEEKS` (default 4 weeks).
  The write path stays ACTIVE in both states. **The REAL emergency stop:**
  disable or delete the `weeklySummarize` trigger itself (Apps Script Triggers
  panel) — this halts the scheduled run and all one-off override calls.
- **Data undo (Run-button reachable, both zero-arg):**
  1. Run `listSummaryHealBackups()` from the editor — read-only, logs one
     line per week that has a `Summary_heal_backup` snapshot (week, run_id,
     row count, total), so you can see what's restorable before choosing.
  2. Set the `SUMMARY_RESTORE_WEEK` Script Property to the target week's
     `week_start` (`YYYY-MM-DD`, e.g. `2026-07-06`).
  3. Run `restoreSummaryWeekFromBackup()` from the editor. It reads
     `SUMMARY_RESTORE_WEEK`, refuses loudly (touching nothing) if it's unset
     or unparseable, and otherwise delegates to the internal
     `restoreWeekFromHealBackup_` — not itself Run-button reachable (trailing
     underscore + required arg), which is exactly why step 8 added this
     wrapper — to restore the week from the **earliest**
     `Summary_heal_backup` snapshot for it — snapshot-once by design, so the
     first entry is always the true pre-heal baseline, never a later
     re-heal's value. Locked against a concurrent `weeklySummarize` run;
     refuses with a `{refused:'locked: ...'}` shape instead of racing it.
- **A code rollback does NOT undo a bad heal.** `upsertRows_` writes with an
  in-place `setValue` and has no delete path; `clasp redeploy … -V 39` reverts
  the code, not the data. The backup tab is the only undo.

Full drift root-cause history (why it tripled overnight, the `_archive`
double-count fix, the $288,852.51 reconciliation, the 18-week repair receipt)
archived to `TODO_ARCHIVE.md` — superseded by the guards above, not deleted.

### ✅ Summary self-heal phase — FREEZE LIFTED 2026-08-31, full write half live

Branch `feat-summary-self-heal`, phase `summary-self-heal`, 10 steps. The phase-end
review gate ran **6 rounds** and never returned `approve`; Jake's call after round 5 was
one bounded repair-only round, then freeze regardless of verdict. The write half shipped
frozen on 2026-08-26 and was **unfrozen on 2026-08-31** once the blocker the freeze
existed to hide was actually fixed. `phases/index.json` still reads `error` for this
phase and that stays correct — the gate never approved it; the unfreeze was Jake's
decision, not a gate verdict.

**The unfreeze is a two-key arrangement.** `SUMMARY_HEAL_FROZEN_ = false` removes the
clamp; it does **not** widen anything by itself. Probed on the shipped source:

| State | `summaryHealWindowSize_()` |
|---|---|
| freeze off, no `SUMMARY_HEAL_ENABLED` property — **production today** | **1** (identical to frozen) |
| freeze off, `SUMMARY_HEAL_ENABLED=false` | 1 |
| freeze off, `SUMMARY_HEAL_ENABLED=true` | 4 (`SUMMARY_HEAL_WEEKS_`) |
| freeze off, `+ SUMMARY_HEAL_WEEKS=12` | 12 |

So the scheduled Monday run is **unchanged** by the unfreeze until someone sets the
Script Property. The two destructive entry points now fall through to their own guards
instead of the freeze refusal — `restoreSummaryWeekFromBackup()` →
`{refused:'SUMMARY_RESTORE_WEEK not set'}`, `runSummaryOrphanSweep()` →
`{mode:'aborted', deleted:0}` with no approval record.

| Entry point | State |
|---|---|
| `previewSummaryHeal()` · `checkSummaryDrift()` · `auditSummaryDrift*()` | live (read-only) |
| `listSummaryHealBackups()` · `runSummaryOrphanSweepDryRun()` | live (read-only) |
| single-week guarded `weeklySummarize()` | live — this IS the pre-phase behaviour |
| multi-week heal window | **live**, gated on `SUMMARY_HEAL_ENABLED` |
| `restoreSummaryWeekFromBackup()` | **live**, gated on `SUMMARY_RESTORE_WEEK` |
| `runSummaryOrphanSweep()` (apply) | **live**, gated on a matching dry-run approval |

**To re-freeze:** set `SUMMARY_HEAL_FROZEN_ = true` in `Code.gs` and redeploy. The
refusal machinery was not deleted — it is still asserted by the suite under
`withHealFrozen(...)` (`test_code.js`), the mirror of the `withHealUnfrozen(...)` wrapper
the write-path tests use. Re-arming it is a tested operation.

**CLOSED — the CRITICAL (restore destroyed pull-owned rows), 2026-08-26.**
`restoreWeekFromHealBackup_` deleted every live `Summary` row for a week using **week
alone** as the predicate, then re-appended only the baseline frozen at that week's FIRST
heal. Rows written *after* that baseline that no heal can produce — `shopify_orderapp`
online revenue (written directly, PRD-10) and `Labour` (external `LABOUR_SHEET_ID` pull)
— were destroyed with no recovery path while the restore reported success
(probe: $4,321.55 row, 1 → 0 rows, `{restored:1}`).
**Fix:** the delete predicate is scoped to what the snapshot OWNS. A live row is deleted
only when *either* its full `SUMMARY_KEY_COLS` tuple is in the snapshot (restore it to
baseline) *or* it is not heal-foreign (a heal could have minted it, so the undo must
remove it — including a rename's orphaned old key). Everything else is **preserved**, and
the return reports `{restored, deleted, preserved}` so `{restored:N}` can never be read as
"the whole week is back to baseline".
`SUMMARY_HEAL_FOREIGN_SUPPLIERS_` (`Code.gs`) is the ONE list, shared with
`healOrphanCandidates_`. Deliberately **not** `SUMMARY_AUDIT_PULL_OWNED_`, an audit-*noise*
list that also names greenbean/bennetts — those rows ARE derived from `Suppliers` and ARE
rebuildable by a heal, so the wider list as a write filter would wrongly exempt rows a
heal owns. Mutation-tested: reverting the predicate to `(week)` alone reds 7 assertions,
including the exact probe figure.
⚠ **Still proven by tests only** — this path has never run against live data.

**CLOSED — IMPORTANT 1 (empty-baseline marker ambiguity), 2026-08-26.**
`listSummaryHealBackups()` no longer counts step 9's marker as restorable: a marker-only
week reports `rows:0, total:0, emptyBaseline:true` and is labelled "restoring this week
REMOVES its healed rows".

**CLOSED — IMPORTANT 2 (two incompatible `weeklySummarize` return shapes), 2026-08-31.**
This was *the* unfreeze blocker. The multi-week shape omitted `refused` and every counter,
so `greenBeanPull_`'s completion test (`orderapp.gs`, `if (sumRes && !sumRes.refused)`)
read an all-refused multi-week run as SUCCESS and drained the resum queue — Summary stale
forever, no alert. Two fixes:
- The multi-week return is now a strict **superset** of the single-week one:
  `summariesAdded` / `summariesUpdated` / `labourTabAdded` / `labourSummaryAdded` always
  present, and `refused` set **iff ZERO weeks healed** (a PARTIAL heal is real work, not a
  refusal), carrying the newest week's action so it means what it means single-week.
- `greenBeanPull_`'s completion test is now **positive**: no refusal AND the run reports
  back the week it was asked for. A negative test passes for any shape that merely lacks
  the key.
Mutation-tested: dropping the `refused` assignment → 1 red; reverting to the negative
completion test → 3 red.

**CLOSED — IMPORTANT 3 (orphan sweep in-lock identity re-check), 2026-08-26.**
`summary_audit.gs` re-verifies every candidate's full `SUMMARY_KEY_COLS` tuple against a
fresh `getDataRange()` read taken *inside* the lock and aborts the whole sweep on any
mismatch, before a single backup row or delete. Covered by
`testOrphanSweepStaleIndexAbortsFix3`.

**CLOSED — MINOR ×3, 2026-08-31.**
- `raiseCalendarAlert_` (`staleness.gs`) created the event and decorated it inside ONE
  try. A `setColor`/`setDescription` throw returned 0 and left the dedup cache unmarked
  while the event was already on the calendar — so the same batch created a **duplicate**,
  and the next day's title scan found the phantom and suppressed the real alert. Creation
  is now the success point; decoration is best-effort and logged separately.
- `healWeeks_` seeded `backedUpWeeks` with no `DATE_ARG_RE` guard, six lines after seeding
  `archiveWeeks` **with** one. That map gates whether a destructive heal takes its backup
  first. Junk observed in the RED run: `["", "not a date", "2026-8-3"]`.
- The Labour correction alert built its calendar **title** from the joined healed-week
  list. Alerts dedup on exact title, so it grew with the heal window and re-alerted
  whenever the week set shifted — invisible while the window was clamped to 1, which is
  exactly why it was unfreeze work. Now anchored on the newest healed week plus a count,
  with the full list in the description.
All three mutation-tested (2 / 1 / 2 red respectively).

**CLOSED — the suite went red by the CALENDAR, 2026-08-31.** `todayStr_` used a bare
`new Date()`, which the suite's `withMockNow` (which patches `Date.now()` only) cannot
pin. Every `withMockNow` block silently read the real clock, and
`testSummaryDriftAudit`'s in-flight-week fixture (pinned to wk 2026-08-24…08-30) passed
only while the real date agreed with it. On Mon 2026-08-31 that week completed,
`r.skipped[0]` came back undefined and the **whole file aborted with a TypeError** — every
test after line 7042 stopped running, with no commit involved. `todayStr_` is now
`new Date(Date.now())`; `withMockNow` was made re-entrant (it was handing the real clock
back to an enclosing pin); `testShopifyWeeklyPull` is pinned instead of clock-dependent.
**Lesson: never trust an inherited green count — re-run the suite.**

**CLOSED, 2026-09-07 — harness defect.** Step subagents kept writing `tdd_state:
"green_done"`, a value `scripts/execute.py` never produces (its only terminal write is
`red_done`, `execute.py:715`). Repaired by hand twice and it recurred both times, because
nothing rejected the value at read time. `_normalize_tdd_state()` (`execute.py`, called
from `_execute_single_step`) now repairs/discards any `tdd_state` outside
`LEGAL_TDD_STATES = {"red_done"}` the moment the runner reads it back, instead of a human
having to catch each recurrence. See "step 9, FIX6" above for the hand-repair record.

**STILL OPEN — pre-existing, out of scope:** `orderapp.gs:176` and `:212` call
`CalendarApp.EventColor` directly, so `staleness.gs`'s "THE ONLY SOURCE OF THE CalendarApp
OAuth SCOPE" comment (`:18`, `:277`) is false independently of this phase.
Also still bare `new Date()` and unmocked, each a latent version of the calendar bug
above: `mayers.gs:81,272`, `orderapp.gs:175,211`, `roastery_email.gs:55`, `square.gs:64`,
`staleness.gs:120`.

**What the gate is worth knowing for:** the suite was green at every round —
1292 → 1412 → 1484 → 1497 → 1517 → 1546 → 1589 → 1616, always 0 failed — and caught
**none** of the four CRITICALs. Every one came from the phase-end review. Green tests are
not evidence of safety on this write path.

**Test discipline note.** Every test that exercises a write path runs its body inside
`withHealUnfrozen(...)`; every refusal assertion runs inside `withHealFrozen(...)`. The
shipped-state gate (`FIX3 test0`) reads the constant from the **file on disk**, so a stray
runtime toggle in an earlier test cannot fake it in either direction.

### Mayers statement re-OCR'd every day forever — FIXED 2026-08-15
`mayersDailyPull` only labels a thread once something parsed out of it
(`mayers.gs`, `if (threadParsed > 0)`). A document that can **never** parse therefore
never gets labelled, keeps matching `MAYERS_SEARCH`, and is sent to Drive OCR again
every single day. The live instance is the monthly *"Mayer's Fine Food statement"*.

Evidence (Gmail, 2026-08-15): the Mayers search matches **8** threads;
`expense-ingested` (`Label_24`) covers **7**. The eighth is the 31 JUL statement.
Standing Drive-OCR quota leak, and the likely cause of the rate-limiting that
truncated the 2026-08-14 harvest at 4 of 8 PDFs.

- [x] Fix: an **unparseable-attachment memo** in Script Properties
      (`MAYERS_UNPARSEABLE`), keyed by attachment name + byte size. A document that
      OCR'd fine and still didn't parse is remembered, and its OCR is skipped next run.
      Deliberately **not** a Gmail label on the thread — the thread must stay unlabelled
      so a new attachment added to it is still processed.
      - Only *deterministic* failures are memoed. A thrown OCR (rate limit) is transient
        and is retried, so a bad day can never permanently discard a real invoice.
        `extractMayersInvoiceFromPdf_` now returns `{parsed, deterministic}` to make that
        distinction available at the call site.
      - `MAYERS_PARSER_VERSION` invalidates the whole memo on bump, so every remembered
        document is retried exactly once against a changed parser — that preserves the
        original "unparseable threads stay unlabelled so they're retried after a fix"
        intent. **Bump it as part of the `BLUES ST` fix.**
      - `resetMayersUnparseableMemo()` is a zero-arg editor escape hatch.
      - 33 new tests; this is the first coverage `mayersDailyPull` has ever had
        (`global.GmailApp` was `{}`). Suite 1145 passed / 0 failed.
- [x] ~~**Latent, same defect class, NOT fixed:** `roastery_email.gs` has the identical
      `if (threadParsed > 0)` gate~~ ✅ **PORTED 2026-09-07** (`db41856`, batch A) —
      `roasteryLoadUnparseable_` + the memo now split transient OCR failures from
      deterministic parse failures, so a permanently-unparseable attachment is memoed
      instead of re-OCR'd every run. Entry was stale as of this close-out; corrected.

### Order-app pulls — live bring-up (Jake + Claude, after phase merge)
Code (branch `feat-orderapp-pulls`, phase `orderapp-pulls`) is merged and unit-tested
(1005/1005 green in `connectors/gas/test_code.js`) but **not yet live**. `shopifyWeeklyPull`
(Summary `kind=revenue`, `supplier=shopify_orderapp`, `location=online`, `department=Roastery`)
and `greenBeanPull` (`Suppliers` `source=greenbean`, `department=Roastery`) pull from the
LEIBLE_Order_app read API via `ORDER_APP_COST_TOKEN`. `installOrderAppTriggers()`
(`connectors/gas/orderapp.gs`) is the idempotent trigger installer — delete-then-create,
touches only its own two handler names (`shopifyWeeklyPull`/`greenBeanPull`), never sweeps
unrelated triggers (e.g. `shopSpendWatchdog`). **PRD-10 and PRD-11 stay `planned` in
`docs/PRD.md` until step 7 below is all-green** — flip them only then, same rule PRD-9 followed.

1. ~~Pre-phase gate~~ ✅ **CLEARED 2026-08-06** — `runOnlineRevenueCleanupDryRun` (editor, 14:44)
   returned `found: 0, weeks: []` → closed as a no-op per the decision tree; no Apply, no backup
   tab needed, deadline pressure gone (Monday's `weeklySummarize` has nothing to double-count).
   Scan scope was `kind='revenue' AND location='online'`, case-insensitive, whole `Summary` tab.
2. ~~Token paste~~ ✅ **DONE 2026-08-06** — `ORDER_APP_COST_TOKEN` in Script Properties (proven
   live: the silent shopifyWeeklyPull success path — the "not set — skipping" log never fired).
   Same visit also fixed the READ token: `.env` `GAS_READ_TOKEN` had NEVER matched the live
   `API_READ_TOKEN` — rotated a fresh hex value into both sides; doGet now returns `ok`.
3. ~~Deploy~~ ✅ **DONE** — v27 live (rollback: `clasp redeploy <id> -V 26`).
4. ~~Editor pulls~~ ✅ **DONE 2026-08-06 15:44–15:45.** Editor-log note for the future: both pulls
   RETURN their counts (never Logger.log them) — a fully-clean shopifyWeeklyPull run logs
   NOTHING. Verified via doGet probe instead: exactly one `shopify_orderapp` online revenue row
   per completed week — 07-06 $972.50 / 07-13 $1,522 / 07-20 $1,502.50 / 07-27 $3,089, all
   Roastery, current week absent. Greenbean: Summary row = VENDOR name (`Bennetts`, wk 07-20,
   $14,219 spend, Roastery); `source='greenbean'` only exists on the Suppliers tab.
5. ~~Summarize sweep~~ ✅ **NO-OP** — only one week (07-20) was affected; it resummarized inline
   during greenBeanPull (single override block in the log; the `orderapp.gs:960` "still queued
   beyond the cap" warning never printed → queue empty).
6. ~~Triggers~~ ✅ **DONE 2026-08-06 16:03** — install log confirmed both: "shopifyWeeklyPull
   Monday 05:00 + greenBeanPull Tuesday 05:00 (Australia/Sydney) installed".
7. **Probes** — all `curl -sL` **doGet** with query params, never bare `-d`/`-X POST` (either
   mis-probes `/exec` and gives a misleading 411/Drive-404 on a healthy endpoint):
   - ✅ Order app shopifySales (2026-08-06): `week=2026-W31` (ISO label, NOT a date — a bare
     date gets `BAD_REQUEST`) → `ok:true`, `grossSales=3089`, `meta.weekStart` echoes
     `2026-07-27` — exact match with the hub Summary row.
   - ✅ Order app greenBeanCost (2026-08-06): probed with the PULL'S OWN window
     (`from=2026-06-01`, 1st of month−2) → `grandTotal=$14,219` (3 rows, 985kg, all Bennetts,
     PENDING) — exact match with the hub's Bennetts wk-07-20 row. NB: a wider probe window
     surfaces a May $840 RECEIVED row that is legitimately OUTSIDE the pull window (not lost).
   - ✅ Hub (2026-08-06): exactly one `shopify_orderapp` online revenue row per completed week
     (07-06/07-13/07-20/07-27), Roastery; greenbean spend present as the vendor-named
     `Bennetts` Summary row.
   - ✅ Double-count sweep (2026-08-06): 8-week probe shows shopify_orderapp as the ONLY online
     revenue source; sole other Roastery row is the Bennetts greenbean spend.
   - ✅ Negative (2026-08-06): hub wrong-token → `result:'error'` ("unauthorized"); Order app
     wrong-token → `{ok:false,error:'UNAUTHORIZED'}` on BOTH `shopifySales` + `greenBeanCost`.
   - ✅ Idempotency (2026-08-06 ~16:04): editor re-run of `shopifyWeeklyPull`, then probe —
     row count unchanged (101), same 4 online rows/totals, ALL `summarized_at` stamps still
     from the first run (15:44:58) → `rowsAdded=0, rowsUpdated=0` proven from the Sheet
     (counts are returned, never logged — see memory).
8. ✅ **DONE 2026-08-06 — ALL PROBES GREEN, PRD-10 + PRD-11 flipped to `built`.**

**→ RUNBOOK COMPLETE 2026-08-06.** Both pulls live-verified, triggers armed (Mon/Tue 05:00
Sydney), idempotency + negative-auth + double-count + cross-foot all green. First unattended
runs: shopifyWeeklyPull Mon 2026-08-10, greenBeanPull Tue 2026-08-11 — the staleness watchdog
(168h) now covers both. Archive this section to TODO_ARCHIVE.md next hygiene pass.

### orderapp-pulls — 3 minors carried out of the approved phase (round 10, 2026-08-06)
Phase-end gate returned **approve**; these were noted, not blocking. None is a live correctness bug.

- [ ] `orderapp.gs`: no row-level shape gate on greenbean rows (asymmetric with the shopify
      path) — a malformed/missing `dateLocal` would make `weekStartForDate_` throw AFTER
      Suppliers ingested but BEFORE the resummarize queue persisted (affected weeks lost,
      repeats every run behind the failcount alert). Currently unreachable: the producer drops
      null-dateLocal rows on from/to queries. Add a pre-ingest gate when next in the file.
- [ ] `orderapp.gs`: `orderAppRunSuccess_` stamps the heartbeat even when `remainingQueue > 0`
      (backlog past `GREENBEAN_RESUM_CAP=5` is only a Logger line no trigger-run reader sees).
      Self-draining at 5 weeks/run so bounded; consider a data-quality alert above a backlog
      threshold.
- [ ] Bookkeeping only: step 6 is `done_with_concerns` because the runner was killed between
      commit and review dispatch (committed step → empty diff → cannot re-review). Its code was
      covered by the phase-end rounds; do not mistake it for a completed per-step review.
- **CalendarApp note (step 6):** `orderapp.gs` also touches the CalendarApp OAuth scope for
  fail-open alerts (`greenBeanRunSuccess_`, line ~280). This is a known exception, deliberately
  out of scope for phase `summary-self-heal` CalendarApp audit (staleness.gs documents it).

### shopspend-hardening — 4 minors carried out of the approved phase (2026-08-05)
Phase-end gate returned **approve**; these were noted, not blocking. None is a correctness bug.
All four closed by phase `dopost-auth-minors` (2026-08-05):

- [x] `runner.py` `compute_weeks_complete`: the `paging.truncated` branch now prints the same
      `WARNING` its five siblings do (step 2).
- [x] `connectors/gas/shopspend.gs:85`: degraded-mode log reworded to "for this request" (step 1).
- [x] `connectors/gas/Code.gs:208` `isValidWeekLabelArray_` now bounds the week number to 01-53
      (step 1).
- [x] `docs/api.md` — remediation curl gated on `token`; write-side auth documented (step 4).
- [x] doPost auth decision: option (a) — `weeks_verified_empty` token-gated on `API_READ_TOKEN`
      (phase `dopost-auth-minors`, 2026-08-05). Reusing the READ token was Jake's explicit call
      (over a separate write token) — a leaked read credential therefore also carries the
      tombstone-bypass write capability. Optional future hardening: split out an
      `API_WRITE_TOKEN` (poster + gate change only, no other connector touched).


### Roastery department — ✅ MIGRATED + DEPLOYED 2026-08-03 (version 23)
Branch `feat-roastery-department`. Phase 1 migration runbook executed end-to-end against the
live hub Sheet; `/exec` moved v22 → **v23** on the same deployment id (URL unchanged).
456 GAS tests green.

- [x] **Phase 1 migration Runbook — DONE 2026-08-03.** Backfill: `Suppliers` 715, `_staging` 0,
      `_archive` 319, `Sales` 24, `Labour` 30, `Summary` 96 — apply matched dry run exactly.
      Sweep after deploy: `blanksFilled: 0` on all 5 tabs (nothing wrote during the window).
      **Index-shift canary PASSED** — re-POST of an existing `mayers`/`3429816` row returned
      `rowsAdded:0, duplicatesSkipped:1`, so dedup survived the column add. Revenue upsert
      round-trip verified (`rowsAdded:1` then `rowsUpdated:1`).
      Deviations from the plan, all deliberate:
      - Restore point is a **named Google Sheets version** (`pre-department-migration`), NOT a
        Drive copy — Jake's call. Restore is therefore whole-spreadsheet, not the plan's
        per-tab *Copy to* recipe at lines 507-511.
      - Rollback anchor (code): `clasp redeploy <deploymentId> -V 22 -d 'rollback to 22'`.
      - The plan's canary connector `kent_paper.py` is **dead** — `LOGIN_URL` is still an
        unfilled TODO (`kent_paper.py:23`). Substituted the curl re-POST above, which tests the
        same dedup path against real data and writes nothing when it passes.
      - Required new code: `migrateAddDepartment_`/`sweepBlankDepartments_` are unreachable from
        the Apps Script editor (trailing `_` hides them from the Run dropdown; the Run button
        passes no args, so `dryRun !== false` always resolved to a dry run — the write path would
        have reported success and changed nothing). Added four public zero-arg wrappers
        (`runDepartmentMigration{DryRun,Apply}`, `runBlankDepartmentSweep{DryRun,Apply}`) in
        `Code.gs`, commit `b9d3dc6`.
- [x] **Test C — `doGet` department filter — ✅ PASSED 2026-08-06.** Unblocked by the read-token
      rotation (`.env` `GAS_READ_TOKEN` had never matched the live `API_READ_TOKEN`; fresh value
      typed into both sides per the token-mismatch memory). `department=Roastery` → 0 rows;
      unfiltered same week → 13 Cafe rows with `department` + `kind` + `total`. Rows also carry
      `total_spend` — that's the deliberate one-release alias (`Code.gs:1481`), not a defect.
- [ ] **`weeklySummarize` round-trip verification** (plan line 697) — deliberately deferred: it
      writes to `Summary`, which is exactly what the blocking cleanup below rebuilds. Run it as
      step 0 of that cleanup, not standalone.
- [ ] **(Jake) Step 4.0 — inspect the coffee order app.** Blocks the rest of Phase 4. Checklist
      is in `docs/ingest-contract.md`: where order data lives, stable order ids?, do uploaded
      invoices carry structured date/vendor/amount or are they file-only, can the app POST out.
      **Waiting on the coffee-order-app API key (Jake, 2026-08-03) — parked until that arrives.**
- [ ] **(Jake) Script Properties** — `RECUR_RENT_ROASTERY` / `RECUR_SHOPIFY` (recurring-costs
      phase). The old Shopify pair (`SHOPIFY_SHOP_DOMAIN`/`SHOPIFY_ACCESS_TOKEN`) is obsolete:
      shopify.gs was deleted (superseded by the Order-app pull, PRD-10) — those properties must
      stay ABSENT; the only new property is `ORDER_APP_COST_TOKEN` (see the orderapp-pulls
      live bring-up runbook).
- [ ] **(Jake) Gmail label `roastery/invoices`** + filter, then install the roastery trigger.
- [x] **Per-source staleness thresholds — DONE (orderapp-pulls phase-end round 9).**
      `STALENESS_THRESHOLD_OVERRIDES` in `staleness.gs` (168h for `shopify_orderapp` +
      `greenbean`, 744h/31d for `recurring`); `shopify_orderapp` + `greenbean` are watched in
      `STALENESS_SOURCES`, so a deleted or never-installed trigger now alerts at the first daily
      check after its missed run. `shopspend` stays exempt — its own `shopSpendWatchdog` trigger
      covers it. **Amended 2026-09-01:** `recurring` was subsequently REMOVED from
      `STALENESS_SOURCES` (with `roastery`) — both are unarmed and `recurring.gs:115` stamps only
      `if (rawRows.length)`, so watching them alerts forever by construction. The 744h override
      stays as pre-staged config; re-add conditions + the `NOT_YET_ARMED` test guard are in
      `staleness.gs` / `test_code.js`.
- [ ] `mayers.gs` entry point (`mayersPull`) was never wrapped in `withScriptLock_` — it fell
      outside every phase's declared `Files:` list. Every other entry point is wrapped.
- [ ] Decide: `validateIngest_` accepts a numeric-string `amount` (`"340.00"`) via
      `isNaN(Number(...))`. The plan listed "amount as a string" as a rejection case. Tightening
      it would reject a plausible coffee-order-app payload.
- [ ] `roastery_email.gs` ships ONE vendor parser ("Sample Bean Co", synthetic). Real vendor
      layouts need their own parsers — deliberately no generic fallback.

### Shopify weekly Roastery figure — ⚠️ NOW LIVE (v23, 2026-08-03) — CLEANUP HAS A DEADLINE
`aggregateSupplierRows_` groups `kind='revenue'` rows by **source** when `channel='online'`
(one weekly row per source) and keeps per-customer grain on every other channel. No Shopify
connector change; no new tab.

**This shipped in version 23 on 2026-08-03 as part of the department deploy — it is no longer
"pre-deploy".** The `weeklySummarize` trigger was reinstalled the same day (Monday 04:00
Australia/Sydney), so:

> **Hard deadline: the cleanup below must be done before Monday 2026-08-10 04:00 AEST.**
> That is the next scheduled `weeklySummarize`. If it fires first, the new source-keyed rows
> land alongside the old customer-keyed ones and `doGet` double-counts those weeks.
> If the cleanup can't happen in time, delete the `weeklySummarize` trigger to buy a week
> (`installWeeklySummarizeTrigger` in `Code.gs` restores it).

- [x] **CLOSED AS NO-OP 2026-08-06** — `runOnlineRevenueCleanupDryRun` returned `found: 0`
      (editor run 14:44; log: "DRY RUN — 0 online revenue row(s) across 0 week(s)"). No orphaned
      customer-keyed online rows existed, so no Apply ran and no backup tab was created. The
      deadline above is moot. Original runbook kept below for the record.
      The dedup key includes `supplier`, so any pre-existing customer-keyed `kind='revenue'`
      **online** Summary row is orphaned rather than updated → `doGet` double-counts that week.
      Run these three from the Apps Script editor **in order** (the Run dropdown keeps its last
      selection and re-runs it — check the log's leading text to know what actually ran):
      1. `runOnlineRevenueCleanupDryRun` — writes nothing. Reports `found`, the affected weeks,
         each week's total, and two warnings that must be cleared BEFORE applying:
         `resummarizable:false` (that week's `Revenue` rows are gone — re-summarizing regenerates
         nothing, restore from the backup tab by hand) and `channelCasings` with more than one
         entry (mixed `Online`/`online` collapses on rebuild — fix the casing in `Revenue` first).
         Record the row count and the distinct `week_start` values here.
      2. `runOnlineRevenueCleanupApply` — copies every matched row to
         `Summary_online_revenue_backup` before a single delete fires, then deletes. Scope is
         `kind='revenue'` AND `location='online'`, case-insensitive, and nothing else EXCEPT
         pull-owned `supplier='shopify_orderapp'` rows, which are code-guarded and skipped;
         wholesale revenue keeps its per-customer key and is not touched. Idempotent.
      3. ~~`runOnlineRevenueResummarize`~~ **SUPERSEDED (orderapp-pulls phase, PRD-10):**
         `aggregateSupplierRows_` no longer derives ANY online Summary row from `Revenue`
         (online is pull-owned), so a resummarize regenerates nothing online by design.
         **KEEP `Summary_online_revenue_backup` permanently** — it is the only record of
         pre-pull online figures; go-forward weeks come from `shopifyWeeklyPull`.
      4. Spot-check `doGet?from=&to=` — recent completed weeks show exactly one online revenue
         row (`supplier='shopify_orderapp'`) once the pull is live; no other online rows return.
      Rollback: `clasp redeploy AKfycby...wnfM -V 23` for the code; the backup tab for the rows.
      Implementation `Code.gs:981`; tests `test_code.js` (`v23 grain cleanup` + `round trip`),
      mutation-checked both ways.
- [ ] **Square daily sales never reach the weekly report.** `Sales` is written by `squareDailyPull`
      and read only by `cleanupCorruptSalesRows` (`Code.gs:823`) and the staleness watchdog
      (`staleness.gs:113`). `weeklySummarize` aggregates `Suppliers` + `Revenue` only
      (`Code.gs:1239-1243`) and `doGet` serves `Summary` only (`Code.gs:955`) — so no Square figure
      is reachable via the API at all. Decide whether that's intended.
- [x] **Mixed channel casing silently loses revenue — FIXED 2026-08-26 (summary-self-heal step 6,
      FIX 2).** `aggregateSupplierRows_` now groups on the SAME `.trim().toLowerCase()`
      normalization `rowKey_` uses, so `"Wholesale"`/`"wholesale"` (or any case/whitespace twin)
      SUM into one group instead of splitting into two that collapse onto the same Summary key —
      100 + 25 now reports the full **125**, not 25. Applies to both `Suppliers` (spend) and
      `Revenue` (non-online) rows, since both share `aggregateSupplierRows_`. `healWeek_` also now
      reports a non-zero `duplicatesSkipped` on the heal path instead of discarding it silently
      (FIX 3) — a genuinely converged re-heal still reports 1, distinguishing "already correct"
      from the old "perpetually re-splitting" state.
      **Consequence:** any in-window (last-4-week self-heal / drift-guard) week carrying a real
      case/whitespace-variant supplier or channel will recompute HIGHER than before this fix —
      that's the fix surfacing itself, not a regression. The $288,852.51/143-week write-off above
      is past the 183-day purge line and untouched by this (self-heal/drift-guard never reach
      those weeks); no dollar figure in this file needed updating. Re-check for a live delta on
      Jake's next weekly self-heal run.

### Shopify bring-up — ❌ SUPERSEDED (2026-08-06, orderapp-pulls phase)
The direct Shopify puller (`shopify.gs`) was deleted without ever being activated — its Script
Properties were never set and no trigger ever existed. Shopify online revenue now arrives via
the Order app's `?api=shopifySales` read API (`shopifyWeeklyPull` in `connectors/gas/orderapp.gs`,
PRD-10, `supplier='shopify_orderapp'` Summary rows). Do NOT set `SHOPIFY_SHOP_DOMAIN`/
`SHOPIFY_ACCESS_TOKEN` and do NOT look for `installShopifyTrigger` — both are gone. The live
bring-up steps live in the "Order-app pulls — live bring-up" runbook above.

### Phase 0 — Foundation — ✅ DONE
- [x] Sheet "LEIBLE Expense Hub" created with `Suppliers` / `Sales` / `_staging` tabs + headers
- [x] Bound GAS project created; scriptId + deploymentId in `config/`
- [x] `doPost` → `Suppliers` dedup proven (FDCo 326 rows, Ordermentum 114 rows, re-runs skip)
- [x] Square tokens in Script Properties; `squareDailyPull()` already ran (4 Sales rows for 2026-06-16)
- [x] Square daily trigger installed (2026-06-30). Mayers trigger held — connector not live-verified yet (see Phase 2).

### Phase 1 — Square pilot (GAS-native) — ✅ LIVE (data present)
- [x] `squareDailyPull()` already ran — 4 Sales rows (York/North/Crowsnest/Pitt) for 2026-06-16 in Sheet
- [x] Daily `squareDailyPull` trigger installed 3am AEST (2026-06-30).

### Phase 2 — Mayers (PDF-invoice connector, GAS-native + Drive OCR)
- [x] Email forward set up from Outlook: `jake@leiblecoffee.com.au` → `mio.jake+mayers@gmail.com` (2026-06-30).
- [x] Live-verified on a real invoice — #3429816 (F.Mayer) delivered to `mio.jake+mayers@gmail.com` as a real `application/pdf` attachment, OCR-parsed and ingested (thread carries the success-gated `expense-ingested` label). Connector correctly ignores Outlook signature `image.png` attachments.
- [x] No OCR tuning needed — real-invoice parse succeeded.
- [x] Daily `mayersDailyPull` trigger installed 2026-07-17 (6am AEST) — every source is now unattended.
- [ ] **(Jake)** After the FIRST auto-forwarded invoice lands, sanity-check it parsed (Outlook rule format may
      differ from the manually-forwarded one that was verified).

### Phase 3 — Ordermentum (Tuga Pastry + Butterboy + Fuel Bakery) — ✅ LIVE (2026-06-18; Fuel added 2026-07-20)
- Connector + session + `docs/clickpath-ordermentum.md` exist (API-first).
- [x] **Butterboy fixed (2026-06-18):** `tradingName` match + relabel. See clickpath "Supplier identity gotcha".
- [x] **Live POST verified (2026-06-18):** run 1 → `rowsAdded:1, duplicatesSkipped:113`; run 2 → `rowsAdded:0, duplicatesSkipped:114` (dedup idempotent).
- [x] **`cleanupOrdermentumRows()` run 2026-07-17** — reported `renamed=0, deleted=0` (nothing left to fix in
      `Suppliers`), and the function has been deleted from `Code.gs` as intended. Caveat: it only ever scanned
      `Suppliers`, and an `archiveAndPurge_` ran earlier the same day (93 rows older than 2026-01-15 → `_archive`),
      so any pre-2026 rows still labelled "Wholesale Cookies PTY LTD" are now frozen in `_archive` under the old
      name. Cosmetic only — `_archive` is cold raw data, `doGet` serves `Summary`, and no pre-2026 week is
      summarized. Worth a relabel pass only if `_archive` is ever used for historical analysis.
- [x] Registered `scripts/run_ordermentum.cmd` as Win task "LEIBLE Expense - Ordermentum" — daily 03:20, LogonType=Interactive (runs while logged in). Session ~15-day JWT refresh; re-run `--attended` when it `blocks`.
- [x] 🟢 **OUTAGE RESOLVED 2026-07-20** — Jake re-authed (`--attended`), backfill POSTed all 160 rows,
      re-run proved dedup (`rowsAdded:0, duplicatesSkipped:160`). One-shot `runOrdermentumBackfillJul2026`
      (since deleted, deploy v21) deleted the stale/frozen Ordermentum Summary rows for weeks 06-29 / 07-06 /
      07-13 and rebuilt them via `weeklySummarize` — **all 14 rebuilt rows verified against per-invoice totals
      computed directly from the Ordermentum API**. Labour + other suppliers untouched (kept 07-17 stamps).
      Note: Tuga has **zero invoices after week 06-29** — Fuel Bakery replaced them, so missing Tuga rows in
      later weeks is reality, not lost data.
- [x] **Fuel Bakery added 2026-07-20** — new pastry supplier (replaces Tuga). `"fuel"` appended to
      `SUPPLIER_FILTER`; verified via API probe: legal name = tradingName = "Fuel Bakery" (no Butterboy-style
      mismatch), matches exactly one supplier, active at York/Pitt/Crowsnest (North has no filtered suppliers —
      legitimate). History starts week 2026-06-29; all 3 completed weeks summarized (see above). No GAS changes
      needed (per-row supplier name).
- **This is exactly what the watchdog is for** — it ran blocked for ~2 weeks and nothing said a word, which is
  the same failure `staleness.gs` was written after. The 2026-07-18 11:00 alert on `ordermentum` is the
  watchdog working correctly on its first day.
- [x] **(decision closed 2026-07-20)** Widen `SUPPLIER_FILTER` to ALL Ordermentum suppliers? **No — keep the
      narrow allowlist.** A new supplier is one keyword; the filter is what keeps one-off/test suppliers out
      of the Sheet.
- **Auto-login — ✅ LIVE-VERIFIED (Ordermentum) 2026-07-20.** Headless form-fill fallback fires when the
  session is auth-dead: reads creds from gitignored `.env`, logs in, re-saves session, continues. Reusable
  base primitive (`base_connector.py`) wired into **both** Ordermentum and Fresh & Chill. Kills the
  fortnightly `--attended` ritual; `--attended` stays as manual fallback; 96h watchdog stays as backstop.
  - [x] **LIVE-PROVEN end-to-end (Ordermentum) 2026-07-20:** forced auth-dead → headless auto-login →
        session saved → 161 rows POSTed (`rowsAdded:1, duplicatesSkipped:160`); re-run reused the saved
        session (no login) `rowsAdded:0, duplicatesSkipped:161`. Creds confirmed correct.
  - [x] **SPA async-auth race found + fixed live:** Ordermentum auth is an XHR that sets the cookie ~1s
        AFTER submit (`/v1/profiles/` 401@t+0 → 200@t+1, url→/dashboard), so the original single post-submit
        check false-reported correct creds as "rejected" + tripped the breaker. `credentials_login` now
        POLLS the success signal up to `LOGIN_SETTLE_TRIES`(15)×1s. Same defensive poll applied to F&C.
        See memory `gotcha-spa-login-async-auth-poll`.
  - [x] Ordermentum login form mapped (plain email+password, no MFA/CAPTCHA) → `docs/clickpath-ordermentum.md`
        "Login form" section. Selectors: `#email` / `#password` / `button[type=submit]` (avoid the decoy
        visibility-toggle `button[type=button]`).
  - [x] Base primitive: `.env` parser (first-`=` split, no inline-`#` strip, `os.environ` precedence,
        creds never logged), `auth_state` ok/dead/transient (fires ONLY on genuine 401/403; 5xx/timeout/
        network = transient → blocked, no attempt), per-key circuit-breaker (`sessions/<key>.autologin_blocked`,
        trips on cred-rejection only, cleared by `--attended` or new `--clear-breaker`), `TransientLoginError`.
  - [x] F&C: own DOM-based dead/transient classifier (no status code); per-shop breaker; partial-success
        loop preserved (one shop failing never aborts the others).
  - [x] Tests: **96 pass** (33 connector-suite: cred-parse/breaker/classifier + regression tests for the 3
        review bugs + 4 SPA-poll tests; 63 untouched still green). Independent Opus plan-review + security
        review, all findings folded in.
  - [x] Recurring 10-day "check auto-login health" reminder → Jake's personal calendar (2026-07-30 start).
  - [x] All creds saved to `.env` (Ordermentum + all 4 F&C pairs), confirmed present + well-formed 2026-07-20.
  - [ ] **(Jake)** `.env.example` needs the new var names appended — blocked by the global `Read(**/.env.*)`
        deny + Write-needs-Read deadlock (see memory `gotcha-env-file-read-deny-write-deadlock`). Jake edits it,
        or OKs a Bash-append (writes names only, reads no secrets).
  - [x] **F&C auto-login LIVE-VERIFIED 2026-07-20** — all 4 shops: emptied sessions → auto-login → save →
        scrape (York 58 / North 80 / Crowsnest 34 / Pitt 57 = 229 orders) → POST `rowsAdded:3`; re-run
        reused saved sessions (no login) `rowsAdded:0, duplicatesSkipped:229`. **Fixed a selector bug found
        live:** Zupply/Devise login field is a TEXT `#user_login` (not `type=email`) + `<input type=submit
        name=commit>` (not a button) — assumed-conventional selectors had timed out. Real selectors now in
        `docs/clickpath-fresh_and_chill.md` + `_auto_login_shop`.
  - [x] `.env.example` completed (11-var template, no values) via Bash write-only append (the `Read(**/.env.*)`
        deadlock blocks the Edit/Write tools).
- [ ] ⚠️ **`_archive` double-count risk found 2026-07-20:** the 07-20 backfill re-ingested 2025 Butterboy
      invoices that `archiveAndPurge_` had already moved to `_archive` on 07-17 — dedup only reads `Suppliers`,
      so purged rows aren't remembered. Those rows now exist in BOTH tabs, and the next Monday trigger will
      re-archive them, creating true duplicates inside `_archive`. Cosmetic while `_archive` stays cold raw
      data, but fix before ever analyzing `_archive` (options: dedup `_archive` on write, or a cleanup pass).

### Phase 4 — Food and Dairy Co — ✅ DONE (2026-06-18)
- Route resolved: **not** on Ordermentum; FDCo app is white-labeled **Pepper** → web twin `fooddairyco.pepr.app` (Cognito auth, `api-aus.usepepper.com/v1/graphql`).
- Built `connectors/playwright/food_dairy_co.py` (API-first, both App/Web + "Other" ingested invoices), `docs/clickpath-fdco.md`, `scripts/run_food_dairy_co.cmd`.
- Live-tested end-to-end: 326 invoices (North 86 / Pitt 96 / Crowsnest 65 / York 79) → GAS `rowsAdded:326`; re-run `duplicatesSkipped:326` (dedup OK).
- [x] Registered `scripts/run_food_dairy_co.cmd` as Win task "LEIBLE Expense - Food and Dairy Co" — daily 03:00, LogonType=Interactive. Session ~30-day Cognito refresh; re-run `--attended` (phone OTP) when it `blocks`.

### Phase 5 — Fresh and Chill — ✅ LIVE (2026-06-22)
- Route resolved: **not** WhatsApp after all — F&C now has a web app **`shop.zupply.com.au`** (Zupply Chef, Rails/Devise, plain user+pass, no MFA). **One login per shop** (4 separate accounts).
- Built `connectors/playwright/fresh_and_chill.py` (DOM scrape of `/orders` table; per-shop session loop), `docs/clickpath-fresh_and_chill.md`.
- Delivery date + globally-unique `PO#` ref + GST-inc total from the orders list; credit notes on a separate page (excluded); pagination handled.
- **All 4 shops live 2026-06-22:** seeded (each has its own credentials) + full run → York 36 / North 35 / Crowsnest 23 / Pitt 35 = 129 orders; `rowsAdded:58, duplicatesSkipped:71` (York pre-loaded, dedup OK).
- [x] Added `scripts/run_fresh_and_chill.cmd` (loops all 4 shops) + registered Win task "LEIBLE Expense - Fresh and Chill" — daily 03:40, LogonType=Interactive (2026-06-30).

### Phase 6 — Kent Paper — ⏸️ DEFERRED (2026-06-18)
- Portal (`kentpaper.com.au/ecommerce`) does **not** expose full order history — only recent orders. Weak/incomplete source; skipped for now. Revisit only if a better data route (full history export, email invoices) turns up.
- [ ] **(Jake)** Attended login + click-path map → `docs/clickpath-kent_paper.md`
- [ ] Fill selectors in `kent_paper.py`; test full flow

### Phase 7 — Read API + Weekly Summary — ✅ LIVE + REPAIRED (2026-07-17)
- Token-gated `doGet` serves weekly summaries (supplier + location + total_spend) from `Summary` tab.
- `weeklySummarize()` aggregates last Mon–Sun into `Summary`, archives raw rows > 6mo to `_archive`, purges originals.
- Default (no params) = last completed week; override with `?from=...&to=...`.
- [x] Code + tests written (`Code.gs`, `test_code.js`)
- [x] API docs written (`docs/api.md`)
- [x] Deployed — live `/exec` returns the token gate (verified 2026-07-16, version 17).
- [x] **Summary dedup bug FIXED (2026-07-16)** — `weeklySummarize` keyed dedup on `String(week_start)`, but the
      Sheet returns that cell as a **Date**, so the key never matched its `yyyy-MM-dd` counterpart and every run
      re-appended the whole week. Live `Summary` shows the 06-15 week written **4×**; `doGet` sums `Summary`, so
      spend was over-reported 4×. Same bug fixed in `labourWeeklyPull_` (Labour tab + Summary keys).
      Root cause it survived 209 green tests: the Node mock stored appended dates as the strings they were
      written as, so `String(cell)` round-tripped cleanly in tests and only broke against a real Sheet. Mock now
      coerces bare `yyyy-MM-dd` on write, mirroring Sheets. See memory `sheet-date-coercion`.
- [x] **Live `Summary` repaired 2026-07-17** — one-shot `runSummaryRepair()` (since deleted): `deleted=24,
      conflicts=0`; backfilled 2026-06-22 (`summariesAdded=6, labour=5`) and 2026-06-29 (`summariesAdded=6,
      labour=5`). The 2026-07-06 week had already landed via a manual no-arg run.
      **Verified live:** the follow-up dry run reported `0 duplicate(s), 0 conflict(s)` — a fresh read of the
      real Sheet from inside GAS, which is the only trustworthy proof here. Drive's `contentSnippet` is a
      cached index and still showed the deleted rows ~minutes later; **never verify a just-finished GAS run
      with it.**
- [x] Weekly `weeklySummarize` trigger installed 2026-07-17 (Monday 4am AEST). Safe now that the dedup is
      fixed — it can no longer append a duplicate set each week.
- [x] One-shots removed from `Code.gs` after running clean (2026-07-17): `runSummaryRepair` (hardcoded
      June-2026 weeks — a footgun if re-run later) and `cleanupOrdermentumRows` (Phase 3; final run
      `renamed=0, deleted=0`). `cleanupDuplicateSummaryRows` is **kept** — dry-run by default, and it's the
      detector that proves the invariant if duplicates ever reappear.
- **Editor gotcha that cost a round-trip:** the Run button passes **no arguments**, so
  `cleanupDuplicateSummaryRows(false)` / `weeklySummarize('2026-06-22')` are not runnable from it — and forcing
  it by editing the signature to `function f(false)` is a SyntaxError that blocks saving. Any hand-run function
  taking arguments needs a zero-arg wrapper. See global memory `gas-runtime-limitation-global`.
- [x] `API_READ_TOKEN` set in Script Properties (confirmed by Jake 2026-07-17). Note for future sessions: a bare
      `/exec` returns `unauthorized` whether the property is set or missing, so this is **not** verifiable from
      outside — only `/exec?token=...` distinguishes the two.

### Phase 8 — Labour link (Onboarding app LABOUR_COST sheet) — ✅ LIVE
- [x] `labourWeeklyPull_()` implemented in Code.gs — reads Onboarding app `LABOUR_COST`, writes `Labour` tab + `Summary` rows (`supplier='Labour'`), empty-safe
- [x] `LABOUR_SHEET_ID` set — confirmed live: real Labour rows for week 2026-06-15 are in the hub Sheet (5 locations, $4,203–$7,245).
- [x] Deployed; `Labour` tab materialised.
- [x] **Test coverage added (2026-07-16)** — the labour path was running weekly against real data with **zero**
      tests (its only mention in the suite was a line switching it OFF). Now covered: dedup re-run, Date
      round-trip, and the missing-`LABOUR_SHEET_ID` skip path.
- Note: labour rows only ever landed once, so unlike the supplier rows they were not duplicated — the same
  latent Date-key bug was there, it just hadn't been re-run yet. Fixed before it could bite.

### Phase 9 — Ingest watchdog (staleness.gs) — ✅ ARMED (2026-07-17)
- `checkIngestStaleness` alerts (orange all-day Calendar events) when any of `food_dairy_co`, `fresh_and_chill`,
  `ordermentum`, `square`, `mayers` stops ingesting. Signal = max(newest sheet `extracted_at`, Script-Properties
  heartbeat) — the sheet alone measures last NEW DATA (dedup means a healthy quiet run writes nothing → cries
  wolf); the heartbeat alone doesn't exist until the first post-deploy run (→ everything alerts on day 1).
- `staleness.gs` is deployed and stable (shipped in v17–19, `/exec` healthy throughout).
- [x] `checkIngestStaleness` trigger installed 2026-07-17 (daily 11:00 AEST). The system is now automated AND
      monitored — closing the gap the file's own header warns about ("every scheduled ingest failed silently for
      a month" because nothing was watching).
- Threshold is **96h** — deliberately silent through a normal Fri→Mon (80h), so a weekend never cries wolf.
- Heartbeats are stamped by `doPost` (all Playwright sources), `mayers.gs`, and `square.gs`.
- [ ] **(Jake)** First real run is 11:00 on 2026-07-18. **Expect exactly ONE alert: `ordermentum`** — and it is
      **correct** (see Phase 3). The other four stamp heartbeats on any healthy run, including quiet ones
      (`mayers` stamps even with no invoice — a quiet day ≠ broken, and a broken Gmail scope throws rather than
      faking success; the Playwright sources stamp via `doPost` regardless of dedup). So: one expected alert,
      and **any OTHER alert is real** — investigate, don't dismiss.
- Deliberate asymmetry worth remembering: `square` stamps **only if at least one site had a token**. A revoked
  token makes every site `continue`, so an unconditional stamp there would mean "ran fine, wrote nothing,
  watchdog silent forever" — the month-of-silence failure in new clothes. No token → no heartbeat → alert fires.

### Phase 0 review findings — backlog (triaged 2026-07-22)
Source: `phases/0-foundation/review-result.json` (3 criticals already FIXED + shipped in the
silent-ingest phase). The 15 below were **re-verified against branch HEAD** on 2026-07-22 — the review
ran off a stale phase-0 merge-base, so status here is current, not as-written. **Base for all fixes:
new branch off trunk (`feat/two-tab-foundation`) AFTER the two in-flight PRs land** (harness-v2 + the
3 fixes). Many findings live in files already inside those PRs — do NOT expand the approved PRs.

**P1 — prod-data / security risk**
- [ ] **#1 (IMP) `doPost` has ZERO auth** — `connectors/gas/Code.gs`. Anyone with the `/exec` URL (same URL
      published for the read side in `api.md`) can POST arbitrary rows into `Suppliers`/`Sales`. doGet is
      token-gated via `checkReadToken_`; doPost is not. Fix = shared-secret header/param, mirror the read gate;
      every connector must then send it → GAS redeploy. Effort: M.
- [ ] **#5 (IMP) Connector non-200 swallowed as empty** — `connectors/playwright/ordermentum.py:~130` +
      `food_dairy_co.py:~176`. PARTIAL: now *warns* but still `return []`/`{}`, so a 5xx for one supplier at one
      venue silently drops its invoices while others post; run reports success. Same class as the connector-POST
      bug just fixed — should raise/`mark_blocked`. Effort: S.
- [ ] **#4 (IMP) `deploy.sh` can mint a 2nd deployment** — `scripts/deploy.sh:~72`. First-deploy detection trusts
      `config/deployment.json` alone; if `deploymentId` is blanked, DID resolves empty → `clasp create-deployment`
      branch → 2nd live `/exec`, violating the one-deployment rule. Add a `clasp list-deployments` cross-check
      before minting. Effort: S.

**P2 — data integrity, cheap**
- [ ] **#7 (IMP) Bare `NotImplementedError` crashes unattended run** — `connectors/playwright/base_connector.py`.
      Default `credentials_login()` raises `NotImplementedError` but `_attempt_auto_login` only catches
      `TransientLoginError`; connectors that don't override (FDCo/Kent) crash instead of `mark_blocked`. Effort: S.
- [ ] **#9 (MIN) Missing supplier merges Tuga + Butterboy** — `connectors/gas/Code.gs`. `validateIngest_` doesn't
      require `row.supplier` when `source==='ordermentum'` (SUPPLIER_NAMES intentionally omits it); a missing
      supplier falls through to the raw `'ordermentum'` label, merging both suppliers' spend. Effort: S.
- [ ] **#11 (MIN) `labourWeeklyPull_` silent zeros on header drift** — `connectors/gas/Code.gs`. Indexes
      `col['week_start']` with no existence check → `coerceDateStr_(undefined)` → every row skipped → returns
      zeros indistinguishable from "no labour data yet", traced only by a `Logger.log`. Effort: S.

**P3 — harness / gate safety (tooling, not prod data)**
- [ ] **#2 (IMP) Review gate binds to stale local `main`** — `scripts/execute.py`. `_resolve_review_base` only does
      local `git rev-parse --verify`; origin has no `main`, so every phase review diffs ~5 weeks of unrelated
      history with no warning — defeating the gate. Effort: M.
- [ ] **#3 (IMP) `test_cmd` runs `shell=True` unvalidated** — `scripts/execute.py:~400`. Unlike the deploy path
      (`_validate_deploy_cmd`), `test_cmd` is read fresh from `index.json` (editable by a
      `--dangerously-skip-permissions` session) and run unconditionally. Effort: S.
- [ ] **#12 (MIN) `pre_push_sync` waves through any git error** — `scripts/pre_push_sync.py:~40`. Any non-zero exit
      from `git rev-list --count HEAD..origin/<branch>` (not just true first-push) → exit 0, skipping the
      behind/rebase check. Effort: S.
- [ ] **#14 (MIN) `sync-from-remote.js` hook has never worked** — `.claude/hooks/sync-from-remote.js`. Hardcodes
      `git fetch origin main` throughout; origin default is `feat/two-tab-foundation`, so every SessionStart fetch
      fails and is swallowed. Effort: S.
- [ ] **#15 (MIN) `_eval_verdict` / `_run_probe` untested** — `scripts/test_execute.py`. The pass/fail/retry/escalate
      branching driving the live-verification gate has no direct unit tests (grep returns zero). Effort: M.

**P4 — low impact / robustness**
- [x] **#8 (MIN) Mayers "Sub Total" may match before real "Total"** — **CLOSED 2026-08-14 as not-a-defect**,
      on the real Drive-OCR text from `runMayersOcrHarvest()`. The premise does not hold: Mayers invoices carry
      **no "Sub Total" label at all** (they use `Ex Tax:`). The one genuine near-miss is the `Line Total` column
      header, and the regex's `\.\d{2}` anchor rejects it because no `123.45`-shaped number follows the header.
      The stated risk was a regex-construction worry, not an observed misparse. Keep the `\.\d{2}` anchor — it is
      what makes this safe. Re-open only if Mayers changes its invoice template.
- [ ] **#10 (MIN) `ensureSheet` never validates existing headers** — `connectors/gas/Code.gs`. No comparison vs
      `SUPPLIERS_HEADERS`/`SALES_HEADERS` for pre-existing tabs; a manual column insert/reorder → every `appendRow`
      writes into the wrong columns silently. Effort: M.
- [ ] **#13 (MIN) Kent Paper skeleton crashes on `goto('')`** — `connectors/playwright/kent_paper.py:~22`.
      `LOGIN_URL=''` but `run()` calls `page.goto(LOGIN_URL)` before branching → uncaught invalid-URL error instead
      of the "not implemented" fail-safe. Not in use (Phase 6 deferred). Effort: S.

**Decision (no code) — needs Jake's sign-off**
- [ ] **#16 (MIN) `.gitignore` un-ignores `.claude/{settings.json,hooks/,commands/}`** to share team config,
      contradicting the global "`.gitignore` must exclude `.claude/`" rule. Justified in a comment; means anything
      dropped into those subpaths is committed by default. Confirm this is intended or tighten it.

**Verified FIXED (no action)**
- [x] **#6 (IMP) Force-push guard regex** — `.claude/hooks/block-dangerous.js`. Now catches flag-after-ref and bare
      `-f` (`/git\s+push\b[^\n]*\s(?:--force(?:-with-lease)?|-f)(?=\s|$)/i`); tripped live on a test string.

## Future
- Move Playwright runners to an always-on box
- Telegram notifications when connectors go `blocked`

## Batch candidates
<!-- Work spotted but not done. Append DURING the session, one line each, always naming
     the file/area it touches. Source for the Next batches block at "lets stop here"
     (~/.claude/docs/todo-hygiene.md). -->

### Open security findings (from /security-audit 2026-09-04, verdict `blocked`)
- ~~🔴 INGEST IS DOWN UNTIL THE CUTOVER IS FINISHED~~ ✅ **RESOLVED 2026-09-07.**
  Outage ran three nights (05/09, 06/09, 07/09; last good 04/09), one more than first
  recorded. Cutover completed end to end: five Script Properties + five `.env` values
  set by Jake, deployed as **v45** (deployment id unchanged, `/exec` URL stable, v44 is
  the rollback anchor). `python scripts/verify_ingest_tokens.py` passes 6/6 sources and
  all four spoof probes (`square`/`mayers`/`greenbean`/`shopify_orderapp`) are refused,
  proving the fix is live in PROD. All three connectors re-run clean and the window
  back-filled itself with **no `--backfill`**: food_dairy_co `rowsAdded 0` (nothing new
  over the weekend), fresh_and_chill **+9**, ordermentum **+11 / 1 updated**.
- ~~per-connector ingest tokens to bind `source` to the caller~~ ✅ **DONE + DEPLOYED
  2026-09-07 (v45).** `checkIngestToken_` + `INGEST_SOURCES_` (`connectors/gas/Code.gs`)
  bind each token to one source; connectors carry `INGEST_TOKEN_<SOURCE>`. The HIGH is
  closed in PROD — verified by the spoof probes above, not by assumption.
- ~~Bound `amount`/`total` in `validateIngest_`~~ ✅ **DEPLOYED 2026-09-07 (v45).**
  `isValidIngestAmount_` requires a finite JS number with `|v| <= MAX_INGEST_AMOUNT_`
  (1,000,000); negatives stay legal for credit notes. Numeric strings are REJECTED.
- ~~**`.env.example` still lists no `INGEST_TOKEN_*` names**~~ ✅ **DONE 2026-09-07**
  (commit `98ee3b6`) — all five names present with empty values.
- ~~Bind `department` to the source rather than only enum-checking it~~ ✅ **DONE +
  DEPLOYED 2026-09-07 (v47)**, commit `e7dc6a2`. `INGEST_SOURCE_DEPARTMENTS_` +
  `ingestDepartmentFor_` (`connectors/gas/Code.gs`) bind each source to one department
  (cafe portals → `Cafe`, `coffee_order_app` → `Roastery`, shopspend → none, since
  `SHOPSPEND_HEADERS` has no such column). Omission is untouched and still defaults to
  `Cafe`. A coverage test asserts `INGEST_SOURCES_` and the department map cover each
  other, so a new connector cannot arrive department-unbound. Mutation-checked: disabling
  the guard fails 13 assertions.
- ~~`upsertRows_` silently drops a within-batch dedup-key collision~~ ✅ **DONE +
  DEPLOYED 2026-09-07 (v47)**, commit `6e19bbd`. `upsertRows_` now returns `collisions[]`
  (key, batch index, dropped amount) and `unchangedSkipped`; `duplicatesSkipped` keeps its
  old meaning as the total, so no consumer changed. Each collision is `Logger.log`'d one
  line per row (covers the GAS-native callers that never read the return), `doPost` reports
  `collisionsDropped`, and `BaseConnector.post` warns on stderr. Mutation-checked: 18 / 5 /
  5 assertions across three mutations. Also fixed `makeSheet` missing `getName()`.
- ~~`doGet` maps every live Summary column generically~~ ✅ **DONE + DEPLOYED 2026-09-07
  (v47)**, commit `d7cec57`. `SUMMARY_PUBLIC_FIELDS_` whitelists the nine served fields;
  anything else is dropped whatever its position in the live header row. Deliberately NOT
  derived from `SUMMARY_HEADERS`. Verified against the external consumer before narrowing:
  `LEIBLE_GM_COST_MONITOR` reads only `location`/`supplier`/`total`/`total_spend`/
  `week_start`/`summarized_at`/`kind`, all still served. Live `doGet` probe on v47 returns
  exactly those nine keys.
- ~~`runtime-defense` gate can never pass in GAS~~ ✅ **NO LONGER TRUE, 2026-09-08.**
  That premise died with the global template fix: `check-runtime-defense.cjs` now
  dispatches on runtime instead of probing only the repo root, so it finds our manifest
  at `connectors/gas/appsscript.json` via `.clasp.json rootDir` and grades us as GAS.
  Verified: `node ~/.claude/templates/security/check-runtime-defense.cjs .` → exit 0,
  "✓ runtime-defense (GAS): 13 file(s) scanned, no UNACKNOWLEDGED gaps", with
  `gas-anonymous-web-app` correctly read off `docs/security-baseline.json` as
  acknowledged-not-fixed. The root-only probe used to fall through to the root
  `pyproject.toml` and print a FALSE GREEN ("✓ Python, 18 files") without ever opening
  the ANONYMOUS `doPost` that is this repo's whole attack surface.
- [ ] **Run `/security-audit` on this repo** — now unblocked by the above and never yet
  attempted end to end. Expect the 6 gates to be runnable; the two known shapes to watch
  are `check-security-baseline.cjs` (we have a register) and whether `check-auth-coverage`
  picks HEADLESS mode here (we serve no HtmlService page, so it should — and that is the
  mode that CHECKS `doPost` instead of exempting it).

### Other open work
- ~~Verify the `checkIngestStaleness` daily 11:00 trigger exists~~ ✅ **INSTALLED
  2026-09-07 13:20** — `installStalenessTrigger: daily 11:00 Australia/Sydney
  trigger installed`. It was NOT there before: every calendar alert on record
  (2026-09-01, 2026-09-07) came from a manual editor run, so alerting had never
  actually been autonomous. The log line (`staleness.gs:460`) prints only after
  `.create()` succeeds, and :452-457 deletes any pre-existing handler first, so
  exactly one trigger exists.
  **First unattended run: 2026-09-08 11:00 AEST.** Expect `stale=1` —
  `coffee_order_app` only (writer parked at roastery-wholesale 7+8). Anything
  higher means a connector stopped, since all feeds were stamped fresh 2026-09-07.
- ~~F2 resummarize-queue starvation~~ ✅ **FIXED 2026-09-07.** `orderAppResumSlice_`
  (`connectors/gas/orderapp.gs`) reserves the last slot for the NEWEST week, so the
  other cap-1 still drain oldest-first but a wedge of permanently-refused split weeks
  can no longer starve the newest. Also fixes the run-1 no-heartbeat: a first
  bring-up with all 8 window weeks affected now stamps on run 1 instead of run 2.
  Used by both greenBeanPull and wholesalePull. 11 new tests + case20/case20b
  rewritten (they asserted the starvation); mutation-checked: dropping the reserved
  slot kills 13.
- ~~`roastery_email.gs:93` success-gated label~~ ✅ **PORTED 2026-09-07** (`db41856`).
  It had NOT been ported — verified, not assumed. The port splits transient OCR
  failures from deterministic parse failures so a Drive rate-limit is never memoed;
  34 new tests, first coverage `roasteryDailyPull` has had.
