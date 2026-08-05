# Step 0: dopost-token-gate

## Requirements Covered

- `PRD-9` — weeks_verified_empty ingest is token-gated: a `doPost` payload carrying
  `weeks_verified_empty` (the breaker-bypass field) must present the shared `API_READ_TOKEN`.
  Writes cannot bypass the blast-radius breaker anonymously. This step is the **GAS half**;
  step 3 is the poster half.

This is *why* this step exists. If the Task section below appears to contradict the requirement
above, `docs/ADR.md`, or a CRITICAL rule in CLAUDE.md, do NOT resolve the conflict yourself and do
NOT proceed on your best guess — set `"status": "needs_context"` with the contradiction spelled out
in `needs_context_detail`, and stop.

## Files to Read

- `connectors/gas/Code.gs` — `doPost` at lines 140-193 (the gate lands between the `JSON.parse`
  at 142 and the `validateIngest_` call at 143); `checkReadToken_` at lines 1471-1477 (the
  fail-closed token check you will REUSE, not duplicate); `validateIngest_` at 220-250 (do not
  modify it — the token check does NOT belong there, it is pure and PropertiesService-free)
- `connectors/gas/test_code.js` — `doPostJson` helper at ~354-357; the PropertiesService mock and
  the `scriptProps` global at ~166-172; existing doGet unauthorized tests (search
  "coverage path: missing token") for the response-shape convention
- `docs/api.md` — the doPost contract and the mass-absence remediation section (~164-181); you
  change no docs in this step (step 4 owns docs), but you must not contradict them

Read the code and understand the design intent before starting.

## Task

`appsscript.json` deploys the web app `access: ANYONE_ANONYMOUS`. `doGet` is token-gated;
`doPost` is not — and since the hardening phase, a single anonymous POST of
`{"rows":[],"weeks_complete":["2026-W31"],"weeks_verified_empty":["2026-W31"]}` zeroes every
present shop-week in that week (the field's purpose is to bypass the blast-radius breaker).
Jake's decision (**fixed, do not reopen**): gate ONLY payloads carrying `weeks_verified_empty`,
reusing the existing `API_READ_TOKEN` script property. All other payloads stay tokenless —
suppliers, revenue, Square, and plain shopspend row/`weeks_complete` POSTs are unaffected.

In `doPost` (`Code.gs:140`), immediately after the `JSON.parse` line and BEFORE the
`validateIngest_` call, add:

```js
if (body && body.weeks_verified_empty !== undefined) {
  var auth = checkReadToken_({ token: body.token });
  if (!auth.ok) return jsonOut_({ result: 'error', message: 'unauthorized' });
}
```

Core rules that must not deviate:

- **Presence-gated, not content-gated.** `weeks_verified_empty: []` still requires the token.
  The gate keys on `!== undefined`, never on array length or validity.
- **Auth precedes validation.** A payload with a malformed `weeks_verified_empty` and no token
  gets `unauthorized`, not a validation message — an anonymous caller learns nothing about the
  field's grammar.
- **Reuse `checkReadToken_` verbatim** — it is fail-closed (property unset → unauthorized) and
  already tested. Do not write a second token comparator.
- **The token travels in the JSON body** (`body.token`), never in the URL or query string —
  GAS logs query strings.
- The response shape mirrors the doGet unauthorized convention exactly:
  `{ result: 'error', message: 'unauthorized' }`. No `code`, no `retryable`.

### Test First (TDD step)

1. Write the failing test(s) for the cases below *before* any implementation.
2. Confirm the test fails (red) for the right reason.
3. Implement the minimum to pass (green), then refactor while keeping tests green.

**Mock hygiene (mandatory):** `scriptProps` in `test_code.js` is a shared mutable global and
`doPostJson` does not reset it. Every case below must set `scriptProps` explicitly at its start
(including `scriptProps = {}` for the unset case) and restore the prior value afterwards —
otherwise a later suite's `API_READ_TOKEN` makes an `unauthorized` assertion pass for the wrong
reason.

Test cases (defined at design time — these are "done"). All shopspend payloads carry the
required base fields (`source`, `kind: 'shopspend'`, `rows`, `extracted_at`):

- `weeks_verified_empty` present, no `token` field → `result: 'error'`, `message: 'unauthorized'`
- `weeks_verified_empty` present, wrong token → `unauthorized`
- `weeks_verified_empty` present, correct token (matching `scriptProps.API_READ_TOKEN`) →
  processing proceeds: response is the normal shopspend shape (`result: 'ok'`,
  `tombstonesWritten`/`tombstonesSkipped` present)
- `weeks_verified_empty: []` (present but empty), no token → `unauthorized` (presence-gated)
- field **absent**, no token, `kind: 'shopspend'` with rows + `weeks_complete` → processed
  normally (no lockstep break for existing payload shapes)
- field absent, no token, `kind: 'suppliers'` → processed normally
- `scriptProps = {}` (property unset), field present, any token → `unauthorized` (fail-closed)
- auth-before-validation: `weeks_verified_empty` as a JSON **string** (invalid type), no token →
  `unauthorized`, NOT `invalid weeks_verified_empty`
- same invalid payload WITH the correct token → the validation error (proves the gate passes
  through to validation, in that order)

## Acceptance Criteria

```bash
node connectors/gas/test_code.js     # all tests pass, including the cases above
```

## Verification Procedure

1. Run the AC command above.
2. Check the architecture checklist:
   - All ingest still flows through `doPost` → `validateIngest_` (CLAUDE.md CRITICAL).
   - `validateIngest_` is unchanged (still pure).
   - No secret value appears in any test, fixture, or log — test tokens are obvious fakes
     (e.g. `'test-token'`).
3. Update this step in `phases/dopost-auth-minors/index.json`:
   - Success → `"status": "completed"`, `"summary": "one-line summary of output"`
   - Failure after 3 retry attempts → `"status": "error"`, `"error_message": "specific details"`
   - User intervention required → `"status": "blocked"`, `"blocked_reason": "specific reason"`,
     then stop immediately

## Prohibitions

- **Do NOT run `bash scripts/deploy.sh`, `clasp push`, `clasp deploy`, or any deploy command in
  this step.** Reason: the GAS gate and the poster's token (step 3) ship together after the
  phase-end gate; deploying now would make the CURRENT poster's `weeks_verified_empty` chunks
  fail `unauthorized` mid-pull. This overrides CLAUDE.md's "deploy when GAS coding is finished"
  rule for this phase only — the controller deploys post-phase.
- Do not gate any payload that lacks `weeks_verified_empty`. Reason: option (b) — gating all of
  doPost — was explicitly rejected by Jake; it breaks every connector in lockstep.
- Do not add the token check to `validateIngest_`. Reason: it is pure and unit-tested without
  PropertiesService; the gate belongs in `doPost` beside the other I/O.
- Do not read the token from `e.parameter` / query string. Reason: GAS logs query strings;
  body-only.
- Do not touch any Python file in this step. Reason: single-runtime (GAS) step; step 3 owns the
  poster.
- Do not put a real token value anywhere — tests, comments, logs. Reason: secrets stay out of
  the repo (CLAUDE.md Absolute Rule).
- Do not break existing tests.
