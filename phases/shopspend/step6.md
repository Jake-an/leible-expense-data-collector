# Step 6: shopspend-report-builder

## Files to Read

- `docs/schema.md` — the `ShopSpend Report` spec (step 0), and the "latest = last row in append
  order" rule.
- `connectors/gas/shopspend.gs` — `ensureShopSpendTabs_` and `ingestShopSpendRows` (steps 1-3),
  including the latest-snapshot index you already built.
- `connectors/gas/Code.gs` — `withScriptLock_` (**86**) and the way `weeklySummarize` wraps its
  entry point (**1493-1504**); `fillBlankDepartments_` (**726-741**) as the contiguous-block
  `setValues()` precedent; `coerceDateStr_` (**1316**).
- `connectors/gas/test_code.js` — `cellDate` (**51-55**), `makeSheet` (**57+**).

## Background — this is the deliverable that matters

The upstream API's stated main failure mode is **under-reporting real money**. A report that
renders totals and drops `diagnostics.warnings[]` shows numbers that are quietly too low, and no
one finds out. The banners below are therefore **not optional polish** — they are the reason this
phase exists.

Three things make the numbers softer than they look:
- `unpricedSkus` non-empty means orders contained SKUs with no price in the source pricing sheet
  and **those line items were skipped entirely**. Totals are a floor, not a truth.
- `amendedCount > 0` means some of that week's dollars are still provisional and may change.
- `possibleDuplicateShopNames` means two spellings of one shop are being reported as separate rows.
  **Never merge them automatically** — `shopId` is free text and two similar names may be genuinely
  different shops. Surface it for a human to fix upstream.

Two more that are easy to get wrong:
- `pricingBasis.divergesFromLivePricing` counts orders whose stored total no longer matches what
  their SKUs cost at today's prices. That includes ordinary post-invoice price changes. It is a
  **drift signal, not provenance** — never render it as "N orders used stale pricing".
- `emptyRangeWithInvalidLabels: true` means the range returned nothing *and* some orders elsewhere
  have unreadable week labels. Show **"unconfirmed"**, never `$0`.

This codebase has **no precedent for a rebuilt tab** — every existing tab is append or
upsert-in-place, and `grep clearContents` returns nothing. So this is a read-modify-write and the
entry point must be wrapped in `withScriptLock_`, mirroring `weeklySummarize`.

## Task

In `connectors/gas/shopspend.gs`:

```js
/** Entry point — wraps the rebuild in withScriptLock_. Zero-arg safe. */
function buildShopSpendReport() { ... }

/** Pure: (snapshotRows, latestPull) -> 2D array ready for a single setValues(). */
function shopSpendReportBlock_(snapshotRows, latestPull) { ... }
```

**Grid.** Latest snapshot per `(shop_id, week_label)` — last row in append order, NOT max
`fetched_at`. Shops down the rows, ISO weeks across the columns, sorted numerically by parsed
`(year, weekNumber)`. Never sort lexicographically on the label: `'2026-W9'` sorts after
`'2026-W10'` as a string. A `presence: 'absent'` latest snapshot renders as `stale` (see banner),
not as a dollar figure.

**Banner block, written above the grid:**

| Condition | Banner |
|---|---|
| `warnings[]` non-empty | Every warning listed verbatim. Never suppressed, never summarised away. |
| `unpriced_sku_count > 0` | `⚠ TOTALS ARE APPROXIMATE — N SKUs unpriced; those line items were skipped entirely.` Totals additionally rendered with a `~` prefix. |
| any row with `amended_count > 0` | `N shop-weeks contain amended orders — provisional, may change.` Mark those cells. |
| `possible_duplicate_shop_names` non-empty | `Possible duplicate shop names — fix upstream. NOT merged automatically.` + the names. |
| `empty_range_with_invalid_labels` true | Affected cells read `unconfirmed`, never `$0`. |
| any `presence: 'absent'` | `N shop-weeks present in a prior pull are absent from the latest pull — values shown are stale.` Mark those cells. |
| always | `meta.gstTreatment` stated on the tab (`EXCLUSIVE_PRIMARY`), plus a note that `gst: 0` is normal because many coffee SKUs are GST-free. |
| always | Price-drift count from `pricingBasis`, labelled **drift** — not "stale pricing". |
| always | `Confirmed orders only; excludes Shopify/online shops.` + the last `fetched_at`. |

