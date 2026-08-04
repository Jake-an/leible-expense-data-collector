"""
Tests for connectors/shopspend/client.py — the shopSpend external API client.

`client.py`/`models.py` are intentionally empty stubs at RED time (see their
module docstrings) — every symbol below (`ShopSpendClient`, `ShopSpendError`,
`ShopSpendTransientError`, `resolve_config`, `parse_week_label`, `_redact`) is
referenced only *inside* test bodies, never as a top-level `from ... import`,
so a missing symbol fails as a clean AttributeError per-test rather than a
whole-file collection ImportError (same convention as
connectors/playwright/test_base_connector.py's `b.IngestError` — see that
file's "post() — GAS ingest bridge" section).

`connectors/shopspend/` has `__init__.py` so pytest's default (prepend)
import mode adds `connectors/` to sys.path and this file collects as
`shopspend.test_client` — `import shopspend.client as client` below relies on
that, no manual sys.path handling needed for it.

`base_connector` lives in the sibling `connectors/playwright/` directory,
which has no `__init__.py` (bare-module, not a package) — reached the same
way `scripts/test_execute.py` reaches `execute.py`: an explicit
`sys.path.insert` then a bare import.

Two hard rules under test throughout (see docs/ARCHITECTURE.md shopSpend flow
+ the step 4 spec): (1) doPost — sorry, shopSpend's `/exec` — always answers
HTTP 200, so success/failure is decided by the JSON body's `ok` field, never
`resp.status_code`; (2) the token must never leak into an exception message,
a log line, or `resp.url` echoed back into an error.
"""

import sys
import time
from pathlib import Path

import pytest
import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "playwright"))
import base_connector as bc

import shopspend.client as client

PROD_URL = "https://script.google.com/macros/s/FAKE_DEPLOYMENT_ID/exec"
PROD_TOKEN = "super-secret-token-xyz"  # noqa: S105 — fake, test-only value


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    """Every test controls SHOPSPEND_*/GAS_* explicitly — never inherit the real env."""
    for key in (
        "SHOPSPEND_ENV",
        "SHOPSPEND_URL_PROD",
        "SHOPSPEND_TOKEN_PROD",
        "SHOPSPEND_URL_DEV",
        "SHOPSPEND_TOKEN_DEV",
        "GAS_EXEC_URL",
        "GAS_READ_TOKEN",
    ):
        monkeypatch.delenv(key, raising=False)


@pytest.fixture(autouse=True)
def isolate_env_file(monkeypatch, tmp_path):
    """get_credential() falls back to reading the repo's real .env when an
    env var is unset — point it at an empty tmp file so a stray real
    SHOPSPEND_* value on Jake's machine can never leak into a test."""
    empty_env = tmp_path / ".env"
    empty_env.write_text("")
    monkeypatch.setattr(bc, "ENV_FILE", empty_env)
    monkeypatch.setattr(bc, "_env_cache", None)


@pytest.fixture(autouse=True)
def fake_sleep(monkeypatch):
    """Backoff sleeps must never actually wait during tests; records call args
    so tests can assert on retry counts without asserting exact durations
    (jitter makes exact durations non-deterministic by design)."""
    calls = []
    monkeypatch.setattr(time, "sleep", lambda seconds: calls.append(seconds))
    return calls


def _client(**overrides):
    kwargs = {"url": PROD_URL, "token": PROD_TOKEN, "environment": "PROD", "timeout": 30}
    kwargs.update(overrides)
    return client.ShopSpendClient(**kwargs)


def _row(shop_id="Leible York", week_label="2026-W26"):
    return {
        "shopId": shop_id,
        "weekLabel": week_label,
        "weekStart": "2026-06-22",
        "weekEnd": "2026-06-28",
        "orderCount": 1,
        "amendedCount": 0,
        "totalExGst": 100.0,
        "gst": 10.0,
        "totalIncGst": 110.0,
    }


def _meta(environment="PROD", matched=0, returned=0, offset=0, limit=2000):
    return {
        "environment": environment,
        "timezone": "Australia/Sydney",
        "gstTreatment": "EXCLUSIVE_PRIMARY",
        "scope": "Confirmed orders only",
        "paging": {
            "limit": limit,
            "offset": offset,
            "matched": matched,
            "returned": returned,
            "rowsIncluded": True,
            "truncated": offset + returned < matched,
        },
        "unknownParams": [],
    }


