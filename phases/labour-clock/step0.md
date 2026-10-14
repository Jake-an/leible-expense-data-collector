# Step 0: config-and-holidays

## Requirements Covered

- `PRD-16` — award-penalty costing: this step builds the config reader and the multiplier lookup it depends on.
- `PRD-20` — NSW public-holiday table: seeded official dates and the 60-day / zero-holiday alerts.

This is *why* this step exists. If the Task section below appears to contradict the
requirement above, `docs/ADR.md`, or a CRITICAL rule in CLAUDE.md, do NOT resolve the
conflict yourself — set `"status": "needs_context"` with the contradiction spelled out
in `needs_context_detail`, and stop.

## Files to Read

- `C:/Users/mioja/.claude/plans/hey-darling-could-we-robust-sphinx.md` — Phase 1 items 2–4 and Phase 2 (the spec for this phase).
- `docs/labour-award-research.md` — the multiplier table, NSW holiday table and SG facts to encode.
- `connectors/gas/labour.gs` — the (currently header-only) file you are adding to.
- `connectors/gas/test_code.js` — head (~460 lines: `load()` indirect-eval, `check`/`eq`) and the tail (insert above the summary + `process.exit`).
- `CLAUDE.md` Architecture Rules (only GAS writes the hub; this file stays pure).

## Task

Add to `connectors/gas/labour.gs`:

**Seed constants** (what the later `labourSetupSheet()` will write into the Labour Sheet; tests use them as fixtures):
- `LABOUR_CLOCK_MULTIPLIER_SEED_` — array of CONFIG rows, header `['employment_type','rate_basis','level_band','day_type','multiplier','source_url','as_of']`. `employment_type` in `casual|full_time|part_time`; `rate_basis` in `loaded` (rate already includes the 25% casual loading) | `unloaded` | `any`; `level_band` in `L0-2|L3-6|all`; `day_type` in `weekday|saturday|sunday|public_holiday`. Values EXACTLY from the plan's Phase 1 item 3 table / `docs/labour-award-research.md`: casual-unloaded weekday 1.25, sat 1.50, sun 1.75 (L3-6) / 1.50 (L0-2), PH 2.50; casual-loaded 1.00 / 1.20 / 1.40 (L3-6) / 1.20 (L0-2) / 2.00; full_time and part_time (`rate_basis` `any`, `level_band` `all`) 1.00 / 1.25 / 1.50 / 2.25. `source_url` = the Fair Work MA000119 URL, `as_of` = `2026-10-14`.
- `LABOUR_NSW_HOLIDAYS_SEED_` — array of `{date:'yyyy-MM-dd', name}` for EVERY row of the official NSW 2026 and 2027 table in `docs/labour-award-research.md`, including the weekend-falling and "additional day" rows (Sat 2026-04-25 Anzac, Mon 2026-04-27 additional, Sat 2026-12-26 Boxing, Mon 2026-12-28 additional, Sat 2027-12-25, Mon 2027-12-27, Sun 2027-12-26, Tue 2027-12-28, Sun 2027-04-25, Mon 2027-04-26, ...). Exclude August Bank Holiday. Re-derive every date from the research doc; do not trust this list.
- `LABOUR_HOLIDAY_ALERT_DAYS_ = 60`.

**`labourReadConfig_(tabs)`** -> `cfg` (pure; `tabs` as in the shared conventions):
- Validates each tab's header row against an expected-header constant per tab (CONFIG as above; HOLIDAYS `[date,name]`; LOCATIONS `[location,code,department,live]`; RATES `[person_email,rate,effective_from]`; PEOPLE `[person_email,employment_type,level,rate_basis]`). A missing tab, missing column or renamed column THROWS an Error naming the tab and column — never returns zeros.
- Returns `{multipliers, holidays, locations, rates, people}`: `multipliers` keyed by a composite key; `holidays` a `{ 'yyyy-MM-dd': name }` map (HOLIDAYS date cell may be a string or a `Date`); `locations` keyed by the BLIP location string as written, each `{code, department, live}` — `live` is true only for an explicit `TRUE`/`true`/`Y`/`yes`/boolean true; a blank or unrecognised cell is false; `rates` keyed by lower-cased email -> array of `{rate, effective_from}`; `people` keyed by lower-cased trimmed email.
- Non-numeric, blank, zero or negative `multiplier` cell -> throws (names the row).
- Unknown `department` (not `Cafe`/`Roastery`) -> throws.

**`labourMultiplier_(cfg, employmentType, rateBasis, level, dayType)`** -> number:
- `level` is `'Intro'|0|1..6` (string or number); band `L0-2` for Intro/0/1/2, `L3-6` for 3-6. Lookup order: exact `(type, basis, band, day)` -> `(type, basis, 'all', day)` -> `(type, 'any', band, day)` -> `(type, 'any', 'all', day)`. NOTHING found -> THROW `Error('labour: no multiplier for <type>/<basis>/<band>/<day>')`. It never defaults to 1.0.

**`labourHolidayAlerts_(cfg, today)`** -> array of alert objects:
- Table end = latest date in `cfg.holidays`. If `today` is within `LABOUR_HOLIDAY_ALERT_DAYS_` days of (or past) the table end -> alert key `labour_holidays_expiring`, title states the end date and "refresh from nsw.gov.au".
- If `cfg.holidays` has ZERO entries dated in `today`'s calendar year -> alert key `labour_holidays_empty`. An empty table is never silently fine. (If the table is entirely empty, both conditions are true; return the `empty` alert once.)
- Otherwise `[]`.

