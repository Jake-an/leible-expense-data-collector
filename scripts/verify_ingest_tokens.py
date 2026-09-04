#!/usr/bin/env python3
"""Verify every per-source ingest token end to end, WITHOUT writing a row.

Run after the cutover in docs/ingest-token-cutover.md, and after any rotation.

How it proves the token without a write: it POSTs a payload that is correctly
authenticated but deliberately INVALID (no `extracted_at`). doPost checks auth
BEFORE validateIngest_, so the two outcomes are unambiguous:

    {"result":"error","code":"UNAUTHORIZED"}   -> the token is wrong/absent
    {"result":"error","message":"missing extracted_at"} -> AUTH PASSED, nothing written

Nothing is ever appended, no heartbeat is stamped, and no connector session or
browser is needed.

It also proves the fix itself: posting `source: "square"` (a GAS-native source,
absent from INGEST_SOURCES_ on purpose) with a REAL connector token must be
refused. Before 2026-09-04 that spoof succeeded and overwrote Square's rows.

Secrets: read from .env via base_connector.get_credential and passed straight
to requests. Never printed, never logged — the output shows only pass/fail and
the server's own response.

    python scripts/verify_ingest_tokens.py
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "connectors" / "playwright"))

import base_connector as bc  # noqa: E402
import requests  # noqa: E402

# source -> credential name. Mirrors INGEST_SOURCES_ in connectors/gas/Code.gs.
# coffee_order_app is intentionally absent: no producer POSTs as that source,
# so its property is meant to stay unset and fail closed.
SOURCES = [
    ("food_dairy_co", "INGEST_TOKEN_FOOD_DAIRY_CO"),
    ("fresh_and_chill", "INGEST_TOKEN_FRESH_AND_CHILL"),
    ("kent_paper", "INGEST_TOKEN_KENT_PAPER"),
    ("ordermentum", "INGEST_TOKEN_ORDERMENTUM"),
    ("shopspend", "INGEST_TOKEN_SHOPSPEND"),
    ("shopspend-backfill", "INGEST_TOKEN_SHOPSPEND"),
]

TIMEOUT = 60


def _post(url: str, body: dict) -> dict:
    resp = requests.post(url, json=body, timeout=TIMEOUT)
    resp.raise_for_status()
    try:
        return resp.json()
    except ValueError:
        return {"result": "error", "message": f"non-JSON response: {resp.text[:200]}"}


def main() -> int:
    url = bc.resolve_exec_url()
    if not url:
        print("FAIL: no /exec URL (GAS_EXEC_URL unset and config/deployment.json has none)")
        return 1

    print(f"hub: {url[:60]}...\n")
    failures = 0

    # --- 1. every source authenticates with its own token ------------------
    for source, cred in SOURCES:
        token = bc.get_credential(cred)
        if not token:
            print(f"  FAIL  {source:<20} {cred} is not set in .env")
            failures += 1
            continue

        # No extracted_at on purpose: valid auth then a validation error.
        body = {"source": source, "rows": [], "token": token}
        res = _post(url, body)

        if res.get("code") == "UNAUTHORIZED":
            print(f"  FAIL  {source:<20} UNAUTHORIZED — {cred} here != the script property,")
            print(f"        {'':<20} or the deploy has not taken. Check the GAS execution log.")
            failures += 1
        elif "extracted_at" in str(res.get("message", "")):
            print(f"  ok    {source:<20} authenticated (refused at validation, nothing written)")
        else:
            print(f"  FAIL  {source:<20} unexpected response: {res}")
            failures += 1

    # --- 2. the spoofing fix itself is live -------------------------------
    print()
    probe_token = bc.get_credential("INGEST_TOKEN_FOOD_DAIRY_CO")
    if not probe_token:
        print("  SKIP  spoof probe — INGEST_TOKEN_FOOD_DAIRY_CO unavailable")
    else:
        for spoofed in ("square", "mayers", "greenbean", "shopify_orderapp"):
            res = _post(url, {"source": spoofed, "rows": [], "token": probe_token})
            if res.get("code") == "UNAUTHORIZED":
                print(f"  ok    spoof {spoofed:<18} refused")
            else:
                print(f"  FAIL  spoof {spoofed:<18} NOT REFUSED — {res}")
                print(f"        {'':<24} the hub is still running the shared-token build.")
                failures += 1

    print()
    if failures:
        print(f"{failures} check(s) FAILED — do not leave this to the scheduler.")
        return 1
    print("All ingest tokens verified. Nothing was written.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
