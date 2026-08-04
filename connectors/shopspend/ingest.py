"""shopSpend GAS ingest poster (step 5 — GREEN implements this).

`BaseConnector.post()` (connectors/playwright/base_connector.py) is NOT
reused here — it hardcodes `kind='suppliers'` implicitly (sends no `kind` at
all) and has no `LOCKED` retry. This poster sends `kind:'shopspend'` on every
request and retries a `LOCKED` response exactly once, after 60s.

The GAS endpoint always answers HTTP 200 — success/failure lives in the JSON
body's `result` field. A `LOCKED` body carries `code` but no `message`, so
`IngestFailed` always surfaces `code` even when `message` is absent.
"""

from __future__ import annotations

import sys
import time
from datetime import datetime
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "playwright"))
import base_connector as bc

_LOCKED_RETRY_DELAY_SECONDS = 60


class IngestFailed(Exception):
    """Raised when the shopspend ingest endpoint rejects a request, or its
    response body can't be parsed as JSON. Carries `code` when the body had
    one (e.g. 'LOCKED') — never silently dropped even when `message` isn't
    present."""

    def __init__(self, message: str, code: str | None = None):
        self.code = code
        super().__init__(message)


def _parse_response(resp) -> dict:
    try:
        return resp.json()
    except ValueError as err:
        raise IngestFailed(f"shopspend ingest: non-JSON response ({err})") from err


def _send(url: str, payload: dict) -> dict:
    resp = requests.post(url, json=payload, timeout=300)
    body = _parse_response(resp)
    if body.get("result") == "ok":
        return body

    code = body.get("code")
    if code == "LOCKED":
        time.sleep(_LOCKED_RETRY_DELAY_SECONDS)
        resp = requests.post(url, json=payload, timeout=300)
        body = _parse_response(resp)
        if body.get("result") == "ok":
            return body
        code = body.get("code")

    message = body.get("message") or (f"code={code}" if code else "unknown ingest error")
    raise IngestFailed(f"shopspend ingest failed: {message}", code=code)


def post_pull(
    rows: list[dict],
    pull: dict,
    source: str = "shopspend",
    chunk_size: int = 200,
    exec_url: str | None = None,
) -> dict:
    url = exec_url or bc.resolve_exec_url()
    if not url:
        raise RuntimeError(
            "No GAS /exec URL: GAS_EXEC_URL is unset and config/deployment.json has no "
            "execUrl. Run bash scripts/deploy.sh, or export GAS_EXEC_URL."
        )

    extracted_at = datetime.now(bc.SYD_TZ).isoformat(timespec="seconds")

    dated_rows = []
    for row in rows:
        dated_row = dict(row)
        dated_row["date"] = dated_row["week_start"]
        dated_rows.append(dated_row)

    for offset in range(0, len(dated_rows), chunk_size):
        chunk = dated_rows[offset : offset + chunk_size]
        payload = {
            "source": source,
            "kind": "shopspend",
            "rows": chunk,
            "extracted_at": extracted_at,
        }
        _send(url, payload)

    # Pulls diagnostics row LAST, with an empty rows list — this is the commit
    # marker (see docs/schema.md ShopSpendPulls): its absence after a partial
    # write is how a resumed pull is detected as incomplete.
    final_payload = {
        "source": source,
        "kind": "shopspend",
        "rows": [],
        "extracted_at": extracted_at,
        "pull": pull,
    }
    return _send(url, final_payload)
