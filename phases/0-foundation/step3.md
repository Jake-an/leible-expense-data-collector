# Step 3: integration-test  — DONE (18 tests passing)

## Files
- `connectors/gas/test_code.js` — zero-dependency Node-mock test runner

## What was built

`test_code.js` loads `Code.gs` / `square.gs` / `mayers.gs` via indirect `eval` under mocks of
`SpreadsheetApp`, `PropertiesService`, `ContentService` (+ stubs for `Utilities`/`Logger`/etc.),
then asserts against the pure logic — no clasp, no live Sheet.

Coverage:
- `normalizeSupplierRow` — column mapping, canonical-supplier resolution, per-row `supplier`
  override (Ordermentum), unknown-source fallback
- `ingestSupplierRows` — `source+invoice_ref` dedup within a batch and against the sheet
- `doPost` — happy path, batch-with-duplicate, missing-`total` error, missing-`source` error,
  unknown source ingests with raw supplier name
- `squareSumOrderGross_` — cents→dollars summation, ignores malformed orders, empty→0
- `parseMayersInvoice_` — real-invoice fixture (ref/total/DD-MMM-YY date), decoy exclusion (Ex Tax/GST/Pay Ref/Line Total), fallback date, null on no match

## Acceptance Criteria (met)
```bash
node connectors/gas/test_code.js   # → "18 passed, 0 failed", exit 0
```

## Prohibitions honoured
- No external test frameworks (plain runner).
- Square/Mayers live behavior (UrlFetchApp, GmailApp, Drive OCR) is **not** mocked end-to-end here —
  that is live verification after step 0, per the plan.
