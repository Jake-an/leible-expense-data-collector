# TODO Archive — LEIBLE Expense Data Collector

Finished work moved out of `TODO.md` so that file stays scannable
(see the TODO hygiene rule in `~/.claude/CLAUDE.md`). Nothing here is active.

---

## Mayers North Sydney never maps — `BLUES ST` regex miss — ✅ FIXED + BACKFILLED 2026-08-24

**Outcome.** Four misfiled rows repaired, $2,713.64 moved to the right shops.
Verified live via doGet against `downloads/mayers-repair-baseline-2026-08-24.json`:

| Post-condition | Result |
|---|---|
| Mayers span total | **$5,127.89**, unchanged — money moved, not created or lost |
| Mayers rows still `UNMAPPED:` / blank | **0 / 0** |
| Leible North | $0.00 → **$1,976.90** |
| Leible York | $703.80 → **$1,440.54** (+$736.74) |
| All 7 invoices at the right shop | exact match vs the census |
| `Bennetts` $14,219 (unrebuildable) | intact |
| Duplicate Mayers rows | 0 |
| Non-Mayers rows, weeks 07-06 / 07-20 / 07-27 | byte-identical |

**How it shipped.**

1. `cb3fde6` — `mayersShopFromText_` rewritten two-pass (Deliver-To block first,
   then a byte-identical whole-text retry so it can only ever *reassign* a shop,
   never lose one), `/\bBLUE\s*ST/i` → `/\bBLUES?\s*ST/i`,
   `MAYERS_PARSER_VERSION` 1→2. Fixtures rebuilt from **real Drive OCR**
   (`connectors/gas/fixtures_mayers_ocr.js`) — the deleted assertion had tested a
   singular `BLUE ST` that no Mayers invoice has ever contained, which is how
   1112 green tests coexisted with a live money bug for two months.
2. `3001a74` — `mayers_repair.gs`, one function with dry-run/apply behind a mode
   flag plus five zero-arg editor wrappers. **Deleted at cleanup.**
3. `f16e90b` — compact dry-run report: the full JSON overflowed the Apps Script
   log, and an approval read off a truncated log approves a list nobody has seen.
4. `36ee01f` — Jake approved the literal key list; all four DELETE tuples matched
   the pre-derived table byte-for-byte.
5. Applied 2026-08-24 12:54–12:55, one invocation per week.

**What the live run confirmed that only live data could.** The stored `UNMAPPED`
hint really is **exactly 60 characters** (`locLen=70` = `UNMAPPED: ` + 60), on all
three North rows. Any `hint.length >= 60 → quarantine` gate would have dropped
`resolvable` to 0 and turned the entire repair into a silent no-op.

**Week 2026-07-27 really does hold two $570.15 Mayers rows** (3446281 → North,
3449495 → Crows Nest). The verification summed both — `mayersWeekTotalBefore`
and `After` were $1,140.30 — instead of assuming one, which is the false-positive
a naive "no duplicate rows" check would have hit.

**Side effect, pre-approved.** Re-summarizing week `2026-06-15` also landed
**$3,176.95** of unrelated spend that was sitting in `Suppliers` and had never
reached `Summary`, including three shop/supplier combinations reading $0 in
reports (Food and Dairy Co @ North, Fresh and Chill @ North, Fresh and Chill @
Pitt). That is a separate, larger problem — see
`memory/summary-goes-stale-against-suppliers.md`.

**RETAINED IN PRODUCTION — do not clean up.** `Summary_mayers_location_backup`
(only copy of the 4 deleted Summary rows) and the four
`MAYERS_REPAIR_SNAPSHOT_<week>` script properties. `restoreMayersLocationSnapshot()`
lives in `mayers.gs` and is the only code that consumes them.

**Rejected, do not re-raise.** Account-code matching (`/Account:\s*(LEI\d+D)/i`)
— genuinely more robust than addresses, but Jake chose address matching on
2026-08-20: *"lets go with address"*. Recorded in
`docs/mayers-location-fix-decisions.md` § HARVEST READ.

<details>
<summary>Original TODO entry, as written before the fix</summary>

### Mayers North Sydney never maps — `BLUES ST` regex miss (found 2026-08-08, NOT fixed)
**Census refreshed 2026-08-20** via doGet `fn=summary` (2026-01-01..2026-08-20). All seven
Gmail invoices are in the Sheet, one Summary row each; Mayers total **$5,127.89**.
**Four rows are misfiled, $2,713.64** — not the two originally recorded:

