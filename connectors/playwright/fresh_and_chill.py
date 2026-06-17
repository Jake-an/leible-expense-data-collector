"""
fresh_and_chill.py — Playwright connector for Fresh and Chill supplier portal.

Skeleton awaiting attended click-path mapping. The portal login URL, post-login DOM
markers (is_logged_in), and invoice table selectors will be discovered by Jake's
attended session and documented in docs/clickpath-fresh_and_chill.md.

Run with --attended first to establish a saved session:
    python connectors/playwright/fresh_and_chill.py --attended
"""

from __future__ import annotations

from playwright.sync_api import Page
from base_connector import BaseConnector, cli_main


class FreshAndChillConnector(BaseConnector):
    NAME = "fresh_and_chill"
    SOURCE = "fresh_and_chill"
    LOGIN_URL = ""  # TODO(attended-mapping): fill in after Jake's attended login

    def is_logged_in(self, page: Page) -> bool:
        """
        Check if the session is authenticated.

        TODO(attended-mapping): During the attended session, Jake will navigate
        the portal post-login and identify a DOM element (e.g., a button, nav link,
        profile widget) that only appears when logged in. Return True if that
        element is present; False otherwise.

        For now, return False to fail safe on unattended runs (requires attended
        re-auth if session expires).
        """
        # TODO(attended-mapping): replace with a real selector check
        # Example: return page.query_selector("button:has-text('Logout')") is not None
        return False

    def read_invoices(self, page: Page) -> list[dict]:
        """
        Navigate to the invoice/order list and extract rows.

        TODO(attended-mapping): During attended mapping, Jake will identify:
        - The URL or link to reach the invoice list page
        - The CSS selector for each row (e.g., table rows, list items)
        - The cell selectors within each row (date, total, invoice reference)

        The mapping will be documented in docs/clickpath-fresh_and_chill.md.
        This method will then:
        1. page.goto(...) to the invoice list
        2. Call self.read_table_rows(page, row_selector, cell_selectors)
        3. Map raw cells to {date (YYYY-MM-DD), total (float), invoice_ref (str)}

        For now, return an empty list with a placeholder.
        """
        # TODO(attended-mapping): Implement once click-path is mapped.
        # Pseudocode example (to be replaced with real selectors):
        #
        # page.goto("https://portal.freshandchill.com/invoices")
        # page.wait_for_selector("table tbody tr")
        # raw_rows = self.read_table_rows(
        #     page,
        #     row_selector="table tbody tr",
        #     cell_selectors={
        #         "date_text": "td:nth-child(1)",
        #         "total_text": "td:nth-child(3)",
        #         "invoice_ref_text": "td:nth-child(2)",
        #     }
        # )
        # invoices = []
        # for row in raw_rows:
        #     invoices.append({
        #         "date": row["date_text"],  # assumes YYYY-MM-DD already
        #         "total": float(row["total_text"].replace("$", "").replace(",", "")),
        #         "invoice_ref": row["invoice_ref_text"],
        #     })
        # return invoices
        #
        # See docs/clickpath-fresh_and_chill.md for the actual selectors.
        return []


if __name__ == "__main__":
    cli_main(FreshAndChillConnector)
