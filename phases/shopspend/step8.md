# Step 8: shopspend-coverage-endpoint

## Requirements Covered

- `PRD-7` — "shopSpend ingest + snapshot store — typed Python client for the external `shopSpend`
  JSON API (per-shop, per-ISO-week order dollars), POSTing via `doPost` into append-only
  `ShopSpend` + `ShopSpendPulls` tabs, snapshotted so history stays reproducible."

This step serves the *reliability* half of PRD-7: `--backfill` can only self-heal a missed Monday
if the runner can find out which weeks are already stored. This step exposes that answer over
HTTP; step 9 consumes it.

If the Task section below appears to contradict this requirement, `docs/ADR.md`, or a CRITICAL
rule in CLAUDE.md, do NOT resolve the conflict yourself and do NOT proceed on a best guess — set
`"status": "needs_context"` with the contradiction spelled out in `needs_context_detail`, and
stop.

## Files to Read

- `docs/api.md` — the whole file. It is the contract this step extends; the `## Response` section
  (**31-77**) is what must not change for existing callers, and `## Parameters` (**20-30**) is
  where the new `fn` parameter is documented.
- `docs/schema.md` — the `ShopSpendPulls` spec, especially `from_week` / `to_week`, which are the
  coverage evidence this endpoint reports.
- `connectors/gas/Code.gs`:
  - `doGet` (**1339-1394**) — read it end to end. It currently takes **no `fn` parameter at all**
    and is hardcoded to `SUMMARY_TAB`; every early `return` is a `jsonOut_({...})`.
  - `checkReadToken_` (**1396**) — the existing read auth. Returns `{ok, message}`; every failure
    path is the string `'unauthorized'`.
  - `jsonOut_` (**1747**) — the only response writer.
  - `SUMMARY_TAB` (**24**), `SHOPSPEND_PULLS_TAB` (**42**), `SHOPSPEND_PULLS_HEADERS` (**49**).
- `connectors/gas/shopspend.gs` — created in earlier steps. **`shopSpendCoveredWeeks_(pullsRows)`
  is built in step 7** and is the function this endpoint must call. Read its implementation and
  its tests before writing anything.
- `connectors/gas/test_code.js` — the existing `doGet` tests, so the regression cases below assert
  against the same fixtures rather than inventing new ones.

## Background — why this is its own step

`--backfill` was specified in step 5 to request only the weeks `ShopSpendPulls` does not yet
cover. That is impossible from the connector side: `doGet` serves the `Summary` tab and nothing
else, so there is no HTTP path to coverage. Building one is GAS work, and step 5's `test_cmd` is
`python -m pytest connectors/shopspend -q` — it cannot mechanically verify a line of `Code.gs`.
So the endpoint lands here, in a step whose `test_cmd` is the GAS suite, and the caller lands in
step 9, whose `test_cmd` is pytest. Each half is verified by the gate that can actually see it.

## Task

**1. Add `fn` dispatch to `doGet` (`connectors/gas/Code.gs:1339`).**

The parameter is new. Resolve it as `var fn = params.fn || 'summary';` so that **a request with no
`fn` behaves exactly as it does today**. Keep `checkReadToken_` as the first thing that runs, before
any dispatch — auth must not become reachable-around.

- `fn === 'summary'` → the existing Summary path, byte-for-byte the same response.
- `fn === 'shopspendCoverage'` → the new path below.
- any other value → `jsonOut_({ result: 'error', message: ... })`. It must **not** fall through to
  Summary.

**2. `fn=shopspendCoverage`.**

Read `SHOPSPEND_PULLS_TAB`, hand the rows to **step 7's `shopSpendCoveredWeeks_(pullsRows)`**, and
return the resulting week labels. Response shape:

```
{ result: 'ok', count: <n>, weeks: ['2026-W29', '2026-W30', ...] }
```

