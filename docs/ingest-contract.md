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
(`JSON.parse(e.postData.contents)`).

**Every payload MUST carry a `token`, and the token is bound to the payload's
`source`** (security audit 2026-09-04). It goes in the JSON body as `token`,
never in the query string — GAS logs query strings.

Each source has its OWN credential, named identically on both sides:
`INGEST_TOKEN_<SOURCE>` is both the script property and the connector's `.env`
variable. `checkIngestToken_` resolves the property from `INGEST_SOURCES_` (a
code constant in `connectors/gas/Code.gs`, not configuration) and is
fail-closed at every step — unknown source, unset property, missing token,
wrong token. It runs BEFORE `validateIngest_`, so a malformed payload without
a token answers `unauthorized` rather than leaking the payload grammar.

A shared token would only be AUTHENTICATION: it proves the caller holds a
secret, not that it may claim the `source` it wrote in the body. Since
`upsertRows_` keys on `source` + `invoice_ref`, a holder could POST
`source: "square"` and overwrite Square's real rows in place, or swing the
company headline the external GM cost monitor reads every Monday 08:00.

`API_READ_TOKEN` is the **read** secret for `doGet` and buys nothing here —
there is deliberately no fallback to it.

The allowlist as of 2026-09-04:

| `source` | script property + `.env` name |
|---|---|
| `food_dairy_co` | `INGEST_TOKEN_FOOD_DAIRY_CO` |
| `fresh_and_chill` | `INGEST_TOKEN_FRESH_AND_CHILL` |
| `kent_paper` | `INGEST_TOKEN_KENT_PAPER` |
| `ordermentum` | `INGEST_TOKEN_ORDERMENTUM` |
| `shopspend` | `INGEST_TOKEN_SHOPSPEND` |
| `shopspend-backfill` | `INGEST_TOKEN_SHOPSPEND` (alias — same runner) |
| `coffee_order_app` | `INGEST_TOKEN_COFFEE_ORDER_APP` (**unset today**, so this contract's shape fails closed until Jake sets it) |

GAS-native sources (`square`, `mayers`, `greenbean`, `labour`,
`shopify_orderapp`) are absent on purpose: they write through the internal
normalizers and never touch `doPost`, so every POST claiming them is refused.

```jsonc
{ "result": "error", "code": "UNAUTHORIZED", "message": "unauthorized" }
```

`code: "UNAUTHORIZED"` stays machine-readable, but it no longer means "retry
without the gated field" — **there is no degraded mode**. It previously did:
the gate covered only payloads carrying `weeks_verified_empty`, so the
shopSpend poster could drop that field and post the rest. That scope left the
primary write path (suppliers/revenue/plain shopspend) anonymous on an
`ANYONE_ANONYMOUS` deployment whose `/exec` URL is committed to this repo, and
was closed on 2026-09-04. A missing or rejected token now means nothing can be
written, so posters fail loudly and before the first POST rather than
stranding a partial pull with no marker.

The read side, `doGet`, is token-gated the same way — see `docs/api.md`.

## Payload shapes (verbatim)

### 1. Wholesale revenue (orders the app itself takes)

**Status: BUILT, NOT YET LIVE — and when it does go live, not via this doc's path.**
⚠ As of 2026-09-04 nothing is deployed and no trigger is installed: `wholesalePull` has
never run against the live Sheet, and PRD-14 is still `planned` in `docs/PRD.md`. Step 8
of the `roastery-wholesale` phase is the supervised first run that flips this to LIVE.
Once it does, `source='coffee_order_app'` `Revenue` rows
(`channel` = `wholesale`/`internal`/`ambiguous`/`unknown`) will be written by the
GAS-native `wholesalePull` (`connectors/gas/orderapp.gs`, PRD-14), which pulls
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
`coffee_order_app` remains valid. **This wholesale-revenue writer has been
BUILT but is not yet deployed** (`wholesalePull`, PRD-14, `roastery-wholesale`
phase, 2026-09-04) — `coffee_order_app` was added to `STALENESS_SOURCES`
(staleness.gs) with a 168h override in step 5; see the staleness bullet below,
including the never-seen false-alarm this opens until step 8 runs.

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
- **`department` is BOUND TO THE SOURCE, not merely enum-checked.** Tightened
  2026-09-07. Passing the enum is not enough: the department must be the one
  that source is bound to in `INGEST_SOURCE_DEPARTMENTS_`
  (`connectors/gas/Code.gs`), the department half of the same allowlist
  `checkIngestToken_` uses to bind a token to its `source`. Today's bindings:

  | source | may claim |
  |---|---|
  | `food_dairy_co`, `fresh_and_chill`, `kent_paper`, `ordermentum` | `Cafe` |
  | `coffee_order_app` | `Roastery` |
  | `shopspend`, `shopspend-backfill` | *no department at all* |

  Omitting `department` is unaffected and still defaults to
  `DEFAULT_DEPARTMENT` (`Cafe`) in the normalizers — only an explicit claim is
  checked. A crossed claim is rejected per row, e.g. `row 0 department
  Roastery is not permitted for source food_dairy_co (bound to Cafe)`; a
  shopspend payload carrying one is rejected with `row 0 sets department, but
  source shopspend writes no department column` (the `ShopSpend` tab has no
  such column, so the value would otherwise be silently discarded).

  **Why:** a token proves which `source` a caller may claim, and said nothing
  about which department. Since `Summary` is keyed
  `week_start||department||kind||supplier||location` and `doGet`'s
  `&department` filter is what `LEIBLE_GM_COST_MONITOR` reads, one compromised
  or buggy connector could otherwise move cost between the two P&Ls.

  These bindings are today's real routes, not a permanent judgement — if
  `kent_paper` packaging or an `ordermentum` line ever becomes genuine
  Roastery spend, that is a one-line edit to the map plus a deploy. Adding a
  connector to `INGEST_SOURCES_` without a department entry fails the test
  suite by design (a gate missing an entry is blind, not red).

  **GAS-native sources are absent from the map on purpose**, exactly as in
  `INGEST_SOURCES_`: `square`/`mayers`/`greenbean`/`labour`/`shopify_orderapp`/
  `recurring` never reach `doPost`, so `checkIngestToken_` refuses any POST
  claiming them before `validateIngest_` runs. A source with no entry is
  *unbound* — the `DEPARTMENTS` enum check stands alone for it — which is only
  reachable by calling `validateIngest_` in-process, as the unit tests do.
- **`amount` / `total` must be a real, finite JSON number, and `|value|` must
  be `<= 1,000,000`.** Tightened 2026-09-04 (security audit). `validateIngest_`
  now tests `typeof v === 'number' && isFinite(v)` and the magnitude bound —
  the old `!isNaN(Number(v))` accepted `Infinity` (`isNaN(Infinity)` is
  false), `""` and `[]` (both coerce to `0`), `true`, and any magnitude, so
  ONE payload could swing the company headline the GM cost monitor reads
  every Monday 08:00. **Numeric strings such as `"340.00"` are now REJECTED**
  — the leniency this bullet used to describe is gone; send a genuine JSON
  number. Negatives ARE accepted: credit notes and refunds are real rows. The
  ceiling is `MAX_INGEST_AMOUNT_` in `connectors/gas/Code.gs`, mirrored as
  `BaseConnector.MAX_TOTAL` in `connectors/playwright/base_connector.py` —
  raise them together or not at all.
- **Contract tests exist** in `connectors/gas/test_code.js`
  (`testCoffeeOrderAppContract`) covering both payload shapes end-to-end
  through `doPost`, plus the three rejection cases named by the plan:
  missing `order_ref`, an invalid `department`, and a non-numeric `amount`
  string.
- **Staleness watchdog: ARMED IN CODE, not yet earning its keep.** `coffee_order_app` is armed in
  `STALENESS_SOURCES` (`connectors/gas/staleness.gs`) with a 168h
  `STALENESS_THRESHOLD_OVERRIDES` entry — added in step 5 of the
  `roastery-wholesale` phase (2026-09-04) ahead of the writer actually running.
  §2's rejection is unrelated to this — §1 (`wholesalePull`, GAS-native) is what
  stamps the heartbeat, not any `doPost` path.

  ⚠ **The historical false-alarm reasoning has NOT stopped applying yet — it is
  live again for the duration of the gap.** `stalenessEntries_` short-circuits on
  a never-seen source (`staleness.gs:259`: `if (seen === null) { ... stale: true }`)
  **before** any threshold is consulted, so the 168h override gives a source with
  no heartbeat zero protection. From the moment this code is deployed until step 8's
  wet run stamps the first heartbeat, `checkIngestStaleness` alerts
  `coffee_order_app` as "never seen since the watchdog was installed" on every run.
  Deploy (step 7) and bring-up (step 8) should happen in the same sitting.

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
