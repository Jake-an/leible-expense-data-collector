"""Tests for the Cropster roasting connector + the base_connector hooks it needs.

All fixtures are synthetic: invented profile ids/names and round dummy numbers.
No browser, no network, no real credentials (get_credential is stubbed).

Symbols are referenced as `cropster.<name>` / `b.<name>` inside test bodies so a
missing implementation fails as AttributeError/assertion, not a collection error.
"""

from __future__ import annotations

import copy
import json
import logging
from datetime import UTC, date, datetime
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo

import base_connector as b
import cropster
import pytest

SYD = ZoneInfo("Australia/Sydney")
EXEC_URL = "https://example.invalid/exec"


@pytest.fixture(autouse=True)
def isolated(monkeypatch):
    monkeypatch.delenv("GAS_EXEC_URL", raising=False)
    monkeypatch.setattr(b, "get_credential", lambda name: "dummy-token")
    sleeps: list = []
    monkeypatch.setattr(b, "_sleep", lambda s: sleeps.append(s), raising=False)
    return sleeps


def _utc_ms(y, mo, d, h=0, mi=0, s=0, ms=0):
    dt = datetime(y, mo, d, h, mi, s, tzinfo=UTC)
    return int(dt.timestamp() * 1000) + ms


# --------------------------------------------------------------------------- #
# Week math
# --------------------------------------------------------------------------- #


def test_week_bounds_aedt_week():
    # Mon 2026-10-12 is AEDT (UTC+11): midnight = Sun 11 Oct 13:00Z.
    frm, to = cropster.sydney_week_bounds(date(2026, 10, 12))
    assert frm == _utc_ms(2026, 10, 11, 13)
    assert to - frm + 1 == 7 * 24 * 3600 * 1000
    assert to == _utc_ms(2026, 10, 18, 12, 59, 59, 999)


def test_week_bounds_aest_week():
    # Mon 2026-07-06 is AEST (UTC+10).
    frm, to = cropster.sydney_week_bounds(date(2026, 7, 6))
    assert frm == _utc_ms(2026, 7, 5, 14)
    assert to - frm + 1 == 7 * 24 * 3600 * 1000


def test_week_bounds_week_containing_october_dst_start():
    # Mon 2026-09-28 (AEST) .. Sun 2026-10-04 (switch to AEDT at 02:00): 7d - 1h.
    frm, to = cropster.sydney_week_bounds(date(2026, 9, 28))
    assert frm == _utc_ms(2026, 9, 27, 14)
    assert to - frm + 1 == 7 * 24 * 3600 * 1000 - 3600 * 1000
    # next Monday 00:00 AEDT = Sun 4 Oct 13:00Z, so `to` is 1 ms before it
    assert to == _utc_ms(2026, 10, 4, 13) - 1


def test_week_bounds_week_containing_april_dst_end():
    # Mon 2026-03-30 (AEDT) .. Sun 2026-04-05 (back to AEST at 03:00): 7d + 1h.
    frm, to = cropster.sydney_week_bounds(date(2026, 3, 30))
    assert frm == _utc_ms(2026, 3, 29, 13)
    assert to - frm + 1 == 7 * 24 * 3600 * 1000 + 3600 * 1000
    assert to == _utc_ms(2026, 4, 5, 14) - 1


def test_weeks_to_pull_monday_morning_newest_is_previous_week():
    now = datetime(2026, 10, 19, 5, 30, tzinfo=SYD)  # Monday
    assert cropster.weeks_to_pull(now, 2) == [date(2026, 10, 5), date(2026, 10, 12)]


def test_weeks_to_pull_sunday_night_excludes_current_week():
    now = datetime(2026, 10, 18, 23, 0, tzinfo=SYD)  # Sunday, week still running
    weeks = cropster.weeks_to_pull(now, 2)
    assert weeks == [date(2026, 9, 28), date(2026, 10, 5)]
    assert date(2026, 10, 12) not in weeks


def test_weeks_to_pull_counts_and_order():
    now = datetime(2026, 10, 21, 9, 0, tzinfo=SYD)
    two = cropster.weeks_to_pull(now, 2)
    twelve = cropster.weeks_to_pull(now, 12)
    assert len(two) == 2 and len(twelve) == 12
    assert twelve == sorted(twelve)  # oldest first
    assert twelve[-2:] == two
    assert twelve[-1] == date(2026, 10, 12)
    assert all(w.weekday() == 0 for w in twelve)  # all Mondays


# --------------------------------------------------------------------------- #
# URL
# --------------------------------------------------------------------------- #


