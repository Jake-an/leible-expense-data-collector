# Step 2: dopost-shopspend-kind

## Files to Read

- `docs/schema.md` — the shopSpend tab specs (step 0) and the two-tab ingest contract.
- `docs/ingest-contract.md` — the `doPost` request/response contract. **Note lines 85-87 are
  currently WRONG** (they claim `BaseConnector.post` retries on `LOCKED`; it does not). Do not fix
  that here — it is corrected in step 5.
- `connectors/gas/Code.gs` — read `doPost` (**122-161**), especially the routing closure
  (**130-138**) and the `LOCKED` branch (**143-145**); `validateIngest_` (**174-210**), especially
  the kind whitelist (**180-183**) and the unconditional `if (!r.date)` at **188**;
  `appendNewRows_` (**426-428**); `ensureSheet` (**573-583**).
- `connectors/gas/shopspend.gs` — `ensureShopSpendTabs_` from step 1.
- `connectors/gas/test_code.js` — existing `doPost` / `validateIngest_` test patterns.

## Background

`doPost` routes **purely on `kind`** (`Code.gs:128`, defaulting to `'suppliers'`); `source` is only
a data column, a dedup namespace, and the heartbeat key. Two facts constrain this step:

1. **`validateIngest_:188` requires `r.date` on EVERY row, for EVERY kind** — it sits above the
   per-kind branch. That line is on the shared path used by all six existing connectors, so
   relaxing it globally is a regression surface. A shopSpend row is keyed `(shop_id, week_label)`
   and has no natural `date`, so **the client sends a synthetic `date` = that week's Monday
   (`week_start`)**. No shared-path change.

2. The response shape `{result, rowsAdded, rowsUpdated, duplicatesSkipped}` (`Code.gs:152-157`) is
   the contract the Python poster reads. The shopspend branch must return that same shape.

This step wires validation + routing with a **straightforward append**. Change detection,
tombstones and the block write land in step 3.

## Task

**1. `validateIngest_` (`connectors/gas/Code.gs`).**

- Widen the kind whitelist at **181** to admit `'shopspend'`.
- Add a `kind === 'shopspend'` branch to the per-row loop (**185-208**) requiring:
  `shop_id` (non-empty), `week_label` matching `/^\d{4}-W\d{2}$/`, `week_start` and `week_end`
  present, and `total_ex_gst` / `gst` / `total_inc_gst` / `order_count` / `amended_count` all
  numeric (`isNaN(Number(x))` → reject, same idiom as `revenue`'s `amount` check at **196**).
- Leave line **188** (`if (!r.date)`) exactly as it is.

**2. `doPost` (`connectors/gas/Code.gs`).** Add a `kind === 'shopspend'` route inside the lock
closure, **before** the revenue branch at **132**:

```js
if (kind === 'shopspend') {
  var tabs = ensureShopSpendTabs_(ss);
  return ingestShopSpendRows(body.source, body.rows, body.extracted_at, tabs.data, body.pull);
}
```

`body.pull` is the optional diagnostics object; when present, one row is written to the
`ShopSpendPulls` tab. It is written **last**, after the data rows, because it is the commit marker
that makes a partially-written chunked pull detectable.

**3. `ingestShopSpendRows(source, rows, extractedAt, sheet, pull)` in `connectors/gas/shopspend.gs`.**
For this step: map each row onto the `SHOPSPEND_HEADERS` column order (`presence` defaults to
`'present'`, `source` from the payload, `fetched_at` from the row or `extractedAt`) and append.
Return `{rowsAdded: <n>, rowsUpdated: 0, duplicatesSkipped: 0}`.

Core rules that must not deviate:
- Return the existing three-field shape. Reason: `doPost:152-157` and the Python poster both
  depend on it.
- Never route shopSpend through `upsertRows_`. Reason: it mutates the prior row in place and
  collapses same-key rows within a batch — the exact opposite of append-only snapshots.
- Never use `toISOString()`. Reason: AEST midnight shifts to the previous UTC day. Use
  `Utilities.formatDate(d, 'Australia/Sydney', 'yyyy-MM-dd')` or the existing `coerceDateStr_`.

### Test First (TDD step)

Add the cases below to `connectors/gas/test_code.js` before implementing; confirm RED for the right
reason (unknown kind rejected / `ingestShopSpendRows` undefined), then implement to green.

Test cases (definition of done):
- **Kind accepted:** a well-formed `kind:'shopspend'` payload returns `result:'ok'` and
  `rowsAdded` equal to the row count; the rows land on the `ShopSpend` tab in header order.
- **Unknown kind still rejected:** `kind:'nonsense'` returns `result:'error'` with
  `unknown kind: nonsense` — the whitelist widened, it did not open.
- **Per-row validation rejects, with the row index in the message:** missing `shop_id`; a
  `week_label` of `'2026-W7'` and of `'26-W07'` (both malformed); a non-numeric `total_ex_gst`;
  a missing `week_start`.
- **`date` is still required on every kind:** a shopspend row without `date` is REJECTED — proving
  line 188 was not relaxed. (The client satisfies it by sending `date = week_start`.)
- **Existing kinds unregressed:** a `suppliers` payload missing `invoice_ref` still fails; a
  `revenue` payload missing `order_ref` still fails; a valid payload of each still succeeds and
  writes to its own tab.
- **Heartbeat:** a successful shopspend post stamps the `shopspend` heartbeat via the existing
  generic call at `Code.gs:150`.
- **Pulls row:** when `body.pull` is present, exactly one row is appended to `ShopSpendPulls`, in
  `SHOPSPEND_PULLS_HEADERS` order, and it is written after the data rows.
- **No regression:** the full existing suite passes.

## Acceptance Criteria

```bash
node connectors/gas/test_code.js      # all tests pass incl. the new cases; exit 0
```

## Verification Procedure

1. Run the AC command.
2. Architecture checklist:
   - All ingest still flows through `doPost` → `validateIngest_` (CLAUDE.md CRITICAL rule).
   - `Suppliers` / `Sales` / `Revenue` / `Summary` behaviour byte-identical.
   - The shopspend branch sits inside `withScriptLock_`, like every other ingest.
3. Update `phases/shopspend/index.json` step 2 (`completed` + `summary`, or `error` +
   `error_message`, or `blocked` + `blocked_reason` then stop).

## Prohibitions

- Do not modify or relax `Code.gs:188` (`if (!r.date)`). Reason: shared by all six existing
  connectors; the synthetic `date` on the client side is the agreed fix.
- Do not implement change detection, tombstones, or the block write. Reason: step 3.
- Do not touch `docs/ingest-contract.md:85-87` or the stale comment at `Code.gs:142`. Reason:
  step 5 owns that correction, together with the retry that makes it true.
- Do not change the `{result, rowsAdded, rowsUpdated, duplicatesSkipped}` response shape.
  Reason: it is the wire contract for every connector.
- Do not add `'shopspend'` to `STALENESS_SOURCES`. Reason: the 96h threshold is global and a
  weekly source would alert ~3 days in 7 — step 7 handles this deliberately.
