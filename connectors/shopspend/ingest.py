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


def _report_tombstones(body: dict) -> None:
    # The WRITE path was previously invisible: GAS returns tombstonesWritten and
    # nobody read it, so a pull that zeroed out shop-weeks looked identical to
    # one that changed nothing. Suppression warned; the destructive path didn't.
    written = body.get("tombstonesWritten")
    if written:
        print(
            f"[shopspend] {written} shop-week(s) tombstoned as absent",
            file=sys.stderr,
        )

    for entry in body.get("tombstonesSkipped", []):
        week = entry.get("week")
        would_write = entry.get("wouldHaveWritten")
        present = entry.get("present")
        print(
            f"[shopspend] WARNING: tombstones skipped for week {week}: {would_write} would have been written, {present} present",
            file=sys.stderr,
        )


def _send(url: str, payload: dict) -> dict:
    resp = requests.post(url, json=payload, timeout=300)
    body = _parse_response(resp)
    if body.get("result") == "ok":
        _report_tombstones(body)
        return body

    code = body.get("code")
    if code == "LOCKED":
        time.sleep(_LOCKED_RETRY_DELAY_SECONDS)
        resp = requests.post(url, json=payload, timeout=300)
        body = _parse_response(resp)
        if body.get("result") == "ok":
            _report_tombstones(body)
            return body
        code = body.get("code")

    message = body.get("message") or (f"code={code}" if code else "unknown ingest error")
    raise IngestFailed(f"shopspend ingest failed: {message}", code=code)


def declared_weeks(rows: list[dict], weeks_complete: list[str], chunk_size: int = 200) -> list[str]:
    """The weeks post_pull will ACTUALLY declare to GAS.

    A week whose row count exceeds chunk_size has to be split across requests,
    and a split week is posted with no `weeks_complete` at all (it cannot be
    declared without re-opening the C1 bug class). Recording the gate's full
    list instead would make diagnostics_json.harness claim a week was declared
    in precisely the case that key exists to expose.
    """
    counts: dict[str, int] = {}
    for row in rows:
        counts[row["week_label"]] = counts.get(row["week_label"], 0) + 1
    return [w for w in weeks_complete if counts.get(w, 0) <= chunk_size]


def post_pull(
    rows: list[dict],
    pull: dict,
    source: str = "shopspend",
    chunk_size: int = 200,
    exec_url: str | None = None,
    weeks_complete: list[str] | None = None,
    weeks_verified_empty: list[str] | None = None,
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

    if weeks_complete is None:
        weeks_complete = []

    if weeks_verified_empty is None:
        weeks_verified_empty = []

    from collections import defaultdict

    rows_by_week = defaultdict(list)
    for row in dated_rows:
        rows_by_week[row["week_label"]].append(row)

    if weeks_complete:
        declared = set(weeks_complete)
        verified_empty_set = set(weeks_verified_empty)
        split_weeks = {w for w in weeks_complete if len(rows_by_week[w]) > chunk_size}

        for week in sorted(split_weeks):
            print(
                f"[shopspend] WARNING: week {week} has {len(rows_by_week[week])} row(s), exceeds chunk_size {chunk_size}, declared in no request",
                file=sys.stderr,
            )

        # Weeks carrying rows that nobody declared complete. They must still be
        # posted — dropping them silently loses spend data — but must never be
        # declared, since declaring authorises GAS to tombstone a week whose
        # completeness we never established. Same shape as the split-week path.
        undeclared_weeks = sorted(w for w in rows_by_week if w not in declared and rows_by_week[w])
        if undeclared_weeks:
            print(
                f"[shopspend] WARNING: rows for undeclared week(s) {undeclared_weeks} posted "
                "without weeks_complete — absence not assessed for them",
                file=sys.stderr,
            )

        complete_weeks_only = [w for w in weeks_complete if w not in split_weeks]

        def _send_declared(chunk_rows, chunk_weeks):
            payload = {
                "source": source,
                "kind": "shopspend",
                "rows": chunk_rows,
                "extracted_at": extracted_at,
                "weeks_complete": chunk_weeks,
            }
            # Scope to THIS request. validateIngest_ rejects any
            # weeks_verified_empty entry absent from the same payload's
            # weeks_complete, and each request is validated alone — attaching
            # the full list to every chunk aborts the whole pull.
            chunk_verified = [w for w in chunk_weeks if w in verified_empty_set]
            if chunk_verified:
                payload["weeks_verified_empty"] = chunk_verified
            _send(url, payload)

        chunk = []
        chunk_weeks = []
        for week in sorted(complete_weeks_only):
            week_rows = rows_by_week[week]

            if len(chunk) + len(week_rows) <= chunk_size:
                chunk.extend(week_rows)
                chunk_weeks.append(week)
            else:
                if chunk:
                    _send_declared(chunk, chunk_weeks)
                chunk = list(week_rows)
                chunk_weeks = [week]

        if chunk or chunk_weeks:
            _send_declared(chunk, chunk_weeks)

        for week in sorted(split_weeks) + undeclared_weeks:
            week_rows = rows_by_week[week]
            for offset in range(0, len(week_rows), chunk_size):
                chunk_data = week_rows[offset : offset + chunk_size]
                payload = {
                    "source": source,
                    "kind": "shopspend",
                    "rows": chunk_data,
                    "extracted_at": extracted_at,
                }
                _send(url, payload)
    else:
        for offset in range(0, len(dated_rows), chunk_size):
            chunk = dated_rows[offset : offset + chunk_size]
            payload = {
                "source": source,
                "kind": "shopspend",
                "rows": chunk,
                "extracted_at": extracted_at,
            }
            _send(url, payload)

    final_payload = {
        "source": source,
        "kind": "shopspend",
        "rows": [],
        "extracted_at": extracted_at,
        "pull": pull,
    }
    return _send(url, final_payload)
