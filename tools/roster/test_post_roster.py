"""Tests for post_roster.py. HTTP, clipboard and sleep are stubbed; no real .env or token is read."""

import json

import post_roster as pr
import pytest

HEADER = (
    "First name,Last name,Email address,Terminated,Termination date,Payroll number,Rate of pay,Rate,"
    "Payment frequency,Employee type,Contracted hours,Employment agreement type,Award,Classification,"
    "Team(s),Roster name,Published roster?,Start date,End date,Start time,End time,Shift status,"
    "Break (minutes),Break (hours),Total hours including breaks (decimal),"
    "Total hours excluding breaks (decimal),Notes,Label,Annual leave duration,Annual leave unit,Sickness (hours)"
)


def _line(
    first="Test",
    last="Person",
    email="test.person@example.invalid",
    roster="Dummy Cafe",
    date="16-Jun-2026",
    start="09:00",
    end="17:30",
    hours="8",
):
    cols = [""] * 31
    cols[0], cols[1], cols[2] = first, last, email
    cols[15], cols[17], cols[19], cols[20], cols[25] = roster, date, start, end, hours
    return ",".join(cols)


def _csv(tmp_path, *lines, preamble=True):
    pre = "Roster details,,,\nGenerated 2026-06-22,,,\n,,,\n" if preamble else ""
    p = tmp_path / "rota.csv"
    p.write_text(pre + HEADER + "\n" + "\n".join(lines) + "\n", encoding="utf-8")
    return p


class FakeResp:
    def __init__(self, body=None, status=200, text="", raise_json=False):
        self._body, self.status, self.text, self._raise = body, status, text, raise_json

    def json(self):
        if self._raise:
            raise ValueError("no json")
        return self._body

    def raise_for_status(self):
        if self.status >= 400:
            raise RuntimeError(f"HTTP {self.status}")


class FakeHttp:
    """Routes by URL: onboarding URLs contain 'ingest-hours'."""

    def __init__(self, collector=None, onboarding=None):
        self.collector = list(collector or [])
        self.onboarding = list(onboarding or [])
        self.calls = []

    def __call__(self, url, json=None, timeout=None):
        self.calls.append((url, json))
        queue = self.onboarding if "ingest-hours" in url else self.collector
        item = queue.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


OK = {"result": "ok", "rowsAdded": 3, "rowsReplaced": {"2026-06-16": 0}, "dates": ["2026-06-16"]}
LOCKED = {"result": "error", "code": "LOCKED", "retryable": True}
URL = "https://example.invalid/exec"


def _shifts(tmp_path):
    return pr.parse_csv(_csv(tmp_path, _line()))[0]


def _run(shifts, http, tmp_path, also=True, tok_paths=None, sleeps=None):
    out = []
    code = pr.run_post(
        shifts,
        URL,
        "dummy-roster-token",
        also_onboarding=also,
        onboarding_token_paths=tok_paths if tok_paths is not None else [tmp_path / "hours.txt"],
        http_post=http,
        sleep=(sleeps.append if sleeps is not None else (lambda s: None)),
        out=out.append,
    )
    return code, "\n".join(out)


@pytest.fixture
def hours_token(tmp_path):
    p = tmp_path / "hours.txt"
    p.write_text("dummy-hours-token", encoding="ascii")
    return p


# ---- parsing


def test_header_detected_after_preamble(tmp_path):
    shifts, skipped = pr.parse_csv(_csv(tmp_path, _line()))
    assert len(shifts) == 1 and skipped == 0


def test_missing_header_raises(tmp_path):
    p = tmp_path / "x.csv"
    p.write_text("a,b\n1,2\n", encoding="utf-8")
    with pytest.raises(pr.RosterError, match="First name"):
        pr.parse_csv(p)


def test_missing_column_raises(tmp_path):
    p = tmp_path / "x.csv"
    p.write_text("First name,Last name\nA,B\n", encoding="utf-8")
    with pytest.raises(pr.RosterError, match="missing expected column"):
        pr.parse_csv(p)


def test_date_parse():
    assert pr.to_iso_date("16-Jun-2026") == "2026-06-16"
    assert pr.to_iso_date("1-Jan-2027") == "2027-01-01"
    assert pr.to_iso_date("2026-06-16") == "2026-06-16"


def test_leave_and_placeholder_rows_skipped(tmp_path):
    p = _csv(
        tmp_path, _line(), _line(start="", end="", hours="0"), _line(hours="0"), _line(email="")
    )
    shifts, skipped = pr.parse_csv(p)
    assert len(shifts) == 1 and skipped == 3


