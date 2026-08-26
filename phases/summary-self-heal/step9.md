# Step 9: bounded-closeout

## Requirements Covered

- `PRD-12` — Summary self-heal window
- `PRD-13` — Summary drift guard

**FINAL STEP. HARD BOUND — read this before anything else.**

Five phase-gate rounds have run. Findings have been real every time, but rounds 4 and 5
found defects almost entirely in code that exists *only because of earlier remediation* —
each fix added surface, which was reviewed, which produced more findings. Jake's decision
(2026-08-26): **one bounded round, then freeze regardless of the gate verdict.**

Therefore, for this step only:

- **REPAIR EXISTING CODE ONLY. Add NO new functions, no new entry points, no new Script
  Properties, no new tabs.** Every fix below is a modification to something that already
  exists.
- If a fix appears to require a new function, it is out of scope: record it in `TODO.md`
  under "known open" and move on. Do not invent surface to close a finding.
- Tests may be added freely — tests are not surface.

## Files to Read

- `connectors/gas/Code.gs` — `healBackupWeek_` at :1999, `healWeeks_` seeding at :2217, `healEarliestBackupRows_`, the Labour alert at :2385
- `connectors/gas/summary_audit.gs` — `previewSummaryHeal` at :458, `listSummaryHealBackups` at :463, `runSummaryOrphanSweep` at :700
- `connectors/gas/Code.gs` `summaryHealWindowSize_` at :2312, `withScriptLock_` usage at :2298 and :1969

## Task

### FIX 1 — IMPORTANT. The backup baseline is falsified for newly-summarized weeks.

`healBackupWeek_`'s snapshot-once guard records **POST-heal** data as the pre-heal baseline
for any week whose first heal had no live `Summary` rows — i.e. every newly summarized week.

`healWeeks_` (`Code.gs:2217`) seeds `backedUpWeeks` only from rows already present in
`Summary_heal_backup`. A first heal of an empty week appends nothing and leaves **no
marker**. The 4-week window re-heals each week ~4 times, so the next run snapshots the
already-healed rows as "the earliest snapshot".

Probe-verified: week `2026-08-17`, 0 `Summary` rows → run 1 heals to 175.25 and writes 0
backup rows → run 2 heals to 999.99 and backs up 175.25 → `healEarliestBackupRows_` returns
175.25, while the true pre-heal baseline was `[]`.

This silently falsifies the explicit "restore the earliest snapshot" promise — the one that
closed a prior CRITICAL.

**Fix within the bound:** the empty baseline must be *recorded as empty*, not left absent.
Write a marker row (or an explicit zero-row sentinel) into the existing
`Summary_heal_backup` tab on a first heal of a week with no live rows, and have
`healEarliestBackupRows_`/`healWeeks_` treat it as a real, earliest snapshot meaning
"restore to nothing". No new function — extend the existing ones.

### FIX 2 — IMPORTANT. The preview lies about blast radius.

`previewSummaryHeal` (`summary_audit.gs:458`) hard-codes a 4-week window while the actual
run sizes its window from `summaryHealWindowSize_` (`Code.gs:2312`) — 1 when
`SUMMARY_HEAL_ENABLED` is off (the default), `SUMMARY_HEAL_WEEKS` when on.

`computeHealPlan_` is genuinely shared, but the week **list** is not, so preview and apply
diverge exactly where the comment claims they "can never diverge". Default state: preview
shows 4, heals 1. With `SUMMARY_HEAL_WEEKS=12`: preview shows 4, heals **12** — the
operator approves one blast radius and gets another, on the only pre-flight look before
real money moves.

**Fix:** `previewSummaryHeal` calls `summaryHealWindowSize_` instead of the literal `4`.
One-line repair. Add a test asserting preview and apply agree on the week list for window
sizes 1, 4 and 12.

### FIX 3 — IMPORTANT. The orphan sweep deletes by stale index with no lock.

`runSummaryOrphanSweep` (`summary_audit.gs:700`) deletes `Summary` rows by **cached row
index** with no script lock. `summaryOrphanSweep_` captures indexes, then the apply loop
deletes them; a concurrent row-deleting path (`restoreWeekFromHealBackup_`,
`cleanupDuplicateSummaryRows`) landing in between shifts those indexes and the sweep deletes
**live, non-orphan rows**.

