# Step 0: shopspend-docs

## Files to Read

- `docs/schema.md` — the existing tab specs. You are ADDING three tabs, not changing any existing one.
- `docs/ARCHITECTURE.md` — the two-runtime design and the POST bridge. You are adding one new data flow.
- `docs/PRD.md` — `PRD-7` and `PRD-8` already exist (added during scaffolding). Do not renumber anything.

## Background

We are building a consumer for an **external** internal Apps Script JSON API called `shopSpend`,
which reports per-shop, per-ISO-week order dollars. It is a **separate silo** from the existing
`Suppliers` / `Sales` / `Revenue` / `Summary` pipeline: no existing tab, header, or the `doGet`
contract changes.

Three new tabs:

**`ShopSpend`** — append-only snapshot store. Headers, in order:
`shop_id`, `week_label`, `week_start`, `week_end`, `order_count`, `amended_count`,
`total_ex_gst`, `gst`, `total_inc_gst`, `gst_treatment`, `environment`, `fetched_at`, `source`,
`presence`.

- Change-detection key is `shop_id` + `week_label`.
- A re-pull **appends a new row only when a figure changed**; identical figures are skipped.
- `presence` is `present` or `absent`. An `absent` row is a tombstone written when a shop-week that
  existed in a previous pull is missing from the current one.
- **"Latest snapshot" means the last matching row in append order** — explicitly NOT max
  `fetched_at`, because `fetched_at` carries a UTC offset and a lexicographic compare orders the
  Australia/Sydney DST flip (`+11:00` → `+10:00`) wrongly.

**`ShopSpendPulls`** — one row per pull, always written, even when nothing changed. Headers:
`fetched_at`, `environment`, `from_week`, `to_week`, `matched`, `returned`, `truncated`,
`warnings_count`, `warnings`, `unpriced_sku_count`, `unpriced_skus`, `amended_count`,
`possible_duplicate_shop_names`, `empty_range_with_invalid_labels`, `invalid_week_labels`,
`gst_treatment`, `diverges_from_live_pricing`, `matches_live_pricing`, `total_orders_scanned`,
`absent_shop_ids`, `diagnostics_json`.

This tab is what makes history reproducible: the upstream API recomputes totals live from a pricing
sheet, so re-pulling the same week can legitimately return different numbers.

**`ShopSpend Report`** — derived, rebuilt in place. A banner block, then shops down × ISO weeks
across (sorted numerically by parsed `(year, weekNumber)`, never lexicographically on the label).

## Task

1. In `docs/schema.md`, add a `shopSpend tabs` section documenting the three tabs above: every
   column, the change-detection key, the append-only + only-when-changed rule, the `presence`
   tombstone semantics, and the "latest = last in append order" rule. State explicitly that these
   tabs are outside the two-tab ingest contract and that no report reads them except
   `ShopSpend Report`.

2. In `docs/ARCHITECTURE.md`, add the shopSpend flow. Include this diagram verbatim:

```
Windows Task Scheduler (Mon 05:00)
  -> connectors/shopspend/runner.py   (resolve env, find missing closed ISO weeks)
  -> connectors/shopspend/client.py   (typed; follow redirects; branch on body.ok, NEVER on
                                       HTTP status; retry only INTERNAL / non-JSON / transport)
  -> our GAS doPost  kind:'shopspend' (chunks of 200 rows, one shared fetched_at,
                                       ShopSpendPulls row LAST = commit marker)
       -> ShopSpend        (append-only snapshots, only when changed)
       -> ShopSpendPulls   (one row per pull + diagnostics)
            -> buildShopSpendReport() -> "ShopSpend Report"
  GAS trigger Mon 14:00 AEST: shopSpendWatchdog() — "did last week's pull land?"
```

3. Record these three facts in `docs/ARCHITECTURE.md` because they are non-obvious and easy to
   get wrong later:
   - The external `shopSpend` API is `gstTreatment: EXCLUSIVE_PRIMARY`; the sibling green-bean
     cost API is `INCLUSIVE`. Never chart one against the other without asserting on
     `meta.gstTreatment`. `gst: 0` on a shop is normal — many coffee SKUs are GST-free.
   - The API's main failure mode is **under-reporting real money**. Totals are a floor, not a
     truth: when `unpricedSkus` is non-empty those line items were skipped entirely.
   - Scope is confirmed orders only (`Receipt Confirmed` + `Amendment Requested`), excluding
     Shopify/online shops. `amendedCount > 0` means those dollars are still provisional.

## Acceptance Criteria

```bash
python -c "import pathlib; s=pathlib.Path('docs/schema.md').read_text(encoding='utf-8'); assert 'ShopSpendPulls' in s and 'presence' in s and 'append order' in s; print('schema.md ok')"
python -c "import pathlib; a=pathlib.Path('docs/ARCHITECTURE.md').read_text(encoding='utf-8'); assert 'shopSpend' in a and 'EXCLUSIVE_PRIMARY' in a and 'doPost' in a; print('ARCHITECTURE.md ok')"
```

## Verification Procedure

1. Run both AC commands.
2. Confirm no existing tab spec in `docs/schema.md` was edited — `git diff docs/schema.md` must be
   purely additive.
3. Update `phases/shopspend/index.json` step 0:
   - Success → `"status": "completed"`, `"summary": "<what was documented>"`
   - Failure after 3 retries → `"status": "error"`, `"error_message": "<specifics>"`
   - User intervention required → `"status": "blocked"`, `"blocked_reason": "<specifics>"`, stop.

## Prohibitions

- Do not write any code in this step. Reason: this is the docs step; every guardrail doc that
  later steps declare must exist and be correct before they run.
- Do not modify the specs of `Suppliers`, `Sales`, `Revenue`, `Summary`, `Labour`, or `_archive`.
  Reason: shopSpend is a separate silo; touching the two-tab contract is out of scope.
- Do not renumber or reword `PRD-1`..`PRD-6`. Reason: PRD IDs are permanent and are referenced by
  every phase's `covers` fields.
- Do not describe the report as re-deriving week boundaries. Reason: `weekStart`/`weekEnd` come
  from the API and must be passed through, never recomputed.
