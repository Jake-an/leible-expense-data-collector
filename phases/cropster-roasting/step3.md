# Step 3: connector

## Requirements Covered

- `PRD-25` - Cropster Playwright connector (session, header capture, explicit per-week fetch, reconciliation, post).

This is *why* this step exists. If the Task section below appears to contradict the
requirement above, `docs/ADR.md`, or a CRITICAL rule in CLAUDE.md, do NOT resolve the
conflict yourself - set `"status": "needs_context"` with the contradiction spelled out
in `needs_context_detail`, and stop.

## Files to Read

- `C:/Users/mioja/.claude/plans/cropster-roasting.md`, `phases/cropster-roasting/contract.md` (**the endpoint/field contract; follow it exactly**).
- `connectors/playwright/base_connector.py` (`BaseConnector` `:223`, `get_credential` `:102`, `_form_login` `:154`, `_attended_login` `:462`, `post` `:562`, `_check_totals` `:527`, `cli_main` `:636`).
- `connectors/playwright/food_dairy_co.py` (subclass pattern), `connectors/playwright/test_base_connector.py` (test/stub pattern).

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

**A. `base_connector.py` (minimal, behaviour-preserving):**
- class attr `KIND = None`: when set, `post` adds `"kind": KIND` to the payload.
- classmethod `validate_rows(cls, rows)`: the default calls the existing `_check_totals` logic; `post` calls `self.validate_rows(rows)` where it called `_check_totals`.
- optional `extra_payload()`: returns `{}` by default; merged into the payload (used for `allow_shrink`).
- one **LOCKED retry**: if the response JSON `code == 'LOCKED'`, sleep 60s (injectable for tests) and re-post once.
- The default suppliers payload must stay byte-identical.

**B. `connectors/playwright/cropster.py`:**
- `NAME='cropster'`, `SOURCE='cropster'`, `KIND='roasting'`, `LOGIN_URL='https://c-sar.cropster.com/apps/roast/production-report'`.
- `is_logged_in(page)`: true only when the report page loaded AND a `productionSummaries` response returned 200 (presence of a cookie is not validity).
- Credentials-login via `_form_login` with `CROPSTER_EMAIL`/`CROPSTER_PASSWORD`.
- Pure helpers (unit-tested, no browser):
  - `sydney_week_bounds(monday_date)` → `(from_ms, to_ms)` using `zoneinfo('Australia/Sydney')`: Monday 00:00:00.000 to Sunday 23:59:59.999.
  - `weeks_to_pull(now_sydney, n)` → the n most recent **completed** Mon–Sun weeks, oldest first. The current, in-progress week is never included.
  - `summaries_url(from_ms, to_ms, group)` per the contract.
  - `parse_and_reconcile(week_start, profile_json, machine_json, names, requested_from_ms, requested_to_ms, response_url)` → rows in the row contract, or raises `ReconcileError`. It checks:
    - unit `KG` and `amount==amountSI`
    - required fields present
    - the range params in `response_url` equal the requested ones
    - Σ PROFILE `endWeight` vs Σ MACHINE within 0.1, and batches equal
    - every profile id resolves to a name
  - loss = `round(100*(1-end/start),2)`, `None` when start == 0. Profiles with 0 batches and 0 weight are skipped.
- Browser flow `read_weeks(page, weeks)`:
  1. Navigate to `LOGIN_URL?dateFrom=..&dateTo=..` for the first week with `page.expect_request` on `productionSummaries`, and keep `request.all_headers()` minus cookie/host/content-length **in memory only**.
  2. For each week, `page.request.get` the PROFILE and MACHINE URLs plus `/api/v2/profiles/<ids>` with those headers, then call `parse_and_reconcile`.
  3. Any exception → abort the whole run: post nothing, exit non-zero.
  4. **Never log or print header values, cookies, or response bodies.** Log per week only `week_start, n_profiles, ok`.
- CLI: reuse `cli_main` flags plus `--backfill` (n=12, default 2) and `--allow-shrink` (only valid with `--backfill`; sets `allow_shrink:true` via `extra_payload`). `--dry-run` prints the per-week summary and posts nothing. Exit 2 on `BlockedError`, as in the base.
- `validate_rows` override: check the row contract shape locally (keys, `date==week_start`, numeric types). No `total`.

### Test First (TDD step)

Write these tests BEFORE the implementation. Confirm RED for the right reason (function undefined / wrong value - not a syntax error), then implement to GREEN, then refactor. The enumerated cases are the definition of done.

Create `connectors/playwright/test_cropster.py`. Use synthetic JSON fixtures shaped exactly like contract.md: invented profile ids/names and round dummy numbers, **no real figures**. Stub creds via monkeypatch and isolate `.env`.
- **Week math:**
  - `sydney_week_bounds` on an AEDT week, an AEST week, and a week containing the DST switch (first Sunday of Oct / first Sunday of Apr): to−from+1 equals the real elapsed ms
  - run on Mon 05:30 Sydney → the newest week is the previous Mon–Sun
  - run on Sunday 23:00 → the current week is excluded
  - n=2 vs n=12 counts and ordering
- **URL:** `summaries_url` has the encoded bracket params and the group.
- **Parse/reconcile:**
  - happy path → exact rows (contract keys, `date==week_start`, loss computed, `start==0` → `None`)
  - missing `endWeight` → raises
  - unit `LBS` → raises
  - response_url range ≠ requested → raises
  - PROFILE Σ ≠ MACHINE Σ (kg) → raises; batches mismatch → raises
  - an unresolved profile id → raises
  - empty `data` on both groupings → zero rows, no error
- **Base hooks:**
  - existing `test_base_connector.py` stays green
  - a new test shows the default connector's payload is byte-identical to before (no `kind`, totals still checked)
  - a `KIND`-set connector payload has `kind`
  - LOCKED → exactly one retry (sleep stubbed); 2× LOCKED → error
- **Connector:**
  - `validate_rows` rejects a row with `total` or with `date≠week_start`
  - `--dry-run` never calls post
  - `--allow-shrink` without `--backfill` → usage error
  - a log-capture test proves no header value or cookie string appears in output (feed a fake header `Cropster-Authenticate: dummy-secret-xyz` and assert the string is absent from caplog/stdout)

## Acceptance Criteria

```bash
python -m pytest connectors/playwright -q
python -m pytest connectors/playwright/test_cropster.py -q
```

All pre-existing tests stay green plus every new case. Report the final pass counts.

## Verification Procedure

1. Run the AC and record the counts (baseline 99).
2. Mutation: disable the MACHINE reconciliation → the mismatch test goes red; restore.
3. `grep -rn "print(.*header\|log.*header" connectors/playwright/cropster.py` → nothing logs header values.
4. Update this step in `index.json`.
5. No live run in this step: credentials may not be present yet. The live run is step 5.

## Prohibitions

- Do not break existing tests. Reason: run the FULL suites (memory `cross-step-test-anchor-conflict`).
- Do not commit credentials, tokens, cookies, header values, PII or real Cropster figures into code, tests, fixtures or phase files. Reason: Absolute Rule; fixtures are synthetic.
- Do not deploy, push, register scheduled tasks or touch Script Properties unless this step says so. Reason: deploy is step 5; push is "lets stop here".
- Do not create a new GAS project/deployment. Reason: one project, one deployment.
- Do not write to any Sheet tab from the Python connector. Reason: two-runtime boundary.
- Do not bypass MFA/CAPTCHA. Reason: Absolute Rule — on a challenge, raise `BlockedError`.
- Do not persist captured headers to disk. Reason: they are session credentials.
