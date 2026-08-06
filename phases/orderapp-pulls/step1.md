# Step 1: iso-week-label-helpers

## Requirements Covered

- `PRD-10` — Shopify online weekly revenue via Order-app read API (the API takes `week=YYYY-Www` labels; the hub has no ISO-week-label *producer* — `shopSpendWeekSpan_` only parses)

This is *why* this step exists. If the Task section below appears to contradict the
requirement above, `docs/ADR.md`, or a CRITICAL rule in CLAUDE.md, do NOT resolve the
conflict yourself — set `"status": "needs_context"` with the contradiction spelled out
in `needs_context_detail`, and stop.

## Files to Read

- `connectors/gas/orderapp.gs` (created in step 0)
- `connectors/gas/Code.gs` :1509–1610 (`todayStr_`, `coerceDateStr_`, `addDaysStr_`, `weekStartForDate_`, `getLastCompletedWeek_` — reuse these, do not duplicate their logic)
- `connectors/gas/shopspend.gs` (see `shopSpendWeekSpan_` — the parser; your producer must round-trip with it)

## Task

Add to `connectors/gas/orderapp.gs` two **pure** helpers:

- `isoWeekLabel_(dateStr) → 'YYYY-Www'` — ISO-8601 week label for a `yyyy-MM-dd` string,
  via the ISO Thursday rule (the week's Thursday determines the ISO year). Build from
  local date components (`new Date(y, m-1, d)` or pure arithmetic). Zero-pad the week
  number to two digits.
- `lastCompletedWeeks_(todayStr, n) → [{label, start, end}]` — the `n` most recent
  **completed** ISO weeks (Mon-start, `end < todayStr`), oldest-first. Compose from
  `getLastCompletedWeek_` / `addDaysStr_` / `weekStartForDate_` and `isoWeekLabel_`.
  `start`/`end` are `yyyy-MM-dd` strings.

### Test First (TDD step)

Test cases (defined at design time — these are "done"):
- `isoWeekLabel_('2026-01-01') === '2026-W01'`
- `isoWeekLabel_('2024-12-30') === '2025-W01'` (Monday belonging to the next ISO year)
- `isoWeekLabel_('2021-01-01') === '2020-W53'` (Friday belonging to the previous ISO year)
- a mid-year Monday and the Sunday of the same week produce the same label
- zero-padding: a week-5 date yields `'W05'`
- `lastCompletedWeeks_('2026-08-06', 4)` → labels `2026-W28..2026-W31`, oldest-first, each `start` a Monday, each `end` = start+6 and `< '2026-08-06'`
- `lastCompletedWeeks_` called on a Monday returns the week that ended yesterday as the newest entry (boundary: current week is never included)

## Acceptance Criteria

```bash
node connectors/gas/test_code.js
```

## Verification Procedure

1. Run the AC command.
2. Checklist: helpers are pure (no Sheet/Properties/UrlFetchApp access); no `toISOString()` anywhere in them.
3. Update this step in `phases/orderapp-pulls/index.json`.

## Prohibitions

- Do not use `Date.prototype.toISOString()` or UTC getters for any part of the calculation. Reason: Sheet/date coercion in this repo is local-component based; UTC round-trips produce AEST off-by-one bugs (documented gotcha).
- Do not re-implement `getLastCompletedWeek_`/`addDaysStr_` logic inline. Reason: single source of truth for week math lives in Code.gs.
- Do not break existing tests.
