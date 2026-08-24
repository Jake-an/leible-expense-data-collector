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

The GAS web-app URL resolves from GAS_EXEC_URL (override) if set, else falls back
to config/deployment.json's execUrl (see resolve_exec_url()).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
from playwright.sync_api import BrowserContext, Page, sync_playwright

# Repo root = two levels up from this file (connectors/playwright/).
REPO_ROOT = Path(__file__).resolve().parents[2]

# Backfill scope arg. Matches the GAS-side DATE_ARG_RE (Code.gs:1573) so a
# --since value and a weeklySummarize override are the same shape.
DATE_ARG_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
SESSIONS_DIR = REPO_ROOT / "sessions"

DEPLOYMENT_JSON = REPO_ROOT / "config" / "deployment.json"
ENV_FILE = REPO_ROOT / ".env"

# Cache for load_env_file() — parsed once per process. Tests reset via
# `monkeypatch.setattr(b, "_env_cache", None)`.
_env_cache: dict[str, str] | None = None


def load_env_file() -> dict[str, str]:
    """Parse repo-root `.env` into a dict. Real `os.environ` wins over file
    values. Cached after the first call (see `_env_cache`).

    Split each line on the FIRST `=` only; `#` is a comment ONLY when it
    begins a (stripped) line — never strip an inline `#`, since a password
    may legitimately contain `#`/`=`/spaces. Strip surrounding quotes and a
    trailing `\\r`; skip blank lines. Never raises if `.env` is absent.
    """
    global _env_cache
    if _env_cache is not None:
        return _env_cache

    values: dict[str, str] = {}
    if ENV_FILE.exists():
        for raw_line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            line = raw_line.rstrip("\r")
            if not line.strip() or line.strip().startswith("#"):
                continue
            if "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
                value = value[1:-1]
            if key:
                values[key] = value

    # Real OS env vars win over the file, for any key present in the file.
    for key in list(values):
        if key in os.environ:
            values[key] = os.environ[key]

    _env_cache = values
    return values


# A GAS doPost may legitimately run to its own 6-minute execution limit on a
# large payload. A client timeout below that reports FAILURE for a request the
# server went on to process successfully — which is exactly what happened on
# 2026-08-25: the Ordermentum run timed out at 300s, exited 1, and had in fact
# ingested three years of invoice history. Overriding via env is for probing;
# the default must stay above 360s.
POST_TIMEOUT_SECONDS = int(os.environ.get("GAS_POST_TIMEOUT_SECONDS", "600"))


def get_credential(name: str) -> str | None:
    """Return a credential by name: real `os.environ` first, then `.env`.
    Never logs the value. Returns None if unset anywhere."""
    env_val = os.environ.get(name)
    if env_val:
        return env_val
    return load_env_file().get(name)


def _breaker_path(key: str) -> Path:
    """Circuit-breaker marker file for `key` (e.g. 'ordermentum' or
    'fresh_and_chill_york'). Lives under sessions/ (already gitignored)."""
    return SESSIONS_DIR / f"{key}.autologin_blocked"


def _breaker_tripped(key: str) -> bool:
    return _breaker_path(key).exists()


def _trip_breaker(key: str, reason: str) -> None:
    """Trip the auto-login circuit-breaker for `key`. Suppresses further
    auto-login attempts until a `--attended` run (or --clear-breaker) clears
    it. Never write the credential value — reason is a short label only."""
    SESSIONS_DIR.mkdir(exist_ok=True)
    stamp = datetime.now(SYD_TZ).isoformat(timespec="seconds")
    _breaker_path(key).write_text(f"{stamp} {reason}\n", encoding="utf-8")


def _clear_breaker(key: str) -> None:
    path = _breaker_path(key)
    if path.exists():
        path.unlink()


def _clear_breaker_with_warning(label: str, key: str, email_var: str, password_var: str) -> None:
    """Clear the auto-login breaker for `key` after a successful attended
    login (re-arms auto-login for the next unattended run). If the breaker
    was tripped AND `.env` has credentials for this key, warn — a wrong
    stored password would otherwise silently re-trip every ~15-day cycle
    without Jake noticing. Never logs credential values."""
    was_tripped = _breaker_tripped(key)
    creds_present = bool(get_credential(email_var) and get_credential(password_var))
    if was_tripped and creds_present:
        print(
            f"[{label}] WARNING: auto-login breaker was tripped and .env has "
            f"credentials for '{key}' — the stored password may be wrong; "
            f"double-check {email_var}/{password_var} in .env.",
            file=sys.stderr,
        )
    _clear_breaker(key)


