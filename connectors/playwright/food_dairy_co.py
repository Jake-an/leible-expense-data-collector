"""Food and Dairy Co connector — Pepper (usepepper.com) GraphQL invoice reader.

FDCo's "native app" is a white-labeled Pepper app; its web twin is
https://fooddairyco.pepr.app. One login (Jake's phone) covers all 4 venues.
Like Ordermentum, this is API-first — no DOM scraping:

  1. Attended first login (base_connector flow): headed browser, Jake clears the
     phone/email OTP. Playwright saves storage_state (incl. localStorage, where
     AWS Cognito keeps the id/refresh tokens) to sessions/food_dairy_co.json.
  2. Unattended re-runs: load the saved session, obtain a fresh Cognito IdToken
     (existing-if-valid → direct Cognito refresh → let the app refresh), then hit
     the Pepper GraphQL API directly.

Per venue we pull BOTH invoice sources and union them (GAS dedups on invoice_ref):
  * App/Web orders  — searchOrderHistory(SCOPE=PAST) → order.order_invoices
  * "Other" ingested — order_invoices(invoice_source=INGESTION, not linked to an order)

Invoice total = Σ(ship_quantity × unit_price_in_micros) / 1e6  (GST-inclusive;
matches the figure shown in the app — do NOT add unit_tax, that double-counts).
Date = the delivery/invoice timestamp converted to Australia/Sydney.

See docs/clickpath-fdco.md for the full API map and the ID discovery query.

Usage:
    python connectors/playwright/food_dairy_co.py --attended   # first login, saves session
    python connectors/playwright/food_dairy_co.py              # unattended API read
"""

from __future__ import annotations

import base64
import json
import time
from datetime import datetime

from base_connector import SYD_TZ, BaseConnector, cli_main
from playwright.sync_api import Page

GRAPHQL_URL = "https://api-aus.usepepper.com/v1/graphql"
COGNITO_URL = "https://cognito-idp.ap-southeast-2.amazonaws.com/"
COGNITO_CLIENT_ID = "58nt1t1batqs52tb8l7k3ipktr"

# FDCo supplier ("business") + its business-organization, from the attended map.
SUPPLIER_ID = "a5f819ac-970f-4b76-926d-4299cdaf1777"
ORG_ID = "860d911c-98d0-47be-8b2f-efc694a551e2"

# Jake's venues on FDCo (all ACTIVE 2026-06-18). restaurant_uuid → shop + chat_uuid.
# Discoverable at runtime via the UserContext_Employee query (employee_chats);
# hardcoded here for stability, mirroring the Ordermentum connector. The chat_uuid
# is required for the "Other"/ingested-invoice query.
VENUES = {
    "18f98318-033e-46eb-bdbe-bb8496c7ca48": {
        "shop": "Leible North",
        "chat": "44433267-e298-4790-a3e5-f8ffd617987e",
    },
    "9e2232d5-c159-46b3-8ad0-759b7c00cea8": {
        "shop": "Leible Pitt",
        "chat": "5034df16-32c3-4349-8e9b-ff78228b91e0",
    },
    "f6181415-b32a-473e-a968-8a75e09f96d0": {
        "shop": "Leible Crowsnest",
        "chat": "6410be40-68e0-48e2-aeca-3a0e1c65cc9b",
    },
    "c0bca7d8-fe22-496d-8de0-eb685433beb3": {
        "shop": "Leible York",
        "chat": "54e6f884-740f-4e68-963d-3d32b8513360",
    },
}

# Single-page pulls; large enough to capture full current history on first run.
# GAS dedups on invoice_ref, so re-runs are idempotent (go-forward).
PAGE_SIZE = 500

_ORDERS_QUERY = (
    "query OH($filters:[SearchOrderHistoryFilterInput!]!,$pageSize:Int,$restaurantUUID:uuid,$supplierUUID:uuid!)"
    "{searchOrderHistory(filters:$filters,page_size:$pageSize,restaurant_id:$restaurantUUID,supplier_id:$supplierUUID)"
    "{orders{order{status restaurant_desired_delivery_time "
    "order_invoices(limit:1,order_by:{created_at:desc})"
    "{invoice_number order_invoice_line_items{ship_quantity unit_price_in_micros}}}}}}"
)