The backup tab does not cover this: it snapshots only the rows the sweep *intended* to
delete, so a mis-indexed delete removes a live row with **no recovery copy**.

Every other `Summary` write path is wrapped (`weeklySummarize` `Code.gs:2298`, `doPost`,
`greenBeanPull_`, mayers, square, recurring), and step 8 already added `withScriptLock_` to
the sibling `restoreWeekFromHealBackup_` (`Code.gs:1969`) for precisely this hazard.

**Fix:** wrap `runSummaryOrphanSweep` in `withScriptLock_`, matching the sibling. Re-verify
the row identity inside the lock before each delete — match on the full `SUMMARY_KEY_COLS`
tuple, not the cached index alone — and abort the whole sweep if any row no longer matches.

### FIX 4 — MINOR. Labour alert bypasses the shared events cache.

The Labour correction alert (`Code.gs:2385`) calls `healRaiseAlert_` without the shared
`eventsCache` argument, triggering an extra `getEventsForDay` read. Pass the cache, as the
other call sites do.

### FIX 5 — MINOR. `listSummaryHealBackups` does not validate dates.

It builds its week list from `coerceDateStr_(backupRows[i][0])` with no `DATE_ARG_RE`
validation, so a blank or malformed date cell becomes a `''` week entry. Guard it the way
`summary_audit.gs:75-78` and `computeHealPlan_` already do.

### FIX 6 — MINOR. `tdd_state: green_done` keeps recurring.

Step 8 carries `tdd_state: "green_done"` — a value `scripts/execute.py` never produces (its
only terminal write is `red_done`, `execute.py:715`). This was repaired once on steps 0-2
this session and has recurred, so it is systemic: the step subagents write it.

**Fix:** correct step 8's value to `red_done` in `phases/summary-self-heal/index.json`
(`tdd_evidence.red` exists, which is the precondition). Add a line to `TODO.md` under
"known open" recording that the subagents keep emitting this value and that a future harness
change should reject unknown `tdd_state` values at write time rather than letting them
persist.

## Test First

Confirm each FAILS before implementing.

1. First heal of a week with **zero** live Summary rows records an explicit empty baseline;
   a later heal does NOT overwrite it. **This is the probe case — mutation-test it.**
2. `healEarliestBackupRows_` on that week resolves to the empty baseline, not the post-heal values.
3. `previewSummaryHeal` and the scheduled run agree on the week list for window sizes 1, 4, 12.
4. `previewSummaryHeal` with `SUMMARY_HEAL_ENABLED` off previews exactly 1 week.
5. `runSummaryOrphanSweep` refuses with a lock-timeout shape when the script lock is held.
6. A row whose key no longer matches its cached index aborts the sweep and deletes nothing.
7. The Labour alert performs no extra `getEventsForDay` read.
8. A malformed date in `Summary_heal_backup` does not produce a `''` week entry.

## Acceptance Criteria

```bash
node connectors/gas/test_code.js
python -m pytest -q
```

## Verification Procedure

1. Run both AC commands.
2. Mutation-test test 1 and test 6 — both protect against irrecoverable data states.
3. Confirm by `git diff --stat` that **no new function was added** — this step is repair-only.
4. Re-run the phase gate and record the verdict. **The phase freezes after this step
   regardless of that verdict** — any remaining findings are written to `TODO.md` as known
   open items for Jake to review, not fixed in another round.

## Prohibitions

- **Do not add any new function, entry point, Script Property or tab.** Reason: rounds 4 and 5 found defects almost exclusively in surface added by earlier remediation; this step exists to stop that cycle.
- Do not weaken any fail-closed guard added by steps 7 or 8. Reason: those closed a CRITICAL where the undo path destroyed data.
- Do not delete a `Summary` row identified only by a cached index. Reason: this is FIX 3 — re-verify identity inside the lock.
- Do not let a first heal of an empty week leave no backup marker. Reason: this is FIX 1 — an absent marker becomes a falsified baseline on the next run.
- Do not break existing tests.
