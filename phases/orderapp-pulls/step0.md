# Step 0: orderapp-config-and-fetch

## Requirements Covered

- `PRD-10` — Shopify online weekly revenue via Order-app read API (this step builds the shared fetch/auth/failure plumbing it runs on)
- `PRD-11` — Green bean committed spend via Order-app read API (same shared plumbing)

This is *why* this step exists. If the Task section below appears to contradict the
requirement above, `docs/ADR.md`, or a CRITICAL rule in CLAUDE.md, do NOT resolve the
conflict yourself and do NOT proceed on your best guess — set
`"status": "needs_context"` with the contradiction spelled out in
`needs_context_detail`, and stop.

## Files to Read

- `connectors/gas/Code.gs` lines 1–140 (constants, `withScriptLock_` at :104) and `labourWeeklyPull_` at :645 (the skip-safe-when-property-unset precedent)
- `connectors/gas/staleness.gs` (heartbeat API: `stalenessStampHeartbeat_`; read the file header comment for why silent feed death is the enemy)
- `connectors/gas/test_code.js` lines 250–340 (mock bootstrap, `load(...)` lines) and lines 1031–1120 (the `global.UrlFetchApp` swap pattern to reuse in your tests)

## Task

Create **`connectors/gas/orderapp.gs`** — the shared plumbing for two new GAS-side pulls
that read the LEIBLE_Order_app's token-gated JSON APIs via `UrlFetchApp`. Header comment:
these pulls live in GAS (not a Python connector) because they need the hub's internal
upsert helpers and Google-side scheduling; the doPost boundary is for external connectors.

Constants:

```js
var ORDER_APP_EXEC_URL = 'https://script.google.com/macros/s/AKfycbwuLSrcyi-e0dLyjEP4-unU5CLCywm6-SRFhSOq_Cufdn0MnvY0MtP4zNvGj20Dy4S9RQ/exec'; // PROD, not a secret
var ORDER_APP_TOKEN_PROP = 'ORDER_APP_COST_TOKEN'; // Script Property; value = Order app's COST_API_TOKEN. Jake pastes it manually. NEVER in repo/logs.
```

Functions (signature level — implementation is yours):

- `getOrderAppToken_() → string|null` — reads the Script Property; null/blank → log
  `'orderapp: ORDER_APP_COST_TOKEN not set — skipping'` and return null (skip-safe,
  labour precedent).
- `orderAppBuildUrl_(execUrl, params) → string` — pure; appends each key=value with
  `encodeURIComponent` on values.
- `orderAppClassifyResponse_(httpCode, bodyText) → {ok:true, body} | {ok:false, reason}` —
  pure. Reasons: `'http-<code>'` for non-200; `'parse'` when bodyText is not JSON (an
  expired /exec deployment serves an HTML login page — this must classify, not throw);
  `'api:<ERROR>'` when parsed body has `ok !== true` (Order app returns HTTP 200 always;
  its error bodies carry `error` ∈ UNAUTHORIZED | BAD_REQUEST | UPSTREAM | SCHEMA |
  INTERNAL and sometimes `traceId` — include `error` in the reason and log the body
  verbatim including traceId, but NEVER log the token).
- `orderAppFetch_(params) → same shape` — thin: token (null → `{ok:false, reason:'no-token'}`,
  zero fetches), `UrlFetchApp.fetch(url, {muteHttpExceptions:true})` inside try/catch
  (a thrown fetch → `{ok:false, reason:'http-exception'}`), then classify.

Failure accounting (fail-open — an uncaught throw or 6-minute timeout must still count):

- `orderAppRunStart_(source) → void` — increments Script Property
  `ORDERAPP_FAILCOUNT_<source>` (missing → treat as 0) **and is called before lock
  acquisition** by the pulls (steps 2/4), so a lock-timeout skip counts. If the
  incremented value is ≥ 2, raise the alert (below) once.
