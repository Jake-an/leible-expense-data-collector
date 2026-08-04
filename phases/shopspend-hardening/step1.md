# Step 1: tombstone-weeks-complete

## Requirements Covered

- `PRD-7` — shopSpend ingest + snapshot store — "snapshotted so history stays reproducible". An
  ingest that writes spurious `absent` tombstones when a pull is split across requests is not
  reproducible: re-posting identical data changes the stored history.

This is *why* this step exists. If the Task section below appears to contradict the requirement
above, `docs/ADR.md`, or a CRITICAL rule in CLAUDE.md, do NOT resolve the conflict yourself and do
NOT proceed on your best guess — set `"status": "needs_context"` with the contradiction spelled out
in `needs_context_detail`, and stop.

## Files to Read

- `connectors/gas/shopspend.gs` — `ingestShopSpendRows` from line 32; the tombstone block at lines
  89-136 (the defect); the `wasAbsent` change-detection at lines 78-81; the
  `tombstone.push(normalizedRows[0][c])` at line 122
- `connectors/gas/Code.gs` — `validateIngest_` at lines 200-258; `doPost` at lines 150-155 (where
  the payload is threaded through)
- `connectors/gas/test_code.js` — the existing tombstone suite at lines 3071-3133 (five tests that
  are the regression net for this defect — they get **updated**, not deleted)
- `docs/schema.md` — the `ShopSpend` tab spec and the `presence` column semantics
- `docs/api.md` — the doPost response contract (you will add two response fields + a procedure)
- Step 0's output: `connectors/gas/Code.gs` `ensureSheet` and the fixed mock in `test_code.js`

Read the code and understand the design intent before starting.

## Task

### The defect (critical, C1 from the phase-end review)

`ingestShopSpendRows` tombstones every week it sees rows for. The poster chunks at 200 rows
(`connectors/shopspend/ingest.py:87`), so a week whose rows straddle a chunk boundary arrives in
two requests — and **each request tombstones the shops carried by the other one**. An identical
re-post is therefore not idempotent. This was reproduced.

