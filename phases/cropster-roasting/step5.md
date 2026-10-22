# Step 5: deploy-live

## Requirements Covered

- none (operational deploy + live verification of PRD-23/24/25).

This is *why* this step exists. If the Task section below appears to contradict the
requirement above, `docs/ADR.md`, or a CRITICAL rule in CLAUDE.md, do NOT resolve the
conflict yourself - set `"status": "needs_context"` with the contradiction spelled out
in `needs_context_detail`, and stop.

## Files to Read

- The approved plan step 5 row (the full ordered list a–p).
- `C:/Users/mioja/.claude/docs/agent-autonomy.md` (PROD chain).
- `docs/autonomy-readiness.json`, `scripts/deploy.sh`, `config/deployment.json`, `docs/ingest-token-cutover.md`.

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

Follow the plan's step 5 (a)–(p) **in order**. Summary:

**Deploy 1 (staleness dormant):**
- The token `INGEST_TOKEN_CROPSTER` must be present in GAS Script Properties AND `.env` (Jake pastes it; ⛔ credential). If it is absent, set `blocked` with a precise ask.
- Record the current deployment version.
- Commit, then tag `prod-cropster-1`.
- `/security-audit` APPROVE at HEAD.
- `bash scripts/deploy.sh`.
- Smoke, read-only: tokenless `fn=roasting` → unauthorized; tokened → ok with empty rows; `fn=summary` answers.
- On failure: `clasp redeploy` the recorded version, re-smoke, stop.

**Live load:**
- `python connectors/playwright/cropster.py --backfill`. Needs `CROPSTER_EMAIL`/`CROPSTER_PASSWORD`, or a saved session from `--attended --dry-run`.
- Read `rowsAdded`.
- curl `fn=roasting` over the 12 weeks: expect 12 weeks.
- Spot-check one week's totalKg against a fresh Chrome read of the Production Report for that exact Mon–Sun range.

**Deploy 2 (arm):**
- Only after `LAST_INGEST_cropster` exists: move `cropster` from `NOT_YET_ARMED` to `STALENESS_SOURCES` with `STALENESS_THRESHOLD_OVERRIDES.cropster = 192`, and update the staleness alert text to name `--backfill`.
- Run the full suite.
- Commit, then tag `prod-cropster-2`.
- Fresh `/security-audit`.
- Deploy, smoke, and keep the rollback line.

**Ops:**
- Register the task for real (`register_cropster_task.ps1`) and confirm with `Get-ScheduledTask`.
- Then update `docs/autonomy-readiness.json`, `TODO.md` and the CLAUDE.md live/rollback lines, and flip PRD-23/24/25 to `built`.

## Acceptance Criteria

```bash
node connectors/gas/test_code.js
python -m pytest connectors/playwright -q
```

All pre-existing tests stay green plus every new case. Report the final pass counts.

## Verification Procedure

1. Record every curl/smoke result in `phases/cropster-roasting/deploy-note.md`: status codes and week counts only, **no kg figures**.
2. `execute.py` exits 0 on non-success, so confirm this step's status in `index.json`.

## Prohibitions

- Do not break existing tests. Reason: run the FULL suites (memory `cross-step-test-anchor-conflict`).
- Do not commit credentials, tokens, cookies, header values, PII or real Cropster figures into code, tests, fixtures or phase files. Reason: Absolute Rule; fixtures are synthetic.
- Do not deploy, push, register scheduled tasks or touch Script Properties unless this step says so. Reason: deploy is step 5; push is "lets stop here".
- Do not create a new GAS project/deployment. Reason: one project, one deployment.
- Do not write to any Sheet tab from the Python connector. Reason: two-runtime boundary.
- Do not bypass a gate (`SKIP_*`, `--no-verify`, hand-written verdict). Reason: hard stop.
- Do not edit CLAUDE.md/docs between the audit and the deploy. Reason: the audit must cover the final HEAD.
