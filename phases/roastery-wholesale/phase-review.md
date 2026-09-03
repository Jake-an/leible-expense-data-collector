# Phase-end review — `roastery-wholesale` (PRD-14)

Run 2026-09-04, out of band. The phase-end gate never fired on its own: `execute.py` exits
2 when the terminal step is `blocked`, so a phase paused at step 7 never reaches it.

**Scope:** `4836218..HEAD` (the phase scaffold landed in `41db8cc`), excluding
`phases/**/*.log`. Explicitly **not** `main...HEAD` — `main` is ~297 commits stale here.

> The prior handoff named `cdf4bc4` as the step-4 commit. That SHA does not exist; the real
> one is **`cdf4bc6`**. It also scoped the review to `73f49c5..98bcb95`, which covers only
> the steps 5–6 tail — step 4's code is an *ancestor* of that range and would have been
> reviewed as nothing.

## Verdict

**No blocking defects on the money path.** Step 4 — which escaped both review gates — fails
closed at every branch traced. Six findings, all now fixed or documented.

### Verified correct (traced, not assumed)

- **Heartbeat week.** `weeks[len-1]` looks like an off-by-one; `lastCompletedWeeks_` is
  oldest-first, so it genuinely is the newest week.
- **Cross-foot cannot throw.** Every bucket in `WHOLESALE_SHOPTYPE_MAP_` is in the shape
  gate's validated bucket list, so `bucketObj.gross` is always present.
- **`dryRun` writes nothing** — all six branches checked: no ingest, no heal cells, no
  queue write, no `weeklySummarize`, no heartbeat, no DQ alert.
- **Split guard runs before the write**, per week, and fails closed on an unreadable archive.
- **Cross-foot is integer cents end to end**, correctly subtracting orders the producer
  counted but the stricter row validator rejected.

## Findings

| # | Sev | Finding | State |
|---|---|---|---|
| F1 | Med | `wholesalePull` dropped `greenBeanPull`'s undrained-backlog log, so a growing queue was invisible to a trigger-invoked run | **fixed** |
| F2 | Med | Resummarize queue can starve head-of-line: a split week is refused every run, never clears, and the oldest-first cap lets stuck weeks consume it permanently. Inherited from `greenBeanPull`; wholesale is more exposed (8-week window, self-heal enqueues arbitrary old weeks) | **open — needs a strategy decision** |
| F3 | Low | The "ingest-return assertion" never reads `ingestRes.duplicatesSkipped`; it detects within-batch collisions from `mapped.rows` alone. The detection is correct and valuable — the comment overclaimed | **comment corrected** |
| F4 | Low | Paging gate used `isFinite(Number(x))` where money fields use strict `typeof`; `null`/`''`/`[]`/`false`/`'200'` all passed | **fixed + 7 tests + mutation-checked** |
| F5 | — | *Withdrawn.* I claimed `weeksFetched` overcounts. It does not — it means "fetched AND shape-valid", identical to its `shopifyWeeklyPull` sibling. The real gap was no end-to-end counter | **`weeksWritten` added** |
| F6 | Low | `snapshot.storedDate` not refreshed after a date heal, so a ref recurring in a later week re-heals and double-counts `datesHealed` | **fixed + case9b + mutation-checked** |

## Findings from the step 5 / step 6 pass

| # | Sev | Finding | State |
|---|---|---|---|
| E1 | **High (docs)** | Step 6 docs asserted `LIVE` / "shipped" / "written in production today" for a connector that has never run and is not deployed — directly contradicting `docs/PRD.md`, which correctly still says `planned`. A future session reading `schema.md` would believe it was live | **corrected to BUILT, NOT YET LIVE** |
| E2 | **High (ops)** | Arming staleness ahead of the writer re-opened the exact false alarm the original comment warned about. `staleness.gs:259` marks a never-seen source `stale: true` **before** any threshold is applied, so the 168h override gives zero protection. Between step 7's push and step 8's first heartbeat, `coffee_order_app` alerts on every run | **documented in both runbooks; mitigation = run 7 and 8 in one sitting** |
| E3 | Med | **Run 1 will not stamp a heartbeat.** The resummarize cap drains oldest-first, so with all 8 window weeks affected the *newest* week lands in the overflow and `newestResumOk` cannot be satisfied. Self-corrects on run 2 | **asserted by test (case20b); documented in the rehearsal** |
| E4 | Low | `installOrderAppTriggers` deletes and recreates `shopifyWeeklyPull` and `greenBeanPull` too — both live. Idempotent against code, but silently reverts any hand-adjusted timing | **documented in the step 7 runbook** |

E3 is F2's head-of-line problem showing up on the very first real run. Fixing F2 as
"always summarize the newest affected week + 4 oldest" would resolve both.

## Test state

| Gate | Result |
|---|---|
| `node connectors/gas/test_code.js` | 2023 passed, 0 failed (baseline 1993 → +30) |
| `python -m pytest scripts/test_execute.py -q` | 283 passed |
| `bash scripts/lint.sh` | clean, 106 files |
| Live Sheet | **never run** — PRD-14 stays `planned` until step 8 |

Mutation checks performed: oauthScopes gate (drop Calendar scope → 1 fail), F4 paging gate
(revert to loose → exactly 6 fail, `offset:0` guard still passes, proving no over-tighten),
F6 snapshot update (remove → case9b fails with `got 2`, the predicted double-heal).
