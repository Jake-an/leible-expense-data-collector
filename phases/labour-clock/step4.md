# Step 4: checks-and-alerts

## Requirements Covered

- `PRD-19` — data-quality checks and alerts (zero rows, >10% exceptions, rate change, 70% drop, 1 July re-verify, pay-guide cross-check).
- `PRD-20` — the holiday alerts from step 0 are aggregated into the run's alert list here.

This is *why* this step exists. If the Task section below appears to contradict the
requirement above, `docs/ADR.md`, or a CRITICAL rule in CLAUDE.md, do NOT resolve the
conflict yourself — set `"status": "needs_context"` with the contradiction spelled out
in `needs_context_detail`, and stop.

## Files to Read

- `C:/Users/mioja/.claude/plans/hey-darling-could-we-robust-sphinx.md` — Phase 1 items 2–4 and Phase 2 (the spec for this phase).
- `docs/labour-award-research.md` — the multiplier table, NSW holiday table and SG facts to encode.
- `connectors/gas/labour.gs` — the (currently header-only) file you are adding to.
- `connectors/gas/test_code.js` — head (~460 lines: `load()` indirect-eval, `check`/`eq`) and the tail (insert above the summary + `process.exit`).
- Steps 0-3 in `labour.gs`: cfg, shifts, exceptions, group rows, `labourHolidayAlerts_`.

## Task

Add to `connectors/gas/labour.gs`. Every function is pure; `today`/`asOf` are parameters; every alert is `{key, title, lines[]}` with ONE line per item.

- **`labourCheckZeroRows_(rowCount, week)`** -> `{stop:boolean, alerts}`: `rowCount === 0` -> `stop:true` + alert `labour_zero_rows` naming the week. `rowCount` is the count of CLOCK_RAW rows in the week range BEFORE dedup/exceptions.
- **`labourCheckExceptions_(shiftsTotal, exceptionsTotal)`** -> `{refuse:boolean, rate, alerts}`: `rate = exceptions / (shifts + exceptions)`; STRICTLY above 0.10 -> `refuse:true` + alert `labour_exceptions_refused` (the later wiring will not write that week). At or below 10% with at least one exception, emit one informational alert `labour_exceptions` with a single count line. Zero total -> `rate 0`, no refusal.
- **`labourExceptionAlerts_(exceptions)`** -> alerts: `person_not_in_people` exceptions produce an alert `labour_person_missing` with ONE line per distinct person (email only), so a new starter never silently costs nothing.
- **`labourCheckRateChange_(thisWeekShifts, prevWeekShifts)`** -> alerts: for each person present in both weeks whose (modal) row rate differs, alert `labour_rate_change` with one line `email: old -> new`. People in only one week are ignored. Compare to the cent.
- **`labourCheckDrop_(groups, history)`** -> alerts: `history` = `{ location: [previous completed weeks' total, newest first] }`. For each location in `groups` with >= 4 prior weeks: median of the latest 4; this week's `total` STRICTLY below 70% of it -> alert `labour_drop`, one line per location. A location with FEWER than 4 prior weeks (or absent from `history`) -> alert `labour_drop_unchecked` whose line says `drop check UNCHECKED` and the weeks of history available.
- **`labourJulyAlert_(today, lastAlertedYear)`** -> `{alert|null, lastAlertedYear}`: from 1 July of a calendar year onward, if `lastAlertedYear < that year`, return alert `labour_reverify_multipliers` ("re-verify award multipliers", cites `docs/labour-award-research.md`) and the NEW `lastAlertedYear` for the caller to persist; before 1 July, or already alerted that year -> `alert:null` and the year unchanged. Fires once per year, never every run.
- **`labourPayGuideCheck_(observations, cfg, payGuide)`** -> alerts (ALERT-ONLY): `observations` = `[{personEmail, rate, date}]`; `payGuide` = `[{effective_from, employment_type, rate_basis, level, rate}]` (seed it from `docs/labour-award-research.md` rates, flagged third-party/unverified in a comment). For each observation use the guide rows with the latest `effective_from <= date` per (type, basis, level); the observation "fits" a level if its rate is within +/-1.0% of the guide rate for the person's PINNED employment_type and rate_basis. Outcomes: fits the pinned level -> nothing; fits a DIFFERENT single level -> alert `labour_payguide_mismatch` line `email: pinned L<a>, rate fits L<b>`; fits MORE THAN ONE level -> alert `labour_payguide_ambiguous` listing ALL candidate levels, never picking one; fits none -> `labour_payguide_nomatch` (above/below-award, informational). No guide row effective on/before the date -> `labour_payguide_stale`. The function returns ONLY alerts: it never returns, mutates or suggests a new classification and must not modify `cfg`.
- **`labourRunChecks_(ctx)`** — thin aggregator returning `{stop, refuse, alerts, lastAlertedYear}`; calls the above plus `labourHolidayAlerts_` (step 0) with `ctx = {week, rowCount, groups, shiftsTotal, exceptions, thisWeekShifts, prevWeekShifts, history, today, lastAlertedYear, payGuide, observations, cfg}`. `stop` short-circuits (zero rows -> only the zero-rows alert plus holiday alerts).

