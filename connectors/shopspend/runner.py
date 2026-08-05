"""shopSpend pull CLI: resolve missing closed ISO weeks, fetch, post (step 5 — GREEN implements this).

    python -m connectors.shopspend.runner [--week 2026-W31] [--from-week X --to-week Y]
                                          [--backfill] [--dry-run]

Default (no args): pull the ISO week that just closed — a Monday 05:00 job
asking for the *current* week would get a week five hours old, so we always
look one week back from "today".
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "playwright"))
import base_connector as bc

import shopspend.client as client
import shopspend.ingest as ingest
import shopspend.models as models

_MAX_DIAGNOSTICS_CHARS = 50000
_BACKFILL_WEEKS = 4


def iso_week_span(from_week: str, to_week: str) -> list[str]:
    """All ISO weeks in ascending order from from_week to to_week (inclusive)."""
    from_y, from_w = map(int, from_week.split("-W"))
    to_y, to_w = map(int, to_week.split("-W"))

    weeks = []
    y, w = from_y, from_w
    while (y, w) <= (to_y, to_w):
        weeks.append(f"{y}-W{w:02d}")
        w += 1
        # An ISO year has 52 or 53 weeks; rolling over at a fixed 53 invents a
        # phantom label (e.g. 2025-W53) which then gets declared complete and,
        # having no rows, verified-empty. Dec 28 is always in the year's last
        # ISO week, so its week number IS that year's length.
        if w > date(y, 12, 28).isocalendar()[1]:
            y += 1
            w = 1
    return weeks


def compute_weeks_complete(
    response, pull: dict, mapped_rows: list[dict]
) -> tuple[list[str], list[str]]:
    """Completeness gate: which weeks passed the fetch trust check, and which spanned
    weeks returned no rows. Returns (weeks_complete, weeks_verified_empty).

    Reads response.meta.paging directly, never pull["matched"] or pull["truncated"],
    because _build_pull degrades those when paging is absent.
    """
    span_weeks = set(iso_week_span(pull["from_week"], pull["to_week"]))
    returned_weeks = {row["week_label"] for row in mapped_rows}

    meta = response.meta
    paging = meta.paging if meta else None
    diag = response.diagnostics

    if paging is None:
        print(
            "[shopspend] WARNING: response missing paging info — zero weeks declared",
            file=sys.stderr,
        )
        return [], []

    if paging.truncated:
        return [], []

    if len(response.rows) < paging.matched:
        print(
            f"[shopspend] WARNING: only {len(response.rows)} of {paging.matched} matched row(s) "
            "returned — zero weeks declared",
            file=sys.stderr,
        )
        return [], []

    if paging.matched == 0:
        print("[shopspend] WARNING: matched zero rows — zero weeks declared", file=sys.stderr)
        return [], []

    if diag and diag.totalOrdersScanned == 0:
        print(
            "[shopspend] WARNING: API scanned zero orders — absence unproven, zero weeks declared",
            file=sys.stderr,
        )
        return [], []

    if diag and diag.emptyRangeWithInvalidLabels:
        print(
            "[shopspend] WARNING: empty range with invalid week labels — zero weeks declared",
            file=sys.stderr,
        )
        return [], []

    weeks_complete = sorted(span_weeks)
    weeks_verified_empty = sorted(span_weeks - returned_weeks)

    return weeks_complete, weeks_verified_empty


def default_week_label(today: date) -> str:
    """The ISO week that just closed (today - 7 days), never the current one."""
    closed = today - timedelta(days=7)
    iso_year, iso_week, _ = closed.isocalendar()
    return f"{iso_year}-W{iso_week:02d}"


def last_n_closed_weeks(today: date, n: int) -> list[str]:
    """The `n` closed ISO weeks ending at default_week_label(today), ascending."""
    weeks = []
    for i in range(n):
        d = today - timedelta(days=7 * (i + 1))
        iso_year, iso_week, _ = d.isocalendar()
        weeks.append(f"{iso_year}-W{iso_week:02d}")
    weeks.reverse()
    return weeks


def missing_weeks_for_backfill(candidate_weeks: list[str], covered: set[str]) -> list[str]:
    """Which of `candidate_weeks` have no ShopSpendPulls coverage yet — this is
    what self-heals a Monday when the machine was off."""
    return [week for week in candidate_weeks if week not in covered]


def map_api_row(row: models.ShopSpendRow, gst_treatment: str, environment: str) -> dict:
    """camelCase API row -> our snake_case ShopSpend row. `date` is always the
    week's Monday (week_start) — never re-derived, the API supplies it."""
    return {
        "shop_id": row.shopId,
        "week_label": row.weekLabel,
        "week_start": row.weekStart,
        "week_end": row.weekEnd,
        "order_count": row.orderCount,
        "amended_count": row.amendedCount,
        "total_ex_gst": row.totalExGst,
        "gst": row.gst,
        "total_inc_gst": row.totalIncGst,
        "gst_treatment": gst_treatment,
        "environment": environment,
        "date": row.weekStart,
    }


