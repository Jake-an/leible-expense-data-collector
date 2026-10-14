# Labour cost — award & public-holiday reference

Researched 2026-10-14 for the clock-in labour rebuild (ADR-008, pending). Source of the
multipliers `labour.gs` seeds into the LEIBLE Labour Sheet `CONFIG` tab. Re-verify every 1 July.

## Restaurant Industry Award 2020 (MA000119) — cafés

Coverage: cafés mainly selling dine-in / table service → MA000119 (cl. 4.2). Takeaway-dominant
café → Fast Food Award MA000003 instead (FWO K600364). Leible cafés assumed dine-in → MA000119.

Penalties (cl. 24.2, Table 8) — % of the **ordinary (unloaded) minimum hourly rate**; casual
columns INCLUDE the 25% casual loading (cl. 11.1):

| Period | FT/PT | Casual Intro–L2 | Casual L3–L6 |
|---|---|---|---|
| Mon–Fri 6am–10pm | 100% | 125% | 125% |
| Saturday | 125% | 150% | 150% |
| Sunday | 150% | 150% | **175%** |
| Public holiday | 225% | 250% | 250% |

Multiplier to apply to a rate that ALREADY includes casual loading = casual % / 125%
(weekday 1.00, Sat 1.20, Sun 1.20 or 1.40, PH 2.00).

Also: Mon–Fri 10pm–midnight +$2.95/hr, midnight–6am +$4.42/hr (flat, not modelled — cafés
closed). PH minimum engagement: casual 2h, FT/PT 4h (not modelled).

Ordinary rates from 2026-07-01 (**third-party: rosterelf, unverified vs official pay guide**):

| Level | FT/PT | Casual (incl. 25%) |
|---|---|---|
| Intro | 25.74 | 32.18 |
| 1 | 26.44 | 33.05 |
| 2 | 27.08 | 33.85 |
| 3 | 27.97 | 34.96 |
| 4 | 29.45 | 36.81 |
| 5 | 31.30 | 39.13 |
| 6 | 32.13 | 40.16 |

Sources: https://awards.fairwork.gov.au/MA000119.html ·
https://www.fairwork.gov.au/tools-and-resources/library/K600364_Award-coverage-for-caf-s ·
https://www.rosterelf.com/data/award-rates/restaurant.json (third-party)

## Roastery — likely Food, Beverage & Tobacco Manufacturing Award (MA000073) — UNCERTAIN

Coverage not confirmed (coffee roasting not named in cl. 4). Day workers: Sat 150%, Sun 200%,
PH 250% (cl. 12.2); casual loading 25% (cl. 10.1(b)), casual penalties on the casual rate
(cl. 10.4). Casual weekend table not obtained → **do not hard-code**; roastery stays on the old
path until it passes the payroll check on its own (plan Phase 4).
Source: https://awards.fairwork.gov.au/MA000073.html

## NSW public holidays (official — https://www.nsw.gov.au/about-nsw/public-holidays)

| Holiday | 2026 | 2027 |
|---|---|---|
| New Year's Day | Thu 1 Jan | Fri 1 Jan |
| Australia Day | Mon 26 Jan | Tue 26 Jan |
| Good Friday | Fri 3 Apr | Fri 26 Mar |
| Easter Saturday | Sat 4 Apr | Sat 27 Mar |
| Easter Sunday | Sun 5 Apr | Sun 28 Mar |
| Easter Monday | Mon 6 Apr | Mon 29 Mar |
| Anzac Day | Sat 25 Apr | Sun 25 Apr |
| Anzac Day additional day | Mon 27 Apr | Mon 26 Apr |
| King's Birthday | Mon 8 Jun | Mon 14 Jun |
| Labour Day | Mon 5 Oct | Mon 4 Oct |
| Christmas Day | Fri 25 Dec | Sat 25 Dec |
| Christmas additional day | — | Mon 27 Dec |
| Boxing Day | Sat 26 Dec | Sun 26 Dec |
| Boxing Day additional day | Mon 28 Dec | Tue 28 Dec |

August Bank Holiday is **not** a declared public holiday for general employees — excluded.

**Do not use Nager.Date as the source.** Its 2026 AU feed omits weekend-falling NSW holidays
(Sat 25 Apr Anzac Day, Sat 26 Dec Boxing Day) — exactly the days a café pays PH rates on a
weekend. Seed HOLIDAYS from the official table above; the run alerts 60 days before the table
runs out so it is refreshed from nsw.gov.au.

## Superannuation guarantee
12% from 2025-07-01 (11.5% from 2024-07-01). Flat onward unless legislated.
