# Step 2: truncated-warning

## Requirements Covered

None — approved-phase minor: stderr WARNING parity on an existing zero-declare branch, no new
user-facing requirement.

If the Task section below appears to contradict `docs/ADR.md` or a CRITICAL rule in CLAUDE.md,
do NOT resolve the conflict yourself — set `"status": "needs_context"` with the contradiction
spelled out in `needs_context_detail`, and stop.

## Files to Read

- `connectors/shopspend/runner.py` — `compute_weeks_complete` at lines 66-115: the
  `paging.truncated` branch at 98-99 is the target; its five sibling zero-declare branches
  (e.g. `paging is None` at 91-96, `matched == 0` at 109-111) each print a
  `[shopspend] WARNING: ... — zero weeks declared` line to stderr
- `connectors/shopspend/test_runner.py` — existing `compute_weeks_complete` tests (how the
  response/paging fixtures are built, how stderr is asserted — mirror those patterns)

Read the code and understand the design intent before starting.

## Task

`compute_weeks_complete`'s `paging.truncated` branch is the ONLY zero-declare path that returns
without printing a `WARNING`. A truncated response therefore disables tombstoning silently — the
run looks healthy while absence assessment quietly stopped. Add a stderr warning mirroring the
siblings' exact format, e.g.:

```python
if paging.truncated:
    print(
        "[shopspend] WARNING: response paging truncated — zero weeks declared",
        file=sys.stderr,
    )
    return [], []
```

Core rules that must not deviate:

- The branch still returns `([], [])` — the WARNING is additive; declaring weeks from a
  truncated response would re-open the completeness-gate hole.
- The message starts with `[shopspend] WARNING:` and ends with `— zero weeks declared`,
  matching its siblings, so log-grepping for either pattern catches all six branches.
- stderr, not stdout — same as every sibling.

### Test First (TDD step)

1. Write the failing test(s) for the cases below *before* any implementation.
2. Confirm the test fails (red) for the right reason.
3. Implement the minimum to pass (green), then refactor while keeping tests green.

Test cases (defined at design time — these are "done"):

- a response with `paging.truncated == True` → returns `([], [])` AND stderr (capsys) contains
  `[shopspend] WARNING:` and `truncated` and `zero weeks declared`
- the truncated warning goes to stderr, not stdout (capsys `out` does not contain it)
- a non-truncated, fully-matched response still declares its weeks with NO truncated warning
  (existing behavior unchanged)

## Acceptance Criteria

```bash
pytest connectors/shopspend -q       # all tests pass, including the cases above
bash scripts/lint.sh                 # ruff clean
```

## Verification Procedure

1. Run the AC commands above.
2. Update this step in `phases/dopost-auth-minors/index.json`:
   - Success → `"status": "completed"`, `"summary": "one-line summary of output"`
   - Failure after 3 retry attempts → `"status": "error"`, `"error_message": "specific details"`
   - User intervention required → `"status": "blocked"`, `"blocked_reason": "specific reason"`,
     then stop immediately

## Prohibitions

- Do not change the branch's return value or its position in the check ordering. Reason: the
  zero-declare behavior is correct and reviewed; only its silence is the defect.
- Do not touch any GAS file. Reason: single-runtime (Python) step; its `test_cmd` is pytest-only
  and would not exercise a GAS change.
- Do not break existing tests.