def truncate_diagnostics_json(blob: str) -> str:
    """A Sheets cell caps at 50,000 characters, and the blob is largest exactly
    when the pull went badly — so this must be defensive, not best-effort."""
    if len(blob) < _MAX_DIAGNOSTICS_CHARS:
        return blob
    marker = "...TRUNCATED"
    keep = _MAX_DIAGNOSTICS_CHARS - len(marker) - 1
    return blob[:keep] + marker


def _build_pull(
    response,
    from_week: str,
    to_week: str,
    environment: str,
    weeks_complete: list[str] | None = None,
    weeks_verified_empty: list[str] | None = None,
) -> dict:
    meta = response.meta or models.Meta()
    diag = response.diagnostics or models.Diagnostics()
    summary = response.summary or models.Summary()
    paging = meta.paging

    diagnostics_json = truncate_diagnostics_json(
        json.dumps(
            {
                "warnings": diag.warnings,
                "unpricedSkus": diag.unpricedSkus,
                "possibleDuplicateShopNames": diag.possibleDuplicateShopNames,
                "invalidWeekLabelSamples": diag.invalidWeekLabelSamples,
                "harness": {
                    "weeks_complete": weeks_complete or [],
                    "weeks_verified_empty": weeks_verified_empty or [],
                },
            }
        )
    )

    return {
        "fetched_at": datetime.now(bc.SYD_TZ).isoformat(timespec="seconds"),
        "environment": environment,
        "from_week": from_week,
        "to_week": to_week,
        "matched": paging.matched if paging else len(response.rows),
        # Every page, not paging.returned — that is the FIRST page's count only,
        # so a paginated pull would record returned < matched and read as
        # truncated when it was in fact complete.
        "returned": len(response.rows),
        "truncated": bool(paging.truncated) if paging else False,
        "warnings_count": len(diag.warnings),
        "warnings": json.dumps(diag.warnings),
        "unpriced_sku_count": len(diag.unpricedSkus),
        "unpriced_skus": json.dumps(diag.unpricedSkus),
        "amended_count": summary.amendedCount,
        "possible_duplicate_shop_names": json.dumps(diag.possibleDuplicateShopNames),
        "empty_range_with_invalid_labels": bool(diag.emptyRangeWithInvalidLabels),
        "invalid_week_labels": json.dumps(diag.invalidWeekLabelSamples),
        "gst_treatment": meta.gstTreatment,
        "diverges_from_live_pricing": "",
        "matches_live_pricing": "",
        "total_orders_scanned": diag.totalOrdersScanned,
        "absent_shop_ids": "",
        "diagnostics_json": diagnostics_json,
    }