def _ok_body(rows=None, environment="PROD"):
    rows = rows if rows is not None else []
    return {
        "ok": True,
        "schemaVersion": 1,
        "meta": _meta(environment=environment, matched=len(rows), returned=len(rows)),
        "rows": rows,
        "summary": {
            "shopCount": 0,
            "weekCount": 0,
            "orderCount": 0,
            "amendedCount": 0,
            "grandTotalExGst": 0,
            "grandTotalGst": 0,
            "grandTotalIncGst": 0,
            "byShop": [],
        },
        "diagnostics": {"warnings": []},
    }


def _page_body(rows, matched, offset, limit=2000):
    body = _ok_body(rows=rows)
    body["meta"]["paging"] = {
        "limit": limit,
        "offset": offset,
        "matched": matched,
        "returned": len(rows),
        "rowsIncluded": True,
        "truncated": offset + len(rows) < matched,
    }
    return body


class _FakeResponse:
    """Stand-in for requests.Response. Never inspect .status_code to decide
    success — the client under test must branch on the JSON body's `ok`
    field, exactly like the real ContentService-backed endpoint (everything
    is HTTP 200, auth failures and server errors included)."""

    def __init__(self, *, json_body=None, text="", url=PROD_URL, json_raises=False):
        self._json_body = json_body
        self.text = text
        self.url = url
        self.status_code = 200
        self._json_raises = json_raises

    def json(self):
        if self._json_raises:
            raise ValueError("Expecting value: line 1 column 1 (char 0)")
        return self._json_body


class _FakeGet:
    """Records every requests.get(...) call and returns/raises queued items in order."""

    def __init__(self, responses):
        self._responses = list(responses)
        self.calls = []

    def __call__(self, url, params=None, timeout=None, allow_redirects=None):
        self.calls.append(
            {"url": url, "params": params, "timeout": timeout, "allow_redirects": allow_redirects}
        )
        item = self._responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    @property
    def call_count(self):
        return len(self.calls)


# --------------------------------------------------------------------------- #
# HTTP 200 + ok:false is never success — fatal codes, zero retries
# --------------------------------------------------------------------------- #


def test_unauthorized_raises_shopspend_error_with_zero_retries(monkeypatch, fake_sleep):
    fake_get = _FakeGet([_FakeResponse(json_body={"ok": False, "error": "UNAUTHORIZED"})])
    monkeypatch.setattr(requests, "get", fake_get)
    conn = _client()

    with pytest.raises(client.ShopSpendError) as exc_info:
        conn.fetch()

    assert exc_info.value.code == "UNAUTHORIZED"
    assert exc_info.value.detail is None
    assert fake_get.call_count == 1
    assert fake_sleep == []


@pytest.mark.parametrize("error_code", ["BAD_REQUEST", "SCHEMA"])
def test_bad_request_and_schema_raise_shopspend_error_with_zero_retries(
    monkeypatch, fake_sleep, error_code
):
    fake_get = _FakeGet(
        [_FakeResponse(json_body={"ok": False, "error": error_code, "detail": "explain"})]
    )
    monkeypatch.setattr(requests, "get", fake_get)
    conn = _client()

    with pytest.raises(client.ShopSpendError) as exc_info:
        conn.fetch()

    assert exc_info.value.code == error_code
    assert exc_info.value.detail == "explain"
    assert fake_get.call_count == 1
    assert fake_sleep == []


# --------------------------------------------------------------------------- #
# INTERNAL — retryable, logs traceId, succeeds later or raises once exhausted
# --------------------------------------------------------------------------- #


def test_internal_error_retries_then_succeeds(monkeypatch):
    fake_get = _FakeGet(
        [
            _FakeResponse(
                json_body={
                    "ok": False,
                    "error": "INTERNAL",
                    "detail": "boom",
                    "traceId": "trace-1",
                }
            ),
            _FakeResponse(json_body=_ok_body(rows=[_row()])),
        ]
    )
    monkeypatch.setattr(requests, "get", fake_get)
    conn = _client()

    result = conn.fetch()

    assert len(result.rows) == 1
    assert fake_get.call_count == 2


def test_internal_error_logs_trace_id(monkeypatch, capsys):
    fake_get = _FakeGet(
        [
            _FakeResponse(
                json_body={
                    "ok": False,
                    "error": "INTERNAL",
                    "detail": "boom",
                    "traceId": "trace-abc-123",
                }
            ),
            _FakeResponse(json_body=_ok_body(rows=[])),
        ]
    )
    monkeypatch.setattr(requests, "get", fake_get)
    conn = _client()

    conn.fetch()

    captured = capsys.readouterr()
    assert "trace-abc-123" in captured.out + captured.err


