# Step 2: gas-read

## Requirements Covered

- `PRD-24` - `doGet` `fn=roasting` read API over the `Roasting` tab.

This is *why* this step exists. If the Task section below appears to contradict the
requirement above, `docs/ADR.md`, or a CRITICAL rule in CLAUDE.md, do NOT resolve the
conflict yourself - set `"status": "needs_context"` with the contradiction spelled out
in `needs_context_detail`, and stop.

## Files to Read

- `C:/Users/mioja/.claude/plans/cropster-roasting.md` (approved plan).
- `phases/cropster-roasting/contract.md`.
- `connectors/gas/Code.gs` (doPost `:479`, `validateIngest_` `:657`, tables `:241/:295/:326`, lock dispatch `:558`, doGet `:2247`).
- `connectors/gas/shopcoffee.gs`, `connectors/gas/staleness.gs`, `connectors/gas/test_code.js` (load lines, `STAMPS_HEARTBEAT`/`NOT_YET_ARMED` ~`:3545`, the doPost test helper with `DOPOST_TEST_TOKEN`).
- `docs/schema.md`, `docs/api.md`, `docs/ingest-token-cutover.md`.

## Design facts (shared by every step in this phase)

- **Spec:** `C:/Users/mioja/.claude/plans/cropster-roasting.md` is the approved plan. Read "Decisions locked", "Step 0 outcome", the step table row for this step, and "Risks". `phases/cropster-roasting/contract.md` is the live Cropster data contract.
- **Two-runtime boundary (CLAUDE.md CRITICAL):** the Playwright connector only logs in, reads and POSTs to `doPost`. GAS validates, normalizes and writes. The connector never writes the Sheet.
- **Row contract (exact; shared by GAS step 1 and connector step 3):** each posted row is `{date, week_start, profile, green_kg_in, roasted_kg_out, weight_loss_pct, batch_count}`.
  - `date === week_start` (a `YYYY-MM-DD` Monday on the Sydney clock). This satisfies the generic `r.date` gate at `Code.gs:752-762`, which stays unchanged.
  - Any other row field is rejected, including `pulled_at` and `department`.
  - The body is `{source:'cropster', kind:'roasting', token, extracted_at, rows, allow_shrink?}`.
- **`Roasting` tab headers:** `week_start, profile, green_kg_in, roasted_kg_out, weight_loss_pct, batch_count, pulled_at`.
  - Key `week_start||profile`. `pulled_at` is server-stamped via `ingestServerStamp_()`.
- **Hub tables (`Code.gs`; key parity is test-enforced):** `cropster` → `INGEST_TOKEN_CROPSTER` in `INGEST_SOURCES_` (`:241`), **`null`** in `INGEST_SOURCE_DEPARTMENTS_` (`:295`), `['roasting']` in `INGEST_SOURCE_KINDS_` (`:326`).
  - The binding must be `null`: a non-null binding injects `department` into rows AFTER `validateIngest_` (`:546-553`). `brighthr_roster` (`:300-305`) is the precedent, and with `null` the check at `:775` rejects a caller-sent `department`.
  - Kind whitelist `:667`. The doPost lock dispatch `:558-574` falls through to `ingestSupplierRows` for an unknown kind, so `roasting` needs an explicit branch.
  - doGet: `checkReadToken_` runs first (`:2347`); `fn` dispatch at `:2254-2256`.
- **Patterns to mirror:** `connectors/gas/shopcoffee.gs` (`SHOP_COFFEE_HEADERS` `:168`, `shopCoffeeUpsert_` `:250`, `shopCoffeeRead_` `:391`, `ensureSheet` `Code.gs:1487`, `sheetSafeRow_`, `coerceDateStr_`, `lastCompletedWeeks_`/`getLastCompletedWeek_`).
- **Staleness:** `STALENESS_SOURCES` `staleness.gs:88`; `STALENESS_THRESHOLD_OVERRIDES` `:51`; heartbeat `LAST_INGEST_<source>` stamped by `stalenessStampHeartbeat_(body.source)` at `Code.gs:587`. `STAMPS_HEARTBEAT` / `NOT_YET_ARMED` are in `test_code.js:3545/:3561`.
  - `cropster` goes into NOT_YET_ARMED in step 1 and is armed only in step 5, after the first clean pull. A never-seen source is stale immediately.
