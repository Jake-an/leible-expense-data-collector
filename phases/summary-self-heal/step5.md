# Step 5: docs-and-operator-guidance

## Requirements Covered

- `covers: []` — documentation and operator guidance only. `covers_reason` is recorded in
  `phases/summary-self-heal/index.json`. PRD-12 and PRD-13 stay `planned` until Jake's
  live verification passes; do NOT flip them in this step.

## Files to Read

- `TODO.md` — the "Summary drift" active section
- `connectors/gas/summary_drift_repair.gs` — header at :34, operator guidance at :300–302
- The plan at `C:/Users/mioja/.claude/plans/graceful-brewing-piglet.md`

## Task

### 1. Correct `summary_drift_repair.gs` operator guidance (comments only, no logic)

- `:300-302` currently tells the operator that a failure "just means something else held
  the script lock — re-run this, it is idempotent". That is now **wrong** for the new
  refusal reasons: a `refuse-duplicate-keys` week will refuse permanently until
  `cleanupDuplicateSummaryRows(false)` is run. Point the operator there.
- `:34`'s "Idempotent … re-run it freely" is now imprecise: a re-run also writes a
  snapshot-once backup. Soften it and say the backup is snapshot-once so a re-run cannot
  poison the undo.

### 2. `TODO.md` — close the drift section

Record, replacing the open items this work resolves:
- The **policy**: drift past the 183-day purge line ($288,852.51 / 143 weeks) is
  deliberately written off, not pending. Say so plainly so a future session does not
  "discover" it as an unaddressed bug.
- The **two guards** now in place: a 4-week self-heal window (armed by
  `SUMMARY_HEAL_ENABLED`, sized by `SUMMARY_HEAL_WEEKS`) and the weekly
  `checkSummaryDrift()` alert to the purge line.
- The items that remain genuinely open and are **out of scope** here: the 253 redundant
  `_archive` rows, `INVOICE_PAGE_LIMIT = 40` truncation, the 24 SPLIT weeks.
- The post-verification action: flip PRD-12/PRD-13 to `built` only after Jake's live
  verification passes.
- The rollback facts an operator needs at 3am: kill switch is `SUMMARY_HEAL_ENABLED=false`
  (instant, no deploy); data undo is the **earliest** `Summary_heal_backup` snapshot per
  week; a code rollback does **not** undo a bad heal.

Archive anything now finished to `TODO_ARCHIVE.md` per TODO hygiene.

## Acceptance Criteria

```bash
node connectors/gas/test_code.js   # unchanged — this step touches no logic
python -m pytest -q
```

## Verification Procedure

1. Run both suites; both must be green and unchanged from Step 4's counts.
2. `git diff` and confirm the only `.gs` changes are comments.
3. Update this step in `phases/summary-self-heal/index.json`.

## Prohibitions

- Do not change any executable line in `summary_drift_repair.gs`. Reason: this step is comments + docs only; its logic was verified correct in review and is out of scope.
- Do not flip PRD-12/PRD-13 to `built`. Reason: they are not built until live verification passes — the same rule PRD-9/10/11 followed.
- Do not delete the retained Mayers repair artifacts (`Summary_mayers_location_backup`, the 4 `MAYERS_REPAIR_SNAPSHOT_<week>` properties, `restoreMayersLocationSnapshot()`). Reason: deliberately retained.
- Do not break existing tests.