### Test First (TDD step)

Add the tests to `connectors/gas/test_code.js` ABOVE the final
`console.log('\n' + passed + ' passed...)` / `process.exit(...)` pair (tests appended after
`process.exit` are dead — memory `test-code-js-appended-tests-after-process-exit-are-dead`).
`labour.gs` is already loaded by `load('labour.gs')` near the top of that file; do not add
another load. Confirm RED for the right reason (the function is undefined / returns the wrong
thing — not a syntax error), implement to green, refactor.

Test cases (defined at design time — these are "done"):
- zero clock rows -> `stop:true`, alert `labour_zero_rows` names the week; non-zero -> no stop
- exceptions exactly 10% (1 of 10) -> NOT refused; 11% (2 of 18) -> `refuse:true`; 0 exceptions and 0 shifts -> rate 0, no refuse
- `person_not_in_people` exceptions -> `labour_person_missing`, one line per distinct person, no duplicate lines for repeated shifts
- rate differs from previous week for one person -> one `labour_rate_change` line `old -> new`; unchanged -> none; person only in one week -> none; a 1-cent change IS reported
- 70% drop: this week at 69.9% of the 4-week median -> `labour_drop`; exactly 70% -> no alert; the median uses the latest 4 weeks only (a 5th older week is ignored)
- insufficient history: 3 prior weeks -> `labour_drop_unchecked` with the text `drop check UNCHECKED`; a location with no history -> UNCHECKED; never a silent pass
- 1 July alert: `today 2026-07-01`, last alerted 2025 -> alert + lastAlertedYear 2026; `2026-07-02`, last 2026 -> null; `2026-06-30`, last 2025 -> null; `2027-07-01`, last 2026 -> alert again (once per year)
- pay-guide: rate exactly matching the pinned level -> no alert; rate matching a different single level -> `labour_payguide_mismatch` and `cfg.people` is deep-equal before/after (never re-classifies); a rate within 1% of TWO adjacent levels -> `labour_payguide_ambiguous` listing BOTH levels, no pick; an above-award pinned rate -> `labour_payguide_nomatch` only; a rate observed after 1 July with a guide row dated 2026-07-01 matches the NEW guide row, not the old one; an observation dated before any guide row -> `labour_payguide_stale`
- `labourRunChecks_`: a zero-row week short-circuits (`stop:true`, no drop/rate alerts); a clean week -> `alerts` contains only the expected keys (assert exact keys); the holiday-expiring alert from step 0 appears in the aggregate
- every alert has a non-empty `key` and `title`, and `lines` is an array of strings with no embedded newlines (one line per item)

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

- Do not re-classify or modify `cfg.people` from the pay-guide check, and do not choose between ambiguous levels. Reason: pinned columns are the source of truth; the guide is a smoke alarm only. Assert deep-equality of `cfg` before/after.
- Do not treat insufficient history as a pass. Reason: an unchecked location must say so out loud.
- Do not persist `lastAlertedYear` or raise anything here. Reason: purity; the wiring phase stores it in a Script Property and raises the alerts.
- Do not join all alert items into one multi-line blob. Reason: the GAS editor log truncates one big blob (memory `gas-editor-log-truncates-one-big-blob`).
- Do not touch `Code.gs` or any `.gs` file other than `labour.gs`. Reason: wiring into `weeklySummarize` is a later phase; this one is pure calculation.
- Do not read or open any Sheet, and do not use `Utilities.formatDate`, `Logger`, `new Date()` with no argument, or the process timezone. Reason: purity, and tests must pass in any `TZ`.
- Do not use the substring `CalendarApp` anywhere in `labour.gs`. Reason: `test_code.js` FIX6 test9a greps every `.gs`.
- Do not name anything `LABOUR_TAB`, `LABOUR_HEADERS`, `getLabourSpreadsheet_` or `labourWeeklyPull_`. Reason: Code.gs owns them; all `.gs` share one global namespace.
- Do not put real staff names, emails or rates in tests, fixtures or comments. Reason: PII rule — use `alice@example.test`-style dummies.
- Do not break existing tests.
