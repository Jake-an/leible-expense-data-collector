# Step 1: shopspend-tabs-and-constants

## Files to Read

- `docs/schema.md` — the shopSpend tab specs written in step 0. They are the contract for the
  header arrays you declare here.
- `connectors/gas/Code.gs` — read the constant block at **lines 21-49**: tab names (`21-27`),
  header arrays (`29-31`, `35-36`), and the dedup key-column block (`41-49`). Also read
  `ensureSheet` (**573-583**) and `getHubSpreadsheet_`.
- `connectors/gas/test_code.js` — read the header comment at **lines 22-26** (why header arrays
  are read off `globalThis`, never redeclared locally), `sheetCoerceOnWrite` / `cellDate`
  (**39-55**), `makeSheet` (**57+**), the `load()` helper and load block (**241-263**), and the
  `check()` harness (**272+**).

## Background

Three new tabs are being added as a separate silo. `ensureSheet(ss, sheetName, headers)`
(`Code.gs:573`) appends the header row **only inside its `if (!sheet)` branch** — so brand-new tabs
are safe, but it will never repair a header on a tab that already exists. That makes the header
arrays declared in this step effectively permanent; getting them right now avoids a hand-written
migration later (the precedent for one is `migrateSummaryHeaders_`, `Code.gs:754`).

## Task

**1. Constants — in `connectors/gas/Code.gs`, in the existing constant block (lines 21-49).**
Follow the established pattern exactly: module-level `var`, tab names grouped with tab names,
header arrays grouped with header arrays. They live in `Code.gs` even though the logic will live
in `shopspend.gs` — that is the existing convention (`SALES_HEADERS` is consumed by `square.gs`,
`REVENUE_HEADERS` by `shopify.gs`).

```js
var SHOPSPEND_TAB = 'ShopSpend';
var SHOPSPEND_PULLS_TAB = 'ShopSpendPulls';
var SHOPSPEND_REPORT_TAB = 'ShopSpend Report';

var SHOPSPEND_HEADERS = ['shop_id', 'week_label', 'week_start', 'week_end', 'order_count',
  'amended_count', 'total_ex_gst', 'gst', 'total_inc_gst', 'gst_treatment', 'environment',
  'fetched_at', 'source', 'presence'];

var SHOPSPEND_PULLS_HEADERS = ['fetched_at', 'environment', 'from_week', 'to_week', 'matched',
  'returned', 'truncated', 'warnings_count', 'warnings', 'unpriced_sku_count', 'unpriced_skus',
  'amended_count', 'possible_duplicate_shop_names', 'empty_range_with_invalid_labels',
  'invalid_week_labels', 'gst_treatment', 'diverges_from_live_pricing', 'matches_live_pricing',
  'total_orders_scanned', 'absent_shop_ids', 'diagnostics_json'];

// Change-detection key into a normalized ShopSpend row array: shop_id + week_label.
// NOT an upsert key — ShopSpend is append-only (see step 3).
var SHOPSPEND_KEY_COLS = [0, 1];
```

**2. New file `connectors/gas/shopspend.gs`.** Header comment stating: separate silo, append-only,
never routed through `upsertRows_`, and that the file is loaded by `test_code.js`. Implement one
function for now:

```js
/**
 * Ensure the three shopSpend tabs exist with their header rows.
 * @returns {{ data: Sheet, pulls: Sheet, report: Sheet }}
 */
function ensureShopSpendTabs_(ss) { /* ensureSheet ×3 */ }
```

**3. Register the new file with the test harness** — add `load('shopspend.gs');` to the load block
in `connectors/gas/test_code.js` (**alongside lines 258-263**, after `load('Code.gs')` and after
`currentSS = makeSpreadsheet()`).

Core rules that must not deviate:
- Do NOT add the new tabs to `DEPARTMENT_TABS` (`Code.gs:590`) or to `setupSheets()`
  (`Code.gs:446`). Reason: those drive the department migration; shopSpend has no `department`
  column and must stay out of that blast radius.
- Read header arrays in tests off `globalThis`, never as local literals. Reason: `test_code.js:22-26`
  documents that shadowing is exactly the bug that let a broken dedup ship under a green suite.

### Test First (TDD step)

Add the cases below to `connectors/gas/test_code.js` **before** implementing. A newly-added failing
assertion turns the whole run RED (`node connectors/gas/test_code.js`, exit 1). Confirm RED is for
the right reason — `ensureShopSpendTabs_` / the constants are undefined, not a harness fault.

Test cases (these are the definition of done):
- **Constants exist on the globals:** `globalThis.SHOPSPEND_TAB === 'ShopSpend'`,
  `SHOPSPEND_PULLS_TAB === 'ShopSpendPulls'`, `SHOPSPEND_REPORT_TAB === 'ShopSpend Report'`.
- **Header arrays are exact and ordered:** `SHOPSPEND_HEADERS` has 14 entries ending in
  `presence`, and `SHOPSPEND_HEADERS[0] === 'shop_id'`, `[1] === 'week_label'`;
  `SHOPSPEND_PULLS_HEADERS` has 21 entries, `[0] === 'fetched_at'`, last is `diagnostics_json`.
- **Key cols point at the right columns:** `SHOPSPEND_HEADERS[SHOPSPEND_KEY_COLS[0]] === 'shop_id'`
  and `SHOPSPEND_HEADERS[SHOPSPEND_KEY_COLS[1]] === 'week_label'` — asserted through the header
  array, so a future column insert that silently breaks the key fails the suite.
- **Tab creation:** `ensureShopSpendTabs_(ss)` on an empty mock spreadsheet creates all three tabs;
  each returned sheet's row 1 equals its header array; the data tab has exactly 1 row (header only,
  no phantom blank row).
- **Idempotent:** calling `ensureShopSpendTabs_(ss)` a second time creates nothing new and does not
  duplicate or rewrite the header row.
- **Silo intact:** the existing tabs are untouched — `Suppliers`/`Sales`/`Revenue`/`Summary`
  headers unchanged, and the full pre-existing suite still passes.

## Acceptance Criteria

```bash
node connectors/gas/test_code.js      # all tests pass incl. the new cases; exit 0
```

## Verification Procedure

1. Run the AC command.
2. Architecture checklist:
   - Constants live in `Code.gs`, logic in `shopspend.gs` — matches the existing convention.
   - `git diff connectors/gas/Code.gs` is purely additive inside the constant block.
   - No CLAUDE.md CRITICAL rule touched: no Sheet-write path outside GAS, two-tab contract intact.
3. Update `phases/shopspend/index.json` step 1 (`completed` + `summary`, or `error` +
   `error_message`, or `blocked` + `blocked_reason` then stop).

## Prohibitions

- Do not modify `doPost`, `validateIngest_`, or any ingest function. Reason: that is step 2.
- Do not implement change detection, the report, or the watchdog. Reason: steps 3, 6, 7.
- Do not add the tabs to `DEPARTMENT_TABS` or `setupSheets()`. Reason: department-migration blast
  radius; shopSpend has no `department` column.
- Do not declare local copies of any `*_HEADERS` array in `test_code.js`. Reason: see
  `test_code.js:22-26` — shadowing silently diverges tests from production.
- Do not change any existing header array. Reason: `ensureSheet` never migrates a live tab, so an
  edited constant does nothing to the real Sheet and only desynchronises code from data.
