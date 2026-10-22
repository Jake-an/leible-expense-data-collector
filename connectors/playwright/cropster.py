"""Cropster roasting connector — weekly Production Report (green in / roasted out / loss).

Reads Cropster's own `productionSummaries` API per completed Sydney Mon-Sun week and
POSTs `kind: roasting` rows to the GAS hub. The connector only logs in, reads and
POSTs; GAS validates and writes (two-runtime boundary).

Auth: the API needs the session cookies PLUS the headers the Ember adapter adds. We
take those from the page's own first `productionSummaries` request, hold them in
memory only, and never log or persist them. See
phases/cropster-roasting/contract.md.

Usage:
    python connectors/playwright/cropster.py --attended        # first login
    python connectors/playwright/cropster.py --dry-run         # read, post nothing
    python connectors/playwright/cropster.py                   # last 2 completed weeks
    python connectors/playwright/cropster.py --backfill [--allow-shrink]   # 12 weeks
"""

from __future__ import annotations

import argparse
import math
import sys
from datetime import date, datetime, timedelta
from urllib.parse import parse_qs, quote, urlencode, urlparse
from zoneinfo import ZoneInfo

from base_connector import (
    SESSIONS_DIR,
    BaseConnector,
    BlockedError,
    IngestError,
    _clear_breaker,
    _clear_breaker_with_warning,
    _form_login,
    get_credential,
)
from playwright.sync_api import Page, sync_playwright

SYDNEY = ZoneInfo("Australia/Sydney")
BASE_URL = "https://c-sar.cropster.com"
SUMMARIES_PATH = "/api/v2/productionSummaries"
ACCOUNT_GROUP = "LEICOF"
KG_TOLERANCE = 0.1
DEFAULT_WEEKS = 2
BACKFILL_WEEKS = 12
# Headers the browser adds itself; everything else the page sent is replayed.
_DROP_HEADERS = {"cookie", "host", "content-length"}
ROW_KEYS = (
    "date",
    "week_start",
    "profile",
    "green_kg_in",
    "roasted_kg_out",
    "weight_loss_pct",
    "batch_count",
)


class ReconcileError(Exception):
    """A week's data failed a contract / reconciliation check. Aborts the run."""


# --------------------------------------------------------------------------- #
# Pure helpers
# --------------------------------------------------------------------------- #


def sydney_week_bounds(monday: date) -> tuple[int, int]:
    """(from_ms, to_ms): Monday 00:00:00.000 .. Sunday 23:59:59.999 Sydney, epoch ms."""
    start = datetime(monday.year, monday.month, monday.day, tzinfo=SYDNEY)
    nxt = monday + timedelta(days=7)
    end = datetime(nxt.year, nxt.month, nxt.day, tzinfo=SYDNEY)
    return int(start.timestamp() * 1000), int(end.timestamp() * 1000) - 1


def weeks_to_pull(now_sydney: datetime, n: int) -> list[date]:
    """The n most recent COMPLETED Mon-Sun weeks (Mondays), oldest first."""
    today = now_sydney.astimezone(SYDNEY).date()
    this_monday = today - timedelta(days=today.weekday())
    return [this_monday - timedelta(weeks=k) for k in range(n, 0, -1)]


def summaries_url(from_ms: int, to_ms: int, group: str) -> str:
    query = urlencode(
        {
            "filter[productionSummaries][group]": ACCOUNT_GROUP,
            "filter[productionSummaries][weightUnit]": "KG",
            "filter[productionSummaries][dateFrom]": from_ms,
            "filter[productionSummaries][dateTo]": to_ms,
            "group[productionSummaries]": group,
        }
    )
    return f"{BASE_URL}{SUMMARIES_PATH}?{query}"


