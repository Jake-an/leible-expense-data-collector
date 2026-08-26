# Step 7: restore-path-and-runbook-fixes

## Requirements Covered

- `PRD-12` — Summary self-heal window
- `PRD-13` — Summary drift guard

Second remediation step. Phase gate round 3 returned 1 CRITICAL + 2 IMPORTANT + 3 MINOR.
**The CRITICAL was introduced by step 6's own fix** — read FIX 1 with that in mind: this
step is repairing the repair, so it gets adversarial tests, not just a patch.

## Files to Read

- `connectors/gas/Code.gs` — `restoreWeekFromHealBackup_` at :1933, `healEarliestBackupRows_` at ~:1902, `summaryHealWindowSize_` at :2253, `weeklySummarize_impl_` labour alert at ~:2330, `healOrphanCandidates_`
- `connectors/gas/summary_audit.gs` — `summaryOrphanSweep_`'s purge-line guard (the correct pattern for FIX 5)
- `connectors/gas/staleness.gs` :18 and :277 (the false invariant comments)
- `connectors/gas/test_code.js` :8231 (the test proving the switch still writes), ~:9190-9192 (the Code.gs-only grep assertion), ~:9200 (the vacuous FIX5 test)
- `TODO.md` :61-70 (the 3am runbook)

## Task

### FIX 1 — CRITICAL. The undo path destroys data before checking it can restore.

`restoreWeekFromHealBackup_` (`Code.gs:1933`) deletes ALL live `Summary` rows for the week
**before** checking the snapshot is non-empty. When `Summary_heal_backup` holds no snapshot
for that week — the state of every week never healed, i.e. all ~169 pre-existing weeks — it
destroys the week's `Summary` and restores nothing, then returns `{restored:0}` and logs
"restored 0 row(s)", which reads as a benign no-op.

Proven with a probe: **2 rows / $350 in, 0 rows / $0 out.** `upsertRows_` only appends and
`setValue`s, so there is no path back, and `TODO.md:64-70` names this the ONLY data undo.

Fix:
- **Early return when `snapshotRows` is empty — before any delete.** Return a distinct,
  loud result (e.g. `{refused:'no-snapshot', week:…}`), never `{restored:0}`, which is
  indistinguishable from success.
- Null-guard `summSheet`.
- Read the snapshot, validate it, and only then touch live rows. Restore must be
  fail-closed: if anything about the snapshot is unreadable, change nothing.

This function currently has **zero callers and zero tests**, so it is not reachable today —
the danger is a human following the runbook during an incident. Give it real coverage.

### FIX 2 — IMPORTANT. The documented emergency switch does not stop writes.

`TODO.md:61-63` says `SUMMARY_HEAL_ENABLED=false` "stops the self-heal write immediately".
It does not. `summaryHealWindowSize_` (`Code.gs:2253`) returns 1 when off, and
`weeklySummarize_impl_` still routes that week through `healWeeks_` → `healWeek_` →
`upsertRows_`. The suite asserts the write happens (`test_code.js:8231`, 100 → 175.25).
`Code.gs`'s own comment is accurate; the runbook contradicts it.

An operator flipping the documented switch mid-incident still gets `Summary` writes.

Decide and implement ONE, then make code, comment, test and runbook agree:
- **(a) Preferred — make the runbook true to the code.** Rewrite `TODO.md` to say the
  switch controls *window size only* (4 → 1) and that the gates stay active. Then document
  what the actual emergency stop is: delete/disable the `weeklySummarize` trigger. Say so
  explicitly, since that is the thing an operator needs at 3am.
- **(b) Make the code true to the runbook** — add a genuine write-disable that skips
  `healWeeks_` entirely. Only choose this if a real stop switch is wanted; it is a
  behaviour change and needs its own test that asserts **zero** writes.

Either way the phrase "stops the self-heal write immediately" must not survive unless it
is literally true.

### FIX 3 — IMPORTANT. The FIX5 regression test passes vacuously.

