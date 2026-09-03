# Step 4: wholesale-pull

## Requirements Covered

- `PRD-14` — the weekly pull entry point: fetch, cross-foot, guard, self-heal, ingest,
  re-summarize, and decide the heartbeat. This is the money-path step.

If the Task below contradicts the requirement, `docs/ADR.md`, or a CRITICAL rule in
CLAUDE.md, set `"status": "needs_context"` with the contradiction spelled out and stop.

## Files to Read

- `connectors/gas/orderapp.gs` — **the whole file**, and specifically:
  `shopifyWeeklyPull` (`:297-305`, the entry-point shape you copy),
  `shopifyWeeklyPull_impl_` (`:340-424`), `greenBeanPull_impl_` (`:714-995`) — you are
  porting its snapshot/diff and its **date-move self-heal at `:842-858`** —
  `orderAppRunStart_` (`:113`), `orderAppRunSuccess_` (`:137`),
  `orderAppRaiseDataQualityAlert_` (`:198`), `orderAppClearDataQualitySignature_` (`:236`),
  `orderAppSignatureHash_` (`:227`), `lastCompletedWeeks_` (`:275`).
- `connectors/gas/Code.gs` — `ingestRevenueRows` (`:633`), `upsertRows_` (`:712-753`)
  **read `:728` and `:738-748` line by line**, `withScriptLock_` (`:204`) and
  `LOCK_TIMEOUT_` (`:202`), `weeksWithArchivedRows_` (`:1646-1659`),
  `weekStartForDate_`, `todayStr_`, `REVENUE_TAB`/`REVENUE_HEADERS`, `ensureSheet`,
  `weeklySummarize`, and `runFdcoBackfillResummarize`'s archive refusal (`:1607-1627`).
- `phases/roastery-wholesale/prod-probe.md` — the measured PROD figures.

## Task

Add `wholesalePull(opts)` and `wholesalePull_impl_(opts)`.

**Entry point** — byte-for-byte the shape of `shopifyWeeklyPull`:

```js
function wholesalePull(opts) {
  orderAppRunStart_(WHOLESALE_SOURCE);              // BEFORE the lock
  var res = withScriptLock_(function () { return wholesalePull_impl_(opts); });
  if (res === LOCK_TIMEOUT_) {
    Logger.log('wholesalePull: could not acquire script lock — skipped this run');
    return { locked: true };
  }
  return res;
}
```

`opts` is optional; `opts.dryRun === true` means build and log everything and **write
nothing at all** — no ingest, no date-move cell writes, no `weeklySummarize`, no heartbeat.

**`wholesalePull_impl_(opts)`**, per week from
`lastCompletedWeeks_(todayStr_(), wholesaleRepullWeeks_())` (oldest-first):

1. **Fetch + gate.** `wholesaleFetchWeekOrders_(week)`. Not `ok` → push
   `{week: week.label, reason}` onto `failedWeeks`, `continue`. Nothing is written for a
   failed week.
2. **Map.** `wholesaleRevenueRows_(fetched.orders)`.
3. **Cross-foot, in integer cents, before anything is written.** For each of the four
   channels, the producer's bucket is `WHOLESALE_SHOPTYPE_MAP_`'s bucket for that channel.
   Compare `mapped.grossCentsByChannel[ch]` against
   `Math.round(fetched.summary[bucket].gross * 100)` minus the cents of that channel's
   counted drops. They must be **exactly equal**. Any mismatch → push onto
   `crossFootFailures` with both figures, write nothing for the week, `continue`.
   Never compare these as floats.
4. **Archive-split guard, BEFORE the write.** `weeksWithArchivedRows_([week.start])`. If it
   returns the week, push onto `splitWeeks`, write nothing, `continue`. Writing a split
   week would strand rows that can never be summarized (Prohibition 8), and re-summarizing
   one overwrites a correct `Suppliers` total with a partial. Note its **fail-closed**
   behaviour: on an unreadable `_archive` header it returns every week you asked about, so
   a whole run can legitimately skip everything — that case must alert loudly, and the
   log line must say which of the two it was.