def _print_dry_run_summary(response, from_week: str, to_week: str) -> None:
    print(
        f"[shopspend] dry-run {from_week}..{to_week}: {len(response.rows)} row(s), writes nothing"
    )

    diag = response.diagnostics
    if diag:
        for warning in diag.warnings:
            print(f"[shopspend] warning: {warning}")
        if diag.unpricedSkus:
            print(f"[shopspend] unpriced SKUs (totals under-reported): {diag.unpricedSkus}")
        if diag.possibleDuplicateShopNames:
            print(f"[shopspend] possible duplicate shop names: {diag.possibleDuplicateShopNames}")
        if diag.emptyRangeWithInvalidLabels:
            print("[shopspend] empty range contains invalid week labels")

    summary = response.summary
    if summary and summary.amendedCount:
        print(f"[shopspend] {summary.amendedCount} amended order(s) — dollars still provisional")

    if response.meta and response.meta.paging and response.meta.paging.truncated:
        print("[shopspend] WARNING: response truncated by the API")


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Pull shopSpend weekly figures into the hub")
    parser.add_argument("--week", help="single ISO week label, e.g. 2026-W31")
    parser.add_argument("--from-week", help="range start ISO week label")
    parser.add_argument("--to-week", help="range end ISO week label")
    parser.add_argument(
        "--backfill", action="store_true", help=f"the last {_BACKFILL_WEEKS} closed weeks"
    )
    parser.add_argument("--dry-run", action="store_true", help="fetch and print, but write nothing")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_arg_parser().parse_args(argv)
    today = date.today()

    if args.week:
        from_week = to_week = args.week
    elif args.from_week and args.to_week:
        from_week, to_week = args.from_week, args.to_week
    elif args.backfill:
        candidates = last_n_closed_weeks(today, _BACKFILL_WEEKS)
        try:
            covered = client.fetch_coverage()
        except (RuntimeError, client.ShopSpendError, client.ShopSpendTransientError) as err:
            print(
                f"[shopspend] coverage unavailable, requesting full backfill span: {err}",
                file=sys.stderr,
            )
            weeks = candidates
        else:
            weeks = missing_weeks_for_backfill(candidates, covered)

        if not weeks:
            print("[shopspend] backfill: all candidate weeks already covered, nothing to pull")
            return 0

        from_week, to_week = weeks[0], weeks[-1]
    else:
        from_week = to_week = default_week_label(today)

    try:
        url, token, environment = client.resolve_config()
    except RuntimeError as err:
        print(f"[shopspend] {err}", file=sys.stderr)
        return 1

    shopspend_client = client.ShopSpendClient(url=url, token=token, environment=environment)

    try:
        response = shopspend_client.fetch(from_week=from_week, to_week=to_week)
    except (client.ShopSpendError, client.ShopSpendTransientError) as err:
        print(f"[shopspend] fetch failed: {err}", file=sys.stderr)
        return 1

    if args.dry_run:
        _print_dry_run_summary(response, from_week, to_week)
        return 0

    gst_treatment = response.meta.gstTreatment if response.meta else ""
    mapped_rows = [
        map_api_row(row, gst_treatment=gst_treatment, environment=environment)
        for row in response.rows
    ]
    mapped_rows.sort(key=lambda r: client.parse_week_label(r["week_label"]))

    weeks_complete, weeks_verified_empty = compute_weeks_complete(
        response, {"from_week": from_week, "to_week": to_week}, mapped_rows
    )

    pull = _build_pull(
        response,
        from_week,
        to_week,
        environment,
        weeks_complete=weeks_complete,
        weeks_verified_empty=weeks_verified_empty,
    )

    try:
        ingest.post_pull(
            mapped_rows,
            pull,
            weeks_complete=weeks_complete,
            weeks_verified_empty=weeks_verified_empty,
        )
    except (ingest.IngestFailed, RuntimeError) as err:
        print(f"[shopspend] ingest failed: {err}", file=sys.stderr)
        return 1

    print(f"[shopspend] posted {len(mapped_rows)} row(s) for {from_week}..{to_week}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
