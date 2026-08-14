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
| 7 | **Re-summarize** with `weeklySummarize('2026-07-20')` and `('2026-07-27')`, asserting the return value and `rowsAdded + rowsUpdated > 0`. | The bare form does only the last completed week and fires `archiveAndPurge_`. It returns `{refused:…}` on lock contention **with no throw** — "no error" is not success. |
| 8 | **Fixtures rebuilt from real OCR text**, all four shops. | `test_code.js:680` asserts `BLUE ST` singular — written from the regex, not from an invoice. That is why 1112 green tests coexisted with a live money bug for two months. |
| 9 | **Harvest search widened** to full Gmail history including already-labelled threads. | Labelled threads are exactly the ones whose rows are already in the Sheet. |
| 10 | **Overall shape**: split into a trivial read-only evidence plan (done) and a Tier-3 repair plan drafted with complete evidence. | Plan-review is worth most on the mutation, and it should review a definite sequence, not conditional branches. |

## Verification that catches the double-count

Week **grand totals unchanged** · `North` up by exactly **$703.00** / **$570.15** ·
`Other` down by the same · **no duplicate Mayers rows**.

## Open — gated on the harvest Doc

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