def test_internal_error_raises_transient_error_after_backoff_ladder_exhausted(
    monkeypatch, fake_sleep
):
    responses = [
        _FakeResponse(
            json_body={"ok": False, "error": "INTERNAL", "detail": "boom", "traceId": f"trace-{i}"}
        )
        for i in range(6)  # 1 initial attempt + 5 backoff retries (2,5,10,20,30s ladder)
    ]
    fake_get = _FakeGet(responses)
    monkeypatch.setattr(requests, "get", fake_get)
    conn = _client()

    with pytest.raises(client.ShopSpendTransientError):
        conn.fetch()

    assert fake_get.call_count == 6
    assert len(fake_sleep) == 5


# --------------------------------------------------------------------------- #
# Non-JSON body (e.g. the post-redeploy "Page not found" HTML) is transient
# --------------------------------------------------------------------------- #


def test_non_json_body_retries_then_succeeds(monkeypatch):
    fake_get = _FakeGet(
        [
            _FakeResponse(json_raises=True, text="<html>Page not found</html>"),
            _FakeResponse(json_body=_ok_body(rows=[])),
        ]
    )
    monkeypatch.setattr(requests, "get", fake_get)
    conn = _client()

    result = conn.fetch()

    assert result.rows == []
    assert fake_get.call_count == 2


def test_non_json_body_raises_transient_error_after_backoff_ladder_exhausted(
    monkeypatch, fake_sleep
):
    fake_get = _FakeGet(
        [_FakeResponse(json_raises=True, text="<html>Page not found</html>") for _ in range(6)]
    )
    monkeypatch.setattr(requests, "get", fake_get)
    conn = _client()

    with pytest.raises(client.ShopSpendTransientError):
        conn.fetch()

    assert fake_get.call_count == 6
    assert len(fake_sleep) == 5


# --------------------------------------------------------------------------- #
# Transport failures — ConnectionError / Timeout — are transient
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("exc_cls", [requests.ConnectionError, requests.Timeout])
def test_transport_failure_retries_then_succeeds(monkeypatch, exc_cls):
    fake_get = _FakeGet([exc_cls("boom"), _FakeResponse(json_body=_ok_body(rows=[]))])
    monkeypatch.setattr(requests, "get", fake_get)
    conn = _client()

    result = conn.fetch()

    assert result.rows == []
    assert fake_get.call_count == 2


def test_transport_failure_raises_transient_error_after_backoff_ladder_exhausted(
    monkeypatch, fake_sleep
):
    fake_get = _FakeGet([requests.ConnectionError("boom") for _ in range(6)])
    monkeypatch.setattr(requests, "get", fake_get)
    conn = _client()

    with pytest.raises(client.ShopSpendTransientError):
        conn.fetch()

    assert fake_get.call_count == 6
    assert len(fake_sleep) == 5


# --------------------------------------------------------------------------- #
# Request shape — redirects, params, timeout
# --------------------------------------------------------------------------- #


def test_request_passes_allow_redirects_true(monkeypatch):
    fake_get = _FakeGet([_FakeResponse(json_body=_ok_body(rows=[]))])
    monkeypatch.setattr(requests, "get", fake_get)
    conn = _client()

    conn.fetch()

    assert fake_get.calls[0]["allow_redirects"] is True


def test_fetch_sends_expected_query_params(monkeypatch):
    fake_get = _FakeGet([_FakeResponse(json_body=_ok_body(rows=[]))])
    monkeypatch.setattr(requests, "get", fake_get)
    conn = _client()

    conn.fetch(from_week="2026-W25", to_week="2026-W31", include="rows")

    params = fake_get.calls[0]["params"]
    assert params["api"] == "shopSpend"
    assert params["token"] == PROD_TOKEN
    assert params["fromWeek"] == "2026-W25"
    assert params["toWeek"] == "2026-W31"
    assert params["include"] == "rows"


def test_fetch_defaults_include_to_rows_and_summary(monkeypatch):
    fake_get = _FakeGet([_FakeResponse(json_body=_ok_body(rows=[]))])
    monkeypatch.setattr(requests, "get", fake_get)
    conn = _client()

    conn.fetch()

    assert fake_get.calls[0]["params"]["include"] == "rows,summary"


