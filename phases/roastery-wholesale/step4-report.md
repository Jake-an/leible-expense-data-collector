# Step 4 (wholesale-pull) — needs_context

## Status

Implementation (`wholesalePull` / `wholesalePull_impl_` in `connectors/gas/orderapp.gs`)
is complete per the step spec and passes **1968/1976** assertions
(`node connectors/gas/test_code.js`). The 8 remaining failures trace to exactly
**two isolated defects in the already-committed RED test fixture**, not to the
implementation. Both are proven below with evidence, not just asserted — no
implementation can satisfy the fixtures as written. Left uncommitted-fixed per
"do NOT weaken, skip, or delete the RED-phase tests to force a pass."

## Defect 1 — case1's fixture is mathematically incompatible with case12's floor test

`case1` (the happy-path test) builds its fixture via `cleanFixtureSet('c', 100)`,
giving the **newest** week (`weeks3[2]`) a single order of `amount: 102`
(`amountBase=100 + i=2`). It then asserts `heartbeatStamped === true`.

`case12` explicitly and precisely tests `WHOLESALE_GROSS_FLOOR` (=800) on the
same "newest week" concept: newest gross `799` → heartbeat **NOT** stamped;
`801` → heartbeat **IS** stamped.

Both `102` and `799` are on the **same side** of the `800` threshold (both
below it). A single monotonic floor check applied to "the newest week's own
wholesale-channel gross" (per the step-4 spec: "AND its `wholesale`-channel
gross ≥ `WHOLESALE_GROSS_FLOOR`") **must** produce the same boolean for both —
yet case1 requires `true` for the smaller value ($102) while case12a requires
`false` for the larger one ($799). This is not an ordering/implementation
question; it is a direct logical contradiction. Confirmed empirically: with the
floor gate implemented exactly as spec'd, case12a/case12b (and every other
case) pass, and case1 fails on precisely (only) its two heartbeat assertions:

```
FAIL- case1: heartbeatStamped true
FAIL- case1: heartbeat actually stamped
```

Cross-checking every OTHER case in the suite that asserts `heartbeatStamped`
truthy — case4a (base 900), case12b (801), case17 (base 900) — all use a
newest-week gross that clears the $800 floor. case1 is the sole outlier still
using `amountBase=100` (likely inherited from an earlier draft written before
the floor gate was finalized).

**Suggested fix** (for whoever owns the test file): change case1's fixture to
`cleanFixtureSet('c', 900)` (or any base ≥ 800), matching every sibling
heartbeat-true case. This does not touch any other assertion in case1 (row
amounts/dates/channels are unaffected by the base value's magnitude).

## Defect 2 — case8's fixture never reaches weeksWithArchivedRows_'s fail-closed branch

`case8` intends to test the fail-closed path: `_archive` has an unreadable
header (no `date` column) → every requested week is reported split. Its setup:

```js
ensureSheet(currentSS, ARCHIVE_TAB, ['when', 'supplier', 'total']); // no 'date' column -> unreadable
```

— creates the tab with a bad header but **appends no data row**. The existing,
already-committed, independently-tested `weeksWithArchivedRows_` (`Code.gs:1646`)
short-circuits before ever inspecting the header:

```js
if (!arch || arch.getLastRow() < 2) return [];
```

A header-only sheet has `getLastRow() === 1`, so this returns `[]`
unconditionally — the "no date column" fail-closed branch is never reached.
The sibling **passing** test for this exact behavior
(`test_code.js:11216-11223`, "unreadable archive header reports every week as
split (fails closed)") DOES append a dummy data row first:

```js
const arch = ensureSheet(currentSS, ARCHIVE_TAB, ['when', 'supplier', 'total']);
arch.appendRow(['2026-07-22', 'Food and Dairy Co', 100]);
```

case8 is missing the equivalent `appendRow`. Confirmed empirically — with my
per-week `weeksWithArchivedRows_([week.start])` call implemented exactly per
spec, ALL SIX of case8's assertions fail in exactly the way this theory
predicts (nothing detected as split, so the run proceeds as if fully clean):

```
FAIL- case8: every requested week is reported split (fail-closed)  (got 0)
FAIL- case8: nothing written at all  (got 3)
FAIL- case8: a DQ alert was raised
FAIL- case8: heartbeat NOT stamped
FAIL- case8: Revenue has no data rows
FAIL- case8: the log distinguishes the fail-closed case from a genuine split
```

**Suggested fix**: add `ensureSheet(...).appendRow([...])` (any row with a
value in the 'when' column, mirroring the sibling test) to case8's fixture,
right after `ensureSheet(currentSS, ARCHIVE_TAB, ['when', 'supplier', 'total'])`.

## What's implemented and verified clean (17 of 20 test cases fully green)

case1 (all but 2 heartbeat asserts), case2 (dryRun), case3 (partial-week
failure), case4a/4b (8-week-window rule), case5 (cross-foot mismatch), case6
(drop-subtracted cross-foot), case7 (genuine split), case9 (date-move
self-heal, mutation-provable), case10 (unexplained collision), case11
(zero-activity newest week), case12a/12b (floor boundary), case13 (ambiguous
still written), case14a/b/c (conflict signature gating), case15 (lock
timeout), case16 (no token), case17 (idempotency), case18 (never
Summary-direct), case19 (diagnostic buckets never ingested), case20 (resum cap
+ overflow queue).

## Recommended next step

Have a human (or a fresh dispatch with test-file write authority — this GREEN
sub-phase is scoped to `connectors/gas/orderapp.gs` only, not the test file)
apply the two one-line fixture fixes above, then re-run
`node connectors/gas/test_code.js`. No implementation changes are expected to
be needed based on the analysis above, but the full suite should be re-verified
once the fixture is corrected.
