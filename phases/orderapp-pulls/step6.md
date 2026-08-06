# Step 6: triggers-and-live-runbook

## Requirements Covered

- `PRD-10` — installs the Monday 05:00 Sydney trigger for `shopifyWeeklyPull` and writes the live bring-up runbook
- `PRD-11` — installs the Tuesday 05:00 Sydney trigger for `greenBeanPull`, same runbook

This is *why* this step exists. If the Task section below appears to contradict the
requirement above, `docs/ADR.md`, or a CRITICAL rule in CLAUDE.md, do NOT resolve the
conflict yourself — set `"status": "needs_context"` and stop.

**Scope note:** this step ends `completed` with code + runbook. The live bring-up
itself (token paste, deploy, probes) is Jake-manual and happens AFTER the phase-end
review gate — it is deliberately NOT a blocking step, because a phase whose terminal
step ends `blocked` never reaches the review gate (exit 2 fires first; this hid
criticals in a prior phase). PRD-10/PRD-11 therefore stay `planned` until the runbook's
probes pass, exactly like PRD-9 was flipped only at live verification.

## Files to Read

- `connectors/gas/orderapp.gs` (steps 0–4)
- `connectors/gas/shopspend.gs` (`installShopSpendWatchdogTrigger` — the idempotent delete-then-create trigger precedent) and its trigger tests in `connectors/gas/test_code.js` ("installing twice leaves exactly one trigger", weekday/hour/timezone assertions)
- `TODO.md` (the pre-phase cleanup block around lines 96–124 — the runbook must reference its state)
- `docs/api.md` (declared doc — doGet probe format)

## Task

1. **`installOrderAppTriggers()`** in `connectors/gas/orderapp.gs` — idempotent
   delete-then-create (mirror `installShopSpendWatchdogTrigger`):
   - `shopifyWeeklyPull`: `.timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(5).inTimezone('Australia/Sydney')` — 05:00 Monday runs after the 04:00 `weeklySummarize`; a lock collision is tolerated (loud-logged, counted, self-heals next week via the 4-week window).
   - `greenBeanPull`: same shape, TUESDAY, hour 5.
   - Running the installer twice leaves exactly one trigger per handler.
2. **Live bring-up runbook** — replace/append the relevant TODO.md section with a
   `## Order-app pulls — live bring-up (Jake + Claude, after phase merge)` checklist:
   1. **Pre-phase gate (deadline Mon 2026-08-10 04:00 AEST, BLOCKING):** run
      `runOnlineRevenueCleanupDryRun`; also inventory distinct `source` values on
      `kind=revenue, location=online` rows (Summary + Revenue, last 8 weeks).
      Decision tree: `found=0` → close the cleanup TODO as a no-op with evidence;
      `found>0` → full v23-grain-change runbook (resolve `resummarizable:false` /
      `channelCasings` warnings first, apply, `runOnlineRevenueResummarize`, keep the
      `Summary_online_revenue_backup` tab until the probes below pass). Miss-the-deadline
      fallback: delete the `weeklySummarize` trigger to buy a week, then complete.
      Reason this blocks: the cleanup's apply-scope (`kind=revenue AND location=online`,
      source-blind) would DELETE the new shopify_orderapp Summary rows.
   2. Jake pastes `ORDER_APP_COST_TOKEN` into hub Script Properties (Apps Script →
      Project Settings). Confirm `SHOPIFY_SHOP_DOMAIN`/`SHOPIFY_ACCESS_TOKEN` are absent
      and no `shopifyTriggerPull_`-era trigger exists.
   3. `bash scripts/deploy.sh` (note the printed rollback anchor).
   4. Editor-run `shopifyWeeklyPull` then `greenBeanPull`; check Logger counts.
   5. **After the first greenbean pull:** editor-run `weeklySummarize('<week>')` across
      the whole seeded 3-month window (don't wait for the overflow queue to drain over
      weeks).
   6. Run `installOrderAppTriggers` once.
   7. Probes (all `curl -sL` doGet with query params — NEVER bare `-d`/`-X POST`):
      - Order app: `?api=shopifySales&token=***&week=<last completed>` → `ok:true`; cross-check `summary.grossSales` vs the hub Summary row
      - Order app: `?api=greenBeanCost&token=***&from=<F>&to=<T>&status=ALL&include=summary` → grand total cross-foots with the sum of new `source='greenbean'` Suppliers rows
      - Hub: `?fn=summary&from=<ws>&to=<we>&department=Roastery&token=<API_READ_TOKEN>` → exactly one `supplier:'shopify_orderapp', kind:'revenue', location:'online'` row per completed week + greenbean spend rows
      - Double-count sweep: no other `location='online'` revenue row for those weeks from another source; no same-date/same-total Roastery Suppliers rows under differing sources
      - Negative: wrong tokens → hub `result:'error'`; Order app `{ok:false,error:'UNAUTHORIZED'}`
      - Idempotency: editor re-run `shopifyWeeklyPull` → `rowsAdded=0` (a settling week may legitimately show `rowsUpdated=1`)
   8. All probes green → flip PRD-10 and PRD-11 to `built` in docs/PRD.md with a
      commit message citing the probes.
3. **docs/api.md:** add a short note that Roastery weekly online revenue appears as
   `supplier='shopify_orderapp'` rows in `fn=summary` responses.

### Test First (TDD step)

Test cases (defined at design time — these are "done"):
- installing twice leaves exactly one trigger for `shopifyWeeklyPull` and one for `greenBeanPull`
- shopify trigger: weekday MONDAY, hour 5, timezone `Australia/Sydney`
- greenbean trigger: weekday TUESDAY, hour 5, timezone `Australia/Sydney`
- installer does not delete unrelated triggers (fixture with `shopSpendWatchdog` trigger present → still present after install)

## Acceptance Criteria

```bash
node connectors/gas/test_code.js
```

## Verification Procedure

1. Run the AC command.
2. Checklist: runbook in TODO.md is complete and self-contained (a future session could execute it without this phase's context); PRD-10/11 remain `planned` in docs/PRD.md at this step's completion.
3. Update this step in `phases/orderapp-pulls/index.json`.

## Prohibitions

- Do not flip PRD-10/PRD-11 to `built` in this step. Reason: they flip only when the live runbook's probes pass (PRD-9 precedent — live-verified before flip).
- Do not run `bash scripts/deploy.sh`, `clasp push`, or any deploy from this step. Reason: deploy needs `ORDER_APP_COST_TOKEN` in place and the pre-phase cleanup gate closed — both Jake-manual; the runner's phase-end gates must run first.
- Do not mark this step `blocked` for the manual items. Reason: they are deliberately post-phase (see Scope note); a blocked terminal step skips the phase-end review gate.
- Do not break existing tests.
