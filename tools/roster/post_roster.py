"""
post_roster.py - ingest a BrightHR "Roster details" CSV into the LEIBLE collector.

Ported from LEIBLE_New Staff Onboarding App/tools/hours-runner/post-roster-csv.py.
Weekly flow (unchanged UX): export the CSV, double-click Post-Roster.cmd, press y.

    Reports > Roster > "Roster Details" > pick the week > Generate CSV
        |
        v
    python post_roster.py rota.csv
        |-- POST {source:'brighthr_roster', kind:'roster', token, rows}  -> collector /exec
        '-- POST ?endpoint=ingest-hours (legacy Onboarding, ALSO_POST_ONBOARDING)
    Both posts are attempted independently (RB7): one failing never skips the other.

Location: "Roster name" is posted VERBATIM as `location`; GAS maps it. "Team(s)" is ignored.
Paid hours = "Total hours excluding breaks (decimal)". No department key is ever sent.

Token (RB8/RB11): `--init-token` generates a 32-char token into .roster-token.txt, copies it
to the clipboard, prints only an 8-char fingerprint, and clears the clipboard once you confirm
the paste. `--regen-token` does the same for a mismatch. The token is never printed.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import secrets
import string
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

import requests

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
DEPLOYMENT_JSON = REPO_ROOT / "config" / "deployment.json"
ROSTER_TOKEN_FILE = HERE / ".roster-token.txt"

SOURCE = "brighthr_roster"
KIND = "roster"

# Dual-post during Phase 4; flipped to False in Phase 5 step 1.
ALSO_POST_ONBOARDING = True
ONBOARDING_SOURCE = "brighthr-roster"
# Old Onboarding DEV /exec (pinned), copied verbatim from the old script.
ONBOARDING_EXEC_URL = (
    "https://script.google.com/macros/s/"
    "AKfycbzGxgFdHwwnwBe1A_aQNFFa35EKhqgRfnRcLw9TrcRHObPT6DtzzaOMe0Y3hGbHLA2k/exec"
)
# The legacy token is READ from the old hours-runner folder (not copied), falling back to a
# copy placed beside this script. Both are gitignored by `*token*.txt`.
ONBOARDING_TOKEN_FILES = (
    Path(r"C:\Users\mioja\.claude\projects\LEIBLE_New Staff Onboarding App\tools\hours-runner\.hours-token.txt"),
    HERE / ".hours-token.txt",
)

LOCKED_RETRY_DELAY_SECONDS = 60
TOKEN_LENGTH = 32

COL_FIRST = "First name"
COL_LAST = "Last name"
COL_EMAIL = "Email address"
COL_ROSTER = "Roster name"  # per-shift site, NOT "Team(s)"
COL_START_DATE = "Start date"
COL_START_TIME = "Start time"
COL_END_TIME = "End time"
COL_PAID_HOURS = "Total hours excluding breaks (decimal)"
COL_PAID_HOURS_ALT = "Total hours (decimal)"

REQUIRED_COLS = (COL_FIRST, COL_LAST, COL_EMAIL, COL_ROSTER, COL_START_DATE, COL_START_TIME, COL_END_TIME)


class RosterError(Exception):
    """Parse / config error that should stop the run with a readable message."""


class PostFailed(Exception):
    def __init__(self, message: str, code: str | None = None):
        super().__init__(message)
        self.code = code


def _red(s: str) -> str:
    return f"\033[91m{s}\033[0m"


def _green(s: str) -> str:
    return f"\033[92m{s}\033[0m"


# --------------------------------------------------------------------------- parsing

def _find_table(path):
    with open(path, newline="", encoding="utf-8-sig") as fh:
        reader = csv.reader(fh)
        rows = []
        for row in reader:
            rows.append((reader.line_num, row))
    for idx, (_, row) in enumerate(rows):
        if row and row[0].strip() == COL_FIRST:
            return row, rows[idx + 1:]
    raise RosterError(
        f"Could not find the details header (a row starting with '{COL_FIRST}') in {path}. "
        "Is this a BrightHR 'Roster details' export?"
    )


def to_iso_date(d: str) -> str:
    """'16-Jun-2026' -> '2026-06-16'. Passes ISO through."""
    s = d.strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
        return s
    return datetime.strptime(s, "%d-%b-%Y").strftime("%Y-%m-%d")


_TIME_RE = re.compile(r"^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?$")


def normalise_time(value: str) -> str:
    """9:00 / 09:00:00 / 9:00 AM / 9:00 pm -> zero-padded 24h 'HH:MM'. ValueError otherwise."""
    m = _TIME_RE.match(value.strip())
    if not m:
        raise ValueError(f"unrecognised time {value!r}")
    hh, mm, ss, ampm = int(m.group(1)), int(m.group(2)), m.group(3), m.group(4)
    if mm > 59 or (ss is not None and int(ss) > 59):
        raise ValueError(f"unrecognised time {value!r}")
    if ampm:
        if not 1 <= hh <= 12:
            raise ValueError(f"unrecognised time {value!r}")
        hh = hh % 12 + (12 if ampm.lower() == "pm" else 0)
    elif hh > 23:
        raise ValueError(f"unrecognised time {value!r}")
    return f"{hh:02d}:{mm:02d}"


def parse_csv(path):
    """Return (shifts, skipped). Each shift carries the collector fields plus the raw
    strings the legacy Onboarding post needs (first_name/last_name/raw_start/raw_end)."""
    header, data_rows = _find_table(path)
    missing = [c for c in REQUIRED_COLS if c not in header]
    hours_col = COL_PAID_HOURS if COL_PAID_HOURS in header else (COL_PAID_HOURS_ALT if COL_PAID_HOURS_ALT in header else None)
    if hours_col is None:
        missing.append("paid hours (" + COL_PAID_HOURS + ")")
    if missing:
        raise RosterError("CSV is missing expected column(s): " + ", ".join(missing))
    col = {c: header.index(c) for c in REQUIRED_COLS}
    i_hours = header.index(hours_col)

    shifts, skipped, errors = [], 0, []
    for line_no, row in data_rows:
        if not row or len(row) <= i_hours:
            continue  # blank line / footer
        email = row[col[COL_EMAIL]].strip().lower()
        start_date = row[col[COL_START_DATE]].strip()
        start_time = row[col[COL_START_TIME]].strip()
        end_time = row[col[COL_END_TIME]].strip()
        try:
            hours = float(row[i_hours].strip() or "0")
        except ValueError:
            hours = 0.0

        # Leave / placeholder rows carry no real shift.
        if not (email and start_date and start_time and end_time) or hours <= 0:
            skipped += 1
            continue

        try:
            iso = to_iso_date(start_date)
            start_n = normalise_time(start_time)
            end_n = normalise_time(end_time)
        except ValueError as err:
            errors.append(f"CSV line {line_no}: {err}")
            continue

        first = row[col[COL_FIRST]].strip()
        last = row[col[COL_LAST]].strip()
        shifts.append({
            "email": email,
            "name": f"{first} {last}".strip(),
            "date": iso,
            "start": start_n,
            "end": end_n,
            "hours": round(hours, 4),
            "location": row[col[COL_ROSTER]].strip(),
            # legacy-only (stripped from the collector payload)
            "first_name": first,
            "last_name": last,
            "raw_start": start_time,
            "raw_end": end_time,
        })
    if errors:
        raise RosterError("Bad date/time value(s):\n  " + "\n  ".join(errors))
    return shifts, skipped


def collector_rows(shifts):
    keys = ("email", "name", "date", "start", "end", "hours", "location")
    return [{k: s[k] for k in keys} for s in shifts]


def onboarding_shifts(shifts):
    """Shape the old script posted: raw time strings, first/last name."""
    return [{
        "email": s["email"], "first_name": s["first_name"], "last_name": s["last_name"],
        "date": s["date"], "start": s["raw_start"], "end": s["raw_end"],
        "hours": s["hours"], "location": s["location"],
    } for s in shifts]


# --------------------------------------------------------------------------- config / token

def read_exec_url(path=DEPLOYMENT_JSON) -> str:
    try:
        url = json.loads(Path(path).read_text(encoding="utf-8")).get("execUrl", "")
    except (OSError, ValueError) as err:
        raise RosterError(f"Cannot read execUrl from {path}: {err}") from err
    if not url:
        raise RosterError(f"No execUrl in {path}.")
    return url


def generate_token() -> str:
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(TOKEN_LENGTH))


def fingerprint(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()[:8]


def read_token(path=ROSTER_TOKEN_FILE) -> str:
    p = Path(path)
    if not p.exists():
        raise RosterError(
            f"No roster token at {p}. Run: python post_roster.py --init-token "
            "(Post-Roster.cmd does this on first run)."
        )
    token = p.read_text(encoding="ascii").strip()
    if not token:
        raise RosterError(f"{p} is empty. Run: python post_roster.py --regen-token")
    return token


def copy_to_clipboard(text: str) -> None:
    subprocess.run(["clip"], input=text.encode("utf-16-le"), check=True)


def clear_clipboard() -> None:
    subprocess.run(["clip"], input=b"", check=True)  # empty stdin empties the clipboard


def init_token(path=ROSTER_TOKEN_FILE, copy=copy_to_clipboard, clear=clear_clipboard,
               confirm=input, out=print) -> str:
    """Generate + save a token, clipboard it, print only a fingerprint, and clear the
    clipboard once the operator confirms the paste (RB8, RB11). Returns the fingerprint."""
    token = generate_token()
    Path(path).write_text(token, encoding="ascii")
    fp = fingerprint(token)
    copy(token)
    out(f"New roster token saved to {Path(path).name} (fingerprint {fp}) and copied to the clipboard.")
    out("Paste it into the collector's INGEST_TOKEN_BRIGHTHR_ROSTER Script Property now.")
    try:
        confirm("Press Enter once it is pasted (the clipboard will then be cleared): ")
    finally:
        clear()
    out("Clipboard cleared.")
    return fp


# --------------------------------------------------------------------------- HTTP

def _redact(msg: str, secret: str) -> str:
    out = msg
    for s in {secret, quote(secret, safe="")}:
        if s:
            out = out.replace(s, "***")
    return out


def _json_body(resp) -> dict:
    try:
        return resp.json()
    except ValueError as err:
        raise PostFailed(f"non-JSON response ({err})") from err


def post_collector(rows, exec_url, token, http_post=requests.post, sleep=time.sleep) -> dict:
    """POST to the collector; retry once after 60s on LOCKED (RB6). Raises PostFailed."""
    payload = {"source": SOURCE, "kind": KIND, "token": token, "rows": rows}
    last_code = None
    for attempt in (1, 2):
        try:
            resp = http_post(exec_url, json=payload, timeout=300)
            body = _json_body(resp)
        except PostFailed:
            raise
        except Exception as err:  # network errors can embed the URL; token is in the body only
            raise PostFailed(_redact(f"{type(err).__name__}: {err}", token)) from err
        if body.get("result") == "ok":
            return body
        last_code = body.get("code")
        if last_code == "LOCKED" and attempt == 1:
            sleep(LOCKED_RETRY_DELAY_SECONDS)
            continue
        break
    message = body.get("message") or (f"code={last_code}" if last_code else "unknown ingest error")
    raise PostFailed(f"collector ingest failed: {message}", code=last_code)


def post_onboarding(shifts, exec_url, token, http_post=requests.post, compute=True) -> dict:
    """The legacy ingest-hours call, exactly as the old script made it."""
    payload = {
        "batch_id": f"{ONBOARDING_SOURCE}-{datetime.now().strftime('%Y%m%d-%H%M%S')}",
        "source": ONBOARDING_SOURCE,
        "shifts": shifts,
        "compute": compute,
    }
    url = f"{exec_url}?endpoint=ingest-hours&token={quote(token, safe='')}"
    try:
        resp = http_post(url, json=payload, timeout=300)
        resp.raise_for_status()
        try:
            return resp.json()
        except ValueError:
            return {"result": "ok", "raw": resp.text[:200]}
    except Exception as err:
        raise PostFailed(_redact(f"{type(err).__name__}: {err}", token)) from err


def read_onboarding_token(paths=ONBOARDING_TOKEN_FILES) -> str:
    for p in paths:
        p = Path(p)
        if p.exists():
            tok = p.read_text(encoding="ascii").strip()
            if tok:
                return tok
    raise RosterError("legacy .hours-token.txt not found (old hours-runner folder or tools/roster/)")


def run_post(shifts, exec_url, token, also_onboarding=None, onboarding_token_paths=ONBOARDING_TOKEN_FILES,
             http_post=requests.post, sleep=time.sleep, out=print) -> int:
    """Attempt BOTH posts independently (RB7). Returns 0 only if every attempted post succeeded."""
    if also_onboarding is None:
        also_onboarding = ALSO_POST_ONBOARDING
    failures = 0

    try:
        body = post_collector(collector_rows(shifts), exec_url, token, http_post=http_post, sleep=sleep)
        out(_green(f"Collector: OK - rowsAdded={body.get('rowsAdded')} "
                   f"rowsReplaced={body.get('rowsReplaced')} dates={body.get('dates')}"))
    except Exception as err:
        failures += 1
        out(_red(f"Collector: FAILED - {err}"))
        if getattr(err, "code", None) == "LOCKED":
            out(_red("The sheet was busy twice. Re-run the shortcut."))

    if also_onboarding:
        try:
            otoken = read_onboarding_token(onboarding_token_paths)
            result = post_onboarding(onboarding_shifts(shifts), ONBOARDING_EXEC_URL, otoken, http_post=http_post)
            out(_green(f"Onboarding: OK - {result}"))
        except Exception as err:
            failures += 1
            out(_red(f"Onboarding: FAILED - {err}"))

    return 0 if failures == 0 else 1


# --------------------------------------------------------------------------- CLI

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="POST a BrightHR 'Roster details' CSV to the LEIBLE collector")
    ap.add_argument("csv_path", nargs="?", help="path to the BrightHR 'Roster details' CSV export")
    ap.add_argument("--dry-run", action="store_true", help="parse and summarise only; do not POST")
    ap.add_argument("--init-token", action="store_true", help="create .roster-token.txt if absent")
    ap.add_argument("--regen-token", action="store_true", help="replace .roster-token.txt (after a mismatch)")
    args = ap.parse_args(argv)

    if args.init_token or args.regen_token:
        if args.init_token and not args.regen_token and ROSTER_TOKEN_FILE.exists():
            print("Roster token already exists; use --regen-token to replace it.")
            return 0
        init_token()
        return 0

    if not args.csv_path:
        ap.error("csv_path is required")

    try:
        shifts, skipped = parse_csv(args.csv_path)
    except RosterError as err:
        print(_red(str(err)))
        return 2

    locations = sorted({s["location"] for s in shifts})
    total_hours = round(sum(s["hours"] for s in shifts), 2)
    dates = sorted({s["date"] for s in shifts})
    print(f"Parsed {len(shifts)} shifts, {total_hours} paid hours ({skipped} rows skipped - no times/hours).")
    print(f"Dates: {', '.join(dates) or '(none)'}")
    print(f"Roster names seen: {', '.join(locations) or '(none)'}")
    print("  -> each must map to a shop in the collector, or the shift costs as unknown_location.")

    if args.dry_run:
        for s in collector_rows(shifts)[:3]:
            print("  e.g.", {**s, "email": "<hidden>", "name": "<hidden>"})
        return 0

    if not shifts:
        print("No shifts to post.")
        return 0

    try:
        exec_url = read_exec_url()
        token = read_token()
    except RosterError as err:
        print(_red(str(err)))
        return 2

    return run_post(shifts, exec_url, token)


if __name__ == "__main__":
    sys.exit(main())
