# Step 3: orphan-detection

## Requirements Covered

- `PRD-12` — Summary self-heal window (a heal that mints orphans creates double-counted money; detection is part of the write path being safe)

If the Task section contradicts `docs/ADR.md` or a CRITICAL rule in CLAUDE.md, set
`"status": "needs_context"` and stop.

## Files to Read

- `connectors/gas/summary_audit.gs` :137-147 — the audit's own orphan reasoning, including its phrase "an orphan is not missing money, it may be double-counted money"
- `connectors/gas/Code.gs` — `SUMMARY_KEY_COLS` at :65, `rowKey_` at :607-615 (the exact normalization to match), `cleanupDuplicateSummaryRows` at :1161 and its bottom-up delete at :1334-1346 (the deletion precedent)
- `connectors/gas/summary_drift_repair.gs` — the dry-run-then-gated-apply shape this step must copy
- `connectors/gas/orderapp.gs` :811-857 — greenbean's date-change path, which mints orphans automatically

## Task

### The problem

`Summary`'s key is `week_start||department||kind||supplier||location`. Change a row's
`location`, `supplier` or `department` in `Suppliers` and a heal writes a **new** key while
the old `Summary` row keeps its money. `upsertRows_` has no delete path, so both rows
survive and `doGet` serves the money **twice**.

This is not hypothetical: it is a documented past incident on this branch, and
`greenBeanPull_` triggers it automatically whenever an upstream date change moves an
invoice between weeks.

### 1. Detection — automatic, inside the heal

For each healed week, sweep live `Summary` keys for that week that are **not** in the
computed batch. Report them as orphan candidates with full key, supplier, location and
total. Fold the finding into that week's existing alert (Step 2 gate 6) so a death between
the write and the alert cannot lose the notice.

Detection **never deletes**.

### 2. Removal — manual, gated, backed up

Follow the project's established shape exactly:
- `runSummaryOrphanSweepDryRun()` — zero-arg, read-only, logs **one line per candidate**
  (a single big `Logger.log(JSON.stringify(...))` is truncated by the editor, so an
  approval gate would show a list nobody has read).
- `runSummaryOrphanSweep()` — gated apply. Backs every matched row up to a retained tab
  before the first `deleteRow`, deletes **bottom-up**, and asserts the matched count equals
  the count the dry run approved. On mismatch: re-run the dry run and re-approve — never
  adjust the count to fit.

### 3. What must never be swept

- Rows whose `supplier` normalizes to `shopify_orderapp`. They are written directly by the
  order-app pull (`orderapp.gs:379-382, 406`) with `location='online'`, have no
  `Suppliers` backing, and `weeklySummarize` can never regenerate them. They will *always*
  look like orphans to a Suppliers-derived sweep. Excluding them is mandatory.
- Anything matched by `(week, location)` alone. A blank `location` reads as a narrow, safe
  predicate and is not. Match the full `SUMMARY_KEY_COLS` tuple with `supplier` and `kind`
  pinned, case-normalized the way `rowKey_` does.

Note the asymmetry deliberately: `shopify_orderapp` is excluded because it is genuinely
never derived. Do **not** generalize this into filtering `SUMMARY_AUDIT_PULL_OWNED_` —
greenbean and labour rows ARE derived and belong in the computed batch.

## Test First

Write these in `connectors/gas/test_code.js` and confirm they FAIL first.

1. Changing a row's `location` in `Suppliers` produces an orphan finding naming the OLD key.
2. The automatic path **does not delete** the orphan — assert zero `deleteRow` calls.
3. The orphan finding rides the same per-week alert as that week's corrections.
4. A `shopify_orderapp` online revenue row is **never** reported as an orphan.
5. A greenbean-derived `Bennetts` row with a blank `location` is **not** reported as an orphan when it is in the computed batch.
6. `runSummaryOrphanSweepDryRun()` writes nothing and logs one line per candidate.
7. `runSummaryOrphanSweep()` backs up every matched row before the first delete.
8. `runSummaryOrphanSweep()` deletes bottom-up (assert the row indices are descending).
9. A count mismatch between dry run and apply aborts without deleting anything.
10. Matching is case-normalized identically to `rowKey_`.

