# Step 7: shopspend-watchdog-and-trigger

## Files to Read

- `docs/rules.md` — the operating rules for anything scheduled or automated.
- `docs/schema.md` — the `ShopSpendPulls` spec; its `fetched_at` + `from_week`/`to_week` are the
  watchdog's evidence.
- `connectors/gas/staleness.gs` — read the whole file, especially: the header comment
  (**18-21**, this file is the ONLY owner of the CalendarApp OAuth scope),
  `STALENESS_THRESHOLD_HOURS = 96` and the comment explaining there are no per-source thresholds
  (**23-30**), `STALENESS_SOURCES` (**30**), `stalenessStampHeartbeat_` (**89**),
  `stalenessEvaluate_` (**194-213**, note the entry shape
  `{source, ageHours, stale, lastSeenMs}`), `stalenessEventTitle_` (**219**),
  `stalenessEventBody_` (**223**), `stalenessRaiseAlerts_(staleEntries, nowMs)` (**260**), and
  `installStalenessTrigger()` (**311-321**).
- `connectors/gas/Code.gs` — `installWeeklySummarizeTrigger()` (**1625-1639**) as the trigger
  idiom, and `resolveDateArg_` (**1335-1342**) for why handlers must be zero-arg safe.
- `connectors/gas/test_code.js` — `testEveryHeartbeatSourceIsWatched` (**2559-2574**), and the
  `ScriptApp` trigger mock (**216-221**) which supports exactly these chains:
  `onWeekDay→atHour→inTimezone→create`, `everyDays→inTimezone→create`,
  `atHour→everyDays→inTimezone→create`, `onMonthDay→atHour→inTimezone→create`.

## Background — why shopSpend cannot use the normal watchdog

`STALENESS_THRESHOLD_HOURS` is **96 and global**; `staleness.gs:25-30` states plainly that there
are no per-source thresholds. shopSpend runs **weekly** (168h), so registering it in
`STALENESS_SOURCES` would mark it stale for roughly 3 days out of every 7 — a guaranteed recurring
false alarm. `'recurring'` is already exempted for exactly this reason (monthly cadence).

But `doPost` stamps a heartbeat for **every** successful ingest via the generic call at
`Code.gs:150`, so shopSpend **will** stamp one. The guard test
`testEveryHeartbeatSourceIsWatched` asserts that every heartbeat-stamping source is either watched
or explicitly exempt — so `'shopspend'` must be added to its `STAMPS_HEARTBEAT` list **with an
`EXEMPT` entry**. Note that list is a hand-maintained literal at `test_code.js:2562`, not derived
from source: it cannot detect an unregistered source by itself, so this has to be done deliberately.

Hence a dedicated watchdog on a weekly cadence instead.

## Task

In `connectors/gas/shopspend.gs`:

**1. `shopSpendWatchdog()` — zero-arg trigger handler.**
- Determine the ISO week that just closed (as of "now").
- Read `ShopSpendPulls` and decide whether a pull covering that week has landed.
- If not, raise an alert by building a `stalenessEvaluate_`-shaped entry
  (`{source: 'shopspend', ageHours, stale: true, lastSeenMs}`) and passing it to the existing
  `stalenessRaiseAlerts_(staleEntries, nowMs)`.
- Must never throw out of the handler — mirror the never-throws discipline of
  `stalenessStampHeartbeat_`.
- **Zero-arg or arg-guarded.** A time-based trigger passes an **event object as argument 1**; that
  is the documented fault that previously corrupted the Sales tab. If the function takes an
  optional "now" for testability, guard it the way `resolveDateArg_` (`Code.gs:1335`) does.

Split the decision into a **pure helper** so it is testable without Calendar or Spreadsheet:

```js
/** Pure: (pullsRows, nowMs) -> {covered:boolean, weekLabel:string, lastPullMs:(number|null)} */
function shopSpendWatchdogEvaluate_(pullsRows, nowMs) { ... }
```

**2. `installShopSpendWatchdogTrigger()`** — same idiom as the other five installers: loop
`ScriptApp.getProjectTriggers()`, `deleteTrigger` any whose `getHandlerFunction()` matches, then
create. Use exactly:

