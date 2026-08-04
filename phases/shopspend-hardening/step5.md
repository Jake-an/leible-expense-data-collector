# Step 5: client-redaction-hardening

## Requirements Covered

- `PRD-7` — shopSpend ingest: "typed Python client for the external `shopSpend` JSON API". A client
  that leaks its own API token into an exception message or a log line fails the project's absolute
  rule that secrets stay out of chat and out of the repo.

This is *why* this step exists. If the Task section below appears to contradict the requirement
above, `docs/ADR.md`, or a CRITICAL rule in CLAUDE.md, do NOT resolve the conflict yourself and do
NOT proceed on your best guess — set `"status": "needs_context"` with the contradiction spelled out
in `needs_context_detail`, and stop.

## Files to Read

- `connectors/shopspend/client.py` — `_redact` at lines 51-54; the redacting siblings at lines 166,
  172 and 191; the **unredacted** fatal raise at line 195; every other raising branch
- `connectors/shopspend/test_client.py` — existing redaction tests
- `docs/rules.md` — the secrets rules

Read the code and understand the design intent before starting.

## Task

### Defect I2 — the fatal path does not redact

`client.py:195`:

```python
raise ShopSpendError(code=error_code, detail=detail)
```

Every sibling error path redacts (`self._redact(...)` at 166, 172, 191); this one does not. Add the
same redaction here.

### Defect I3 — `_redact` is substring-only

`_redact` (lines 51-54) does a plain `text.replace(token, "***")`. But `resp.url` carries the token
**percent-encoded**, so a token containing `+`, `/` or `=` appears in a different form and survives
redaction untouched.

Redact the percent-encoded form of the token as well as the raw form.

### Also: stop echoing the raw body on the fatal path

The fatal path echoes `resp.text[:200]`. A token can be bisected mid-string by that slice, and
redaction cannot catch a fragment. Stop echoing the raw body there.

### Test First (TDD step)

1. Write the failing test(s) for the cases below *before* any implementation. Use the
   `ecc:tdd-guide` agent to drive the red-green-refactor loop.
2. Confirm the test fails (red) for the right reason.
3. Implement the minimum to pass (green), then refactor while keeping tests green.

**Build the expected URL in tests with `requests.Request(...).prepare().url`.** A hand-rolled
`quote()` may use a different safe set than the URL under test and would prove nothing.

Test cases (defined at design time — these are "done"):

- a fatal `UNAUTHORIZED` whose `detail` echoes the token does **not** leak it
- a token containing `+`, `/` and `=` is redacted from a `resp.url` that carries it
  percent-encoded — expected URL built via `prepare()`
- a URL-safe token still redacts — no regression
- the raw body is **not** echoed on the fatal path
- redaction is asserted across **every** raising branch by parametrization, so a future branch that
  forgets to redact fails this suite

## Acceptance Criteria

```bash
python -m pytest connectors/shopspend -q     # all tests pass, including the cases above
ruff check connectors/shopspend               # clean
```

## Verification Procedure

1. Run the AC commands above.
2. Check the architecture checklist:
   - Does it not violate the CRITICAL rules in CLAUDE.md, in particular "secrets stay out of chat
     and out of the repo"?
3. Update this step in `phases/shopspend-hardening/index.json`:
   - Success → `"status": "completed"`, `"summary": "one-line summary of output"`
   - Failure after 3 retry attempts → `"status": "error"`, `"error_message": "specific details"`
   - User intervention required → `"status": "blocked"`, `"blocked_reason": "specific reason"`,
     then stop immediately

## Prohibitions

- **Never put a real token in a test fixture, a log line, or a commit.** Reason: absolute project
  rule — no credentials in the repo. Use an obviously-fake token literal.
- Do not build the expected percent-encoded URL by hand with `quote()`. Reason: a different safe
  set than the code under test makes the assertion vacuous. Use `requests.Request(...).prepare().url`.
- **Do NOT run `bash scripts/deploy.sh`, `clasp push`, `clasp deploy`, or any other deploy command
  in this step.** Reason: the phase is under a deploy embargo until its phase-end review gate
  passes AND the branch is merged to `feat-shopspend`.
- Do not touch any GAS/JS file in this step. Reason: single-runtime (Python) step; its `test_cmd`
  is pytest-only and would not exercise a GAS change.
- Do not break existing tests.
