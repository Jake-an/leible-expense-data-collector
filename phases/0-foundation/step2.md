# Step 2: normalize-and-dedup  — DONE (code-complete)

## Files
- `connectors/gas/Code.gs` — `normalizeSupplierRow`, `canonicalSupplier_`, `ingestSupplierRows`,
  `isDuplicate`-equivalent (`buildKeySet_` / `rowKey_`), `appendSalesRow_`

## What was built

### `normalizeSupplierRow(row, source, extractedAt)`
Returns the `Suppliers` column array:
`[date, supplier, total, invoice_ref, location, source, extracted_at]`
- `supplier` resolved by `canonicalSupplier_`: per-row `row.supplier` wins (Ordermentum),
  else the `SUPPLIER_NAMES` map (`food_dairy_co → Food and Dairy Co`, …), else the raw source.
- `total` coerced to Number; `location` defaults to `""`.

### Dedup (`source + invoice_ref`)
- `buildKeySet_(sheet, keyCols)` reads the sheet once and builds a key lookup (skips header).
- `ingestSupplierRows` dedups against the sheet **and** earlier rows in the same batch,
  returning `{ rowsAdded, duplicatesSkipped }`.
- `appendSalesRow_` does the same for the `Sales` tab with key `date + location`.

The old 9-column schema (description/amount/category/raw_data, key `source+date+amount+description`)
was replaced — see `docs/ADR.md` ADR-003a.

## Acceptance Criteria (met)
```bash
grep -q "function normalizeSupplierRow" connectors/gas/Code.gs
grep -q "function ingestSupplierRows" connectors/gas/Code.gs
grep -q "duplicatesSkipped" connectors/gas/Code.gs
```