```js
ScriptApp.newTrigger('shopSpendWatchdog')
  .timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(14)
  .inTimezone('Australia/Sydney').create();
```

Monday 14:00 AEST — the afternoon after the 05:00 pull, so a failed pull is caught the same day.
This chain is supported by the test mock as-is; do not use a chain outside the four listed above
without extending the mock.

**3. `connectors/gas/test_code.js`** — add `'shopspend'` to `STAMPS_HEARTBEAT` (**2562**) and an
`EXEMPT` entry (**2563**) reading `'weekly cadence exceeds STALENESS_THRESHOLD_HOURS'`.

Core rules that must not deviate:
- **Do NOT add `'shopspend'` to `STALENESS_SOURCES`.** Reason: the global 96h threshold guarantees
  a false alarm ~3 days in 7 for a weekly source.
- **Do NOT open a second `CalendarApp` call site.** Reason: `staleness.gs:18-21` declares itself the
  sole owner of that OAuth scope, and a scope change requires a push → authorize → full-deploy
  sequence that can take `/exec` down. Call into `stalenessRaiseAlerts_`; do not call
  `CalendarApp` from `shopspend.gs`.
- Trigger installers are run manually from the Apps Script editor by convention — do not auto-run
  one.

### Test First (TDD step)

Add cases to `connectors/gas/test_code.js` before implementing; drive
`shopSpendWatchdogEvaluate_` directly with fixture rows. Confirm RED, then green.

Test cases (definition of done):
- **Covered week → no alert:** a `ShopSpendPulls` row whose `from_week`/`to_week` span the
  just-closed week → `covered: true`, and `stalenessRaiseAlerts_` is not called.
- **Missing week → alert:** no covering pulls row → `covered: false`, and exactly one alert entry
  is raised with `source: 'shopspend'`.
- **Empty tab (cold start) → alert** with `ageHours: null`, mirroring `stalenessEvaluate_`'s
  never-seen convention (`staleness.gs:200-202`).
- **A pull for a DIFFERENT week does not count as coverage.**
- **Year boundary:** run on the first Monday of January 2027 → the just-closed week resolves
  correctly (`2026-W52`/`2026-W53`), not `2027-W00`.
- **Never throws:** a `ShopSpendPulls` tab with malformed rows, and a Calendar that throws, both
  leave `shopSpendWatchdog()` returning normally.
- **Zero-arg safe:** calling `shopSpendWatchdog(<fake trigger event object>)` behaves identically
  to calling it with no argument — the event object is never mistaken for a date.
- **Trigger install is idempotent:** calling `installShopSpendWatchdogTrigger()` twice leaves
  exactly one trigger for that handler; it is `MONDAY`, hour `14`, `Australia/Sydney`.
- **Registration guard:** `'shopspend'` is in `STAMPS_HEARTBEAT` and is `EXEMPT`; assert
  `STALENESS_SOURCES.indexOf('shopspend') === -1` explicitly.
- **No regression:** the full existing suite passes, including the other five sources' watchdog
  assertions.

## Acceptance Criteria

```bash
node connectors/gas/test_code.js      # all tests pass incl. the new cases; exit 0
```

## Verification Procedure

1. Run the AC command.
2. Architecture checklist:
   - `grep -n "CalendarApp" connectors/gas/shopspend.gs` returns nothing.
   - `STALENESS_SOURCES` is unchanged.
   - The handler is zero-arg safe.
3. Update `phases/shopspend/index.json` step 7 (`completed` + `summary`, or `error` +
   `error_message`, or `blocked` + `blocked_reason` then stop).

## Prohibitions

- Do not add `'shopspend'` to `STALENESS_SOURCES`. Reason: global 96h threshold vs a 168h cadence.
- Do not call `CalendarApp` from `shopspend.gs`. Reason: single-owner OAuth scope; a new scope can
  take the live `/exec` deployment down until re-authorized.
- Do not change `STALENESS_THRESHOLD_HOURS` or add per-source thresholds. Reason: that is a
  separate `TODO.md` item affecting every existing source.
- Do not use a trigger chain outside the four the mock supports without extending the mock first.
  Reason: an untested chain fails only in production.
- Do not run `deploy.sh` or install the trigger. Reason: deployment is the attended integration
  step; trigger installers are run manually from the editor.
