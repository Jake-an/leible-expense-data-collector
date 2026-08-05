"""shopSpend external API client.

Two hard rules (see docs/ARCHITECTURE.md shopSpend flow):

1. Follow redirects — Apps Script 302s to a googleusercontent.com host.
2. Never branch on HTTP status. ContentService always answers 200; success or
   failure is decided by the JSON body's `ok` field. A non-JSON body (the
   post-redeploy "Page not found" HTML page) is treated as transient, not a
   failure to surface.

The token travels in the query string, so every error path here is redacted
before it can reach an exception, a log line, or stdout/stderr.
"""

from __future__ import annotations

import random
import sys
import time
from pathlib import Path
from urllib.parse import quote

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "playwright"))
import base_connector as bc

from shopspend.models import Diagnostics, Meta, ShopSpendResponse, ShopSpendRow, Summary

_BACKOFF_LADDER = (2, 5, 10, 20, 30)
_MAX_ATTEMPTS = len(_BACKOFF_LADDER) + 1
_FATAL_CODES = frozenset({"UNAUTHORIZED", "BAD_REQUEST", "SCHEMA"})


class ShopSpendError(Exception):
    """Fatal — do not retry. Carries the API's `error` code and optional detail."""

    def __init__(self, code: str, detail: str | None = None, trace_id: str | None = None):
        self.code = code
        self.detail = detail
        self.trace_id = trace_id
        message = f"shopSpend error {code}"
        if detail:
            message += f": {detail}"
        super().__init__(message)


class ShopSpendTransientError(Exception):
    """Retryable — backoff ladder exhausted without a definitive answer."""


def _redact(text: str, token: str) -> str:
    if not text or not token:
        return text
    redacted = text.replace(token, "***")
    encoded_token = quote(token, safe="")
    if encoded_token != token:
        redacted = redacted.replace(encoded_token, "***")
    return redacted


def parse_week_label(label: str) -> tuple[int, int]:
    """'2026-W31' -> (2026, 31), for numeric (not lexicographic) sorting."""
    year_part, _, week_part = label.partition("-W")
    return int(year_part), int(week_part)


def resolve_config() -> tuple[str, str, str]:
    """(url, token, environment) from SHOPSPEND_ENV + SHOPSPEND_{URL,TOKEN}_<ENV>.

    Fails loud: get_credential() returns None rather than raising, so each
    piece is checked explicitly here.
    """
    environment = bc.get_credential("SHOPSPEND_ENV")
    if not environment:
        raise RuntimeError("SHOPSPEND_ENV is not set")

    url = bc.get_credential(f"SHOPSPEND_URL_{environment}")
    if not url:
        raise RuntimeError(f"SHOPSPEND_URL_{environment} is not set")

    token = bc.get_credential(f"SHOPSPEND_TOKEN_{environment}")
    if not token:
        raise RuntimeError(f"SHOPSPEND_TOKEN_{environment} is not set")

    return url, token, environment