def test_summaries_url_has_encoded_bracket_params_and_group():
    url = cropster.summaries_url(1000, 2000, "MACHINE")
    assert url.startswith("https://c-sar.cropster.com/api/v2/productionSummaries?")
    assert "%5B" in url and "%5D" in url and "[" not in url
    q = parse_qs(urlparse(url).query)
    assert q["filter[productionSummaries][group]"] == ["LEICOF"]
    assert q["filter[productionSummaries][weightUnit]"] == ["KG"]
    assert q["filter[productionSummaries][dateFrom]"] == ["1000"]
    assert q["filter[productionSummaries][dateTo]"] == ["2000"]
    assert q["group[productionSummaries]"] == ["MACHINE"]


# --------------------------------------------------------------------------- #
# Parse / reconcile
# --------------------------------------------------------------------------- #

WEEK = "2026-10-12"
FROM_MS, TO_MS = 1_700_000_000_000, 1_700_000_604_799_999
NAMES = {"pAAAA": "Dummy Blend", "pBBBB": "Dummy Single"}


def _w(kg):
    return {"amount": kg, "unit": "KG", "amountSI": kg}


def _entry(key, val, start, end, batches):
    return {
        "id": f"id-{val}",
        "type": "productionSummaries",
        "attributes": {
            key: val,
            "startWeight": _w(start),
            "endWeight": _w(end),
            "batchCount": batches,
            "failedBatchWeight": None,
            "failRate": None,
        },
    }


def _profile_json():
    return {
        "data": [
            _entry("profile", "pAAAA", 100, 85, 5),
            _entry("profile", "pBBBB", 50, 42.5, 3),
        ]
    }


def _machine_json():
    return {"data": [_entry("machine", "mXXXX", 150, 127.5, 8)]}


def _good_url(frm=FROM_MS, to=TO_MS, group="PROFILE"):
    return cropster.summaries_url(frm, to, group)


def _parse(profile=None, machine=None, names=None, url=None, frm=FROM_MS, to=TO_MS):
    return cropster.parse_and_reconcile(
        WEEK,
        profile if profile is not None else _profile_json(),
        machine if machine is not None else _machine_json(),
        names if names is not None else NAMES,
        frm,
        to,
        url if url is not None else _good_url(),
    )


def test_parse_happy_path_exact_rows():
    rows = _parse()
    by_profile = {r["profile"]: r for r in rows}
    assert set(by_profile) == {"Dummy Blend", "Dummy Single"}
    assert by_profile["Dummy Blend"] == {
        "date": WEEK,
        "week_start": WEEK,
        "profile": "Dummy Blend",
        "green_kg_in": 100,
        "roasted_kg_out": 85,
        "weight_loss_pct": 15.0,
        "batch_count": 5,
    }
    assert by_profile["Dummy Single"]["weight_loss_pct"] == 15.0
    for r in rows:
        assert set(r) == {
            "date",
            "week_start",
            "profile",
            "green_kg_in",
            "roasted_kg_out",
            "weight_loss_pct",
            "batch_count",
        }
        assert r["date"] == r["week_start"]


def test_parse_loss_is_rounded_to_two_decimals():
    prof = {"data": [_entry("profile", "pAAAA", 30, 25, 2)]}
    mach = {"data": [_entry("machine", "mXXXX", 30, 25, 2)]}
    (row,) = _parse(profile=prof, machine=mach)
    assert row["weight_loss_pct"] == 16.67


def test_parse_zero_start_weight_gives_null_loss():
    prof = {"data": [_entry("profile", "pAAAA", 0, 5, 1)]}
    mach = {"data": [_entry("machine", "mXXXX", 0, 5, 1)]}
    (row,) = _parse(profile=prof, machine=mach)
    assert row["weight_loss_pct"] is None


def test_parse_skips_profile_with_no_batches_and_no_weight():
    prof = {
        "data": [
            _entry("profile", "pAAAA", 100, 85, 5),
            _entry("profile", "pBBBB", 0, 0, 0),
        ]
    }
    mach = {"data": [_entry("machine", "mXXXX", 100, 85, 5)]}
    rows = _parse(profile=prof, machine=mach)
    assert [r["profile"] for r in rows] == ["Dummy Blend"]


def test_parse_empty_data_on_both_groupings_is_zero_rows_no_error():
    assert _parse(profile={"data": []}, machine={"data": []}) == []


def test_parse_missing_end_weight_raises():
    prof = _profile_json()
    del prof["data"][0]["attributes"]["endWeight"]
    with pytest.raises(cropster.ReconcileError):
        _parse(profile=prof)


