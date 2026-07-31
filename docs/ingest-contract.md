# Coffee Order App — Ingest Contract

This is the contract the coffee order app (separate repo, not this one) must
satisfy to POST into the hub. It reuses the existing `doPost` endpoint and
`validateIngest_` rules documented in `docs/schema.md` / `docs/api.md` —
**no hub-side code changes were needed to support this source**; this doc
formalizes the shapes so the app side can be built against something concrete.

**Status:** hub-side contract only. Step 4.0 (does the app actually have this
data, can it emit it, can it POST) is a separate, blocked, Jake-only
inspection step — see the checklist at the end of this doc. Nothing here
implies the app can meet this contract yet.

## Endpoint

`POST` to the hub's `/exec` URL (`config/deployment.json`), `Content-Type`
irrelevant — the body is parsed as JSON regardless
(`JSON.parse(e.postData.contents)`). No auth token on write (matches every
other connector; the read side, `doGet`, is the one that's token-gated — see
`docs/api.md`).

## Payload shapes (verbatim)

### 1. Wholesale revenue (orders the app itself takes)

```jsonc
{ "kind": "revenue", "source": "coffee_order_app", "extracted_at": "2026-08-03T09:00:00+10:00",
  "rows": [ { "date": "2026-08-03", "department": "Roastery", "channel": "wholesale",
              "customer": "Cafe X", "amount": 340.00, "order_ref": "ORD-1182" } ] }
```

Lands in the `Revenue` tab (`docs/schema.md`), dedup key `source + order_ref`.
Required per row: `date`, `channel`, `customer`, `amount` (a JSON number, not
a numeric string), `order_ref`. `department` is optional — omitted defaults
to `DEFAULT_DEPARTMENT` (`Cafe`); if present it must be exactly `Cafe` or
`Roastery`.

**`channel` is an open enum, and the weekly rollup treats one value specially.**
`validateIngest_` only requires `channel` to be non-empty. In the weekly
`Summary`, `channel: "online"` is collapsed to one row per source (guest
checkouts carry synthetic per-order customer names); every other channel is
grouped per customer. Two consequences for a new connector:

- Use a **consistent casing** per channel. `Summary` dedup lowercases the
  channel, so mixing `"Online"` and `"online"` in one week silently drops one
  group's revenue from that week's figure.
- If you introduce a channel whose `customer` values are synthetic or unique
  per order, add it to the collapse rule in `aggregateSupplierRows_`
  (`connectors/gas/Code.gs`) — otherwise it writes one `Summary` row per order.

### 2. Uploaded bean / packaging invoice

```jsonc
{ "kind": "suppliers", "source": "coffee_order_app", "extracted_at": "2026-08-03T09:00:00+10:00",
  "rows": [ { "date": "2026-08-01", "department": "Roastery", "supplier": "Green Bean Co",
              "total": 1840.00, "invoice_ref": "coa-8823" } ] }
```

Lands in the `Suppliers` tab, dedup key `source + invoice_ref`. Required per
row: `date`, `total` (a JSON number, not a numeric string), `invoice_ref`,
and `supplier` (see below). `department` follows the same rule as above.

## Response shapes

Success:

```json
{ "result": "ok", "rowsAdded": 1, "rowsUpdated": 0, "duplicatesSkipped": 0 }
```

Validation failure (payload rejected, nothing written):

```json
{ "result": "error", "message": "row 0 missing order_ref" }
```

Lock contention (another ingest or `weeklySummarize` held the script lock
past its 30s timeout) — **retryable**, nothing written, heartbeat NOT
stamped:

```json
{ "result": "error", "code": "LOCKED", "retryable": true }
```

The app should retry once after ~60s on `code: 'LOCKED'`, matching the
Playwright `BaseConnector.post` convention already used by every other
connector. Any other `result: 'error'` (a validation failure) should NOT be
retried blindly — the payload itself is malformed and will fail again
identically.

## Field rules

- **`invoice_ref` is the app's own upload ID — never an OCR'd invoice
  number.** The app is not expected to read or parse the uploaded invoice
  file at all; it just needs a stable identifier for whatever record it
  creates when a file is uploaded (e.g. a row id, a Firestore doc id, a
  Postgres serial). **Known accepted gap:** if the same physical invoice
  gets uploaded twice, that produces two different upload IDs and therefore
  two separate `Suppliers` rows — dedup on `source + invoice_ref` cannot
  catch this, because from the hub's point of view they are two distinct,
  legitimately-different keys. This is a human dedup problem the app should
  guard against at upload time (e.g. warn on a same-day/same-vendor
  re-upload); the hub does not and will not attempt to detect it.
