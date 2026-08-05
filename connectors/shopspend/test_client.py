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
# Pagination progress guard — returned:0 while offset < matched must raise
# instead of spinning forever at a stuck offset (step 6, defect I4).
# --------------------------------------------------------------------------- #


def test_paging_zero_returned_before_matched_raises_no_progress_error(monkeypatch):
    """The regression itself: returned=0 with offset(0) < matched(10) must
    raise, naming the stuck offset and the known matched count, instead of
    re-requesting the same offset forever. Only one response is queued — a
    client that still loops calls requests.get() a second time, and the
    bounded fake transport raises IndexError immediately instead of hanging
    the suite for the real 2-hour task limit."""
    page = _page_body([], matched=10, offset=0)
    fake_get = _FakeGet([_FakeResponse(json_body=page)])
    monkeypatch.setattr(requests, "get", fake_get)
    conn = _client()

    with pytest.raises(client.ShopSpendError) as exc_info:
        conn.fetch()

    message = str(exc_info.value)
    assert "offset" in message
    assert "0" in message
    assert "10" in message
    assert fake_get.call_count == 1


def test_final_page_zero_returned_at_or_past_matched_is_clean_finish(monkeypatch):
    """`matched` can shrink between calls (e.g. concurrent edits on the API
    side) — if a page's own offset already meets or exceeds that page's
    matched count, returned=0 is a legitimate clean finish, not a stuck-
    progress error, even though the raw offset never quite reached the
    *earlier* page's higher matched figure."""
    page1 = _page_body([_row()] * 10, matched=15, offset=0)
    page2 = _page_body([], matched=10, offset=10)
    fake_get = _FakeGet([_FakeResponse(json_body=page1), _FakeResponse(json_body=page2)])
    monkeypatch.setattr(requests, "get", fake_get)
    conn = _client()

    result = conn.fetch()

    assert len(result.rows) == 10
    assert fake_get.call_count == 2


def test_matched_zero_never_trips_progress_guard(monkeypatch):
    """An empty result set (matched=0, returned=0, offset=0) is the ordinary
    single-page-with-no-rows case, not a stuck-progress condition."""
    page = _page_body([], matched=0, offset=0)
    fake_get = _FakeGet([_FakeResponse(json_body=page)])
    monkeypatch.setattr(requests, "get", fake_get)
    conn = _client()

    result = conn.fetch()

    assert result.rows == []
    assert fake_get.call_count == 1


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
# Step 5 — fatal-path redaction hardening (defects I2 + I3)
#
# I2: client.py:195's fatal raise (`raise ShopSpendError(code=error_code,
# detail=detail)`) is the one raising branch that skips `self._redact(...)`,
# unlike its siblings at 166, 172 and 191.
#
# I3: `_redact` (lines 51-54) is a plain `text.replace(token, "***")` — but
# `resp.url` carries the token percent-encoded, so a token containing `+`,
# `/` or `=` changes form under quoting and survives raw-substring redaction
# untouched.
# --------------------------------------------------------------------------- #


def test_fatal_unauthorized_detail_echoing_token_is_redacted(monkeypatch, fake_sleep):
    """I2 — the fatal branch must redact `detail` exactly like every sibling
    error path already does."""
    fake_get = _FakeGet(
        [
            _FakeResponse(
                json_body={
                    "ok": False,
                    "error": "UNAUTHORIZED",
                    "detail": f"token {PROD_TOKEN} rejected",
                }
            )
        ]
    )
    monkeypatch.setattr(requests, "get", fake_get)
    conn = _client()

    with pytest.raises(client.ShopSpendError) as exc_info:
        conn.fetch()

    assert PROD_TOKEN not in str(exc_info.value)
    assert PROD_TOKEN not in (exc_info.value.detail or "")
    assert "***" in str(exc_info.value)


def test_percent_encoded_token_is_redacted_from_url():
    """I3 — a token containing +, / and = appears percent-encoded in
    resp.url; _redact must strip that encoded form too, not just the raw
    token. Expected URL is built via requests' own prepare(), never a
    hand-rolled quote() (a different safe set would prove nothing)."""
    tricky_token = "ab+cd/ef=gh"
    prepared_url = (
        requests.Request("GET", PROD_URL, params={"api": "shopSpend", "token": tricky_token})
        .prepare()
        .url
    )
    assert tricky_token not in prepared_url  # sanity: prepare() really did encode it

    redacted = client._redact(prepared_url, tricky_token)

    assert "***" in redacted
    assert tricky_token not in redacted
    # every percent-encoded fragment produced by prepare() must be gone too
    assert "%2B" not in redacted
    assert "%2F" not in redacted
    assert "%3D" not in redacted


def test_client_redacts_percent_encoded_token_from_response_url(monkeypatch, fake_sleep):
    """Same defect as above, exercised end-to-end through the client's
    non-JSON retry path (client.py:172-174), which embeds resp.url verbatim
    into the redacted error message."""
    tricky_token = "ab+cd/ef=gh"
    prepared_url = requests.Request("GET", PROD_URL, params={"token": tricky_token}).prepare().url
    fake_get = _FakeGet(
        [
            _FakeResponse(json_raises=True, text="<html>Page not found</html>", url=prepared_url)
            for _ in range(6)
        ]
    )
    monkeypatch.setattr(requests, "get", fake_get)
    conn = _client(token=tricky_token)

    with pytest.raises(client.ShopSpendTransientError) as exc_info:
        conn.fetch()

    rendered = str(exc_info.value)
    assert tricky_token not in rendered
    assert "%2B" not in rendered
    assert "%2F" not in rendered
    assert "%3D" not in rendered
    assert "***" in rendered


