"""Fresh and Chill connector — Zupply (shop.zupply.com.au) order scraper.

Fresh & Chill uses Zupply Chef, a Rails/Devise app with plain user+password auth.
One separate Zupply account per Leible shop (4 total). The connector maintains a
saved session per shop and loops all 4 on unattended runs.

Orders page at /orders is a server-rendered HTML table (no JSON API). Columns:
  Order (supplier + PO#) | Order Date | Delivery Date | Total | Service Fee | Total Charged

Usage:
    python connectors/playwright/fresh_and_chill.py --attended --shop york
    python connectors/playwright/fresh_and_chill.py --attended --shop north
    python connectors/playwright/fresh_and_chill.py --attended --shop crowsnest
    python connectors/playwright/fresh_and_chill.py --attended --shop pitt
    python connectors/playwright/fresh_and_chill.py              # unattended, all shops
"""

from __future__ import annotations

import argparse
import re
import sys
import time
from datetime import datetime

from playwright.sync_api import sync_playwright, Page, BrowserContext

from base_connector import BaseConnector, BlockedError, SESSIONS_DIR, SYD_TZ

SHOPS = {
    "york": "Leible York",
    "north": "Leible North",
    "crowsnest": "Leible Crowsnest",
    "pitt": "Leible Pitt",
}


class FreshAndChillConnector(BaseConnector):
    NAME = "fresh_and_chill"
    SOURCE = "fresh_and_chill"
    LOGIN_URL = "https://shop.zupply.com.au/users/sign_in"

    def __init__(self, exec_url: str | None = None):
        super().__init__(exec_url)

    def _session_path(self, shop_key: str):
        return SESSIONS_DIR / f"fresh_and_chill_{shop_key}.json"

    def is_logged_in(self, page: Page) -> bool:
        return page.query_selector("a[href='/orders']") is not None

    def read_invoices(self, page: Page) -> list[dict]:
        raise NotImplementedError("Use read_shop_invoices with location param")

    def read_shop_invoices(self, page: Page, location: str) -> list[dict]:
        """Scrape all order pages for a single shop, return normalized rows."""
        rows: list[dict] = []
        page_num = 1

        while True:
            url = "https://shop.zupply.com.au/orders"
            if page_num > 1:
                url += f"?page={page_num}"
            page.goto(url, wait_until="domcontentloaded")
            page.wait_for_selector("table", timeout=15000)

            table_rows = page.query_selector_all("table tbody tr")
            if not table_rows:
                break

            for tr in table_rows:
                cells = tr.query_selector_all("td")
                if len(cells) < 4:
                    continue

                po_text = cells[0].inner_text().strip()
                po_match = re.search(r"PO#(\d+)", po_text)
                if not po_match:
                    continue
                invoice_ref = f"PO#{po_match.group(1)}"

                delivery_text = cells[2].inner_text().strip()
                date_match = re.match(r"(\d{2}/\d{2}/\d{4})", delivery_text)
                if not date_match:
                    continue
                date_str = datetime.strptime(date_match.group(1), "%d/%m/%Y").strftime("%Y-%m-%d")

                total_text = cells[3].inner_text().strip()
                total_match = re.search(r"\$([\d,]+\.\d{2})", total_text)
                if not total_match:
                    continue
                total = float(total_match.group(1).replace(",", ""))

                rows.append({
                    "date": date_str,
                    "total": total,
                    "invoice_ref": invoice_ref,
                    "location": location,
                })

            has_next = page.query_selector(f"a[href*='page={page_num + 1}']")
            if not has_next:
                break
            page_num += 1

        return rows

    def run_attended(self, shop_key: str, wait_seconds: int = 300) -> None:
        """Headed login for a single shop. Polls until logged in (no Enter needed),
        then auto-saves the session. Times out after wait_seconds."""
        location = SHOPS[shop_key]
        session_path = self._session_path(shop_key)
        SESSIONS_DIR.mkdir(exist_ok=True)

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=False)
            context = browser.new_context()
            page = context.new_page()
            page.goto(self.LOGIN_URL, wait_until="domcontentloaded")

            print(
                f"\n[{self.NAME}] ATTENDED LOGIN — {location}\n"
                f"  A browser window is open at {self.LOGIN_URL}.\n"
                f"  Log in with the {location} account. The session saves automatically\n"
                f"  once you reach the orders page (no Enter needed). Waiting up to {wait_seconds}s...\n"
            )

            deadline = time.time() + wait_seconds
            while time.time() < deadline:
                if self.is_logged_in(page):
                    context.storage_state(path=str(session_path))
                    print(f"[{self.NAME}] Logged in — session saved: {session_path}")
                    context.close()
                    browser.close()
                    return
                page.wait_for_timeout(2000)

            print(f"[{self.NAME}] ERROR: timed out waiting for login", file=sys.stderr)
            context.close()
            browser.close()
            sys.exit(2)

    def run_unattended(self) -> dict:
        """Loop all shops, scrape orders, POST combined rows."""
        self._require_exec_url()
        SESSIONS_DIR.mkdir(exist_ok=True)
        all_rows: list[dict] = []
        blocked_shops: list[str] = []

        with sync_playwright() as pw:
            for shop_key, location in SHOPS.items():
                session_path = self._session_path(shop_key)
                if not session_path.exists():
                    print(f"[{self.NAME}] {location}: no session file, skipping (run --attended --shop {shop_key})")
                    blocked_shops.append(location)
                    continue

                browser = pw.chromium.launch(headless=True)
                context = browser.new_context(storage_state=str(session_path))
                page = context.new_page()
                page.goto("https://shop.zupply.com.au/orders", wait_until="domcontentloaded")

                if not self.is_logged_in(page):
                    print(f"[{self.NAME}] {location}: session expired, BLOCKED")
                    blocked_shops.append(location)
                    context.close()
                    browser.close()
                    continue

                rows = self.read_shop_invoices(page, location)
                context.storage_state(path=str(session_path))
                context.close()
                browser.close()
                print(f"  [{self.NAME}] {location}: {len(rows)} orders")
                all_rows.extend(rows)

        if blocked_shops and not all_rows:
            self.mark_blocked(f"all shops blocked: {', '.join(blocked_shops)}")

        result = self.post(all_rows)
        if blocked_shops:
            print(f"[{self.NAME}] WARNING: blocked shops: {', '.join(blocked_shops)}")
        print(f"[{self.NAME}] total {len(all_rows)} rows -> POST {result}")
        return {"rows": len(all_rows), "blocked": blocked_shops, "post": result}


def main():
    parser = argparse.ArgumentParser(description="Fresh and Chill (Zupply) connector")
    parser.add_argument("--attended", action="store_true",
                        help="Headed login for a single shop; saves session")
    parser.add_argument("--shop", choices=list(SHOPS.keys()),
                        help="Shop to log into (required with --attended)")
    args = parser.parse_args()

    connector = FreshAndChillConnector()

    if args.attended:
        if not args.shop:
            print("ERROR: --attended requires --shop <york|north|crowsnest|pitt>", file=sys.stderr)
            sys.exit(1)
        connector.run_attended(args.shop)
    else:
        try:
            connector.run_unattended()
        except BlockedError:
            sys.exit(2)


if __name__ == "__main__":
    main()