_INGESTED_QUERY = (
    "query OI($chatUUID:uuid!,$limit:Int,$supplierUUID:uuid!)"
    "{order_invoices(limit:$limit,order_by:[{invoice_date:desc}],"
    'where:{invoice_source:{_eq:"INGESTION"},chat_uuid:{_eq:$chatUUID},supplier_uuid:{_eq:$supplierUUID},'
    "order_uuid:{_eq:null},_not:{order_invoices_orders:{}}})"
    "{invoice_date invoice_number order_invoice_line_items{ship_quantity unit_price_in_micros}}}"
)


class FoodDairyCoConnector(BaseConnector):
    NAME = "food_dairy_co"
    SOURCE = "food_dairy_co"
    LOGIN_URL = "https://fooddairyco.pepr.app/"

    def __init__(self, exec_url: str | None = None):
        super().__init__(exec_url)
        self._token: str | None = None

    # ------------------------------------------------------------------ #
    # Auth — AWS Cognito tokens live in localStorage (restored by storage_state)
    # ------------------------------------------------------------------ #
    def is_logged_in(self, page: Page) -> bool:
        """True only when a USABLE Cognito token can be obtained.

        The presence of a refreshToken proves nothing: one that Cognito has
        expired or revoked sits in localStorage looking exactly like a live
        one. Checking presence alone is what let 46 scheduled runs sail past
        the auth gate and then fail deep in the read, and what made
        `--attended` skip the login prompt on a 46-day-dead session.

        Cheap path first: a still-valid IdToken needs no network round trip.
        Otherwise ask Cognito to honour the refresh token — the only answer
        that actually distinguishes a live session from a dead one.
        """
        tok = self._ls_value(page, ".idToken")
        if self._valid(tok):
            self._token = tok
            return True
        return self._refresh_id_token(page) is not None

    def _ls_value(self, page: Page, suffix: str) -> str | None:
        return page.evaluate(
            "(suffix) => { const k = Object.keys(localStorage).find(k => k.endsWith(suffix));"
            " return k ? localStorage.getItem(k) : null; }",
            suffix,
        )

    @staticmethod
    def _jwt_exp(token: str) -> int:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return json.loads(base64.urlsafe_b64decode(payload)).get("exp", 0)

    def _valid(self, token: str | None) -> bool:
        try:
            return bool(token) and self._jwt_exp(token) > time.time() + 60
        except Exception:
            return False

    def _refresh_id_token(self, page: Page) -> str | None:
        """Exchange the stored refreshToken for a fresh IdToken.

        Returns None when there is no refresh token, when Cognito rejects it
        (an expired/revoked token answers 400 NotAuthorizedException), or when
        the token that comes back is not itself valid. Shared by is_logged_in
        (which needs the yes/no) and _id_token (which needs the token), so the
        auth gate and the read path can never disagree about what "logged in"
        means.
        """
        rt = self._ls_value(page, ".refreshToken")
        if not rt:
            return None
        resp = page.request.post(
            COGNITO_URL,
            headers={
                "content-type": "application/x-amz-json-1.1",
                "x-amz-target": "AWSCognitoIdentityProviderService.InitiateAuth",
            },
            data=json.dumps(
                {
                    "AuthFlow": "REFRESH_TOKEN_AUTH",
                    "ClientId": COGNITO_CLIENT_ID,
                    "AuthParameters": {"REFRESH_TOKEN": rt},
                }
            ),
        )
        if resp.status != 200:
            return None
        tok = (resp.json().get("AuthenticationResult") or {}).get("IdToken")
        if self._valid(tok):
            self._token = tok
            return tok
        return None

    def _id_token(self, page: Page) -> str:
        """Return a fresh IdToken: reuse if valid → direct Cognito refresh →
        fall back to letting the app refresh it. Block if none can be obtained."""
        if self._valid(self._token):
            return self._token

        # 1. Existing token in localStorage may still be valid.
        tok = self._ls_value(page, ".idToken")
        if self._valid(tok):
            self._token = tok
            return tok

        # 2. Direct Cognito REFRESH_TOKEN_AUTH (public SPA client, no secret).
        tok = self._refresh_id_token(page)
        if tok:
            return tok

        # 3. Fall back: the app refreshes on boot — poll localStorage briefly.
        deadline = time.time() + 30
        while time.time() < deadline:
            page.wait_for_timeout(1500)
            tok = self._ls_value(page, ".idToken")
            if self._valid(tok):
                self._token = tok
                return tok

        self.mark_blocked("could not obtain a valid Cognito token; run with --attended")

    # ------------------------------------------------------------------ #
    # Read
    # ------------------------------------------------------------------ #
    def _gql(self, page: Page, token: str, query: str, variables: dict) -> dict:
        resp = page.request.post(
            GRAPHQL_URL,
            headers={
                "content-type": "application/json",
                "authorization": f"Bearer {token}",
                "x-pepper-container-app": "JALAPENO",
                "x-pepper-app-platform": "web",
                "x-pepper-business-id": SUPPLIER_ID,
                "x-pepper-business-organization-id": ORG_ID,
                "x-pepper-accept-language": "en-US",
            },
            data=json.dumps({"query": query, "variables": variables}),
        )
        if resp.status != 200:
            print(f"  [{self.NAME}] WARNING: GraphQL HTTP {resp.status}")
            return {}
        body = resp.json()
        if body.get("errors"):
            print(f"  [{self.NAME}] WARNING: GraphQL errors: {body['errors']}")
        return body.get("data") or {}

    @staticmethod
    def _total(line_items: list[dict]) -> float:
        return round(
            sum(
                (i.get("ship_quantity") or 0) * (i.get("unit_price_in_micros") or 0)
                for i in line_items
            )
            / 1e6,
            2,
        )

    @staticmethod
    def _syd_date(iso: str) -> str:
        # e.g. "2026-06-12T14:00:00+00:00" (UTC) → Sydney date "2026-06-13".
        return datetime.fromisoformat(iso).astimezone(SYD_TZ).date().isoformat()

    def read_invoices(self, page: Page) -> list[dict]:
        token = self._id_token(page)
        rows: list[dict] = []
        for venue_id, meta in VENUES.items():
            shop = meta["shop"]
            before = len(rows)

            # App/Web orders (only those already invoiced).
            data = self._gql(
                page,
                token,
                _ORDERS_QUERY,
                {
                    "filters": [{"operation": "EQUALS", "type": "SCOPE", "value": "PAST"}],
                    "pageSize": PAGE_SIZE,
                    "restaurantUUID": venue_id,
                    "supplierUUID": SUPPLIER_ID,
                },
            )
            for entry in (data.get("searchOrderHistory") or {}).get("orders") or []:
                order = entry.get("order") or {}
                inv = (order.get("order_invoices") or [None])[0]
                if not inv or not inv.get("invoice_number"):
                    continue
                rows.append(
                    {
                        "date": self._syd_date(order["restaurant_desired_delivery_time"]),
                        "total": self._total(inv.get("order_invoice_line_items") or []),
                        "invoice_ref": inv["invoice_number"],
                        "supplier": "Food and Dairy Co",
                        "location": shop,
                    }
                )

            # "Other" ingested invoices (phone/manual, not tied to an app order).
            data = self._gql(
                page,
                token,
                _INGESTED_QUERY,
                {
                    "chatUUID": meta["chat"],
                    "limit": PAGE_SIZE,
                    "supplierUUID": SUPPLIER_ID,
                },
            )
            for inv in data.get("order_invoices") or []:
                if not inv.get("invoice_number") or not inv.get("invoice_date"):
                    continue
                rows.append(
                    {
                        "date": self._syd_date(inv["invoice_date"]),
                        "total": self._total(inv.get("order_invoice_line_items") or []),
                        "invoice_ref": inv["invoice_number"],
                        "supplier": "Food and Dairy Co",
                        "location": shop,
                    }
                )

            print(f"  [{self.NAME}] {shop}: {len(rows) - before} invoices")
        return rows


if __name__ == "__main__":
    cli_main(FoodDairyCoConnector)
