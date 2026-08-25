# Step 0: preflight-instrumentation

## Requirements Covered

- `PRD-12` — Summary self-heal window (this step builds the read-only planner both the preview and the heal run on, so they can never disagree)
- `PRD-13` — Summary drift guard (this step adds the `minWeek` window the guard audits through)

This is *why* this step exists. If the Task section below appears to contradict the
requirement above, `docs/ADR.md`, or a CRITICAL rule in CLAUDE.md, do NOT resolve the
conflict yourself and do NOT proceed on your best guess — set
`"status": "needs_context"` with the contradiction spelled out in
`needs_context_detail`, and stop.

## Files to Read

- `connectors/gas/Code.gs` — `upsertRows_` at :609 (the write primitive and its `idx` forward-loop duplicate behaviour), `SUMMARY_KEY_COLS` at :65, `aggregateSupplierRows_` at :1690, `weeklySummarize_impl_` at :1806, `getLastCompletedWeek_` at :1652, `addDaysStr_`/`weekStartForDate_`/`coerceDateStr_`/`todayStr_` at :1592–1650
- `connectors/gas/summary_audit.gs` — the whole file; `auditSummaryDrift_` at :51, `auditPurgeCutoff_` at :337, `auditDedupeSourceRows_`, `SUMMARY_AUDIT_PULL_OWNED_` at :40
- `connectors/gas/test_code.js` lines 250–360 (mock bootstrap + `load(...)`) and the existing `auditSummaryDrift` cases

## Task

**Nothing in this step writes to any Sheet.** This is instrumentation only, and it ships
and is run on its own deploy before the write path exists (`scripts/deploy.sh` pushes the
whole project, so read-only code cannot reach the editor alongside unwritten write code).

### 1. `computeHealPlan_(weeks, ctx)` in `connectors/gas/Code.gs`

The single source of truth for what a heal *would* do. Both the preview and the real heal
call it; they must never diverge, because the preview is the only look Jake gets before
real money moves.

`ctx` is built **once** by the caller and holds:
- `archiveWeeks` — a Set of `week_start` strings present in `_archive`
- `summaryRows` — the live `Summary` values array
- `supplierRows`, `revenueRows` — the source arrays

Returns, per requested week, `{week, action, rows, projectedSetValues, reason}` where
`action` is one of:
- `'heal'` — will write; `rows` is `[{key, live, computed, delta, isNew}]`
- `'skip-split'` — the week has at least one `_archive` row
- `'refuse-duplicate-keys'` — the live `Summary` already holds duplicate keys for this week

Rules that are load-bearing:
- Build the `_archive` week Set as `weekStartForDate_(coerceDateStr_(row[0]))` guarded by
  `DATE_ARG_RE`. `_archive` predates the blank-date guard and a raw cell reads back as a
  `Date`, not a string — an ungated build seeds a `''` key or throws mid-run.
- Duplicate detection mirrors `rowKey_`'s `trim().toLowerCase()` normalization exactly.
- **No pull-owned filtering of any kind.** See Prohibitions.

### 2. `previewSummaryHeal()` in `connectors/gas/summary_audit.gs`

Zero-arg editor entry point. Builds `ctx`, calls `computeHealPlan_` for the last 4
completed weeks, and logs a compact **line-per-week** report (one big
`Logger.log(JSON.stringify(...))` gets truncated by the editor — documented project
gotcha). Returns the plan object.

Must also report:
- `projectedSetValues` for the whole scheduled 4-week heal (feeds the >300 batching threshold)
- `projectedOverrideCost` — the `_archive` + `Summary` read sizes a *single* override call
  would pay, so the same threshold covers `greenBeanPull_`'s up-to-5-calls-per-run path

### 3. `auditSummaryDrift_(detail, minWeek)` window

Add an optional second parameter. `null`/absent ⇒ audit every week exactly as today —
the 14 existing audit tests and the manual `auditSummaryDrift()` entry point must be
untouched. When supplied, skip weeks `< minWeek`.

## Test First

Write these cases in `connectors/gas/test_code.js` and confirm they FAIL before implementing.

1. `computeHealPlan_` returns `action:'heal'` with correct `delta` for a week whose
   computed total differs from live.
2. A week with an `_archive` row returns `action:'skip-split'` and **no** `rows` to write.
3. `_archive` rows whose date cell is a `Date` object are still matched (not missed).
4. An `_archive` row with a **blank** date does not seed a `''` key and does not throw.
5. A week whose live `Summary` holds two rows with the same key returns
   `action:'refuse-duplicate-keys'`.
6. A `Suppliers` row for `Bennetts` with `location: ''` **IS** included in the plan
   (proves no pull-owned filtering — this is the inverse of a defect caught in review).
7. A `shopify_orderapp` online revenue row in live `Summary` never appears in the
   computed batch (it is structurally unreachable: `Code.gs:1710-1714` drops
   `channel='online'`).
8. `computeHealPlan_` performs **zero** writes — assert the mock records no `setValue`
   or `appendRow` calls.
9. `auditSummaryDrift_(false, null)` returns byte-identical output to
   `auditSummaryDrift_(false)` (window is opt-in).
10. `auditSummaryDrift_(false, '2026-03-01')` excludes weeks before that date and
    includes weeks on/after it.
11. `previewSummaryHeal()` reports both `projectedSetValues` and `projectedOverrideCost`.

## Acceptance Criteria

```bash
node connectors/gas/test_code.js   # all suites green, including every case above
```

## Verification Procedure

1. Run the AC command; the baseline is **1292 passed** plus the new cases.
2. Architecture checklist: no Sheet writes anywhere in this step; two-runtime boundary
   intact; CLAUDE.md CRITICAL rules intact.
3. Update this step in `phases/summary-self-heal/index.json` per the six-state vocabulary.

## Prohibitions

- **Do not filter the computed batch against `SUMMARY_AUDIT_PULL_OWNED_`, or any
  supplier-name list.** Reason: greenbean does NOT write `Summary` — it ingests
  `Suppliers` rows (`orderapp.gs:520`) and its vendor-named row is the *derived output* of
  `aggregateSupplierRows_`. Filtering would drop genuine spend from the current week and,
  because the audit's `missing` side has no such exclusion (`summary_audit.gs:122-135`),
  alert the dropped rows as missing money forever. `SUMMARY_AUDIT_PULL_OWNED_` is an
  audit-noise list, never a writer-ownership list.
- Do not write to any Sheet tab in this step. Reason: Step 0 ships on its own read-only deploy.
- Do not change the default behaviour of `auditSummaryDrift_`. Reason: 14 existing tests and a live manual entry point depend on it.
- Do not use bare `new Date()` for any stamped value — use `new Date(Date.now())`. Reason: `withMockNow` patches only `Date.now()`, so bare construction is untestable.
- Do not do date math via `toISOString()` on a local date. Reason: AEST off-by-one (documented project gotcha).
- Do not emit the report as one big `Logger.log(JSON.stringify(...))`. Reason: the editor truncates it and an approval gate then shows a list nobody has read.
- Do not break existing tests.
