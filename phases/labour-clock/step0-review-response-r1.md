# Step 0 review response (round 1)

Fixed in connectors/gas/labour.gs, with new tests in connectors/gas/test_code.js (L2 block):
- [important] HOLIDAYS malformed date now throws naming the HOLIDAYS row. This also stops the NaN span suppressing labour_holidays_expiring, so no separate guard in labourHolidayAlerts_.
- [minor] Duplicate CONFIG composite key now throws naming the row.
- [minor] RATES effective_from must match yyyy-MM-dd, otherwise it throws naming the row (blank also rejected).

Not changed:
- [minor] connectors/shopspend/test_ingest.py reformat: out of this step's scope. I did not revert history. Move to a style commit if unwanted.
- [minor] weak L1 checks: reviewer says "later cleanup"; RED tests must not be modified.
- [minor] commit hygiene (duplicate subjects, step0-*.log): history rewrite is out of scope; gitignore the logs in a follow-up.
