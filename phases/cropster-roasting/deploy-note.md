# cropster-roasting — deploy note (2026-10-22)

| step | result |
|---|---|
| Deploy 1 | @64, tag `prod-2026-10-22-cropster-1`, rollback @63; audit seq 7 (full) APPROVE 0 High |
| Smoke | tokenless /exec + fn=roasting → unauthorized; tokened fn=roasting ok (tab absent note); fn=summary ok |
| Ingest token | authenticated empty post → `roasting_empty` (auth passed, nothing written); wrong token → UNAUTHORIZED |
| Live backfill | `--backfill` → result ok, rowsAdded 122 (12 weeks) |
| Read-back | fn=roasting 2026-07-27..2026-10-12 → 12 weeks, 122 rows |
| Spot-check | week 2026-10-12: hub totalKg = Cropster Production Report summary (Chrome) |
| Deploy 2 | @65, tag `prod-2026-10-22-cropster-2`, rollback @64; audit seq 8 (scoped) APPROVE 0 High; staleness armed 192h |
| Schedule | `LEIBLE Cropster Weekly` Mon 05:30, StartWhenAvailable; test-fire LastTaskResult 0, rowsUpdated 22 / rowsAdded 0 |