| Week | Ref | Amount | Stored `location` |
|---|---|---|---|
| 2026-06-15 | 3429816 | $736.74 | `''` blank — **YORK**, historical: predates shop attribution |
| 2026-07-06 | 3437634 | $703.75 | `UNMAPPED: … 5 BLUES ST …` |
| 2026-07-20 | 3442003 | $703.00 | `UNMAPPED: … 5 BLUES ST …` |
| 2026-07-27 | 3446281 | $570.15 | `UNMAPPED: … 5 BLUES ST …` |

Every consumer buckets these to `Other` instead of `North` (confirmed downstream in
`LEIBLE_GM_COST_MONITOR/ExpenseAPI.gs` — `normaliseShopKey` returns `'Other'`).

**All four shops DO order from Mayers** (York 06-29, Crowsnest 07-27, Pitt 08-10 all map
correctly) — so this is a naming/regex fault, not a delivery-cadence or missed-forward
gap. Jake confirmed 2026-08-20: **"if you see 5 blue street it is north sydney invoice."**
That closes the "is ~7 invoices/2 months real?" question: yes, ~1 invoice per shop per
3-4 weeks, nothing missing upstream.

**Trap — week 2026-07-27 legitimately holds TWO Mayers rows of the same $570.15**
(3446281 → North, 3449495 → Crowsnest; identical standing orders, forwarded 15s apart).
Any "no duplicate Mayers rows" verification **false-positives**. Assert on `invoice_ref`.

**Blank row resolved 2026-08-20 (harvest + local PDF):** `3429816` is a **York**
invoice (`Deliver To: 89 YORK ST`, `Account: LEI05D`), NOT North. It is blank only
because it was ingested 2026-06-17, five days before `mayersShopFromText_` existed
(`ff51fab`, 2026-06-22) — there was no attribution logic to run. **The widened `BLUES`
regex does NOT fix it.** The repair is two sets: **North +$1,976.90** (3437634, 3442003,
3446281) and **York +$736.74** (3429816). Repairing it as North would misplace $736.74.

**Totals are all CORRECT** — no dollar backfill needed, so "week grand totals unchanged"
stays a valid invariant. TODO #8 confirmed not-a-defect on real OCR.

**Open recommendation:** every invoice carries a stable account code — `LEI04D`
Roastery/Crows Nest, `LEI05D` York, `LEI06D` Pitt, `LEI07D` North Sydney. Matching
`/Account:\s*(LEI\d+D)/i` is immune to `BLUE`/`BLUES` and to all address/OCR variance.
New evidence since the grill, so it is a legitimate reason to re-open decision 1 —
Jake's call. See `docs/mayers-location-fix-decisions.md` § HARVEST READ.

**Trap — the stored UNMAPPED hint is EXACTLY 60 chars** (`slice(0,60)` boundary). A
`hintSuspect >= 60 → quarantine` gate quarantines all three UNMAPPED rows, drops
`resolvable` to 0 and aborts the repair as a no-op. `BLUES ST` sits at chars 29-37.

Root cause — `connectors/gas/mayers.gs:27`:
```js
{ re: /\bBLUE\s*ST/i, shop: 'Leible North' },   // invoice says "5 BLUES ST"
//        ^ needs S?    \bBLUE matches "BLUE" inside "BLUES", \s* matches nothing,
//                      then "ST" is required but the next char is "S" → no match
```

- [x] **Evidence step shipped 2026-08-14** (branch `feat-mayers-location-fix`,
      `connectors/gas/mayers_harvest.gs`, pushed NOT deployed — it is an editor-run
      diagnostic, `/exec` is untouched). Run `runMayersOcrHarvest()` in the editor; it
      writes a Google Doc of REAL Drive OCR text for up to one invoice per shop, plus
      each invoice's verdicts under today's regexes. Read-only: no Suppliers/Summary
      writes, no Gmail labels. **This gates the fix below** — `pdftotext` is NOT a valid
      proxy for Drive OCR (measured: the real invoice PDF failed all three production
      regexes under pdftotext while that same invoice ingested fine live), so neither
      the Deliver-To scoping nor TODO #8 can be settled offline. Delete the file when
      the parser work closes.
