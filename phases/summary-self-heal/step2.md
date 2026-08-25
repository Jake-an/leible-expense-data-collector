# Step 2: guarded-shared-write-path

## Requirements Covered

- `PRD-12` — Summary self-heal window

**This is the step that writes live financial totals.** If the Task section contradicts
`docs/ADR.md` or a CRITICAL rule in CLAUDE.md, set `"status": "needs_context"` and stop.

## Files to Read

- `connectors/gas/Code.gs` — `weeklySummarize` at :1793 (note `withScriptLock_` wraps the WHOLE entry point at :1798), `weeklySummarize_impl_` at :1806, `archiveAndPurge_` at :1905, `upsertRows_` at :609, `cleanupDuplicateSummaryRows` at :1161, `installWeeklySummarizeTrigger` at :1945
- `connectors/gas/orderapp.gs` — `GREENBEAN_RESUM_CAP` at :514, the resummarize loop at :811-857, `greenBeanPull_impl_` at :714
- `connectors/gas/summary_drift_repair.gs` — :37-56 (its own zero-`_archive` predicate), :230 (4-minute budget), :263-284 (how it consumes `res.refused`)
- `connectors/gas/mayers.gs` :427 and the restore path at :617 (backup-tab precedent)
- Step 0's `computeHealPlan_`

## Task

### 1. `healWeeks_(weeks, ctx)` and `healWeek_(week, ctx)`

One write path, used by **both** the scheduled run and the override branch.

**`ctx` is built ONCE per entry point** by `healWeeks_`, never per week. It holds the
`_archive` week Set and the `Summary` snapshot. This is not an optimization —
`greenBeanPull_` makes up to `GREENBEAN_RESUM_CAP = 5` override calls per run, *after* a
20-page fetch, a full `Suppliers` snapshot and an orphan scan, and is already near the
6-minute ceiling where a timeout is a partial-ingest event. The override branch reads
neither tab today (`Code.gs:1812` only `ensureSheet`s `_archive`; archive/purge is skipped
on `ovr` at :1884-1888), so a per-week build would add five full `_archive` reads to that
path. `runSummaryDriftRepair`'s 4-minute budget (:230) would likewise absorb the cost
silently as fewer weeks per run.

Weeks are healed **newest-first**, so a mid-run death leaves the most recent weeks done —
*unless* the death lands inside wk-1's own write, which the per-week backup makes
recoverable. Do not overstate this in comments.

Per week, in this order:

1. **Backup, snapshot-once.** Copy the week's existing `Summary` rows to
   `Summary_heal_backup` with a `run_id` stamp column. **If a snapshot for that week
   already exists, do not overwrite it.** Without this the backup is append-only: healing
   week W twice would store *post-heal* values as a later snapshot, and "restore from
   backup" would restore the corruption. Restore rule is the **earliest** snapshot per
   week — document it in the tab header comment and in `TODO.md` (Step 5).
2. **SPLIT guard** — `computeHealPlan_` returns `skip-split`; honour it, write nothing.
3. **Duplicate-key refusal** — `computeHealPlan_` returns `refuse-duplicate-keys`; write
   nothing and alert. `upsertRows_` builds `idx` in a forward loop (:612-614) so it keeps
   the LAST twin and would half-update the week.
4. Write via one `upsertRows_` call for that week.
5. Run Step 3's orphan detection for the week and fold its finding into the same alert.
6. **Raise the per-week alert immediately** — never batched to the end of the run. A death
   between the writes and a batched alert moves money silently, and `checkSummaryDrift()`
   detects *drift*, not *corrections*, so it would never backfill the notice.

### 2. Wire both branches

`weeklySummarize_impl_` selects weeks, then calls `healWeeks_`:
- override supplied → a one-element list, archive/purge still skipped
- no override → the last N completed weeks

**Branch differences must reduce to exactly two:** week selection, and archive/purge
(scheduled only). Every safety gate is shared. This deliberately brings `greenBeanPull_`'s
existing unguarded override writes under the same protection.

### 3. Kill switch

- `SUMMARY_HEAL_ENABLED` (Script Property, default **off**) controls only **how many weeks**
  are healed: off means 1, on means `SUMMARY_HEAL_WEEKS` (Script Property, default 4).
