"""Ordermentum portal connector — Tuga Pastry + Butterboy.

Both suppliers sell through the same Ordermentum app, so one connector serves two
accounts. Each account has its own saved session (sessions/ordermentum_<acct>.json)
and stamps its canonical supplier name onto every row via the `supplier` field —
the GAS hub keys both under source `ordermentum` but resolves the name per row
(see Code.gs canonicalSupplier_).

Skeleton awaiting attended click-path mapping: LOGIN_URL and the
is_logged_in / read_invoices selectors are filled in after Jake's attended login
(record the path in docs/clickpath-ordermentum.md first).

Usage:
    python connectors/playwright/ordermentum.py --attended              # both accounts, headed
    python connectors/playwright/ordermentum.py --attended --account tuga
    python connectors/playwright/ordermentum.py                         # both, unattended
"""

from __future__ import annotations

import argparse
import sys

from playwright.sync_api import Page
from base_connector import BaseConnector, BlockedError

# account key → canonical supplier name (written to each row's `supplier`).
ACCOUNTS = {
    "tuga": "Tuga Pastry",
    "butterboy": "Butterboy",
}

LOGIN_URL = ""  # TODO(attended-mapping): Ordermentum login URL, filled after attended login


class OrdermentumConnector(BaseConnector):
    SOURCE = "ordermentum"
    LOGIN_URL = LOGIN_URL

    def __init__(self, account_key: str, exec_url: str | None = None):
        if account_key not in ACCOUNTS:
            raise ValueError(f"unknown Ordermentum account: {account_key}")
        self.account_key = account_key
        self.supplier_name = ACCOUNTS[account_key]
        # per-account session file: ordermentum_tuga.json / ordermentum_butterboy.json
        self.NAME = f"ordermentum_{account_key}"
        super().__init__(exec_url=exec_url)

    def is_logged_in(self, page: Page) -> bool:
        # TODO(attended-mapping): check a post-login Ordermentum landmark (e.g. the
        # account switcher or an orders nav link). Return False for now so unattended
        # runs fail safe to `blocked` until the selector is discovered.
        #   return page.query_selector("[data-testid='orders-nav']") is not None
        return False

    def read_invoices(self, page: Page) -> list[dict]:
        # TODO(attended-mapping): open the order/invoice list, read the table, and
        # map each raw record to {date, total, invoice_ref}. Stamp the account's
        # supplier name so the hub can tell Tuga from Butterboy.
        #
        # Intended implementation (sketch):
        #     raw = self.read_table_rows(page, row_selector=".order-row", cell_selectors={
        #         "date_str": ".order-date", "total_str": ".order-total", "ref": ".order-number",
        #     })
        #     return [{
        #         "date": parse_date(r["date_str"]),          # → YYYY-MM-DD
        #         "total": float(r["total_str"].lstrip("$").replace(",", "")),
        #         "invoice_ref": r["ref"],
        #         "supplier": self.supplier_name,
        #     } for r in raw]
        #
        # See docs/clickpath-ordermentum.md for discovered selectors.
        return []


def main() -> None:
    parser = argparse.ArgumentParser(description="Ordermentum connector (Tuga Pastry + Butterboy)")
    parser.add_argument("--attended", action="store_true",
                        help="headed first login; save session for later unattended runs")
    parser.add_argument("--account", choices=list(ACCOUNTS), default=None,
                        help="run a single account (default: all accounts)")
    args = parser.parse_args()

    account_keys = [args.account] if args.account else list(ACCOUNTS)
    exit_code = 0
    for key in account_keys:
        try:
            OrdermentumConnector(key).run(attended=args.attended)
        except BlockedError:
            exit_code = 2  # one account blocked; keep going, report at the end
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
