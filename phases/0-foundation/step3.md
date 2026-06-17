# Step 3: integration-test  — DONE (16 tests passing)

## Files
- `connectors/gas/test_code.js` — zero-dependency Node-mock test runner

## What was built

`test_code.js` loads `Code.gs` / `square.gs` / `myers.gs` via indirect `eval` under mocks of
`SpreadsheetApp`, `PropertiesService`, `ContentService` (+ stubs for `Utilities`/`Logger`/etc.),
then asserts against the pure logic — no clasp, no live Sheet.

Coverage:
- `normalizeSupplierRow` — column mapping, canonical-supplier resolution, per-row `supplier`
  override (Ordermentum), unknown-source fallback
- `ingestSupplierRows` — `source+invoice_ref` dedup within a batch and against the sheet
- `doPost` — happy path, batch-with-duplicate, missing-`total` error, missing-`source` error,
  unknown source ingests with raw supplier name
- `squareSumOrderGross_` — cents→dollars summation, ignores malformed orders, empty→0
- `parseMyersInvoice_` — ref+total+DD/MM/YYYY parse, received-date fallback, null on no match

## Acceptance Criteria (met)
```bash
node connectors/gas/test_code.js   # → "16 passed, 0 failed", exit 0
```

## Prohibitions honoured
- No external test frameworks (plain runner).
- Square/Myers live behavior (UrlFetchApp, GmailApp) is **not** mocked end-to-end here —
  that is live verification after step 0, per the plan.
