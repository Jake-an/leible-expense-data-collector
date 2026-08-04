# Step 0: ensure-sheet-empty-headers

## Requirements Covered

- `PRD-7` — shopSpend ingest + snapshot store: POSTing via `doPost` into append-only `ShopSpend` +
  `ShopSpendPulls` tabs.
- `PRD-8` — shopSpend reporting + data-quality surfacing: the `ShopSpend Report` tab.

Both requirements depend on the three shopSpend tabs being creatable at all. Today the first
production `doPost` for `kind: 'shopspend'` throws before any of it happens (see Task).

This is *why* this step exists. If the Task section below appears to contradict the requirement
above, `docs/ADR.md`, or a CRITICAL rule in CLAUDE.md, do NOT resolve the conflict yourself and do
NOT proceed on your best guess — set `"status": "needs_context"` with the contradiction spelled out
in `needs_context_detail`, and stop.

## Files to Read

- `connectors/gas/Code.gs` — `ensureSheet` at lines 675-685 (the function being fixed)
- `connectors/gas/shopspend.gs` — `ensureShopSpendTabs_` at lines 16-22 (the only caller that
  passes empty headers, line 20)
- `connectors/gas/test_code.js` — the mock sheet factory, `getRange` at line 113 (the mock being
  fixed); the four existing `ensureSheet` callers' tests
- `docs/ARCHITECTURE.md` — the two-runtime boundary

Read the code and understand the design intent before starting.

## Task

### The defect (critical, C2 from the phase-end review)

`connectors/gas/shopspend.gs:20` calls:

```js
report: ensureSheet(ss, SHOPSPEND_REPORT_TAB, [])
```

`ensureSheet` (`Code.gs:675-685`) then runs, for a tab that does not yet exist:

```js
sheet.appendRow(headers);                          // appendRow([]) — no-op-ish
sheet.getRange(1, 1, 1, headers.length)            // getRange(1, 1, 1, 0)  <-- real GAS THROWS
  .setBackground('#a5b89d')...
sheet.setFrozenRows(1);
```

Real Google Apps Script rejects `getRange(row, col, numRows, numCols)` when `numCols < 1`. The
`ShopSpend Report` tab is created deliberately headerless (its layout is written by the report
builder, not by `ensureSheet`), so the **first** production `doPost` that has to create the tabs
throws and no shopSpend data is ever ingested.

### 1. Fix the mock FIRST — otherwise the test is vacuous

`connectors/gas/test_code.js:113`:

```js
getRange: (row, col) => makeRangeChain(row, col),
```

The mock accepts `getRange` with **any** arguments and silently discards `numRows` / `numCols`.
That is precisely why 705 node tests passed over a crash that real GAS raises on the first call.

Change the mock so that `getRange` records all four arguments and **throws** when the geometry is
invalid — specifically when `numCols` or `numRows` is present and `< 1`. Mirror real GAS: a call
with only `(row, col)` stays legal; a call with an explicit `numCols` of `0` must fail.

Fixing the mock is part of the fix, not an aside. A green run against the old mock proves nothing
about this defect.

### 2. Guard `ensureSheet`

In `Code.gs:675-685`, guard the header write, the styling `getRange` chain, and `setFrozenRows` on
`headers && headers.length`. A tab created with empty headers must still be **created** and
returned — it simply gets no header row, no `#a5b89d` styling and no frozen row.

Behaviour for non-empty headers must be **byte-identical to today**: the header row is appended,
`getRange(1, 1, 1, headers.length)` is styled `#a5b89d` / white / bold, and row 1 is frozen.

The four existing callers all pass non-empty headers and never reach the new branch — this change
is zero-risk to them, and a test case asserts it.

### Test First (TDD step)

1. Write the failing test(s) for the cases below *before* any implementation. Use the
   `ecc:tdd-guide` agent to drive the red-green-refactor loop.
2. Confirm the test fails (red) for the right reason — a missing guard / a mock that does not yet
   enforce geometry, not a broken test file.
3. Implement the minimum to pass (green), then refactor while keeping tests green.

Test cases (defined at design time — these are "done"):

- The **mock itself** fails a deliberate `getRange(1, 1, 1, 0)` — assert the fixed mock throws.
  Write this case first; it is the case that proves the other cases are not vacuous.
- `ensureSheet(ss, name, [])` on a **missing** tab creates the tab, returns it, and never calls
  `getRange` with `numCols < 1`.
- `ensureSheet(ss, name, [...non-empty])` behaves exactly as today: header row appended, the
  header range styled `#a5b89d` with white bold text, `setFrozenRows(1)` called.
- An **existing** tab is untouched by either path (no re-append, no re-style).
- All four existing `ensureSheet` callers still get their header rows (assert against the real
  `*_HEADERS` constants, not literals).
- `ensureShopSpendTabs_` creates all three tabs — `ShopSpend`, `ShopSpendPulls` and the headerless
  `ShopSpend Report` — without throwing.

## Acceptance Criteria

```bash
node connectors/gas/test_code.js     # all tests pass, including the cases above
```

## Verification Procedure

1. Run the AC command above.
2. Check the architecture checklist:
   - Does it follow the directory structure in `docs/ARCHITECTURE.md`?
   - Does it stay within the tech stack defined in `docs/ADR.md`?
   - Does it not violate the CRITICAL rules in CLAUDE.md?
3. Update this step in `phases/shopspend-hardening/index.json`:
   - Success → `"status": "completed"`, `"summary": "one-line summary of output"`
   - Failure after 3 retry attempts → `"status": "error"`, `"error_message": "specific details"`
   - User intervention required → `"status": "blocked"`, `"blocked_reason": "specific reason"`,
     then stop immediately

## Prohibitions

- **Do NOT run `bash scripts/deploy.sh`, `clasp push`, `clasp deploy`, or any other deploy command
  in this step.** Reason: this phase is under a deploy embargo until its phase-end review gate
  passes and the branch is merged to `feat-shopspend`. There is no safe intermediate deploy point;
  deploying mid-phase reinstates the exact bugs the phase fixes. This overrides CLAUDE.md's "deploy
  when GAS coding is finished" rule for this phase only.
- Do not relax the mock's new geometry assertion to make an unrelated test pass. Reason: a
  permissive mock is the root cause of this defect surviving 705 green tests. If the stricter mock
  reddens another call site, that call site has a real bug — fix it or report it in `summary`.
- Do not change any `*_HEADERS` constant. Reason: editing a headers constant does nothing to an
  existing live tab (`ensureSheet` only writes headers when the tab is missing) and would silently
  desynchronise the code from the live Sheet.
- Do not touch any Python file in this step. Reason: this is a single-runtime (GAS) step; its
  `test_cmd` is node-only and would not exercise a Python change.
- Do not break existing tests.
