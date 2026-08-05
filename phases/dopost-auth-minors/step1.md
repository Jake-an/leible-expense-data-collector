# Step 1: gas-minors

## Requirements Covered

None — approved-phase minors (week-label 01-53 bound + degraded-log wording): hardening of
already-built PRD-7/PRD-8 behavior, no new user-facing requirement.

If the Task section below appears to contradict `docs/ADR.md` or a CRITICAL rule in CLAUDE.md,
do NOT resolve the conflict yourself — set `"status": "needs_context"` with the contradiction
spelled out in `needs_context_detail`, and stop.

## Files to Read

- `connectors/gas/Code.gs` — `isValidWeekLabelArray_` at lines 205-211 (the regex at 208 is the
  target); its doc comment explains why coercion is rejected
- `connectors/gas/shopspend.gs` — the degraded-mode `Logger.log` at line 85
- `connectors/gas/test_code.js` — existing `isValidWeekLabelArray_` / `weeks_complete` validation
  tests (search "weeks_complete as a JSON string")
- Step 0's diff (`git log`/`git diff` on this branch) — the token gate now sits ahead of
  validation; your tests for invalid labels must send the correct test token (or omit
  `weeks_verified_empty`) so they exercise VALIDATION, not the auth gate

Read the code and understand the design intent before starting.

## Task

Two minors carried out of the approved shopspend-hardening phase (recorded in `TODO.md`):

### 1. `isValidWeekLabelArray_` (`Code.gs:208`) — bound the week number to 01-53

The current regex `^\d{4}-W\d{2}$` accepts `2026-W00` and `2026-W54`..`2026-W99`. The Python CLI
already bounds week numbers to 01-53; **GAS is the destructive side** (these labels feed
tombstoning), so the stricter check belongs here too. Replace the regex with one accepting only
`W01`–`W53`, e.g. `^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$`.

Note: `2020-W01` must remain VALID — the post-phase live probes depend on it.

### 2. `shopspend.gs:85` — log wording

The degraded-mode log currently says "tombstoning skipped entirely for this pull". It fires once
per REQUEST, and a chunked pull sends several requests — so it reads far more alarming than it
is. Change "for this pull" to "for this request". Wording change only; the condition, level, and
the rest of the message stay as they are.

### Test First (TDD step)

1. Write the failing test(s) for the cases below *before* any implementation.
2. Confirm the test fails (red) for the right reason.
3. Implement the minimum to pass (green), then refactor while keeping tests green.

Test cases (defined at design time — these are "done"):

- `isValidWeekLabelArray_(['2026-W00'])` → false
- `isValidWeekLabelArray_(['2026-W54'])` → false
- `isValidWeekLabelArray_(['2026-W99'])` → false
- `isValidWeekLabelArray_(['2026-W01'])` → true (lower bound)
- `isValidWeekLabelArray_(['2026-W53'])` → true (upper bound — ISO years can have 53 weeks)
- `isValidWeekLabelArray_(['2020-W01'])` → true (the live-probe label)
- `validateIngest_` rejects a shopspend payload with `weeks_complete: ['2026-W00']`
  (message `invalid weeks_complete`)
- all existing valid-label tests (`2026-W31` etc.) still pass unchanged

(The `shopspend.gs:85` wording change is not unit-testable — `Logger.log` output is not
asserted by the suite. It is verified by grep in the Verification Procedure.)

## Acceptance Criteria

```bash
node connectors/gas/test_code.js     # all tests pass, including the cases above
grep -n "for this request" connectors/gas/shopspend.gs    # the reworded log
```

## Verification Procedure

1. Run the AC commands above; confirm the grep hits line ~85 and
   `grep -n "for this pull" connectors/gas/shopspend.gs` finds nothing.
2. Update this step in `phases/dopost-auth-minors/index.json`:
   - Success → `"status": "completed"`, `"summary": "one-line summary of output"`
   - Failure after 3 retry attempts → `"status": "error"`, `"error_message": "specific details"`
   - User intervention required → `"status": "blocked"`, `"blocked_reason": "specific reason"`,
     then stop immediately

## Prohibitions

- **Do NOT run any deploy command in this step.** Reason: the phase ships as one unit after the
  phase-end gate (see step 0's embargo rationale).
- Do not loosen the regex to accept W00 or W54+ "for compatibility". Reason: no valid ISO week
  label has those numbers; accepting them is the defect being fixed.
- Do not change anything else about `shopspend.gs:85`'s condition or surrounding logic. Reason:
  wording-only minor; behavior changes belong to no step in this phase.
- Do not touch any Python file. Reason: single-runtime (GAS) step; the Python side's 01-53 bound
  already exists.
- Do not break existing tests.
