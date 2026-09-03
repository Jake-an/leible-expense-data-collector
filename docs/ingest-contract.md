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

**Status: LIVE — but not via this doc's path.** `source='coffee_order_app'` `Revenue`
rows (`channel` = `wholesale`/`internal`/`ambiguous`/`unknown`) are written in production
today by the GAS-native `wholesalePull` (`connectors/gas/orderapp.gs`, PRD-14), which pulls
the Order app's own `?api=wholesaleSales` read endpoint on a time trigger — **not** by the
coffee order app POSTing this shape to `doPost`. The payload shape below remains the
contract for if the app itself ever POSTs wholesale revenue directly, but nothing does
that today; `wholesalePull` is the sole live producer.

**Consequence: a GAS-native caller bypasses `validateIngest_` entirely.** Every rejection
this doc attributes to ingest below — the `channel: "online"` reservation, the
`department` enum check, the numeric-`amount` check — is enforced by `doPost` →
`validateIngest_`, which only runs for an app-side POST. `wholesalePull` never calls
`doPost`; it writes through `ingestRevenueRows` directly. So none of those rejections
apply on the live path. `wholesaleRevenueRows_` (`connectors/gas/orderapp.gs`)
re-implements the equivalent gates itself — shopType→channel mapping (drops an
unrecognised `shopType` rather than defaulting it), `typeof amount === 'number' &&
isFinite(amount)`, a strict date shape, non-blank `order_ref` — precisely because
`validateIngest_` is never reached on this path.

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

**`channel: "online"` is reserved for the `shopify_orderapp` feed
(`orderapp.gs`, `shopifyWeeklyPull`, PRD-10) and is MECHANICALLY REJECTED at
ingest.** `validateIngest_` refuses any `kind: "revenue"` payload containing a
row with `channel: "online"` (case-insensitive), from any source — the
Order-app read API is the sole producer for that channel, and a POSTed online
row would flow through `weeklySummarize` into a second source-keyed Summary
row and double-count the week. This wholesale-revenue shape is unaffected:
`channel: "wholesale"` (or any non-`"online"` channel) from
`coffee_order_app` remains valid. **This wholesale-revenue writer has now
shipped** (`wholesalePull`, PRD-14, step 5 of the `roastery-wholesale` phase,
2026-09-04) — `coffee_order_app` was added to `STALENESS_SOURCES`
(staleness.gs) with a 168h override at that point; see the staleness bullet
below.

**`channel` is an open enum (aside from the `"online"` rejection above), and
the weekly rollup treats one value specially.** `channel: "online"` rows are
EXCLUDED from the weekly rollup entirely (`aggregateSupplierRows_` skips them,
counted + logged) — the sole online figure is the pull-owned
`supplier='shopify_orderapp'` Summary row written by `shopifyWeeklyPull`
(PRD-10). Every other channel is grouped per customer. Two consequences for a
new connector:

- Prefer a **consistent casing** per channel anyway. `aggregateSupplierRows_`
  now groups on the same normalized (`.trim().toLowerCase()`) key `Summary`
  dedup uses, so mixing `"Wholesale"` and `"wholesale"` in one week sums
  correctly rather than silently dropping a group — but the displayed
  `location` keeps whichever casing was seen first, which reads as
  inconsistent to a consumer.
- If you introduce a channel whose `customer` values are synthetic or unique
  per order, it will write one `Summary` row per order — talk to the schema
  first (the old online→source collapse rule was removed with PRD-10; there is
  no per-source collapse to add to anymore).

### 2. Uploaded bean / packaging invoice — SUPERSEDED, mechanically rejected

**Status: this payload shape is retired.** Stock-intake invoices for
Roastery arrive only via the Order-app `greenBeanCost` pull
(`source='greenbean'`, `orderapp.gs`, `greenBeanPull`, PRD-11) — the app
never needed to build this upload path. `validateIngest_`
(`connectors/gas/Code.gs`) now rejects any `kind:'suppliers'` (or
omitted-kind, which defaults to `'suppliers'`) payload carrying
`source: 'coffee_order_app'`, naming the greenbean exclusivity in the error
message. The shape below is preserved for history only — do not build
against it.

```jsonc
{ "kind": "suppliers", "source": "coffee_order_app", "extracted_at": "2026-08-03T09:00:00+10:00",
  "rows": [ { "date": "2026-08-01", "department": "Roastery", "supplier": "Green Bean Co",
              "total": 1840.00, "invoice_ref": "coa-8823" } ] }
```

This would have landed in the `Suppliers` tab, dedup key `source +
invoice_ref` — required per row: `date`, `total` (a JSON number, not a
numeric string), `invoice_ref`, and `supplier` (see below). `department`
followed the same rule as above. None of that applies now; the payload is
rejected before rows are validated.

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

The app should retry once after ~60s on `code: 'LOCKED'`. Note this is NOT
the Playwright `BaseConnector.post` convention — that method sends no `kind`
and does not retry at all; the shopSpend poster
(`connectors/shopspend/ingest.py`) is the one connector in this repo that
implements the LOCKED retry, and any new connector should follow its
example rather than `BaseConnector.post`. Any other `result: 'error'` (a
validation failure) should NOT be retried blindly — the payload itself is
malformed and will fail again identically.

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
- **No `SUPPLIER_NAMES` entry for `coffee_order_app`.** True, but now moot —
  the retired suppliers-kind shape (§2 above) is what would have needed it,
  and that shape is rejected before `canonicalSupplier_` is ever reached.
  Kept here only as a historical note.
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
- **Staleness watchdog: LIVE, watched.** `coffee_order_app` is now armed in
  `STALENESS_SOURCES` (`connectors/gas/staleness.gs`) with a 168h
  `STALENESS_THRESHOLD_OVERRIDES` entry — added in step 5 of the
  `roastery-wholesale` phase (2026-09-04) once `wholesalePull` gave it a real
  heartbeat to watch. The historical reasoning above (never stamped, would
  only false-alarm) no longer applies; §2's rejection is unrelated to this —
  §1 (`wholesalePull`, GAS-native) is what stamps the heartbeat, not any
  `doPost` path.

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
   (96h default; `STALENESS_THRESHOLD_OVERRIDES` in staleness.gs carries
   per-source values for slower cadences) — a daily-batch app that runs once
   nightly still lands comfortably inside the default window.

Once these are answered, write the findings into the plan (per the plan's
own Step 4.0 instruction) before any app-side or further hub-side work
proceeds.
