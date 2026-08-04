# Step 4: report-unassessed-pricing

## Requirements Covered

- `PRD-8` — shopSpend reporting + data-quality surfacing: the `ShopSpend Report` tab with mandatory
  banners. This step makes the pricing banner tell the truth about an unassessed value.

This is *why* this step exists. If the Task section below appears to contradict the requirement
above, `docs/ADR.md`, or a CRITICAL rule in CLAUDE.md, do NOT resolve the conflict yourself and do
NOT proceed on your best guess — set `"status": "needs_context"` with the contradiction spelled out
in `needs_context_detail`, and stop.

## Files to Read

- `connectors/gas/shopspend.gs` — the pricing-drift banner at lines 278-279
- `connectors/gas/Code.gs` — `normalizePullMetadataRow_`, specifically lines 368-369 where both
  pricing columns are passed through **uncoerced** (unlike their `String(...)`/`Number(...)`
  neighbours)
- `connectors/gas/test_code.js` — the drift-wording test around lines 3384-3390 (asserts the
  current wording; it gets updated); the pull-column-order assertions around line 2940
- `docs/schema.md` — the `ShopSpendPulls` pricing columns as updated by step 3 (`""` = not
  assessed)
- Step 3's output: `connectors/shopspend/runner.py` `_build_pull` now emits `""` for both pricing
  columns

Read the code and understand the design intent before starting.

## Task

Step 3 made the connector emit `""` for `diverges_from_live_pricing` / `matches_live_pricing`,
meaning **not assessed**. This step makes the report say so.

`shopspend.gs:278-279` currently prints `Pricing drift vs current live pricing: matches.` Render
the unknown value as **"not assessed"**.

### Treat unknown as `'' | undefined`

`Code.gs:368-369` passes both pricing columns through uncoerced, so `""` survives to the cell — but
a **legacy or short row** read back from the Sheet yields `undefined`, not `''`. Handle both.

A legacy `true` / `false` must still render drift / matches respectively — rows already written
must not regress.

### Test First (TDD step)

1. Write the failing test(s) for the cases below *before* any implementation. Use the
   `ecc:tdd-guide` agent to drive the red-green-refactor loop.
2. Confirm the test fails (red) for the right reason.
3. Implement the minimum to pass (green), then refactor while keeping tests green.

Test cases (defined at design time — these are "done"):

- `""` renders "not assessed", never "matches" and never "diverges"
- `undefined` renders "not assessed" too
- a legacy `true` / `false` still renders drift / matches — no regression for rows already written
- the pull-column-order assertions (around `test_code.js:2940`) still pass
- the pricing columns are still passed through **uncoerced** by `normalizePullMetadataRow_`

Update the existing drift-wording test (around `test_code.js:3384-3390`) to match the new wording,
preserving its intent — it must still assert that the banner never says "stale pricing".

## Acceptance Criteria

```bash
node connectors/gas/test_code.js     # all tests pass, including the cases above
```

## Verification Procedure

1. Run the AC command above.
2. Check the architecture checklist:
   - Does it follow the directory structure in `docs/ARCHITECTURE.md`?
   - Does it not violate the CRITICAL rules in CLAUDE.md?
3. Update this step in `phases/shopspend-hardening/index.json`:
   - Success → `"status": "completed"`, `"summary": "one-line summary of output"`
   - Failure after 3 retry attempts → `"status": "error"`, `"error_message": "specific details"`
   - User intervention required → `"status": "blocked"`, `"blocked_reason": "specific reason"`,
     then stop immediately

## Prohibitions

- **`normalizePullMetadataRow_` must NOT change.** Do not "tidy" `Code.gs:368-369` into
  `Boolean(pull.diverges_from_live_pricing)` or any other coercion. Reason: that would silently
  defeat steps 3 and 4 *together* while every node test keeps passing, because those tests build
  `pullRow({...})` directly and never exercise the normalizer's coercion. A test case above asserts
  the pass-through is still uncoerced.
- **Do NOT run `bash scripts/deploy.sh`, `clasp push`, `clasp deploy`, or any other deploy command
  in this step.** Reason: the phase is under a deploy embargo until its phase-end review gate
  passes AND the branch is merged to `feat-shopspend`. This overrides CLAUDE.md's "deploy when GAS
  coding is finished" rule for this phase only.
- Do not touch any Python file in this step. Reason: single-runtime (GAS) step; its `test_cmd` is
  node-only and would not exercise a Python change.
- Do not break existing tests.

## Note for the phase summary

This step changes what a report Jake reads actually says: "matches" → "not assessed". That corrects
a false assurance, but it will look like a regression if unexplained. Say so explicitly in this
step's `summary`.
