# Step 6 — silo-check-and-docs — findings

## 1. Silo proof (file:line evidence)

**`ShopSpend` / `ShopSpendPulls` / `ShopSpend Report` are reached only by `shopspend.gs` +
the tab constants/normalizers in `Code.gs` + `doGetShopSpendCoverage_` behind its own `fn`:**

- Tab constants: `Code.gs:41-43` (`SHOPSPEND_TAB`, `SHOPSPEND_PULLS_TAB`, `SHOPSPEND_REPORT_TAB`).
- Write path: `doPost`'s `kind === 'shopspend'` branch (`Code.gs:257-262, 292, 342, 407`) calls
  `ensureShopSpendTabs_` (`shopspend.gs:16`) and `ingestShopSpendRows` (`shopspend.gs:58`);
  row/pull normalizers `normalizeShopSpendRow` (`Code.gs:516`) and the pull-metadata mapper
  (`Code.gs:536`).
- Report rebuild: `buildShopSpendReport_impl_` / `buildShopSpendReport` (`shopspend.gs:399,424`).
- Watchdog: `shopSpendWatchdog*` (`shopspend.gs:535-606`), its own trigger
  (`installShopSpendWatchdogTrigger`, `shopspend.gs:606`) — separate from every other watched
  source in `STALENESS_SOURCES`.
- Read path: `doGet` only reaches `ShopSpendPulls` when `fn=shopspendCoverage` explicitly
  (`Code.gs:1687` → `doGetShopSpendCoverage_`, `Code.gs:1753`), which delegates span expansion
  to `shopSpendCoveredWeeks_` (`shopspend.gs:510`). The default `fn=summary` branch
  (`Code.gs:1685-1686` → `doGetSummary_`, `Code.gs:1694`) never touches it.

**`weeklySummarize_impl_`, `aggregateSupplierRows_`, the default `doGet` path and
`summary_audit.gs` read only `Suppliers`, `Revenue`, `Summary` and `_archive`:**

- `weeklySummarize_impl_` (`Code.gs:2570`) opens `SUPPLIERS_TAB` (`:2572`) and ensures
  `SUMMARY_TAB` / `ARCHIVE_TAB` / `REVENUE_TAB` / `SUMMARY_HEAL_BACKUP_TAB` (`:2575-2578`).
  No `SHOPSPEND_*` constant appears anywhere in this function.
- `aggregateSupplierRows_` (`Code.gs:1894`) takes an in-memory `rows` array and a `kind` of
  `'spend'`/`'revenue'` as arguments — it has **no sheet access of its own**, so it is
  structurally incapable of reading `ShopSpend`.
- `doGetSummary_` (`Code.gs:1694`) opens `SUMMARY_TAB` only (`:1697`).
- `summary_audit.gs` opens `SUMMARY_TAB` / `SUPPLIERS_TAB` / `ARCHIVE_TAB` / `REVENUE_TAB` /
  `SUMMARY_HEAL_BACKUP_TAB` at every `getSheetByName` call site (`:57,60-62,237-238,
  430-433,547,550-552,718,799,925`). A full-file grep for `ShopSpend|shopSpend|shopspend`
  returns exactly **one** hit in the whole file (`:879`), and it is a comment enumerating
  trigger-handler names (`shopSpendWatchdog, checkIngestStaleness, weeklySummarize, ...`) —
  not a read.

**Therefore nothing anywhere adds shopSpend dollars to wholesale dollars.** The two pipelines
share no function, no tab, and no in-memory row.

## The silo is a reporting boundary, not a data-level one

Step 0's PROD probe found the sharper fact: a single order sampled from the Order app carries
`invoiceStatus: 'Finalized'` **and** `status: 'Receipt Confirmed'` at the same time
(`phases/roastery-wholesale/prod-probe.md:61-66`). `?api=shopSpend` scopes to confirmed orders
via `status` (`Receipt Confirmed` + `Amendment Requested`, `docs/architecture.md:249`);
`?api=wholesaleSales` scopes via `invoiceStatus` (`Finalized`/`Archived`,
`phases/roastery-wholesale/step1.md:32`). Both filters can be true of the **same order** —
the two read APIs are two different views over one shop-order sheet, not two disjoint data
sets. The silo documented above holds only because no report in this repo reads both tab
families together; it is not true that the underlying orders are partitioned. Stated plainly
in `docs/schema.md` and `docs/ingest-contract.md` below.

## 2. `summaryOrphanSweep_` bounds

`summaryOrphanSweep_` (`summary_audit.gs:545`) **does** cover `kind='revenue'` rows: its
recompute step concatenates `aggregateSupplierRows_(sourceRows, ..., 'spend')` with
`aggregateSupplierRows_(revenueRows, ..., 'revenue')` (`:584-585`), and the candidate scan only
special-cases `supplier === 'shopify_orderapp'` or `'labour'` for exclusion (`:604`) — a
wholesale customer row is not exempted.

It skips, though:
- any week **before** `purgeCutoff` (`:581` in the recompute loop, `:600` in the candidate
  loop) — the same 183-day purge line every other audit in this file respects.
- any week carrying `_archive` rows (`:582` recompute loop, `:601` candidate loop) — the SPLIT
  guard, deferred to the archive-aware repair this file already documents as out of scope.

**Consequence:** a shop reclassified upstream (e.g. a wholesale customer later reclassified
`internal`, or vice versa) before the purge line, in a week that never gets archived, orphans
a `location='wholesale'` (or `internal`/`ambiguous`/`unknown`) Summary row that nothing will
ever sweep — the recompute simply never runs for that week. This is an existing bound of the
sweep, not something PRD-14 introduces; PRD-14 just adds a new row shape the bound applies to.

## Verification

```
bash scripts/lint.sh          → PASS
node connectors/gas/test_code.js → 1993 passed, 0 failed (unchanged from step 5)
```

`git diff --stat` after this step: `docs/schema.md`, `docs/ingest-contract.md`, `docs/api.md`,
`TODO.md`, `phases/roastery-wholesale/index.json`, `phases/roastery-wholesale/step6-report.md`.
No `.gs` file changed.
