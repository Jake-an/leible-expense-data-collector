# Step 5: staleness-and-trigger

## Requirements Covered

- `PRD-14` — arm the watchdog for the new source and register the weekly trigger **in
  code only**. The trigger is not installed until step 8.

If the Task below contradicts the requirement, `docs/ADR.md`, or a CRITICAL rule in
CLAUDE.md, set `"status": "needs_context"` with the contradiction spelled out and stop.

## Files to Read

- `connectors/gas/staleness.gs` — `STALENESS_THRESHOLD_OVERRIDES` (`:45-49`), the comment
  block `:50-76`, `STALENESS_SOURCES` (`:77-78`).
- `connectors/gas/test_code.js` — `testEveryHeartbeatSourceIsWatched`, specifically the
  `STAMPS_HEARTBEAT` literal (`:3021`), `EXEMPT`, `NOT_YET_ARMED` (`:3036-3039`), and the
  two standalone registration guards at `:3072-3073` and `:3079-3080`. Also
  `testCoffeeOrderAppContract`, whose first assertion is the second of those two guards.
- `connectors/gas/orderapp.gs` — `installOrderAppTriggers` (`:1010-1025`).

## Task

**1. `staleness.gs`**
- Add `'coffee_order_app'` to `STALENESS_SOURCES`.
- Add `coffee_order_app: 168` to `STALENESS_THRESHOLD_OVERRIDES` (weekly cadence; without
  it the 96h default false-alarms every week by construction).
- **Delete** the exclusion comment at `:55-60` — the block beginning
  `'coffee_order_app' — NO LIVE WRITER today` and ending `or it runs unwatched.` Replace it
  with a one-line note that the writer shipped in phase `roastery-wholesale` (PRD-14) and
  stamps via `orderAppRunSuccess_`. Leaving the old comment in place makes the file lie.

**2. `connectors/gas/test_code.js`** — the co-edits, and note carefully what they are NOT:
`coffee_order_app` is **not** a `NOT_YET_ARMED` key. That map (`:3036-3039`) holds only
`roastery` and `recurring`, and its verbatim-RE-ADD-line mechanism is untouched by this
step. The actual edits are:
- add `'coffee_order_app'` to the `STAMPS_HEARTBEAT` literal (`:3021`) — it now genuinely
  stamps, so the guard must see it and require it to be watched;
- delete the standalone guard at `:3072-3073`
  (`"'coffee_order_app' is NOT in STALENESS_SOURCES …"`);
- delete the equivalent first assertion of `testCoffeeOrderAppContract` at `:3079-3080`.
Both now assert the opposite of the truth and would red.

**3. `installOrderAppTriggers()` in `orderapp.gs`** — add two handlers to the list it
manages, keeping its delete-then-create-its-own-names discipline:
- `wholesalePull` — `MONDAY`, `atHour(6)`, `Australia/Sydney`
- `wholesalePullRetry` — `MONDAY`, `atHour(7)`, `Australia/Sydney`

Add `wholesalePullRetry()`: a zero-arg wrapper that reads the `coffee_order_app` staleness
heartbeat and **no-ops** (logging one line) if it was stamped within the last 6 hours,
otherwise calls `wholesalePull()`.

Comment the slot choice, because it is not arbitrary: `LEIBLE_GM_COST_MONITOR` reads
`doGet` at **Monday 08:00** (`Main.gs:270`), so a pull landing after that misses the read
by six days and permanently understates the company headline by the newest week's
wholesale revenue. 06:00 sits after `weeklySummarize` (04:00) and `shopifyWeeklyPull`
(05:00). GAS weekly triggers fire at a random minute inside the named hour, so the real
margin is ~50 minutes, and a `withScriptLock_` timeout aborts with no retry — hence the
07:00 second chance.

⚠ **Do NOT invoke `installOrderAppTriggers()` in this step.** Code only.

### Test First (TDD step)

Test cases (defined at design time — these are "done"):
- `STALENESS_SOURCES` contains `'coffee_order_app'`
- `STALENESS_THRESHOLD_OVERRIDES.coffee_order_app === 168`
- the existing "every override belongs to a watched or not-yet-armed source" assertion
  still passes
- `testEveryHeartbeatSourceIsWatched` now asserts `coffee_order_app` **is** watched
- **shipped-state gate, read from the file on disk** (mirroring the existing
  `stalenessArmSrc` pattern): the string `NO LIVE WRITER today` no longer appears in
  `staleness.gs`, and neither does `RE-ADD 'coffee_order_app'`
- the `NOT_YET_ARMED` map still contains exactly `roastery` and `recurring`, and both
  RE-ADD lines still appear verbatim in `staleness.gs` — this step must not disturb them
- `wholesalePullRetry` no-ops when the heartbeat is < 6h old (asserts `wholesalePull` was
  not called), and calls through when it is older or absent
- `installOrderAppTriggers` creates 4 triggers with handlers `shopifyWeeklyPull`,
  `greenBeanPull`, `wholesalePull`, `wholesalePullRetry`; days/hours are Mon 05, Tue 05,
  Mon 06, Mon 07; timezone `Australia/Sydney` on all four
- it deletes only its own 4 handler names — seed a `shopSpendWatchdog` trigger and assert
  it survives
- running it twice leaves exactly 4 of its own triggers, not 8

## Acceptance Criteria

```bash
node connectors/gas/test_code.js
```

## Verification Procedure

1. Run the AC command. Record pass/fail counts.
2. `grep -n "coffee_order_app" connectors/gas/staleness.gs connectors/gas/test_code.js` and
   read every hit — confirm none of them still asserts the source is unwatched.
3. `grep -rn "installOrderAppTriggers()" ` across the diff — there must be no call site
   added by this step.
4. Update this step in `phases/roastery-wholesale/index.json`.

## Prohibitions

- Do not add `coffee_order_app` to `NOT_YET_ARMED` or `EXEMPT`. Reason: it is armed, and
  it has no separate watchdog of its own. `EXEMPT`'s docstring demands a real alternative
  watchdog.
- Do not touch the `roastery` / `recurring` entries or their verbatim RE-ADD lines.
  Reason: that guard is what stops either feed being armed without being watched; it is
  unrelated to this phase.
- Do not call `installOrderAppTriggers()`. Reason: see step 8 — arming the trigger before
  the supervised bring-up makes the first live write unattended and unverified.
- Do not lower the 168h override toward the 96h default. Reason: a weekly feed watched at
  96h alerts every week by construction.
- Do not break existing tests.