The fix (Jake's decision — **fixed, do not reopen**): the client declares which weeks it carries
**in full**, and GAS tombstones only those.

```
 BEFORE                              AFTER
 chunk = 200 rows, week may split    whole weeks per request, packed to chunk_size
 GAS tombstones every week seen      GAS tombstones only weeks_complete
   → identical re-post writes           → identical re-post writes nothing
     spurious tombstones                → split week: no tombstone (safe), warned
```

This step is the **GAS half**. Step 2 is the Python half. Step 1 alone tombstones nothing against
today's client — that is safe and intended, and it is one of the reasons this phase is under a
deploy embargo (see Prohibitions).

### 1. `validateIngest_` (`Code.gs:200-258`) — validate both new wire fields

`weeks_complete` **and** `weeks_verified_empty`, when present, must each be an array whose every
element matches `^\d{4}-W\d{2}$`. Otherwise reject the payload. Both are currently unvalidated, so
a JSON **string** would sail straight through.

Additionally:

- Every entry in `weeks_verified_empty` must also appear in `weeks_complete`. A week cannot be
  "verified empty" without being declared complete.
- **Reject any payload where a week named in `weeks_verified_empty` has ≥1 row in `body.rows`.**
  `validateIngest_` already walks `body.rows` (`Code.gs:211-256`), so this check is free. Without
  it, the exemption in section 4 disables the circuit breaker **on the client's word alone**,
  which defeats the breaker's stated purpose of holding even if a future client forgets.

**A limit worth knowing, and worth stating here so nobody assumes otherwise:** a verified-empty
week that carries rows in a *sibling* request of the same pull is undetectable server-side — each
request is validated alone. That case is prevented only by step 2's packing invariant, not by this
validation. Do not attempt to detect it here.

### 2. `ingestShopSpendRows` (`shopspend.gs:32`) — tombstone only declared weeks

Build a **hash set** (`{label: true}`) from `weeks_complete` and tombstone only those weeks.

**Never `indexOf` the raw field.** `"2026-W31".indexOf("2026-W3")` is truthy, so a truncated label
would tombstone a week the payload never carried — the exact defect class this step exists to fix.

Thread `weeks_complete` (and `weeks_verified_empty`) from `doPost` (`Code.gs:150-155`) through to
`ingestShopSpendRows`.

When the field is **absent**: tombstone nothing, and `Logger.log` a warning when rows are present,
so the degraded mode is visible rather than silent.

### 3. `shopspend.gs:122` — use `extractedAt`, not `normalizedRows[0]`

```js
tombstone.push(normalizedRows[0][c]);   // fetched_at from the first incoming row
```

Today tombstoning is gated on the payload having rows, so `normalizedRows[0]` is always safe.
Decoupling tombstoning from the rows makes `rows: []` reachable, `normalizedRows[0]` `undefined`,
and this line a TypeError → caught by `doPost` → **the pull marker never lands**. Use
`extractedAt`, which is already a parameter of `ingestShopSpendRows` (`shopspend.gs:32`).

### 4. Blast-radius circuit breaker — with a floor and an explicit exemption

Always return `tombstonesWritten` **and** `tombstonesSkipped: [{week, wouldHaveWritten, present}]`
in the `doPost` response, so both the count and every suppression are visible to the client, not
only to a `Logger.log` nobody reads.

Skip a declared week's tombstoning when **all** of these hold:

- it would tombstone **more than half** of that week's currently-`present` shop-weeks, **and**
- that week has **at least 5** present shop-weeks (the floor — below it, always write; with 3
  shops, 2 closing is 66% and entirely ordinary), **and**
- the week is **not** listed in `weeks_verified_empty`.

`weeks_verified_empty` is the exemption: step 2 puts a week there only after that week passed the
**full** completeness gate and genuinely returned no rows. It is the client asserting "I verified
this week is empty" — the one case where a 100% tombstone is correct — so the breaker stands down.

**Belt-and-braces:** `ingestShopSpendRows` must itself drop a rows-carrying week from the exemption
set rather than trusting the flag, even though `validateIngest_` already rejects that payload.

#### Why skipping is the right default — state this in a code comment, or a future reader will "simplify" the floor away

The two error directions are **not symmetric**:

- A **wrong tombstone self-heals.** `shopspend.gs:78-81` treats `wasAbsent` as a change, so the
  shop-week re-appends as `present` on the next good pull.
- A **suppressed tombstone never self-heals.** The condition recomputes from the same sheet state
  on every pull, so it stays suppressed on pull 1, pull 2, and forever.

That asymmetry is what makes "skip when unsure" correct *and* what makes the sub-5 blast radius
acceptable — below the floor, a wrong tombstone costs one self-healing pull.

Because suppression is **permanent**, it is suppressed *until a human confirms*. So the skip must
be reported on the wire and surfaced by the poster (step 2), never merely logged. **Document the
confirmation procedure in `docs/api.md`** alongside the new response fields: how Jake accepts a
genuine mass absence (a one-off `absent` write for the affected shop-weeks). Without a written
procedure, "until a human confirms" is aspirational and the hole is permanent in practice.

`tombstonesSkipped` is **always present** on `kind: 'shopspend'` responses — an empty array when
nothing was skipped — and omitted for other kinds.

### Test First (TDD step)

1. Write the failing test(s) for the cases below *before* any implementation. Use the
   `ecc:tdd-guide` agent to drive the red-green-refactor loop.
2. Confirm the test fails (red) for the right reason.
3. Implement the minimum to pass (green), then refactor while keeping tests green.

**Before writing them, check that the breaker cases and the empty-week cases are jointly
satisfiable.** An earlier draft of this design required both "rows-empty declaring a week
tombstones every present shop (100%)" and "a week tombstoning >50% is skipped" — jointly
unsatisfiable. The floor and the `weeks_verified_empty` exemption are what make both reachable.

Test cases (defined at design time — these are "done"):

- a payload declaring its week tombstones missing shops as today
- a payload **not** declaring a week present in its rows tombstones nothing for it
- field absent → zero tombstones **and** a `Logger.log` warning when rows are present
- `rows: []` + `weeks_complete: ["2026-W31"]` + `weeks_verified_empty: ["2026-W31"]` tombstones
  every present shop for that week (100%, breaker exempt) **without throwing**
- `rows: []` + `weeks_complete: ["2026-W31"]` and **not** verified-empty, with ≥5 present
  shop-weeks → **skipped**, and the week appears in `tombstonesSkipped`
- **below the floor:** the same unverified 100% case with only 3 present shop-weeks **writes**
- exactly 50% with ≥5 present shop-weeks still **writes**; 51% is **skipped**
- **the skip is sticky:** two identical consecutive pulls both skip and both report the week in
  `tombstonesSkipped` — asserting the non-self-healing behaviour is intended, not accidental
- two sequential half-payloads for one week (the C1 repro shape) produce **zero** tombstones
- an identical re-post of a complete week appends nothing
- `weeks_complete` as a string, as a nested array, and with a bogus label are each rejected by
  `validateIngest_`; likewise `weeks_verified_empty`
- `weeks_verified_empty` naming a week absent from `weeks_complete` is rejected
- `weeks_verified_empty` naming a week that has ≥1 row in the same payload is rejected — the check
  that stops a buggy client disabling the breaker
- with validation bypassed, `ingestShopSpendRows` still drops a rows-carrying week from the
  exemption set (belt-and-braces)
- `tombstonesSkipped` is an **empty array** (not omitted) when nothing was skipped
- a truncated label (`2026-W3`) never matches `2026-W31`
- `tombstonesWritten` and `tombstonesSkipped` are present in the `doPost` response on every
  shopspend ingest
- `docs/api.md` documents `tombstonesWritten`, `tombstonesSkipped`, and the procedure for
  confirming a genuine mass absence

**The existing tombstone suite (`test_code.js:3071-3133`) is UPDATED to pass `weeks_complete`,
preserving each test's intent — not relaxed, not deleted.** Those five tests are the regression net
for the crux defect.

## Acceptance Criteria

```bash
node connectors/gas/test_code.js     # all tests pass, including the cases above
```

## Verification Procedure

1. Run the AC command above.
2. Confirm `docs/api.md` documents both new response fields and the mass-absence confirmation
   procedure.
3. Check the architecture checklist:
   - Does it follow the directory structure in `docs/ARCHITECTURE.md`?
   - Does it stay within the tech stack defined in `docs/ADR.md`?
   - Does it not violate the CRITICAL rules in CLAUDE.md — in particular, all ingest still flows
     through `doPost` → `validateIngest_`?
4. Update this step in `phases/shopspend-hardening/index.json`:
   - Success → `"status": "completed"`, `"summary": "one-line summary of output"`
   - Failure after 3 retry attempts → `"status": "error"`, `"error_message": "specific details"`
   - User intervention required → `"status": "blocked"`, `"blocked_reason": "specific reason"`,
     then stop immediately

## Prohibitions

- **Do NOT run `bash scripts/deploy.sh`, `clasp push`, `clasp deploy`, or any other deploy command
  in this step.** Reason: deploying after step 1 ships a hub that tombstones nothing and records
  stale `present` rows forever, because the matching client change lands in step 2. The embargo
  runs until the phase-end review gate passes AND the branch is merged to `feat-shopspend`. This
  overrides CLAUDE.md's "deploy when GAS coding is finished" rule for this phase only.
- Do not use `indexOf` (or any substring match) to test week membership. Reason:
  `"2026-W31".indexOf("2026-W3")` is truthy and would tombstone a week the payload never carried —
  the exact defect class being fixed. Use a hash set with exact-key lookup.
- Do not delete or relax the five existing tombstone tests at `test_code.js:3071-3133`. Reason:
  they are the regression net for the crux defect; update them to pass `weeks_complete` while
  preserving each test's original intent.
- Do not remove the ≥5 floor or the `weeks_verified_empty` exemption as a "simplification".
  Reason: without the floor, an ordinary 3-shop week with 2 closures is permanently suppressed;
  without the exemption, the breaker suppresses the one case (a verified-empty week) that the
  rows-empty mechanism exists to record.
- Do not attempt to detect a verified-empty week whose rows arrived in a sibling request. Reason:
  each request is validated alone; that case is covered by step 2's packing invariant.
- Do not touch any Python file in this step. Reason: single-runtime (GAS) step; its `test_cmd` is
  node-only and would not exercise a Python change.
- Do not break existing tests.
