# Step 2: sales-dedup-coerce

## Files to Read

First, read these to understand the design intent before touching code:

- `/docs/schema.md` — the `Sales` tab dedup contract: the key is `date`+`location`. Re-running / backfilling the same day must NOT append a duplicate.
- `connectors/gas/Code.gs` — the file you will modify. Read `rowKey_` (~176-182), `SALES_KEY_COLS = [0, 1]` (~line 32, date + location), `buildKeySet_` (~167-174), `appendSalesRow_` (~155-161), and `coerceDateStr_` (~603-611, already handles `v instanceof Date` → local `YYYY-MM-DD`).
- `connectors/gas/test_code.js` — the Node-mock harness. Read the top-of-file `sheetCoerceOnWrite` / `cellDate` helpers (~lines 36-52) — the mock deliberately parses a bare `YYYY-MM-DD` written string back into a `Date` on read, exactly as a real Sheet does. Read `testSalesRowIsCorrupt` (~631) and the other Sales tests for the invocation pattern.

## Background (the bug)

The Sales-tab dedup is broken. `SALES_KEY_COLS = [0, 1]` keys on the **date** column (index 0) + location, but `rowKey_` builds the key with a **bare `String(rowArray[keyCols[i]])`** and no coercion:

```js
function rowKey_(rowArray, keyCols) {
  var parts = [];
  for (var i = 0; i < keyCols.length; i++) {
    parts.push(String(rowArray[keyCols[i]]).trim().toLowerCase());
  }
  return parts.join('||');
}
```

A written `'2026-07-15'` comes back from Sheets as a `Date` object on read. So:
- existing row's key → `String(Date) = "wed jul 15 2026 00:00:00 gmt+1000..."||"york"`
- new row's key → `"2026-07-15"||"york"`

These never match → `appendSalesRow_` sees the new row as unseen → **appends a duplicate → gross double-counted** on every re-run / backfill / overlapping trigger, violating the `date`+`location` contract. Every OTHER date path in `Code.gs` (lines ~271, ~494, ~672) already routes through `coerceDateStr_` — this one path forgot it. (See project memory: "Sheet date coercion".)

## Task

In `connectors/gas/Code.gs`, make `rowKey_` coerce `Date`-typed key columns before stringifying:

```js
function rowKey_(rowArray, keyCols) {
  var parts = [];
  for (var i = 0; i < keyCols.length; i++) {
    var v = rowArray[keyCols[i]];
    v = (v instanceof Date) ? coerceDateStr_(v) : v;   // <-- the fix
    parts.push(String(v).trim().toLowerCase());
  }
  return parts.join('||');
}
```

Core rules that must not deviate:
- Use the EXISTING `coerceDateStr_` (Code.gs:603) — do NOT hand-roll date formatting or use `toISOString()`. Reason: `toISOString()` shifts AEST midnight to the previous UTC day (off-by-one); `coerceDateStr_` uses local components deliberately.
- The coercion must apply to ANY `Date`-typed key col generically (via `instanceof Date`), not be special-cased to index 0. Reason: `rowKey_` is shared by `SALES_KEY_COLS` and `SUPPLIERS_KEY_COLS`; a future date key col must be safe too.
- Non-`Date` values (strings like the location) must pass through with identical `.trim().toLowerCase()` behavior — no change to their key contribution. Reason: don't perturb the Suppliers `source`+`invoice_ref` key.

### Test First (TDD step)

1. Add the cases below to `connectors/gas/test_code.js` **before** implementing. Use the existing `sheetCoerceOnWrite` to model how a written date round-trips to a `Date`. The file runs via `node connectors/gas/test_code.js`; a newly-added failing assertion turns the whole run RED.
2. Confirm RED for the right reason — current `rowKey_` produces different keys for a `Date` vs its `YYYY-MM-DD` string, so the equality assertion fails.
3. Implement the coercion (green), then refactor while green.

Test cases (defined at design time — these are "done"):
- **Key parity:** `rowKey_([new Date(2026, 6, 15), 'York'], SALES_KEY_COLS)` equals `rowKey_(['2026-07-15', 'York'], SALES_KEY_COLS)` — the Date-typed date col and its `YYYY-MM-DD` string yield the SAME key.
- **Dedup on re-run (the real symptom):** `appendSalesRow_(sheet, ['2026-07-15','York',100,'square','...'])` returns `true` and appends; a SECOND `appendSalesRow_(sheet, ['2026-07-15','York',100,'square','...'])` — after the first was stored and coerced to a `Date` by the mock — returns `false` and does NOT append (assert `sheet._rows.length` did not grow).
- **Non-date passthrough:** the location column's contribution is unchanged — `rowKey_` on two rows differing only in location produces different keys; casing/whitespace still normalized (`'York'` and `' york '` collide).
- **No regression:** the full existing suite still passes (`node connectors/gas/test_code.js` exit 0).

## Acceptance Criteria

```bash
node connectors/gas/test_code.js      # all tests pass, incl. the new dedup-coercion cases; exit 0
```

## Verification Procedure

1. Run the AC command above.
2. Architecture checklist:
   - `date`+`location` dedup contract now holds across a re-run (schema.md).
   - No CLAUDE.md CRITICAL rule violated; the two-tab ingest path is unchanged apart from the key coercion.
3. Update `phases/fix-silent-ingest-failures/index.json` step 2:
   - Success → `"status": "completed"`, `"summary": "rowKey_ coerces Date-typed key cols via coerceDateStr_; Sales re-run no longer double-counts; new + existing tests green."`
   - Failure after 3 retries → `"status": "error"`, `"error_message": "<specifics>"`
   - User intervention required → `"status": "blocked"`, `"blocked_reason": "<specifics>"` then stop.

## Prohibitions

- Do not use `toISOString()` or hand-rolled date math. Reason: AEST off-by-one; `coerceDateStr_` exists precisely to avoid it.
- Do not special-case column index 0. Reason: `rowKey_` is shared; coerce by type (`instanceof Date`), not by position.
- Do not change `SALES_KEY_COLS` or `SUPPLIERS_KEY_COLS`. Reason: the key COLUMNS are the contract; only their stringification was wrong.
- Do not touch `square.gs` or the Python connector here. Reason: those are steps 0 and 1.
- Do not break existing tests.