- `orderAppRunSuccess_(source) → void` — resets the counter to 0 and calls
  `stalenessStampHeartbeat_(source)`. Called ONLY on full success. If an alert was
  raised earlier in this same execution, log `'orderapp: <source> recovered'`.
- `orderAppRaiseAlert_(source, count) → void` — creates an orange Calendar event using
  the same calendar mechanism as staleness.gs (read how `stalenessRaiseAlerts_` obtains
  the calendar and reuse that acquisition), but with a **purpose-built title/body**:
  title `'LEIBLE expense orderapp: previous <source> run did not complete'`; body says
  this run is retrying and lists what to check: the GAS time trigger, the
  `ORDER_APP_COST_TOKEN` Script Property, and the Order app /exec URL (deployment may
  have changed). Do NOT reuse `stalenessRaiseAlerts_`'s body builder — it renders
  age-hours fields that are undefined here and points at Windows Task Scheduler /
  Playwright re-auth, which do not apply. Never throws (wrap in try/catch like the
  staleness alert path). Source tokens contain no colons.

Wire `load('orderapp.gs')` into `connectors/gas/test_code.js` next to the existing
`load('shopify.gs')` line (~:331). Property/calendar/UrlFetchApp access in tests uses
the existing mocks; follow the save/restore pattern at test_code.js:1031–1120 so fakes
never leak into later suites.

### Test First (TDD step)

1. Write the failing tests for the cases below *before* any implementation.
2. Confirm RED for the right reason (missing symbols/assertions — the runner classifies this).
3. Implement the minimum to pass, then refactor while green.

Test cases (defined at design time — these are "done"):
- token property unset → `orderAppFetch_` returns `{ok:false, reason:'no-token'}` and `UrlFetchApp.fetch` is called **zero** times
- HTTP 200 + `{"ok":true,...}` → `{ok:true, body}` passes the parsed body through
- HTTP 200 + `{"ok":false,"error":"UNAUTHORIZED"}` → reason `'api:UNAUTHORIZED'`
- HTTP 500 → reason `'http-500'`
- HTTP 200 + `<html>...login...</html>` → reason `'parse'` (no throw)
- `orderAppBuildUrl_` percent-encodes `&`, space, and `+` in param values
- `orderAppRunStart_` ×1 then `orderAppRunSuccess_` → counter property is `0`, heartbeat stamped once
- `orderAppRunStart_` ×2 with no success between → exactly ONE alert event created, on the second call only (none on the first)
- fail-then-success sequence (`start`, no success; `start` → alert; then success) → alert title/body contain "did not complete" + "retrying" wording, body names trigger/token/URL (assert it does NOT mention Task Scheduler), counter ends at `0`, `'recovered'` logged
- simulated crash: `orderAppRunStart_` called, then nothing → counter property remains `1`, no heartbeat stamped (this is the fail-open guarantee)
- alert calendar throwing → `orderAppRaiseAlert_` does not throw out

## Acceptance Criteria

```bash
node connectors/gas/test_code.js   # all suites green, including every case above
```

## Verification Procedure

1. Run the AC command.
2. Architecture checklist: two-runtime boundary respected (this file only reads the
   Order app API and hub properties — no Sheet writes in this step); no secret values
   in code, logs, or test fixtures; CLAUDE.md CRITICAL rules intact.
3. Update this step in `phases/orderapp-pulls/index.json` per the six-state vocabulary.

## Prohibitions

- Do not log, echo, or fixture the real token value anywhere. Reason: secrets stay out of chat/repo (CLAUDE.md Absolute Rule).
- Do not write to any Sheet tab in this step. Reason: writes belong to steps 2/4 via the existing upsert helpers.
- Do not reuse `stalenessRaiseAlerts_`'s event body. Reason: it renders undefined age fields and misdirecting remediation steps for this failure class.
- Do not use `Date.now()`-free logic that depends on `toISOString()` for any date math. Reason: AEST off-by-one (documented project gotcha).
- Do not break existing tests.
