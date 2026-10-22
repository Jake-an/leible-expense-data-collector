# shop-coffee-kg — deploy-live evidence (2026-10-22)

- Readiness: `health-probe` marked green by Jake (tokenless smoke + tokened fn probe), commit 408c62c.
- Tag `prod-2026-10-22-shopcoffee`; rollback anchor deployment @62.
- `/security-audit` (scoped, audit_seq 6) at final HEAD: **approve** — gates 6/6, 0 High.
- `bash scripts/deploy.sh` → deployment `AKfycbypZz…wnfM` @63 (id unchanged); tokenless smoke `{"result":"error","message":"unauthorized"}`.
- Tokened `fn=shopCoffee` before first pull → `ok:true`, note "ShopCoffee tab not found"; no-token → unauthorized.
- Editor (Claude, Chrome): `installOrderAppTriggers` → log lists `shopCoffeePull Monday 06:30 (Australia/Sydney)`; `shopCoffeePullDry` → weeksRequested 12, weeksWritten 12, weeksSkipped 0.
  - Also (accidental mis-selection) `shopifyWeeklyPull` ran once — idempotent scheduled pull, completed clean.
- Real run `shopCoffeePullRun` (clicked by Jake — classifier denied Claude's Run click): 12 weeks, 48 rows, 0 skipped, unclassified 0 kg every week; unmapped = Leible Taiwan + external cafes only.
- Post-run tokened `fn=shopCoffee` 2026-07-27..2026-10-19 → 48 rows, 12 weeks. 12-week totals: York bar 463.0 / retail 298.2; Pitt 856.3 / 204.6; Crowsnest 99.5 / 98.8 (orders in 5/12 weeks); North (Leible Blue) 704.0 / 276.5.
- Chrome read-only: ShopCoffee tab shows the 10-column header and week × 4-shop rows.
