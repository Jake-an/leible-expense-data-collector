# Step 9: shopspend-backfill-wiring

## Requirements Covered

- `PRD-7` — "shopSpend ingest + snapshot store — typed Python client for the external `shopSpend`
  JSON API (per-shop, per-ISO-week order dollars), POSTing via `doPost` into append-only
  `ShopSpend` + `ShopSpendPulls` tabs, snapshotted so history stays reproducible."

This step completes the *reliability* half of PRD-7 that step 8 opened: `--backfill` stops
re-requesting all four closed weeks blindly and asks only for the weeks the hub does not already
have.

If the Task section below appears to contradict this requirement, `docs/ADR.md`, or a CRITICAL
rule in CLAUDE.md, do NOT resolve the conflict yourself and do NOT proceed on a best guess — set
`"status": "needs_context"` with the contradiction spelled out in `needs_context_detail`, and
stop.

## Files to Read

- `docs/api.md` — as updated by step 8, specifically the `fn` parameter and the
  `fn=shopspendCoverage` response shape. This is the contract you are consuming.
- `docs/ARCHITECTURE.md` — the two-runtime boundary. Connectors read and POST; they never touch
  the Sheet directly.
- `connectors/shopspend/runner.py` — read it end to end. In particular:
  - `_BACKFILL_WEEKS = 4` (**27**)
  - `last_n_closed_weeks(today, n)` (**37**)
  - `missing_weeks_for_backfill(candidate_weeks, covered)` (**48**) — **already implemented and
    unit-tested in step 5, deliberately left with no caller. This step is its caller.**
  - `main(argv)` (**161**) and its `--backfill` branch, which currently does
    `candidates = last_n_closed_weeks(...)` then `from_week, to_week = candidates[0],
    candidates[-1]` — the unconditional full-span request this step replaces.
- `connectors/shopspend/client.py` — `resolve_config()` (**63**) and `ShopSpendClient` (**84**)
  for the house style of config resolution and error types (`ShopSpendError` **34**,
  `ShopSpendTransientError` **47**). Note `resolve_config()` resolves the **external shopSpend
  API**, not the hub — coverage is a different endpoint with different config.
- `connectors/shopspend/ingest.py` — `post_pull` (**65**) and the block at **75-76** showing how
  the GAS hub URL is resolved: `GAS_EXEC_URL` env var, falling back to `execUrl` in
  `config/deployment.json`. Reuse that resolution; do not invent a second one.
- `connectors/shopspend/test_runner.py` — the existing tests, especially
  `test_missing_weeks_for_backfill_finds_the_one_gap` (**100**) and
  `test_missing_weeks_for_backfill_returns_empty_when_fully_covered` (**109**). Your new
  end-to-end cases sit alongside these; do not duplicate or weaken them.

## Task

**1. `connectors/shopspend/client.py` — `fetch_coverage()`.**

```python
def fetch_coverage() -> set[str]:
    """Covered ISO week labels from the hub's ShopSpendPulls tab."""
```

- Resolve the hub URL exactly the way `ingest.py` does (`GAS_EXEC_URL`, else `execUrl` from
  `config/deployment.json`). Do not add a second resolution path.
- Read the hub read token from a **new** env var `GAS_READ_TOKEN`, sent as the `token` query
  param. It must match the `API_READ_TOKEN` Script Property (see `docs/api.md`). The token is a
  secret: it must never be logged, printed, or included in an exception message — reuse the
  redaction discipline already in `client.py` (`_redact`, **51**).
- Call `GET <hub>?fn=shopspendCoverage&token=<...>` and return the `weeks` array as a `set[str]`.
- Raise on a non-`ok` result or an unparseable body. Do **not** return an empty set on error —
  an empty set means "hub has nothing stored", and conflating it with failure would make a broken
  hub look like a cold start and silently re-pull everything.

**2. `connectors/shopspend/runner.py` — wire it into `--backfill`.**

Replace the unconditional full-span request in `main()`'s `--backfill` branch with:

