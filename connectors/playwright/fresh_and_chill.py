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

from base_connector import (
    SESSIONS_DIR,
    BaseConnector,
    BlockedError,
    TransientLoginError,
    _breaker_tripped,
    _clear_breaker,
    _clear_breaker_with_warning,
    _form_login,
    _trip_breaker,
    get_credential,
)
from playwright.sync_api import Page, sync_playwright

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

    # Devise (server-rendered) redirects on submit, so a race is less likely
    # than Ordermentum's async SPA XHR — but poll defensively/uniformly
    # anyway rather than checking once, in case a shop's redirect or
    # session-cookie write lags the initial page settle.
    LOGIN_SETTLE_TRIES = 15  # ~15s max (1s apart), matches ordermentum.py

    def is_logged_in(self, page: Page) -> bool:
        return page.query_selector("a[href='/orders']") is not None

    def _classify_shop_state(self, page: Page) -> str:
        """'ok' | 'dead' | 'transient' for a shop's /orders load.

        F&C has no status-code auth signal (is_logged_in is DOM-only) and
        run_unattended never passes through base run()/auth_state(), so this
        classifier lives here instead. 'dead' = redirected to
        /users/sign_in OR the Devise sign-in form is present (genuine
        auth-death — safe to auto-login). Anything else non-/orders
        (500 / error / partial load) = 'transient' — do NOT attempt login,
        keep the shop in blocked_shops, breaker untouched.
        """
        if self.is_logged_in(page):
            return "ok"
        if "/users/sign_in" in page.url:
            return "dead"
        if page.query_selector("input[type='email']") and page.query_selector(
            "input[type='password']"
        ):
            return "dead"
        return "transient"

    def _auto_login_shop(self, page: Page, shop_key: str) -> bool:
        """Headless auto-login for one shop — called only when
        _classify_shop_state() returns 'dead'. Returns True on success
        (session saved, breaker cleared); False on any non-success path
        (breaker tripped / no creds / credentials rejected). Never raises
        BlockedError itself — the per-shop loop in run_unattended must stay
        partial-success-safe (one blocked shop doesn't kill the others).
        TransientLoginError from _form_login is a second-line guard here,
        not the primary transient/dead decision (that's _classify_shop_state).
        """
        location = SHOPS[shop_key]
        key = f"fresh_and_chill_{shop_key}"
        session_path = self._session_path(shop_key)

        if _breaker_tripped(key):
            print(
                f"[{self.NAME}] {location}: auto-login breaker tripped, skipping "
                f"(run --attended --shop {shop_key})"
            )
            return False

        email = get_credential(f"FRESH_AND_CHILL_{shop_key.upper()}_EMAIL")
        password = get_credential(f"FRESH_AND_CHILL_{shop_key.upper()}_PASSWORD")
        if not email or not password:
            print(f"[{self.NAME}] {location}: no credentials in .env, skipping auto-login")
            return False

        try:
            # Zupply is Rails/Devise: the login field is a TEXT input named
            # user[login] (id user_login) — not type=email — and the submit is
            # an <input type=submit name=commit value="Log in">, not a <button>.
            # Mapped live 2026-07-20 (docs/clickpath-fresh_and_chill.md).
            _form_login(
                page,
                self.LOGIN_URL,
                email,
                password,
                email_sel="#user_login",
                password_sel="#user_password",
                submit_sel="input[name='commit']",
            )
        except TransientLoginError as err:
            print(f"[{self.NAME}] {location}: auto-login could not be attempted (transient): {err}")
            return False

        # Poll rather than check once — same defensive pattern as
        # ordermentum.py's SPA poll (docs/clickpath-ordermentum.md), applied
        # here for uniformity even though Devise's server-rendered redirect
        # is less race-prone than an async SPA XHR.
        for _ in range(self.LOGIN_SETTLE_TRIES):
            if self.is_logged_in(page):
                page.context.storage_state(path=str(session_path))
                _clear_breaker(key)
                print(f"[{self.NAME}] {location}: auto-login succeeded, session saved")
                return True
            page.wait_for_timeout(1000)

        _trip_breaker(key, "credentials rejected or login incomplete")
        print(
            f"[{self.NAME}] {location}: auto-login failed — credentials rejected; breaker tripped"
        )
        return False

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

                rows.append(
                    {
                        "date": date_str,
                        "total": total,
                        "invoice_ref": invoice_ref,
                        "location": location,
                    }
                )

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
                    _clear_breaker_with_warning(
                        self.NAME,
                        f"fresh_and_chill_{shop_key}",
                        f"FRESH_AND_CHILL_{shop_key.upper()}_EMAIL",
                        f"FRESH_AND_CHILL_{shop_key.upper()}_PASSWORD",
                    )
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
                    print(
                        f"[{self.NAME}] {location}: no session file, skipping (run --attended --shop {shop_key})"
                    )
                    blocked_shops.append(location)
                    continue

                browser = pw.chromium.launch(headless=True)
                context = browser.new_context(storage_state=str(session_path))
                page = context.new_page()

                # Everything from here (including the post-auto-login reload
                # and read_shop_invoices, which can raise — e.g. its own
                # wait_for_selector("table") timeout) is wrapped so a single
                # shop's failure can't abort the whole for-loop; other shops
                # must still run and POST. context/browser always close via
                # finally, on every path (success, blocked, or error).
                try:
                    page.goto("https://shop.zupply.com.au/orders", wait_until="domcontentloaded")

                    if not self.is_logged_in(page):
                        state = self._classify_shop_state(page)
                        if state == "dead" and self._auto_login_shop(page, shop_key):
                            # Auto-login succeeded — reload /orders with the fresh session.
                            page.goto(
                                "https://shop.zupply.com.au/orders", wait_until="domcontentloaded"
                            )
                        else:
                            reason = (
                                "session expired, auto-login failed"
                                if state == "dead"
                                else f"session {state}"
                            )
                            print(f"[{self.NAME}] {location}: {reason}, BLOCKED")
                            blocked_shops.append(location)
                            continue

                    rows = self.read_shop_invoices(page, location)
                    context.storage_state(path=str(session_path))
                except Exception as err:
                    print(
                        f"[{self.NAME}] {location}: error reading orders, BLOCKED: {err}",
                        file=sys.stderr,
                    )
                    blocked_shops.append(location)
                    continue
                finally:
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
    parser.add_argument(
        "--attended", action="store_true", help="Headed login for a single shop; saves session"
    )
    parser.add_argument(
        "--shop",
        choices=list(SHOPS.keys()),
        help="Shop to log into (required with --attended and --clear-breaker)",
    )
    parser.add_argument(
        "--clear-breaker",
        action="store_true",
        help="clear one shop's auto-login circuit-breaker without a full attended "
        "login (requires --shop; use after fixing a .env typo)",
    )
    args = parser.parse_args()

    if args.clear_breaker:
        if not args.shop:
            print(
                "ERROR: --clear-breaker requires --shop <york|north|crowsnest|pitt>",
                file=sys.stderr,
            )
            sys.exit(1)
        _clear_breaker(f"fresh_and_chill_{args.shop}")
        print(f"[fresh_and_chill] auto-login breaker cleared for {SHOPS[args.shop]}")
        return

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
