# Step 5 review response — round 2

## Finding: runner.py:175 — `--backfill` spec/code contradiction needs audit resolution

**Status: not fixed — evidence confirms the finding's factual claims; the requested action is a
product/spec decision outside the scope of an autonomous code fix.**

### Verification

Re-read `connectors/shopspend/runner.py:161-171` (current `HEAD`). Confirmed unchanged from round
1: `--backfill` branch (169-171) calls `last_n_closed_weeks(today, _BACKFILL_WEEKS)` and requests
the full `candidates[0]..candidates[-1]` range unconditionally. `missing_weeks_for_backfill()` is
implemented and tested but never called from `main()`. The finding's description of current
behavior is accurate.

### Why no code change was made

This round's finding does not claim the round-1 rebuttal is wrong — it explicitly says "the
rebuttal correctly notes no hub read endpoint exists for ShopSpendPulls." What it asks for is
resolution of a genuine contradiction *within the step brief itself* (`phases/shopspend/step5.md`
lines 74-76 mandate gap-detection; Task 4, line 94, forbids any `Code.gs` behaviour change; a hub
read endpoint requires exactly that). It offers three resolution paths:

- **(a) Implement the hub read, relaxing Task 4.** Not taken: Task 4's "no behaviour change to
  Code.gs" is an explicit constraint of *this* step, and the step's own Prohibitions section
  (lines 139-150) restricts this step to the poster/CLI/doc-comment surface. Silently relaxing a
  named constraint of the step brief to satisfy a different clause of the same brief is a scope
  decision I'm not positioned to make unilaterally — it's exactly the kind of contradiction that
  needs a human call, not a unilateral pick between two conflicting spec lines.
- **(b) Update the step brief to acknowledge deferral.** Not taken: `phases/shopspend/step5.md` is
  the spec this step is graded against, not an implementation artifact. Editing the spec to match
  what was actually built — after the fact, without Jake's sign-off — is self-grading and isn't
  something I'll do from inside a "fix review findings" pass.
- **(c) Document Jake's explicit waiver.** Not taken: no such waiver exists in this conversation.
  I won't fabricate one.

### Disposition

This is a real spec-code mismatch, already disclosed twice (`step5-report.md` "One gap, called out
rather than silently punted"; `shopspend-backfill-coverage-gap.md` project memory) and now
confirmed accurate by two independent reviews. Resolving it requires Jake to pick (a), (b), or a
fourth option he prefers — not something this pass can close out. Flagging as **blocked pending
Jake's decision** rather than guessing. No files changed for this finding.

**Behavior in the meantime remains safe**: step 3's ingest is idempotent, so over-fetching the full
4-week range on `--backfill` costs one extra API call and writes nothing new.
