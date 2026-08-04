# Step 5 — shopspend-runner-and-bridge

## What was built

- `connectors/shopspend/ingest.py` — `post_pull()`: sends `kind:'shopspend'` on
  every request (never reuses `BaseConnector.post`, which sends no `kind` and
  has no retry), chunks rows at `chunk_size` (default 200), forces every row's
  `date` to its own `week_start`, sends the `ShopSpendPulls` diagnostics row
  LAST as an empty-rows request carrying `pull` (the commit marker), retries
  a `LOCKED` body once after 60s via `time.sleep` (patched by the test
  fixture), and raises `IngestFailed` (carrying `.code`) on anything else
  that isn't `result:'ok'` — including a non-JSON body.
- `connectors/shopspend/runner.py` — the CLI: `default_week_label` (today - 7
  days, so a Monday 05:00 job never asks for the current, still-open week),
  `last_n_closed_weeks`, `missing_weeks_for_backfill`, `map_api_row`
  (camelCase → snake_case, `date` always `week_start`), `truncate_diagnostics_json`
  (defensive 50,000-char Sheets cell cap), and `main()` wiring `--week`,
  `--from-week`/`--to-week`, `--backfill`, `--dry-run`.
- `docs/ingest-contract.md` + `connectors/gas/Code.gs:165-168` — corrected:
  neither doc now claims `BaseConnector.post` retries `LOCKED`; both now name
  `connectors/shopspend/ingest.py` as the one poster that does. No behaviour
  change to `Code.gs` (comment only, confirmed via `git diff`).

## One gap, called out rather than silently punted

`--backfill`'s spec ("compute which of the last 4 closed weeks have no
`ShopSpendPulls` coverage yet") assumes a way to *read* `ShopSpendPulls`
coverage from the hub. No such read endpoint exists — `doGet` only serves the
`Summary` tab (`docs/api.md`); `ShopSpendPulls` isn't queryable over HTTP.

`missing_weeks_for_backfill(candidate_weeks, covered)` is implemented and
fully tested as a pure function (the `covered` set is caller-supplied), but
`main()`'s `--backfill` path does **not** call it — there is nothing to
supply `covered` from yet. Instead `--backfill` requests the full 4-week
range unconditionally (`last_n_closed_weeks` → one ranged `from_week..to_week`
fetch). This is safe, not a correctness gap: step 3's ingest is fully
idempotent (identical re-pulls are `duplicatesSkipped`, not re-added), so
re-requesting already-covered weeks costs one extra external API call and
writes nothing new. It's a missed optimization, not a bug.

Wiring real coverage detection needs a hub-side read capability that doesn't
exist yet (a new `doGet` mode, or similar) — that's follow-up work, likely
alongside step 7 (`shopspend-watchdog-and-trigger`), not this step.