def test_fetch_passes_configured_timeout(monkeypatch):
    fake_get = _FakeGet([_FakeResponse(json_body=_ok_body(rows=[]))])
    monkeypatch.setattr(requests, "get", fake_get)
    conn = _client(timeout=45)

    conn.fetch()

    assert fake_get.calls[0]["timeout"] == 45


# --------------------------------------------------------------------------- #
# Paging — loop on meta.paging until offset + returned >= matched
# --------------------------------------------------------------------------- #


def test_paging_issues_three_calls_and_concatenates_rows(monkeypatch):
    page1 = _page_body([_row()] * 2000, matched=4500, offset=0)
    page2 = _page_body([_row()] * 2000, matched=4500, offset=2000)
    page3 = _page_body([_row()] * 500, matched=4500, offset=4000)
    fake_get = _FakeGet(
        [
            _FakeResponse(json_body=page1),
            _FakeResponse(json_body=page2),
            _FakeResponse(json_body=page3),
        ]
    )
    monkeypatch.setattr(requests, "get", fake_get)
    conn = _client()

    result = conn.fetch()

    assert fake_get.call_count == 3
    assert [c["params"].get("offset", 0) for c in fake_get.calls] == [0, 2000, 4000]
    assert len(result.rows) == 4500


def test_single_page_response_issues_exactly_one_call(monkeypatch):
    body = _page_body([_row()] * 10, matched=10, offset=0)
    fake_get = _FakeGet([_FakeResponse(json_body=body)])
    monkeypatch.setattr(requests, "get", fake_get)
    conn = _client()

    result = conn.fetch()

    assert fake_get.call_count == 1
    assert len(result.rows) == 10


# --------------------------------------------------------------------------- #
# parse_week_label — numeric sort, not lexicographic
# --------------------------------------------------------------------------- #


def test_parse_week_label_returns_year_week_int_tuple():
    assert client.parse_week_label("2026-W31") == (2026, 31)


def test_sorting_by_parse_week_label_orders_numerically_not_lexically():
    labels = ["2026-W10", "2026-W9", "2027-W01", "2026-W52"]
    expected = ["2026-W9", "2026-W10", "2026-W52", "2027-W01"]

    assert sorted(labels, key=client.parse_week_label) == expected
    # Prove the contrast: plain lexicographic sort gets this wrong.
    assert sorted(labels) != expected


# --------------------------------------------------------------------------- #
# Secret hygiene — token must never leak into an exception, log, or resp.url
# --------------------------------------------------------------------------- #


def test_redact_helper_strips_token_from_text():
    text = f"GET {PROD_URL}?api=shopSpend&token={PROD_TOKEN}&fromWeek=2026-W31 failed"

    redacted = client._redact(text, PROD_TOKEN)

    assert PROD_TOKEN not in redacted
    assert "***" in redacted


def test_transport_exception_and_response_url_token_leaks_are_redacted(monkeypatch, fake_sleep):
    """Two leak sources in one scenario: (1) requests.ConnectionError embeds the
    full URL (token included) in its message — this is real `requests`
    behaviour, not test artifice; (2) a fake response's .url also carries the
    token, standing in for GAS's redirect target. Neither may survive into
    the exception this client ultimately raises."""
    boom = requests.ConnectionError(
        f"Failed to establish a new connection to {PROD_URL}?token={PROD_TOKEN}"
    )
    leaky_response = _FakeResponse(
        json_raises=True,
        text="<html>Page not found</html>",
        url=f"{PROD_URL}?api=shopSpend&token={PROD_TOKEN}",
    )
    fake_get = _FakeGet(
        [boom, leaky_response, leaky_response, leaky_response, leaky_response, leaky_response]
    )
    monkeypatch.setattr(requests, "get", fake_get)
    conn = _client()

    with pytest.raises(client.ShopSpendTransientError) as exc_info:
        conn.fetch()

    rendered = str(exc_info.value)
    assert PROD_TOKEN not in rendered
    assert "***" in rendered


def test_log_output_never_contains_token_or_full_url(monkeypatch, capsys):
    fake_get = _FakeGet(
        [
            _FakeResponse(
                json_body={
                    "ok": False,
                    "error": "INTERNAL",
                    "detail": "boom",
                    "traceId": "trace-1",
                },
                url=f"{PROD_URL}?api=shopSpend&token={PROD_TOKEN}",
            ),
            _FakeResponse(json_body=_ok_body(rows=[])),
        ]
    )
    monkeypatch.setattr(requests, "get", fake_get)
    conn = _client()

    conn.fetch(from_week="2026-W25", to_week="2026-W31")

    captured = capsys.readouterr()
    assert PROD_TOKEN not in captured.out
    assert PROD_TOKEN not in captured.err
    assert PROD_URL not in captured.out
    assert PROD_URL not in captured.err


