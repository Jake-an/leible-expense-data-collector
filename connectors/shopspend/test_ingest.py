"""
Tests for connectors/shopspend/ingest.py — the shopSpend GAS ingest poster.

`ingest.py` is an intentionally empty stub at RED time (see its module
docstring) — every symbol below (`post_pull`, `IngestFailed`) is referenced
only *inside* test bodies, never as a top-level `from ... import`, so a
missing symbol fails as a clean AttributeError per-test rather than a
whole-file collection ImportError (same convention as
connectors/shopspend/test_client.py).

Two hard rules under test (see step 5 spec, docs/ingest-contract.md):
(1) BaseConnector.post() is NOT reused — this poster sends `kind:'shopspend'`
    and retries `LOCKED` once after 60s, neither of which post() does;
(2) the GAS response is always HTTP 200 — success/failure is decided by the
    JSON body's `result` field, and a `LOCKED` body has no `message` key, so
    the raised error must surface `code`, not a KeyError or a blank message.
"""

import sys
from pathlib import Path

import pytest
import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "playwright"))
import base_connector as bc

import shopspend.ingest as ingest

PROD_URL = "https://script.google.com/macros/s/FAKE_DEPLOYMENT_ID/exec"


@pytest.fixture(autouse=True)
def fake_sleep(monkeypatch):
    """Backoff sleep must never actually wait during tests."""
    import time

    calls = []
    monkeypatch.setattr(time, "sleep", lambda seconds: calls.append(seconds))
    return calls


def _row(i=0, week_start="2026-07-27", **overrides):
    row = {
        "shop_id": f"shop-{i}",
        "week_label": "2026-W31",
        "week_start": week_start,
        "week_end": "2026-08-02",
        "order_count": 3,
        "amended_count": 0,
        "total_ex_gst": 100.0,
        "gst": 10.0,
        "total_inc_gst": 110.0,
        "gst_treatment": "EXCLUSIVE_PRIMARY",
        "environment": "PROD",
    }
    row.update(overrides)
    return row


def _pull(**overrides):
    pull = {
        "fetched_at": "2026-08-03T05:00:00+10:00",
        "environment": "PROD",
        "from_week": "2026-W31",
        "to_week": "2026-W31",
        "matched": 10,
        "returned": 10,
        "truncated": False,
        "warnings_count": 0,
        "warnings": "[]",
        "unpriced_sku_count": 0,
        "unpriced_skus": "[]",
        "amended_count": 0,
        "possible_duplicate_shop_names": "[]",
        "empty_range_with_invalid_labels": False,
        "invalid_week_labels": "[]",
        "gst_treatment": "EXCLUSIVE_PRIMARY",
        "diverges_from_live_pricing": False,
        "matches_live_pricing": True,
        "total_orders_scanned": 12,
        "absent_shop_ids": "[]",
        "diagnostics_json": "{}",
    }
    pull.update(overrides)
    return pull


class _FakeResp:
    """Stand-in for requests.Response — always HTTP 200; success/failure lives
    in the JSON body's `result` field, exactly like the real ContentService
    endpoint (see doPost, Code.gs)."""

    def __init__(self, body):
        self._body = body
        self.status_code = 200

    def json(self):
        if self._body is None:
            raise ValueError("Expecting value: line 1 column 1 (char 0)")
        return self._body

    def raise_for_status(self):
        return None


def _ok_resp(rows_added=1, rows_updated=0, duplicates_skipped=0):
    return _FakeResp(
        {
            "result": "ok",
            "rowsAdded": rows_added,
            "rowsUpdated": rows_updated,
            "duplicatesSkipped": duplicates_skipped,
        }
    )


def _locked_resp():
    return _FakeResp({"result": "error", "code": "LOCKED", "retryable": True})


def _error_resp(message):
    return _FakeResp({"result": "error", "message": message})


def _non_json_resp():
    return _FakeResp(None)


class _FakePost:
    """Records every requests.post(...) call and returns queued responses in order."""

    def __init__(self, responses):
        self._responses = list(responses)
        self.calls = []

    def __call__(self, url, json=None, timeout=None, **kwargs):
        self.calls.append({"url": url, "json": json, "timeout": timeout})
        return self._responses.pop(0)

    @property
    def call_count(self):
        return len(self.calls)