def test_parse_missing_batch_count_raises():
    prof = _profile_json()
    del prof["data"][1]["attributes"]["batchCount"]
    with pytest.raises(cropster.ReconcileError):
        _parse(profile=prof)


def test_parse_non_kg_unit_raises():
    prof = _profile_json()
    prof["data"][0]["attributes"]["endWeight"]["unit"] = "LBS"
    with pytest.raises(cropster.ReconcileError):
        _parse(profile=prof)


def test_parse_amount_not_equal_amount_si_raises():
    prof = _profile_json()
    prof["data"][0]["attributes"]["startWeight"]["amountSI"] = 99
    with pytest.raises(cropster.ReconcileError):
        _parse(profile=prof)


def test_parse_response_url_range_differs_from_requested_raises():
    with pytest.raises(cropster.ReconcileError):
        _parse(url=_good_url(frm=FROM_MS + 86_400_000))
    with pytest.raises(cropster.ReconcileError):
        _parse(url=_good_url(to=TO_MS - 1))


def test_parse_profile_vs_machine_kg_mismatch_raises():
    mach = {"data": [_entry("machine", "mXXXX", 150, 127.0, 8)]}  # 0.5 kg off
    with pytest.raises(cropster.ReconcileError):
        _parse(machine=mach)


def test_parse_kg_difference_within_tolerance_is_ok():
    mach = {"data": [_entry("machine", "mXXXX", 150, 127.55, 8)]}  # 0.05 kg off
    assert len(_parse(machine=mach)) == 2


def test_parse_batch_count_mismatch_raises():
    mach = {"data": [_entry("machine", "mXXXX", 150, 127.5, 9)]}
    with pytest.raises(cropster.ReconcileError):
        _parse(machine=mach)


def test_parse_unresolved_profile_id_raises():
    with pytest.raises(cropster.ReconcileError):
        _parse(names={"pAAAA": "Dummy Blend"})  # pBBBB has no name


# --------------------------------------------------------------------------- #
# Base hooks
# --------------------------------------------------------------------------- #


class _Resp:
    def __init__(self, body):
        self._body = body
        self.text = json.dumps(body)

    def raise_for_status(self):
        pass

    def json(self):
        return self._body


class _PlainConnector(b.BaseConnector):
    NAME = "plain_test"
    SOURCE = "plain_test"


class _KindConnector(b.BaseConnector):
    NAME = "kind_test"
    SOURCE = "kind_test"
    KIND = "thing"

    @classmethod
    def validate_rows(cls, rows):
        return None  # no `total` requirement


def test_default_connector_payload_is_unchanged(monkeypatch):
    sent = []
    monkeypatch.setattr(
        b.requests, "post", lambda url, **kw: sent.append(kw["json"]) or _Resp({"result": "ok"})
    )
    _PlainConnector(exec_url=EXEC_URL).post(
        [{"date": "2026-07-01", "total": 1.0, "invoice_ref": "I"}]
    )
    (payload,) = sent
    assert list(payload) == ["source", "rows", "extracted_at", "token"]
    assert "kind" not in payload
    assert b.BaseConnector.KIND is None


def test_default_connector_still_checks_totals(monkeypatch):
    monkeypatch.setattr(b.requests, "post", lambda *a, **kw: _Resp({"result": "ok"}))
    with pytest.raises(b.IngestError):
        _PlainConnector(exec_url=EXEC_URL).post([{"date": "2026-07-01", "invoice_ref": "I"}])


def test_default_validate_rows_is_the_total_check():
    with pytest.raises(b.IngestError):
        _PlainConnector.validate_rows([{"date": "2026-07-01"}])
    _PlainConnector.validate_rows([{"date": "2026-07-01", "total": 2.5}])


def test_default_extra_payload_is_empty():
    assert _PlainConnector(exec_url=EXEC_URL).extra_payload() == {}


def test_kind_connector_payload_has_kind_and_uses_its_own_validate_rows(monkeypatch):
    sent = []
    monkeypatch.setattr(
        b.requests, "post", lambda url, **kw: sent.append(kw["json"]) or _Resp({"result": "ok"})
    )
    _KindConnector(exec_url=EXEC_URL).post([{"date": "2026-07-01", "x": 1}])
    assert sent[0]["kind"] == "thing"