def _num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _weight(attrs: dict, field: str) -> float:
    w = attrs.get(field)
    if not isinstance(w, dict):
        raise ReconcileError(f"missing {field}")
    if w.get("unit") != "KG":
        raise ReconcileError(f"{field} unit is {w.get('unit')!r}, expected KG")
    amount, si = w.get("amount"), w.get("amountSI")
    if not _num(amount) or not _num(si) or amount != si:
        raise ReconcileError(f"{field} amount/amountSI invalid or unequal")
    return amount


def _entries(payload: dict, key: str) -> list[dict]:
    """Validate every entry of one grouping; return [{id, start, end, batches}]."""
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, list):
        raise ReconcileError(f"{key} response has no data list")
    out = []
    for entry in data:
        attrs = entry.get("attributes") if isinstance(entry, dict) else None
        if not isinstance(attrs, dict):
            raise ReconcileError(f"{key} entry has no attributes")
        batches = attrs.get("batchCount")
        if not _num(batches):
            raise ReconcileError(f"{key} entry missing batchCount")
        out.append(
            {
                "id": attrs.get(key),
                "start": _weight(attrs, "startWeight"),
                "end": _weight(attrs, "endWeight"),
                "batches": batches,
            }
        )
    return out


def parse_and_reconcile(
    week_start: str,
    profile_json: dict,
    machine_json: dict,
    names: dict[str, str],
    requested_from_ms: int,
    requested_to_ms: int,
    response_url: str,
) -> list[dict]:
    """Validate one week and return row-contract rows, or raise ReconcileError.

    The range check below is a request-integrity check (it catches a redirect that
    drops or rewrites the date params), NOT a server echo: the response body does not
    echo the range, and `response_url` is the URL of the request we built ourselves.
    """
    q = parse_qs(urlparse(response_url).query)
    got_from = q.get("filter[productionSummaries][dateFrom]", [None])[0]
    got_to = q.get("filter[productionSummaries][dateTo]", [None])[0]
    if got_from != str(requested_from_ms) or got_to != str(requested_to_ms):
        raise ReconcileError("response date range differs from the requested range")

    profiles = _entries(profile_json, "profile")
    machines = _entries(machine_json, "machine")

    if abs(sum(p["end"] for p in profiles) - sum(m["end"] for m in machines)) > KG_TOLERANCE + 1e-9:
        raise ReconcileError("PROFILE and MACHINE roasted kg totals disagree")
    if sum(p["batches"] for p in profiles) != sum(m["batches"] for m in machines):
        raise ReconcileError("PROFILE and MACHINE batch counts disagree")

    rows = []
    for p in profiles:
        if p["batches"] == 0 and p["start"] == 0 and p["end"] == 0:
            continue
        name = names.get(p["id"])
        if not name:
            raise ReconcileError(f"profile id {p['id']!r} did not resolve to a name")
        loss = None if p["start"] == 0 else round(100 * (1 - p["end"] / p["start"]), 2)
        if loss is not None and not 0 <= loss <= 100:
            # roasted > green is a Cropster data-entry slip; a negative loss would
            # make the hub refuse the whole payload, so store kg and null the %.
            print(f"  [cropster] {week_start} profile {p['id']}: loss outside 0..100, stored as null")
            loss = None
        rows.append(
            {
                "date": week_start,
                "week_start": week_start,
                "profile": name,
                "green_kg_in": p["start"],
                "roasted_kg_out": p["end"],
                "weight_loss_pct": loss,
                "batch_count": p["batches"],
            }
        )
    return rows


# --------------------------------------------------------------------------- #
# Connector
# --------------------------------------------------------------------------- #


