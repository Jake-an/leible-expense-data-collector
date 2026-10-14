# Step 2: cost-shift

## Requirements Covered

- `PRD-16` — award-penalty costing with pinned type/level/basis, PH > Sun > Sat > weekday.
- `PRD-17` — superannuation guarantee from a dated table.

This is *why* this step exists. If the Task section below appears to contradict the
requirement above, `docs/ADR.md`, or a CRITICAL rule in CLAUDE.md, do NOT resolve the
conflict yourself — set `"status": "needs_context"` with the contradiction spelled out
in `needs_context_detail`, and stop.

## Files to Read

- `C:/Users/mioja/.claude/plans/hey-darling-could-we-robust-sphinx.md` — Phase 1 items 2–4 and Phase 2 (the spec for this phase).
- `docs/labour-award-research.md` — the multiplier table, NSW holiday table and SG facts to encode.
- `connectors/gas/labour.gs` — the (currently header-only) file you are adding to.
- `connectors/gas/test_code.js` — head (~460 lines: `load()` indirect-eval, `check`/`eq`) and the tail (insert above the summary + `process.exit`).
- Steps 0 and 1 in `labour.gs`: `labourReadConfig_`, `labourMultiplier_`, shift shape.

## Task

Add to `connectors/gas/labour.gs`:

- **`LABOUR_SG_RATES_`** — dated table, ascending: `[{from:'2024-07-01', rate:0.115}, {from:'2025-07-01', rate:0.12}]`. **`labourSgRate_(date)`** -> the rate of the latest row with `from <= date`; a date BEFORE the first row THROWS (never 0).
- **`labourDayType_(date, cfg)`** -> `'public_holiday'` if `cfg.holidays[date]`, else `'sunday'`, `'saturday'`, else `'weekday'`. Day-of-week from the calendar date itself (parse `yyyy-MM-dd` as UTC components; no TZ dependence). Priority PH > Sunday > Saturday > weekday: a public holiday that falls on a weekend is costed at the PH rate.
- **`labourCostShift_(shift, cfg)`** -> `{ok:true, dayType, multiplier, base, gross, uplift, sgRate, super, total, employmentType, level, rateBasis}` or `{ok:false, exception:{reason, recordId, personEmail, date, location, detail}}`:
  - looks up `cfg.people[shift.personEmail]`; absent -> exception `person_not_in_people` (NOT a guess, NOT a default type). A PEOPLE row with a blank `employment_type`/`level`/`rate_basis` -> exception `person_incomplete`.
  - `multiplier = labourMultiplier_(cfg, type, basis, level, dayType)` — a missing multiplier propagates as a THROW; do not catch it.
  - `base = hours x rate`; `gross = base x multiplier`; `uplift = gross - base`; `super = gross x labourSgRate_(shift.date)`; `total = gross + super`.
  - The person's PINNED type/level/basis are used as-is: a junior rate, an above-award rate or a post-1-July rate is costed from the pins and the row rate. The rate is never used to infer or change classification here.

### Test First (TDD step)

Add the tests to `connectors/gas/test_code.js` ABOVE the final
`console.log('\n' + passed + ' passed...)` / `process.exit(...)` pair (tests appended after
`process.exit` are dead — memory `test-code-js-appended-tests-after-process-exit-are-dead`).
`labour.gs` is already loaded by `load('labour.gs')` near the top of that file; do not add
another load. Confirm RED for the right reason (the function is undefined / returns the wrong
thing — not a syntax error), implement to green, refactor.

Test cases (defined at design time — these are "done"):
- weekday casual-unloaded 8h at 30.00 -> multiplier 1.25, gross 300.00, base 240.00, uplift 60.00
- weekday casual-loaded -> 1.00; full_time vs casual-loaded on the same row rate, same date -> different multipliers/gross (2 cases)
- Saturday casual-loaded L2 -> 1.20; Sunday casual-loaded L2 -> 1.20 vs L3 -> 1.40 (the Level 2 vs Level 3 Sunday case)
- Sunday full_time -> 1.50; Saturday part_time -> 1.25
- public holiday on a weekday (Mon 2026-10-05 Labour Day) -> PH multiplier
- public holiday FALLING ON A SATURDAY: Sat 2026-04-25 (Anzac) -> `public_holiday`, NOT `saturday`, costed at the PH rate (2.00 loaded) — PH wins
- public holiday falling on a Sunday (2027-04-25) -> `public_holiday` not `sunday`
- a holiday removed from `cfg.holidays` -> that same Saturday costs at the Saturday rate (proves the PH branch is data-driven)
- missing multiplier for the person's combination -> `labourCostShift_` THROWS (propagated)
- SG boundary: shift `2025-06-30` -> 0.115, shift `2025-07-01` -> 0.12; `2024-07-01` -> 0.115; `2024-06-30` -> THROWS (before table)
- `super = gross x rate` and `total = gross + super` on a worked example (gross 300.00 on 2025-07-01 -> super 36.00, total 336.00)
- person absent from PEOPLE -> `{ok:false, exception.reason:'person_not_in_people'}` and no cost fields
- PEOPLE row with blank `level` -> `person_incomplete`
- pinned junior (Intro, rate below the Level 2 award rate) and above-award rate (above Level 6) both cost correctly from pins — result equals hours x rate x the pinned multiplier; no reclassification, no exception
- a rate that would fit a different level under the post-1-July-2026 pay guide still costs from the PINNED level (the "rate after 1 July change is fine" case)
- `labourDayType_` on leap-day / year-boundary dates (2028-02-29; 2026-12-31 -> weekday) and no dependence on `TZ` (run once under `TZ=UTC` and once `TZ=Australia/Sydney`)

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

- Do not re-classify anyone from their rate in this function. Reason: junior, above-award and post-1-July rates must cost correctly; classification is pinned in `PEOPLE`, and the pay-guide cross-check (step 4) is alert-only.
- Do not hard-code any multiplier or SG rate other than the dated `LABOUR_SG_RATES_` table. Reason: multipliers live in CONFIG; SG is the only legislated dated constant.
- Do not catch the missing-multiplier throw. Reason: failing loud is the requirement; the later wiring phase decides what a thrown week means.
- Do not apply super to anything but gross, or round per shift. Reason: rounding happens once at the group boundary.
- Do not touch `Code.gs` or any `.gs` file other than `labour.gs`. Reason: wiring into `weeklySummarize` is a later phase; this one is pure calculation.
- Do not read or open any Sheet, and do not use `Utilities.formatDate`, `Logger`, `new Date()` with no argument, or the process timezone. Reason: purity, and tests must pass in any `TZ`.
- Do not use the substring `CalendarApp` anywhere in `labour.gs`. Reason: `test_code.js` FIX6 test9a greps every `.gs`.
- Do not name anything `LABOUR_TAB`, `LABOUR_HEADERS`, `getLabourSpreadsheet_` or `labourWeeklyPull_`. Reason: Code.gs owns them; all `.gs` share one global namespace.
- Do not put real staff names, emails or rates in tests, fixtures or comments. Reason: PII rule — use `alice@example.test`-style dummies.
- Do not break existing tests.
