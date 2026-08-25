# Step 4: drift-guard-and-calendar-helper

## Requirements Covered

- `PRD-13` — Summary drift guard

If the Task section contradicts `docs/ADR.md` or a CRITICAL rule in CLAUDE.md, set
`"status": "needs_context"` and stop.

## Files to Read

- `connectors/gas/staleness.gs` — the WHOLE file. Its header states the CalendarApp OAuth-scope invariant; :60 documents why trigger handlers take zero arguments; :275-330 is `stalenessCalendar_` / `stalenessRaiseAlerts_`; :341-360 is the trigger installer and its timing rationale
- `connectors/gas/summary_audit.gs` — `auditSummaryDrift_` at :51 (with Step 0's `minWeek`), `auditPurgeCutoff_` at :337, `auditLogReport_` at :345
- `connectors/gas/orderapp.gs` :1001 — `installOrderAppTriggers`, the idempotent delete-then-create installer shape
- `connectors/gas/test_code.js` :199 — the existing `CalendarApp` mock

## Task

### 1. Extract `raiseCalendarAlert_` into `staleness.gs`

`staleness.gs` is deliberately documented as the **ONLY** source of the `CalendarApp` OAuth
scope. Keep that literally true: the new helper lives in `staleness.gs`, and the drift code
calls it (GAS is a flat namespace, so cross-file calls are free).

`raiseCalendarAlert_(title, bodyLines, color, nowMs)`:
- resolves the calendar via the existing `stalenessCalendar_` fallback chain, never throws
- idempotent within a day via the existing "titles already on the day" read
- takes `bodyLines` as an **array**, joined into the description — callers must not
  hand-build one long blob

Refactor `stalenessRaiseAlerts_` onto it so there is exactly one calendar path, not two.
Its existing behaviour and tests must not change.

**No new OAuth scope is added** — scopes are project-level and `CalendarApp` is already
consented — so the `deploy.sh --push-only` authorize dance is NOT needed here. Do not add it.

### 2. `checkSummaryDrift()`

**Zero-argument** trigger handler. A time-based trigger passes an event object as argument
1; `staleness.gs:60` documents that as exactly what corrupted the `Sales` tab (Fault 3).
All logic lives in an injectable `summaryDriftCheck_(nowMs)` so it is testable.

Behaviour:
- windowed audit from `auditPurgeCutoff_(todayStr_())` — reuses `ARCHIVE_RETENTION_DAYS`
  rather than inventing a constant, so the horizon is "as old as a week can be and still be
  cheaply repairable"
- read-only: it must never write to any tab
- raises one calendar alert naming the drifted weeks when any week inside the window
  disagrees with its sources
- **SPLIT weeks inside the window**: the heal skips them and the sanctioned repair
  *understates* them, so flagging one daily is an un-actionable recurring alert. Suppress
  with an explicit recorded reason, and put a remediation line in the alert body rather
  than firing every day with no available fix.

### 3. `installSummaryDriftTrigger()`

Delete-then-create, touching **only** its own handler name — never sweep unrelated triggers
(`shopSpendWatchdog`, `weeklySummarize`, the staleness and orderapp handlers all live in the
same project). Weekly, Monday, **after** `weeklySummarize`'s 04:00 slot; 07:00
Australia/Sydney gives ~3h of margin and is clear of the staleness check's daily 11:00.

Separate trigger on purpose: a guard that runs inside the thing it watches cannot report
that the thing never ran.

## Test First

Write these in `connectors/gas/test_code.js` and confirm they FAIL first.

1. `checkSummaryDrift()` tolerates being handed a trigger event object (zero-arg contract holds).
2. Windowed audit excludes weeks past the purge line and includes weeks inside it.
3. `auditSummaryDrift()` called with no arguments still audits every week (regression guard).
4. A drifted week inside the window raises exactly one calendar alert.
5. No drifted week inside the window raises **zero** alerts.
6. The alert is idempotent within a day — a second run creates no second event.
7. A SPLIT week inside the window is suppressed with a recorded reason, not alerted daily.
8. The alert body names the remediation and is passed as `bodyLines`, not one blob.
9. `checkSummaryDrift()` writes nothing — assert zero `setValue`/`appendRow`/`deleteRow`.
10. A broken/unavailable calendar does not throw out of `raiseCalendarAlert_`.
11. `stalenessRaiseAlerts_`'s existing behaviour is unchanged after the refactor.
12. `installSummaryDriftTrigger()` removes only its own handler and leaves others intact.

## Acceptance Criteria

```bash
node connectors/gas/test_code.js   # all suites green, including every case above
```

## Verification Procedure

1. Run the AC command.
2. Confirm by grep that `CalendarApp` appears in **no file other than** `staleness.gs`.
3. Confirm `checkSummaryDrift` is registered nowhere as taking a parameter.
4. Update this step in `phases/summary-self-heal/index.json`.

## Prohibitions

- **Do not reference `CalendarApp` outside `staleness.gs`.** Reason: that file is deliberately the single source of the OAuth scope, so a scope change can never take `/exec` down with un-consented code — `/exec` is the sole ingest path.
- **Do not give `checkSummaryDrift` a parameter.** Reason: a time-based trigger passes an event object as arg 1; that is what corrupted the `Sales` tab.
- Do not write to any tab in this step. Reason: the guard is read-only by design; a watchdog that mutates can break the thing it watches.
- Do not sweep triggers by anything other than the exact handler name. Reason: five other handlers live in this project.
- Do not add the `--push-only` authorize step to the deploy. Reason: no new scope is added; `CalendarApp` is already consented project-wide.
- Do not alert on weeks past the purge line. Reason: those 143 weeks and $288,852.51 are deliberately written off; alerting on them daily makes the guard noise.
- Do not use bare `new Date()`. Reason: `withMockNow` patches only `Date.now()`.
- Do not break existing tests.