class ShopSpendClient:
    def __init__(self, url: str, token: str, environment: str, timeout: int = 120) -> None:
        self.url = url
        self.token = token
        self.environment = environment
        self.timeout = timeout

    def fetch(
        self,
        from_week: str | None = None,
        to_week: str | None = None,
        include: str = "rows,summary",
    ) -> ShopSpendResponse:
        offset = 0
        all_rows: list[ShopSpendRow] = []
        response_meta: Meta | None = None
        response_summary: Summary | None = None
        response_diagnostics: Diagnostics | None = None
        schema_version = None

        while True:
            params = {"api": "shopSpend", "token": self.token, "include": include, "offset": offset}
            if from_week:
                params["fromWeek"] = from_week
            if to_week:
                params["toWeek"] = to_week

            body = self._request(params)

            meta = Meta.from_dict(body.get("meta"))
            if meta.environment != self.environment:
                raise ShopSpendError(
                    code="ENVIRONMENT_MISMATCH",
                    detail=f"configured={self.environment} response={meta.environment}",
                )

            rows = [ShopSpendRow.from_dict(row) for row in body.get("rows") or []]
            all_rows.extend(rows)

            if response_meta is None:
                response_meta = meta
                response_summary = Summary.from_dict(body.get("summary"))
                response_diagnostics = Diagnostics.from_dict(body.get("diagnostics"))
                schema_version = body.get("schemaVersion")

            paging = meta.paging
            returned = paging.returned if paging else len(rows)
            matched = paging.matched if paging else len(rows)
            if offset + returned >= matched:
                break
            offset += returned

        return ShopSpendResponse(
            rows=all_rows,
            meta=response_meta,
            summary=response_summary,
            diagnostics=response_diagnostics,
            schemaVersion=schema_version,
        )

    def _request(self, params: dict) -> dict:
        """One page's worth of GET, with the retryable-error backoff ladder.

        Retryable: error == 'INTERNAL', a non-JSON body, transport failures.
        Fatal (raise immediately, zero retries): UNAUTHORIZED, BAD_REQUEST, SCHEMA.
        """
        last_error_message = "unknown error"

        for attempt in range(_MAX_ATTEMPTS):
            if attempt > 0:
                delay = _BACKOFF_LADDER[attempt - 1]
                time.sleep(delay + random.uniform(0, delay * 0.2))

            try:
                resp = requests.get(
                    self.url, params=params, timeout=self.timeout, allow_redirects=True
                )
            except (
                requests.ConnectionError,
                requests.Timeout,
                requests.exceptions.ChunkedEncodingError,
            ) as err:
                last_error_message = self._redact(str(err))
                continue

            try:
                body = resp.json()
            except ValueError:
                last_error_message = self._redact(
                    f"non-JSON response (url={resp.url}): {resp.text[:200]}"
                )
                continue

            if body.get("ok"):
                return body

            error_code = body.get("error", "UNKNOWN")
            detail = body.get("detail")

            if error_code == "INTERNAL":
                trace_id = body.get("traceId")
                print(
                    f"[shopspend] retry reason=INTERNAL api=shopSpend "
                    f"fromWeek={params.get('fromWeek')} toWeek={params.get('toWeek')} "
                    f"traceId={trace_id}",
                    file=sys.stderr,
                )
                last_error_message = self._redact(f"INTERNAL error traceId={trace_id}: {detail}")
                continue

            # Fatal — including unrecognized codes, which we don't retry either.
            raise ShopSpendError(code=error_code, detail=self._redact(detail) if detail else None)

        raise ShopSpendTransientError(
            f"shopSpend request failed after {_MAX_ATTEMPTS} attempts: {last_error_message}"
        )

    def _redact(self, text: str) -> str:
        return _redact(text, self.token)


def fetch_coverage() -> set[str]:
    """Covered ISO week labels from the hub's `ShopSpendPulls` tab
    (`fn=shopspendCoverage`, docs/api.md) — advisory input to `--backfill`
    narrowing (runner.py). Resolves the hub URL exactly like ingest.py
    (`GAS_EXEC_URL`, else `execUrl` in config/deployment.json) and reads the
    token from `GAS_READ_TOKEN`, a separate credential from the shopSpend
    external-API token.

    Never returns an empty set on failure — that would be indistinguishable
    from a genuine cold-start hub with nothing stored yet, so callers must
    treat any exception here as "coverage unknown", not "nothing covered".
    """
    url = bc.resolve_exec_url()
    if not url:
        raise RuntimeError(
            "No GAS /exec URL: GAS_EXEC_URL is unset and config/deployment.json has no execUrl."
        )

    token = bc.get_credential("GAS_READ_TOKEN")
    if not token:
        raise RuntimeError("GAS_READ_TOKEN is not set")

    params = {"fn": "shopspendCoverage", "token": token}

    try:
        resp = requests.get(url, params=params, timeout=30, allow_redirects=True)
    except requests.RequestException as err:
        # Base class on purpose, not a subclass tuple. runner.py's --backfill only
        # degrades to the full 4-week span for (RuntimeError, ShopSpendError,
        # ShopSpendTransientError); anything else escapes and kills the run, which
        # from the Scheduled Task means no data that week. TooManyRedirects is the
        # live case — allow_redirects=True and GAS /exec redirects to
        # googleusercontent (same reason probes need `curl -sL`).
        raise ShopSpendTransientError(_redact(f"coverage request failed: {err}", token)) from None

    try:
        body = resp.json()
    except ValueError:
        raise ShopSpendTransientError(
            _redact(f"coverage: non-JSON response (url={resp.url}): {resp.text[:200]}", token)
        ) from None

    if body.get("result") != "ok":
        message = body.get("message") or "unknown coverage error"
        raise ShopSpendError(code="COVERAGE_ERROR", detail=_redact(str(message), token))

    return set(body.get("weeks") or [])
