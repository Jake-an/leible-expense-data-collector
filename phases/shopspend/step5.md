# Step 5: shopspend-runner-and-bridge

## Files to Read

- `docs/ARCHITECTURE.md` — the shopSpend flow (step 0).
- `docs/ingest-contract.md` — the `doPost` wire contract. **Lines 85-87 are currently WRONG** and
  you are fixing them in this step (see Task 4).
- `connectors/shopspend/client.py` + `models.py` — built in step 4. `ShopSpendClient.fetch`,
  `resolve_config`, `parse_week_label`, `ShopSpendError`, `ShopSpendTransientError`.
- `connectors/playwright/base_connector.py` — `resolve_exec_url` (**168-184**) and `post`
  (**354-371**). Read `post` to understand what it does NOT do (no `kind`, no retry) — you are
  writing a replacement, not calling it.
- `connectors/gas/Code.gs` — the `LOCKED` branch (**143-145**), the response shape (**152-157**),
  and the stale comment at **142** you are correcting.

## Background

The Playwright `BaseConnector.post()` cannot be reused here, for two independently fatal reasons:

1. It hardcodes `payload = {source, rows, extracted_at}` with **no `kind` field**, so a shopspend
   payload falls through to `kind='suppliers'` (`Code.gs:128`) and every row is rejected for a
   missing `total`/`invoice_ref`.
2. The `LOCKED` retry that `docs/ingest-contract.md:85-87` and the comment at `Code.gs:142` both
   claim it performs **does not exist** — there is no retry, no sleep, no `code` inspection in that
   method. Both docs are stale and are corrected here.

Worse, the `LOCKED` body is `{result:'error', code:'LOCKED', retryable:true}` — it has **no
`message` key**, so a naive `body.get("message", "unknown ingest error")` raises literally
`"unknown ingest error"`. With chunked writes, a `LOCKED` on chunk 3 of 5 would leave chunks 1-2
written, no commit marker, no retry, and a useless error string.

## Task

**1. `connectors/shopspend/ingest.py` — the poster.**

```python
class IngestFailed(Exception): ...  # carries .code when the body had one


def post_pull(
    rows: list[dict],
    pull: dict,
    source: str = "shopspend",
    chunk_size: int = 200,
    exec_url: str | None = None,
) -> dict: ...
```

- Resolve the GAS `/exec` URL via `resolve_exec_url()` from `base_connector`; fail loud if empty.
- Send `{"source": source, "kind": "shopspend", "rows": [...], "extracted_at": <stamp>}`.
- **Every row carries a synthetic `date` equal to its `week_start`** (the Monday). Reason:
  `validateIngest_` requires `date` on every row for every kind, and that line is shared with all
  six existing connectors — the synthetic date is how we satisfy it without touching them.
- **Chunk at `chunk_size` rows**, all chunks sharing one `fetched_at`. Send the
  `ShopSpendPulls` diagnostics row **LAST**, as `body.pull` on a final request, so it acts as the
  commit marker: a partially-written pull is detectable by the absence of its pulls row.
- **Raise on anything that is not `result == "ok"`**, and always surface `code` in the message.
  Never fall back to a lenient success.
- **Retry `code == "LOCKED"` once after 60s**, then raise. The sleep must be injectable.
- `requests.post(..., timeout=300)`; GAS hard-kills at 360s, so a client-side timeout can occur
  mid-write — which is why resume must be idempotent (step 3 guarantees identical figures append
  nothing).

**2. `connectors/shopspend/runner.py` — the CLI.**

```
python -m connectors.shopspend.runner [--week 2026-W31] [--from-week X --to-week Y]
                                      [--backfill] [--dry-run]
```

- **Default (no args): pull the ISO week that just CLOSED** — `date.today() - timedelta(days=7)`,
  then `.isocalendar()` → `f"{year}-W{week:02d}"`. A Monday 05:00 job asking for the *current*
  week would get a week five hours old.
- **`--backfill`: the last 4 closed weeks.** On every run, compute which of those 4 weeks have no
  `ShopSpendPulls` coverage yet and request only the missing span — this is what self-heals a
  Monday when the machine was off.
- **`--dry-run`: fetch, parse, print a summary plus every triggered data-quality condition, and
  write NOTHING.** This is how the live contract gets validated before anything touches the Sheet.
