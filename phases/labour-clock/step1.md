# Step 1: rows-to-shifts

## Requirements Covered

- `PRD-15` — clock-row -> shift normalisation (hours, Sydney date, dedup, exceptions) via a single header-name map.

This is *why* this step exists. If the Task section below appears to contradict the
requirement above, `docs/ADR.md`, or a CRITICAL rule in CLAUDE.md, do NOT resolve the
conflict yourself — set `"status": "needs_context"` with the contradiction spelled out
in `needs_context_detail`, and stop.

## Files to Read

- `C:/Users/mioja/.claude/plans/hey-darling-could-we-robust-sphinx.md` — Phase 1 items 2–4 and Phase 2 (the spec for this phase).
- `connectors/gas/labour.gs` — the (currently header-only) file you are adding to.
- `connectors/gas/test_code.js` — head (~460 lines: `load()` indirect-eval, `check`/`eq`) and the tail (insert above the summary + `process.exit`).
- `connectors/gas/Code.gs` — `coerceDateStr_` (~`:2456`) and the existing Date-handling idioms; memory `sheet-date-coercion`.
- Step 0's output in `labour.gs` (`labourReadConfig_` cfg shape: `cfg.locations`, `cfg.rates`, `cfg.people`).

## Task

Add to `connectors/gas/labour.gs`:

**`LABOUR_CLOCK_COLS`** — header-name map, ONE constant, the only place Zap column names appear. Provisional (will be remapped after the Zapier probe):
`{ person_email:'person_email', person_name:'person_name', clock_in:'clock_in', clock_out:'clock_out', hours:'hours', break_minutes:'break_minutes', location:'location', rate:'rate', record_id:'record_id' }` — logical name -> header text in `CLOCK_RAW` row 0. Columns are located by header text, never by position.

**`labourSydneyParts_(v)`** -> `{date:'yyyy-MM-dd', ms:<epoch ms>}` or `null` if unparseable. `v` is a `Date` object, an ISO string with offset (`2026-06-25T10:32:24+10:00`), or a zone-less `yyyy-MM-dd HH:mm[:ss]` string (interpreted as Sydney local). Derive the Sydney calendar date WITHOUT `Utilities`/`Intl`/process TZ: implement the NSW DST rule (AEDT UTC+11 from 02:00 standard on the first Sunday of October to 03:00 daylight on the first Sunday of April; otherwise AEST UTC+10).

**`labourRowsToShifts_(rows, range, cfg)`** -> `{shifts, exceptions}`:
- `rows` = 2-D array incl. header row; `range` = `{start:'yyyy-MM-dd', end:'yyyy-MM-dd'}` inclusive on the Sydney clock-in date; rows outside are silently skipped (not exceptions). A missing mapped column THROWS naming it (header drift).
- Shift = `{recordId, personEmail, personName, date, clockInMs, clockOutMs, hours, location, locationCode, department, rate, rateSource:'row'|'rates_fallback'}`. Email lower-cased + trimmed.
- Hours = out - in - break when both in and out parse; otherwise the Zapier `hours` cell when it is a finite number > 0. If both exist and disagree by more than 0.05h, trust out - in - break.
- Dedup: key = `record_id` when non-blank, else `personEmail|clockInMs`. The row with the LATEST clock-out wins (an edited clock-out replaces the earlier row); ties -> the later row in sheet order.
- `department` and `locationCode` come from `cfg.locations[location]` (roastery location -> `Roastery`, others as configured).
- Rate = the row's `rate` when finite > 0; else the `cfg.rates` fallback for that person (latest `effective_from` <= shift date) with `rateSource:'rates_fallback'`; else exception `no_rate`.
- Exceptions are `{reason, recordId, personEmail, date, location, detail}` with `reason` in `unpaired` (clock-in or clock-out missing/unparseable), `negative` (out before in, or computed hours <= 0), `over_16h` (hours > 16), `unknown_location` (not in `cfg.locations`), `no_rate`. A row gets exactly ONE reason; check in the order unpaired -> negative -> over_16h -> unknown_location -> no_rate. No exception row is ever also costed.
- Dedup happens BEFORE exception classification so a superseded row is neither shift nor exception.