def _form_login(
    page: Page,
    login_url: str,
    email: str,
    password: str,
    email_sel: str,
    password_sel: str,
    submit_sel: str,
) -> None:
    """Generic fill+submit helper for a plain email/password login form.
    Does NOT verify success — the caller checks is_logged_in()/auth_state()
    afterward. Never logs credential values.

    Raises TransientLoginError if the form can't even be reached/filled
    (network error, selector never appears) — distinct from a rejected
    login (wrong password), which the caller detects via the post-submit
    logged-in check.
    """
    try:
        page.goto(login_url, wait_until="domcontentloaded")
        page.wait_for_selector(email_sel, timeout=15000)
        page.fill(email_sel, email)
        page.fill(password_sel, password)
        page.click(submit_sel)
        page.wait_for_load_state("domcontentloaded")
    except Exception as err:
        raise TransientLoginError(f"form login could not be attempted: {err}") from err


def resolve_exec_url() -> str:
    """GAS /exec URL: GAS_EXEC_URL (override) → config/deployment.json execUrl.

    Never raises — returns '' and lets post() own the single failure message, so a
    corrupt config can't crash an --attended run that never POSTs.
    """
    env_url = os.environ.get("GAS_EXEC_URL", "").strip()
    if env_url:
        return env_url
    try:
        with DEPLOYMENT_JSON.open(encoding="utf-8") as fh:
            return str(json.load(fh).get("execUrl", "") or "").strip()
    except FileNotFoundError:
        print(f"[base] no {DEPLOYMENT_JSON} — cannot resolve execUrl", file=sys.stderr)
    except (json.JSONDecodeError, OSError, TypeError) as err:
        print(f"[base] cannot read {DEPLOYMENT_JSON}: {err}", file=sys.stderr)
    return ""


# Australia/Sydney offset for extracted_at stamps. Australia observes DST; this is
# a fixed +10:00 for simplicity — refine if exact AEDT stamping ever matters.
SYD_TZ = timezone(timedelta(hours=10))


class BlockedError(Exception):
    """Raised when a connector cannot proceed without human re-auth."""


class TransientLoginError(Exception):
    """Raised by a `credentials_login` impl (or `_form_login`) when a login
    attempt couldn't even be made — form not found, network error. Distinct
    from a rejected login (wrong password): this path blocks WITHOUT
    tripping the circuit-breaker, since nothing about the credentials was
    actually tested."""


class IngestError(Exception):
    """Raised when the GAS ingest endpoint rejects rows or cannot parse the response."""