- Map API camelCase → our snake_case row shape: `shopId`→`shop_id`, `weekLabel`→`week_label`,
  `weekStart`→`week_start`, `weekEnd`→`week_end`, `orderCount`→`order_count`,
  `amendedCount`→`amended_count`, `totalExGst`→`total_ex_gst`, `gst`→`gst`,
  `totalIncGst`→`total_inc_gst`; plus `gst_treatment` from `meta.gstTreatment`, `environment` from
  `meta.environment`, `date` = `week_start`.
- Build the `pull` dict from `meta.paging` + `diagnostics`, matching `SHOPSPEND_PULLS_HEADERS`.
  Truncate `diagnostics_json` defensively — a Sheets cell caps at 50,000 characters, and the blob
  is largest exactly when the pull went badly.
- Exit non-zero on any failure. Never swallow an ingest rejection.

**3. Sort output by `parse_week_label`** wherever weeks are ordered for display.

**4. Correct the two stale docs** — `docs/ingest-contract.md:85-87` and the comment at
`Code.gs:142` — so they describe what the code actually does: `BaseConnector.post` does **not**
retry; the shopSpend poster (`connectors/shopspend/ingest.py`) retries `LOCKED` once after 60s.
This is a comment/doc change to `Code.gs` only — **no behaviour change to that file.**

### Test First (TDD step)

Write `connectors/shopspend/test_runner.py` before implementing. Fake `requests.post` and the
client; inject the sleep. Confirm RED, then implement to green.

Test cases (definition of done):
- **Just-closed week:** on a Monday, the default week is the previous ISO week, not the current one.
- **Year boundary:** a date in early January 2027 resolves to `2026-W52`/`2026-W53` correctly, and
  a `2027-W01` label formats with the zero-padded `W01`.
- **Gap detection:** given `ShopSpendPulls` coverage for 3 of the last 4 weeks, `--backfill`
  requests the missing week.
- **Chunking:** 450 rows at `chunk_size=200` issues 3 data requests plus the pulls request; every
  chunk carries the SAME `fetched_at`; the pulls request is LAST.
- **`kind` is always sent** as `"shopspend"` on every chunk.
- **Synthetic `date`:** every posted row has `date == week_start`.
- **`LOCKED` retried once** after an injected 60s sleep, then succeeds; a second `LOCKED` raises
  `IngestFailed` with `LOCKED` in the message (the body has no `message` key — assert the code
  still surfaces).
- **Non-ok raises:** `{"result": "error", "message": "..."}` raises; a non-JSON 200 raises. Neither
  is ever treated as success.
- **Idempotent resume:** re-posting an already-written chunk is a no-op — a stubbed GAS returning
  `rowsAdded: 0, duplicatesSkipped: n` is a success, not an error.
- **`--dry-run` writes nothing:** `requests.post` is never called; the summary still prints the
  triggered data-quality conditions.
- **Diagnostics truncation:** an oversized blob is truncated below 50,000 characters.
- **Field mapping:** a full API row maps onto every `SHOPSPEND_HEADERS` field with no `None` gaps.

## Acceptance Criteria

```bash
python -m pytest connectors/shopspend -q     # all pass; exit 0
ruff check connectors/shopspend
```

## Verification Procedure

1. Run both AC commands, then the full suite: `python -m pytest -q`.
2. Confirm `git diff connectors/gas/Code.gs` contains **only** the corrected comment at line 142 —
   no behaviour change in this step.
3. Grep the diff for token leaks: no URL or `params` in any log line.
4. Update `phases/shopspend/index.json` step 5 (`completed` + `summary`, or `error` +
   `error_message`, or `blocked` + `blocked_reason` then stop).

## Prohibitions

- Do not modify `BaseConnector.post()` or any Playwright connector. Reason: six live connectors
  depend on that exact wire format; the whole point of a separate poster is to leave it alone.
- Do not fall back to a lenient `{"result": "ok"}` on an unparseable body. Reason: that exact
  leniency is the silent-failure class phase `fix-silent-ingest-failures` was built to kill.
- Do not retry anything except `LOCKED` here. Reason: API-side retry belongs to the client
  (step 4); this layer talks to our own GAS.
- Do not run the real backfill or hit the live endpoint. Reason: needs Jake and a real token, and
  the shared script lock — that is the attended integration step.
- Do not re-derive `week_start`/`week_end`. Reason: the API supplies them; recomputing invites an
  off-by-one against ISO weeks.