- **No `SUPPLIER_NAMES` entry for `coffee_order_app`.** Every other
  file-based/portal connector (Food and Dairy Co, Fresh and Chill, Kent
  Paper, Mayers) maps a fixed `source` string to one canonical supplier name
  via the `SUPPLIER_NAMES` table in `connectors/gas/Code.gs`. That doesn't
  fit here — the app's upload form lets the user name any bean/packaging
  supplier per invoice. So, exactly like Ordermentum (which serves multiple
  suppliers — Tuga, Butterboy — under one `source`), `coffee_order_app` rows
  **must carry their own `supplier` field**; `canonicalSupplier_`
  (`connectors/gas/Code.gs:216`) always prefers `row.supplier` over the
  `SUPPLIER_NAMES` map when present, so this falls out of existing logic with
  no code change.
- **`department` must be `'Cafe'` or `'Roastery'`, or omitted.** Anything
  else (a typo, a third department the app's UI hasn't been told to
  constrain to `DEPARTMENTS`) is rejected by `validateIngest_` with a
  message naming the offending row index, e.g. `row 0 invalid department:
  Kitchen`. Since this is Roastery-sourced data, the app will realistically
  always send `department: 'Roastery'` explicitly rather than rely on the
  `Cafe` default — but the default exists and is honored if it's omitted.
- **`amount` / `total` must be a JSON number, not a numeric string.** A
  string like `"340.00"` currently still parses via `Number(...)` and would
  NOT be rejected (see `validateIngest_` in `connectors/gas/Code.gs`) — but a
  non-numeric string (e.g. a form field the app failed to parse, landing as
  `"340.00abc"` or similar) IS rejected. The app should still send a genuine
  JSON number type, not rely on this leniency.
- **Contract tests exist** in `connectors/gas/test_code.js`
  (`testCoffeeOrderAppContract`) covering both payload shapes end-to-end
  through `doPost`, plus the three rejection cases named by the plan:
  missing `order_ref`, an invalid `department`, and a non-numeric `amount`
  string.
- **Staleness watchdog:** `coffee_order_app` is included in
  `STALENESS_SOURCES` (`connectors/gas/staleness.gs`), so if the app stops
  POSTing for >96h an orange all-day alert fires, same as every other
  source.

## Rollback

The app simply stops POSTing. Nothing in the hub breaks — `coffee_order_app`
just ages past the staleness threshold and raises one alert; no schema,
trigger, or other connector depends on it existing.

## Step 4.0 — open questions Jake must answer before the app-side work starts

This doc describes what the hub will accept. It does **not** establish that
the coffee order app can actually produce this data yet. That's a separate,
blocked inspection step — open the app and work through this checklist in
one sitting:

1. **Where does order data live?** (Sheet / Firestore / Postgres / other) —
   this determines whether "add an outbound POST" is a small change or a
   new integration surface.
2. **Does each order have a stable, unique id already?** If yes, that id is
   the natural `order_ref` for the revenue payload. If not, what would make
   a good one (do you need to add an id column/field)?
3. **Do uploaded invoices carry any structured data today** (date, vendor
   name, amount), or is an upload just a file with no extracted fields?
   This decides which of the two payload shapes (or both) the app can
   satisfy right now.
4. **If invoices are file-only (no structured fields captured at upload):**
   pick one of two branches —
   - **(a)** Add fields to the app's own upload form (vendor, amount, date)
     so the app emits structured `kind:'suppliers'` rows itself — permanent
     fix, lives in the app's repo.
   - **(b)** OCR the uploaded file in GAS, following the `mayers.gs` pattern
     (Gmail/Drive OCR → parsed rows) — more work, lives in this repo, and
     only makes sense if the app truly cannot capture structured fields at
     upload time.
   This decision determines the shape of a later phase's work; do not start
   building either branch before deciding.
5. **Can the app make an outbound HTTP POST at all?** Some app platforms
   (e.g. certain no-code/low-code builders, some mobile-only fully-hosted
   SaaS) restrict or entirely block outbound webhooks. If it can't POST
   directly, is there a scheduled export (CSV to Drive, email digest) the
   hub could instead pull/parse on a timer — a materially different
   integration than "the app POSTs directly to `doPost`"?
6. **What triggers a POST?** Per-order in near-real-time, or a batch/daily
   sync? This affects whether `extracted_at` should be "now" per row or a
   shared batch timestamp, and interacts with the staleness threshold
   (currently 96h) — a daily-batch app that runs once nightly still needs to
   land comfortably inside that window.

Once these are answered, write the findings into the plan (per the plan's
own Step 4.0 instruction) before any app-side or further hub-side work
proceeds.