def test_extra_payload_is_merged(monkeypatch):
    sent = []
    monkeypatch.setattr(
        b.requests, "post", lambda url, **kw: sent.append(kw["json"]) or _Resp({"result": "ok"})
    )

    class _Extra(_KindConnector):
        def extra_payload(self):
            return {"allow_shrink": True}

    _Extra(exec_url=EXEC_URL).post([{"date": "2026-07-01"}])
    assert sent[0]["allow_shrink"] is True
    assert sent[0]["kind"] == "thing"


def test_locked_retries_exactly_once_after_sleeping(monkeypatch, isolated):
    responses = [_Resp({"result": "error", "code": "LOCKED"}), _Resp({"result": "ok", "n": 1})]
    calls = []
    monkeypatch.setattr(
        b.requests, "post", lambda url, **kw: calls.append(1) or responses[len(calls) - 1]
    )
    result = _KindConnector(exec_url=EXEC_URL).post([{"date": "2026-07-01"}])
    assert result == {"result": "ok", "n": 1}
    assert len(calls) == 2
    assert isolated == [60]


def test_locked_twice_raises_ingest_error_after_one_retry(monkeypatch, isolated):
    calls = []
    monkeypatch.setattr(
        b.requests,
        "post",
        lambda url, **kw: calls.append(1) or _Resp({"result": "error", "code": "LOCKED"}),
    )
    with pytest.raises(b.IngestError):
        _KindConnector(exec_url=EXEC_URL).post([{"date": "2026-07-01"}])
    assert len(calls) == 2
    assert isolated == [60]


# --------------------------------------------------------------------------- #
# Connector
# --------------------------------------------------------------------------- #


def _row(**over):
    row = {
        "date": WEEK,
        "week_start": WEEK,
        "profile": "Dummy Blend",
        "green_kg_in": 100,
        "roasted_kg_out": 85,
        "weight_loss_pct": 15.0,
        "batch_count": 5,
    }
    row.update(over)
    return row


def test_connector_constants():
    c = cropster.CropsterConnector
    assert (c.NAME, c.SOURCE, c.KIND) == ("cropster", "cropster", "roasting")
    assert c.LOGIN_URL == "https://c-sar.cropster.com/apps/roast/production-report"


def test_validate_rows_accepts_contract_rows_including_null_loss():
    cropster.CropsterConnector.validate_rows([_row(), _row(weight_loss_pct=None)])


def test_validate_rows_rejects_total():
    with pytest.raises(b.IngestError):
        cropster.CropsterConnector.validate_rows([_row(total=1.0)])


def test_validate_rows_rejects_date_not_equal_week_start():
    with pytest.raises(b.IngestError):
        cropster.CropsterConnector.validate_rows([_row(date="2026-10-13")])


@pytest.mark.parametrize("extra", [{"pulled_at": "x"}, {"department": "Roastery"}])
def test_validate_rows_rejects_unknown_fields(extra):
    with pytest.raises(b.IngestError):
        cropster.CropsterConnector.validate_rows([_row(**extra)])


@pytest.mark.parametrize("field", ["green_kg_in", "roasted_kg_out", "batch_count"])
def test_validate_rows_rejects_non_numeric_values(field):
    with pytest.raises(b.IngestError):
        cropster.CropsterConnector.validate_rows([_row(**{field: "85"})])
    with pytest.raises(b.IngestError):
        cropster.CropsterConnector.validate_rows([_row(**{field: True})])


def test_validate_rows_rejects_missing_key():
    r = _row()
    del r["profile"]
    with pytest.raises(b.IngestError):
        cropster.CropsterConnector.validate_rows([r])


def test_post_sends_kind_roasting_and_allow_shrink_only_when_set(monkeypatch):
    sent = []
    monkeypatch.setattr(
        b.requests, "post", lambda url, **kw: sent.append(kw["json"]) or _Resp({"result": "ok"})
    )
    cropster.CropsterConnector(exec_url=EXEC_URL).post([_row()])
    cropster.CropsterConnector(exec_url=EXEC_URL, allow_shrink=True).post([_row()])
    assert sent[0]["source"] == "cropster" and sent[0]["kind"] == "roasting"
    assert "allow_shrink" not in sent[0]
    assert sent[1]["allow_shrink"] is True


def test_allow_shrink_without_backfill_is_a_usage_error(capsys):
    with pytest.raises(SystemExit) as exc:
        cropster.main(["--allow-shrink"])
    assert exc.value.code == 2


