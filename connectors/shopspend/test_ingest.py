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
from collections import Counter
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


# --------------------------------------------------------------------------- #
# Packing by whole week (step 2) — pack complete weeks per request, up to
# chunk_size, and declare exactly the weeks each request carries in full.
# `weeks_complete`/`weeks_verified_empty` are new keyword-only params; None
# means "declare nothing" so all 15 pre-existing call sites above stay valid
# and fail safe (see step 2 task file, docs/schema.md tombstone semantics).
# --------------------------------------------------------------------------- #


def _week_rows(week_label, week_start, count, start_i=0):
    return [_row(start_i + n, week_start=week_start, week_label=week_label) for n in range(count)]


def _ok_resp_with_tombstones_skipped(entries, rows_added=1):
    return _FakeResp(
        {
            "result": "ok",
            "rowsAdded": rows_added,
            "rowsUpdated": 0,
            "duplicatesSkipped": 0,
            "tombstonesWritten": 0,
            "tombstonesSkipped": entries,
        }
    )


def test_four_weeks_under_chunk_size_one_request_declares_all_four(monkeypatch):
    weeks = ["2026-W28", "2026-W29", "2026-W30", "2026-W31"]
    rows = []
    for idx, week in enumerate(weeks):
        rows += _week_rows(week, f"2026-07-{6 + idx:02d}", 2, start_i=idx * 2)
    pull = _pull(from_week="2026-W28", to_week="2026-W31")
    fake_post = _FakePost([_ok_resp(rows_added=8), _ok_resp()])
    monkeypatch.setattr(requests, "post", fake_post)

    ingest.post_pull(rows, pull, exec_url=PROD_URL, weeks_complete=weeks)

    assert fake_post.call_count == 2  # one data request + the pulls marker
    data_call = fake_post.calls[0]
    assert len(data_call["json"]["rows"]) == 8
    assert sorted(data_call["json"]["weeks_complete"]) == weeks
    assert fake_post.calls[-1]["json"]["pull"] == pull


def test_span_exceeding_chunk_size_packs_several_requests_each_declaring_carried_weeks(
    monkeypatch,
):
    weeks = ["2026-W28", "2026-W29", "2026-W30", "2026-W31", "2026-W32"]
    rows = []
    for idx, week in enumerate(weeks):
        rows += _week_rows(week, f"2026-07-{6 + idx:02d}", 4, start_i=idx * 4)
    pull = _pull(from_week="2026-W28", to_week="2026-W32")
    fake_post = _FakePost([_ok_resp(), _ok_resp(), _ok_resp(), _ok_resp()])
    monkeypatch.setattr(requests, "post", fake_post)

    ingest.post_pull(rows, pull, exec_url=PROD_URL, chunk_size=10, weeks_complete=weeks)

    assert fake_post.call_count == 4  # 3 data requests + the pulls marker
    data_calls = fake_post.calls[:-1]
    row_counts = [len(c["json"]["rows"]) for c in data_calls]
    assert row_counts == [8, 8, 4]
    declared = [set(c["json"].get("weeks_complete") or []) for c in data_calls]
    assert declared == [
        {"2026-W28", "2026-W29"},
        {"2026-W30", "2026-W31"},
        {"2026-W32"},
    ]


def test_single_week_over_chunk_size_splits_declared_in_no_request_and_warns(monkeypatch, capsys):
    rows = _week_rows("2026-W31", "2026-07-27", 250)
    pull = _pull(from_week="2026-W31", to_week="2026-W31")
    fake_post = _FakePost([_ok_resp(), _ok_resp(), _ok_resp()])
    monkeypatch.setattr(requests, "post", fake_post)

    ingest.post_pull(rows, pull, exec_url=PROD_URL, chunk_size=200, weeks_complete=["2026-W31"])

    assert fake_post.call_count == 3  # 200 + 50 + the pulls marker
    row_counts = [len(c["json"]["rows"]) for c in fake_post.calls[:-1]]
    assert row_counts == [200, 50]
    for call in fake_post.calls:
        assert "2026-W31" not in (call["json"].get("weeks_complete") or [])

    captured = capsys.readouterr()
    output = captured.out + captured.err
    assert "WARNING" in output
    assert "2026-W31" in output
    assert "250" in output


def test_weeks_complete_none_declares_nothing_in_every_request(monkeypatch):
    fake_post = _FakePost([_ok_resp(), _ok_resp()])
    monkeypatch.setattr(requests, "post", fake_post)

    ingest.post_pull([_row()], _pull(), exec_url=PROD_URL)

    assert all(not c["json"].get("weeks_complete") for c in fake_post.calls)
    assert all(not c["json"].get("weeks_verified_empty") for c in fake_post.calls)


def test_complete_fetch_with_zero_row_week_emits_rows_empty_request_declaring_both(monkeypatch):
    pull = _pull(from_week="2026-W31", to_week="2026-W31")
    fake_post = _FakePost([_ok_resp(rows_added=0), _ok_resp()])
    monkeypatch.setattr(requests, "post", fake_post)

    ingest.post_pull(
        [], pull, exec_url=PROD_URL, weeks_complete=["2026-W31"], weeks_verified_empty=["2026-W31"]
    )

    assert fake_post.call_count == 2
    data_call = fake_post.calls[0]
    assert data_call["json"]["rows"] == []
    assert data_call["json"]["weeks_complete"] == ["2026-W31"]
    assert data_call["json"]["weeks_verified_empty"] == ["2026-W31"]
    assert fake_post.calls[-1]["json"]["pull"] == pull


