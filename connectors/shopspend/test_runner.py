"""
Tests for connectors/shopspend/runner.py — the shopSpend pull CLI.

`runner.py` is an intentionally empty stub at RED time (see its module
docstring) — every symbol below (`default_week_label`, `last_n_closed_weeks`,
`missing_weeks_for_backfill`, `map_api_row`, `truncate_diagnostics_json`,
`main`) is referenced only *inside* test bodies, never as a top-level
`from ... import`, so a missing symbol fails as a clean AttributeError
per-test rather than a whole-file collection ImportError (same convention as
connectors/shopspend/test_client.py).

Chunking / kind / synthetic-date / LOCKED-retry / non-ok / idempotent-resume
behaviour belongs to the poster and is covered in test_ingest.py, not here —
this file covers what is uniquely runner.py's job: resolving which ISO week
to pull (and self-healing a gap), mapping the API's camelCase rows onto our
snake_case ShopSpend row shape, building a defensively-truncated pull
diagnostics blob, and the --dry-run CLI path that must never POST.
"""

import sys
from datetime import date
from pathlib import Path

import pytest
import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "playwright"))
import base_connector as bc

import shopspend.client as client
import shopspend.ingest as ingest
import shopspend.models as models
import shopspend.runner as runner


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
    """get_credential() falls back to reading the repo's real .env when an env
    var is unset — point it at an empty tmp file so a stray real SHOPSPEND_*
    value on Jake's machine can never leak into a test."""
    empty_env = tmp_path / ".env"
    empty_env.write_text("")
    monkeypatch.setattr(bc, "ENV_FILE", empty_env)
    monkeypatch.setattr(bc, "_env_cache", None)


# --------------------------------------------------------------------------- #
# default_week_label — the ISO week that just CLOSED, never the current one
# --------------------------------------------------------------------------- #


def test_default_week_label_is_previous_iso_week_not_current():
    monday = date(2026, 8, 3)  # isocalendar (2026, 32, 1) -> closed week is 2026-W31

    assert runner.default_week_label(monday) == "2026-W31"


def test_default_week_label_year_boundary_early_january_resolves_to_prior_year():
    early_jan = date(2027, 1, 5)  # today - 7 days lands in ISO week 2026-W53

    assert runner.default_week_label(early_jan) == "2026-W53"


def test_default_week_label_zero_pads_w01():
    mid_jan = date(2027, 1, 11)  # today - 7 days lands in ISO week 2027-W01

    assert runner.default_week_label(mid_jan) == "2027-W01"


# --------------------------------------------------------------------------- #
# last_n_closed_weeks — the span --backfill considers
# --------------------------------------------------------------------------- #


def test_last_n_closed_weeks_returns_four_weeks_ending_at_default():
    today = date(2026, 8, 3)  # default_week_label(today) == 2026-W31

    weeks = runner.last_n_closed_weeks(today, 4)

    assert weeks == ["2026-W28", "2026-W29", "2026-W30", "2026-W31"]


# --------------------------------------------------------------------------- #
# missing_weeks_for_backfill — gap detection self-heals a machine-was-off Monday
# --------------------------------------------------------------------------- #


def test_missing_weeks_for_backfill_finds_the_one_gap():
    candidate_weeks = ["2026-W28", "2026-W29", "2026-W30", "2026-W31"]
    covered = {"2026-W28", "2026-W29", "2026-W31"}

    missing = runner.missing_weeks_for_backfill(candidate_weeks, covered)

    assert missing == ["2026-W30"]


def test_missing_weeks_for_backfill_returns_empty_when_fully_covered():
    candidate_weeks = ["2026-W28", "2026-W29"]
    covered = {"2026-W28", "2026-W29"}

    assert runner.missing_weeks_for_backfill(candidate_weeks, covered) == []


# --------------------------------------------------------------------------- #
# map_api_row — camelCase API row -> our snake_case ShopSpend row, no gaps
# --------------------------------------------------------------------------- #