- [ ] Fix + backfill. **Tier-3 work — mutates production Sheet rows; give it its own plan.**
      **Decisions already locked → `docs/mayers-location-fix-decisions.md` (2026-08-14).**
      Read it before planning: fix shape, safety gate, sweep scope, repair method and
      verification invariants are all settled, and it records what NOT to rediscover.
      Three traps already investigated (2026-08-08) — do not rediscover them:
      1. `mayersShopFromText_` tests each rule against the **whole** invoice text, and the BLUE
         rule precedes Crows Nest (`mayers.gs:24-29`). Widening to `/\bBLUES?\s*ST/i` could steal
         another shop's invoice if "5 Blues St" appears in a bill-to/head-office block — today
         that misfire is impossible *because* the regex never matches. Pre-flight: dump the OCR
         text of a known Crows Nest / York / Pitt invoice and grep for `BLUES` before flipping;
         if present outside Deliver-To, scope the match to the Deliver-To capture instead. Add a
         Crows-Nest-with-stray-BLUES regression case beside `test_code.js:683`.
      2. `SUMMARY_KEY_COLS = [0,6,7,2,3]` **includes `location`** (`Code.gs:65`). Rewriting a
         row's location and re-summarizing therefore *orphans* the old Summary row instead of
         updating it (`upsertRows_` has no delete path) → the same money is served twice. The
         backfill must delete the stale `UNMAPPED:` Summary rows explicitly, in code, inside
         `withScriptLock_` (re-entrant via `SCRIPT_LOCK_DEPTH_`, `Code.gs:104-109`).
      3. Re-summarize needs the **override** form — `weeklySummarize('2026-07-20')` and
         `('2026-07-27')`. The bare form does only the last completed week and also fires
         `archiveAndPurge_` (`Code.gs:1800`). It returns `{refused:…}` on lock contention with
         **no throw** (`Code.gs:1755-1758`, and `refused:'incomplete-week'` at 1793) — assert the
         return value; "no error" is not success.
         **Field names (verified 2026-08-15, `Code.gs:1854-1855`): `summariesAdded` /
         `summariesUpdated`** — NOT `rowsAdded`/`rowsUpdated`, which is what an earlier draft of
         this list and `decisions.md` decision 7 both said. Assert on the wrong names and you are
         doing arithmetic on `undefined`: `undefined + undefined` is `NaN`, so a
         `sum > 0` assert always FAILS and a `sum === 0` guard never fires — vacuous in whichever
         direction it is written. (`upsertRows_` is the one that returns `rowsAdded`/`rowsUpdated`;
         `weeklySummarize` renames them on the way out.)
      Verification that catches the double-count: week **grand totals unchanged**, `North` up by
      exactly **$703.75 / $703.00 / $570.15** (plus **$736.74** if the blank row resolves),
      `Other` down by the same, **no duplicate `invoice_ref`**.
      NOT "no duplicate Mayers rows" — wk 2026-07-27 legitimately has two $570.15 rows
      (see the census + traps at the top of this section).

</details>

---

## Summary drift — $288,852.51 across 143 weeks — root cause + repair history (2026-08-25, superseded 2026-08-26)

**Superseded by the "Summary drift — SELF-HEALING GUARDS LIVE" section in `TODO.md`**
(phase `summary-self-heal`). Kept here for the root-cause narrative and repair
receipts; the open decisions below are now resolved — see `TODO.md` for the
current policy and the two guards that ship it.

`auditSummaryDrift()` (`connectors/gas/summary_audit.gs`, read-only) over all
**169** completed weeks, 2026-08-25 08:09:

| | weeks | $ |
|---|---:|---:|
| Rebuildable — every source row still in `Suppliers`, none in `_archive` | 136 | **237,064.62** |
| `SPLIT` — rows in BOTH `Suppliers` and `_archive`, refused (see below) | 24 | **114,310.43** |
| **Total drifted** | **160 of 169** | **351,375.05** |

**500 rows missing, 0 stale.** Whole supplier@shop rows are absent, reading $0
in every report.

**Why it tripled overnight — a silent success reported as a failure.** The
pagination fix (`516252b`) made the Ordermentum connector walk every invoice
page. The scheduled run at **2026-08-25 03:29** read ~1000 invoices per venue
instead of the usual 188 rows, POSTed them, and hit the client's 300s timeout —
`exit=1`, logged as a failure. **GAS had already ingested them.** Three years of
invoice history (back to `2023-05-29`) landed in `Suppliers` with no run
anywhere claiming success. Fixed in `0bd2521`: the POST timeout is now 600s,
above the 360s GAS ceiling, since a client timeout below it turns a server-side
success into a reported failure.

**The `_archive` double-count was live, not hypothetical.**
`ingestSupplierRows` dedups against `Suppliers` only — it never consulted
`_archive`. So re-ingested historical invoices landed beside their archived
copies. `auditSummaryDrift_` concatenated both tabs **without deduping on
`invoice_ref`**, so the $114,310.43 on those 24 weeks was inflated by an unknown
amount until fixed.