- compute `candidates = last_n_closed_weeks(today, _BACKFILL_WEEKS)`
- `covered = client.fetch_coverage()`
- `weeks = missing_weeks_for_backfill(candidates, covered)`
- request only the span those weeks describe; if `weeks` is empty, print that everything is
  covered and **exit 0 without calling the API or posting anything**.

**Degrade, never skip.** If `fetch_coverage()` raises, log the reason and fall back to requesting
the full `candidates[0]..candidates[-1]` span — today's behaviour. Reason: a hub outage must cost
one redundant API call, not a silently missed week. Never let a coverage failure narrow the
request.

**3. Note for step 10.** `GAS_READ_TOKEN` is a new required `.env` value. Step 10 documents the
attended `.env` setup — add `GAS_READ_TOKEN` to the list it documents, or record it in the step 9
summary so step 10 picks it up.

Core rules that must not deviate:
- Coverage is advisory for *narrowing* only. It may never cause fewer weeks to be fetched than the
  full span when it is unavailable.
- The connector still POSTs through the existing ingest path. This step adds a read; it changes
  nothing about how rows are written.

### Test First (TDD step)

Write the tests in `connectors/shopspend/test_runner.py` (and a client-level test file if that
matches the existing layout) before implementing. Fake the HTTP layer; never hit a live endpoint.
Confirm RED, then green.

Test cases (definition of done):
- **`fetch_coverage()` parses:** a stubbed `{"result":"ok","count":2,"weeks":["2026-W29","2026-W30"]}`
  returns `{"2026-W29", "2026-W30"}` as a set.
- **`fetch_coverage()` raises on error:** `{"result":"error","message":"unauthorized"}` raises, and
  a non-JSON 200 raises. Neither returns an empty set.
- **Token never leaks:** the token does not appear in any exception message or printed output on
  the failure paths above.
- **3-of-4 covered → one week requested:** with coverage for three of the four closed weeks,
  `--backfill` requests only the missing week.
- **Fully covered → no request at all:** `--backfill` calls neither the shopSpend API nor the
  ingest poster, and exits 0.
- **Coverage unavailable → full span:** when `fetch_coverage()` raises, `--backfill` requests the
  full 4-week span (degraded, not skipped) and still exits 0 on success.
- **`--dry-run --backfill` writes nothing:** the ingest poster is never called, even when coverage
  identifies missing weeks.
- **`missing_weeks_for_backfill` is actually called:** assert `main()` reaches it — this is the
  wiring the step exists to add, and it is the exact defect that stalled step 5.
- **No regression:** the existing step 4 and step 5 tests still pass unchanged.

## Acceptance Criteria

```bash
python -m pytest connectors/shopspend -q   # all tests pass incl. the new cases; exit 0
ruff check connectors/shopspend
ruff format --check connectors/shopspend
```

## Verification Procedure

1. Run the AC commands.
2. Architecture checklist:
   - `grep -n "missing_weeks_for_backfill" connectors/shopspend/runner.py` shows a call inside
     `main()`, not just the definition.
   - No second hub-URL resolution path: `grep -n "GAS_EXEC_URL" connectors/shopspend/*.py` shows
     the resolution reused, not duplicated.
   - No Sheet writes and no new POST paths — this step adds a read.
   - The token appears in no log or exception string.
3. Update `phases/shopspend/index.json` step 9 (`completed` + `summary`, or `error` +
   `error_message`, or `blocked` + `blocked_reason` then stop).

## Prohibitions

- Do not return an empty set from `fetch_coverage()` on failure. Reason: it is indistinguishable
  from a cold start, and would turn a broken hub into a silent full re-pull forever.
- Do not narrow the request when coverage is unavailable. Reason: a missed week is invisible; a
  redundant API call is not.
- Do not log, print, or embed `GAS_READ_TOKEN` in an error. Reason: secrets stay out of chat, logs
  and the repo.
- Do not hit the live endpoint in tests. Reason: needs Jake and a real token; that is the attended
  integration step.
- Do not modify `missing_weeks_for_backfill()`'s signature or its step 5 tests. Reason: they are
  the contract this step wires up; changing them hides a wiring failure.
- Do not run `deploy.sh`. Reason: deployment is a separate attended step.