def test_map_api_row_produces_full_snake_case_row_with_no_none_gaps():
    row = models.ShopSpendRow(
        shopId="Leible York",
        weekLabel="2026-W31",
        weekStart="2026-07-27",
        weekEnd="2026-08-02",
        orderCount=12,
        amendedCount=1,
        totalExGst=1000.0,
        gst=100.0,
        totalIncGst=1100.0,
    )

    mapped = runner.map_api_row(row, gst_treatment="EXCLUSIVE_PRIMARY", environment="PROD")

    assert mapped == {
        "shop_id": "Leible York",
        "week_label": "2026-W31",
        "week_start": "2026-07-27",
        "week_end": "2026-08-02",
        "order_count": 12,
        "amended_count": 1,
        "total_ex_gst": 1000.0,
        "gst": 100.0,
        "total_inc_gst": 1100.0,
        "gst_treatment": "EXCLUSIVE_PRIMARY",
        "environment": "PROD",
        "date": "2026-07-27",
    }
    assert None not in mapped.values()


def test_map_api_row_date_always_equals_week_start():
    row = models.ShopSpendRow(weekStart="2026-08-03", weekEnd="2026-08-09")

    mapped = runner.map_api_row(row, gst_treatment="EXCLUSIVE_PRIMARY", environment="PROD")

    assert mapped["date"] == "2026-08-03" == mapped["week_start"]


# --------------------------------------------------------------------------- #
# truncate_diagnostics_json — Sheets cell cap is 50,000 chars, largest blob
# happens exactly when the pull went badly, so this must be defensive
# --------------------------------------------------------------------------- #


def test_truncate_diagnostics_json_keeps_output_below_50000_chars():
    oversized = "x" * 60000

    result = runner.truncate_diagnostics_json(oversized)

    assert len(result) < 50000


def test_truncate_diagnostics_json_leaves_small_blobs_untouched():
    small = '{"warnings": []}'

    assert runner.truncate_diagnostics_json(small) == small


# --------------------------------------------------------------------------- #
# --dry-run — fetch + parse + print, but requests.post is NEVER called
# --------------------------------------------------------------------------- #


def _fake_response(warnings=None):
    return client.ShopSpendResponse(
        rows=[
            models.ShopSpendRow(
                shopId="Leible York",
                weekLabel="2026-W31",
                weekStart="2026-07-27",
                weekEnd="2026-08-02",
                orderCount=1,
                amendedCount=0,
                totalExGst=100.0,
                gst=10.0,
                totalIncGst=110.0,
            )
        ],
        meta=models.Meta(
            environment="PROD",
            timezone="Australia/Sydney",
            gstTreatment="EXCLUSIVE_PRIMARY",
            scope="Confirmed orders only",
        ),
        summary=models.Summary(),
        diagnostics=models.Diagnostics(warnings=warnings or []),
        schemaVersion=1,
    )


def test_dry_run_never_posts_and_prints_data_quality_conditions(monkeypatch, capsys):
    monkeypatch.setattr(
        client.ShopSpendClient,
        "fetch",
        lambda self, **kw: _fake_response(warnings=["missing pricing for SKU-1"]),
    )
    monkeypatch.setenv("SHOPSPEND_ENV", "PROD")
    monkeypatch.setenv("SHOPSPEND_URL_PROD", "https://example.invalid/exec")
    monkeypatch.setenv("SHOPSPEND_TOKEN_PROD", "tok")

    posted = {"called": False}

    def fake_post(*args, **kwargs):
        posted["called"] = True
        raise AssertionError("requests.post must never be called in --dry-run")

    monkeypatch.setattr(requests, "post", fake_post)

    exit_code = runner.main(["--week", "2026-W31", "--dry-run"])

    captured = capsys.readouterr()
    assert posted["called"] is False
    assert exit_code == 0
    assert "missing pricing for SKU-1" in captured.out


# --------------------------------------------------------------------------- #
# --backfill wiring (step 9) — missing_weeks_for_backfill was implemented and
# unit-tested in step 5 but never called from main(); these tests drive that
# wiring. Coverage narrows the request when available and degrades to the
# full 4-week span (never fewer weeks) when fetch_coverage() fails.
# --------------------------------------------------------------------------- #


class _FixedDate(date):
    """monkeypatched in place of runner.date so --backfill tests control
    'today' deterministically — matches last_n_closed_weeks(date(2026,8,3), 4)
    == ["2026-W28", "2026-W29", "2026-W30", "2026-W31"] used elsewhere above."""

    @classmethod
    def today(cls):
        return date(2026, 8, 3)


def _set_shopspend_env(monkeypatch):
    monkeypatch.setenv("SHOPSPEND_ENV", "PROD")
    monkeypatch.setenv("SHOPSPEND_URL_PROD", "https://example.invalid/exec")
    monkeypatch.setenv("SHOPSPEND_TOKEN_PROD", "tok")


