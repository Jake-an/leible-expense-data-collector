# Step 5 review response — round 1

## Finding: runner.py:169 — `--backfill` doesn't detect/fetch only missing weeks

**Status: not fixed — accepted as accurate about current behavior, but the suggested fix is
infeasible within this step's scope.**

The finding is correct that `main()`'s `--backfill` branch calls `last_n_closed_weeks()` and
requests the full 4-week range unconditionally, and that `missing_weeks_for_backfill()` (tested,
line ~48) is never called from `main()`.

The suggested fix — "query the ShopSpendPulls tab to extract the set of covered weeks" — requires
a hub-side HTTP read endpoint for `ShopSpendPulls` coverage. **No such endpoint exists.**
`docs/api.md` confirms `doGet` serves only the `Summary` tab; there is no mode that exposes
`ShopSpendPulls` rows or week coverage. Nothing in step 4 (`client.py`/`models.py`) or this step's
brief provides a way to fetch that data over HTTP, and building one would mean adding new `doGet`
behavior to `Code.gs` — which this step's own Task 4 requires to have **no behaviour change**
("Correct the two stale docs... This is a comment/doc change to `Code.gs` only — no behaviour
change to that file").

This gap was identified and disclosed during the original implementation (see
`phases/shopspend/step5-report.md`, "One gap, called out rather than silently punted") and is
tracked in project memory (`shopspend-backfill-coverage-gap.md`) as follow-up work for step 7
(`shopspend-watchdog-and-trigger`) or later, once a hub-side coverage-read capability exists.

It is not a correctness bug: step 3's ingest is fully idempotent (identical re-pulls come back as
`duplicatesSkipped`, not re-added), so over-fetching the full 4-week range on every `--backfill`
run costs one extra external API call and writes nothing new to the Sheet.

**No code change made for this finding** — implementing it would require adding a new GAS `doGet`
read capability, which is out of scope for `shopspend-runner-and-bridge` and violates this step's
own "no behaviour change to `Code.gs`" constraint.

## Finding: runner.py:125 — ruff format issues

**Status: fixed.** Ran `ruff format connectors/shopspend` — reformatted lines 125-126 (print
statement) and 156-158 (`--dry-run` `add_argument` call) to satisfy `ruff format --check`. No
logic changed. Verified: `ruff format --check connectors/shopspend` passes, `ruff check
connectors/shopspend` passes, `pytest connectors/shopspend -q` — 53 passed.
