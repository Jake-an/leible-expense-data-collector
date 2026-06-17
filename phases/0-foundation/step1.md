# Step 1: dopost-endpoint  — DONE (code-complete; live deploy blocked on step 0)

## Files
- `connectors/gas/Code.gs` — `doPost`, `validateIngest_`, `jsonOut_`, `ensureSheet`
- `connectors/gas/appsscript.json` — web-app manifest

## What was built

`doPost(e)` receives a supplier ingest payload and appends new rows to the `Suppliers` tab.

**Input shape** (two-tab contract — see `docs/ARCHITECTURE.md`):
```json
{
  "source": "food_dairy_co",
  "rows": [ { "date": "2026-06-15", "total": 245.50, "invoice_ref": "INV-10293", "location": "York St" } ],
  "extracted_at": "2026-06-17T09:30:00+10:00"
}
```

**Behavior:**
- Parse `e.postData.contents`; `validateIngest_` requires `source` (string), `rows` (array),
  `extracted_at`, and each row to have `date`, `total` (numeric), `invoice_ref`.
- Resolve the hub Sheet (`HUB_SHEET_ID` property or bound active Sheet), `ensureSheet('Suppliers', …)`.
- `ingestSupplierRows` normalizes + dedups + appends.
- Returns `{ result:"ok", rowsAdded, duplicatesSkipped }` or `{ result:"error", message }`.
- Whole body wrapped in try/catch — never throws out of `doPost`.

`appsscript.json`: `timeZone` Australia/Sydney, V8, webapp `ANYONE_ANONYMOUS` / `USER_DEPLOYING`.

## Acceptance Criteria (met)
```bash
node -e "JSON.parse(require('fs').readFileSync('connectors/gas/appsscript.json'))"
grep -q "function doPost" connectors/gas/Code.gs
```
Live POST verification is blocked on step 0 (deploy) — see the plan's Verification section.