- **Tests:**
  - `node connectors/gas/test_code.js` (baseline **3500 passed**). Add `load('cropster.gs')` beside the other `load(...)` lines. Insert new tests **above** the final `console.log(... passed ...)` / `process.exit(...)` pair, which sits at the very end of the file; tests after `process.exit` are dead.
  - `python -m pytest connectors/playwright -q` (baseline **99 passed**). Stub `get_credential`/env via monkeypatch (unstubbed, it reads the real `.env`).
  - `python -m pytest scripts/test_execute.py -q` (baseline **288 passed**).
- **Memory gotchas:**
  - Overwrite/replace attacks must be tested **sequentially** (two separate posts), because a same-batch duplicate is dropped.
  - `eq()` is full-object equality, so a new field on a shared object ripples into other tests.
  - Money/kg gates use `typeof x==='number' && isFinite(x)`, not `Number()` coercion.
  - Assert the specific refusal reason, not just "refused".
  - Mutation-check every new guard (revert the guard → the test goes red → restore).

## Task

Add `roastingRead_(from, to)` to `cropster.gs` and one `fn=roasting` dispatch line in `Code.gs` doGet. The token check already runs first.
- `from`/`to` are ISO `YYYY-MM-DD` week_start bounds, inclusive. The default is the last completed week. Invalid or inverted dates → `{ok:false, result:'error', message}`, never all data.
- Response: `{ok:true, fn:'roasting', from, to, rows:[{week_start, profile, green_kg_in, roasted_kg_out, weight_loss_pct, batch_count, pulled_at}], weeks:[{week_start, totalKg, batchCount, profiles}]}`.
  - `totalKg` = Σ `roasted_kg_out` rounded to 0.1.
  - `weeks` is sorted ascending and contains only weeks that have rows.
- Skip blank rows. Coerce Date cells via `coerceDateStr_`. kg values are numbers.
- Missing tab → `{ok:true, rows:[], weeks:[], note}`.
- Docs: add `fn=roasting` to `docs/api.md` (params, auth, response, example with dummy numbers).

### Test First (TDD step)

Write these tests BEFORE the implementation. Confirm RED for the right reason (function undefined / wrong value - not a syntax error), then implement to GREEN, then refactor. The enumerated cases are the definition of done.

- token + range → only rows in range, shape as above
- default → exactly the last completed week
- **no token / wrong token → unauthorized, and no row data in the body**
- inverted or malformed dates → error body
- missing tab → ok, empty, with a note
- blank padding rows are skipped and don't affect totals
- Date cells come back as `YYYY-MM-DD` (no AEST off-by-one)
- `weeks[].totalKg` = rounded Σ; `batchCount` = Σ
- existing `fn` handlers unaffected

## Acceptance Criteria

```bash
node connectors/gas/test_code.js
```

All pre-existing tests stay green plus every new case. Report the final pass counts.

## Verification Procedure

1. Run the AC and record the counts.
2. Mutation: bypass the token check in the test double → the no-token test goes red → revert.
3. `grep -n "roasting" docs/api.md`.
4. Update this step in `index.json`.

## Prohibitions

- Do not break existing tests. Reason: run the FULL suites (memory `cross-step-test-anchor-conflict`).
- Do not commit credentials, tokens, cookies, header values, PII or real Cropster figures into code, tests, fixtures or phase files. Reason: Absolute Rule; fixtures are synthetic.
- Do not deploy, push, register scheduled tasks or touch Script Properties unless this step says so. Reason: deploy is step 5; push is "lets stop here".
- Do not create a new GAS project/deployment. Reason: one project, one deployment.
- Do not write to any Sheet tab from the Python connector. Reason: two-runtime boundary.
- Do not add a second auth path. Reason: the doGet token check is the whole read surface.