def test_backfill_requests_only_missing_week_when_three_of_four_covered(monkeypatch):
    monkeypatch.setattr(runner, "date", _FixedDate)
    _set_shopspend_env(monkeypatch)
    monkeypatch.setattr(client, "fetch_coverage", lambda: {"2026-W28", "2026-W29", "2026-W31"})

    fetch_calls = []

    def fake_fetch(self, **kwargs):
        fetch_calls.append(kwargs)
        return _fake_response()

    monkeypatch.setattr(client.ShopSpendClient, "fetch", fake_fetch)
    monkeypatch.setattr(ingest, "post_pull", lambda *a, **kw: {"result": "ok"})

    exit_code = runner.main(["--backfill"])

    assert exit_code == 0
    assert len(fetch_calls) == 1
    assert fetch_calls[0]["from_week"] == "2026-W30"
    assert fetch_calls[0]["to_week"] == "2026-W30"


def test_backfill_fully_covered_makes_no_request_and_exits_zero(monkeypatch):
    monkeypatch.setattr(runner, "date", _FixedDate)
    _set_shopspend_env(monkeypatch)
    monkeypatch.setattr(
        client,
        "fetch_coverage",
        lambda: {"2026-W28", "2026-W29", "2026-W30", "2026-W31"},
    )

    def fail_fetch(self, **kwargs):
        raise AssertionError("shopSpend API must not be called when fully covered")

    def fail_post(*args, **kwargs):
        raise AssertionError("ingest poster must not be called when fully covered")

    monkeypatch.setattr(client.ShopSpendClient, "fetch", fail_fetch)
    monkeypatch.setattr(ingest, "post_pull", fail_post)

    exit_code = runner.main(["--backfill"])

    assert exit_code == 0


def test_backfill_falls_back_to_full_span_when_coverage_unavailable(monkeypatch):
    monkeypatch.setattr(runner, "date", _FixedDate)
    _set_shopspend_env(monkeypatch)

    coverage_calls = []

    def failing_coverage():
        coverage_calls.append(True)
        raise RuntimeError("hub is down")

    monkeypatch.setattr(client, "fetch_coverage", failing_coverage)

    fetch_calls = []

    def fake_fetch(self, **kwargs):
        fetch_calls.append(kwargs)
        return _fake_response()

    monkeypatch.setattr(client.ShopSpendClient, "fetch", fake_fetch)
    monkeypatch.setattr(ingest, "post_pull", lambda *a, **kw: {"result": "ok"})

    exit_code = runner.main(["--backfill"])

    assert coverage_calls == [True]
    assert exit_code == 0
    assert len(fetch_calls) == 1
    assert fetch_calls[0]["from_week"] == "2026-W28"
    assert fetch_calls[0]["to_week"] == "2026-W31"


def test_dry_run_backfill_never_posts_even_when_weeks_are_missing(monkeypatch):
    monkeypatch.setattr(runner, "date", _FixedDate)
    _set_shopspend_env(monkeypatch)
    monkeypatch.setattr(client, "fetch_coverage", lambda: {"2026-W28", "2026-W29", "2026-W31"})
    monkeypatch.setattr(client.ShopSpendClient, "fetch", lambda self, **kw: _fake_response())

    def fail_post(*args, **kwargs):
        raise AssertionError("--dry-run must never post")

    monkeypatch.setattr(ingest, "post_pull", fail_post)

    exit_code = runner.main(["--backfill", "--dry-run"])

    assert exit_code == 0


def test_backfill_actually_calls_missing_weeks_for_backfill(monkeypatch):
    """The exact wiring this step exists to add — missing_weeks_for_backfill
    was implemented and unit-tested in step 5 but left with no caller."""
    monkeypatch.setattr(runner, "date", _FixedDate)
    _set_shopspend_env(monkeypatch)
    monkeypatch.setattr(
        client,
        "fetch_coverage",
        lambda: {"2026-W28", "2026-W29", "2026-W30", "2026-W31"},
    )
    monkeypatch.setattr(client.ShopSpendClient, "fetch", lambda self, **kw: _fake_response())
    monkeypatch.setattr(ingest, "post_pull", lambda *a, **kw: {"result": "ok"})

    calls = []
    original = runner.missing_weeks_for_backfill

    def spy(candidate_weeks, covered):
        calls.append((candidate_weeks, covered))
        return original(candidate_weeks, covered)

    monkeypatch.setattr(runner, "missing_weeks_for_backfill", spy)

    exit_code = runner.main(["--backfill"])

    assert exit_code == 0
    assert len(calls) == 1
    assert calls[0][0] == ["2026-W28", "2026-W29", "2026-W30", "2026-W31"]


