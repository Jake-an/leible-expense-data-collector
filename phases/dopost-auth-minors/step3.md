# Step 3: poster-token-degradation

## Requirements Covered

- `PRD-9` — weeks_verified_empty ingest is token-gated: the shopSpend poster sends the token
  from `GAS_READ_TOKEN` and degrades non-destructively (drops the field, warns, keeps pulling)
  when the token is unresolvable. This step is the **poster half**; step 0 is the GAS half.

This is *why* this step exists. If the Task section below appears to contradict the requirement
above, `docs/ADR.md`, or a CRITICAL rule in CLAUDE.md, do NOT resolve the conflict yourself and do
NOT proceed on your best guess — set `"status": "needs_context"` with the contradiction spelled out
in `needs_context_detail`, and stop.

## Files to Read

- `connectors/shopspend/ingest.py` — `post_pull` (lines 103-227): `_send_declared` at 164-179
  attaches `weeks_verified_empty` at 176-178 (the ONLY site that sends the field); the
  pull-marker `final_payload` at 220-227; `_send` raises `IngestFailed` on any non-ok body
  (84-85) — this is why an `unauthorized` mid-stream would strand a partial pull
- `connectors/shopspend/client.py` — lines 247-249: the `bc.get_credential("GAS_READ_TOKEN")`
  pattern (this step REUSES the same credential name; note client.py RAISES on missing — this
  step must NOT, see Task)
- `connectors/shopspend/runner.py` — how `post_pull` is called with `weeks_verified_empty` and
  how the `pull` dict is built (find `_build_pull` / the `pull` construction and its
  `diagnostics_json` / warnings channel — the degradation flag must land somewhere the
  pull-marker row records)
- `connectors/shopspend/test_ingest.py` — existing `post_pull` tests (how `_send`/requests are
  mocked, how payloads are captured — mirror those patterns)
- Step 0's diff on this branch — the GAS contract the token must satisfy

Read the code and understand the design intent before starting.

## Task

After step 0 deploys, GAS rejects any payload carrying `weeks_verified_empty` without a valid
token. The poster must therefore (1) send the token on exactly those payloads, and (2) never
let a missing token destroy a pull.

### 1. Attach the token where the field is attached

In `post_pull`, resolve the token ONCE, before the first POST, via
`bc.get_credential("GAS_READ_TOKEN")` (same credential the read path uses —
`client.py:247`). In `_send_declared`, whenever `chunk_verified` is attached
(`ingest.py:176-178`), also attach `payload["token"] = token`. Payloads that do not carry
`weeks_verified_empty` — undeclared/split-week chunks, the tokenless-branch chunks, the
pull-marker `final_payload` — never carry a token.

### 2. Non-destructive degradation when the token is unresolvable

If `weeks_verified_empty` is non-empty but `bc.get_credential("GAS_READ_TOKEN")` returns
nothing: do NOT raise (client.py raises for reads; the write path must not — an exception here,
or an `unauthorized` from GAS mid-stream, aborts after earlier chunks wrote, leaving partial
data and no pull marker, per `_send` at `ingest.py:84-85` and the marker at 220-227). Instead:

- drop `weeks_verified_empty` from EVERY chunk (empty the verified set before chunking),
- print ONE stderr warning:
  `[shopspend] WARNING: GAS_READ_TOKEN not set — weeks_verified_empty dropped, tombstone bypass skipped`,
- continue the pull unchanged: all row chunks, `weeks_complete` declarations, and the
  pull marker still post (tokenless — GAS accepts them without a token).

This mirrors the existing "no declaration = no tombstone" posture: losing the token loses
tombstone-bypass, never data.

- If there are no verified-empty weeks to send, do not warn about a missing token at all —
  nothing was dropped.

### 3. Degraded state must be machine-visible, not stderr-only

The Monday 05:00 Scheduled Task may not capture stderr, so a token outage must not be
invisible-but-successful forever. Record the degradation in the pull marker so the stored pull
row carries it: add it to the `pull` dict's existing diagnostics/warnings channel (see
`runner.py`'s pull construction — prefer the channel the `ShopSpend Report` already surfaces,
the same way `tombstonesSkipped` is surfaced; do NOT invent a new GAS-side column or change any
GAS code). A reader of the `ShopSpendPulls` row must be able to see that verified-empty
declarations were dropped for lack of a token.

### Test First (TDD step)

1. Write the failing test(s) for the cases below *before* any implementation.
2. Confirm the test fails (red) for the right reason.
3. Implement the minimum to pass (green), then refactor while keeping tests green.

Test cases (defined at design time — these are "done"). Mock the HTTP layer and
`bc.get_credential`; capture every payload sent:

- token resolvable + verified-empty weeks → `payload["token"]` present on exactly the chunks
  that carry `weeks_verified_empty`; absent from chunks without the field; absent from the
  pull-marker payload
- token resolvable + NO verified-empty weeks → no payload carries a token
- token unresolvable (`get_credential` → `None`) + verified-empty weeks → NO payload carries
  `weeks_verified_empty` or `token`; every expected POST still happens INCLUDING the pull
  marker (no exception, no partial send); exactly one stderr WARNING naming `GAS_READ_TOKEN`
- token unresolvable + no verified-empty weeks → no warning at all
- degraded run → the pull-marker payload's `pull` dict records the degradation in its
  diagnostics/warnings channel; a healthy run's does not
- the token value never appears on stdout or stderr in any of the above (assert against the
  captured streams using an obvious fake like `"test-token"`)

## Acceptance Criteria

```bash
pytest connectors/shopspend -q       # all tests pass, including the cases above
bash scripts/lint.sh                 # ruff clean
```

## Verification Procedure

1. Run the AC commands above.
2. Confirm by reading the diff: the token is resolved once, attached only alongside
   `weeks_verified_empty`, and no code path prints or logs its value.
3. Update this step in `phases/dopost-auth-minors/index.json`:
   - Success → `"status": "completed"`, `"summary": "one-line summary of output"`
   - Failure after 3 retry attempts → `"status": "error"`, `"error_message": "specific details"`
   - User intervention required → `"status": "blocked"`, `"blocked_reason": "specific reason"`,
     then stop immediately

## Prohibitions

- **Do NOT run any deploy command in this step.** Reason: both halves ship together after the
  phase-end gate (see step 0's embargo rationale).
- Do not raise when the token is missing. Reason: the write path degrades non-destructively by
  design — raising (or letting GAS's `unauthorized` raise via `IngestFailed`) strands a partial
  pull with no marker, the exact failure this design exists to avoid.
- Do not attach the token to payloads that lack `weeks_verified_empty`. Reason: minimizing
  secret spread was part of the approved design; tokenless payloads must keep working tokenless
  (that is the no-lockstep guarantee for every other connector).
- Do not read the token from anywhere but `bc.get_credential("GAS_READ_TOKEN")`. Reason: `.env`
  var `GAS_READ_TOKEN` deliberately pairs with GAS property `API_READ_TOKEN` — do not invent a
  new env var name.
- Do not print, log, or embed a real token; test fixtures use obvious fakes. Reason: secrets
  stay out of the repo and out of output (CLAUDE.md Absolute Rule).
- Do not touch any GAS file. Reason: single-runtime (Python) step; step 0 owns the GAS half.
- Do not break existing tests.
