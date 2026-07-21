# Step 1: square-api-failure

## Files to Read

First, read these to understand the design intent before touching code:

- `/docs/schema.md` — the `Sales` tab contract (`date`, `location`, `gross_sales`, `source`, `extracted_at`) and the `date`+`location` dedup key.
- `connectors/gas/square.gs` — the file you will modify. Read the `squareDailyPull` site loop (~lines 45-99), `squareCallApi_` (~140-163, returns `null` on any non-2xx / exception), `squareSearchOrders_` (~165-194, currently `if (!result) break;`), and `squareListLocations_` (~196-202, currently `return []` on `!result || !result.locations`).
- `connectors/gas/Code.gs` — `appendSalesRow_` (~155-161), `stalenessStampHeartbeat_` (search for the function), and `coerceDateStr_`.
- `connectors/gas/test_code.js` — the Node-mock harness you will extend. Read `testStalenessSquareHeartbeatException` (~line 1091, already covers the **no-token** → no-heartbeat path) and the mock setup (`scriptProps`, `makeSheet`, how `squareDailyPull` is invoked).

## Background (the bug)

In `squareDailyPull`, `sitesWithToken++` (square.gs:69) counts token **presence**, not API success. On an expired token / 5xx / outage:

- `squareCallApi_` returns `null` (square.gs:156-162).
- `squareListLocations_` returns `[]` — **indistinguishable from a site that genuinely has no locations** (square.gs:198).
- → `orders` `[]` → `squareSumOrderGross_` → `gross = 0` → a **`$0` sales row is written** (square.gs:78-79), AND
- because a token was present, `stalenessStampHeartbeat_('square')` fires (square.gs:89-90).

So an outage writes `$0` (indistinguishable from a genuinely closed day) **and** stamps the freshness heartbeat, so the staleness watchdog — built specifically to catch silent-ingest failure — stays silent through exactly that failure.

## Task — null-sentinel (the approved approach)

Make an API failure **distinguishable from a genuine empty result**, using the `null` sentinel that `squareCallApi_` already returns (do NOT introduce exceptions).

1. **`squareListLocations_`** — split the collapsed `[]`:
   ```js
   var result = squareCallApi_('/locations', accessToken, 'GET', null);
   if (!result) return null;              // API FAILURE (call returned null)
   if (!result.locations) return [];      // genuine: no locations on the account
   return result.locations.map(...);      // unchanged
   ```

2. **`squareSearchOrders_`** — return `null` on API failure instead of silently returning partial/empty orders:
   ```js
   var result = squareCallApi_('/orders/search', accessToken, 'POST', payload);
   if (!result) return null;              // API FAILURE — do NOT trust partial pages
   // ...accumulate result.orders as before; return the array on success (possibly [])
   ```
   Reason for returning `null` (not the accumulated partial): a mid-pagination 5xx must fail the whole site pull loudly, not write a truncated gross that looks like a quiet day.

3. **`squareDailyPull` site loop** — treat `null` from either wrapper as "this site's pull FAILED": skip the `$0` row, skip counting it as a healthy site. Only stamp the heartbeat when **≥1 site fully succeeded**. NOTE: add a NEW `sitesOk` counter as the heartbeat gate — **keep the existing `sitesWithToken` counter and return key** (token-presence semantics unchanged). Reason: existing tests assert `res.sitesWithToken` (`test_code.js:1110,1120`); removing/repurposing it breaks them for the wrong reason during GREEN.
   ```js
   var sitesOk = 0;                        // NEW: heartbeat gate = sites that pulled successfully
   // (keep the existing `var sitesWithToken = 0;` and its ++ on token presence, and keep it in the return object)
   for (...) {
     var token = props.getProperty(site.prop);
     if (!token) { Logger.log(... 'no token' ...); continue; }

     var locations = squareListLocations_(token);
     if (locations === null) {             // API failure
       Logger.log('squareDailyPull: ' + site.name + ' — Square API FAILED (locations); not writing $0, not counting toward heartbeat');
       continue;
     }
     var orders = [];
     var apiFailed = false;
     for (var l = 0; l < locations.length; l++) {
       var got = squareSearchOrders_(token, locations[l].id, startIso, endIso);
       if (got === null) { apiFailed = true; break; }   // API failure on this site
       orders = orders.concat(got);
     }
     if (apiFailed) {
       Logger.log('squareDailyPull: ' + site.name + ' — Square API FAILED (orders); not writing $0, not counting toward heartbeat');
       continue;
     }

     var gross = squareSumOrderGross_(orders);          // genuine result (may be 0 on a real closed day)
     var salesRow = [dateStr, site.name, gross, 'square', extractedAt];
     if (appendSalesRow_(sheet, salesRow)) rowsWritten++; else duplicatesSkipped++;
     sitesOk++;
   }

   if (sitesOk > 0) stalenessStampHeartbeat_('square');
   else Logger.log('squareDailyPull: NO site pulled successfully — not stamping heartbeat, so staleness will alert');
   ```

