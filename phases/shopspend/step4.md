# Step 4: shopspend-python-client

## Files to Read

- `docs/ARCHITECTURE.md` — the shopSpend flow added in step 0.
- `connectors/playwright/base_connector.py` — read `load_env_file` (**49-84**), `get_credential`
  (**87-93**), `resolve_exec_url` (**168-184**), and `post` (**354-371**). You will **import**
  `get_credential`; you will **not** reuse `post` (see Prohibitions).
- `connectors/playwright/test_base_connector.py` — the pytest conventions used in this repo:
  tests sit beside source, `monkeypatch` fixtures, a `_FakePostResponse`-style fake rather than a
  network mock library.
- `pyproject.toml` — ruff config. `connectors/gas` is excluded; **`connectors/shopspend/` is NOT**,
  so this code is linted: `target-version = py312`, `line-length = 100`,
  `select = ["E","W","F","I","UP","B","SIM","C4"]`, `quote-style = "double"`.

## Background — the external API contract (authoritative)

```
GET https://script.google.com/macros/s/AKfycbwuLSrcyi-e0dLyjEP4-unU5CLCywm6-SRFhSOq_Cufdn0MnvY0MtP4zNvGj20Dy4S9RQ/exec
    ?api=shopSpend&token=<secret>&fromWeek=2026-W31&toWeek=2026-W31&include=rows,summary
```

| Param | Required | Notes |
|---|---|---|
| `api` | yes | literal `shopSpend` |
| `token` | yes | secret |
| `fromWeek` / `toWeek` | no | `YYYY-Www`, both inclusive; omit both for all history |
| `include` | no | `rows`, `summary`, or `rows,summary` (default both) |
| `limit` / `offset` | no | paging; default limit 2000, max 10000 |

There is deliberately **no calendar-date filter** — ask by week or not at all.

Success body (abridged):

```json
{ "ok": true, "schemaVersion": 1,
  "meta": { "environment": "PROD", "timezone": "Australia/Sydney",
            "gstTreatment": "EXCLUSIVE_PRIMARY", "scope": "Confirmed orders only",
            "paging": { "limit": 2000, "offset": 0, "matched": 46, "returned": 46,
                        "rowsIncluded": true, "truncated": false },
            "unknownParams": [] },
  "rows": [ { "shopId": "Leible York", "weekLabel": "2026-W26",
              "weekStart": "2026-06-22", "weekEnd": "2026-06-28",
              "orderCount": 2, "amendedCount": 0,
              "totalExGst": 3360.77, "gst": 27.18, "totalIncGst": 3387.96 } ],
  "summary": { "shopCount": 11, "weekCount": 8, "orderCount": 48, "amendedCount": 0,
               "grandTotalExGst": 105069.35, "grandTotalGst": 1061.91,
               "grandTotalIncGst": 106131.26, "byShop": [ ... ] },
  "diagnostics": { "warnings": [], "pricingBasis": { "exGst": {...}, "gst": "...", "note": "..." },
                   "emptyRangeWithInvalidLabels": false, "gstBasisMismatch": 16,
                   "unpricedSkus": [], "invalidWeekLabels": 0, "invalidWeekLabelSamples": [],
                   "possibleDuplicateShopNames": [], "multiBucketWeeks": 0,
                   "multiBucketWeekSamples": [], "totalOrdersScanned": 48,
                   "positiveControlCount": 2 } }
```

Error body: `{ "ok": false, "error": "UNAUTHORIZED" }`. Codes: `UNAUTHORIZED` (bad/missing token,
no detail by design), `BAD_REQUEST` (has `detail`), `SCHEMA` (has `detail`), `INTERNAL` (has
`detail` + `traceId`).

**Two hard rules.**

1. **Follow redirects.** Apps Script 302s to a `googleusercontent.com` host; a client with
   redirects disabled receives HTML, not JSON.
2. **Never branch on HTTP status.** `ContentService` cannot set status codes, so *everything* is
   HTTP 200 — auth failures and server errors included. Parse the body and branch on `ok`. Treat a
   non-JSON body as a transient infrastructure failure and retry: Apps Script intermittently serves
   a Google "Page not found" HTML page for ~60s after a redeploy.

## Task

Create `connectors/shopspend/` with `__init__.py`, `models.py`, `client.py`, and `test_client.py`.

**`models.py`** — typed containers (dataclasses or `TypedDict`) for `ShopSpendRow`, `Paging`,
`Meta`, `Summary`, `Diagnostics`, `ShopSpendResponse`. They must **tolerate unknown fields** — the
server may add keys additively and that must not raise.

**`client.py`**

```python
class ShopSpendError(Exception):          # fatal; carries .code and optional .detail/.trace_id
class ShopSpendTransientError(Exception): # retryable

class ShopSpendClient:
    def __init__(self, url: str, token: str, environment: str, timeout: int = 120) -> None: ...
    def fetch(self, from_week: str | None = None, to_week: str | None = None,
              include: str = "rows,summary") -> ShopSpendResponse: ...

def resolve_config() -> tuple[str, str, str]:   # (url, token, environment) from SHOPSPEND_ENV
def parse_week_label(label: str) -> tuple[int, int]   # '2026-W31' -> (2026, 31)
```

Behaviour:

- **Config** via `get_credential()` from `base_connector`: `SHOPSPEND_ENV` (`PROD`|`DEV`) selects
  `SHOPSPEND_URL_<ENV>` and `SHOPSPEND_TOKEN_<ENV>`. `get_credential` returns `None` rather than
  raising, so assert explicitly and fail loud.
