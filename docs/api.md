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
| `from` | no | Last completed Mon | Start date filter (inclusive, `YYYY-MM-DD`). Compared against `week_start`. |
| `to` | no | Last completed Sun | End date filter (inclusive, `YYYY-MM-DD`). Compared against `week_start`. |
| `department` | no | all departments | Filter to `Cafe` or `Roastery`. Omit for every department. |

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
the `supplier` field holds the **customer** name (dual meaning, kept so the
JSON shape doesn't fork per kind) and `location` holds the channel
(`wholesale`, `shopify`, …). Revenue and spend rows are never netted against
each other — sum them separately per `kind` if you need a combined figure.

### Error responses

```json
{ "result": "error", "message": "unauthorized" }
{ "result": "error", "message": "Summary tab not found. Run weeklySummarize() first." }
```

## Summary tab schema

| Column | Type | Description |
|---|---|---|
| `week_start` | date (YYYY-MM-DD) | Monday of the summary week |
| `week_end` | date (YYYY-MM-DD) | Sunday of the summary week |
| `supplier` | string | Canonical supplier name (`kind:'spend'`) or customer name (`kind:'revenue'`) |
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