@pytest.mark.parametrize(
    "raw,want",
    [
        ("9:00", "09:00"),
        ("09:00:00", "09:00"),
        ("9:00 AM", "09:00"),
        ("9:00 pm", "21:00"),
        ("12:00 AM", "00:00"),
        ("12:30 PM", "12:30"),
        ("17:30", "17:30"),
        ("0:05", "00:05"),
    ],
)
def test_time_normalisation(raw, want):
    assert pr.normalise_time(raw) == want


@pytest.mark.parametrize("raw", ["25:00", "9", "nine", "13:00 PM", "09:60", ""])
def test_bad_time_rejected(raw):
    with pytest.raises(ValueError):
        pr.normalise_time(raw)


def test_bad_time_fails_dry_run_naming_csv_line(tmp_path, capsys):
    p = _csv(tmp_path, _line(), _line(start="whenever"))
    with pytest.raises(pr.RosterError, match=r"CSV line \d+: unrecognised time 'whenever'"):
        pr.parse_csv(p)
    assert pr.main([str(p), "--dry-run"]) == 2
    assert "whenever" in capsys.readouterr().out


def test_parsed_times_are_normalised(tmp_path):
    s = pr.parse_csv(_csv(tmp_path, _line(start="9:00 AM", end="5:30 pm")))[0][0]
    assert (s["start"], s["end"]) == ("09:00", "17:30")


# ---- payload shape


def test_collector_rows_shape_has_no_department_or_legacy_keys(tmp_path):
    rows = pr.collector_rows(_shifts(tmp_path))
    assert rows == [
        {
            "email": "test.person@example.invalid",
            "name": "Test Person",
            "date": "2026-06-16",
            "start": "09:00",
            "end": "17:30",
            "hours": 8.0,
            "location": "Dummy Cafe",
        }
    ]
    assert "department" not in rows[0]


def test_collector_payload_body(tmp_path):
    http = FakeHttp(collector=[FakeResp(OK)])
    pr.post_collector(
        pr.collector_rows(_shifts(tmp_path)), URL, "dummy-roster-token", http_post=http
    )
    url, body = http.calls[0]
    assert url == URL
    assert set(body) == {"source", "kind", "token", "rows"}
    assert body["source"] == "brighthr_roster" and body["kind"] == "roster"
    assert body["token"] == "dummy-roster-token"


def test_onboarding_shape_matches_legacy(tmp_path):
    o = pr.onboarding_shifts(pr.parse_csv(_csv(tmp_path, _line(start="9:00 AM")))[0])[0]
    assert set(o) == {
        "email",
        "first_name",
        "last_name",
        "date",
        "start",
        "end",
        "hours",
        "location",
    }
    assert o["start"] == "9:00 AM"  # raw string preserved, as the old script posted it


# ---- config / token


def test_exec_url_from_deployment_json(tmp_path):
    p = tmp_path / "d.json"
    p.write_text(json.dumps({"execUrl": "https://example.invalid/x/exec"}), encoding="utf-8")
    assert pr.read_exec_url(p) == "https://example.invalid/x/exec"


def test_real_deployment_json_has_exec_url():
    assert pr.read_exec_url().startswith("https://script.google.com/macros/s/")


def test_token_file_read_and_missing(tmp_path):
    p = tmp_path / ".roster-token.txt"
    with pytest.raises(pr.RosterError, match="init-token"):
        pr.read_token(p)
    p.write_text("dummy-token-value\n", encoding="ascii")
    assert pr.read_token(p) == "dummy-token-value"


def test_init_token_generates_32_chars_copies_prints_fingerprint_only_and_clears(tmp_path):
    p = tmp_path / ".roster-token.txt"
    events, out = [], []
    fp = pr.init_token(
        p,
        copy=lambda t: events.append(("copy", t)),
        clear=lambda: events.append(("clear",)),
        confirm=lambda prompt: events.append(("confirm",)),
        out=out.append,
    )
    token = p.read_text(encoding="ascii")
    assert len(token) == 32 and token.isalnum()
    assert events == [("copy", token), ("confirm",), ("clear",)]  # cleared only after confirm
    assert fp == pr.fingerprint(token) and len(fp) == 8
    assert token not in "\n".join(out) and fp in "\n".join(out)


def test_init_token_clears_clipboard_even_if_confirm_aborted(tmp_path):
    events = []

    def boom(_):
        raise KeyboardInterrupt

    with pytest.raises(KeyboardInterrupt):
        pr.init_token(
            tmp_path / "t.txt",
            copy=lambda t: None,
            clear=lambda: events.append("clear"),
            confirm=boom,
            out=lambda s: None,
        )
    assert events == ["clear"]


def test_regenerated_tokens_differ(tmp_path):
    a = pr.generate_token()
    assert a != pr.generate_token()


# ---- LOCKED retry (RB6)


