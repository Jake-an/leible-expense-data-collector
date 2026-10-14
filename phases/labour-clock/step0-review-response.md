# Step 0 review response — round 2

- **[important] HOLIDAYS named row with blank date** — Accepted, verified. `labour.gs` `labourReadConfig_` skipped rows when the date key was empty (`if (d)`). Now throws `labour: HOLIDAYS row N has a name but no date` when the name is non-blank; fully blank rows are still skipped. Added test in `test_code.js` (after the malformed-date check): named row with blank date throws naming HOLIDAYS. Full suite: 2790 passed, 0 failed.
- **[minor] test_ingest.py reformat** — Non-blocking, accepted as-is; no change.
- **[minor] people-key test asserts key only** — Non-blocking; RED-committed test left untouched.
- **[minor] commit hygiene / run logs** — Non-blocking; history rewrite out of scope. No change.