**Write discipline.** Build the entire block (banners + grid) into one 2D array, `clearContents()`
the tab, then a single `setValues()`. Reason: a run that dies mid-rebuild must not leave a visibly
half-broken report. `ensureSheet` creates but never clears, so the clear is yours to do.

Core rules that must not deviate:
- `shopSpendReportBlock_` is **pure** — takes rows, returns an array, touches no `SpreadsheetApp`.
  Reason: that is what makes the banner logic unit-testable.
- Wrap the **entry point** in `withScriptLock_`, not the inner writer. Reason: the codebase rule at
  `Code.gs:60-80`.
- Never mutate the `ShopSpend` or `ShopSpendPulls` tabs from here. Reason: this is a read-only
  consumer of the snapshot store.

### Test First (TDD step)

Add cases to `connectors/gas/test_code.js` before implementing. Drive `shopSpendReportBlock_`
directly with fixture arrays — no spreadsheet needed for the banner assertions. Confirm RED, then
green.

Test cases (definition of done):
- **Week ordering:** columns for `2026-W9`, `2026-W10`, `2026-W52`, `2027-W01` appear in that
  numeric order. Assert the contrast: a lexicographic sort would put `2026-W10` before `2026-W9`.
- **Latest snapshot wins:** two snapshots for one key → the grid shows the last-appended one, and
  the DST fixture (`+11:00` row appended before a `+10:00` row) still resolves to the second.
- **Each banner fires on its condition and is absent otherwise** — one test per row of the table
  above.
- **`unpricedSkus` → approximate:** with `unpriced_sku_count: 6`, the banner is present AND the
  rendered totals carry the `~` marker.
- **`emptyRangeWithInvalidLabels` → `unconfirmed`, never `$0`:** assert the block contains no
  `'$0'`/`0` cell for the affected range.
- **Absent tombstone → stale marking**, not a dollar figure.
- **Duplicate shop names are surfaced but NOT merged:** two similar `shop_id`s remain two separate
  rows in the grid.
- **Drift wording:** the price-drift banner does not contain the substring `stale pricing`.
- **GST basis always stated:** `EXCLUSIVE_PRIMARY` appears in the block on every build.
- **Single write:** the rebuild issues one `clearContents()` and one `setValues()` — assert via the
  mock's recorded calls, not `appendRow` in a loop.
- **Lock:** `buildShopSpendReport()` goes through `withScriptLock_`.
- **No mutation:** the `ShopSpend` and `ShopSpendPulls` tabs are byte-identical after a rebuild.
- **No regression:** the full existing suite passes.

## Acceptance Criteria

```bash
node connectors/gas/test_code.js      # all tests pass incl. the new cases; exit 0
```

## Verification Procedure

1. Run the AC command.
2. Architecture checklist:
   - Report reads snapshots only; no writes outside `ShopSpend Report`.
   - Entry point locked; block written in one `setValues()`.
   - No existing tab or endpoint touched.
3. Update `phases/shopspend/index.json` step 6 (`completed` + `summary`, or `error` +
   `error_message`, or `blocked` + `blocked_reason` then stop).

## Prohibitions

- Do not suppress, truncate, or summarise `warnings[]`. Reason: it is the API's only channel for
  telling us the totals are wrong; hiding it is the failure this phase exists to prevent.
- Do not merge similar `shop_id` values. Reason: free text; merging risks combining genuinely
  different shops. Surface for a human.
- Do not render `$0` when `empty_range_with_invalid_labels` is true. Reason: it means unknown, not
  zero — and "$0" reads as a fact.
- Do not label price drift as "stale pricing". Reason: it counts ordinary post-invoice price
  changes; that wording would send someone chasing a non-bug.
- Do not sort weeks lexicographically. Reason: `2026-W9` vs `2026-W10`.
- Do not build the watchdog or its trigger. Reason: step 7.
