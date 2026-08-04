# Step 6: pagination-progress-guard

## Requirements Covered

- `PRD-7` — shopSpend ingest: "typed Python client for the external `shopSpend` JSON API". A client
  whose pagination loop can spin forever against a misbehaving API never delivers the ingest.

This is *why* this step exists. If the Task section below appears to contradict the requirement
above, `docs/ADR.md`, or a CRITICAL rule in CLAUDE.md, do NOT resolve the conflict yourself and do
NOT proceed on your best guess — set `"status": "needs_context"` with the contradiction spelled out
in `needs_context_detail`, and stop.

## Files to Read

- `connectors/shopspend/client.py` — the pagination loop at lines 128-134
- `connectors/shopspend/models.py` — `Paging` and `Meta.paging` at line 39
- `connectors/shopspend/test_client.py` — existing pagination tests

Read the code and understand the design intent before starting.

## Task

### The defect (important, I4 from the phase-end review)

`client.py:132-134`:

```python
if offset + returned >= matched:
    break
offset += returned
```

When the API returns `returned: 0` while `matched > 0`, the break condition is false and `offset`
never advances — the loop spins until the 2-hour task limit.

Raise an explicit error instead of looping. The error must name what happened (no progress at a
given offset with a known `matched`) so a real API regression is diagnosable from the message.

### Test First (TDD step)

1. Write the failing test(s) for the cases below *before* any implementation. Use the
   `ecc:tdd-guide` agent to drive the red-green-refactor loop.
2. Confirm the test fails (red) for the right reason.
3. Implement the minimum to pass (green), then refactor while keeping tests green.

Test cases (defined at design time — these are "done"):

- `returned: 0` with `offset < matched` **raises** rather than looping
- a well-formed three-page walk still succeeds
- a final page with `returned: 0` and `offset >= matched` is a **clean finish**, not an error
- `matched: 0` never trips the guard

Write the raising case with a bounded fake transport so a regression fails fast instead of hanging
the suite.

## Acceptance Criteria

```bash
python -m pytest connectors/shopspend -q     # all tests pass, including the cases above
ruff check connectors/shopspend               # clean
```

## Verification Procedure

1. Run the AC commands above.
2. Check the architecture checklist:
   - Does it stay within the tech stack defined in `docs/ADR.md`?
   - Does it not violate the CRITICAL rules in CLAUDE.md?
3. Update this step in `phases/shopspend-hardening/index.json`:
   - Success → `"status": "completed"`, `"summary": "one-line summary of output"`
   - Failure after 3 retry attempts → `"status": "error"`, `"error_message": "specific details"`
   - User intervention required → `"status": "blocked"`, `"blocked_reason": "specific reason"`,
     then stop immediately

## Prohibitions

- Do not "fix" this by adding a fixed iteration cap and silently returning partial rows. Reason:
  silently-partial rows would then be declared complete by step 2's gate only if paging looked
  healthy — but a partial result presented as whole is exactly the failure class this phase exists
  to remove. Raise.
- **Do NOT run `bash scripts/deploy.sh`, `clasp push`, `clasp deploy`, or any other deploy command
  in this step.** Reason: the phase is under a deploy embargo until its phase-end review gate
  passes AND the branch is merged to `feat-shopspend`.
- Do not touch any GAS/JS file in this step. Reason: single-runtime (Python) step; its `test_cmd`
  is pytest-only and would not exercise a GAS change.
- Do not break existing tests.
