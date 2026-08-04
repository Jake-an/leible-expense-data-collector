# Step 2: chunk-by-week-poster

## Requirements Covered

- `PRD-7` — shopSpend ingest + snapshot store — "snapshotted so history stays reproducible". This
  is the client half of the idempotent-tombstoning fix begun in step 1.

This is *why* this step exists. If the Task section below appears to contradict the requirement
above, `docs/ADR.md`, or a CRITICAL rule in CLAUDE.md, do NOT resolve the conflict yourself and do
NOT proceed on your best guess — set `"status": "needs_context"` with the contradiction spelled out
in `needs_context_detail`, and stop.

## Files to Read

- `connectors/shopspend/ingest.py` — `post_pull` signature at lines 65-71; the chunk loop at line
  87 onward; the pulls-marker final payload
- `connectors/shopspend/runner.py` — `_build_pull` at lines 100-122 (note `from_week`/`to_week` at
  103-104 and the silent paging degradation at 105-107); the truncation warning at 145-146; the
  `ingest.post_pull(mapped_rows, pull)` call site at line 218
- `connectors/shopspend/models.py` — `Meta.paging: Paging | None` at line 39; `Diagnostics` at
  lines 84-96 (`emptyRangeWithInvalidLabels` :87, `totalOrdersScanned` :95); `_known_kwargs` at
  lines 14-16
- `connectors/shopspend/test_ingest.py` — `_row()` at lines 43-58 (hardcodes
  `week_label: "2026-W31"`); the 450-row/`chunk_size=200` case at lines 220-232; all 15 `post_pull`
  call sites
- `docs/ingest-contract.md` and `docs/schema.md` — the wire contract
- Step 1's output: `connectors/gas/Code.gs` `validateIngest_` and `connectors/gas/shopspend.gs`
  `ingestShopSpendRows` — the server side of the contract you are now emitting

Read the code and understand the design intent before starting.

## Task

Pack **whole weeks** per request, up to `chunk_size`, and declare which weeks each request carries
in full.

### Why packing, not one-week-per-request

N weeks → N+1 round trips, each taking `withScriptLock_`, re-reading the whole tab via
`getDataRange()` (`shopspend.gs:40`), and carrying its own 60s `LOCKED` sleep
(`ingest.py:53-59`) — a 12-week backfill would burn ~12 minutes of retry sleeps alone. Pack
**multiple complete weeks** per request up to `chunk_size`. Same invariant, far fewer round trips.

### Span source — named explicitly

`weeks_complete` derives from the **requested span**: `pull["from_week"]` / `pull["to_week"]`
(`runner.py:103-104`), expanded to week labels. **Not** re-derived from the returned rows.

`post_pull` (`ingest.py:65-71`) has no span parameter and is called as `post_pull(mapped_rows,
pull)` (`runner.py:218`) — the `pull` dict is the single source. An implementer who re-derives the
span from rows silently reverts the empty-week fix while every other test still passes, so a case
below asserts the declared set matches the **pull span**, never the returned rows.

### Completeness gate — the safety-critical part

Declaring a week complete **authorises GAS to tombstone it**. Declare **nothing**, and warn,
whenever the fetch cannot be trusted to be whole.

**Where the gate runs — the seam is named; do not relocate it.** `post_pull(rows, pull, source,
chunk_size, exec_url)` receives **no** `response`, `meta` or `diagnostics`, and all 15 existing
call sites in `test_ingest.py` use that shape. So the gate **cannot** run inside `post_pull`.

Compute it in `runner.py` (which holds `response`) and pass the results down as two new keyword
params:

```python
def post_pull(rows, pull, source="shopspend", chunk_size=200, exec_url=None,
              weeks_complete: list[str] | None = None,
              weeks_verified_empty: list[str] | None = None) -> dict:
```

`None` means **declare nothing** — so the 15 existing call sites stay valid *and* fail safe. This
makes `runner.py` a step-2 file as well as a step-3 file; same runtime, so no cross-runtime
violation, but note the overlap.

