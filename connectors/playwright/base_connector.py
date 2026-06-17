"""
base_connector.py — shared Playwright logic for LEIBLE portal connectors.

Every supplier portal connector subclasses BaseConnector and fills in four
portal-specific hooks (LOGIN_URL, is_logged_in, read_invoices, plus NAME/SOURCE).
The base handles the parts that are identical across portals:

  * session persistence  — saved storage_state in sessions/<name>.json
  * attended first login  — headed browser, wait for Jake to clear MFA/CAPTCHA
  * unattended re-runs    — load saved session, skip login
  * fail-safe blocking    — if not logged in on an unattended run, mark blocked
  * POST to GAS           — build the bridge contract and send to doPost

Rules this enforces (see docs/rules.md): never bypass MFA/CAPTCHA (Jake clears
them in the attended window); session-first; fail safe to `blocked`.

Run a connector:
    python connectors/playwright/<name>.py            # unattended (needs saved session)
    python connectors/playwright/<name>.py --attended # headed first login, saves session

The GAS web-app URL is read from the GAS_EXEC_URL environment variable.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

import requests
from playwright.sync_api import sync_playwright, Page, BrowserContext

# Repo root = two levels up from this file (connectors/playwright/).
REPO_ROOT = Path(__file__).resolve().parents[2]
SESSIONS_DIR = REPO_ROOT / "sessions"

# Australia/Sydney offset for extracted_at stamps. Australia observes DST; this is
# a fixed +10:00 for simplicity — refine if exact AEDT stamping ever matters.
SYD_TZ = timezone(timedelta(hours=10))


class BlockedError(Exception):
    """Raised when a connector cannot proceed without human re-auth."""


class BaseConnector:
    # --- subclasses MUST override these ---
    NAME: str = "base"            # session filename + log label
    SOURCE: str = "base"          # POST `source` field (and Suppliers dedup namespace)
    LOGIN_URL: str = ""           # portal login / landing URL

    def __init__(self, exec_url: str | None = None):
        self.exec_url = exec_url or os.environ.get("GAS_EXEC_URL", "")
        self.session_path = SESSIONS_DIR / f"{self.NAME}.json"

    # ------------------------------------------------------------------ #
    # Portal-specific hooks — override in subclasses
    # ------------------------------------------------------------------ #
    def is_logged_in(self, page: Page) -> bool:
        """Return True if the saved session is still authenticated."""
        raise NotImplementedError

    def read_invoices(self, page: Page) -> list[dict]:
        """Navigate the invoice/order list and return rows:
        [{date: 'YYYY-MM-DD', total: float, invoice_ref: str, location?: str}, ...]
        """
        raise NotImplementedError

    # ------------------------------------------------------------------ #
    # Shared orchestration
    # ------------------------------------------------------------------ #
    def run(self, attended: bool = False) -> dict:
        SESSIONS_DIR.mkdir(exist_ok=True)
        with sync_playwright() as pw:
            context = self._new_context(pw, headed=attended)
            page = context.new_page()
            page.goto(self.LOGIN_URL, wait_until="domcontentloaded")

            if not self.is_logged_in(page):
                if attended:
                    self._attended_login(page)
                    context.storage_state(path=str(self.session_path))
                else:
                    self.mark_blocked("not logged in and no valid session; run with --attended")

            rows = self.read_invoices(page)
            # Persist refreshed cookies after a successful unattended read too.
            context.storage_state(path=str(self.session_path))
            context.close()

        result = self.post(rows)
        print(f"[{self.NAME}] read {len(rows)} rows → POST {result}")
        return {"rows": len(rows), "post": result}

    def _new_context(self, pw, headed: bool) -> BrowserContext:
        browser = pw.chromium.launch(headless=not headed)
        if self.session_path.exists():
            return browser.new_context(storage_state=str(self.session_path))
        return browser.new_context()

    def _attended_login(self, page: Page) -> None:
        print(
            f"\n[{self.NAME}] ATTENDED LOGIN REQUIRED\n"
            f"  A browser window is open at {self.LOGIN_URL}.\n"
            f"  Log in and clear any MFA/CAPTCHA, then return here and press Enter.\n"
        )
        input("  Press Enter once you are fully logged in... ")
        if not self.is_logged_in(page):
            self.mark_blocked("still not logged in after attended login")

    def post(self, rows: list[dict]) -> dict:
        if not rows:
            return {"result": "skipped", "reason": "no rows"}
        if not self.exec_url:
            raise RuntimeError("GAS_EXEC_URL not set — cannot POST to the hub")
        payload = {
            "source": self.SOURCE,
            "rows": rows,
            "extracted_at": datetime.now(SYD_TZ).isoformat(timespec="seconds"),
        }
        resp = requests.post(self.exec_url, json=payload, timeout=60)
        resp.raise_for_status()
        try:
            return resp.json()
        except ValueError:
            return {"result": "ok", "raw": resp.text[:200]}

    def mark_blocked(self, reason: str) -> None:
        print(f"[{self.NAME}] BLOCKED: {reason}", file=sys.stderr)
        raise BlockedError(reason)

    # ------------------------------------------------------------------ #
    # Small DOM helper shared by skeletons
    # ------------------------------------------------------------------ #
    @staticmethod
    def read_table_rows(page: Page, row_selector: str, cell_selectors: dict[str, str]) -> list[dict]:
        """Generic: for each element matching row_selector, pull one field per
        cell_selectors entry (field name → CSS/text selector relative to the row).
        Subclasses still map raw cells → the {date,total,invoice_ref} contract.
        """
        out: list[dict] = []
        for row in page.query_selector_all(row_selector):
            record: dict[str, str] = {}
            for field, sel in cell_selectors.items():
                el = row.query_selector(sel)
                record[field] = (el.inner_text().strip() if el else "")
            out.append(record)
        return out


def cli_main(connector_cls) -> None:
    """Standard CLI entry shared by every connector module."""
    parser = argparse.ArgumentParser(description=f"{connector_cls.NAME} portal connector")
    parser.add_argument("--attended", action="store_true",
                        help="headed first login; save session for later unattended runs")
    args = parser.parse_args()
    try:
        connector_cls().run(attended=args.attended)
    except BlockedError:
        sys.exit(2)
