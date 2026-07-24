# Step 0: ingest-error-raise

## Files to Read

First, read these to understand the design intent before touching code:

- `/docs/ARCHITECTURE.md` — the **two-runtime, one-boundary** design: a Playwright connector ONLY logs in, downloads raw rows, and POSTs to the GAS `doPost` ingest endpoint. It must never treat a rejected ingest as success.
- `/docs/schema.md` — the two-tab contract and the `doPost` response shape.
- `connectors/playwright/base_connector.py` — the file you will modify. Read `post()` (currently lines ~341-355), `run()` (~242-279), and the existing exception classes `BlockedError` (~185) and `TransientLoginError` (~189).

## Background (the bug)

`doPost` in `connectors/gas/Code.gs` returns **HTTP 200 even when it rejects the batch**:

- success: `jsonOut_({ result: 'ok', rowsAdded, duplicatesSkipped })` (Code.gs:68)
- validation reject: `jsonOut_({ result: 'error', message })` (Code.gs:57) — still HTTP 200
- server exception: `jsonOut_({ result: 'error', message })` (Code.gs:70) — still HTTP 200

`post()` today only calls `resp.raise_for_status()` (transport-layer only) and then `return resp.json()`. A `{"result":"error"}` body sails through as an ordinary return value; `run()` prints it and returns normally, so the process **exits 0**. One malformed row silently drops the entire batch with a clean exit — this is the exact mechanism behind the "Tuga/Butterboy spend missing ~2 weeks" incident.

## Task

In `connectors/playwright/base_connector.py`:

1. **Add a new exception class** next to `BlockedError` / `TransientLoginError`:

   ```python
   class IngestError(Exception):
       """GAS doPost returned HTTP 200 but a logical failure (result != 'ok'),
       or a body we cannot confirm as success. Raised so run() exits non-zero
       and the failure is loud, not swallowed."""
   ```

   It MUST be a direct `Exception` subclass — NOT a subclass of `BlockedError` or `TransientLoginError` — so no existing `except` accidentally swallows it. `run()` has no try/except around `self.post(rows)`, so an `IngestError` propagates out of the process (non-zero exit). Do not add a catch.

2. **Harden `post()`** so it fails loud on a logical error. After `resp.raise_for_status()`, parse the body and confirm success:

   ```python
   def post(self, rows: list[dict]) -> dict:
       if not rows:
           return {"result": "skipped", "reason": "no rows"}
       self._require_exec_url()
       payload = {...}  # unchanged
       resp = requests.post(self.exec_url, json=payload, timeout=300)
       resp.raise_for_status()  # transport errors only
       # NEW: confirm the GAS-level result before returning success.
       try:
           body = resp.json()
       except ValueError:
           raise IngestError(...)  # non-JSON 200 (e.g. an HTML error page) is NOT confirmable success
       if body.get("result") != "ok":
           raise IngestError(...)  # logical rejection: include body.get("message")
       return body
   ```

   Core rules that must not deviate:
   - The empty-`rows` early return (`{"result": "skipped", ...}`) stays FIRST — no HTTP call, no raise. Reason: an empty POST is a legitimate no-op, not a failure.
   - A non-JSON 200 body must raise `IngestError`, not return `{"result":"ok"}` as the old `except ValueError` fallback did. Reason: GAS can return a 200 HTML page on certain platform errors; treating an unparseable body as success re-opens the exact silent-failure class this step closes. This is a deliberate tightening of the old lenient fallback.
   - The raised `IngestError` message must include the GAS `message` field when present, so the log names the offending row/reason.

### Test First (TDD step)

1. Write the failing tests for the cases below in `connectors/playwright/test_base_connector.py` **before** any implementation. `post()` currently has ZERO coverage — you are adding it. Monkeypatch the HTTP call (`base_connector.requests.post`) to return a fake response object exposing `.raise_for_status()` (no-op) and `.json()` / `.text`. Set `GAS_EXEC_URL` (or monkeypatch `resolve_exec_url`) so `_require_exec_url()` passes.
   - **CRITICAL — reference `IngestError` the file's existing way so RED is a clean assertion, not a collection error:** the module is already imported as `import base_connector as b` (top of the file). Reference the new symbol **inside test bodies** as `b.IngestError` (e.g. `with pytest.raises(b.IngestError):`). Do NOT add a module-level `from base_connector import IngestError`. Reason: before you implement it, a top-level import fails at pytest **collection** with `ImportError`, which errors the whole file (masking every real assertion) and reads as a *wrong-reason* RED to the harness classifier; `b.IngestError` inside a test body yields a clean `AttributeError`/assertion-style RED for the missing symbol.
2. Confirm the tests fail (red) for the right reason — `IngestError` does not exist yet / `post()` still returns the error dict.
3. Implement the minimum to pass (green), then refactor while keeping green.

Test cases (defined at design time — these are "done"):
- **200 + `{"result":"ok","rowsAdded":3}`** → `post()` returns the dict, raises nothing.
- **200 + `{"result":"error","message":"row 0 missing invoice_ref"}`** → raises `IngestError`, and the exception message contains `"row 0 missing invoice_ref"`.
- **200 + non-JSON body** (e.g. `"<html>error</html>"`, `.json()` raises `ValueError`) → raises `IngestError` (cannot confirm success). Asserts the tightened fallback.
- **`post([])`** (empty rows) → returns `{"result":"skipped","reason":"no rows"}`, makes NO HTTP call (assert `requests.post` was not invoked), raises nothing.
- **`IngestError` is a distinct `Exception` subclass** — `assert not issubclass(IngestError, BlockedError)` and `assert not issubclass(IngestError, TransientLoginError)` — proving `run()`'s existing flow cannot swallow it.

## Acceptance Criteria

```bash
python -m pytest connectors/playwright/test_base_connector.py -q   # all tests pass, incl. the 5 new post() cases
```

## Verification Procedure

1. Run the AC command above.
2. Architecture checklist:
   - Connector still only logs in → downloads → POSTs (no Sheet writes) — boundary intact (ARCHITECTURE.md).
   - The change makes a rejected ingest LOUD (non-zero exit), not silent — matches the two-runtime contract.
   - No CLAUDE.md CRITICAL rule violated (no new deployment, no credentials, no bypass of the doPost path).
3. Update `phases/fix-silent-ingest-failures/index.json` step 0 based on the result:
   - Success → `"status": "completed"`, `"summary": "IngestError added; post() raises on result!=ok / non-JSON 200; 5 new post() tests green."`
   - Failure after 3 retries → `"status": "error"`, `"error_message": "<specifics>"`
   - User intervention required → `"status": "blocked"`, `"blocked_reason": "<specifics>"` then stop.

## Prohibitions

- Do not add a try/except around `self.post(rows)` in `run()`. Reason: the whole point is that `IngestError` propagates to a non-zero exit; catching it re-buries the failure.
- Do not make `IngestError` a subclass of `BlockedError`/`TransientLoginError`. Reason: `_attempt_auto_login` and other paths catch those; an ingest rejection must not be mistaken for an auth outcome.
- Do not weaken the empty-rows early return or change the `{"result":"skipped"}` shape. Reason: downstream `run()` prints it; other connectors rely on it.
- Do not touch `connectors/gas/*` in this step — this is the Python side only. Reason: keeps the step to one module (bugs 2 & 3 are separate steps).
- Do not break existing tests.