**Read `response.meta.paging` directly — NOT `pull["matched"]`.** `_build_pull` degrades silently
(`runner.py:105-107`): `matched = paging.matched if paging else len(response.rows)` and
`truncated = ... if paging else False`. By the time anything sees `pull`, the paging-absent case is
indistinguishable from a complete fetch and the two strongest conditions below become
definitionally false. The *span* still comes from `pull["from_week"]`/`pull["to_week"]`; only the
completeness signals must come from `response`.

| Condition | Source | Why |
|---|---|---|
| `meta is None or meta.paging is None` | `models.py:39` `paging: Paging \| None` | **Without this the next two rows silently no-op** — `matched` collapses to `len(rows)` so `len(rows) < matched` is never true, and `truncated` is hardcoded False. A partial fetch would sail straight through the gate. |
| `paging.truncated` | `runner.py:145-146` already warns, then posts anyway | Truncation drops rows; declaring the span would tombstone every dropped shop-week |
| `len(rows) < paging.matched` | `meta.paging` directly | Same, without relying on the truncated flag being set |
| `paging.matched == 0` | `meta.paging` directly | A degenerate `ok: true, rows: []` — upstream outage, auth scoped to nothing, bad week filter |
| `diagnostics.totalOrdersScanned == 0` | `models.py:95` | The API scanned nothing; absence is unproven |
| `diagnostics.emptyRangeWithInvalidLabels` | `models.py:87` | Exists precisely because this failure happens |

Without this gate, one bad HTTP call flips an entire 4-week span to `absent` — zeros written into a
spend ledger and rendered as `stale`. That is strictly worse than the C1 bug being fixed:
incomplete data becomes actively wrong data.

### A genuinely empty week

When the fetch passed the **full** gate above and one spanned week returned no rows, emit a
rows-empty request declaring that week in **both** `weeks_complete` and `weeks_verified_empty`.
That second field is what stands step 1's circuit breaker down for a legitimate 100% absence;
without it the breaker would suppress the very case this mechanism exists to record. Step 1's
`extractedAt` fix is what makes the rows-empty request safe.

### Surface every suppression

`post_pull` must print a `WARNING` naming each week in the response's `tombstonesSkipped`, with its
`wouldHaveWritten` / `present` counts. The breaker is deliberately not self-healing, so a skip that
is never surfaced is a silent permanent hole. **Print-only — the WARNING must never raise**, or a
suppression would abort a pull that otherwise succeeded.

### Test First (TDD step)

1. Write the failing test(s) for the cases below *before* any implementation. Use the
   `ecc:tdd-guide` agent to drive the red-green-refactor loop.
2. Confirm the test fails (red) for the right reason.
3. Implement the minimum to pass (green), then refactor while keeping tests green.

Test cases (defined at design time — these are "done"):

- 4 weeks under `chunk_size` → **one** request declaring all four, plus the pulls marker last
- a span exceeding `chunk_size` packs into several requests, each declaring exactly the weeks it
  carries in full
- a single week over `chunk_size` splits, is declared in **no** request's `weeks_complete`, and
  warns with the week and the row count
- a **truncated** response declares zero weeks
- `matched > len(rows)` declares zero weeks
- `matched == 0` declares zero weeks and warns
- `totalOrdersScanned == 0` declares zero weeks
- `emptyRangeWithInvalidLabels` declares zero weeks
- `meta.paging is None` declares zero weeks and warns — **construct this case with rows present
  and `len(rows)` deliberately equal to what `_build_pull` would report as `matched`, so the test
  FAILS if the gate reads `pull["matched"]` instead of `meta.paging` directly**
- a complete fetch whose spanned week returned no rows produces a rows-empty request declaring it
  in **both** `weeks_complete` and `weeks_verified_empty`
