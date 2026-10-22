# Cropster Production Report — data contract (step 0 probe, 2026-10-22)

Probed read-only in Chrome on the signed-in session (`yama@leiblecoffee.com.au`, account group `LEICOF`). This file holds **field names and behaviour only**. The anchor figures live in the untracked `downloads/cropster-probe/anchor.json` (gitignored). No cookies or header values are recorded anywhere.

## Page
- `https://c-sar.cropster.com/apps/roast/production-report?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD`
  - The URL query params set the range directly, inclusive and in Sydney local dates; no date-picker clicking is needed.
  - The optional `averageTimespan=DAY|MONTH` only changes the P/x columns and doesn't affect the stored fields.
- The app is Ember, with an Ember Data JSON:API adapter.

## Endpoint
`GET https://c-sar.cropster.com/api/v2/productionSummaries` takes these query params, URL-encoded with brackets:
- `filter[productionSummaries][group]=LEICOF`
- `filter[productionSummaries][weightUnit]=KG`
- `filter[productionSummaries][dateFrom]=<epoch ms>`: Monday 00:00:00.000 **Australia/Sydney** (e.g. 13 Oct 2026 AEDT → `1791810000000`).
- `filter[productionSummaries][dateTo]=<epoch ms>`: the following Sunday 23:59:59.999 Sydney.
- `group[productionSummaries]=PROFILE | MACHINE | WORKER`

**Auth:**
- Needs the session cookies **plus** the request headers the app's adapter adds: `Content-Type`, `Cropster-Authenticate`, `Client-Version` (value like `cropster-core_<ver>`).
- A fetch with cookies only → **403** `access_denied`.
- The connector takes these headers from the page's **own** first `productionSummaries` request (Playwright `request.headers()`), holds them in memory only, and never logs them.

**Initial page load** fires only `group=PROFILE`. MACHINE and WORKER fire later, depending on the UI. The connector therefore requests MACHINE explicitly, as described under Reconciliation.

## Response (JSON:API)
`{ data: [ { id, type:"productionSummaries", attributes:{...}, links:{self} } ] }`
- One element per profile (or per machine/worker for the other groupings).
- **No `meta`/`links` paging**: all groups come back in one response. 12 profiles arrived in a single response.

`attributes`:
| field | type | use |
|---|---|---|
| `profile` | string (profile id, e.g. `D8w7v`) | key → resolve name |
| `startWeight` | `{amount, unit:"KG", amountSI}` | **green_kg_in** = `amount` |
| `endWeight` | `{amount, unit:"KG", amountSI}` | **roasted_kg_out** = `amount` |
| `batchCount` | number | **batch_count** |
| `failedBatchWeight`, `failRate` | object or null | null on every probed row; record only, not stored |
| `previousStartWeight` / `previousEndWeight` | Weight | previous-period comparison; ignore |
| `dateFrom`, `dateTo`, `machine`, `worker`, `lot`, `profileGroup`, `totalPrice`, `qualityRate` | null in PROFILE grouping | ignore (**the range is NOT echoed in the body**) |

- With `weightUnit=KG`, `unit` is always `"KG"` and `amount === amountSI`. Any other unit → raise.
- **Weight loss:**
  - There is no weight-loss field. The UI's "Weight loss" column equals `round(100 × (1 − endWeight/startWeight))`; the probe matched 15% on the sample profile.
  - Stored `weight_loss_pct = round(100 × (1 − end/start), 2)`, which is Cropster's own figure from Cropster's own weights. `null` when `start == 0`.
- **Incomplete/failed batches:** Cropster reports them separately via `failedBatchWeight`/`failRate`, and all were null in the probe. `batchCount` and the weights are taken as Cropster reports them; no exclusion is applied hub-side.

## Profile names
`GET /api/v2/profiles/<id1>,<id2>,…` (comma list, URL-encoded) needs the same headers and returns `data[].{id, attributes.name, …}`. Use `attributes.name` and keep `id` in the connector log for rename diagnosis.

## Reconciliation (replaces "echoed range + summary card" from the plan)
- **Range guard:** the response's request URL `dateFrom`/`dateTo` params must equal the epochs requested for that week.
- **Cross-grouping check:** fetch `group=MACHINE` for the same range. Require Σ PROFILE `endWeight` = Σ MACHINE `endWeight` (±0.1 kg) **and** Σ PROFILE `batchCount` = Σ MACHINE `batchCount`. The probe matched exactly.
- **Profile names:** every profile id must resolve to a name. An unresolved id → raise.
- Any mismatch → raise, and post nothing for the whole run.

## Anchor check (16–22 Oct 2026; values in `downloads/cropster-probe/anchor.json`)
- PROFILE Σ roasted, Σ batches and Σ green all match the Production Report summary card: **PASS**.
- MACHINE Σ equals PROFILE Σ: **PASS**.
- Sample profile roasted, batches and UI loss %: **PASS**.