# --------------------------------------------------------------------------- #
# Fail closed on environment mismatch
# --------------------------------------------------------------------------- #


def test_environment_mismatch_raises_and_yields_no_data(monkeypatch):
    fake_get = _FakeGet([_FakeResponse(json_body=_ok_body(rows=[_row()], environment="DEV"))])
    monkeypatch.setattr(requests, "get", fake_get)
    conn = _client(environment="PROD")

    with pytest.raises(client.ShopSpendError):
        conn.fetch()


# --------------------------------------------------------------------------- #
# resolve_config — fail loud, never silently return None
# --------------------------------------------------------------------------- #


def test_resolve_config_returns_url_token_environment(monkeypatch):
    monkeypatch.setenv("SHOPSPEND_ENV", "DEV")
    monkeypatch.setenv("SHOPSPEND_URL_DEV", "https://example.invalid/exec-dev")
    monkeypatch.setenv("SHOPSPEND_TOKEN_DEV", "dev-token")

    url, token, environment = client.resolve_config()

    assert url == "https://example.invalid/exec-dev"
    assert token == "dev-token"
    assert environment == "DEV"


def test_resolve_config_missing_token_raises(monkeypatch):
    monkeypatch.setenv("SHOPSPEND_ENV", "PROD")
    monkeypatch.setenv("SHOPSPEND_URL_PROD", PROD_URL)
    monkeypatch.delenv("SHOPSPEND_TOKEN_PROD", raising=False)

    with pytest.raises(Exception):  # noqa: B017 — exact exception type is client's to choose
        client.resolve_config()


def test_resolve_config_missing_env_raises(monkeypatch):
    monkeypatch.delenv("SHOPSPEND_ENV", raising=False)

    with pytest.raises(Exception):  # noqa: B017 — exact exception type is client's to choose
        client.resolve_config()


# --------------------------------------------------------------------------- #
# Forward-compatible parsing — server may add fields additively
# --------------------------------------------------------------------------- #


def test_unknown_response_fields_are_tolerated(monkeypatch):
    body = _ok_body(rows=[_row()])
    body["meta"]["somethingNew"] = "unexpected-value"
    fake_get = _FakeGet([_FakeResponse(json_body=body)])
    monkeypatch.setattr(requests, "get", fake_get)
    conn = _client()

    result = conn.fetch()

    assert len(result.rows) == 1


# --------------------------------------------------------------------------- #
# fetch_coverage — hub's fn=shopspendCoverage, advisory input to --backfill
# (step 9). Resolves the hub URL exactly like ingest.py (GAS_EXEC_URL, else
# config/deployment.json execUrl) and reads GAS_READ_TOKEN for the token
# query param. Must never return an empty set on failure — that would be
# indistinguishable from a genuine cold-start hub with nothing stored yet.
# --------------------------------------------------------------------------- #


def test_fetch_coverage_parses_weeks_into_a_set(monkeypatch):
    monkeypatch.setenv("GAS_EXEC_URL", "https://example.invalid/exec")
    monkeypatch.setenv("GAS_READ_TOKEN", "read-tok")
    fake_get = _FakeGet(
        [_FakeResponse(json_body={"result": "ok", "count": 2, "weeks": ["2026-W29", "2026-W30"]})]
    )
    monkeypatch.setattr(requests, "get", fake_get)

    result = client.fetch_coverage()

    assert result == {"2026-W29", "2026-W30"}
    params = fake_get.calls[0]["params"]
    assert params["fn"] == "shopspendCoverage"
    assert params["token"] == "read-tok"


def test_fetch_coverage_raises_on_error_result(monkeypatch):
    monkeypatch.setenv("GAS_EXEC_URL", "https://example.invalid/exec")
    monkeypatch.setenv("GAS_READ_TOKEN", "read-tok")
    fake_get = _FakeGet([_FakeResponse(json_body={"result": "error", "message": "unauthorized"})])
    monkeypatch.setattr(requests, "get", fake_get)
    fetch_coverage = client.fetch_coverage  # resolved outside raises: a missing symbol must
    # error the test, not be swallowed as the "raises" this test is actually checking for.

    with pytest.raises(Exception):  # noqa: B017 — exact exception type is client's to choose
        fetch_coverage()