# --------------------------------------------------------------------------- #
# Completeness gate (step 2) — declaring a week complete authorises GAS to
# tombstone it, so the gate must read response.meta.paging directly (never
# pull['matched']/pull['truncated'], which _build_pull degrades to len(rows)/
# False when paging is absent — runner.py:105-107) and decline (declare
# nothing) whenever the fetch cannot be trusted to be whole. The declared
# span always comes from pull['from_week']/pull['to_week'], never the rows.
# --------------------------------------------------------------------------- #


def _shop_row(week_label, shop_id="shop-1"):
    return models.ShopSpendRow(
        shopId=shop_id,
        weekLabel=week_label,
        weekStart="2026-07-27",
        weekEnd="2026-08-02",
        orderCount=1,
        amendedCount=0,
        totalExGst=100.0,
        gst=10.0,
        totalIncGst=110.0,
    )


def _gate_response(
    rows,
    matched,
    truncated=False,
    total_orders_scanned=None,
    empty_range_invalid=False,
    paging=True,
):
    if total_orders_scanned is None:
        total_orders_scanned = len(rows)
    meta = models.Meta(
        environment="PROD",
        timezone="Australia/Sydney",
        gstTreatment="EXCLUSIVE_PRIMARY",
        scope="Confirmed orders only",
        paging=(
            models.Paging(
                limit=100, offset=0, matched=matched, returned=len(rows), truncated=truncated
            )
            if paging
            else None
        ),
    )
    diagnostics = models.Diagnostics(
        totalOrdersScanned=total_orders_scanned, emptyRangeWithInvalidLabels=empty_range_invalid
    )
    return client.ShopSpendResponse(
        rows=rows, meta=meta, summary=models.Summary(), diagnostics=diagnostics, schemaVersion=1
    )


def _mapped(rows):
    return [
        runner.map_api_row(r, gst_treatment="EXCLUSIVE_PRIMARY", environment="PROD") for r in rows
    ]


def test_iso_week_span_single_week_returns_one_label():
    assert runner.iso_week_span("2026-W31", "2026-W31") == ["2026-W31"]


def test_iso_week_span_multi_week_range_is_ascending():
    assert runner.iso_week_span("2026-W28", "2026-W31") == [
        "2026-W28",
        "2026-W29",
        "2026-W30",
        "2026-W31",
    ]


def test_gate_truncated_response_declares_zero_weeks():
    rows = [_shop_row("2026-W31")]
    response = _gate_response(rows, matched=1, truncated=True)
    pull = {"from_week": "2026-W31", "to_week": "2026-W31"}

    weeks_complete, weeks_verified_empty = runner.compute_weeks_complete(
        response, pull, _mapped(rows)
    )

    assert weeks_complete == []
    assert weeks_verified_empty == []


def test_gate_matched_greater_than_returned_rows_declares_zero_weeks():
    rows = [_shop_row("2026-W31")]
    response = _gate_response(rows, matched=5, truncated=False)
    pull = {"from_week": "2026-W31", "to_week": "2026-W31"}

    weeks_complete, weeks_verified_empty = runner.compute_weeks_complete(
        response, pull, _mapped(rows)
    )

    assert weeks_complete == []
    assert weeks_verified_empty == []


def test_gate_matched_zero_declares_zero_weeks_and_warns(capsys):
    response = _gate_response([], matched=0, truncated=False, total_orders_scanned=10)
    pull = {"from_week": "2026-W31", "to_week": "2026-W31"}

    weeks_complete, weeks_verified_empty = runner.compute_weeks_complete(response, pull, [])

    assert weeks_complete == []
    assert weeks_verified_empty == []
    captured = capsys.readouterr()
    assert "WARNING" in captured.out + captured.err


def test_gate_total_orders_scanned_zero_declares_zero_weeks():
    rows = [_shop_row("2026-W31")]
    response = _gate_response(rows, matched=1, truncated=False, total_orders_scanned=0)
    pull = {"from_week": "2026-W31", "to_week": "2026-W31"}

    weeks_complete, weeks_verified_empty = runner.compute_weeks_complete(
        response, pull, _mapped(rows)
    )

    assert weeks_complete == []
    assert weeks_verified_empty == []


