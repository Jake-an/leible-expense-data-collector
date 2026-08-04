# Step 3: pull-diagnostics-honest-values

## Requirements Covered

- `PRD-8` — shopSpend reporting + data-quality surfacing. A pull row that hardcodes "pricing
  matches" is the opposite of data-quality surfacing: it manufactures an assurance nobody checked.

This is *why* this step exists. If the Task section below appears to contradict the requirement
above, `docs/ADR.md`, or a CRITICAL rule in CLAUDE.md, do NOT resolve the conflict yourself and do
NOT proceed on your best guess — set `"status": "needs_context"` with the contradiction spelled out
in `needs_context_detail`, and stop.

## Files to Read

- `connectors/shopspend/runner.py` — `_build_pull` at lines 100-122, specifically the hardcoded
  values at lines 117-120; `truncate_diagnostics_json` at line 73 and its use at line 89
- `connectors/shopspend/models.py` — `Diagnostics` at lines 84-96 (note `pricingBasis: dict | None`
  at line 86 — the only pricing-adjacent member)
- `docs/schema.md` — the `ShopSpendPulls` column spec at lines 163-171, specifically lines 166-169
- `connectors/gas/Code.gs` — `SHOPSPEND_PULLS_HEADERS` at line 49 (read only — do NOT edit)
- Step 2's output in `connectors/shopspend/runner.py` — the completeness gate and the computed
  `weeks_complete` / `weeks_verified_empty`

Read the code and understand the design intent before starting.

## Task

### The defect (important, I1 from the phase-end review)

`runner.py:117-120` hardcodes:

```python
"diverges_from_live_pricing": False,
"matches_live_pricing": True,
...
"absent_shop_ids": "[]",
```

So every pull row asserts that pricing matches live pricing — an assurance that was never computed.

**The API does not expose pricing divergence.** `Diagnostics` (`models.py:84-96`) has no such
field. The only pricing-adjacent member is `pricingBasis: dict | None` (line 86), whose shape is
documented nowhere. There is nothing to derive from, and inventing a derivation would replace one
false assurance with a differently-sourced one.

`absent_shop_ids` is separately unfillable by the connector — GAS computes tombstones *after* the
pull row is built.

### 1. Emit honest unknowns

Emit `""` for all three columns: `diverges_from_live_pricing`, `matches_live_pricing`,
`absent_shop_ids`. New semantics: `""` = **not assessed**.

Step 4 is what makes `""` render as "not assessed" in the report. Until step 4 lands, `""` is falsy
and the report would print "matches" — which is why this phase is under a deploy embargo (see
Prohibitions).

### 2. Update `docs/schema.md` in this step

`docs/schema.md:166-169` currently types both pricing columns as **boolean, required** and
`absent_shop_ids` as **string (JSON array), required**. Emitting `""` without that edit leaves the
doc and the code disagreeing. Document `""` = not assessed for all three.

### 3. Record the declared weeks in the Sheet, not only on stderr

When step 2's completeness gate trips, rows land and the pull marker lands, but absence is never
assessed and **nothing in the hub says so** — the only trace is a console warning nobody re-reads.

Record the declared week list under a `harness` key inside the existing `diagnostics_json` blob
(built in `_build_pull`), so a regression that silently disables absence detection is visible in
the Sheet.

Deliberately **not** a new `ShopSpendPulls` column: that would require changing
`SHOPSPEND_PULLS_HEADERS` (`Code.gs:49`) too, making this a cross-runtime step and violating the
phase's single-runtime rule. `diagnostics_json` is Python-side only.

### Test First (TDD step)

1. Write the failing test(s) for the cases below *before* any implementation. Use the
   `ecc:tdd-guide` agent to drive the red-green-refactor loop.
2. Confirm the test fails (red) for the right reason.
3. Implement the minimum to pass (green), then refactor while keeping tests green.

Test cases (defined at design time — these are "done"):

- all three columns emit `""`, never `False` / `True` / `"[]"`
- a populated `pricingBasis` still yields `""` — we do not guess
- `docs/schema.md` documents `""` for all three **and** the `harness` key inside `diagnostics_json`
- the declared week list round-trips through `truncate_diagnostics_json` intact for a realistic
  4-week pull
- the pull row still has exactly `SHOPSPEND_PULLS_HEADERS`' width and column order

## Acceptance Criteria

```bash
python -m pytest connectors/shopspend -q     # all tests pass, including the cases above
ruff check connectors/shopspend               # clean
```

## Verification Procedure

1. Run the AC commands above.
2. Confirm `docs/schema.md` and the emitted values agree.
3. Check the architecture checklist:
   - Does the connector still only log in, download and POST — never write to the Sheet directly?
   - Does it not violate the CRITICAL rules in CLAUDE.md?
4. Update this step in `phases/shopspend-hardening/index.json`:
   - Success → `"status": "completed"`, `"summary": "one-line summary of output"`
   - Failure after 3 retry attempts → `"status": "error"`, `"error_message": "specific details"`
   - User intervention required → `"status": "blocked"`, `"blocked_reason": "specific reason"`,
     then stop immediately

## Prohibitions

- **Do NOT run `bash scripts/deploy.sh`, `clasp push`, `clasp deploy`, or any other deploy command
  in this step.** Reason: deploying between steps 3 and 4 is the *worst* point in the phase —
  `Code.gs:368-369` passes both pricing columns through **uncoerced**, `""` is falsy, and
  `shopspend.gs:278` then prints "Pricing drift vs current live pricing: **matches**" for a value
  that was never assessed. That reinstates finding I1 in production by following the plan. Step 4
  is what makes `""` render as "not assessed". Embargo runs until the phase-end gate passes AND the
  branch is merged to `feat-shopspend`.
- Do not derive a pricing-divergence value from `pricingBasis` or any other field. Reason: the API
  exposes no divergence signal and its shape is undocumented; a guess is a differently-sourced
  false assurance, which is the defect being fixed.
- Do not add a new `ShopSpendPulls` column. Reason: it would require editing
  `SHOPSPEND_PULLS_HEADERS` (`Code.gs:49`), making this a cross-runtime step under a pytest-only
  `test_cmd`. Also: editing a `*_HEADERS` constant does nothing to an already-existing live tab.
- Do not touch any GAS/JS file in this step. Reason: single-runtime (Python) step; its `test_cmd`
  is pytest-only and would not exercise a GAS change.
- Do not break existing tests.