## Acceptance Criteria

```bash
node connectors/gas/test_code.js   # all suites green, including every case above
```

## Verification Procedure

1. Run the AC command.
2. Mutation-test case 4 — remove the `shopify_orderapp` exclusion and confirm a test goes red.
3. Read the diff against the Prohibitions.
4. Update this step in `phases/summary-self-heal/index.json`.

## Prohibitions

- **Do not delete anything on an automatic/triggered path.** Reason: `shopify_orderapp` rows are unrebuildable and a weekly automatic deleter over financial records is not recoverable from.
- **Do not match rows by `(week, location)`.** Reason: a blank `location` makes that predicate far broader than it reads; documented near-miss worth $14,219.
- **Do not extend the sweep exclusion to `SUMMARY_AUDIT_PULL_OWNED_`.** Reason: greenbean and labour rows are derived and legitimately in the batch; only `shopify_orderapp` is genuinely never derived.
- Do not emit the candidate list as one big `Logger.log(JSON.stringify(...))`. Reason: editor truncation hides items from the approval gate.
- Do not use bare `new Date()`. Reason: `withMockNow` patches only `Date.now()`.
- Do not break existing tests.

---

## RESOLVED 2026-08-25 — the round-9 test conflict (read this before re-running)

The first attempt at this step implemented the spec correctly and then stopped at
`needs_context`, because the literal spec breaks one pre-existing test
(`connectors/gas/test_code.js`, the round-9 case
`same ref, same total: the date move itself is not an orphan`). That stop was correct:
the conflict is a financial-correctness decision, not an implementation detail.

**The conflict is real, and both sides were right about different things.**

`greenBeanPull_`'s date-move self-heal (`orderapp.gs:842-858`) rewrites the `Suppliers`
row's date in place and re-summarizes BOTH the old and the new week. Re-summarizing the
OLD week aggregates to **no row at all** for that key, and `upsertRows_` has no delete
path — so the old week's `Summary` row survives holding the full amount while the new
week also gains it. **The same money is then live at two weeks and `doGet` serves it
twice.**

- At the SUPPLIERS level the original assertion still holds: a re-dated invoice is not an
  orphan there (the ref is still in the pull), and orderapp's own sweep correctly stays
  silent.
- At the SUMMARY level it genuinely is an orphan. This step's detection is what surfaces it.

**Jake's decision (2026-08-25): accept it as a real finding.** The round-9 expectation is
changed from 0 alerts to 1, with the full reasoning written into the test body so a future
session cannot quietly revert it and re-silence the double-count. Detection alerts; the
gated manual sweep clears it. This is exactly the design this step already specifies —
detection automatic, deletion manual and backed up.

**Explicitly rejected**, do not re-propose:
- Narrowing the detection with a heuristic to suppress cross-week date-moves. It hides a
  genuine double-count, which is the failure mode this whole phase exists to prevent.
- Fixing the root cause by having the date-move self-heal delete the stale old-week
  `Summary` row. That adds an automatic `Summary` delete on the greenbean path, which this
  step's Prohibitions forbid and which the Tier 3 plan review ruled out as unrecoverable —
  `shopify_orderapp` rows cannot be regenerated.

**Therefore the "Do not break existing tests" Prohibition is narrowed for this one case
only:** the round-9 alert-count expectation may change from 0 to 1. Every other existing
test must still pass. Suite was green at **1446 passed, 0 failed** after the change.

Follow-up recorded for Step 5's `TODO.md` work: the greenbean date-move path mints a
Summary orphan every time it fires, so each occurrence needs a manual sweep. Fixing the
root cause safely is out of scope here and belongs in its own reviewed change.