Core rules that must not deviate:
- A site whose API **failed** MUST NOT write any row (not even `$0`) and MUST NOT count toward the heartbeat gate. Reason: `$0`-on-failure + heartbeat is the silent-failure being fixed.
- A site whose API **succeeded with genuinely zero orders** (real closed day) MUST still write its `$0` row and MUST count toward the heartbeat. Reason: a real closed day is legitimate data; over-correcting would suppress it and mis-fire staleness.
- The heartbeat stamps iff **≥1 site pulled successfully** — mirroring the already-correct no-token path (no healthy site → no heartbeat → staleness alerts).
- Keep the return object shape (`date`, `rowsWritten`, `duplicatesSkipped`, ...); you may add a `sitesOk`/`sitesFailed` field but do not remove existing keys.

### Test First (TDD step)

1. Extend `connectors/gas/test_code.js` with the cases below **before** implementing. Follow the existing pattern: mock `squareCallApi_` (or the site's token + the wrappers) and assert against `scriptProps` (heartbeat key `LAST_INGEST_square`) and the Sales sheet `_rows`. The whole file runs via `node connectors/gas/test_code.js` (exit 0 = pass, 1 = fail); a newly-added failing assertion turns the whole run RED even though prior tests pass.
2. Confirm RED for the right reason — the current code writes `$0` + stamps the heartbeat on failure, so the new assertions fail.
3. Implement the null-sentinel change (green), then refactor while green.

Test cases (defined at design time — these are "done"):
- **`squareListLocations_` with `squareCallApi_ → null`** returns `null` (NOT `[]`).
- **`squareListLocations_` with `squareCallApi_ → {locations: []}`** returns `[]` (genuine empty preserved).
- **`squareSearchOrders_` with `squareCallApi_ → null`** returns `null` (NOT `[]`).
- **`squareDailyPull`, single site, API fails** (mock `squareCallApi_ → null` for that site): NO Sales row appended for that site AND `LAST_INGEST_square` is NOT in `scriptProps` (heartbeat not stamped).
- **`squareDailyPull`, single site, API OK but zero orders** (locations non-empty, orders `[]`): a `$0` Sales row IS written AND `LAST_INGEST_square` IS stamped (a real closed day must record + heartbeat — no over-correction).
- **`squareDailyPull`, two sites, one fails + one succeeds**: heartbeat IS stamped (≥1 healthy), the failed site writes NO row, the healthy site writes its row.

## Acceptance Criteria

```bash
node connectors/gas/test_code.js      # all tests pass, incl. the 6 new square-failure cases; exit 0
```

## Verification Procedure

1. Run the AC command above.
2. Architecture checklist:
   - Still GAS-only; the connector boundary is untouched (ARCHITECTURE.md).
   - The `Sales` row shape is unchanged (schema.md `date`+`location` dedup contract preserved).
   - No CLAUDE.md CRITICAL rule violated.
3. Update `phases/fix-silent-ingest-failures/index.json` step 1:
   - Success → `"status": "completed"`, `"summary": "Square API failure now null-sentinel'd; no $0 row + no heartbeat on failure; real closed-day still records+heartbeats; 6 new tests green."`
   - Failure after 3 retries → `"status": "error"`, `"error_message": "<specifics>"`
   - User intervention required → `"status": "blocked"`, `"blocked_reason": "<specifics>"` then stop.

## Prohibitions

- Do not use exceptions for the failure signal. Reason: the approved approach is the `null` sentinel, matching `squareCallApi_`'s existing contract and keeping the diff minimal.
- Do not suppress the genuine closed-day `$0` row. Reason: a real day with no sales is valid data; only API *failure* skips the write.
- Do not stamp the heartbeat when zero sites succeeded. Reason: that is the false-heartbeat bug.
- Do not touch `Code.gs` `rowKey_` here — the Sales-dedup coercion is step 2. Reason: one module per step.
- Do not break existing tests (especially `testStalenessSquareHeartbeatException` and the staleness suite).
