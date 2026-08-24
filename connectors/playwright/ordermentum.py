"""Ordermentum connector — API-first invoice reader.

One Ordermentum login covers all venues and suppliers. The connector:
  1. Loads saved cookies from sessions/ordermentum.json
  2. Extracts the Bearer JWT from the `session` cookie
  3. Hits the Ordermentum JSON API directly (no DOM scraping)
  4. Iterates active venues → suppliers → invoices
  5. POSTs to GAS doPost

Attended first login uses the base_connector flow (headed browser, Jake logs in,
cookies saved). All subsequent runs are API-only via the saved JWT.

Usage:
    python connectors/playwright/ordermentum.py --attended   # first login, saves session
    python connectors/playwright/ordermentum.py              # unattended API read
"""

from __future__ import annotations

import sys

from base_connector import BaseConnector, TransientLoginError, _form_login, cli_main, get_credential
from playwright.sync_api import Page

API_BASE = "https://app.ordermentum.com"

# Only pull invoices from these suppliers (case-insensitive substring match,
# tested against BOTH the legal name and the Ordermentum tradingName).
# NB: some suppliers bill under an unrelated legal entity — e.g. Butterboy
# invoices as "Wholesale Cookies PTY LTD" (tradingName "Butterboy"), so matching
# the legal name alone silently drops them. Keep keywords aligned to a name the
# supplier actually shows: "allie" (not "alie") matches "Allie's Foods".
SUPPLIER_FILTER = [
    "tuga",
    "allie",
    "butterboy",
    "fuel",
]

# retailer_id → canonical shop name (for the `location` column).
#
# These are Ordermentum RETAILER ids, which are legal entities, not shopfronts —
# that is why they read as company names and not "Leible North".
#
# 5 Blue St North Sydney has TWO retailer accounts and only one of them is live:
#
#   5dc2803b-…  'Apex international group pty ltd'      created 2022-05-30  DEAD
#               tradingName 'Leible coffee blue street - North Sydney'
#   2476a89b-…  'LEGEND STAR INVESTMENTS PTY LTD'       created 2025-03-23  LIVE
#               tradingName 'Leible Coffee North Sydney Blue'
#
# Both carry a 5 Blue St North Sydney delivery address, so the names cannot tell
# them apart. This mapping pointed at Apex, which has **zero** SUPPLIER_FILTER
# suppliers — so North produced no rows at all, for any supplier, ever, while
# the other three shops looked perfectly healthy. Measured 2026-08-24: at least
# $11,931.92 of real North spend never reached the Sheet (Fuel Bakery, Tuga,
# Allie's Foods). Jake confirmed the two-account situation the same day.
#
# Corroboration from a different source: Mayers' North Sydney invoices bill to
# "LEIBLE COFFEE NORTH SYDNEY LEGEND STAR INVESTMENTS PTY LTD 5 BLUES ST".
#
# Verify a change here with connectors/playwright/ordermentum.py --list-venues,
# which prints every retailer this login owns and how many of its suppliers
# match SUPPLIER_FILTER. Do not hand-edit an id from the Ordermentum URL bar.
VENUES = {
    "73cb4dc6-bc70-431c-bfad-186f05e8851b": "Leible York",  # KAFFAPRO PTY LTD
    "c2942ee1-acb5-45a1-b8df-72c5e5f03aa3": "Leible Pitt",  # MZCOFFEE PTY LTD
    "73904d83-094a-4764-9da9-cfa61231001c": "Leible Crowsnest",  # LEIBLE COFFEE ROASTERS PTY LTD
    "2476a89b-060e-4308-9a18-558bbf475782": "Leible North",  # LEGEND STAR INVESTMENTS PTY LTD
}

# Retailer ids that are known-dead and must never be re-added. Without this the
# next person reading an old commit, or an Ordermentum export, puts Apex back.
RETIRED_VENUES = {
    "5dc2803b-51e2-4415-8484-edb4cdf40517": (
        "Apex international group pty ltd — the OLD North Sydney account, "
        "superseded by LEGEND STAR INVESTMENTS PTY LTD (2476a89b-…). "
        "It still resolves and still returns HTTP 200, it just has no bakery "
        "suppliers, so using it fails silently."
    ),
}

# /v2/invoices is paginated at 25/page and the connector used to request page 1
# only, dropping everything older with no warning. Measured 2026-08-24: Tuga at
# the North venue has 437 invoices across 18 pages, Fuel Bakery 53 across 3.
# That never showed up in the weekly figures because the sort is newest-first
# and a weekly run only needs the newest few — it bites a backfill, or any
# recovery after an outage, which is exactly when the data matters most.
INVOICE_PAGE_LIMIT = 40  # runaway guard; 40 * 25 = 1000 invoices per venue+supplier