The test at ~`test_code.js:9200` ("`healEarliestBackupRows_` is either called by production
code or removed") is satisfied by one dead function calling another: its only caller is
`restoreWeekFromHealBackup_`, which itself has no callers, no tests and no doc reference.
It cannot detect the dead-code condition it was written to catch.

Assert **reachability from a live entry point**, not mere textual reference. If FIX 1 wires
`restoreWeekFromHealBackup_` into a documented, callable restore entry point, this resolves
naturally — that entry point becomes the anchor the test checks.

### FIX 4 — MINOR. The "Labour correction" alert cries wolf weekly.

`weeklySummarize_impl_` ~:2330 fires whenever `labourResult.summaryAdded + summaryUpdated > 0`.
`summaryAdded` counts **brand-new** rows, so an ordinary first-time labour insert for a
fresh week trips it on every scheduled run — a weekly calendar event labelled "correction"
when nothing was corrected. Gate on `summaryUpdated` (or `upsertRows_`'s `updates` array)
alone. `'Labour correction'` currently has 0 references in `test_code.js`; add one.

### FIX 5 — MINOR. `healOrphanCandidates_` needs the purge-line guard.

It lacks the `auditPurgeCutoff_` guard `summaryOrphanSweep_` applies. On a manual
`weeklySummarize('<old-week>')` override past the 183-day line, neither `Suppliers` nor
`_archive` holds the source rows, the recompute is empty, and every live `Summary` row is
reported as an orphan candidate — while the correctly-windowed sweep will always refuse to
act on them. The alert names rows the removal path cannot touch. Scheduled runs are
unaffected (last 4 weeks only). Apply the same guard.

### FIX 6 — MINOR. Make the CalendarApp invariant comments true, or delete them.

`staleness.gs:18` and `:277` claim that file is "THE ONLY SOURCE OF THE CalendarApp OAuth
SCOPE" / "the ONLY functions in the project that touch CalendarApp". **False** —
`orderapp.gs:176` and `:212` call `CalendarApp.EventColor.ORANGE` directly and predate this
phase. The FIX1 test comment says "no file other than staleness.gs references CalendarApp"
while the assertion only greps `Code.gs` (`test_code.js:9190-9192`), so `orderapp.gs` is
never checked.

No functional impact — the scope is granted either way. But a false invariant comment is
worse than none, because the next person trusts it. Either:
- correct the comments to name `orderapp.gs` as a known exception, and widen the test
  assertion to grep all of `connectors/gas/*.gs` with `orderapp.gs` explicitly allowlisted; or
- state the invariant as an intent with a recorded exception.

Write the `TODO.md` note step 6's brief required and did not deliver.

**Do not refactor `orderapp.gs` itself here** — pre-existing, out of scope, note it.

## Test First

Confirm each FAILS before implementing.

1. `restoreWeekFromHealBackup_` on a week with NO snapshot deletes **nothing** and returns a
   loud refusal — assert live rows and totals byte-identical afterwards. **This is the
   $350→$0 case; mutation-test it.**
2. Same, with a null/missing `Summary` sheet — no throw, no write.
3. A malformed snapshot refuses rather than partially restoring.
4. A valid snapshot restores exactly the earliest snapshot's rows.
5. `SUMMARY_HEAL_ENABLED=false` behaves exactly as documented — whichever of FIX 2 (a)/(b)
   is chosen, the test asserts the documented behaviour literally.
6. The `healEarliestBackupRows_` guard fails when the chain is dead-code-only (i.e. it
   would have caught the vacuous case).
7. A first-time labour insert raises **no** "Labour correction" alert; a genuine labour
   change does.
8. `healOrphanCandidates_` reports zero candidates for a week past `auditPurgeCutoff_`.
9. The CalendarApp assertion greps all of `connectors/gas/*.gs`, not just `Code.gs`.

## Acceptance Criteria

```bash
node connectors/gas/test_code.js
python -m pytest -q
```

## Verification Procedure

1. Run both AC commands.
2. Mutation-test test 1: remove the early return and confirm it goes red.
3. Confirm `TODO.md`'s runbook and the code agree on the kill switch — read both, side by side.
4. Re-run the phase gate. It must return `approve`.

## Prohibitions

- **Do not delete any live `Summary` row before the replacement data is read and validated.** Reason: this is the exact CRITICAL being fixed; the undo path has no undo.
- Do not let any restore path return `{restored:0}` on failure. Reason: indistinguishable from a successful no-op, which is how this hid.
- Do not leave `TODO.md` claiming a stop the code does not implement. Reason: an operator relies on it during an incident.
- Do not refactor `orderapp.gs`'s CalendarApp calls. Reason: pre-existing and out of scope; note it in `TODO.md`.
- Do not weaken any existing guard to make a test pass.
- Do not break existing tests.
