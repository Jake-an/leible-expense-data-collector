"""Food and Dairy Co portal connector — Playwright-based invoice scraper.

Skeleton awaiting attended click-path mapping. The portal requires browser login
with saved session reuse. Run with --attended to discover the login flow and DOM
selectors, then update this module with the real LOGIN_URL and is_logged_in/
read_invoices implementations.

Usage:
    python connectors/playwright/food_dairy_co.py --attended
    python connectors/playwright/food_dairy_co.py            # unattended (needs saved session)
"""

from playwright.sync_api import Page
from base_connector import BaseConnector, cli_main


class FoodDairyCoConnector(BaseConnector):
    """Food and Dairy Co portal scraper."""

    NAME = "food_dairy_co"
    SOURCE = "food_dairy_co"
    LOGIN_URL = ""  # TODO(attended-mapping): Fill in after attended login discovery

    def is_logged_in(self, page: Page) -> bool:
        """
        TODO(attended-mapping): During attended login, identify the post-login DOM
        landmark (e.g., account dropdown, logout link, dashboard heading) that
        proves the session is valid. Once identified, return a check like:

            return page.query_selector(".account-menu") is not None

        For now, return False to fail safe — unattended runs will be blocked
        until the landmark is discovered and this method is filled in.
        """
        return False

    def read_invoices(self, page: Page) -> list[dict]:
        """
        TODO(attended-mapping): Navigate to the invoice/order list page and map
        the table rows to the normalized contract: {date, total, invoice_ref}.

        Intended implementation (sketch):
            raw_rows = self.read_table_rows(
                page,
                row_selector=".invoice-row",  # CSS selector for each row
                cell_selectors={
                    "date_str": ".date-cell",
                    "total_str": ".total-cell",
                    "ref": ".invoice-id-cell",
                }
            )
            result = []
            for raw in raw_rows:
                result.append({
                    "date": parse_date(raw["date_str"]),  # → YYYY-MM-DD
                    "total": float(raw["total_str"]),
                    "invoice_ref": raw["ref"],
                })
            return result

        See docs/clickpath-food_dairy_co.md for discovered selectors.
        """
        return []


if __name__ == "__main__":
    cli_main(FoodDairyCoConnector)
