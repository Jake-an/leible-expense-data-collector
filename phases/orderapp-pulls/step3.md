# Step 3: greenbean-invoice-grouping

## Requirements Covered

- `PRD-11` — Green bean committed spend via Order-app read API: aggregate line-grain stock-intake rows to invoice grain for the `Suppliers` tab

This is *why* this step exists. If the Task section below appears to contradict the
requirement above, `docs/ADR.md`, or a CRITICAL rule in CLAUDE.md, do NOT resolve the
conflict yourself — set `"status": "needs_context"` and stop.

## Files to Read

- `connectors/gas/orderapp.gs` (steps 0–2)
- `connectors/gas/Code.gs` :35 (`SUPPLIERS_HEADERS`), :60 (`SUPPLIERS_KEY_COLS = [5,3]` — source + invoice_ref), :332 (`normalizeSupplierRow` — the raw-row shape this step must produce), :445 (`ingestSupplierRows`)
- `docs/schema.md` (Suppliers tab contract)

## Task

Add to `connectors/gas/orderapp.gs` one **pure** function:

`greenBeanInvoices_(apiRows) → [{date, supplier, total, invoice_ref, department:'Roastery'}]`

Input: the Order app's greenBeanCost `rows[]` items. Relevant fields per row (exact
JSON keys from the Order app): `dateLocal` (`yyyy-MM-dd` Sydney-local), `supplierRaw`
(display name), `supplierKey` (normalized key), `invoiceNum`, `totalCostIncGst`
(number, AUD inc GST; non-numeric source cells arrive as `0` with a `flags` entry —
still counted, never dropped), `status` (RECEIVED/PENDING/UNKNOWN/OTHER — ALL statuses
count; committed spend is the locked product decision).

Mapping (the line→invoice grain rule — implement exactly):
- Group rows by `(supplierKey, invoiceNum)`.
- `invoice_ref = supplierKey + '/' + invoiceNum` — ALWAYS prefixed. Reason: the
  Suppliers dedup key is `source+invoice_ref` only; two suppliers sharing an invoice
  number under `source='greenbean'` would silently overwrite each other without the
  prefix, and a conditional prefix would be window-dependent (non-idempotent).
- Blank/missing `invoiceNum` → `invoice_ref = supplierKey + '/noinv-' + dateLocal`
  (grouped per supplier per Sydney day).
- `date = min(dateLocal)` across the group's rows.
- `supplier = supplierRaw` of the group's first row.
- `total = ` sum of `totalCostIncGst` across the group, rounded to 2dp ONCE at emit
  (not per-line).
- `department = 'Roastery'`. No `location`.

Output order: deterministic (e.g. sorted by invoice_ref) so tests are stable.

### Test First (TDD step)

Test cases (defined at design time — these are "done"):
- 3 lines, 1 invoice → one row; `total` = sum; `date` = earliest `dateLocal`
- two suppliers both carrying `invoiceNum:'INV-100'` → two rows with distinct refs (`keyA/INV-100`, `keyB/INV-100`)
- blank `invoiceNum`, same supplier, two different days → two rows (`key/noinv-<d1>`, `key/noinv-<d2>`)
- blank `invoiceNum`, same supplier, same day, two lines → one summed row
- rounding: lines `10.005 + 0.001` → total `10.01` (round once at emit)
- empty input → `[]`
- a flagged row with `totalCostIncGst: 0` → still contributes a row (never dropped)
- mixed statuses (RECEIVED + PENDING in one invoice) → single summed row, both lines counted

## Acceptance Criteria

```bash
node connectors/gas/test_code.js
```

## Verification Procedure

1. Run the AC command.
2. Checklist: function is pure (no Sheet/Properties/UrlFetchApp access); output shape matches `normalizeSupplierRow`'s expected raw-row fields.
3. Update this step in `phases/orderapp-pulls/index.json`.

## Prohibitions

- Do not filter by `status`. Reason: ALL statuses count as committed spend — locked product decision (grill round, 2026-08-06).
- Do not emit line-grain rows. Reason: Suppliers is invoice-grain; line items are explicitly out of MVP scope (PRD "Out of MVP Scope", ADR-003a).
- Do not derive dates from `timestampUtc`. Reason: UTC bucketing misfiles Sydney purchases into the previous day; `dateLocal` is already Sydney-local.
- Do not break existing tests.
