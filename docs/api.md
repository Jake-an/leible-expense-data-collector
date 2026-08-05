# Read API — Weekly Summary Endpoint

The GAS web app exposes a `doGet` read endpoint on the same deployment as the `doPost` ingest endpoint. It serves pre-aggregated weekly summaries (supplier + location + total spend) from the `Summary` tab.

## Authentication

Every request must include a `token` parameter matching the `API_READ_TOKEN` stored in Script Properties. Missing or wrong token → `{"result":"error","message":"unauthorized"}`.

The token never appears in the repo. Set it once in the Apps Script editor:
**Project Settings → Script Properties → `API_READ_TOKEN` = (your secret)**.

## Endpoint

```
GET https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec?token=<TOKEN>
```

The deployment ID is the same one used for `doPost` (tracked in `config/deployment.json`).

## Parameters

| Param | Required | Default | Description |
|---|---|---|---|
| `token` | yes | — | API read token (must match `API_READ_TOKEN` Script Property) |
| `fn` | no | `summary` | Which endpoint to serve: `summary` (default, the Summary payload below) or `shopspendCoverage` (the shopSpend coverage payload below). Omitting `fn` is unchanged legacy behaviour — existing callers are unaffected. Any other value is an error, never a fallback to `summary`. |
| `from` | no | Last completed Mon | `fn=summary` only. Start date filter (inclusive, `YYYY-MM-DD`). Compared against `week_start`. |
| `to` | no | Last completed Sun | `fn=summary` only. End date filter (inclusive, `YYYY-MM-DD`). Compared against `week_start`. |
| `department` | no | all departments | `fn=summary` only. Filter to `Cafe` or `Roastery`. Omit for every department. |

When `from` and `to` are both omitted, the API defaults to the **last completed Mon–Sun week** (e.g. calling on Monday 2026-06-22 returns the week of June 15–21).

## Response

```json
{
  "result": "ok",
  "week_start": "2026-06-15",
  "week_end": "2026-06-21",
  "count": 8,
  "rows": [
    {
      "week_start": "2026-06-15",
      "week_end": "2026-06-21",
      "supplier": "Butterboy",
      "location": "York St",
      "total": 240.50,
      "total_spend": 240.50,
      "summarized_at": "2026-06-22T04:00:12+10:00",
      "department": "Cafe",
      "kind": "spend"
    }
  ]
}
```

`total_spend` is kept as an alias of `total` for one release so existing
consumers don't break — read `total` going forward. On a `kind:"revenue"` row
`location` holds the channel (`online`, `wholesale`, …) and the `supplier`
field's meaning depends on it (dual meaning, kept so the JSON shape doesn't
fork per kind):

- `location: "online"` → `supplier` is the **source** (`shopify`, …), so online
  revenue is **one row per source per week**. Online customers are not exposed:
  guest checkouts are named `#<order_number>`, unique per order, which would put
  one Summary row per order into the API. Per-order online detail lives on the
  `Revenue` tab in the Sheet, not on this endpoint.
- any other channel → `supplier` is the **customer** name, one row per customer
  per week. Wholesale accounts are real named customers and keep their own line.

Revenue and spend rows are never netted against each other — sum them
separately per `kind` if you need a combined figure.

> **Channel casing must be consistent.** `location` stores the raw channel
> string, but Summary dedup lowercases it. If two rows in the same week carry
> `"Online"` and `"online"`, they collapse to a single Summary row and the
> later group is dropped as a duplicate — that week under-reports. Emit one
> canonical casing per channel.

### Error responses

```json
{ "result": "error", "message": "unauthorized" }
{ "result": "error", "message": "Summary tab not found. Run weeklySummarize() first." }
{ "result": "error", "message": "unknown fn: nope" }
```

## `fn=shopspendCoverage` — shopSpend coverage

Reports which ISO weeks the `ShopSpendPulls` tab already covers, so a caller
(the Python `--backfill` runner, step 9) can request only the weeks it's
missing instead of over-fetching. Read-only, outside the two-tab ingest
contract (see `docs/schema.md` "shopSpend tabs"). Delegates span expansion to
`shopSpendCoveredWeeks_` in `connectors/gas/shopspend.gs` — the same function
the shopSpend watchdog (step 7) uses, so the two can never disagree about
which weeks count as covered.

```
GET https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec?token=<TOKEN>&fn=shopspendCoverage
```

```json
{
  "result": "ok",
  "count": 3,
  "weeks": ["2026-W29", "2026-W30", "2026-W31"]
}
```

`weeks` is sorted ascending and de-duplicated, with each `ShopSpendPulls` row's
`from_week..to_week` span expanded to every week it covers. A missing or empty
`ShopSpendPulls` tab returns `{"result":"ok","count":0,"weeks":[]}` — cold
start is a normal state here, not an error.

## `doPost` shopspend ingest — tombstone response fields

