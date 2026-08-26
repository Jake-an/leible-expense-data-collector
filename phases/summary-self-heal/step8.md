# Step 8: operator-entry-points-and-latents

## Requirements Covered

- `PRD-12` — Summary self-heal window
- `PRD-13` — Summary drift guard

Final remediation step. Gate round 4 returned **no CRITICAL** — 1 IMPORTANT + 3 MINOR.
Severity has converged across four rounds (CRITICAL → IMPORTANT/MINOR → CRITICAL →
IMPORTANT/MINOR → none). These four close it out.

## Files to Read

- `connectors/gas/Code.gs` — `restoreWeekFromHealBackup_` at :1935, `healEarliestBackupRows_` at :1909 (the `row[8]` hardcode), the `SUMMARY_HEADERS.length` slice at :1963, `withScriptLock_` usage at :2273
- `connectors/gas/summary_audit.gs` — `runSummaryDriftRepair` / `runSummaryOrphanSweep` (the operator-wrapper convention to copy)
- `connectors/gas/staleness.gs` ~:296 — `raiseCalendarAlert_`'s per-call `getEventsForDay`
- `TODO.md` :67-69 — the runbook line that names an unrunnable function

## Task

### FIX 1 — IMPORTANT. The documented undo cannot actually be run.

`TODO.md:67-69` tells the 3am operator to "run `restoreWeekFromHealBackup_('YYYY-MM-DD')`
from the editor". That is not possible:

- Apps Script treats a **trailing underscore as private** — the function is excluded from
  the editor's Run picker and from `google.script.run`.
- It takes a **required argument** the Run button cannot supply.

So the only documented data undo, for the only irreversible write path in this phase, is
unreachable at exactly the moment it is needed. It does at least fail closed (invoked with
no arg, `week` is `undefined`, nothing matches, it returns `{refused:'no-snapshot'}`), but
"safe when unusable" is not a recovery path.

Every other operator-facing entry point here is a no-underscore, zero-arg wrapper:
`runSummaryDriftRepair`, `runSummaryOrphanSweep`, `cleanupDuplicateSummaryRows`,
`previewSummaryHeal`, `auditSummaryDrift`. Follow that convention exactly:

- **`listSummaryHealBackups()`** — zero-arg, read-only. Logs **one line per week** that has
  a snapshot (week, run_id, row count, total), so the operator can see what is restorable
  before choosing. One line per item, never one big `Logger.log(JSON.stringify(...))` —
  the editor truncates that.
- **`restoreSummaryWeekFromBackup()`** — zero-arg. Reads the target week from a Script
  Property (`SUMMARY_RESTORE_WEEK`), refuses loudly if unset or unparseable, and otherwise
  delegates to the existing `restoreWeekFromHealBackup_`. Keep every fail-closed guard step
  7 added.

Then **rewrite the `TODO.md` runbook** to name the functions that actually exist and the
property to set, in the order an operator performs them. The runbook must be executable
top-to-bottom by someone who has not read this phase.

### FIX 2 — MINOR. Lock the restore.

`restoreWeekFromHealBackup_` reads the live `Summary` range, then deletes that week's rows
and appends the snapshot, with **no `withScriptLock_`** — unlike `weeklySummarize`
(`Code.gs:2273`) and every scheduled/ingest entry point.

Sibling manual tools (`cleanupDuplicateSummaryRows`, `runSummaryOrphanSweep`) are also
unlocked, so this is existing convention rather than drift introduced here, and the
delete-backwards loop is index-safe against `appendRow`. **But this tool is explicitly
documented for 3am incident use, when the 04:00 `weeklySummarize` trigger may fire.** A
concurrent heal's upsert can interleave with the restore's delete+append and be silently
lost. Wrap it — it already returns a `{refused:...}` shape, so the lock-timeout case costs
nothing to express.

### FIX 3 — MINOR. Two encodings of the same fact will disagree.

`healEarliestBackupRows_` (`Code.gs:1909`) hardcodes `row[8]` as `run_id`, while its only
caller slices restored rows with `SUMMARY_HEADERS.length` (`Code.gs:1963`). Both are correct
today (`SUMMARY_HEADERS` has 8 entries; `SUMMARY_HEAL_BACKUP_HEADERS =
SUMMARY_HEADERS.concat(['run_id'])`) — and they disagree the moment a column is added:
`run_id` moves while `row[8]` keeps reading a data column, so snapshot tie-breaking would
silently mix two snapshots and the restore would write a **blended week**.

This is the same latent class as this project's documented "header consts do not migrate
live tabs" gotcha. Introduce a single named constant (`SUMMARY_BACKUP_RUNID_COL =
SUMMARY_HEADERS.length`) and use it in both places. Add a test asserting the two stay in
agreement.

### FIX 4 — MINOR. Calendar read amplification.

The `raiseCalendarAlert_` extraction (`staleness.gs:~296`) moved the `getEventsForDay` read
**inside** the per-alert primitive. `stalenessRaiseAlerts_` previously did ONE calendar read
per batch and tested each title against that map; it now re-reads the day's events once per
alert. Same for `healRaiseAlert_`, which fires per healed week (up to 4 per run) plus per
SPLIT/duplicate refusal.

Behaviour and correctness are unaffected — this is Calendar read-quota and latency on a
scheduled path. Memoize the day-read per invocation, or hoist it back to the caller and pass
the map in. Do not change the idempotency semantics while doing it.

## Test First

Confirm each FAILS before implementing.

1. `listSummaryHealBackups()` is zero-arg, writes nothing, and logs one line per snapshotted week.
2. `restoreSummaryWeekFromBackup()` with `SUMMARY_RESTORE_WEEK` unset refuses loudly and deletes nothing.
3. Same with an unparseable property value — refuses, deletes nothing.
4. With a valid property and a valid snapshot, it restores exactly the earliest snapshot's rows.
5. Neither new entry point name ends in an underscore (assert on the exported names).
6. The restore refuses with a lock-timeout shape when the script lock is held.
7. `run_id` column resolution comes from one constant — a test that adds a column to `SUMMARY_HEADERS` keeps both call sites in agreement.
8. The day's calendar events are read **once** per invocation regardless of how many alerts are raised, and idempotency still holds.

## Acceptance Criteria

```bash
node connectors/gas/test_code.js
python -m pytest -q
```

## Verification Procedure

1. Run both AC commands.
2. **Read `TODO.md`'s runbook top-to-bottom and confirm every function it names exists, is
   zero-arg, and has no trailing underscore.** This is the whole point of FIX 1 — verify it
   as an operator would, not by grep.
3. Mutation-test FIX 3: add a column to `SUMMARY_HEADERS` and confirm test 7 catches the drift.
4. Re-run the phase gate. It must return `approve`.

## Prohibitions

- Do not document any operator procedure that names an underscore-suffixed or argument-taking function. Reason: Apps Script hides those from the Run picker — this is the exact defect being fixed.
- Do not weaken any fail-closed guard step 7 added to the restore path. Reason: those close a CRITICAL where the undo destroyed data.
- Do not change `raiseCalendarAlert_`'s idempotency behaviour while optimizing its reads. Reason: duplicate alerts on the corruption channel were a prior finding.
- Do not refactor `orderapp.gs`'s CalendarApp calls. Reason: pre-existing, out of scope, already noted.
- Do not break existing tests.
