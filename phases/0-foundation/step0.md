# Step 0: sheet-and-gas-setup

## Status: BLOCKED — requires manual action by Jake

This step cannot be automated. Jake must:

1. Create a new Google Sheet named "LEIBLE Expense Hub".
2. Add three tabs with headers matching `docs/schema.md`:
   - `Suppliers`: `date | supplier | total | invoice_ref | location | source | extracted_at`
   - `Sales`: `date | location | gross_sales | source | extracted_at`
   - `_staging`: same columns as `Suppliers` (scratch area for test ingestion)
   - (GAS `ensureSheet` will also create these on first write, but creating them up front lets Jake eyeball the layout.)
3. Create a Google Apps Script project bound to the Sheet (Extensions → Apps Script).
4. Note the GAS script ID from the URL (the long string after `/projects/`).
5. Add the four Square access tokens to Script Properties (Project Settings → Script Properties):
   `SQUARE_ACCESS_TOKEN_YORK`, `SQUARE_ACCESS_TOKEN_NORTH_SYDNEY`,
   `SQUARE_ACCESS_TOKEN_CROWSNEST`, `SQUARE_ACCESS_TOKEN_PITT`
   (same tokens used by LEIBLE_Payroll / GM Cost Monitor). Optionally set `HUB_SHEET_ID`
   if the project is not bound to the Sheet.
6. `npm install -g @google/clasp` (if needed), then `clasp login`.
7. Create `config/clasp.json` with:
   ```json
   { "scriptId": "<the-script-id>", "rootDir": "connectors/gas" }
   ```

Once done, set this step's status to `"completed"` in `phases/0-foundation/index.json` with a
summary like: `"Sheet + 3 tabs created, GAS project <id>, Square tokens set, clasp configured"`.

## Acceptance Criteria
- Google Sheet exists with `Suppliers` / `Sales` / `_staging` tabs and correct headers
- GAS project is bound to the Sheet (or `HUB_SHEET_ID` set)
- Four `SQUARE_ACCESS_TOKEN_*` properties present in Script Properties
- `config/clasp.json` exists with a valid scriptId