# --------------------------------------------------------------------------- #
# kind + source + timeout — shape of every request
# --------------------------------------------------------------------------- #


def test_kind_is_shopspend_on_every_request(monkeypatch):
    fake_post = _FakePost([_ok_resp(), _ok_resp()])
    monkeypatch.setattr(requests, "post", fake_post)

    ingest.post_pull([_row()], _pull(), exec_url=PROD_URL)

    assert fake_post.call_count == 2
    assert all(c["json"]["kind"] == "shopspend" for c in fake_post.calls)


def test_source_defaults_to_shopspend(monkeypatch):
    fake_post = _FakePost([_ok_resp(), _ok_resp()])
    monkeypatch.setattr(requests, "post", fake_post)

    ingest.post_pull([_row()], _pull(), exec_url=PROD_URL)

    assert all(c["json"]["source"] == "shopspend" for c in fake_post.calls)


def test_source_override_is_honored(monkeypatch):
    fake_post = _FakePost([_ok_resp(), _ok_resp()])
    monkeypatch.setattr(requests, "post", fake_post)

    ingest.post_pull([_row()], _pull(), source="shopspend-backfill", exec_url=PROD_URL)

    assert all(c["json"]["source"] == "shopspend-backfill" for c in fake_post.calls)


def test_post_uses_timeout_300(monkeypatch):
    fake_post = _FakePost([_ok_resp(), _ok_resp()])
    monkeypatch.setattr(requests, "post", fake_post)

    ingest.post_pull([_row()], _pull(), exec_url=PROD_URL)

    assert all(c["timeout"] == 300 for c in fake_post.calls)


# --------------------------------------------------------------------------- #
# Synthetic date — every row's date is forced to its own week_start
# --------------------------------------------------------------------------- #


def test_synthetic_date_equals_week_start(monkeypatch):
    rows = [_row(0, week_start="2026-07-27"), _row(1, week_start="2026-08-03")]
    fake_post = _FakePost([_ok_resp(), _ok_resp()])
    monkeypatch.setattr(requests, "post", fake_post)

    ingest.post_pull(rows, _pull(), exec_url=PROD_URL)

    sent_rows = fake_post.calls[0]["json"]["rows"]
    assert sent_rows[0]["date"] == "2026-07-27"
    assert sent_rows[1]["date"] == "2026-08-03"


def test_synthetic_date_overwrites_a_pre_existing_wrong_date(monkeypatch):
    rows = [_row(0, week_start="2026-07-27", date="1999-01-01")]
    fake_post = _FakePost([_ok_resp(), _ok_resp()])
    monkeypatch.setattr(requests, "post", fake_post)

    ingest.post_pull(rows, _pull(), exec_url=PROD_URL)

    assert fake_post.calls[0]["json"]["rows"][0]["date"] == "2026-07-27"


# --------------------------------------------------------------------------- #
# Chunking — chunk_size rows per data request, pulls request LAST, shared stamp
# --------------------------------------------------------------------------- #


def test_chunking_450_rows_at_200_issues_three_data_requests_plus_pulls_request(monkeypatch):
    rows = [_row(i) for i in range(450)]
    fake_post = _FakePost(
        [
            _ok_resp(rows_added=200),
            _ok_resp(rows_added=200),
            _ok_resp(rows_added=50),
            _ok_resp(rows_added=0),
        ]
    )
    monkeypatch.setattr(requests, "post", fake_post)

    ingest.post_pull(rows, _pull(), exec_url=PROD_URL, chunk_size=200)

    assert fake_post.call_count == 4
    row_counts = [len(c["json"]["rows"]) for c in fake_post.calls]
    assert row_counts == [200, 200, 50, 0]


def test_pulls_request_is_last_and_carries_the_pull_dict(monkeypatch):
    rows = [_row(i) for i in range(450)]
    pull = _pull()
    fake_post = _FakePost([_ok_resp(), _ok_resp(), _ok_resp(), _ok_resp()])
    monkeypatch.setattr(requests, "post", fake_post)

    ingest.post_pull(rows, pull, exec_url=PROD_URL, chunk_size=200)

    for call in fake_post.calls[:-1]:
        assert not call["json"].get("pull")
    assert fake_post.calls[-1]["json"]["pull"] == pull