class CropsterConnector(BaseConnector):
    NAME = "cropster"
    SOURCE = "cropster"
    KIND = "roasting"
    LOGIN_URL = f"{BASE_URL}/apps/roast/production-report"

    def __init__(self, exec_url: str | None = None, allow_shrink: bool = False):
        super().__init__(exec_url=exec_url)
        self.allow_shrink = allow_shrink

    def extra_payload(self) -> dict:
        return {"allow_shrink": True} if self.allow_shrink else {}

    @classmethod
    def validate_rows(cls, rows: list[dict]) -> None:
        for i, row in enumerate(rows):
            if set(row) != set(ROW_KEYS):
                raise IngestError(
                    f"row {i} keys {sorted(row)} differ from the roasting row contract. "
                    f"Nothing was posted."
                )
            if row["date"] != row["week_start"]:
                raise IngestError(f"row {i} date != week_start. Nothing was posted.")
            if not isinstance(row["profile"], str) or not row["profile"]:
                raise IngestError(f"row {i} has no profile name. Nothing was posted.")
            for field in ("green_kg_in", "roasted_kg_out", "batch_count"):
                if not _num(row[field]):
                    raise IngestError(
                        f"row {i} {field} is not a finite number. Nothing was posted."
                    )
            loss = row["weight_loss_pct"]
            if loss is not None and not _num(loss):
                raise IngestError(f"row {i} weight_loss_pct is not a number or null.")
            if loss is not None and not 0 <= loss <= 100:
                raise IngestError(f"row {i} weight_loss_pct is outside 0..100. Nothing was posted.")

    # ---- auth ------------------------------------------------------------ #
    def is_logged_in(self, page: Page) -> bool:
        """True only when the report page loaded AND productionSummaries returned 200.
        A cookie being present proves nothing about validity."""
        try:
            with page.expect_response(
                lambda r: "productionSummaries" in r.url, timeout=30000
            ) as info:
                page.goto(self.LOGIN_URL, wait_until="domcontentloaded")
            return info.value.status == 200
        except Exception:  # noqa: BLE001 - no summaries response == not logged in
            return False

    def credentials_login(self, page: Page) -> bool:
        email = get_credential("CROPSTER_EMAIL")
        password = get_credential("CROPSTER_PASSWORD")
        _form_login(
            page,
            self.LOGIN_URL,
            email or "",
            password or "",
            'input[type="email"], input[name="username"], input[name="email"]',
            'input[type="password"]',
            'button[type="submit"]',
        )
        if page.query_selector('iframe[src*="captcha"]'):
            self.mark_blocked("CAPTCHA presented — run --attended")
        return self.is_logged_in(page)

    # ---- browser flow ---------------------------------------------------- #
    def read_weeks(self, page: Page, weeks: list[date]) -> list[dict]:
        """Fetch + reconcile every week. Any exception aborts the whole run."""
        if not weeks:
            return []
        first = weeks[0]
        last_day = first + timedelta(days=6)
        with page.expect_request(lambda r: "productionSummaries" in r.url, timeout=30000) as info:
            page.goto(
                f"{self.LOGIN_URL}?dateFrom={first.isoformat()}&dateTo={last_day.isoformat()}"
            )
        # In memory only. Never logged, printed or written to disk.
        headers = {
            k: v for k, v in info.value.all_headers().items() if k.lower() not in _DROP_HEADERS
        }

        rows: list[dict] = []
        for wk in weeks:
            from_ms, to_ms = sydney_week_bounds(wk)
            profile_url, profile_json = self._get_json(
                page, summaries_url(from_ms, to_ms, "PROFILE"), headers, "PROFILE"
            )
            _, machine_json = self._get_json(
                page, summaries_url(from_ms, to_ms, "MACHINE"), headers, "MACHINE"
            )
            ids = sorted(
                {
                    e["attributes"]["profile"]
                    for e in profile_json.get("data", [])
                    if isinstance(e, dict) and (e.get("attributes") or {}).get("profile")
                }
            )
            names = self._profile_names(page, ids, headers)
            week_rows = parse_and_reconcile(
                wk.isoformat(), profile_json, machine_json, names, from_ms, to_ms, profile_url
            )
            print(f"[{self.NAME}] week {wk.isoformat()} n_profiles={len(week_rows)} ok")
            rows.extend(week_rows)
        return rows

    @staticmethod
    def _get_json(page: Page, url: str, headers: dict, what: str) -> tuple[str, dict]:
        resp = page.request.get(url, headers=headers)
        if resp.status != 200:
            raise ReconcileError(f"{what} request returned HTTP {resp.status}")
        return resp.url, resp.json()

    def _profile_names(self, page: Page, ids: list[str], headers: dict) -> dict[str, str]:
        if not ids:
            return {}
        # Literal commas between ids (per contract); each id percent-encoded alone.
        url = f"{BASE_URL}/api/v2/profiles/{','.join(quote(i, safe='') for i in ids)}"
        _, payload = self._get_json(page, url, headers, "profile names")
        names = {}
        for e in payload.get("data", []):
            name = (e.get("attributes") or {}).get("name")
            if e.get("id") and name:
                names[e["id"]] = name
        return names

    def collect(self, attended: bool, weeks: list[date]) -> list[dict]:
        """Log in (saved session -> auto-login -> attended) and read the weeks."""
        SESSIONS_DIR.mkdir(exist_ok=True)
        with sync_playwright() as pw:
            context = self._new_context(pw, headed=attended)
            page = context.new_page()
            if attended:
                if not self.is_logged_in(page):
                    self._reset_session_state(page)
                    self._attended_login(page)
                _clear_breaker_with_warning(
                    self.NAME, self.NAME, "CROPSTER_EMAIL", "CROPSTER_PASSWORD"
                )
            elif not self.is_logged_in(page):
                creds = bool(
                    get_credential("CROPSTER_EMAIL") and get_credential("CROPSTER_PASSWORD")
                )
                self._attempt_auto_login(page, self.NAME, creds)
            rows = self.read_weeks(page, weeks)
            context.storage_state(path=str(self.session_path))
            context.close()
        return rows