- **Fail closed across environments:** after a successful parse, if `meta.environment` does not
  equal the configured `SHOPSPEND_ENV`, raise `ShopSpendError` — do not return data.
- **Request:** `requests.get(url, params={...}, timeout=..., allow_redirects=True)`. Set
  `allow_redirects` explicitly rather than relying on the default.
- **Retryable = exactly three classes:** `error == "INTERNAL"`, a body that will not parse as JSON,
  and transport failures (`requests.ConnectionError`, `Timeout`, `ChunkedEncodingError`).
  `UNAUTHORIZED`, `BAD_REQUEST`, `SCHEMA` are fatal with **zero** retries.
- **Backoff:** 2, 5, 10, 20, 30 seconds plus jitter (≈67s total), spanning the documented ~60s
  post-redeploy window. Sleep must be injectable so tests do not actually wait.
- **Log `traceId`** when the error is `INTERNAL`.
- **Paging:** loop on `meta.paging`, advancing `offset` until `offset + returned >= matched`.
  Concatenate `rows`; keep the first response's `meta`/`summary`/`diagnostics`. Respect max
  `limit` 10000.
- **Secret hygiene — this is the sharp edge.** The token travels in the query string, and
  `requests` embeds the full URL in `RequestException` messages, in `resp.url`, and in tracebacks.
  Wrap every call; re-raise through a `_redact(text)` helper that replaces the token value with
  `***`. Log lines carry only `api=shopSpend fromWeek=… toWeek=…` — never `params`, never a URL.
- **`parse_week_label`** returns an `(int, int)` tuple for numeric sorting. Sorting by the raw
  label is wrong: `'2026-W9' > '2026-W10'` lexicographically.

Core rules that must not deviate:
- Never inspect `resp.status_code` to decide success or failure. Reason: everything is 200; a
  status branch would treat an auth failure as a success.
- Never re-derive week boundaries. Reason: `weekStart`/`weekEnd` come from the API and are
  authoritative; this step only ever *parses* a label to sort or to choose a week to request.
- Never hardcode or log the token.

### Test First (TDD step)

Write `connectors/shopspend/test_client.py` before implementing. Fake the `requests.get` call with
`monkeypatch` and a fake response object exposing `.text`, `.json()`, `.url`, `.status_code` — no
network, no token. Confirm RED (module/attribute does not exist), then implement to green.

Test cases (definition of done):
- **HTTP 200 + `ok:false` is never success:** a 200 carrying `{"ok": false, "error": "UNAUTHORIZED"}`
  raises `ShopSpendError`, with **exactly zero** retries (assert the call count is 1).
- Same zero-retry assertion for `BAD_REQUEST` and `SCHEMA`.
- **`INTERNAL` retries** and surfaces `traceId`; succeeds if a later attempt returns `ok:true`;
  raises after the ladder is exhausted.
- **Non-JSON body retries:** an HTML "Page not found" page at HTTP 200 is transient, not success.
- **Transport failures retry:** `requests.ConnectionError` and `Timeout` each retry.
- **Redirects requested:** the call passes `allow_redirects=True`.
- **Paging:** `matched: 4500` with `limit: 2000` issues 3 calls with offsets 0/2000/4000 and
  returns 4500 concatenated rows; a single-page response issues exactly 1 call.
- **Sorting:** `sorted(labels, key=parse_week_label)` puts `2026-W9` before `2026-W10`, and
  `2026-W52` before `2027-W01`; plain `sorted()` on the raw labels does not (assert the contrast).
- **Redaction:** a `requests.RequestException` whose message contains the token, and a fake
  `resp.url` containing the token, both come back with `***` and no token substring anywhere in
  the raised exception.
- **Environment mismatch:** configured `PROD` but `meta.environment == "DEV"` raises, and returns
  no rows.
- **Missing token fails loud:** with `SHOPSPEND_TOKEN_PROD` unset, `resolve_config()` raises
  rather than returning `None`.
- **Unknown response fields are tolerated:** a response with an extra `meta.somethingNew` key
  parses without raising.

## Acceptance Criteria

```bash
python -m pytest connectors/shopspend -q     # all pass; exit 0
ruff check connectors/shopspend
```

## Verification Procedure

1. Run both AC commands.
2. Grep the diff for leaks: no literal token, no `print` of `params` or a URL, no
   `resp.status_code` branch deciding success.
3. Confirm the whole suite is unaffected: `python -m pytest -q`.
4. Update `phases/shopspend/index.json` step 4 (`completed` + `summary`, or `error` +
   `error_message`, or `blocked` + `blocked_reason` then stop).

## Prohibitions

- Do not modify `connectors/playwright/base_connector.py`. Reason: it is on the hot path for all
  six existing connectors; importing from it is fine, changing it is not.
- Do not reuse `BaseConnector.post()`. Reason: it hardcodes a payload with **no `kind` field**, so
  a shopspend payload would be validated as `suppliers` and rejected. The poster is step 5.
- Do not branch on HTTP status anywhere. Reason: ContentService returns 200 for everything.
- Do not retry `UNAUTHORIZED` or `BAD_REQUEST`. Reason: the contract forbids it — retrying a bad
  token just burns quota against an endpoint designed for ~1 call per week.
- Do not poll or call the endpoint per page load. Reason: one call reads an entire spreadsheet.
- Do not hit the real network in tests. Reason: tests must run with no token present.
