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

import json
import re
from playwright.sync_api import Page

from base_connector import BaseConnector, cli_main

API_BASE = "https://app.ordermentum.com"

# Only pull invoices from these suppliers (case-insensitive substring match).
SUPPLIER_FILTER = [
    "tuga",
    "alie",
    "butterboy",
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

    def read_invoices(self, page: Page) -> list[dict]:
        rows: list[dict] = []
        for venue_id, shop in VENUES.items():
            suppliers = self._get_suppliers(page, venue_id)
            for sid, sname in suppliers:
                invoices = self._get_invoices(page, venue_id, sid)
                for inv in invoices:
                    if inv.get("cancelled"):
                        continue
                    rows.append({
                        "date": inv["date"][:10],
                        "total": inv["total"],
                        "invoice_ref": inv["number"],
                        "supplier": sname,
                        "location": shop,
                    })
            print(f"  [{self.NAME}] {shop}: {len(suppliers)} suppliers")
        return rows

    def _get_suppliers(self, page: Page, venue_id: str) -> list[tuple[str, str]]:
        resp = page.request.get(
            f"{API_BASE}/v2/marketplaces",
            params={"retailerId": venue_id, "disabled": "false"},
        )
        if resp.status != 200:
            print(f"  [{self.NAME}] WARNING: marketplaces returned {resp.status} for venue {venue_id}")
            return []
        data = resp.json().get("data", [])
        all_suppliers = [(m["supplierId"], m["supplier"]["name"]) for m in data]
        return [
            (sid, name) for sid, name in all_suppliers
            if any(kw in name.lower() for kw in SUPPLIER_FILTER)
        ]

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
