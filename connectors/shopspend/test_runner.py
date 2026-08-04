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
import shopspend.models as models
import shopspend.runner as runner


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    """Every test controls SHOPSPEND_* explicitly — never inherit the real env."""
    for key in (
        "SHOPSPEND_ENV",
        "SHOPSPEND_URL_PROD",
        "SHOPSPEND_TOKEN_PROD",
        "SHOPSPEND_URL_DEV",
        "SHOPSPEND_TOKEN_DEV",
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