class OrdermentumConnector(BaseConnector):
    NAME = "ordermentum"
    SOURCE = "ordermentum"
    LOGIN_URL = "https://app.ordermentum.com"

    def is_logged_in(self, page: Page) -> bool:
        resp = page.request.get(f"{API_BASE}/v1/profiles/")
        return resp.status == 200

    def auth_state(self, page: Page) -> str:
        """'ok' (200) / 'dead' (401/403 — auth genuinely rejected) /
        'transient' (any other status, or the probe request itself throwing
        on a network failure — page.request.get raises rather than
        returning a response object on e.g. DNS/connection errors)."""
        try:
            resp = page.request.get(f"{API_BASE}/v1/profiles/")
        except Exception as err:
            print(f"[{self.NAME}] auth probe network error (transient): {err}")
            return "transient"
        if resp.status == 200:
            return "ok"
        if resp.status in (401, 403):
            return "dead"
        return "transient"

    # Ordermentum auth is an async SPA XHR: after submit the session cookie
    # lands ~1s later, so is_logged_in() probed immediately reads 401 and a
    # correct password looks "rejected" (proven live 2026-07-20: profiles=401 at
    # t+0s → 200 at t+1s, url→/dashboard). Poll the success signal before
    # concluding rejection.
    LOGIN_SETTLE_TRIES = 15  # ~15s max (1s apart)

    def credentials_login(self, page: Page) -> bool:
        """Headless email/password login via the Phase-1 mapped selectors
        (docs/clickpath-ordermentum.md). Raises TransientLoginError if the
        form never loads; otherwise polls is_logged_in() for up to
        LOGIN_SETTLE_TRIES seconds (SPA auth is async) and returns whether it
        passes — a genuinely rejected password stays 401 for the whole window
        and returns False (not an exception)."""
        email = get_credential("ORDERMENTUM_EMAIL")
        password = get_credential("ORDERMENTUM_PASSWORD")
        if not email or not password:
            raise TransientLoginError(
                "ORDERMENTUM_EMAIL/ORDERMENTUM_PASSWORD missing at attempt time"
            )
        _form_login(
            page,
            self.LOGIN_URL,
            email,
            password,
            email_sel="input[name='email']",
            password_sel="input[name='password']",
            submit_sel="button[type='submit']",
        )
        for _ in range(self.LOGIN_SETTLE_TRIES):
            if self.is_logged_in(page):
                return True
            page.wait_for_timeout(1000)
        return False

    def read_invoices(self, page: Page) -> list[dict]:
        rows: list[dict] = []
        barren: list[str] = []

        for venue_id, shop in VENUES.items():
            if venue_id in RETIRED_VENUES:
                raise ValueError(
                    f"VENUES maps {shop!r} to retired retailer {venue_id}: "
                    f"{RETIRED_VENUES[venue_id]}"
                )
            suppliers = self._get_suppliers(page, venue_id)
            for sid, sname in suppliers:
                invoices = self._get_invoices(page, venue_id, sid)
                for inv in invoices:
                    if inv.get("cancelled"):
                        continue
                    rows.append(
                        {
                            "date": inv["date"][:10],
                            "total": inv["total"],
                            "invoice_ref": inv["number"],
                            "supplier": sname,
                            "location": shop,
                        }
                    )
            print(f"  [{self.NAME}] {shop}: {len(suppliers)} suppliers")
            if not suppliers:
                barren.append(shop)

        # A venue with no matching suppliers is indistinguishable from a venue
        # that is simply quiet — which is precisely how the wrong North Sydney
        # retailer id survived for months while three shops looked healthy.
        # Every configured venue is there BECAUSE it orders; if one stops
        # returning suppliers, that is a broken mapping or a revoked permission,
        # not a quiet week. Say so loudly rather than posting a short payload.
        if barren:
            print(
                f"  [{self.NAME}] WARNING: {len(barren)} configured venue(s) returned NO "
                f"matching suppliers: {', '.join(barren)}. Every venue in VENUES is there "
                f"because it orders — a zero here means a stale retailer id, a revoked "
                f"permission, or a supplier renamed out of SUPPLIER_FILTER. "
                f"Run with --list-venues to see the live retailer list.",
                file=sys.stderr,
            )
        return rows

    def _get_suppliers(self, page: Page, venue_id: str) -> list[tuple[str, str]]:
        resp = page.request.get(
            f"{API_BASE}/v2/marketplaces",
            params={"retailerId": venue_id, "disabled": "false"},
        )
        if resp.status != 200:
            print(
                f"  [{self.NAME}] WARNING: marketplaces returned {resp.status} for venue {venue_id}"
            )
            return []
        data = resp.json().get("data", [])
        out: list[tuple[str, str]] = []
        for m in data:
            sid = m["supplierId"]
            supplier = m.get("supplier", {})
            legal = supplier.get("name", "")
            trading = supplier.get("tradingName") or ""
            haystack = f"{legal} {trading}".lower()
            if any(kw in haystack for kw in SUPPLIER_FILTER):
                # Prefer the tradingName as the Sheet label — it's the recognisable
                # name (e.g. "Butterboy", not "Wholesale Cookies PTY LTD").
                out.append((sid, (trading or legal).strip()))
        return out

    def _get_invoices(self, page: Page, venue_id: str, supplier_id: str) -> list[dict]:
        """Every invoice for this venue+supplier, following pagination.

        The response carries meta.totalPages; requesting page 1 alone silently
        truncated at 25 invoices (see INVOICE_PAGE_LIMIT). Because the sort is
        newest-first, a weekly run never noticed — it only needs the newest few
        — so the loss was invisible until a backfill needed the history.

        A mid-way page failure returns what was collected so far rather than
        discarding it: a partial read is still real invoices, and doPost dedups
        on source+invoice_ref, so the next run fills the gap.
        """
        out: list[dict] = []
        page_no = 1
        total_pages = 1

        while page_no <= total_pages and page_no <= INVOICE_PAGE_LIMIT:
            resp = page.request.get(
                f"{API_BASE}/v2/invoices",
                params={
                    "supplierId": supplier_id,
                    "retailerId": venue_id,
                    "sortBy[dueAt]": "-1",
                    "pageNo": str(page_no),
                },
            )
            if resp.status != 200:
                print(
                    f"  [{self.NAME}] WARNING: invoices returned {resp.status} "
                    f"on page {page_no} — keeping the {len(out)} invoice(s) read so far"
                )
                return out

            body = resp.json()
            out.extend(body.get("data", []))

            meta = body.get("meta") or {}
            reported = meta.get("totalPages")
            if not isinstance(reported, int) or reported < 1:
                # No usable meta: stop after this page rather than guess. Old
                # behaviour, so this can only ever match what we had before.
                break
            total_pages = reported
            page_no += 1

        if total_pages > INVOICE_PAGE_LIMIT:
            print(
                f"  [{self.NAME}] WARNING: supplier {supplier_id} at venue {venue_id} "
                f"reports {total_pages} pages, over the INVOICE_PAGE_LIMIT of "
                f"{INVOICE_PAGE_LIMIT} — read {len(out)} invoice(s), OLDEST ONES SKIPPED",
                file=sys.stderr,
            )
        return out