Conventions shared by every step of this phase (READ before coding; later steps build on them):

- **Alerts are returned, not raised.** A check returns `{key, title, lines: string[]}` objects (one line per item — memory `gas-editor-log-truncates-one-big-blob`). The later wiring phase passes them to the existing alert path. Nothing in `labour.gs` logs or alerts.
- **Tab arrays.** Config tabs arrive as 2-D arrays whose row 0 is the header, exactly what `getValues()` returns: `tabs = {CONFIG, HOLIDAYS, LOCATIONS, RATES, PEOPLE}`. (The plan names `labourReadConfig_(ss)`; to keep the function pure it takes these arrays instead, and a thin Sheet-reading wrapper is added in the wiring phase.)
- **Dates** are `'yyyy-MM-dd'` strings in Australia/Sydney. Cells may be strings OR `Date` objects (memory `sheet-date-coercion`: coerce via LOCAL components, never `toISOString`). Do not depend on `Utilities` or the process TZ.
- **`today` / `asOf`** are always parameters (`'yyyy-MM-dd'`), never read from a clock.
- **Money** is computed in floats then rounded to cents ONLY at the group boundary (step 3); per-shift values keep full precision. Compare in tests with a 1e-9 tolerance or integer cents.


### Test First (TDD step)

Add the tests to `connectors/gas/test_code.js` ABOVE the final
`console.log('\n' + passed + ' passed...)` / `process.exit(...)` pair (tests appended after
`process.exit` are dead — memory `test-code-js-appended-tests-after-process-exit-are-dead`).
`labour.gs` is already loaded by `load('labour.gs')` near the top of that file; do not add
another load. Confirm RED for the right reason (the function is undefined / returns the wrong
thing — not a syntax error), implement to green, refactor.

Test cases (defined at design time — these are "done"):
- `labourReadConfig_` happy path on the seed fixtures -> multipliers, holidays, locations (`live` parse), people populated
- header drift: a renamed CONFIG column, a missing HOLIDAYS tab, a missing PEOPLE column -> each THROWS naming the tab (3 cases)
- a multiplier cell that is blank / `'abc'` / `0` / negative -> throws (4 cases)
- unknown `department` -> throws
- LOCATIONS `live` cell: `TRUE`, `'yes'`, blank, `'maybe'` -> true, true, false, false (blank/unknown = NOT live)
- HOLIDAYS date cell as a `Date` object and as a string -> both land in the same `'yyyy-MM-dd'` key (local-component coercion)
- `labourMultiplier_`: casual/unloaded/weekday -> 1.25 (the bug-class case); casual/loaded/weekday -> 1.00; full_time vs casual on the same inputs -> different multipliers; casual L2 Sunday -> 1.20 vs L3 Sunday -> 1.40 (loaded) and 1.50 vs 1.75 (unloaded)
- `labourMultiplier_` for a combination absent from CONFIG -> THROWS (not 1.0); same when one row was deleted from an otherwise-valid config
- seed holidays: contains `2026-04-25` (Sat Anzac), `2026-12-26` (Sat Boxing) and `2027-04-26`; does NOT contain an August Bank Holiday date; the 2026 and 2027 counts match the research doc
- `labourHolidayAlerts_`: today `2027-10-31` (table ends 2027-12-28, 58 days) -> `labour_holidays_expiring`; today `2027-10-29` (60 days) -> expiring (boundary inclusive); today `2027-10-28` (61 days) -> `[]`; a cfg with no holidays in today's year -> `labour_holidays_empty`; a fully empty table -> exactly one `labour_holidays_empty`

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

- Do not default a missing multiplier to 1.0, or to any number, anywhere. Reason: a silent weekday rate on weekends is the likely cause of today's labour mismatch; the failure must be loud.
- Do not fetch holidays from Nager.Date or any URL. Reason: its AU feed omits weekend-falling NSW holidays — exactly the days that pay PH rates.
- Do not hard-code multipliers inside `labourMultiplier_`; the seed constant is data for the setup function, and lookup reads `cfg`. Reason: multipliers are changed in the Sheet, not in code.
- Do not treat a blank `live` cell as live. Reason: a location must never be dropped by both the old and new path.
- Do not touch `Code.gs` or any `.gs` file other than `labour.gs`. Reason: wiring into `weeklySummarize` is a later phase; this one is pure calculation.
- Do not read or open any Sheet, and do not use `Utilities.formatDate`, `Logger`, `new Date()` with no argument, or the process timezone. Reason: purity, and tests must pass in any `TZ`.
- Do not use the substring `CalendarApp` anywhere in `labour.gs`. Reason: `test_code.js` FIX6 test9a greps every `.gs`.
- Do not name anything `LABOUR_TAB`, `LABOUR_HEADERS`, `getLabourSpreadsheet_` or `labourWeeklyPull_`. Reason: Code.gs owns them; all `.gs` share one global namespace.
- Do not put real staff names, emails or rates in tests, fixtures or comments. Reason: PII rule — use `alice@example.test`-style dummies.
- Do not break existing tests.