def test_url_safe_token_still_redacted_no_regression():
    """A token with no characters that need percent-encoding must still be
    caught — the percent-encoded path is additive, not a replacement for
    the raw-substring path."""
    safe_token = PROD_TOKEN
    prepared_url = (
        requests.Request("GET", PROD_URL, params={"api": "shopSpend", "token": safe_token})
        .prepare()
        .url
    )

    redacted = client._redact(prepared_url, safe_token)

    assert safe_token not in redacted
    assert "***" in redacted


def test_fatal_path_does_not_echo_raw_response_body(monkeypatch):
    """The fatal branch must never fall back to resp.text — a `[:200]` slice
    can bisect a token mid-string, and no redaction pass can catch a
    fragment. Only the parsed JSON `detail` field may appear, and it must be
    redacted (I2)."""
    raw_html_with_token = f"<html>error token={PROD_TOKEN} rejected</html>"
    fake_get = _FakeGet(
        [
            _FakeResponse(
                json_body={
                    "ok": False,
                    "error": "UNAUTHORIZED",
                    "detail": f"see body for {PROD_TOKEN}",
                },
                text=raw_html_with_token,
                url=f"{PROD_URL}?api=shopSpend&token={PROD_TOKEN}",
            )
        ]
    )
    monkeypatch.setattr(requests, "get", fake_get)
    conn = _client()

    with pytest.raises(client.ShopSpendError) as exc_info:
        conn.fetch()

    rendered = str(exc_info.value)
    assert PROD_TOKEN not in rendered
    assert raw_html_with_token not in rendered
    assert "<html>" not in rendered


def _fatal_unauthorized_leak():
    return (
        [
            _FakeResponse(
                json_body={"ok": False, "error": "UNAUTHORIZED", "detail": f"tok {PROD_TOKEN}"}
            )
        ],
        client.ShopSpendError,
    )


def _fatal_bad_request_leak():
    return (
        [
            _FakeResponse(
                json_body={"ok": False, "error": "BAD_REQUEST", "detail": f"tok {PROD_TOKEN}"}
            )
        ],
        client.ShopSpendError,
    )


def _fatal_schema_leak():
    return (
        [_FakeResponse(json_body={"ok": False, "error": "SCHEMA", "detail": f"tok {PROD_TOKEN}"})],
        client.ShopSpendError,
    )


def _fatal_unrecognized_code_leak():
    return (
        [
            _FakeResponse(
                json_body={"ok": False, "error": "SOME_FUTURE_CODE", "detail": f"tok {PROD_TOKEN}"}
            )
        ],
        client.ShopSpendError,
    )


def _transport_exhausted_leak():
    boom = requests.ConnectionError(f"conn failed {PROD_URL}?token={PROD_TOKEN}")
    return ([boom] * 6, client.ShopSpendTransientError)


def _non_json_exhausted_leak():
    resp = _FakeResponse(
        json_raises=True, text="<html>nf</html>", url=f"{PROD_URL}?api=shopSpend&token={PROD_TOKEN}"
    )
    return ([resp] * 6, client.ShopSpendTransientError)


def _internal_exhausted_leak():
    resp = _FakeResponse(
        json_body={
            "ok": False,
            "error": "INTERNAL",
            "detail": f"tok {PROD_TOKEN}",
            "traceId": "trace-1",
        }
    )
    return ([resp] * 6, client.ShopSpendTransientError)


@pytest.mark.parametrize(
    "make_responses",
    [
        _fatal_unauthorized_leak,
        _fatal_bad_request_leak,
        _fatal_schema_leak,
        _fatal_unrecognized_code_leak,
        _transport_exhausted_leak,
        _non_json_exhausted_leak,
        _internal_exhausted_leak,
    ],
    ids=[
        "fatal-unauthorized",
        "fatal-bad-request",
        "fatal-schema",
        "fatal-unrecognized-code",
        "transport-exhausted",
        "non-json-exhausted",
        "internal-exhausted",
    ],
)
def test_every_raising_branch_redacts_the_token(monkeypatch, fake_sleep, make_responses):
    """Parametrized across every branch in `_request` that can ultimately
    raise — fatal codes (including an unrecognized one, which the fatal
    branch also catches) and each retryable branch once its backoff ladder
    is exhausted — so a future branch that forgets to redact fails this
    suite instead of shipping a leak silently."""
    responses, expected_exc = make_responses()
    fake_get = _FakeGet(responses)
    monkeypatch.setattr(requests, "get", fake_get)
    conn = _client()

    with pytest.raises(expected_exc) as exc_info:
        conn.fetch()

    assert PROD_TOKEN not in str(exc_info.value)


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


def test_fatal_non_string_detail_does_not_crash_redaction(monkeypatch, fake_sleep):
    """Review finding [3]: `detail` is untrusted JSON. When it arrives as a dict
    the redaction call raised AttributeError ('dict' object has no attribute
    'replace') from inside the fatal path, replacing the clean ShopSpendError
    with an opaque crash. Robustness, not disclosure."""
    fake_get = _FakeGet(
        [
            _FakeResponse(
                json_body={
                    "ok": False,
                    "error": "UNAUTHORIZED",
                    "detail": {"reason": "bad token", "token": PROD_TOKEN},
                }
            )
        ]
    )
    monkeypatch.setattr(requests, "get", fake_get)
    conn = _client()

    with pytest.raises(client.ShopSpendError) as exc_info:
        conn.fetch()

    # The real error survives — not an AttributeError — and still redacts.
    assert exc_info.value.code == "UNAUTHORIZED"
    assert PROD_TOKEN not in str(exc_info.value)
    assert PROD_TOKEN not in str(exc_info.value.detail or "")