def test_gate_empty_range_with_invalid_labels_declares_zero_weeks():
    rows = [_shop_row("2026-W31")]
    response = _gate_response(
        rows, matched=1, truncated=False, total_orders_scanned=5, empty_range_invalid=True
    )
    pull = {"from_week": "2026-W31", "to_week": "2026-W31"}

    weeks_complete, weeks_verified_empty = runner.compute_weeks_complete(
        response, pull, _mapped(rows)
    )

    assert weeks_complete == []
    assert weeks_verified_empty == []


def test_gate_meta_paging_none_declares_zero_weeks_and_warns_reading_response_not_pull(capsys):
    """Constructed so pull['matched'] == len(rows) — exactly what _build_pull
    degrades to when paging is absent (runner.py:105). The test FAILS if the
    gate reads pull['matched'] instead of response.meta.paging directly,
    because pull['matched'] alone would make this look like a complete
    fetch."""
    rows = [_shop_row("2026-W31")]
    response = _gate_response(rows, matched=1, truncated=False, paging=False)
    pull = runner._build_pull(response, "2026-W31", "2026-W31", "PROD")
    assert pull["matched"] == len(rows)

    weeks_complete, weeks_verified_empty = runner.compute_weeks_complete(
        response, pull, _mapped(rows)
    )

    assert weeks_complete == []
    assert weeks_verified_empty == []
    captured = capsys.readouterr()
    assert "WARNING" in captured.out + captured.err


def test_gate_complete_fetch_with_zero_row_spanned_week_declares_both_complete_and_verified_empty():
    rows = [_shop_row("2026-W31")]  # W30 is spanned but returned nothing
    response = _gate_response(rows, matched=1, truncated=False)
    pull = {"from_week": "2026-W30", "to_week": "2026-W31"}

    weeks_complete, weeks_verified_empty = runner.compute_weeks_complete(
        response, pull, _mapped(rows)
    )

    assert weeks_complete == ["2026-W30", "2026-W31"]
    assert weeks_verified_empty == ["2026-W30"]


def test_gate_declared_weeks_equal_pull_span_never_the_returned_rows():
    rows = [_shop_row("2026-W31"), _shop_row("2026-W32")]  # W32 is outside the requested span
    response = _gate_response(rows, matched=2, truncated=False)
    pull = {"from_week": "2026-W31", "to_week": "2026-W31"}

    weeks_complete, weeks_verified_empty = runner.compute_weeks_complete(
        response, pull, _mapped(rows)
    )

    assert weeks_complete == ["2026-W31"]
    assert "2026-W32" not in weeks_complete


def test_gate_weeks_verified_empty_is_subset_of_zero_row_spanned_weeks():
    # span W28..W31; W28 and W30 have rows, W29 and W31 do not
    rows = [_shop_row("2026-W28"), _shop_row("2026-W30")]
    response = _gate_response(rows, matched=2, truncated=False)
    pull = {"from_week": "2026-W28", "to_week": "2026-W31"}

    weeks_complete, weeks_verified_empty = runner.compute_weeks_complete(
        response, pull, _mapped(rows)
    )

    zero_row_spanned_weeks = {"2026-W29", "2026-W31"}
    assert set(weeks_verified_empty) <= zero_row_spanned_weeks
    assert "2026-W28" not in weeks_verified_empty
    assert "2026-W30" not in weeks_verified_empty


def test_main_passes_gate_computed_weeks_complete_and_verified_empty_to_post_pull(monkeypatch):
    _set_shopspend_env(monkeypatch)
    rows = [_shop_row("2026-W31")]
    response = _gate_response(rows, matched=1, truncated=False)
    monkeypatch.setattr(client.ShopSpendClient, "fetch", lambda self, **kw: response)

    captured_kwargs = {}

    def fake_post_pull(mapped_rows, pull, **kwargs):
        captured_kwargs.update(kwargs)
        return {"result": "ok"}

    monkeypatch.setattr(ingest, "post_pull", fake_post_pull)

    exit_code = runner.main(["--week", "2026-W31"])

    assert exit_code == 0
    assert captured_kwargs.get("weeks_complete") == ["2026-W31"]
    assert captured_kwargs.get("weeks_verified_empty") == []