5. **Pre-ingest snapshot.** Read the `Revenue` tab once per run, building
   `{ 'coffee_order_app||' + order_ref.trim().toLowerCase() : {storedDate, amount, rowIndex} }`
   — the same `.trim().toLowerCase()` normalization `rowKey_` uses.
6. **Date-move self-heal — port `orderapp.gs:842-858`.** For every mapped row whose key is
   in the snapshot and whose `date !== snap.storedDate`: `setValue` the date cell and the
   `extracted_at` cell in place, and queue **both** `weekStartForDate_(snap.storedDate)`
   and `weekStartForDate_(row.date)` for re-summarize. This is not optional and is not
   covered by any other guard: `upsertRows_` writes **only** the amount and stamp cells
   (`Code.gs:743-746`), so a moved order with an unchanged amount returns
   `duplicatesSkipped` — no write, no diff, no signal — and the money stays in the wrong
   ISO week forever. The cross-foot cannot see it either, because the API and the mapped
   rows agree; the disagreement is with what is already in the Sheet.
7. **Ingest.** `ingestRevenueRows(WHOLESALE_SOURCE, rows, extractedAt, revSheet)` where
   `revSheet = ensureSheet(ss, REVENUE_TAB, REVENUE_HEADERS)`.
8. **Assert the return.** Require
   `rowsAdded + rowsUpdated + duplicatesSkipped === rows.length`, and require every
   `duplicatesSkipped` to be explained by a snapshot entry with an equal amount. An
   unexplained skip means a within-batch key collision (`Code.gs:728` discards the second
   row silently, never sums it) → treat exactly like a cross-foot mismatch: record it and
   suppress the heartbeat.
9. **Queue.** A week is queued for re-summarize if `rowsAdded + rowsUpdated > 0` or a
   date-move touched it. Then `weeklySummarize(weekStart)` per queued week, capped per run
   like `GREENBEAN_RESUM_CAP` with the remainder persisted to a
   `WHOLESALE_RESUM_QUEUE` Script Property. **Assert the return** — `weeklySummarize`
   returns `{refused:…}` rather than throwing, and its counters are `summariesAdded` /
   `summariesUpdated`, not `rowsAdded`.

**Heartbeat — Prohibition 10, all five conditions.** Call
`orderAppRunSuccess_(WHOLESALE_SOURCE)` only if the newest week (the LAST entry of
`lastCompletedWeeks_`) passed its gate AND was not skipped as split AND wrote rows AND was
successfully re-summarized AND its `wholesale`-channel gross ≥ `WHOLESALE_GROSS_FLOOR`.
Otherwise do not stamp. A quiet week (shutdown/holiday) therefore raises a staleness alert
168h later; that is deliberate, it fails toward alerting, and it must be commented so the
first occurrence is not debugged as a bug.

**Data-quality alert.** `orderAppRaiseDataQualityAlert_(WHOLESALE_SOURCE, message, signature)`
when any of: `failedWeeks`, `crossFootFailures`, unexplained skips, `splitWeeks`, a
zero-row completed week, `summary.ambiguous.orderCount > 0`,
`summary.unknown.orderCount > 0`, or a non-empty `meta.classificationConflicts`. The
signature is `orderAppSignatureHash_` over the sorted conflict list plus the failed/split
week labels. On a fully clean run call `orderAppClearDataQualitySignature_`. Never
auto-resolve a conflict — a human fixes `SHOPS` in the Order app.

**Logging.** One line per week with the four bucket grosses, and one line per week for
`orphanRows` / `undatedRows` / `outOfWeekRows` / `excluded` carrying count and gross plus
the literal words **"diagnostic only — never ingested"**. Do not emit one large
`JSON.stringify` blob; the GAS editor log truncates it.

**Return** `{weeksRequested, weeksFetched, failedWeeks, crossFootFailures, splitWeeks,
ordersFetched, rowsAdded, rowsUpdated, duplicatesSkipped, datesHealed, weeksResummarized,
weeksQueued, byBucket, heartbeatStamped, dryRun, apiFailed?, noToken?}`.

### Test First (TDD step)

Test cases (defined at design time — these are "done"):
- happy path, 3 weeks, all clean → rows land in `Revenue` in `REVENUE_HEADERS` order with
  `source='coffee_order_app'`; heartbeat stamped
