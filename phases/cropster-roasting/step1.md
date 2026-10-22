# Step 1: gas-ingest

## Requirements Covered

- `PRD-23` - Cropster Roasting weekly ingest (doPost `kind=roasting` → validate → `Roasting` tab).

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

Create **`connectors/gas/cropster.gs`** with `ROASTING_TAB='Roasting'`, `ROASTING_HEADERS`, `ROASTING_SOURCE='cropster'`, `roastingIngest_(body)` and `roastingUpsert_(sheet, rows, opts)`. Wire **`Code.gs`**:
- kind whitelist + `roasting`
- the 3 tables (`cropster` → `INGEST_TOKEN_CROPSTER` / **`null`** / `['roasting']`)
- an explicit `roasting` branch in the lock dispatch calling `roastingIngest_`
- a `roasting` branch in `validateIngest_`

**Validation (in `validateIngest_`; refuse the whole payload with a specific `message`, never truncate):**
- row keys exactly the row contract; `date === week_start`
- `week_start` is a Monday `YYYY-MM-DD`, not after the current Sydney week's Monday, and not more than 16 weeks before it
- `profile` is a non-empty string ≤200 chars
- `green_kg_in`, `roasted_kg_out`: `typeof number && isFinite && 0 ≤ x ≤ 100000`
- `batch_count`: an integer ≥ 0
- `weight_loss_pct`: a finite number in [0,100], or `null`
- ≤500 rows and ≤13 distinct `week_start` per payload
- no duplicate `week_start||profile` within the payload
- `allow_shrink`, if present, must be boolean

**`roastingUpsert_` (week-scoped atomic replace):**
- Read the whole tab body.
- Build the new body in memory: keep every row whose week is NOT in the batch, and replace all rows of each batch week with the batch rows. Sort by `week_start`, then `profile`.
- Stamp `pulled_at` = `ingestServerStamp_()`.
- Apply `sheetSafeRow_` to every row.
- **Shrink guard:** for each batch week with stored rows, if the new Σ `roasted_kg_out` < 50% of the stored Σ and `allow_shrink !== true`, refuse the WHOLE payload (no write) with a message naming the week(s).
- Pad the body with blank rows up to the old `getLastRow()` and write header + body in ONE `setValues`. After that, best-effort delete trailing blank rows inside try/catch; never let the trim throw out.
- `ensureSheet` creates the tab with headers when it is missing.
- Return `{rowsAdded, rowsUpdated, weeks}` so doPost's response keeps its shape.

Staleness: add `cropster` to `STAMPS_HEARTBEAT` **and** `NOT_YET_ARMED` in `test_code.js`. Add a comment in `staleness.gs` beside the other not-yet-armed notes: "cropster: arm (add to STALENESS_SOURCES + override 192h) only after the first clean live pull stamps LAST_INGEST_cropster — phases/cropster-roasting step 5".

Docs: add the `Roasting` tab to `docs/schema.md` (columns, key, week-scoped replace, shrink guard, kg only, no department). Add `cropster`/`roasting` to `docs/ingest-token-cutover.md`'s source list.

### Test First (TDD step)

Write these tests BEFORE the implementation. Confirm RED for the right reason (function undefined / wrong value - not a syntax error), then implement to GREEN, then refactor. The enumerated cases are the definition of done.

Add to `connectors/gas/test_code.js` (above the final summary/`process.exit` pair):
- **Fields:**
  - a valid payload is accepted
  - week_start not a Monday → refused
  - `date ≠ week_start` → refused
  - an unknown row field → refused; also `pulled_at`, and `department` (each asserting the specific message)
  - empty or 201-char profile → refused
  - kg as a string `"5"`, `NaN`, `Infinity`, `-1`, `100001` → refused
  - batch_count `1.5` / `-1` → refused
  - loss `101` / `-0.1` → refused; loss `null` → accepted
- **Window and size:**
  - week_start after the current week → refused; 17 weeks back → refused; exactly 16 weeks back → accepted
  - 14 distinct weeks → refused; 501 rows → refused (refused, not truncated)
  - an in-payload duplicate key → refused
  - non-boolean `allow_shrink` → refused
- **Auth / routing:**
  - wrong token → `UNAUTHORIZED`
  - the `cropster` token posting `kind:'suppliers'` → refused
  - another source posting `kind:'roasting'` → refused
  - parity test includes `cropster`
- **End-to-end `doPost`:** real test token + valid roasting payload → `result:'ok'`; rows land in `Roasting` with the headers above; **no `department` key/column anywhere**; `Suppliers` row count unchanged.
- **Upsert (each a sequential two-post test):**
  - a re-post of the same week updates in place (no duplicate rows, values changed)
  - a profile renamed in the 2nd post leaves no orphan row for that week
  - weeks absent from the 2nd post are untouched
  - server `pulled_at` wins (a client cannot set it)
- **Atomicity:** inject a throw inside the single `setValues` → prior rows intact. Inject a throw in the trailing-blank trim → no duplicate rows, and a Σ read over the tab equals the expected value.
- **Shrink guard:**
  - a 2nd post cutting a week's Σ to <50% → refused, message names the week, nothing written (other weeks in the same payload also unwritten)
  - with `allow_shrink:true` → accepted
  - a ≥50% case → accepted
- **Formula injection:** profile `=HYPERLINK("x")` stored inert.
- **Heartbeat:** `LAST_INGEST_cropster` stamped after an ok post; `cropster` is listed in `NOT_YET_ARMED` and not in `STALENESS_SOURCES`.

## Acceptance Criteria

```bash
node connectors/gas/test_code.js
```

All pre-existing tests stay green plus every new case. Report the final pass counts.

## Verification Procedure

1. Run the AC command and record the counts (baseline 3500).
2. Mutation-check: (a) remove the shrink guard → the shrink test goes red; (b) set the department binding to `'Roastery'` → the end-to-end test goes red; (c) remove the explicit lock-dispatch branch → the Suppliers-unchanged test goes red. Restore each.
3. `git diff --stat` touches only `connectors/gas/{Code.gs,cropster.gs,staleness.gs,test_code.js}` and `docs/{schema.md,ingest-token-cutover.md}`.
4. Update this step in `phases/cropster-roasting/index.json`.

## Prohibitions

- Do not break existing tests. Reason: run the FULL suites (memory `cross-step-test-anchor-conflict`).
- Do not commit credentials, tokens, cookies, header values, PII or real Cropster figures into code, tests, fixtures or phase files. Reason: Absolute Rule; fixtures are synthetic.
- Do not deploy, push, register scheduled tasks or touch Script Properties unless this step says so. Reason: deploy is step 5; push is "lets stop here".
- Do not create a new GAS project/deployment. Reason: one project, one deployment.
- Do not write to any Sheet tab from the Python connector. Reason: two-runtime boundary.
- Do not change behaviour for any existing kind/source. Reason: shared ingest path; the existing tests prove it.
- Do not relax the generic `r.date` gate. Reason: the row contract satisfies it as-is.
