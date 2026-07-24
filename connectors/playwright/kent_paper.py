"""
Kent Paper portal connector skeleton for LEIBLE Expense Data Collector.

Kent Paper supplies paper products via a web portal. This skeleton awaits
attended click-path mapping (docs/clickpath-kent_paper.md) to fill in the
portal's login check and invoice list navigation.

First run:
    python connectors/playwright/kent_paper.py --attended

Unattended re-runs (with saved session):
    python connectors/playwright/kent_paper.py
"""

from base_connector import BaseConnector, cli_main
from playwright.sync_api import Page


class KentPaperConnector(BaseConnector):
    NAME = "kent_paper"
    SOURCE = "kent_paper"
    LOGIN_URL = (
        ""  # TODO(attended-mapping): fill in Kent Paper portal login URL after attended session
    )

    def is_logged_in(self, page: Page) -> bool:
        """Check if the saved session is still authenticated.

        TODO(attended-mapping):
          During attended login, identify the post-login indicator (e.g. a menu
          element, dashboard heading, or URL change). Then uncomment and fill in
          the selector below:

            # Example: check for the "Welcome" heading or account menu
            # return page.query_selector("selector_here") is not None

        For now, always return False so unattended runs fail safe to blocked
        and don't risk stale sessions.
        """
        return False

    def read_invoices(self, page: Page) -> list[dict]:
        """Navigate to the invoice list and extract rows.

        TODO(attended-mapping):
          1. Navigate to the invoice/order list page (e.g. page.goto(...))
          2. Use read_table_rows to extract raw cells from the invoice table
          3. Map each row to {date, total, invoice_ref, location?}

        Example approach (uncomment and adapt once click-path is known):

            # page.goto("<invoice-list-url>", wait_until="domcontentloaded")
            # raw_rows = self.read_table_rows(
            #     page,
            #     row_selector="table tbody tr",  # Select each invoice row
            #     cell_selectors={
            #         "date": "td:nth-child(1)",       # Raw date cell
            #         "invoice_ref": "td:nth-child(2)", # Invoice ID
            #         "total": "td:nth-child(3)",       # Amount
            #     }
            # )
            # invoices = []
            # for raw in raw_rows:
            #     invoices.append({
            #         "date": raw["date"],  # Assumed YYYY-MM-DD or converted
            #         "total": float(raw["total"].replace("$", "")),
            #         "invoice_ref": raw["invoice_ref"].strip(),
            #     })
            # return invoices

        See docs/clickpath-kent_paper.md for the full click-path mapping.
        """
        return []


if __name__ == "__main__":
    cli_main(KentPaperConnector)
