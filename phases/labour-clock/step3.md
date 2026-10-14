# Step 3: group-week-location

## Requirements Covered

- `PRD-18` — one row per ISO week x location with hours, base, uplift, gross, super, total, department, shift count and exception count.

This is *why* this step exists. If the Task section below appears to contradict the
requirement above, `docs/ADR.md`, or a CRITICAL rule in CLAUDE.md, do NOT resolve the
conflict yourself — set `"status": "needs_context"` with the contradiction spelled out
in `needs_context_detail`, and stop.

## Files to Read

- `C:/Users/mioja/.claude/plans/hey-darling-could-we-robust-sphinx.md` — Phase 1 items 2–4 and Phase 2 (the spec for this phase).
- `connectors/gas/labour.gs` — the (currently header-only) file you are adding to.
- `connectors/gas/test_code.js` — head (~460 lines: `load()` indirect-eval, `check`/`eq`) and the tail (insert above the summary + `process.exit`).
- `connectors/gas/orderapp.gs` `isoWeekLabel_` (~`:559`) and `connectors/gas/Code.gs` Labour tab columns (`LABOUR_HEADERS`, ~`:8`, and `labourWeeklyPull_` ~`:1373-1440`) — mirror the week_start/week_end/iso_week conventions; do NOT call into those at runtime (purity).
- Steps 1-2 in `labour.gs`: shift and cost shapes.

## Task

Add to `connectors/gas/labour.gs`:

**`labourIsoWeek_(date)`** -> `{weekStart:'yyyy-MM-dd' (Monday), weekEnd:'yyyy-MM-dd' (Sunday), isoWeek:'YYYY-Www'}` computed from the calendar date alone (UTC components; no TZ). Must produce the same `isoWeek` label format as `isoWeekLabel_` in `orderapp.gs` (read it, mirror it; a test calls BOTH on the same inputs).

**`labourGroup_(costed, exceptions)`** -> array of group rows, sorted by `weekStart` then `location`:
- `costed` = array of `{shift, cost}` where `cost.ok` is true (caller filters; a `cost.ok === false` entry passed in is a programming error -> throw). `exceptions` = the exception objects from steps 1-2 (each carries `date` and `location` when known).
- Group key = ISO week of `shift.date` x `shift.location`. Row: `{weekStart, weekEnd, isoWeek, location, locationCode, department, hours, base, uplift, gross, super, total, shiftCount, exceptionCount}`.
- Sums are accumulated at full precision then ROUNDED TO CENTS once per row (`Math.round(x*100)/100`); `total` is the rounded sum of the UNROUNDED gross+super, and a test asserts `|total - (gross + super)| <= 0.01` so drift is bounded and visible.
- `department` is the shift's department; if shifts in one group disagree -> THROW (config error, not a guess).
- A group that has exceptions but zero costed shifts still emits a row (`shiftCount 0`, `exceptionCount n`, money 0) so the exception rate is visible. Exceptions with no resolvable location are counted under location `'(unknown)'`.
- Empty input -> `[]`.

### Test First (TDD step)

Add the tests to `connectors/gas/test_code.js` ABOVE the final
`console.log('\n' + passed + ' passed...)` / `process.exit(...)` pair (tests appended after
`process.exit` are dead — memory `test-code-js-appended-tests-after-process-exit-are-dead`).
`labour.gs` is already loaded by `load('labour.gs')` near the top of that file; do not add
another load. Confirm RED for the right reason (the function is undefined / returns the wrong
thing — not a syntax error), implement to green, refactor.

Test cases (defined at design time — these are "done"):
- three weekday shifts, one location, one week -> one row with correct hours/base/uplift/gross/super/total/shiftCount
- two locations same week -> two rows, sorted; two weeks same location -> two rows, week order
- a shift on Sunday 2026-10-11 and Monday 2026-10-12 -> DIFFERENT ISO weeks (week boundary is Monday)
- ISO year boundary: 2026-12-31 and 2027-01-01 -> same ISO week `2026-W53`; `labourIsoWeek_` agrees with `isoWeekLabel_` (orderapp.gs) on the same inputs
- `base + uplift` ~ `gross` and `gross + super` ~ `total` within a cent on a 7-shift mixed (weekday/Sat/Sun/PH) week
- rounding: shifts each 0.004 under a cent boundary — the row total equals round2 of the true sum, not the sum of rounded shifts
- roastery location group -> `department:'Roastery'`; cafe -> `'Cafe'`
- department disagreement inside one group -> THROWS
- exception-only group (`shiftCount 0`, `exceptionCount 2`, money 0) is emitted
- exceptions with no location -> counted under `'(unknown)'`
- empty costed + empty exceptions -> `[]`
- a `cost.ok:false` entry passed to `labourGroup_` -> THROWS

## Acceptance Criteria

```bash
node connectors/gas/test_code.js
```

Baseline before this phase: 2718 passed, 0 failed. All pre-existing tests stay green plus every
case above. Report the final pass count.

## Verification Procedure

1. Run the AC command; record pass/fail counts.
2. Purity: grep `connectors/gas/labour.gs` for `SpreadsheetApp|PropertiesService|UrlFetchApp|Utilities|Logger|CalendarApp|DriveApp|GmailApp|new Date\(\)|Date\.now`
   — expect NO matches (a clock-dependent function takes `today`/`asOf` as a parameter; the
   word `CalendarApp` must not appear even in a comment — `test_code.js` FIX6 test9a fails on it).
3. Mutation check on the step's most important rule (named in the Prohibitions): break it, confirm a test goes red, revert.
4. Update this step in `phases/labour-clock/index.json`.

## Prohibitions

- Do not round per shift. Reason: per-shift rounding drifts a week's total by cents against the pay run.
- Do not drop zero-shift groups that have exceptions. Reason: step 4's >10% exception refusal reads `exceptionCount`/`shiftCount`; a hidden group hides a bad location.
- Do not call `isoWeekLabel_` or anything in `Code.gs` from `labour.gs` at runtime (the test may call it for comparison). Reason: keep the file standalone.
- Do not touch `Code.gs` or any `.gs` file other than `labour.gs`. Reason: wiring into `weeklySummarize` is a later phase; this one is pure calculation.
- Do not read or open any Sheet, and do not use `Utilities.formatDate`, `Logger`, `new Date()` with no argument, or the process timezone. Reason: purity, and tests must pass in any `TZ`.
- Do not use the substring `CalendarApp` anywhere in `labour.gs`. Reason: `test_code.js` FIX6 test9a greps every `.gs`.
- Do not name anything `LABOUR_TAB`, `LABOUR_HEADERS`, `getLabourSpreadsheet_` or `labourWeeklyPull_`. Reason: Code.gs owns them; all `.gs` share one global namespace.
- Do not put real staff names, emails or rates in tests, fixtures or comments. Reason: PII rule — use `alice@example.test`-style dummies.
- Do not break existing tests.