Sorted ascending, de-duplicated — whatever `shopSpendCoveredWeeks_` guarantees, not a second sort.
A missing or empty `ShopSpendPulls` tab is `{result:'ok', count:0, weeks:[]}`, **not** an error:
cold start is a normal state, and step 9 must be able to tell "nothing stored yet" apart from
"the hub is broken".

**3. Update `docs/api.md`** — document `fn` under `## Parameters`, and add the coverage response
under `## Response`. State explicitly that omitting `fn` is unchanged legacy behaviour.

Core rules that must not deviate:
- **The default response shape does not change.** Reason: the weekly report reads this endpoint
  live; a changed shape breaks reporting silently, with no error anywhere.
- **Do not write a second `ShopSpendPulls` span parser.** Reason: step 7 owns
  `shopSpendCoveredWeeks_`, and the watchdog and the backfill must never disagree about which
  weeks are covered. Call it; do not reimplement it.
- **The only caller of `fn=shopspendCoverage` lands in step 9 (`shopspend-backfill-wiring`).** An
  endpoint with no consumer is expected at this step and is **not** a review finding.

### Test First (TDD step)

Add cases to `connectors/gas/test_code.js` before implementing. Confirm RED, then green.

Test cases (definition of done):
- **No `fn` → unchanged:** for a fixed Summary fixture, the response has the same keys, in the
  same order, with the same values as before this step. (The harness mocks the Sheet rather than
  replaying a live response, so assert structural equality against the fixture — not a literal
  byte comparison.)
- **`fn=summary` → identical to omitting `fn`** for the same fixture.
- **`fn=shopspendCoverage` → covered weeks** from `ShopSpendPulls`, matching what
  `shopSpendCoveredWeeks_` returns for the same rows.
- **Span expansion:** a single pulls row `from_week: '2026-W29'`, `to_week: '2026-W31'` reports
  all three weeks — asserting the endpoint delegates rather than reading endpoints only.
- **Empty / missing `ShopSpendPulls` → `{result:'ok', count:0, weeks:[]}`**, not an error.
- **Missing token → `unauthorized`** on the coverage path, and **bad token → `unauthorized`** —
  the coverage data is never returned without auth.
- **Unknown `fn` (e.g. `fn=nope`) → an error response**, and specifically NOT the Summary payload.
- **Auth runs before dispatch:** an unknown `fn` with a bad token still returns `unauthorized`,
  not an unknown-fn error.
- **No regression:** the full existing suite passes, including every current `doGet` test.

## Acceptance Criteria

```bash
node connectors/gas/test_code.js      # all tests pass incl. the new cases; exit 0
```

## Verification Procedure

1. Run the AC command.
2. Architecture checklist:
   - `grep -n "from_week" connectors/gas/Code.gs` shows no new span-parsing logic — the coverage
     path delegates to `shopSpendCoveredWeeks_` in `shopspend.gs`.
   - The `params.fn` default is `'summary'`, so an absent `fn` is the legacy path.
   - `checkReadToken_` still runs before any `fn` branch.
   - No new `doPost` behaviour, no Sheet writes: this endpoint is read-only.
3. Update `phases/shopspend/index.json` step 8 (`completed` + `summary`, or `error` +
   `error_message`, or `blocked` + `blocked_reason` then stop).

## Prohibitions

- Do not change the response for a request that omits `fn`. Reason: the weekly report depends on
  it and would fail silently.
- Do not reimplement span parsing. Reason: two parsers will drift and split the watchdog's answer
  from the backfill's.
- Do not let an unknown `fn` fall through to Summary. Reason: a typo in a caller would silently
  return the wrong dataset instead of an error.
- Do not write to any tab. Reason: this is a read endpoint; all writes go through `doPost`.
- Do not run `deploy.sh`. Reason: deployment is a separate attended step, and this endpoint is
  live-probed after it lands.
- Do not add a second read token or auth path. Reason: `checkReadToken_` is the single read gate.
