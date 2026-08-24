# Mayers location fix — decisions locked (2026-08-14)

Pre-drafting decisions for the Tier-3 Mayers repair (see `TODO.md` → "Mayers North
Sydney never maps"). Locked via a four-round grill before any plan was written.
**These are settled — re-open only with a reason, don't re-litigate.**

## Status

- Branch `feat-mayers-location-fix` off `feat-orderapp-pulls`, commit `6abbbab`.
  **Not pushed to origin** (push is gated on "lets stop here").
- `connectors/gas/mayers_harvest.gs` **pushed to GAS, NOT deployed**. It is an
  editor-run diagnostic; `/exec` still serves **version 27**, untouched.
  Rollback anchor if a deploy ever happens: `clasp redeploy <id> -V 27`.
- **Next action:** run `runMayersOcrHarvest()` in the GAS editor (zero-arg; expect an
  auth prompt for `DocumentApp.create`). It writes one Google Doc with real Drive OCR
  text per shop. Everything below marked "gated" waits on that Doc.
- Suite baseline at this commit: `node connectors/gas/test_code.js` → **1112 passed, 0 failed**.

## The defect

`connectors/gas/mayers.gs:27` — `/\bBLUE\s*ST/i` cannot match `5 BLUES ST`: `\bBLUE`
matches inside `BLUES`, `\s*` matches empty, then `ST` is required but the next char is
`S`. Falls through to the `UNMAPPED:` hint branch. $703.00 (wk 2026-07-20) + $570.15
(wk 2026-07-27) bucket to `Other` instead of `North` in every consumer.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | **Two-pass matching**: try rules against the `Deliver To` block first; if nothing matches there, retry whole text. Plus widen to `/\bBLUES?\s*ST/i`. | Scoping can only break a tie, never lose a match a shop gets today. Kills trap 1 structurally. |
| 2 | Rejected: strict Deliver-To-only (no retry). | A shop whose address falls outside the 120-char window would regress to UNMAPPED, and we cannot detect that for Pitt or Crowsnest. |
| 3 | Rejected: widen + reorder rules. | Protects Crowsnest only; leaves York and Pitt exposed; makes rule order load-bearing and invisible. |
| 4 | **Safety gate**: dry-run reports every row it would touch and writes nothing → Jake reviews → separate Apply run mutates inside `withScriptLock_`. | Mirrors the `runOnlineRevenueCleanupDryRun` precedent. |
| 5 | **Sweep scope**: scan the whole `Suppliers` tab for any `UNMAPPED:` location, all sources, all weeks. Repair only what the Mayers fix resolves; anything else is written up as a separate finding. | Scanning is read-only and near-free; the two known rows came from a single 2-week probe. |
| 6 | **Repair method**: in-place rewrite of the `Suppliers` location cells + **explicit deletion** of stale `UNMAPPED:` Summary rows + re-summarize via the override form. | `SUMMARY_KEY_COLS` includes `location` (`Code.gs:65`) and `upsertRows_` has no delete path — a naive rewrite orphans the old Summary row and the money is served twice. |
| 7 | **Re-summarize** with the override form for **all four** affected weeks — `weeklySummarize('2026-06-15')`, `('2026-07-06')`, `('2026-07-20')`, `('2026-07-27')`. Assert `res && !res.refused && res.weekStart === '<week>'`, then confirm success by **reading Summary state**. | The bare form does only the last completed week and fires `archiveAndPurge_`. It returns `{refused:…}` on lock contention **with no throw** — "no error" is not success. |

| 8 | **Fixtures rebuilt from real OCR text**, all four shops. | `test_code.js:680` asserts `BLUE ST` singular — written from the regex, not from an invoice. That is why 1112 green tests coexisted with a live money bug for two months. |
| 9 | **Harvest search widened** to full Gmail history including already-labelled threads. | Labelled threads are exactly the ones whose rows are already in the Sheet. |
| 10 | **Overall shape**: split into a trivial read-only evidence plan (done) and a Tier-3 repair plan drafted with complete evidence. | Plan-review is worth most on the mutation, and it should review a definite sequence, not conditional branches. |

> **Correction (2026-08-15) to decision 7.** This row originally said
> `rowsAdded + rowsUpdated`. Those are `upsertRows_`'s field names;
> `weeklySummarize` renames them to **`summariesAdded` / `summariesUpdated`** on the
> way out (verified at `Code.gs:1854-1855`). Asserting on the old names does
> arithmetic on `undefined` → `NaN`, which makes the check vacuous in either
> direction: `sum > 0` always fails, `sum === 0` never fires. The whole point of
> decision 7 is that "no error" is not success — the wrong field names reintroduce
> exactly that hole.
>
> **Further amended 2026-08-20 (dual review round 3).** Do **not** assert
> `summariesAdded + summariesUpdated > 0` either — that was still wrong twice over.
> (a) Both refusal paths make the sum `NaN`: `{refused:'locked'}` (`Code.gs:1757`)
> carries neither field, and `{refused:'incomplete-week'}` (`Code.gs:1791-1795`)
> carries `summariesAdded:0` and no `summariesUpdated`. (b) Counts are not a
> success signal at all: `upsertRows_` counts an existing key with an unchanged
> amount as `duplicatesSkipped` (`Code.gs:593`), so a **correct** recovery re-run
> legitimately returns 0/0 and would read as failure. Assert `!res.refused` and
> `res.weekStart`, then verify by reading Summary. Also: this decision originally
> named only two weeks; there are **four**.

## Verification that catches the double-count

Week **grand totals unchanged** · `North` up by exactly **$703.75** / **$703.00** /
**$570.15** (plus **$736.74** if the blank row resolves) · `Other` down by the same ·
**no duplicate `invoice_ref`**.

> Corrected 2026-08-20: this line used to say "no duplicate Mayers rows" and to name
> only two weeks. Both were wrong. Week 2026-07-27 legitimately carries TWO Mayers
> rows of the same $570.15 (different shops, different refs), so a row-level
> duplicate check false-positives — assert on `invoice_ref`. See the live census below.

## Live row census (doGet `fn=summary`, 2026-01-01..2026-08-20, probed 2026-08-20)

All seven Gmail invoices are present, one Summary row each. **All four shops order
from Mayers** — the earlier "North Sydney skew" read was an artefact of only having
evidence for the misattributed rows, which are all North. Jake confirmed the cause is
naming, not ordering.

| Week | Ref | Amount | Stored `location` | Verdict |
|---|---|---|---|---|
| 2026-06-15 | 3429816 | $736.74 | `''` (blank) | **BROKEN** — the `''` path, mechanism unconfirmed |
| 2026-06-29 | 3434688 | $703.80 | `Leible York` | ok |
| 2026-07-06 | 3437634 | $703.75 | `UNMAPPED: …5 BLUES ST…` | **BROKEN** |
| 2026-07-20 | 3442003 | $703.00 | `UNMAPPED: …5 BLUES ST…` | **BROKEN** |
| 2026-07-27 | 3449495 | $570.15 | `Leible Crowsnest` | ok |
| 2026-07-27 | 3446281 | $570.15 | `UNMAPPED: …5 BLUES ST…` | **BROKEN** |
| 2026-08-10 | 3463868 | $1140.30 | `Leible Pitt` | ok |

Mayers total in span: **$5,127.89**. Misfiled: **$2,713.64** across 4 rows.

### Jake's mapping rule (authoritative, 2026-08-20)

> "if you see 5 blue street it is north sydney invoice"

`5 BLUE(S) ST` identifies **Leible North** — confirmed by the business owner, not
inferred from the regex. This is what decision 1's widening to `/\bBLUES?\s*ST/i`
rests on.

### Two traps this census exposes

1. **Week 2026-07-27 legitimately holds TWO Mayers rows of the SAME $570.15**
   (refs 3446281 → North, 3449495 → Crowsnest — identical standing orders to two
   shops, forwarded 15 seconds apart). The verification line "no duplicate Mayers
   rows" therefore **false-positives**. Dedup and assert on **`invoice_ref`**, never
   on week+amount. Nothing is double-counted today.
2. **The stored UNMAPPED hint is EXACTLY 60 characters** including its trailing
   space — `slice(0, 60)` lands exactly on the boundary. A `hintSuspect >= 60 →
   quarantine` gate would quarantine all three UNMAPPED rows, drop `resolvable` to 0
   and abort the repair as a no-op. Truncation is harmless here: `BLUES ST` sits at
   chars 29-37, well inside the window.

### Still unconfirmed

The blank-`location` row (3429816) is the `''` return path — no rule matched **and**
no `Deliver To` marker was found. If its OCR text contains `5 BLUES ST` anywhere,
decision 1's whole-text retry resolves it and the widened regex fixes all four rows.
That is **probable but unread** — it needs the harvest Doc for 3429816.

## HARVEST READ 2026-08-20 — the gated questions are now answered

Doc: `1sbid-4-VnA0o8et5Dr8OGXyn8ZyXg12k0QCQ9-UZ_Qc`. 8 PDFs seen, 4 harvested
(one per shop-hint), all four hints covered.

### 1. The blank row is YORK, not North — and it is a historical artefact

`3429816` ($736.74, wk 2026-06-15) is a **York** invoice: `Deliver To: 89 YORK ST`,
`Account: LEI05D` — the same account code as `3434688`, which maps to `Leible York`
correctly. Two independent confirmations:

- `pdftotext` on the local `TAX INVOICE - 3429816.pdf` shows York in both Bill-To and
  Deliver-To. (Reading an address off pdftotext is legitimate; only *parser* questions
  are off-limits to it.)
- The harvester itself skipped `3429816` as **already-covered-York**, which means its
  real Drive-OCR text matched `/YORK\s*ST/i`. Production's `/\bYORK\s*ST/i` differs
  only by a word boundary that `89 YORK ST` satisfies — so today's parser resolves it.

**It is blank because it was ingested before shop attribution existed.**
`mayersShopFromText_` first appears in `ff51fab` (2026-06-22); the invoice is dated
2026-06-17. There was no `location` logic to run.

> **This corrects the 2026-08-15 note that guessed the blank row was North and would be
> swept up by the widened `BLUES` regex. It would not.** Repairing it as North would
> have moved $736.74 to the wrong shop. The repair is now two distinct sets:
> **North +$1,976.90** (3437634, 3442003, 3446281) and **York +$736.74** (3429816).

### 2. TODO #8 is confirmed not-a-defect, on real OCR

Money labels resolve in document order `Ex Tax → GST → Total`, all equal to the true
total on all three real invoices. `hasSubTotal` is **false** everywhere — the premise
never existed. `Line Total` is a column header followed by item rows, so the `\.\d{2}`
anchor rejects it. The production regex returned 1,140.30 / 570.15 / 703.80 — all
correct. **Keep the `\.\d{2}` anchor; it is what makes this safe.**

### 3. No dollar backfill needed

Every harvested total matches its `Ex Tax`+`GST` breakdown and the stored Sheet value.
Only `location` is wrong, so **"week grand totals unchanged" remains a valid
invariant** — the tension flagged under "Dollar backfill" does not materialise.

### 4. Trap 1 is structurally dead, but unevidenced for Crows Nest

`hasBLUES_ST` is **false** on Pitt (3463868) and York (3434688), **true** only on North
(3446281) — no steal risk from those. **But no real Crows Nest invoice was harvested:**
the monthly statement matched the `BURLINGTON|CROWS NEST` hint first and occupied the
Crowsnest slot, so `3449495` was skipped. The harvest's "shops seen: … Crowsnest" is
therefore misleading — that slot holds a statement, not an invoice.

Decision 1's two-pass still kills the trap structurally: every real invoice carries a
`Deliver To` block naming its own shop, so the Deliver-To pass resolves before the
whole-text retry can mis-fire. Still add the synthetic Crows-Nest-with-stray-`BLUES`
regression case.

### 5. ~~Recommendation~~ REJECTED by Jake 2026-08-20 — address, not account code

Every invoice carries a stable, unambiguous shop key that no OCR spelling variance can
break:

| Account | Shop |
|---|---|
| `LEI04D` | Roastery / Crows Nest |
| `LEI05D` | York |
| `LEI06D` | Pitt |
| `LEI07D` | North Sydney |

`/Account:\s*(LEI\d+D)/i` is immune to `BLUE`/`BLUES`, to address reformatting, and to
the Bill-To/Deliver-To distinction entirely. This evidence did not exist at grill time,
so it is a legitimate reason to re-open decision 1 — **Jake's call.** Suggested shape:
account code first, existing address rules as the fallback, so nothing regresses.

Jake's call, 2026-08-20: **"lets go with address"**. Decision 1 stands exactly as
locked — two-pass Deliver-To-first matching plus the widened `/\bBLUES?\s*ST/i`.
The account-code idea is recorded here only so it is not re-raised as though it were
an open question. **Do not re-litigate.**

### 6. The statement is confirmed unparseable

`LEI04D_31 JUL 26.pdf`: `parseMayersInvoice_ → NULL`, no `Deliver To` marker, no
`Invoice No`. It can never parse — exactly the permanent-failure case the
unparseable-attachment memo (shipped `8ae39d8`) exists to stop re-OCRing.

## Open — ~~gated on the harvest Doc~~ RESOLVED 2026-08-20 (see above)

- **TODO #8 (total regex).** In scope, but fix only if the real OCR shows it
  mis-resolves; close as not-a-defect if it resolves correctly. The TODO's stated
  premise is **already disproven** — real Mayers invoices have no `Sub Total` label,
  they use `Ex Tax:`. The genuine hazard is the `Line Total` column header, which
  precedes the real `Total:`. On one non-OCR extraction the production regex resolved
  `Line Total` → **1.00**, so the hazard is real in principle; whether it bites in
  production is unknown.
- **Dollar backfill.** If ingested totals turn out wrong, decide then whether this plan
  repairs them or hands off to a separate one. Note the tension: "week grand totals
  unchanged" is the invariant that catches a double-count, and it stops holding the
  moment totals legitimately change.

## Do not rediscover

- **`pdftotext` is not a valid proxy for Drive OCR.** Measured 2026-08-14: the real
  invoice PDF in the repo root fails **all three** production regexes under pdftotext
  (ref, total, date → NULL) while that same invoice is on record as OCR-parsed and
  ingested live. pdftotext splits money labels from their values across lines; Drive
  OCR evidently does not. No offline extractor can settle a parser question here.
- **The GAS editor Run button passes no arguments** — every verification function needs
  a zero-arg wrapper shipped with it.
- `main` is 0 ahead / **313 behind** `feat-orderapp-pulls`. It is a stale trunk; the
  live line of development is the `feat-<phase>` branch chain.

## PHASE 3 BASELINE — captured 2026-08-24, before any mutation

Phases 1-3 of `~/.claude/plans/mayers-address-repair-quiet-harbor.md` are done.
**Nothing in production has been mutated.** The parser fix and the repair
function are deployed but the repair has not been applied.

### Deployment

| | |
|---|---|
| **Deployed version** | **30** (parser fix + `mayers_repair.gs` + retained rollback) |
| **ROLLBACK ANCHOR** | **`clasp redeploy <id> -V 28 -d 'rollback to 28'`** |

> Corrected: the earlier note in this file said `/exec` served version **27**.
> Live `clasp list-deployments` on 2026-08-24 showed **28** — a deploy landed
> 2026-08-14 14:54. Re-derive from live, never from this file.
>
> **v29 was deployed and rolled back.** `connectors/gas/fixtures_mayers_ocr.js`
> is a Node module ending in `module.exports`, `.claspignore` only excluded
> `test_code.js` by name, so it pushed to GAS and threw
> `ReferenceError: module is not defined` out of `doGet` — killing `/exec`
> entirely. Fixed in `183788f`: `.claspignore` now excludes `**/*.js` (the rule
> is the extension — every GAS file is `.gs`), and `deploy.sh` ends with an
> unauthenticated smoke check that proves the project loads.

### Retained artifacts (do NOT clean these up)

- `Summary_mayers_location_backup` — the only copy of the deleted Summary rows.
- Script properties `MAYERS_REPAIR_SNAPSHOT_2026-06-15`, `_2026-07-06`,
  `_2026-07-20`, `_2026-07-27`. Write-once **per week**; a refusal to overwrite
  means that week already ran. Consumed by `restoreMayersLocationSnapshot()` in
  `mayers.gs` (kept deliberately — `mayers_repair.gs` is deleted at cleanup).

### Mayers-only baseline (doGet `fn=summary`, live, 2026-08-24)

| Week | Stored `location` | Total |
|---|---|---|
| 2026-06-15 | `''` (blank) | $736.74 |
| 2026-07-06 | `UNMAPPED: …5 BLUES ST…` | $703.75 |
| 2026-07-20 | `UNMAPPED: …5 BLUES ST…` | $703.00 |
| 2026-07-27 | `Leible Crowsnest` | $570.15 |
| 2026-07-27 | `UNMAPPED: …5 BLUES ST…` | $570.15 |

**Mayers across these four weeks: $3,283.79** — must be identical after the
repair (the money moves between locations, it is not created or destroyed).
Plus $703.80 (wk 2026-06-29) and $1,140.30 (wk 2026-08-10) outside the repair
set = the **$5,127.89** span total.

> The FULL multi-supplier baseline — every supplier and kind for the four weeks —
> is in **`downloads/mayers-repair-baseline-2026-08-24.json`**, which is
> gitignored (`.gitignore:11`). It stays out of this file on purpose: this file
> is tracked and pushed, and that dump is business data.

### The unrebuildable row, confirmed live

`2026-07-20` · `Bennetts` · `location=''` · **$14,219.00** · `Roastery/spend`.
Written straight to `Summary` by `orderapp.gs:406`; `weeklySummarize` rebuilds
only from `Suppliers`+`Revenue`, so **nothing in this repo can regenerate it**.
Its key is `2026-07-20||roastery||spend||bennetts||`.

Week `2026-06-15`'s only blank-`location` row is the Mayers one — confirmed, not
assumed. That is why the delete predicate must be the full `SUMMARY_KEY_COLS`
tuple: in that week the row being repaired is itself at `location=''`, so only
`supplier`/`kind`/`department` separate it from a co-located row.

### The literal key list awaiting Jake's approval

Derived from the live baseline above using `rowKey_`'s own normalization
(`String(v).trim().toLowerCase()`, note the UNMAPPED hint's trailing space is
trimmed). The dry run must print this same list.

| Week | DELETE (stale key) | ADD (target key) | Target pre-state |
|---|---|---|---|
| 2026-06-15 | `2026-06-15\|\|cafe\|\|spend\|\|mayers\|\|` | `…\|\|mayers\|\|leible york` | absent |
| 2026-07-06 | `2026-07-06\|\|cafe\|\|spend\|\|mayers\|\|unmapped: leible coffee north sydney 5 blues st north sydney nsw 2060` | `…\|\|mayers\|\|leible north` | absent |
| 2026-07-20 | `2026-07-20\|\|cafe\|\|spend\|\|mayers\|\|unmapped: …` | `…\|\|mayers\|\|leible north` | absent |
| 2026-07-27 | `2026-07-27\|\|cafe\|\|spend\|\|mayers\|\|unmapped: …` | `…\|\|mayers\|\|leible north` | absent |

One row per key. `Leible North` +$1,976.90 · `Leible York` +$736.74.

### Next action

Run **`runMayersLocationRepairDryRun()`** in the GAS editor (`clasp run` is
unavailable — the project is deliberately not deployed as API executable), check
its `staleSummaryKeys[].keyTuple` list against the table above and its
`drift.nonMayersDriftCount`, then apply one week at a time.

### BASELINE REFRESHED 2026-08-24 — after the Ordermentum North backfill

`downloads/mayers-repair-baseline-2026-08-24.json` was **re-captured** after an
unrelated fix landed rows in three of the four repair weeks. The Mayers repair
itself is unchanged — this note exists so the refresh is not mistaken for drift.

**What happened.** The Ordermentum connector was pointed at the dead North
Sydney retailer account, so `Leible North` had no Ordermentum rows at all. Fixed
in `516252b`; 54 rows backfilled and weeks `2026-06-29`..`2026-08-17`
re-summarized. Three of those weeks (`07-06`, `07-20`, `07-27`) are also Mayers
repair weeks.

**Verified unaffected**, by diffing the superseded baseline against the new one:

- Mayers rows are **byte-identical** in all four weeks (1/1/1/2 rows).
- Mayers four-week total is still **$3,283.79**.
- The unrebuildable `Bennetts` row is still **$14,219.00** at `location=''`.
- The approved DELETE/ADD key tuples are Mayers-only, so **they do not change**.
  The table above still stands as approved.

**What did change in the repair weeks** — expect these in the dry-run's drift
list, and do not treat them as new:

| Week | Row | Change |
|---|---|---|
| 2026-07-06 | `Fuel Bakery` / `Leible North` | **+** $931.05 (backfill) |
| 2026-07-20 | `Fuel Bakery` / `Leible North` | **+** $1,328.92 (backfill) |
| 2026-07-20 | `Tuga Pastries Australia` / `Leible North` | **+** $69.29 (backfill) |
| 2026-07-27 | `Fuel Bakery` / `Leible North` | **+** $1,674.48 (backfill) |
| 2026-07-27 | `Fuel Bakery` / `Leible Crowsnest` | $563.23 → $641.77 (pagination fix) |
| 2026-07-27 | `Fuel Bakery` / `Leible York` | $720.33 → $750.62 (pagination fix) |
| 2026-07-27 | `Fresh and Chill` / `Leible York` | $913.30 → **$888.68** ⚠️ |

⚠️ The `Fresh and Chill` move is **not** from this backfill — different
connector, different source. It is pre-existing drift that the re-summarize
surfaced: the `Summary` row had gone stale against `Suppliers`. This is exactly
the hazard the plan's "non-Mayers drift lands silently" risk describes, observed
for real. **Open item for Jake**, tracked separately from the Mayers repair.
