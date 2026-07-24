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

# Active venues Jake confirmed 2026-06-18.
# venue_id → canonical shop name (for the `location` column).
VENUES = {
    "73cb4dc6-bc70-431c-bfad-186f05e8851b": "Leible York",
    "c2942ee1-acb5-45a1-b8df-72c5e5f03aa3": "Leible Pitt",
    "73904d83-094a-4764-9da9-cfa61231001c": "Leible Crowsnest",
    "5dc2803b-51e2-4415-8484-edb4cdf40517": "Leible North",
}


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
        for venue_id, shop in VENUES.items():
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
        resp = page.request.get(
            f"{API_BASE}/v2/invoices",
            params={
                "supplierId": supplier_id,
                "retailerId": venue_id,
                "sortBy[dueAt]": "-1",
                "pageNo": "1",
            },
        )
        if resp.status != 200:
            print(f"  [{self.NAME}] WARNING: invoices returned {resp.status}")
            return []
        return resp.json().get("data", [])


if __name__ == "__main__":
    cli_main(OrdermentumConnector)