**Never re-summarize a `SPLIT` week.** `weeklySummarize_impl_` recomputes
from `Suppliers` ONLY and `Summary` upserts, so a week straddling the archive
cutoff gets its live `Summary` row overwritten with the partial total — turning
missing money into *understated* money, which hides far better. The predicate is
"no `_archive` rows at all", NOT the audit's `sourceRowsStillPresent`.
`summaryDriftRepairPlan_()` enforces this; mutation-tested 2026-08-24. This is
still true and still enforced — the self-heal window inherits the same guard.

**The old end is truncated.** `INVOICE_PAGE_LIMIT = 40` (1000 invoices) cut
one supplier off mid-history — `2023-05-29` is where the window ran out, not
where trading began. Still open — see `TODO.md`.

- [x] Zero-arg repair wrapper with the SPLIT guard — `connectors/gas/summary_drift_repair.gs` (`12fde6b`, deployed v35)
- [x] POST timeout raised above the GAS ceiling — `0bd2521`
- [x] **`_archive` made consistent 2026-08-25.** Three defects, all fixed and
      deployed (v37–v39):
      - `ingestSupplierRows` never consulted `_archive`, so purged invoices were
        re-appended to `Suppliers` (`6dc5e5b`; returns `archivedSkipped`).
      - `archiveAndPurge_` appended with no dedup, so every re-ingest-then-purge
        cycle added ANOTHER `_archive` copy — up to **7 copies** of one invoice
        (`0734916`).
      - `auditSummaryDrift_` summed both tabs without deduping, then deduped only
        against `Suppliers` and not `_archive` against itself (`6dc5e5b`,
        `4b141df`).
- [x] **Drift figure now trustworthy: $288,852.51.** Reconciled two ways —
      $342,224.38 − $20,624.23 (cross-tab dedup) − $32,747.64 (same-tab dedup)
      = $288,852.51, and the removed total $53,371.87 equals
      `auditArchiveDuplicates()`'s independently-computed over-count exactly.
      `stale` stayed 0 throughout, so none of the duplication sat in groups
      already present in `Summary`.
- [x] **Approved window fully closed.** All 143 remaining drifted weeks are past
      the purge line, so `runSummaryDriftRepairDryRun()` now has nothing to
      repair inside `SUMMARY_REPAIR_MIN_WEEK_`.
- [x] **Ingest confirmed PARTIAL and completed 2026-08-25.** The re-run returned
      `read 2644 rows -> rowsAdded: 622, duplicatesSkipped: 2022` — the 03:29 POST
      had landed only 2022 of 2644 rows before GAS hit its own limit. Any plan
      computed before this re-run was stale.
- [x] **Approved window repaired 2026-08-25 09:18 — 18 weeks, +$94,348.88.**
      `runSummaryDriftRepair()`: 18 ok, 0 failed, 0 not attempted, 101s.
      `Summary` 155 → 337 rows, $329,894.37 → $424,243.25, verified by doGet
      before/after. **182 rows added, 0 updated, 0 keys removed** — purely
      additive, no live figure overwritten. Only two pre-existing weeks moved,
      by exactly their planned net (`2026-06-15` +$942.27, `2026-06-22`
      +$2,021.39). 18 weeks not 17: `2026-06-15` drifted once the ingest
      completed. Labour did NOT move — those weeks predate its coverage.
- [x] **Decided 2026-08-25 (Jake):** the 119 out-of-window weeks and the
      $288,852.51 past the 183-day purge line are **written off**, not
      repaired. Instead of widening the repair window, `summary-self-heal`
      ships a standing 4-week self-heal + weekly drift alert so new drift
      cannot silently reaccumulate the same way. See `TODO.md`.
- [ ] The **24 SPLIT weeks — $92,885.74** (was $146,257.61; the whole
      $53,371.87 of duplication was in these weeks) — still open, carried
      forward to `TODO.md`. Still NOT repairable by `weeklySummarize` — it
      reads `Suppliers` only and would understate them. Needs an
      archive-aware aggregate, and the 253 redundant rows cleaned first.
- [ ] Clean up the **253 redundant `_archive` rows** — carried forward to `TODO.md`.
- [ ] Raise or paginate past `INVOICE_PAGE_LIMIT` — carried forward to `TODO.md`.
- [x] **Standing guard against silent re-accumulation — shipped 2026-08-26**
      (phase `summary-self-heal`): the 4-week self-heal window + weekly
      `checkSummaryDrift()` alert. See `TODO.md`.