- **The gates are always active in both states.** "Off" means "today's single-week
  behaviour, now guarded" — never "gates bypassed".
- Script Property is `SUMMARY_HEAL_WEEKS` (no trailing underscore); the in-code default
  constant is `SUMMARY_HEAL_WEEKS_`. Two names because they are two things.

Reason this exists: the Monday 04:00 trigger is already installed (:1945-1958) and
`scripts/deploy.sh` pushes the whole project, so without the switch, deploying the code
arms an unattended production write before anyone has read the preview.

### 4. Newest-week failure is loud

Routing wk-1 through the gates changes the current production path: today wk-1 is always
written, if imperfectly; now it can be refused or skipped and **not written at all**. The
current week is what every report and `LEIBLE_GM_COST_MONITOR` reads. So a SPLIT-skip or
duplicate-refusal of the **newest** week raises the alert at **high severity** and the run
must not report success. A silently un-summarized current week is worse than a slightly
wrong one.

## Test First

Write these in `connectors/gas/test_code.js` and confirm they FAIL first.

1. Scheduled run heals exactly wk-1..wk-4, newest first; wk-5 untouched.
2. Kill switch off means window = 1 **and wk-1 is still written with gates active**; on means full window.
3. A refused or skipped **wk-1** raises a high-severity alert and the run does not report success.
4. `ctx` is built once: a 5-week override loop performs **one** `_archive` read, not five.
5. **SPLIT guard** — a week with an `_archive` row is skipped and its live total is byte-identical afterwards. **Mutation-test this**: break the guard and confirm a test fails.
6. **Duplicate-key refusal** — refused and alerted, not half-updated.
7. Backup is written before any `setValue` for that week.
8. **Backup idempotency** — healing the same week twice does not overwrite the first snapshot; the restore helper resolves to the earliest.
9. **Override path gets the same gates** — an override call backs up, refuses duplicates and detects orphans exactly like the scheduled path.
10. `archiveAndPurge_` runs exactly once per scheduled run and never on an override.
11. A `Bennetts` row with a blank `location` **IS** summarized (no pull-owned filtering).
12. A `shopify_orderapp` online revenue row is untouched by a heal.
13. Correction alert fires per week off actual `updates`, including a labour-only correction; silent when nothing changed, **including a greenbean override re-summarize of an unchanged week**.

## Acceptance Criteria

```bash
node connectors/gas/test_code.js   # all suites green, including every case above
```

## Verification Procedure

1. Run the AC command.
2. **Mutation-test case 5** — disable the SPLIT guard, confirm a test goes red, restore it. A guard nothing tests is not a guard.
3. Read the diff against every Prohibition below. Green tests do not prove a prohibition was honoured (documented project lesson).
4. Update this step in `phases/summary-self-heal/index.json`.

## Prohibitions

- **Do not build `ctx` per week.** Reason: five extra full-tab reads on a path already near the 6-minute ceiling, where a timeout is a partial-ingest event.
- **Do not attach the gates to the non-override branch only.** Reason: `greenBeanPull_` writes through the override branch up to 5 times per run and would stay unguarded — the same hazard this step exists to close.
- **Do not filter the batch against `SUMMARY_AUDIT_PULL_OWNED_` or any supplier list.** Reason: CRITICAL caught in plan review — greenbean rows are derived, filtering drops real money and alerts it as missing forever.
- **Do not delete any `Summary` row in this step.** Reason: deletion is Step 3's gated, backed-up, manual path; `shopify_orderapp` rows are unrebuildable.
- Do not re-summarize a week that has `_archive` rows, under any circumstance. Reason: `weeklySummarize` reads `Suppliers` only, so it overwrites a correct total with a partial one — missing money becomes understated money, which hides far better.
- Do not let the heal reach past the 183-day purge line. Reason: those 143 weeks and $288,852.51 are deliberately written off; touching them invalidates the verification assert.
- Do not assert success via `summariesAdded + summariesUpdated`. Reason: goes `NaN` on refusal paths and makes the assertion vacuous in both directions.
- Do not use bare `new Date()`. Reason: `withMockNow` patches only `Date.now()`.
- Do not break existing tests.