class BaseConnector:
    # --- subclasses MUST override these ---
    NAME: str = "base"  # session filename + log label
    SOURCE: str = "base"  # POST `source` field (and Suppliers dedup namespace)
    LOGIN_URL: str = ""  # portal login / landing URL

    def __init__(self, exec_url: str | None = None):
        self.exec_url = exec_url or resolve_exec_url()
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
    # Headless auto-login hooks — override in subclasses that support it.
    # Defaults keep every existing connector's behaviour unchanged (no
    # auto-login capability → 'no credentials in .env' → blocked, same as
    # today's "not logged in" block).
    # ------------------------------------------------------------------ #
    def auth_state(self, page: Page) -> str:
        """'ok' | 'dead' | 'transient'. Default derives from is_logged_in()
        (ok/dead only — never transient) so existing connectors that don't
        override this are unaffected."""
        return "ok" if self.is_logged_in(page) else "dead"

    def credentials_login(self, page: Page) -> bool:
        """Perform a headless credentials login (form-fill via _form_login,
        or equivalent) and return whether it appears to have succeeded.
        Must not itself raise on a rejected login (wrong password) — only
        raise TransientLoginError when the attempt couldn't even be made."""
        raise NotImplementedError

    # ------------------------------------------------------------------ #
    # Shared orchestration
    # ------------------------------------------------------------------ #
    def run(self, attended: bool = False, dry_run: bool = False, since: str | None = None) -> dict:
        """Read the portal and POST to GAS.

        dry_run reads exactly as a real run does — same session, same auth path,
        same read_invoices — and then STOPS before post(). It is the only way to
        see what a connector would write without writing it, which matters most
        for a backfill: a mapping fix can change how many rows a run produces by
        orders of magnitude, and doPost has no undo.

        since ('YYYY-MM-DD') drops rows dated before it, AFTER the read. It is a
        deliberate scope control for backfills, not an optimisation — fixing the
        Ordermentum North venue turned a routine run into 2,640 rows spanning
        three years, and two things make posting all of that a bad idea:
        GAS appends row by row inside a 6-minute execution limit, and
        ARCHIVE_RETENTION_DAYS (183) means anything older than ~6 months is
        swept into _archive by the next weekly run without ever reaching Summary
        unless that week is re-summarized by hand.

        The filter lives here rather than in each read_invoices so a subclass
        cannot forget it, and so --dry-run reports exactly what --since would
        post.
        """
        if not attended and not dry_run:
            self._require_exec_url()
        if since is not None and not DATE_ARG_RE.match(since):
            raise ValueError(f"--since must be YYYY-MM-DD, got {since!r}")
        SESSIONS_DIR.mkdir(exist_ok=True)
        with sync_playwright() as pw:
            context = self._new_context(pw, headed=attended)
            page = context.new_page()
            page.goto(self.LOGIN_URL, wait_until="domcontentloaded")

            if attended:
                if not self.is_logged_in(page):
                    self._attended_login(page)
                _clear_breaker_with_warning(
                    self.NAME,
                    self.NAME,
                    f"{self.NAME.upper()}_EMAIL",
                    f"{self.NAME.upper()}_PASSWORD",
                )
                context.storage_state(path=str(self.session_path))
            else:
                state = self.auth_state(page)
                if state == "transient":
                    self.mark_blocked(
                        "auth_state=transient (5xx/timeout/network) — not attempting auto-login"
                    )
                elif state == "dead":
                    email_var = f"{self.NAME.upper()}_EMAIL"
                    password_var = f"{self.NAME.upper()}_PASSWORD"
                    creds_present = bool(get_credential(email_var) and get_credential(password_var))
                    self._attempt_auto_login(page, self.NAME, creds_present)
                # state == "ok" → proceed straight to read_invoices below.

            rows = self.read_invoices(page)
            # Persist refreshed cookies after a successful unattended read too.
            context.storage_state(path=str(self.session_path))
            context.close()

        if since is not None:
            before = len(rows)
            # A row with no/blank date is NOT silently dropped — an undated row
            # is a parsing problem worth seeing, and dropping it here would hide
            # it behind a flag that reads as "just narrowing the window".
            rows = [r for r in rows if not str(r.get("date") or "") or str(r["date"])[:10] >= since]
            print(f"[{self.NAME}] --since {since}: kept {len(rows)} of {before} row(s)")

        if dry_run:
            return self._dry_run_report(rows)

        result = self.post(rows)
        print(f"[{self.NAME}] read {len(rows)} rows -> POST {result}")
        return {"rows": len(rows), "post": result}

    def _dry_run_report(self, rows: list[dict]) -> dict:
        """Summarise what a real run WOULD have posted. Writes nothing to GAS.

        The full row dump goes to downloads/ (gitignored) rather than the
        terminal: it is business data, and a 500-row scroll is not reviewable
        anyway. The per-location/per-supplier breakdown on screen is what a
        person can actually check a mapping against.
        """
        by_loc: dict[str, list[dict]] = {}
        for r in rows:
            by_loc.setdefault(str(r.get("location", "")), []).append(r)

        print(f"\n[{self.NAME}] DRY RUN — {len(rows)} row(s) read, NOTHING POSTED\n")
        print(f"  {'location':<20}{'supplier':<26}{'rows':>6}{'total':>14}   {'date range'}")
        print("  " + "-" * 88)
        for loc in sorted(by_loc):
            by_sup: dict[str, list[dict]] = {}
            for r in by_loc[loc]:
                by_sup.setdefault(str(r.get("supplier", "")), []).append(r)
            for sup in sorted(by_sup):
                group = by_sup[sup]
                dates = sorted(str(g.get("date", ""))[:10] for g in group if g.get("date"))
                span = f"{dates[0]} .. {dates[-1]}" if dates else "—"
                total = sum(float(g.get("total") or 0) for g in group)
                print(f"  {loc:<20}{sup:<26}{len(group):>6}{total:>14,.2f}   {span}")
        print("  " + "-" * 88)
        print(
            f"  {'TOTAL':<46}{len(rows):>6}{sum(float(r.get('total') or 0) for r in rows):>14,.2f}"
        )

        out = REPO_ROOT / "downloads" / f"{self.NAME}-dryrun.json"
        out.parent.mkdir(exist_ok=True)
        out.write_text(json.dumps(rows, indent=2, default=str), encoding="utf-8")
        print(f"\n  full row dump: {out}  (gitignored)")
        print(f"  to actually ingest: python connectors/playwright/{self.NAME}.py\n")
        return {"rows": len(rows), "post": {"result": "dry-run", "reason": "nothing posted"}}

    def _attempt_auto_login(self, page: Page, key: str, creds_present: bool) -> None:
        """Orchestrate a headless auto-login attempt for breaker key `key`.
        1. breaker tripped -> blocked, no attempt.
        2. no creds -> blocked, breaker untouched.
        3. credentials_login raises TransientLoginError -> blocked, no trip.
        4. credentials_login returns True -> save session, clear breaker, continue.
        5. credentials_login returns False -> trip breaker, blocked.

        credentials_login's return value is the SINGLE source of truth here
        (contract: True only when login is verified, False when
        attempted-but-rejected, raises TransientLoginError when it couldn't
        even attempt). Do NOT re-probe is_logged_in() after the hook
        returns — a second independent probe here would (a) be able to
        false-trip the breaker on a transient blip unrelated to the actual
        credentials, and (b) crash the run uncaught if it raises, since
        is_logged_in() has no try/except of its own.
        """
        if _breaker_tripped(key):
            self.mark_blocked(f"auto-login breaker tripped for '{key}' — run --attended to clear")
        if not creds_present:
            self.mark_blocked(f"no credentials in .env for '{key}'; run --attended")

        try:
            attempted_ok = self.credentials_login(page)
        except TransientLoginError as err:
            self.mark_blocked(f"auto-login could not be attempted for '{key}': {err}")
            return  # unreachable — mark_blocked raises; kept for readability

        if attempted_ok:
            page.context.storage_state(path=str(self.session_path))
            _clear_breaker(key)
            print(f"[{self.NAME}] auto-login succeeded for '{key}'; session saved")
            return

        _trip_breaker(key, "credentials rejected or login incomplete")
        self.mark_blocked(f"auto-login failed for '{key}' — credentials rejected; breaker tripped")

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

    def _require_exec_url(self) -> None:
        if not self.exec_url:
            raise RuntimeError(
                f"No GAS /exec URL: GAS_EXEC_URL is unset and {DEPLOYMENT_JSON} has no execUrl. "
                f"Run bash scripts/deploy.sh, or export GAS_EXEC_URL."
            )

    def post(self, rows: list[dict]) -> dict:
        if not rows:
            return {"result": "skipped", "reason": "no rows"}
        self._require_exec_url()
        payload = {
            "source": self.SOURCE,
            "rows": rows,
            "extracted_at": datetime.now(SYD_TZ).isoformat(timespec="seconds"),
        }
        resp = requests.post(self.exec_url, json=payload, timeout=POST_TIMEOUT_SECONDS)
        resp.raise_for_status()
        try:
            body = resp.json()
        except ValueError as err:
            raise IngestError(f"GAS response not valid JSON: {resp.text[:200]}") from err
        if body.get("result") != "ok":
            raise IngestError(body.get("message", "unknown ingest error"))
        return body

    def mark_blocked(self, reason: str) -> None:
        print(f"[{self.NAME}] BLOCKED: {reason}", file=sys.stderr)
        raise BlockedError(reason)

    # ------------------------------------------------------------------ #
    # Small DOM helper shared by skeletons
    # ------------------------------------------------------------------ #
    @staticmethod
    def read_table_rows(
        page: Page, row_selector: str, cell_selectors: dict[str, str]
    ) -> list[dict]:
        """Generic: for each element matching row_selector, pull one field per
        cell_selectors entry (field name → CSS/text selector relative to the row).
        Subclasses still map raw cells → the {date,total,invoice_ref} contract.
        """
        out: list[dict] = []
        for row in page.query_selector_all(row_selector):
            record: dict[str, str] = {}
            for field, sel in cell_selectors.items():
                el = row.query_selector(sel)
                record[field] = el.inner_text().strip() if el else ""
            out.append(record)
        return out


def cli_main(connector_cls) -> None:
    """Standard CLI entry shared by every connector module."""
    parser = argparse.ArgumentParser(description=f"{connector_cls.NAME} portal connector")
    parser.add_argument(
        "--attended",
        action="store_true",
        help="headed first login; save session for later unattended runs",
    )
    parser.add_argument(
        "--clear-breaker",
        action="store_true",
        help="clear the auto-login circuit-breaker without a full attended login "
        "(use after fixing a .env typo)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="read the portal and report what WOULD be ingested; POSTs nothing",
    )
    parser.add_argument(
        "--since",
        metavar="YYYY-MM-DD",
        help="ignore rows dated before this (backfill scope control)",
    )
    args = parser.parse_args()
    if args.clear_breaker:
        _clear_breaker(connector_cls.NAME)
        print(f"[{connector_cls.NAME}] auto-login breaker cleared")
        return
    try:
        connector_cls().run(attended=args.attended, dry_run=args.dry_run, since=args.since)
    except BlockedError:
        sys.exit(2)