def list_venues() -> None:
    """Print every retailer this login owns, and how many of each one's suppliers
    match SUPPLIER_FILTER. Read-only.

    This is the check that settles a VENUES edit. A retailer id copied from the
    Ordermentum URL bar looks identical to a correct one and fails silently — an
    id can be live, return HTTP 200, and still be the wrong company. The
    supplier count is the signal: a shop that orders shows a non-zero count.

    Usage:  python connectors/playwright/ordermentum.py --list-venues
    """
    from pathlib import Path

    from playwright.sync_api import sync_playwright

    session = Path(__file__).resolve().parents[2] / "sessions" / "ordermentum.json"
    if not session.exists():
        print(f"no saved session at {session} — run with --attended first", file=sys.stderr)
        raise SystemExit(2)

    # Keyed by retailer id, the same thing the loop below iterates. Inverting it
    # to shop-name keys makes every `rid in known` test false, so the whole
    # "which of these is mapped?" column silently disappears — which is the one
    # question this diagnostic exists to answer.
    known = dict(VENUES)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page = browser.new_context(storage_state=str(session)).new_page()

        probe = page.request.get(f"{API_BASE}/v1/profiles/")
        if probe.status != 200:
            print(f"session is dead (profiles -> {probe.status}); run --attended", file=sys.stderr)
            browser.close()
            raise SystemExit(2)

        resp = page.request.get(f"{API_BASE}/v1/retailers")
        retailers = resp.json().get("data", resp.json())
        print(f"{len(retailers)} retailer account(s) visible to this login:\n")
        for r in retailers:
            rid, name = r.get("id"), r.get("name")
            trading = r.get("tradingName") or ""
            mark = f"  <== VENUES[{known[rid]!r}]" if rid in known else ""
            if rid in RETIRED_VENUES:
                mark = "  <== RETIRED, do not use"
            print(f"  {rid}  {name!r}")
            if trading:
                print(
                    f"      tradingName: {trading!r}{mark}"
                    if mark
                    else f"      tradingName: {trading!r}"
                )
            elif mark:
                print(f"     {mark}")

            m = page.request.get(
                f"{API_BASE}/v2/marketplaces", params={"retailerId": rid, "disabled": "false"}
            )
            if m.status != 200:
                print(f"      marketplaces -> HTTP {m.status}\n")
                continue
            data = m.json().get("data", [])
            matched = []
            for entry in data:
                s = entry.get("supplier", {})
                hay = f"{s.get('name', '')} {s.get('tradingName') or ''}".lower()
                if any(kw in hay for kw in SUPPLIER_FILTER):
                    matched.append((s.get("tradingName") or s.get("name") or "?").strip())
            print(
                f"      {len(data)} supplier(s); {len(matched)} match SUPPLIER_FILTER: {sorted(matched)}\n"
            )
        browser.close()


if __name__ == "__main__":
    # Handled here rather than in cli_main: this is an Ordermentum-specific
    # diagnostic and does not belong on every connector's CLI.
    if "--list-venues" in sys.argv:
        list_venues()
    else:
        cli_main(OrdermentumConnector)