### Test First (TDD step)

Add the tests to `connectors/gas/test_code.js` ABOVE the final
`console.log('\n' + passed + ' passed...)` / `process.exit(...)` pair (tests appended after
`process.exit` are dead — memory `test-code-js-appended-tests-after-process-exit-are-dead`).
`labour.gs` is already loaded by `load('labour.gs')` near the top of that file; do not add
another load. Confirm RED for the right reason (the function is undefined / returns the wrong
thing — not a syntax error), implement to green, refactor.

Test cases (defined at design time — these are "done"):
- a plain weekday 09:00-17:00 row -> one shift, hours 8, correct Sydney date, department from LOCATIONS
- break deduction: 09:00-17:30 with `break_minutes` 30 -> 8.0 hours
- hours from the Zapier `hours` cell when in/out are absent; out - in - break wins when the cell disagrees by > 0.05h
- crossing midnight: in 22:00 Fri, out 02:00 Sat -> 4h, DATE = Friday (clock-in date)
- Sydney vs UTC: clock-in `2026-06-25T23:30:00+10:00` and `2026-06-26T08:00:00+10:00` -> correct Sydney dates; `2026-07-01T00:30:00+10:00` is 07-01 not 06-30; an AEDT case (`2026-11-10T00:15:00+11:00`) lands on 11-10
- string date cell vs `Date`-object cell for the SAME instant -> identical shift date and hours (2 cases)
- the same tests pass under `TZ=UTC` and `TZ=Australia/Sydney` (run the suite both ways once and record it)
- range filter: a row dated outside `range` is dropped, not an exception; boundary days included
- dedup by `record_id`: two rows same id, later clock-out wins; dedup without id by `person|clock-in`; the edited row is the one costed (hours reflect the newer out)
- a superseded duplicate is neither a shift nor an exception
- exceptions: clock-out blank -> `unpaired`; out before in -> `negative`; 17h -> `over_16h`; location not in LOCATIONS -> `unknown_location`; no rate and no RATES row -> `no_rate` (5 cases); each produces exactly one exception and no shift
- RATES fallback: no row rate but a RATES row effective before the shift -> costed with `rateSource:'rates_fallback'`; a RATES row effective AFTER the shift date is NOT used (-> `no_rate`)
- roastery location row -> `department:'Roastery'`; cafe row -> `'Cafe'`
- a renamed/missing mapped column (e.g. no `clock_out` header) -> THROWS naming the column
- email case/whitespace differences collapse to one person for dedup

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

- Do not use positional column indexes for CLOCK_RAW. Reason: the Zap will be remapped after the probe; `LABOUR_CLOCK_COLS` is the single remap point.
- Do not take the date from the clock-out or from UTC. Reason: a shift crossing midnight is costed on the clock-in day (splitting at midnight is out of scope, noted in the runbook).
- Do not drop an exception row silently or cost it as well. Reason: the >10% exception refusal in step 4 counts them; a lost row hides a bad week.
- Do not echo real names/emails into test output.
- Do not touch `Code.gs` or any `.gs` file other than `labour.gs`. Reason: wiring into `weeklySummarize` is a later phase; this one is pure calculation.
- Do not read or open any Sheet, and do not use `Utilities.formatDate`, `Logger`, `new Date()` with no argument, or the process timezone. Reason: purity, and tests must pass in any `TZ`.
- Do not use the substring `CalendarApp` anywhere in `labour.gs`. Reason: `test_code.js` FIX6 test9a greps every `.gs`.
- Do not name anything `LABOUR_TAB`, `LABOUR_HEADERS`, `getLabourSpreadsheet_` or `labourWeeklyPull_`. Reason: Code.gs owns them; all `.gs` share one global namespace.
- Do not put real staff names, emails or rates in tests, fixtures or comments. Reason: PII rule — use `alice@example.test`-style dummies.
- Do not break existing tests.