def _print_summary(rows: list[dict]) -> None:
    by_week: dict[str, list[dict]] = {}
    for r in rows:
        by_week.setdefault(r["week_start"], []).append(r)
    for wk in sorted(by_week):
        grp = by_week[wk]
        print(
            f"[cropster] {wk}: {len(grp)} profile(s), "
            f"{sum(r['roasted_kg_out'] for r in grp):.1f} kg roasted, "
            f"{sum(r['batch_count'] for r in grp)} batch(es)"
        )


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="cropster roasting connector")
    parser.add_argument("--attended", action="store_true", help="headed first login")
    parser.add_argument("--clear-breaker", action="store_true", help="clear the auto-login breaker")
    parser.add_argument("--dry-run", action="store_true", help="read and summarise; POSTs nothing")
    parser.add_argument("--backfill", action="store_true", help=f"pull {BACKFILL_WEEKS} weeks")
    parser.add_argument(
        "--allow-shrink",
        action="store_true",
        help="let a backfill shrink stored rows (needs --backfill)",
    )
    args = parser.parse_args(argv)
    if args.allow_shrink and not args.backfill:
        parser.error("--allow-shrink is only valid with --backfill")
    if args.clear_breaker:
        _clear_breaker(CropsterConnector.NAME)
        print("[cropster] auto-login breaker cleared")
        return

    connector = CropsterConnector(allow_shrink=args.allow_shrink)
    weeks = weeks_to_pull(datetime.now(SYDNEY), BACKFILL_WEEKS if args.backfill else DEFAULT_WEEKS)
    try:
        if not args.dry_run:
            connector._require_exec_url()
        rows = connector.collect(args.attended, weeks)
        if args.dry_run:
            print(f"[cropster] DRY RUN — {len(rows)} row(s), NOTHING POSTED")
            _print_summary(rows)
            return
        result = connector.post(rows)
        print(f"[cropster] read {len(rows)} rows -> POST {result}")
    except BlockedError:
        sys.exit(2)
    except (ReconcileError, IngestError) as err:
        print(f"[cropster] ABORTED, nothing posted: {err}", file=sys.stderr)
        sys.exit(1)
    except Exception as err:  # noqa: BLE001 - timeouts / decode errors: abort tidily
        # Type name only: never header or body content.
        print(f"[cropster] ABORTED, nothing posted: {type(err).__name__}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
