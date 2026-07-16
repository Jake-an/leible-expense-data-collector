# Playwright Portal Connectors

Local browser automation for supplier portals that GAS can't reach. Each connector
logs into a portal with a saved session, reads the on-screen invoice/order list,
and POSTs invoice-level rows to the GAS `doPost` endpoint (→ `Suppliers` tab).

All connectors subclass `BaseConnector` (`base_connector.py`). The base owns
session persistence, attended login, fail-safe blocking, and the POST. A portal
connector only supplies `NAME` / `SOURCE` / `LOGIN_URL` and two hooks:
`is_logged_in(page)` and `read_invoices(page)`.

## Setup

```bash
cd connectors/playwright
pip install -r requirements.txt
python -m playwright install chromium
# Optional: export GAS_EXEC_URL to override config/deployment.json's execUrl.
export GAS_EXEC_URL="https://script.google.com/macros/s/<deployment-id>/exec"
```

## Attended first login (per portal — Jake)

The first run must be attended so Jake clears login + any MFA/CAPTCHA (rules.md:
never bypass these). A headed browser opens; log in, then press Enter. The session
is saved to `sessions/<name>.json` (gitignored) and reused unattended afterwards.

```bash
python connectors/playwright/ordermentum.py --attended
```

## Unattended runs

```bash
python connectors/playwright/ordermentum.py        # uses saved session
```

If the session has expired, the connector exits `blocked` (code 2) — re-run with
`--attended` to refresh.

## Click-path mapping status

Each portal connector currently has its selectors stubbed with a
`# TODO(attended-mapping)` block. They are filled in **after** Jake's attended
login, when the real DOM is visible — record the click-path in
`docs/clickpath-<name>.md` first, then wire the selectors. Until then, unattended
runs will not return real rows.

| Connector | source | accounts | status |
|---|---|---|---|
| `ordermentum.py` | `ordermentum` | Tuga Pastry, Butterboy | skeleton — selectors TODO |
| `food_dairy_co.py` | `food_dairy_co` | one | skeleton — selectors TODO |
| `fresh_and_chill.py` | `fresh_and_chill` | one | skeleton — selectors TODO |
| `kent_paper.py` | `kent_paper` | one | skeleton — selectors TODO |