def test_dry_run_never_posts_and_default_is_two_weeks(monkeypatch):
    seen = {}

    def fake_collect(self, attended, weeks):
        seen["n"] = len(weeks)
        return [_row()]

    monkeypatch.setattr(cropster.CropsterConnector, "collect", fake_collect)
    monkeypatch.setattr(
        cropster.CropsterConnector,
        "post",
        lambda self, rows: pytest.fail("--dry-run must not post"),
    )
    monkeypatch.setattr(b.requests, "post", lambda *a, **kw: pytest.fail("no HTTP in dry-run"))
    cropster.main(["--dry-run"])
    assert seen["n"] == 2


def test_backfill_pulls_twelve_weeks(monkeypatch):
    seen = {}

    def fake_collect(self, attended, weeks):
        seen["n"] = len(weeks)
        seen["allow_shrink"] = self.allow_shrink
        return [_row()]

    monkeypatch.setattr(cropster.CropsterConnector, "collect", fake_collect)
    cropster.main(["--backfill", "--allow-shrink", "--dry-run"])
    assert seen == {"n": 12, "allow_shrink": True}


# ---- read_weeks: browser flow against a fake page, and secret hygiene ------ #

SECRET = "dummy-secret-xyz"
COOKIE = "session=dummy-cookie-abc"


class _FakeRequestObj:
    def all_headers(self):
        return {
            "cropster-authenticate": SECRET,
            "client-version": "cropster-core_0.0",
            "content-type": "application/vnd.api+json",
            "cookie": COOKIE,
            "host": "c-sar.cropster.com",
            "content-length": "0",
        }


class _FakeExpect:
    def __init__(self):
        self.value = _FakeRequestObj()

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class _FakeResponse:
    def __init__(self, url, body, status=200):
        self.url = url
        self.status = status
        self._body = body
        self.ok = status == 200

    def json(self):
        return copy.deepcopy(self._body)

    def text(self):
        return json.dumps(self._body)


class _FakePage:
    def __init__(self, machine_end=127.5):
        self.machine_end = machine_end
        self.gotos: list[str] = []
        self.gets: list[tuple[str, dict]] = []
        self.request = self  # page.request.get(...)

    def expect_request(self, *a, **kw):
        return _FakeExpect()

    def goto(self, url, **kw):
        self.gotos.append(url)

    def get(self, url, headers=None, **kw):
        self.gets.append((url, dict(headers or {})))
        if "/api/v2/profiles/" in url:
            return _FakeResponse(
                url,
                {
                    "data": [
                        {"id": pid, "type": "profiles", "attributes": {"name": nm}}
                        for pid, nm in NAMES.items()
                    ]
                },
            )
        group = parse_qs(urlparse(url).query)["group[productionSummaries]"][0]
        if group == "PROFILE":
            return _FakeResponse(url, _profile_json())
        return _FakeResponse(url, {"data": [_entry("machine", "mXXXX", 150, self.machine_end, 8)]})


def test_read_weeks_returns_reconciled_rows_and_forwards_safe_headers_only():
    page = _FakePage()
    rows = cropster.CropsterConnector(exec_url=EXEC_URL).read_weeks(page, [date(2026, 10, 12)])
    assert {r["profile"] for r in rows} == {"Dummy Blend", "Dummy Single"}
    assert "dateFrom=2026-10-12" in page.gotos[0] and "dateTo=2026-10-18" in page.gotos[0]
    assert len(page.gets) == 3  # PROFILE, MACHINE, profile names
    for _url, headers in page.gets:
        lowered = {k.lower() for k in headers}
        assert "cropster-authenticate" in lowered
        assert not lowered & {"cookie", "host", "content-length"}


def test_read_weeks_never_logs_header_values_or_cookies(caplog, capsys):
    caplog.set_level(logging.DEBUG)
    page = _FakePage()
    cropster.CropsterConnector(exec_url=EXEC_URL).read_weeks(page, [date(2026, 10, 12)])
    out = capsys.readouterr()
    blob = out.out + out.err + caplog.text
    assert SECRET not in blob
    assert "dummy-cookie-abc" not in blob


def test_read_weeks_aborts_on_reconcile_failure_without_leaking_secrets(caplog, capsys):
    caplog.set_level(logging.DEBUG)
    page = _FakePage(machine_end=100.0)  # MACHINE disagrees with PROFILE
    with pytest.raises(cropster.ReconcileError) as exc:
        cropster.CropsterConnector(exec_url=EXEC_URL).read_weeks(page, [date(2026, 10, 12)])
    out = capsys.readouterr()
    blob = out.out + out.err + caplog.text + str(exc.value)
    assert SECRET not in blob
    assert "dummy-cookie-abc" not in blob