def test_fetch_coverage_raises_on_non_json_body(monkeypatch):
    monkeypatch.setenv("GAS_EXEC_URL", "https://example.invalid/exec")
    monkeypatch.setenv("GAS_READ_TOKEN", "read-tok")
    fake_get = _FakeGet([_FakeResponse(json_raises=True, text="<html>Page not found</html>")])
    monkeypatch.setattr(requests, "get", fake_get)
    fetch_coverage = client.fetch_coverage  # resolved outside raises — see comment above

    with pytest.raises(Exception):  # noqa: B017 — exact exception type is client's to choose
        fetch_coverage()


def test_fetch_coverage_error_result_never_leaks_token(monkeypatch, capsys):
    secret = "super-secret-read-token"  # noqa: S105 — fake, test-only value
    monkeypatch.setenv("GAS_EXEC_URL", "https://example.invalid/exec")
    monkeypatch.setenv("GAS_READ_TOKEN", secret)
    fake_get = _FakeGet([_FakeResponse(json_body={"result": "error", "message": "unauthorized"})])
    monkeypatch.setattr(requests, "get", fake_get)
    fetch_coverage = client.fetch_coverage  # resolved outside raises — see comment above

    with pytest.raises(Exception) as exc_info:  # noqa: B017 — exact type is client's to choose
        fetch_coverage()

    assert secret not in str(exc_info.value)
    captured = capsys.readouterr()
    assert secret not in captured.out
    assert secret not in captured.err


def test_fetch_coverage_non_json_never_leaks_token(monkeypatch, capsys):
    secret = "super-secret-read-token"  # noqa: S105 — fake, test-only value
    monkeypatch.setenv("GAS_EXEC_URL", "https://example.invalid/exec")
    monkeypatch.setenv("GAS_READ_TOKEN", secret)
    fake_get = _FakeGet(
        [
            _FakeResponse(
                json_raises=True,
                text="<html>Page not found</html>",
                url=f"https://example.invalid/exec?fn=shopspendCoverage&token={secret}",
            )
        ]
    )
    monkeypatch.setattr(requests, "get", fake_get)
    fetch_coverage = client.fetch_coverage  # resolved outside raises — see comment above

    with pytest.raises(Exception) as exc_info:  # noqa: B017 — exact type is client's to choose
        fetch_coverage()

    assert secret not in str(exc_info.value)
    captured = capsys.readouterr()
    assert secret not in captured.out
    assert secret not in captured.err


# Every transport failure must surface as ShopSpendTransientError so runner.py's
# --backfill branch — which catches (RuntimeError, ShopSpendError,
# ShopSpendTransientError) — degrades to the full 4-week span instead of dying.
# TooManyRedirects is not hypothetical: allow_redirects=True is set and GAS /exec
# redirects to googleusercontent (the same reason probes need `curl -sL`).
@pytest.mark.parametrize(
    "transport_error",
    [
        requests.TooManyRedirects("exceeded 30 redirects"),
        requests.exceptions.MissingSchema("Invalid URL 'nonsense': No scheme supplied"),
        requests.exceptions.InvalidURL("Failed to parse"),
        requests.exceptions.ContentDecodingError("failed to decode response"),
    ],
    ids=["too_many_redirects", "missing_schema", "invalid_url", "content_decoding"],
)
def test_fetch_coverage_converts_every_transport_error_to_transient(monkeypatch, transport_error):
    monkeypatch.setenv("GAS_EXEC_URL", "https://example.invalid/exec")
    monkeypatch.setenv("GAS_READ_TOKEN", "read-tok")
    monkeypatch.setattr(requests, "get", _FakeGet([transport_error]))
    fetch_coverage = client.fetch_coverage  # resolved outside raises — see comment above

    with pytest.raises(client.ShopSpendTransientError):
        fetch_coverage()


def test_fetch_coverage_transport_error_never_leaks_token(monkeypatch):
    secret = "super-secret-read-token"  # noqa: S105 — fake, test-only value
    monkeypatch.setenv("GAS_EXEC_URL", "https://example.invalid/exec")
    monkeypatch.setenv("GAS_READ_TOKEN", secret)
    monkeypatch.setattr(
        requests, "get", _FakeGet([requests.TooManyRedirects(f"redirected to ?token={secret}")])
    )
    fetch_coverage = client.fetch_coverage  # resolved outside raises — see comment above

    with pytest.raises(client.ShopSpendTransientError) as exc_info:
        fetch_coverage()

    assert secret not in str(exc_info.value)