- `dryRun: true` on the same fixture → identical returned counts, **zero** rows in
  `Revenue`, no `weeklySummarize` call, no heartbeat stamped
- one week fails its gate → that week writes nothing, the others do write, `failedWeeks`
  names it, DQ alert raised
- the **newest** week fails → heartbeat NOT stamped; an **older** week fails → heartbeat
  IS stamped (this is the 8-week-window rule, and is why it differs from shopify's)
- cross-foot mismatch of exactly 1 cent → the week writes **nothing** and is recorded
- cross-foot passes when drops are subtracted correctly (a dropped bad-amount order makes
  the raw sums differ, and the week still writes)
- a week with rows in `_archive` → nothing written, `splitWeeks` names it,
  `weeklySummarize` NOT called for it
- `weeksWithArchivedRows_` returns every week (the fail-closed case) → the whole run
  writes nothing, alerts, and does not stamp the heartbeat
- **date-move**: an existing `Revenue` row for `ORD-X` dated `2026-08-03`, upstream now
  `2026-08-11`, same amount → the date cell is rewritten, `extracted_at` refreshed, and
  BOTH `2026-08-03` and `2026-08-10` week-starts are queued. Mutation-check it: remove the
  self-heal and confirm this case reds.
- within-batch collision: two mapped rows share an `order_ref` → `duplicatesSkipped` is
  unexplained by the snapshot → recorded, heartbeat suppressed
- zero-activity newest week (gate passes, `orders: []`) → no heartbeat, DQ alert raised
- newest week's wholesale gross of `799` → no heartbeat; `801` → heartbeat
- `summary.ambiguous.orderCount > 0` (the real Leible Taiwan case) → DQ alert raised,
  rows still written on the `ambiguous` channel
- `classificationConflicts` non-empty → alert; identical conflicts next run → suppressed
  by the signature; a changed conflict list → alerts again
- lock timeout → `{locked:true}`, nothing written, `orderAppRunStart_` still called
- no token → `orderAppRunSkipped_` path, nothing written, no heartbeat
- **idempotency**: run the happy path twice → second run `rowsAdded:0, rowsUpdated:0`,
  `Revenue` row count unchanged
- **never Summary-direct**: assert the `Summary` tab is untouched except via
  `weeklySummarize`
- `orphanRows`/`undatedRows`/`outOfWeekRows` present in the fixture → **zero** rows from
  them reach `Revenue`, and the log line says "diagnostic only — never ingested"

## Acceptance Criteria

```bash
node connectors/gas/test_code.js
```

## Verification Procedure

1. Run the AC command fresh — do not trust an inherited green count. Record pass/fail.
2. Run each Prohibition below as a grep or an assertion against the diff, not just the
   test run. Green tests have masked prohibition breaches in this repo before.
3. Mutation-check three separately, reverting each: (a) remove the date-move self-heal,
   (b) move the `weeksWithArchivedRows_` check to after the ingest, (c) compare the
   cross-foot as floats instead of cents. Each must red at least one named case.
4. Update this step in `phases/roastery-wholesale/index.json`.

## Prohibitions

- Never derive `external` as `all − internal`.
- Never ingest `orphanRows`, `undatedRows`, `outOfWeekRows` or `excluded`. Reason: they are
  per-scan diagnostics, not week-scoped — the step-0 probe measured `orphanRows` at a
  constant $2,703 in **every** weekly response and `outOfWeekRows` at ~$241k. Summing them
  across weekly pulls would invent six figures of revenue.
- Never write a week whose `diagnostics.*Ok` are not all true.
- Never write a week whose cross-foot does not balance, and never compare those sums as
  floats.
- Never call `weeklySummarize` on a week carrying `_archive` rows, and never write one
  either.
- Never write to `Summary` directly. Reason: `shopify_orderapp` is the single documented
  exception to "Summary is derived", and this is not it.
- Never stamp the heartbeat on fewer than all five conditions above.
- Never auto-resolve `classificationConflicts`.
- Never call `installOrderAppTriggers()` from this step. Reason: arming the trigger before
  step 8's supervised bring-up makes the first live write unattended.
- Do not break existing tests.
