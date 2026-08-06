# Step 4: greenbean-pull

## Requirements Covered

- `PRD-11` — Green bean committed spend via Order-app read API: fetch (offset paging), ingest into Suppliers, snapshot-diff affected-week re-summarize with persisted overflow queue

This is *why* this step exists. If the Task section below appears to contradict the
requirement above, `docs/ADR.md`, or a CRITICAL rule in CLAUDE.md, do NOT resolve the
conflict yourself — set `"status": "needs_context"` and stop.

## Files to Read

- `connectors/gas/orderapp.gs` (steps 0–3)
- `connectors/gas/Code.gs` :60 (`SUPPLIERS_KEY_COLS`), :100–139 (`SCRIPT_LOCK_DEPTH_` re-entrancy — nested `weeklySummarize` inside a locked pull is legal), :445 (`ingestSupplierRows(source, rows, extractedAt, sheet)` — returns `{rowsAdded, rowsUpdated, duplicatesSkipped}` COUNTS ONLY, no key attribution), :535 (`upsertRows_` — on key match updates ONLY amount+stamp, never the date column), :734 (`ensureSheet`), :1561 (`weekStartForDate_`), :1700 (`weeklySummarize(weekStartOverride)` — refuses incomplete weeks, skips archive/purge on override)

## Task

Add to `connectors/gas/orderapp.gs`:

```js
var GREENBEAN_RESUM_CAP = 5;
var GREENBEAN_RESUM_QUEUE_PROP = 'ORDERAPP_RESUM_QUEUE_greenbean'; // JSON array of 'yyyy-MM-dd' week starts
function greenBeanWindow_(todayStr) { /* pure → {from, to}: from = 1st of (month−2), to = todayStr; string arithmetic only */ }
function greenBeanFetchAllRows_() { /* offset paging → rows[]|null */ }
function greenBeanPull() { /* orderAppRunStart_('greenbean') BEFORE lock; withScriptLock_ */ }
function greenBeanPull_impl_() { /* → {rowsFetched, invoices, rowsAdded, rowsUpdated, duplicatesSkipped, weeksResummarized, weeksQueued, noToken?, apiFailed?} */ }
```

**Fetch** (`greenBeanFetchAllRows_`): request
`{api:'greenBeanCost', from, to, status:'ALL', include:'rows', limit:5000, offset}` in a
loop: while the response `meta.paging.truncated === true && meta.paging.rowsIncluded === true`,
refetch with `offset += meta.paging.returned`, concatenating `rows`. If
`truncated === true && rowsIncluded === false` (Order-app size guards dropped the rows
array), return null → the run ABORTS with a logged error: never ingest a knowingly
incomplete window.

**Ingest + snapshot-diff resummarize** (`greenBeanPull_impl_`):
1. `invoices = greenBeanInvoices_(rows)` (step 3).
2. **Before ingest:** snapshot the Suppliers sheet into a map
   `'greenbean' + '||' + invoice_ref → {storedDate, total}` (only `source='greenbean'`
   rows; coerce dates with `coerceDateStr_`).
3. `ingestSupplierRows('greenbean', invoices, extractedAt, ensureSheet(ss, 'Suppliers', SUPPLIERS_HEADERS))`.
4. Classify each **submitted** invoice against the snapshot:
   - key absent → new row → affected week = `weekStartForDate_(invoice.date)`
   - key present, `total` differs (compare as rounded numbers) → affected week =
     `weekStartForDate_(snapshot.storedDate)`. Reason: `upsertRows_` never rewrites the
     date column, so the row still lives in the stored date's week — summarizing by the
     newly computed date would refresh the wrong week and leave the changed week stale.
   - key present, total unchanged → NO affected week.
5. Merge: queue-from-property (drain oldest-first) + this run's affected **completed**
   weeks (dedup, exclude current week), oldest-first. Call `weeklySummarize(weekStart)`
   for up to `GREENBEAN_RESUM_CAP` of them; write the remainder back to the queue
   property. Only weeks actually summarized leave the queue.
6. `orderAppRunSuccess_('greenbean')` only on full success (fetch complete AND ingest
   done AND every attempted resummarize returned without throwing; a non-empty
   remaining queue is fine — it is persisted work, not failure).
7. Token unset → `{noToken:true}`, nothing written.

### Test First (TDD step)

Test cases (defined at design time — these are "done"):
- paging: page1 `truncated:true, rowsIncluded:true, returned:N` + page2 `truncated:false` → rows concatenated, offsets `0, N`
- size-guard abort: `truncated:true, rowsIncluded:false` → returns null, nothing written, counter NOT reset, no heartbeat
- changed invoice total → Suppliers row updated in place AND `weeklySummarize` invoked for exactly the **snapshot stored date's** week (fixture: invoice gains a line dated in an EARLIER week than the stored row date → the stored week is resummarized, not the recomputed min-date week)
- unchanged invoice on re-pull → contributes NO affected week (no `weeklySummarize` call for it)
- new invoice → affected week = its computed date's week
- \>5 affected weeks (first-run fixture: invoices spread over 7 completed weeks) → exactly 5 `weeklySummarize` calls oldest-first, remaining 2 week-starts persisted in `ORDERAPP_RESUM_QUEUE_greenbean`
- following run with empty diff → the 2 queued weeks are drained (summarized) and the queue property emptied
- current-week invoice → never resummarized, never queued
- `greenBeanWindow_('2026-01-15')` → `{from:'2025-11-01', to:'2026-01-15'}` (year boundary)
- token unset → `{noToken:true}`, sheet untouched

## Acceptance Criteria

```bash
node connectors/gas/test_code.js
```

## Verification Procedure

1. Run the AC command.
2. Checklist: Suppliers written ONLY via `ingestSupplierRows`; resummarize only ever called with completed weeks; queue property survives across simulated runs.
3. Update this step in `phases/orderapp-pulls/index.json`.

## Prohibitions

- Do not ingest a partially-fetched window. Reason: a silently short window looks like real spend shrinkage downstream.
- Do not derive an updated invoice's affected week from the recomputed `min(dateLocal)`. Reason: the sheet row's date column is never updated by `upsertRows_`; the row lives in the stored date's week (step 4 of Task).
- Do not resummarize or queue the current incomplete week. Reason: `weeklySummarize` refuses incomplete weeks; queueing it would wedge the queue head.
- Do not drop overflow weeks with only a log line. Reason: a log is not a work item; understated Summary weeks would persist silently (review round 3 finding).
- Do not break existing tests.