def test_all_requests_share_the_same_extracted_at(monkeypatch):
    rows = [_row(i) for i in range(450)]
    fake_post = _FakePost([_ok_resp(), _ok_resp(), _ok_resp(), _ok_resp()])
    monkeypatch.setattr(requests, "post", fake_post)

    ingest.post_pull(rows, _pull(), exec_url=PROD_URL, chunk_size=200)

    stamps = {c["json"]["extracted_at"] for c in fake_post.calls}
    assert len(stamps) == 1


# --------------------------------------------------------------------------- #
# LOCKED — retried once after 60s, then raises with code surfaced
# --------------------------------------------------------------------------- #


def test_locked_retried_once_then_succeeds(monkeypatch, fake_sleep):
    fake_post = _FakePost([_locked_resp(), _ok_resp(), _ok_resp()])
    monkeypatch.setattr(requests, "post", fake_post)

    result = ingest.post_pull([_row()], _pull(), exec_url=PROD_URL)

    assert fake_post.call_count == 3
    assert fake_sleep == [60]
    assert result["result"] == "ok"


def test_locked_twice_raises_ingest_failed_with_code_surfaced(monkeypatch, fake_sleep):
    fake_post = _FakePost([_locked_resp(), _locked_resp()])
    monkeypatch.setattr(requests, "post", fake_post)

    with pytest.raises(ingest.IngestFailed) as exc_info:
        ingest.post_pull([_row()], _pull(), exec_url=PROD_URL)

    assert fake_post.call_count == 2
    assert fake_sleep == [60]
    assert exc_info.value.code == "LOCKED"
    assert "LOCKED" in str(exc_info.value)


# --------------------------------------------------------------------------- #
# Non-ok is never leniently treated as success
# --------------------------------------------------------------------------- #


def test_validation_error_raises_ingest_failed_with_message(monkeypatch):
    fake_post = _FakePost([_error_resp("row 0 missing shop_id")])
    monkeypatch.setattr(requests, "post", fake_post)

    with pytest.raises(ingest.IngestFailed) as exc_info:
        ingest.post_pull([_row()], _pull(), exec_url=PROD_URL)

    assert "row 0 missing shop_id" in str(exc_info.value)


def test_non_json_response_raises_ingest_failed(monkeypatch):
    fake_post = _FakePost([_non_json_resp()])
    monkeypatch.setattr(requests, "post", fake_post)

    with pytest.raises(ingest.IngestFailed):
        ingest.post_pull([_row()], _pull(), exec_url=PROD_URL)


# --------------------------------------------------------------------------- #
# Idempotent resume — zero rowsAdded with duplicatesSkipped is success
# --------------------------------------------------------------------------- #


def test_zero_rows_added_with_duplicates_skipped_is_success_not_error(monkeypatch):
    fake_post = _FakePost(
        [_ok_resp(rows_added=0, duplicates_skipped=1), _ok_resp(rows_added=0, duplicates_skipped=0)]
    )
    monkeypatch.setattr(requests, "post", fake_post)

    result = ingest.post_pull([_row()], _pull(), exec_url=PROD_URL)

    assert result["result"] == "ok"


# --------------------------------------------------------------------------- #
# exec_url resolution — fail loud, never silently skip the POST
# --------------------------------------------------------------------------- #


def test_missing_exec_url_raises_loud_and_never_posts(monkeypatch):
    """RuntimeError, not bare Exception: AttributeError (a missing `post_pull`
    symbol) is also an Exception, so asserting the broad base class here would
    pass vacuously before the function even exists. RuntimeError matches
    BaseConnector._require_exec_url's own convention for this exact failure."""
    monkeypatch.setattr(bc, "resolve_exec_url", lambda: "")
    fake_post = _FakePost([])
    monkeypatch.setattr(requests, "post", fake_post)

    with pytest.raises(RuntimeError):
        ingest.post_pull([_row()], _pull())

    assert fake_post.call_count == 0