A `kind: 'shopspend'` `doPost` request tombstones a shop-week only for ISO
weeks the payload declares complete via `weeks_complete` (see
`docs/schema.md` "shopSpend tabs"). Every response to a `kind: 'shopspend'`
request carries two extra fields (omitted entirely on `suppliers`/`revenue`
responses):

| Field | Type | Description |
|---|---|---|
| `tombstonesWritten` | number | Count of tombstone rows actually written this pull |
| `tombstonesSkipped` | array | One entry per week the blast-radius breaker suppressed, `[]` when nothing was skipped (never omitted) |

Each `tombstonesSkipped` entry has the shape:

```json
{ "week": "2026-W31", "wouldHaveWritten": 51, "present": 100 }
```

**Blast-radius breaker.** A declared-complete week is skipped rather than
tombstoned when it would tombstone **more than half** of that week's
currently-`present` shop-weeks **and** that week has **at least 5** present
shop-weeks (below the floor, a small ordinary closure — e.g. 2 of 3 shops —
always writes). A week named in `weeks_verified_empty` is exempt from the
breaker (see `docs/schema.md`).

**What backs that exemption — read this before trusting it.** The connector
does *not* positively confirm a week is empty upstream. It derives
`weeks_verified_empty` as `spanned weeks − weeks that returned rows`, and only
after the whole fetch clears the completeness gate (paging present, not
truncated, every matched row returned, `matched > 0`, orders actually scanned,
no invalid-label empty range). So the assertion is "this fetch was trustworthy
as a whole, and within it this week returned nothing" — not a per-week probe.
A fetch that is complete-looking but wrong upstream would still exempt the
week. That is the residual risk the ≥5 floor and the sticky skip exist to
bound; treat `weeks_verified_empty` as strong evidence, not proof.

**The skip is sticky and does not self-heal.** It recomputes from the same
sheet state on every pull, so an unresolved mass-absence stays suppressed
pull after pull — unlike a wrong tombstone, which self-corrects the moment
the shop-week reappears in a good pull. That asymmetry is deliberate: a
suppressed tombstone must stay suppressed **until a human confirms it**.

**Confirming a genuine mass absence.** If `tombstonesSkipped` reports a week
that really did lose more than half its shops (e.g. a supplier closure, an
upstream outage that only partially recovered), do not try to force it
through the breaker. Instead, in the Apps Script editor, call
`ingestShopSpendRows` directly (or write the rows via the Sheet UI) with a
one-off payload naming exactly the affected shop-weeks and
`weeks_verified_empty` including the affected week — this is the same
exemption path a genuinely empty week uses, applied by Jake's deliberate
confirmation rather than the client's word alone. Do not edit `ShopSpend`
rows in place; every tombstone, confirmed or not, is a new appended row (see
`docs/schema.md`'s append-only rule).

## Summary tab schema

| Column | Type | Description |
|---|---|---|
| `week_start` | date (YYYY-MM-DD) | Monday of the summary week |
| `week_end` | date (YYYY-MM-DD) | Sunday of the summary week |
| `supplier` | string | Canonical supplier name (`kind:'spend'`); on `kind:'revenue'` the source when `location` is `online`, else the customer name |
| `location` | string | Delivery site (`kind:'spend'`) or channel (`kind:'revenue'`) |
| `total` | number | Sum of invoice totals or order amounts (AUD) for that group+week |
| `summarized_at` | datetime (ISO 8601) | When the summary was last written or updated |
| `department` | string | `Cafe` or `Roastery` |
| `kind` | string | `spend` (from `Suppliers`) or `revenue` (from `Revenue`) |

## Weekly trigger

`weeklySummarize()` runs every Monday at 4am AEST (install via `installWeeklySummarizeTrigger()` in the editor). Each run:

1. Aggregates raw `Suppliers` rows (`kind:'spend'`) and `Revenue` rows (`kind:'revenue'`) for the last completed Mon–Sun into `Summary`
2. **Upsert**, keyed on `week_start||department||kind||supplier||location`: a new key appends; an existing key with an unchanged total is skipped; an existing key whose underlying total has since changed (e.g. an amended wholesale order) is **updated in place** — this is what makes correcting a row after its week was already summarized actually reach the weekly figure
3. Archives raw `Suppliers` rows older than 6 months to `_archive` tab
4. Purges the archived rows from `Suppliers`
5. Pulls Labour cost for the same week (see `docs/ADR.md` ADR-007) — always `department:'Cafe'`, `kind:'spend'`, routed through the same upsert key

## Calling from another GAS project

```javascript
function fetchWeeklySummary() {
  var url = 'https://script.google.com/macros/s/DEPLOYMENT_ID/exec';
  var token = PropertiesService.getScriptProperties().getProperty('EXPENSE_HUB_TOKEN');

  var response = UrlFetchApp.fetch(url + '?token=' + token, { muteHttpExceptions: true });
  var data = JSON.parse(response.getContentText());

  if (data.result !== 'ok') throw new Error('Expense hub: ' + data.message);
  return data.rows;
}
```
