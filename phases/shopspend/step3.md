# Step 3: shopspend-ingest-change-detection

## Files to Read

- `docs/schema.md` — the `ShopSpend` spec: append-only, only-when-changed, `presence` tombstones,
  and "latest = last row in append order".
- `connectors/gas/shopspend.gs` — `ensureShopSpendTabs_` (step 1) and `ingestShopSpendRows`
  (step 2, the naive append you are replacing).
- `connectors/gas/Code.gs` — `buildKeyIndex_` (**342-349**) and `rowKey_` (**416-424**) for the
  composite-key idiom; `appendNewRows_` (**426-428**) — note it is one `appendRow()` API call per
  row; `fillBlankDepartments_` (**726-741**) — the contiguous-block `setValues()` precedent;
  `coerceDateStr_` (**1316-1324**).
- `connectors/gas/test_code.js` — `sheetCoerceOnWrite` (**39-46**) and `cellDate` (**51-55**).
  A bare `yyyy-MM-dd` written to a cell comes back as a `Date`; assertions must compare via
  `cellDate()`, never `String(cell)`.

## Background

Re-pulling the same week can legitimately return different numbers — the upstream API recomputes
totals live from a pricing sheet. So `ShopSpend` is an append-only snapshot store. But writing a
full row set on every weekly pull would grow the tab by `shops × weeks` forever, and every read
helper in this codebase does a full `getDataRange().getValues()` scan, so read cost grows with it.

The agreed policy: **append a snapshot row only when a figure actually changed.** "We checked at T
and nothing moved" is still recorded — by the `ShopSpendPulls` row, which is written on every pull
regardless. That keeps history reproducible without unbounded growth.

Two traps this step must handle:

- **`appendNewRows_` is one API call per row** and `Code.gs:704-707` already documents that shape
  risking the 6-minute execution limit. Use a single contiguous block write instead.
- **"Latest snapshot" must mean the LAST MATCHING ROW IN APPEND ORDER, not max `fetched_at`.**
  `fetched_at` carries a UTC offset, and a lexicographic compare orders the Australia/Sydney DST
  flip (`+11:00` → `+10:00`, April and October) wrongly — a snapshot taken later in wall-clock time
  can sort earlier as a string.

## Task

Replace the naive append in `ingestShopSpendRows` (`connectors/gas/shopspend.gs`) with:

**1. Latest-snapshot index.** Scan the `ShopSpend` tab once and build
`{ 'shop_id||week_label': <row array> }` keeping the **last** matching row encountered, i.e. append
order. Use the `rowKey_` idiom (lowercase, trim, `'||'` join) so key building matches the rest of
the codebase.

**2. Change detection.** For each incoming row, compare the five numeric figures — `order_count`,
`amended_count`, `total_ex_gst`, `gst`, `total_inc_gst` — against the latest snapshot for its key.
Compare **numerically** (`Number(a) !== Number(b)`), not as strings.
- New key, or any figure differs → append a new snapshot row with `presence: 'present'`.
- All five identical → skip; count it in `duplicatesSkipped`.
- A latest snapshot with `presence: 'absent'` counts as a difference — the shop-week reappearing is
  a real change and must produce a fresh `present` row.

**3. Tombstones for disappearing shop-weeks.** Build the set of `(shop_id, week_label)` keys that
the incoming payload covers *for the weeks it covers*. Any key that already has a
`presence: 'present'` latest snapshot for one of those weeks, but is absent from the payload, gets
an appended tombstone row: same `shop_id`/`week_label`/`week_start`/`week_end`, zeros for the
figures, `presence: 'absent'`, current `fetched_at`.

Scope the diff to the weeks present in the payload — a pull for `2026-W31` must never tombstone
`2026-W20`. If the payload contains no rows at all, tombstone nothing (an empty range is a
diagnostics condition, handled by the report, not a signal that every shop vanished).

Without this, a shop-week that stops being reported keeps rendering its old dollar figure in the
report forever — a silently wrong number, which is exactly this project's headline failure mode.

**4. Block write.** Collect all rows to append (changed + tombstones) into one 2D array and write
once:

```js
sheet.getRange(sheet.getLastRow() + 1, 1, block.length, SHOPSPEND_HEADERS.length).setValues(block);
```

Skip the write entirely when `block.length === 0`.

**5. Return** `{rowsAdded: <appended incl. tombstones>, rowsUpdated: 0, duplicatesSkipped: <unchanged>}`.

Core rules that must not deviate:
- `rowsUpdated` is always `0`. Reason: nothing is ever mutated in place; the value proves it.
- Never call `upsertRows_`. Reason: it overwrites the prior row and collapses same-key rows within
  a batch — it would destroy the snapshot history this step exists to create.
- Never use `toISOString()`. Reason: AEST off-by-one.

### Test First (TDD step)

Add these to `connectors/gas/test_code.js` before implementing. Confirm RED for the right reason
(figures change but no row appends / no tombstone), then implement to green.

Test cases (definition of done):
- **First pull appends everything:** 3 rows in, `rowsAdded: 3`, `duplicatesSkipped: 0`.
- **Identical re-pull appends nothing:** same 3 rows again → `rowsAdded: 0`,
  `duplicatesSkipped: 3`, and the tab row count is unchanged. This is the idempotent-resume path
  the chunked poster relies on.
- **A changed figure appends one row:** re-pull with `total_ex_gst` altered on one shop →
  `rowsAdded: 1`, `duplicatesSkipped: 2`; the tab now holds BOTH snapshots for that key (the old
  row is still present and unmodified).
- **Each of the five figures is watched:** a change in `order_count` alone, and in `amended_count`
  alone, each appends. (Guards against comparing only the money columns.)
- **Latest = append order, not `fetched_at` (DST fixture):** append a row with
  `fetched_at = '2026-04-04T10:00:00+11:00'`, then a row with `'2026-04-05T10:00:00+10:00'`. The
  SECOND row is the latest snapshot even though it sorts earlier lexicographically — a re-pull
  matching the second row's figures must be treated as unchanged.
- **Tombstone on disappearance:** pull A covers shops X and Y for `2026-W31`; pull B covers only X
  for `2026-W31` → a `presence: 'absent'` row is appended for Y, and `rowsAdded` counts it.
- **Tombstone scope:** pull B for `2026-W31` does NOT tombstone a shop that only ever appeared in
  `2026-W30`.
- **No double tombstone:** pull C, again without Y, appends no second tombstone for Y (its latest
  snapshot is already `absent`).
- **Reappearance:** pull D includes Y again → a `presence: 'present'` row is appended even if its
  figures match the pre-tombstone snapshot.
- **Empty payload tombstones nothing.**
- **Single block write:** the append path issues one `setValues()` for the whole batch, not one
  `appendRow()` per row. Assert via the mock's recorded write calls.
- **Date cells:** `week_start` / `week_end` round-trip correctly — assert with `cellDate()`,
  not `String(cell)`.
- **No regression:** the full existing suite passes.

## Acceptance Criteria

```bash
node connectors/gas/test_code.js      # all tests pass incl. the new cases; exit 0
```

## Verification Procedure

1. Run the AC command.
2. Architecture checklist:
   - No existing tab or ingest path changed; the shopspend branch is still inside `withScriptLock_`.
   - `rowsUpdated` is 0 in every shopspend response.
   - Confirm `git diff` shows no call to `upsertRows_` or `appendNewRows_` from `shopspend.gs`.
3. Update `phases/shopspend/index.json` step 3 (`completed` + `summary`, or `error` +
   `error_message`, or `blocked` + `blocked_reason` then stop).

## Prohibitions

- Do not use `upsertRows_` or `appendNewRows_`. Reason: the first overwrites history, the second is
  one API call per row and risks the 6-minute limit on a backfill.
- Do not compare figures as strings. Reason: `3360.77` written to a cell and read back may differ
  in string form; `Number()` comparison is the contract.
- Do not sort or select snapshots by `fetched_at`. Reason: the DST offset flip mis-orders it — see
  the fixture above.
- Do not tombstone weeks the payload does not cover. Reason: a single-week pull would wipe out
  every other week's data in the report.
- Do not build the report or touch the watchdog. Reason: steps 6 and 7.