def test_locked_then_ok_retries_once_after_60s(tmp_path):
    http, sleeps = FakeHttp(collector=[FakeResp(LOCKED), FakeResp(OK)]), []
    body = pr.post_collector([{}], URL, "dummy", http_post=http, sleep=sleeps.append)
    assert body["rowsAdded"] == 3 and sleeps == [60] and len(http.calls) == 2


def test_locked_twice_fails_with_rerun_message(tmp_path, hours_token):
    http, sleeps = (
        FakeHttp(
            collector=[FakeResp(LOCKED), FakeResp(LOCKED)], onboarding=[FakeResp({"result": "ok"})]
        ),
        [],
    )
    code, out = _run(_shifts(tmp_path), http, tmp_path, sleeps=sleeps)
    assert code == 1 and sleeps == [60]
    assert "Re-run the shortcut" in out and "\033[91m" in out


def test_unauthorized_not_retried():
    http, sleeps = FakeHttp(collector=[FakeResp({"result": "error", "code": "UNAUTHORIZED"})]), []
    with pytest.raises(pr.PostFailed) as ei:
        pr.post_collector([{}], URL, "dummy", http_post=http, sleep=sleeps.append)
    assert ei.value.code == "UNAUTHORIZED" and sleeps == [] and len(http.calls) == 1


# ---- dual post (RB7)


def test_both_posts_succeed(tmp_path, hours_token):
    http = FakeHttp(collector=[FakeResp(OK)], onboarding=[FakeResp({"result": "ok"})])
    code, out = _run(_shifts(tmp_path), http, tmp_path)
    assert code == 0 and len(http.calls) == 2
    assert "Collector: OK" in out and "rowsAdded=3" in out and "Onboarding: OK" in out
    onboarding_url, body = http.calls[1]
    assert "endpoint=ingest-hours&token=dummy-hours-token" in onboarding_url
    assert body["compute"] is True and body["source"] == "brighthr-roster" and "shifts" in body


def test_collector_failure_does_not_skip_onboarding(tmp_path, hours_token):
    http = FakeHttp(
        collector=[FakeResp({"result": "error", "code": "UNAUTHORIZED"})],
        onboarding=[FakeResp({"result": "ok"})],
    )
    code, out = _run(_shifts(tmp_path), http, tmp_path)
    assert code == 1 and len(http.calls) == 2
    assert "Collector: FAILED" in out and "Onboarding: OK" in out


def test_onboarding_failure_still_reports_collector_ok(tmp_path, hours_token):
    http = FakeHttp(collector=[FakeResp(OK)], onboarding=[FakeResp(None, status=500)])
    code, out = _run(_shifts(tmp_path), http, tmp_path)
    assert code == 1 and "Collector: OK" in out and "Onboarding: FAILED" in out


def test_collector_network_error_does_not_skip_onboarding_and_redacts_token(tmp_path, hours_token):
    http = FakeHttp(
        collector=[ConnectionError(f"boom {URL} dummy-roster-token")],
        onboarding=[FakeResp({"result": "ok"})],
    )
    code, out = _run(_shifts(tmp_path), http, tmp_path)
    assert code == 1 and "Onboarding: OK" in out
    assert "dummy-roster-token" not in out and "***" in out


def test_missing_legacy_token_is_reported_red_but_collector_ran(tmp_path):
    http = FakeHttp(collector=[FakeResp(OK)])
    code, out = _run(_shifts(tmp_path), http, tmp_path)  # hours.txt absent
    assert (
        code == 1
        and "Collector: OK" in out
        and "Onboarding: FAILED" in out
        and len(http.calls) == 1
    )


def test_flag_false_skips_onboarding(tmp_path):
    http = FakeHttp(collector=[FakeResp(OK)])
    code, out = _run(_shifts(tmp_path), http, tmp_path, also=False)
    assert code == 0 and len(http.calls) == 1 and "Onboarding" not in out


def test_flag_default_is_true_and_read_at_call_time(tmp_path, hours_token, monkeypatch):
    assert pr.ALSO_POST_ONBOARDING is True
    monkeypatch.setattr(pr, "ALSO_POST_ONBOARDING", False)
    http = FakeHttp(collector=[FakeResp(OK)])
    out = []
    pr.run_post(_shifts(tmp_path), URL, "dummy", http_post=http, out=out.append)
    assert len(http.calls) == 1


def test_onboarding_http_error_redacts_url_token(tmp_path):
    http = FakeHttp(
        onboarding=[
            RuntimeError("fail https://x/exec?endpoint=ingest-hours&token=dummy-hours-token")
        ]
    )
    with pytest.raises(pr.PostFailed) as ei:
        pr.post_onboarding([], URL, "dummy-hours-token", http_post=http)
    assert "dummy-hours-token" not in str(ei.value)