- the declared week set equals the `pull` span, never the returned rows
- `--dry-run` issues **zero** HTTP posts under the new shape
- a re-declared already-covered week appends nothing (dedup, `shopspend.gs:80-85`)
- a response carrying `tombstonesSkipped` makes the poster print a WARNING naming each skipped week
  with its counts — and does **not** raise
- every request carries the same `fetched_at` and `kind: 'shopspend'`
- the commit marker is still last and still carries `pull`

**Packing invariant — assert as a property, not just examples:** for every request,
`set(weeks_complete) ⊆ {weeks whose full row count is carried in this request}`, and for each
declared week the carried row count equals that week's total mapped rows. Example-based cases alone
let the C1 bug class return the moment a chunk boundary lands mid-week while the week is still
declared.

**Runner-side exemption case (the packing invariant does not cover this).** The packing property is
asserted over `post_pull`'s output, but `weeks_verified_empty` is **computed** in `runner.py`. A
runner-side bug that marks a spanned week verified-empty when `response.rows` did carry rows for it
escapes both the property test (if those rows land in a sibling request) and server validation
(each request is validated alone). Add a runner-level case computed from a response fixture:
`weeks_verified_empty ⊆ {spanned weeks with zero rows in response.rows}`.

**The existing chunking tests are updated, not relaxed** (same discipline as step 1's GAS tombstone
suite). `test_ingest.py:43-58`'s `_row()` hardcodes `week_label: "2026-W31"`, so the existing
450-row/`chunk_size=200` case (`:220-232`) is **one week over the limit** and now exercises the
**degraded split-week path**, not packing. It stays green — which is exactly why this must be said
out loud: after this change the old chunking tests no longer prove packing works. The new cases do.

## Acceptance Criteria

```bash
python -m pytest connectors/shopspend -q     # all tests pass, including the cases above
ruff check connectors/shopspend               # clean
```

## Verification Procedure

1. Run the AC commands above.
2. Check the architecture checklist:
   - Does the connector still only log in, download and POST — never write to the Sheet directly?
   - Does it stay within the tech stack defined in `docs/ADR.md`?
   - Does it not violate the CRITICAL rules in CLAUDE.md?
3. Update this step in `phases/shopspend-hardening/index.json`:
   - Success → `"status": "completed"`, `"summary": "one-line summary of output"`
   - Failure after 3 retry attempts → `"status": "error"`, `"error_message": "specific details"`
   - User intervention required → `"status": "blocked"`, `"blocked_reason": "specific reason"`,
     then stop immediately

## Prohibitions

- **Do NOT run `bash scripts/deploy.sh`, `clasp push`, `clasp deploy`, or any other deploy command
  in this step.** Reason: the phase is under a deploy embargo until its phase-end review gate
  passes AND the branch is merged to `feat-shopspend`. This overrides CLAUDE.md's "deploy when GAS
  coding is finished" rule for this phase only.
- Do not derive `weeks_complete` from the returned rows. Reason: it silently reverts the empty-week
  fix (a week that returned nothing would never be declared, so a genuine mass absence is never
  recorded) while every other test still passes. Derive from `pull["from_week"]`/`pull["to_week"]`.
- Do not read `pull["matched"]` or `pull["truncated"]` in the completeness gate. Reason:
  `_build_pull` degrades those to `len(rows)` and `False` when paging is absent, so a partial fetch
  becomes indistinguishable from a complete one and the gate silently no-ops. Read
  `response.meta.paging` directly.
- Do not change `post_pull`'s existing positional parameters or their order. Reason: 15 existing
  call sites in `test_ingest.py` use that shape; the new params are keyword-only additions
  defaulting to `None` (= declare nothing = fail safe).
- Do not let the `tombstonesSkipped` WARNING raise. Reason: a suppression would then abort a pull
  that otherwise succeeded. Print-only.
- Do not touch any GAS/JS file in this step. Reason: single-runtime (Python) step; its `test_cmd`
  is pytest-only and would not exercise a GAS change.
- Do not break existing tests.