def test_tombstones_skipped_response_prints_warning_and_does_not_raise(monkeypatch, capsys):
    fake_post = _FakePost(
        [
            _ok_resp_with_tombstones_skipped(
                [{"week": "2026-W31", "wouldHaveWritten": 5, "present": 5}]
            ),
            _ok_resp(),
        ]
    )
    monkeypatch.setattr(requests, "post", fake_post)

    result = ingest.post_pull([_row()], _pull(), exec_url=PROD_URL)

    assert result["result"] == "ok"
    captured = capsys.readouterr()
    output = captured.out + captured.err
    assert "WARNING" in output
    assert "2026-W31" in output
    assert "5" in output


def test_packing_invariant_declared_weeks_are_always_fully_carried_with_correct_counts(
    monkeypatch,
):
    """Property, not just examples: for every declared week in every request,
    the row count carried in THAT request equals the week's total mapped row
    count — guards against the C1 bug class returning if a chunk boundary
    ever lands mid-week while the week is still declared complete."""
    scenarios = [
        {"chunk_size": 5, "week_counts": [("2026-W01", 3), ("2026-W02", 2), ("2026-W03", 4)]},
        {
            "chunk_size": 10,
            "week_counts": [("2026-W10", 7), ("2026-W11", 1), ("2026-W12", 1), ("2026-W13", 1)],
        },
        {"chunk_size": 3, "week_counts": [("2026-W20", 6)]},
    ]

    for scenario in scenarios:
        full_counts = dict(scenario["week_counts"])
        rows = []
        start_i = 0
        for week, count in scenario["week_counts"]:
            rows += _week_rows(week, "2026-07-27", count, start_i=start_i)
            start_i += count
        weeks_complete_param = [week for week, _ in scenario["week_counts"]]
        pull = _pull(from_week=weeks_complete_param[0], to_week=weeks_complete_param[-1])

        fake_post = _FakePost([_ok_resp() for _ in range(20)])
        monkeypatch.setattr(requests, "post", fake_post)

        ingest.post_pull(
            rows,
            pull,
            exec_url=PROD_URL,
            chunk_size=scenario["chunk_size"],
            weeks_complete=weeks_complete_param,
        )

        data_calls = [c for c in fake_post.calls if not c["json"].get("pull")]
        for call in data_calls:
            declared = call["json"].get("weeks_complete") or []
            request_counts = Counter(r["week_label"] for r in call["json"]["rows"])
            for week in declared:
                assert request_counts.get(week, 0) == full_counts[week]


# --------------------------------------------------------------------------- #
# Phase-end review fixes — multi-chunk scoping + no silent row loss
# --------------------------------------------------------------------------- #


def _data_requests(fake_post):
    """Every shopspend data request (excludes the pulls commit marker)."""
    return [c["json"] for c in fake_post.calls if c["json"].get("kind") == "shopspend"
            and "pull" not in c["json"]]


def test_weeks_verified_empty_is_scoped_to_the_chunk_that_declares_it(monkeypatch):
    """Review finding [0]: the FULL weeks_verified_empty list was attached to every
    chunk while weeks_complete carried only that chunk's weeks. validateIngest_
    rejects any payload whose weeks_verified_empty entry is absent from that
    request's weeks_complete, so a multi-chunk pull with an empty spanned week
    aborted entirely (IngestFailed, no data, no pull marker)."""
    rows = _week_rows("2026-W28", "2026-07-06", 4, start_i=0) + _week_rows(
        "2026-W29", "2026-07-13", 4, start_i=100
    )
    pull = _pull(from_week="2026-W28", to_week="2026-W31")

    fake_post = _FakePost([_ok_resp() for _ in range(20)])
    monkeypatch.setattr(requests, "post", fake_post)

    ingest.post_pull(
        rows,
        pull,
        chunk_size=5,
        exec_url=PROD_URL,
        weeks_complete=["2026-W28", "2026-W29", "2026-W31"],
        weeks_verified_empty=["2026-W31"],
    )

    reqs = _data_requests(fake_post)
    assert len(reqs) > 1, "scenario must span more than one chunk to be meaningful"
    for req in reqs:
        declared = set(req.get("weeks_complete") or [])
        verified = set(req.get("weeks_verified_empty") or [])
        assert verified <= declared, (
            f"weeks_verified_empty {sorted(verified)} not a subset of this request's "
            f"weeks_complete {sorted(declared)} — GAS validateIngest_ would reject it"
        )


def test_rows_for_undeclared_weeks_are_still_posted(monkeypatch):
    """Review finding [1]: silent row loss. When weeks_complete was non-empty the
    packer iterated only over weeks_complete, so rows for any other week were
    dropped with no warning and no non-zero exit. Before this phase every mapped
    row was posted unconditionally."""
    rows = _week_rows("2026-W28", "2026-07-06", 2, start_i=0) + _week_rows(
        "2026-W99", "2026-07-13", 1, start_i=100
    )
    pull = _pull(from_week="2026-W28", to_week="2026-W28")

    fake_post = _FakePost([_ok_resp() for _ in range(20)])
    monkeypatch.setattr(requests, "post", fake_post)

    ingest.post_pull(
        rows,
        pull,
        chunk_size=200,
        exec_url=PROD_URL,
        weeks_complete=["2026-W28"],
    )

    posted = Counter()
    for req in _data_requests(fake_post):
        for row in req["rows"]:
            posted[row["week_label"]] += 1

    assert posted["2026-W28"] == 2
    assert posted["2026-W99"] == 1, "rows for an undeclared week must not be silently dropped"

    # And they must never be declared complete — that would authorise tombstoning
    # a week we did not verify.
    for req in _data_requests(fake_post):
        if any(r["week_label"] == "2026-W99" for r in req["rows"]):
            assert not req.get("weeks_complete"), (
                "an undeclared week's rows must travel in a request that declares nothing"
            )
