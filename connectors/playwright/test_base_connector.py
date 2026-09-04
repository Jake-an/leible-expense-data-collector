"""
Tests for base_connector.resolve_exec_url() — the GAS_EXEC_URL env override /
config/deployment.json fallback introduced to make connectors self-sufficient
outside the .cmd wrapper (see docs/rules.md and lets-plan-this-for-spicy-kite.md
Step 2).

Bare `import base_connector` resolves via pytest's default prepend import mode
(this file lives beside base_connector.py in connectors/playwright/, same as
scripts/test_execute.py:17-18's setup, just without needing sys.path.insert
since there's no package __init__.py in the way).
"""

import itertools
import json
import time
from pathlib import Path

import base_connector as b
import food_dairy_co
import fresh_and_chill
import ordermentum
import pytest


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    """Every test controls GAS_EXEC_URL explicitly — never inherit the real env."""
    monkeypatch.delenv("GAS_EXEC_URL", raising=False)


def test_env_wins_over_deployment_json(monkeypatch, tmp_path):
    monkeypatch.setenv("GAS_EXEC_URL", "https://example.com/exec-from-env")
    deployment = tmp_path / "deployment.json"
    deployment.write_text(json.dumps({"execUrl": "https://example.com/exec-from-file"}))
    monkeypatch.setattr(b, "DEPLOYMENT_JSON", deployment)

    assert b.resolve_exec_url() == "https://example.com/exec-from-env"


def test_falls_back_to_deployment_json_when_env_unset(monkeypatch, tmp_path):
    deployment = tmp_path / "deployment.json"
    deployment.write_text(json.dumps({"execUrl": "https://example.com/exec-from-file"}))
    monkeypatch.setattr(b, "DEPLOYMENT_JSON", deployment)

    assert b.resolve_exec_url() == "https://example.com/exec-from-file"


def test_whitespace_only_env_falls_through_to_deployment_json(monkeypatch, tmp_path):
    monkeypatch.setenv("GAS_EXEC_URL", "   ")
    deployment = tmp_path / "deployment.json"
    deployment.write_text(json.dumps({"execUrl": "https://example.com/exec-from-file"}))
    monkeypatch.setattr(b, "DEPLOYMENT_JSON", deployment)

    assert b.resolve_exec_url() == "https://example.com/exec-from-file"


def test_missing_deployment_json_returns_empty_string(monkeypatch, tmp_path):
    missing = tmp_path / "does_not_exist.json"
    monkeypatch.setattr(b, "DEPLOYMENT_JSON", missing)

    assert b.resolve_exec_url() == ""


def test_malformed_deployment_json_returns_empty_string(monkeypatch, tmp_path):
    deployment = tmp_path / "deployment.json"
    deployment.write_text("{not valid json")
    monkeypatch.setattr(b, "DEPLOYMENT_JSON", deployment)

    assert b.resolve_exec_url() == ""


def test_repo_root_deployment_json_exists():
    """Pin: if config/deployment.json ever moves, this test fails loudly instead
    of resolve_exec_url() silently falling through to ''."""
    assert (b.REPO_ROOT / "config" / "deployment.json").exists()


# --------------------------------------------------------------------------- #
# Headless auto-login — plan-autologin.md (2026-07-20)
# --------------------------------------------------------------------------- #

# ---- .env parser (load_env_file / get_credential) ------------------------- #


def test_load_env_file_parses_comments_blank_lines_and_quotes(monkeypatch, tmp_path):
    env_path = tmp_path / ".env"
    env_path.write_text(
        "# a full-line comment\n\nFOO=bar\nQUOTED=\"hello world\"\nSINGLE_QUOTED='single value'\n"
    )
    monkeypatch.setattr(b, "ENV_FILE", env_path)
    monkeypatch.setattr(b, "_env_cache", None)

    values = b.load_env_file()

    assert values["FOO"] == "bar"
    assert values["QUOTED"] == "hello world"
    assert values["SINGLE_QUOTED"] == "single value"
    assert not any("comment" in v for v in values.values())


def test_load_env_file_os_environ_wins_over_file_value(monkeypatch, tmp_path):
    env_path = tmp_path / ".env"
    env_path.write_text("FOO=from_file\n")
    monkeypatch.setattr(b, "ENV_FILE", env_path)
    monkeypatch.setattr(b, "_env_cache", None)
    monkeypatch.setenv("FOO", "from_os_environ")

    values = b.load_env_file()

    assert values["FOO"] == "from_os_environ"


def test_load_env_file_password_with_equals_hash_and_spaces_survives_intact(monkeypatch, tmp_path):
    """A password containing '=', '#' and spaces must NOT be corrupted by an
    inline-'#' strip or a naive split('='): first-'=' split + no inline-'#'
    strip is what keeps it intact. A corrupted password would masquerade as
    'creds rejected' and false-trip the circuit-breaker."""
    env_path = tmp_path / ".env"
    raw_password = "p@ss=word#1 with spaces"
    env_path.write_text(f"FRESH_AND_CHILL_YORK_PASSWORD={raw_password}\n")
    monkeypatch.setattr(b, "ENV_FILE", env_path)
    monkeypatch.setattr(b, "_env_cache", None)
    monkeypatch.delenv("FRESH_AND_CHILL_YORK_PASSWORD", raising=False)

    values = b.load_env_file()

    assert values["FRESH_AND_CHILL_YORK_PASSWORD"] == raw_password


def test_get_credential_prefers_os_environ_then_falls_back_to_env_file(monkeypatch, tmp_path):
    env_path = tmp_path / ".env"
    env_path.write_text("ONLY_IN_FILE=file_value\n")
    monkeypatch.setattr(b, "ENV_FILE", env_path)
    monkeypatch.setattr(b, "_env_cache", None)
    monkeypatch.delenv("ONLY_IN_FILE", raising=False)
    monkeypatch.delenv("NOWHERE", raising=False)

    assert b.get_credential("ONLY_IN_FILE") == "file_value"
    assert b.get_credential("NOWHERE") is None


def test_get_credential_os_environ_only_no_file_entry(monkeypatch, tmp_path):
    env_path = tmp_path / ".env"
    env_path.write_text("")
    monkeypatch.setattr(b, "ENV_FILE", env_path)
    monkeypatch.setattr(b, "_env_cache", None)
    monkeypatch.setenv("ENV_ONLY_VAR", "env_only_value")

    assert b.get_credential("ENV_ONLY_VAR") == "env_only_value"


# ---- _attempt_auto_login orchestrator (mocked Page/context) --------------- #


class _FakeStorageState:
    """Records storage_state(path=...) calls instead of writing real files."""

    def __init__(self):
        self.calls: list[str] = []

    def __call__(self, path):
        self.calls.append(path)


class _FakeContext:
    def __init__(self):
        self.storage_state = _FakeStorageState()


class _FakePage:
    def __init__(self):
        self.context = _FakeContext()


class _AutoLoginConnector(b.BaseConnector):
    """Minimal BaseConnector subclass for exercising _attempt_auto_login
    without a real browser."""

    NAME = "autologintest"
    SOURCE = "autologintest"
    LOGIN_URL = "https://example.invalid/login"

    def __init__(
        self, *, logged_in_result=True, credentials_login_result=True, credentials_login_raises=None
    ):
        super().__init__(exec_url="https://example.invalid/exec")
        self._logged_in_result = logged_in_result
        self._credentials_login_result = credentials_login_result
        self._credentials_login_raises = credentials_login_raises
        self.credentials_login_calls = 0
        self.is_logged_in_calls = 0

    def is_logged_in(self, page):
        self.is_logged_in_calls += 1
        return self._logged_in_result

    def credentials_login(self, page):
        self.credentials_login_calls += 1
        if self._credentials_login_raises is not None:
            raise self._credentials_login_raises
        return self._credentials_login_result


@pytest.fixture
def isolated_sessions(monkeypatch, tmp_path):
    """Redirect SESSIONS_DIR (and therefore breaker markers + session_path)
    to a tmp dir so tests never touch the real sessions/ directory."""
    sessions_dir = tmp_path / "sessions"
    monkeypatch.setattr(b, "SESSIONS_DIR", sessions_dir)
    return sessions_dir


def test_attempt_auto_login_success_saves_session_and_clears_breaker(isolated_sessions):
    """A tripped breaker blocks immediately (step 1 of the orchestrator) —
    so the meaningful assertion for a successful attempt is that the
    breaker stays untripped and the session gets saved."""
    key = "autologintest"
    assert not b._breaker_tripped(key)

    conn = _AutoLoginConnector(logged_in_result=True, credentials_login_result=True)
    page = _FakePage()

    conn._attempt_auto_login(page, key, creds_present=True)  # must not raise

    assert conn.credentials_login_calls == 1
    assert not b._breaker_tripped(key)
    assert page.context.storage_state.calls == [str(conn.session_path)]


def test_attempt_auto_login_trusts_credentials_login_return_value_only(isolated_sessions):
    """Regression (security review, HIGH+MEDIUM, same root cause): the
    orchestrator must NOT make a second, independent is_logged_in(page)
    probe after credentials_login() already returned True. Proof: stub
    is_logged_in to return False (which a redundant second call would read
    as 'still not logged in' and WRONGLY trip the breaker) while
    credentials_login returns True (verified success). The auto-login must
    still succeed, the breaker must stay untripped, and is_logged_in must
    never be called at all — credentials_login's return value is the sole
    source of truth."""
    key = "autologintest"
    conn = _AutoLoginConnector(logged_in_result=False, credentials_login_result=True)
    page = _FakePage()

    conn._attempt_auto_login(page, key, creds_present=True)  # must not raise

    assert conn.credentials_login_calls == 1
    assert conn.is_logged_in_calls == 0  # no redundant second probe
    assert not b._breaker_tripped(key)  # NOT false-tripped
    assert page.context.storage_state.calls == [str(conn.session_path)]


def test_attempt_auto_login_rejected_trips_breaker_and_blocks(isolated_sessions):
    key = "autologintest"
    conn = _AutoLoginConnector(logged_in_result=False, credentials_login_result=False)
    page = _FakePage()

    with pytest.raises(b.BlockedError):
        conn._attempt_auto_login(page, key, creds_present=True)

    assert conn.credentials_login_calls == 1
    assert b._breaker_tripped(key)


def test_attempt_auto_login_breaker_already_tripped_blocks_without_attempt(isolated_sessions):
    key = "autologintest"
    b._trip_breaker(key, "already tripped before this run")
    conn = _AutoLoginConnector()
    page = _FakePage()

    with pytest.raises(b.BlockedError):
        conn._attempt_auto_login(page, key, creds_present=True)

    assert conn.credentials_login_calls == 0


def test_attempt_auto_login_no_creds_blocks_without_tripping(isolated_sessions):
    key = "autologintest"
    conn = _AutoLoginConnector()
    page = _FakePage()

    with pytest.raises(b.BlockedError):
        conn._attempt_auto_login(page, key, creds_present=False)

    assert conn.credentials_login_calls == 0
    assert not b._breaker_tripped(key)


def test_attempt_auto_login_transient_login_error_blocks_without_tripping(isolated_sessions):
    key = "autologintest"
    conn = _AutoLoginConnector(credentials_login_raises=b.TransientLoginError("network blip"))
    page = _FakePage()

    with pytest.raises(b.BlockedError):
        conn._attempt_auto_login(page, key, creds_present=True)

    assert conn.credentials_login_calls == 1
    assert not b._breaker_tripped(key)


# ---- post() — GAS ingest bridge: fail loud on logical rejection ----------- #
#
# doPost returns HTTP 200 even on a logical rejection ({"result":"error",...})
# or an uncaught server exception (see docs/schema.md, ARCHITECTURE.md POST
# Bridge Contract). post() must not treat either as success — this is the
# fix for the Tuga/Butterboy silent-drop incident.
#
# IngestError doesn't exist yet at RED time; reference it as `b.IngestError`
# inside each test body (not a top-level import) so a missing symbol fails as
# a clean assertion/AttributeError, not a whole-file collection ImportError.


class _FakePostResponse:
    """Stand-in for requests.Response: raise_for_status() is a no-op (real
    transport-layer errors are a separate, already-covered path). json()
    either returns the parsed body or raises ValueError like the real method
    does on non-JSON content; .text mirrors the raw body."""

    def __init__(self, *, json_body=None, json_raises=False, text=""):
        self._json_body = json_body
        self._json_raises = json_raises
        self.text = text

    def raise_for_status(self):
        pass

    def json(self):
        if self._json_raises:
            raise ValueError("Expecting value: line 1 column 1 (char 0)")
        return self._json_body


def test_post_returns_body_on_result_ok(monkeypatch):
    fake_resp = _FakePostResponse(json_body={"result": "ok", "rowsAdded": 3})
    monkeypatch.setattr(b.requests, "post", lambda *a, **kw: fake_resp)
    conn = _AutoLoginConnector()

    result = conn.post([{"date": "2026-07-01", "total": 1.0, "invoice_ref": "INV-1"}])

    assert result == {"result": "ok", "rowsAdded": 3}


def test_post_raises_ingest_error_on_result_error(monkeypatch):
    fake_resp = _FakePostResponse(
        json_body={"result": "error", "message": "row 0 missing invoice_ref"}
    )
    monkeypatch.setattr(b.requests, "post", lambda *a, **kw: fake_resp)
    conn = _AutoLoginConnector()

    with pytest.raises(b.IngestError) as exc_info:
        conn.post([{"date": "2026-07-01", "total": 1.0, "invoice_ref": ""}])

    assert "row 0 missing invoice_ref" in str(exc_info.value)


def test_post_raises_ingest_error_on_non_json_200_body(monkeypatch):
    """A 200 with an unparseable body (e.g. an HTML error page from GAS) is
    NOT confirmable success — must raise, not fall back to {"result":"ok"}
    the way the old lenient `except ValueError` used to."""
    fake_resp = _FakePostResponse(json_raises=True, text="<html>error</html>")
    monkeypatch.setattr(b.requests, "post", lambda *a, **kw: fake_resp)
    conn = _AutoLoginConnector()

    with pytest.raises(b.IngestError):
        conn.post([{"date": "2026-07-01", "total": 1.0, "invoice_ref": "INV-1"}])


def test_post_sends_ingest_token_in_payload(monkeypatch):
    """doPost requires a token on EVERY payload (security audit 2026-09-04).

    Asserted explicitly because the other post tests resolve the credential
    from the developer's real .env — they would keep passing on this machine
    even if post() stopped sending the token entirely.
    """
    captured = {}

    def _capture(*a, **kw):
        captured.update(kw.get("json") or {})
        return _FakePostResponse(json_body={"result": "ok", "rowsAdded": 1})

    monkeypatch.setattr(
        b, "get_credential", lambda name: "tok-123" if name == "GAS_READ_TOKEN" else None
    )
    monkeypatch.setattr(b.requests, "post", _capture)
    conn = _AutoLoginConnector()

    conn.post([{"date": "2026-07-01", "total": 1.0, "invoice_ref": "INV-1"}])

    assert captured.get("token") == "tok-123"


def test_post_without_ingest_token_raises_and_makes_no_http_call(monkeypatch):
    """A missing credential must fail BEFORE the request. Posting tokenless
    would leak the rows to an endpoint that will only reject them, and the
    bare `unauthorized` back would not say which credential is absent here."""
    calls = []
    monkeypatch.setattr(b, "get_credential", lambda name: None)
    monkeypatch.setattr(b.requests, "post", lambda *a, **kw: calls.append((a, kw)))
    conn = _AutoLoginConnector()

    with pytest.raises(b.IngestError) as exc_info:
        conn.post([{"date": "2026-07-01", "total": 1.0, "invoice_ref": "INV-1"}])

    assert "GAS_READ_TOKEN" in str(exc_info.value)
    assert calls == [], "no HTTP call may be made without a token"


def test_post_reports_rejected_token_distinctly(monkeypatch):
    """UNAUTHORIZED means the two copies of the secret diverged — it must not
    read as a row-data problem, and it is not degradable."""
    monkeypatch.setattr(b, "get_credential", lambda name: "stale-token")
    monkeypatch.setattr(
        b.requests,
        "post",
        lambda *a, **kw: _FakePostResponse(
            json_body={"result": "error", "code": "UNAUTHORIZED", "message": "unauthorized"}
        ),
    )
    conn = _AutoLoginConnector()

    with pytest.raises(b.IngestError) as exc_info:
        conn.post([{"date": "2026-07-01", "total": 1.0, "invoice_ref": "INV-1"}])

    msg = str(exc_info.value)
    assert "UNAUTHORIZED" in msg
    assert "diverged" in msg


def test_post_empty_rows_returns_skipped_and_makes_no_http_call(monkeypatch):
    calls = []
    monkeypatch.setattr(b.requests, "post", lambda *a, **kw: calls.append((a, kw)))
    conn = _AutoLoginConnector()

    result = conn.post([])

    assert result == {"result": "skipped", "reason": "no rows"}
    assert calls == []


def test_ingest_error_is_distinct_from_blocked_and_transient_login_error():
    """Proves run()'s existing except clauses (BlockedError, TransientLoginError)
    cannot accidentally swallow an ingest rejection."""
    assert issubclass(b.IngestError, Exception)
    assert not issubclass(b.IngestError, b.BlockedError)
    assert not issubclass(b.IngestError, b.TransientLoginError)


# ---- attended success clears the breaker (+ .env-typo warning) ------------ #


def test_clear_breaker_with_warning_clears_and_warns_when_tripped_with_creds(
    isolated_sessions, monkeypatch, capsys
):
    key = "autologintest"
    b._trip_breaker(key, "prior unattended rejection")
    monkeypatch.setenv("AUTOLOGINTEST_EMAIL", "someone@example.com")
    monkeypatch.setenv("AUTOLOGINTEST_PASSWORD", "hunter2")

    b._clear_breaker_with_warning(
        "autologintest", key, "AUTOLOGINTEST_EMAIL", "AUTOLOGINTEST_PASSWORD"
    )

    assert not b._breaker_tripped(key)
    captured = capsys.readouterr()
    assert "WARNING" in captured.err
    assert "hunter2" not in captured.err  # never log credential values


def test_clear_breaker_with_warning_no_warning_when_not_previously_tripped(
    isolated_sessions, monkeypatch, capsys
):
    key = "autologintest"
    monkeypatch.setenv("AUTOLOGINTEST_EMAIL", "someone@example.com")
    monkeypatch.setenv("AUTOLOGINTEST_PASSWORD", "hunter2")

    b._clear_breaker_with_warning(
        "autologintest", key, "AUTOLOGINTEST_EMAIL", "AUTOLOGINTEST_PASSWORD"
    )

    captured = capsys.readouterr()
    assert "WARNING" not in captured.err


# ---- Ordermentum auth_state (transient must cover 5xx AND network-throw) -- #


class _FakeOMResponse:
    def __init__(self, status):
        self.status = status


class _FakeOMRequest:
    def __init__(self, status=None, raises=None):
        self._status = status
        self._raises = raises

    def get(self, url):
        if self._raises is not None:
            raise self._raises
        return _FakeOMResponse(self._status)


class _FakeOMPage:
    def __init__(self, status=None, raises=None):
        self.request = _FakeOMRequest(status=status, raises=raises)


def test_ordermentum_auth_state_ok_on_200():
    conn = ordermentum.OrdermentumConnector(exec_url="https://example.invalid/exec")
    assert conn.auth_state(_FakeOMPage(status=200)) == "ok"


def test_ordermentum_auth_state_dead_on_401():
    conn = ordermentum.OrdermentumConnector(exec_url="https://example.invalid/exec")
    assert conn.auth_state(_FakeOMPage(status=401)) == "dead"


def test_ordermentum_auth_state_dead_on_403():
    conn = ordermentum.OrdermentumConnector(exec_url="https://example.invalid/exec")
    assert conn.auth_state(_FakeOMPage(status=403)) == "dead"


def test_ordermentum_auth_state_transient_on_5xx():
    conn = ordermentum.OrdermentumConnector(exec_url="https://example.invalid/exec")
    assert conn.auth_state(_FakeOMPage(status=503)) == "transient"


def test_ordermentum_auth_state_transient_on_network_error():
    """page.request.get raises (not returns) on a network failure — the
    probe must be wrapped in try/except so this resolves to 'transient'
    instead of crashing the run."""
    conn = ordermentum.OrdermentumConnector(exec_url="https://example.invalid/exec")
    assert conn.auth_state(_FakeOMPage(raises=RuntimeError("connection reset"))) == "transient"


# ---- Ordermentum credentials_login SPA-auth poll (live-verification fix) -- #
#
# Live 2026-07-20: Ordermentum's auth XHR is async — /v1/profiles/ read 401
# at t+0s immediately post-submit, then 200 at t+1s (url -> /dashboard in the
# same window). A single immediate is_logged_in() check false-reports a
# CORRECT password as rejected. credentials_login() now polls
# LOGIN_SETTLE_TRIES times, 1s apart, before concluding rejection.
#
# These tests stub _form_login (no real browser/network) and page.request.get
# (via a status-sequence fake), and use a small instance-level
# LOGIN_SETTLE_TRIES plus a counting no-op wait_for_timeout so they run in
# well under a second — never a real multi-second sleep.


class _FakePollResponse:
    def __init__(self, status):
        self.status = status


class _FakePollRequest:
    """Returns each status in `status_sequence` in order, then repeats the
    final value forever (models the XHR settling and staying settled)."""

    def __init__(self, status_sequence):
        self._iter = itertools.chain(status_sequence, itertools.repeat(status_sequence[-1]))

    def get(self, url):
        return _FakePollResponse(next(self._iter))


class _FakePollPage:
    def __init__(self, status_sequence):
        self.request = _FakePollRequest(status_sequence)
        self.wait_for_timeout_calls = 0

    def wait_for_timeout(self, ms):
        # Counting no-op — proves the poll loop drives the assertions below
        # without ever actually sleeping.
        self.wait_for_timeout_calls += 1


def test_ordermentum_credentials_login_polls_past_initial_401(monkeypatch):
    """Proves the poll survives misses past t+0 instead of giving up
    immediately: 401, 401, then 200 — must still return True."""
    monkeypatch.setenv("ORDERMENTUM_EMAIL", "someone@example.com")
    monkeypatch.setenv("ORDERMENTUM_PASSWORD", "correct-password")
    monkeypatch.setattr(ordermentum, "_form_login", lambda *a, **kw: None)

    conn = ordermentum.OrdermentumConnector(exec_url="https://example.invalid/exec")
    conn.LOGIN_SETTLE_TRIES = (
        5  # small, so a bug that didn't mock wait_for_timeout would be obvious
    )
    page = _FakePollPage(status_sequence=[401, 401, 200])

    start = time.monotonic()
    result = conn.credentials_login(page)
    elapsed = time.monotonic() - start

    assert result is True
    assert page.wait_for_timeout_calls == 2  # slept after miss #1 and #2, not after the #3 success
    assert elapsed < 1.0  # no real sleep happened


def test_ordermentum_credentials_login_returns_false_when_never_settles(monkeypatch):
    """Genuine rejection: is_logged_in stays False (401) for the whole poll
    window -> credentials_login returns False (not an exception, not a
    false 'success' from giving up early)."""
    monkeypatch.setenv("ORDERMENTUM_EMAIL", "someone@example.com")
    monkeypatch.setenv("ORDERMENTUM_PASSWORD", "wrong-password")
    monkeypatch.setattr(ordermentum, "_form_login", lambda *a, **kw: None)

    conn = ordermentum.OrdermentumConnector(exec_url="https://example.invalid/exec")
    conn.LOGIN_SETTLE_TRIES = 3
    page = _FakePollPage(status_sequence=[401])  # stays 401 forever

    start = time.monotonic()
    result = conn.credentials_login(page)
    elapsed = time.monotonic() - start

    assert result is False
    assert page.wait_for_timeout_calls == 3  # full window exhausted
    assert elapsed < 1.0  # no real sleep happened


# ---- Fresh & Chill dead/transient classifier ------------------------------ #


class _FakeElement:
    pass


class _FakeFCPage:
    def __init__(self, url, orders_link_present=False, email_input=False, password_input=False):
        self.url = url
        self._orders_link_present = orders_link_present
        self._email_input = email_input
        self._password_input = password_input

    def query_selector(self, selector):
        if selector == "a[href='/orders']" and self._orders_link_present:
            return _FakeElement()
        if selector == "input[type='email']" and self._email_input:
            return _FakeElement()
        if selector == "input[type='password']" and self._password_input:
            return _FakeElement()
        return None


def test_fc_classify_ok_when_orders_link_present():
    conn = fresh_and_chill.FreshAndChillConnector(exec_url="https://example.invalid/exec")
    page = _FakeFCPage(url="https://shop.zupply.com.au/orders", orders_link_present=True)
    assert conn._classify_shop_state(page) == "ok"


def test_fc_classify_dead_on_sign_in_redirect():
    conn = fresh_and_chill.FreshAndChillConnector(exec_url="https://example.invalid/exec")
    page = _FakeFCPage(url="https://shop.zupply.com.au/users/sign_in")
    assert conn._classify_shop_state(page) == "dead"


def test_fc_classify_dead_on_devise_form_present_without_redirect():
    conn = fresh_and_chill.FreshAndChillConnector(exec_url="https://example.invalid/exec")
    page = _FakeFCPage(
        url="https://shop.zupply.com.au/orders", email_input=True, password_input=True
    )
    assert conn._classify_shop_state(page) == "dead"


def test_fc_classify_transient_on_other_non_orders_state():
    """500 / error / partial load — neither logged in, redirected to
    sign-in, nor showing the Devise form — must be 'transient', not 'dead',
    so run_unattended never attempts auto-login (breaker untouched)."""
    conn = fresh_and_chill.FreshAndChillConnector(exec_url="https://example.invalid/exec")
    page = _FakeFCPage(url="https://shop.zupply.com.au/500")
    assert conn._classify_shop_state(page) == "transient"


# ---- F&C run_unattended per-shop loop isolation (Bug 3 regression) -------- #


class _FakeFCPageStub:
    """Bare-minimum Playwright Page stand-in for run_unattended's own
    page.goto() calls. The connector's DOM-reading methods (is_logged_in,
    read_shop_invoices) are overridden per-test below so they never touch
    this object's internals."""

    def goto(self, url, wait_until=None):
        pass


class _FakeFCBrowserContext:
    def __init__(self):
        self.storage_state = _FakeStorageState()
        self.closed = False

    def new_page(self):
        return _FakeFCPageStub()

    def close(self):
        self.closed = True


class _FakeFCBrowser:
    def __init__(self):
        self.closed = False

    def new_context(self, storage_state=None):
        return _FakeFCBrowserContext()

    def close(self):
        self.closed = True


class _FakeFCChromium:
    def launch(self, headless=True):
        return _FakeFCBrowser()


class _FakeFCPw:
    def __init__(self):
        self.chromium = _FakeFCChromium()


class _FakeSyncPlaywrightCM:
    def __enter__(self):
        return _FakeFCPw()

    def __exit__(self, *exc_info):
        return False


def _fake_sync_playwright():
    return _FakeSyncPlaywrightCM()


class _MultiShopReadFailureConnector(fresh_and_chill.FreshAndChillConnector):
    """is_logged_in always True (every saved session already valid) so this
    test isolates Bug 3 — a post-login read crashing the whole per-shop
    loop — from the separately-tested auto-login orchestration."""

    def __init__(self, *, raising_shop_key: str, exec_url: str):
        super().__init__(exec_url=exec_url)
        self._raising_shop_key = raising_shop_key
        self.read_calls: list[str] = []

    def is_logged_in(self, page):
        return True

    def read_shop_invoices(self, page, location):
        self.read_calls.append(location)
        if location == fresh_and_chill.SHOPS[self._raising_shop_key]:
            raise RuntimeError("simulated wait_for_selector('table') timeout")
        return [{"date": "2026-07-01", "total": 12.5, "invoice_ref": "PO#1", "location": location}]


def test_fc_run_unattended_isolates_one_shops_read_failure_from_others(monkeypatch, tmp_path):
    """Regression (security review, MEDIUM, Bug 3): a raise from
    read_shop_invoices for ONE shop must not abort the whole per-shop loop.
    That shop lands in blocked_shops; every healthy sibling shop must still
    be read and its rows included in the POST payload."""
    sessions_dir = tmp_path / "sessions"
    sessions_dir.mkdir()
    monkeypatch.setattr(fresh_and_chill, "SESSIONS_DIR", sessions_dir)
    monkeypatch.setattr(fresh_and_chill, "sync_playwright", _fake_sync_playwright)

    # Every shop needs an existing session file so run_unattended doesn't
    # skip it via the (unrelated) "no session file" branch.
    for shop_key in fresh_and_chill.SHOPS:
        (sessions_dir / f"fresh_and_chill_{shop_key}.json").write_text("{}")

    raising_shop_key = "north"
    conn = _MultiShopReadFailureConnector(
        raising_shop_key=raising_shop_key, exec_url="https://example.invalid/exec"
    )

    posted: dict = {}

    def fake_post(rows):
        posted["rows"] = rows
        return {"result": "ok"}

    monkeypatch.setattr(conn, "post", fake_post)

    result = conn.run_unattended()

    raising_location = fresh_and_chill.SHOPS[raising_shop_key]
    other_locations = [loc for key, loc in fresh_and_chill.SHOPS.items() if key != raising_shop_key]

    assert raising_location in result["blocked"]
    for loc in other_locations:
        assert loc in conn.read_calls  # every OTHER shop was still attempted
    assert posted["rows"], "healthy shops' rows must still be POSTed"
    assert all(row["location"] != raising_location for row in posted["rows"])
    assert all(row["location"] in other_locations for row in posted["rows"])


# ---- F&C _auto_login_shop settle-poll parity (live-verification fix) ------ #
#
# Applies the same defensive poll as ordermentum.py's SPA fix, uniformly,
# even though Devise's server-rendered redirect is less race-prone than an
# async SPA XHR. These tests stub _form_login (no real browser/network) and
# is_logged_in via a status-sequence fake page, with a counting no-op
# wait_for_timeout so they run in well under a second.


class _FakeFCPollPage:
    """Yields each entry of `logged_in_sequence` (one per is_logged_in()
    call) via query_selector, then repeats the final value forever."""

    def __init__(self, logged_in_sequence):
        self._iter = itertools.chain(logged_in_sequence, itertools.repeat(logged_in_sequence[-1]))
        self.wait_for_timeout_calls = 0
        self.context = _FakeContext()

    def query_selector(self, selector):
        if selector == "a[href='/orders']":
            return _FakeElement() if next(self._iter) else None
        return None

    def wait_for_timeout(self, ms):
        self.wait_for_timeout_calls += 1


def test_fc_auto_login_shop_polls_past_initial_dom_miss(monkeypatch, tmp_path):
    """Proves _auto_login_shop polls past an initial DOM-miss instead of
    giving up immediately: False, False, then True -> must return True."""
    sessions_dir = tmp_path / "sessions"
    monkeypatch.setattr(b, "SESSIONS_DIR", sessions_dir)
    monkeypatch.setattr(fresh_and_chill, "SESSIONS_DIR", sessions_dir)
    monkeypatch.setattr(fresh_and_chill, "_form_login", lambda *a, **kw: None)
    monkeypatch.setenv("FRESH_AND_CHILL_YORK_EMAIL", "someone@example.com")
    monkeypatch.setenv("FRESH_AND_CHILL_YORK_PASSWORD", "correct-password")

    conn = fresh_and_chill.FreshAndChillConnector(exec_url="https://example.invalid/exec")
    conn.LOGIN_SETTLE_TRIES = 5
    page = _FakeFCPollPage(logged_in_sequence=[False, False, True])

    start = time.monotonic()
    result = conn._auto_login_shop(page, "york")
    elapsed = time.monotonic() - start

    assert result is True
    assert page.wait_for_timeout_calls == 2  # slept after miss #1 and #2, not after the #3 success
    assert elapsed < 1.0  # no real sleep happened
    assert not b._breaker_tripped("fresh_and_chill_york")
    assert page.context.storage_state.calls == [str(conn._session_path("york"))]


def test_fc_auto_login_shop_returns_false_when_never_settles(monkeypatch, tmp_path):
    """Genuine rejection: DOM never shows logged-in for the whole poll
    window -> returns False (never raises BlockedError), and trips the
    per-shop breaker only after the full window is exhausted."""
    sessions_dir = tmp_path / "sessions"
    monkeypatch.setattr(b, "SESSIONS_DIR", sessions_dir)
    monkeypatch.setattr(fresh_and_chill, "SESSIONS_DIR", sessions_dir)
    monkeypatch.setattr(fresh_and_chill, "_form_login", lambda *a, **kw: None)
    monkeypatch.setenv("FRESH_AND_CHILL_NORTH_EMAIL", "someone@example.com")
    monkeypatch.setenv("FRESH_AND_CHILL_NORTH_PASSWORD", "wrong-password")

    conn = fresh_and_chill.FreshAndChillConnector(exec_url="https://example.invalid/exec")
    conn.LOGIN_SETTLE_TRIES = 3
    page = _FakeFCPollPage(logged_in_sequence=[False])  # never logs in

    start = time.monotonic()
    result = conn._auto_login_shop(page, "north")
    elapsed = time.monotonic() - start

    assert result is False
    assert page.wait_for_timeout_calls == 3  # full window exhausted
    assert elapsed < 1.0  # no real sleep happened
    assert b._breaker_tripped("fresh_and_chill_north")


# ---- Ordermentum venue mapping + invoice pagination ---------------------- #
#
# Two live defects found 2026-08-24, both of which produced NO error and NO
# short-payload signal — the connector reported success while money went
# missing:
#
#   1. VENUES["Leible North"] pointed at retailer 5dc2803b-… ('Apex
#      international group pty ltd'), the DEAD one of the two North Sydney
#      accounts. It resolves, returns HTTP 200, and has zero SUPPLIER_FILTER
#      suppliers — so North produced no rows at all, for any supplier, ever,
#      while the other three shops looked healthy. >= $11,931.92 of real spend
#      never reached the Sheet.
#   2. _get_invoices requested pageNo=1 only. The North venue's Tuga history is
#      437 invoices across 18 pages; Fuel Bakery 53 across 3.

VENUES_NORTH_ID = "2476a89b-060e-4308-9a18-558bbf475782"


class _PagedOMRequest:
    """Models /v2/invoices pagination and /v2/marketplaces, recording calls."""

    def __init__(self, pages=None, page_status=None, suppliers=None, meta_totalpages=True):
        self.pages = pages or {}
        self.page_status = page_status or {}
        self.suppliers = suppliers if suppliers is not None else []
        self.meta_totalpages = meta_totalpages
        self.calls = []

    def get(self, url, params=None):
        params = params or {}
        self.calls.append((url, dict(params)))
        outer = self

        if "marketplaces" in url:

            class MarketResp:
                status = 200

                @staticmethod
                def json():
                    return {"data": outer.suppliers}

            return MarketResp()

        page_no = int(params.get("pageNo", 1))
        page_status = outer.page_status.get(page_no, 200)

        class InvoiceResp:
            status = page_status

            @staticmethod
            def json():
                body = {"data": outer.pages.get(page_no, [])}
                if outer.meta_totalpages:
                    body["meta"] = {"totalPages": len(outer.pages), "pageNo": page_no}
                return body

        return InvoiceResp()


class _PagedOMPage:
    def __init__(self, request):
        self.request = request


def _inv(n):
    return {"date": "2026-08-03T00:00:00Z", "total": 10.0, "number": f"INV{n}"}


def _om_conn():
    return ordermentum.OrdermentumConnector(exec_url="https://example.invalid/exec")


def test_ordermentum_north_venue_is_the_live_legend_star_account():
    """The whole defect in one assertion. Apex resolves and returns 200, so
    nothing but this mapping distinguishes it from the live account."""
    assert VENUES_NORTH_ID in ordermentum.VENUES
    assert ordermentum.VENUES[VENUES_NORTH_ID] == "Leible North"


def test_ordermentum_dead_north_account_is_not_mapped():
    dead = "5dc2803b-51e2-4415-8484-edb4cdf40517"
    assert dead not in ordermentum.VENUES
    assert dead in ordermentum.RETIRED_VENUES


def test_ordermentum_all_four_shops_are_mapped_exactly_once():
    assert sorted(ordermentum.VENUES.values()) == [
        "Leible Crowsnest",
        "Leible North",
        "Leible Pitt",
        "Leible York",
    ]


def test_ordermentum_read_invoices_rejects_a_retired_venue(monkeypatch):
    """Re-adding a retired id must fail loudly, not silently return nothing."""
    dead = next(iter(ordermentum.RETIRED_VENUES))
    monkeypatch.setattr(ordermentum, "VENUES", {dead: "Leible North"})
    with pytest.raises(ValueError, match="retired retailer"):
        _om_conn().read_invoices(_PagedOMPage(_PagedOMRequest()))


def test_ordermentum_get_invoices_follows_every_page():
    """pageNo=1 alone truncated at 25. Real case: 53 Fuel Bakery invoices."""
    req = _PagedOMRequest(
        pages={
            1: [_inv(i) for i in range(25)],
            2: [_inv(i) for i in range(25, 50)],
            3: [_inv(i) for i in range(50, 53)],
        }
    )
    got = _om_conn()._get_invoices(_PagedOMPage(req), "venue", "supplier")
    assert len(got) == 53, "must read all 3 pages, not just the first 25"
    assert [i["number"] for i in got] == [f"INV{i}" for i in range(53)]
    assert [c[1]["pageNo"] for c in req.calls] == ["1", "2", "3"]


def test_ordermentum_get_invoices_stops_when_meta_is_missing():
    """No usable meta -> behave exactly as before (one page), never guess."""
    req = _PagedOMRequest(pages={1: [_inv(1)], 2: [_inv(2)]}, meta_totalpages=False)
    got = _om_conn()._get_invoices(_PagedOMPage(req), "venue", "supplier")
    assert len(got) == 1
    assert len(req.calls) == 1


def test_ordermentum_get_invoices_keeps_what_it_read_when_a_page_fails():
    """A partial read is real invoices; doPost dedups on source+invoice_ref, so
    the next run fills the gap. Discarding them would turn a transient blip into
    permanent data loss."""
    req = _PagedOMRequest(pages={1: [_inv(1)], 2: [_inv(2)], 3: [_inv(3)]}, page_status={2: 503})
    got = _om_conn()._get_invoices(_PagedOMPage(req), "venue", "supplier")
    assert [i["number"] for i in got] == ["INV1"]


def test_ordermentum_get_invoices_respects_the_runaway_limit(monkeypatch):
    monkeypatch.setattr(ordermentum, "INVOICE_PAGE_LIMIT", 2)
    req = _PagedOMRequest(pages={n: [_inv(n)] for n in range(1, 6)})
    got = _om_conn()._get_invoices(_PagedOMPage(req), "venue", "supplier")
    assert len(got) == 2
    assert len(req.calls) == 2


def test_ordermentum_barren_venue_warns_loudly(monkeypatch, capsys):
    """A venue returning zero matching suppliers is exactly what the dead North
    account looked like for months. Every venue in VENUES is there because it
    orders, so zero is a broken mapping — not a quiet week."""
    monkeypatch.setattr(ordermentum, "VENUES", {"live-id": "Leible North"})
    rows = _om_conn().read_invoices(_PagedOMPage(_PagedOMRequest(suppliers=[])))
    assert rows == []
    err = capsys.readouterr().err
    assert "returned NO matching suppliers" in err
    assert "Leible North" in err


def test_ordermentum_healthy_venue_does_not_warn(monkeypatch, capsys):
    """The warning must not cry wolf, or it gets ignored like every other one."""
    monkeypatch.setattr(ordermentum, "VENUES", {"live-id": "Leible North"})
    req = _PagedOMRequest(
        pages={1: [_inv(1)]},
        suppliers=[
            {
                "supplierId": "s1",
                "supplier": {"name": "Fuel Bakery Pty Ltd", "tradingName": "Fuel Bakery"},
            }
        ],
    )
    rows = _om_conn().read_invoices(_PagedOMPage(req))
    assert len(rows) == 1
    assert rows[0]["location"] == "Leible North"
    assert rows[0]["supplier"] == "Fuel Bakery"
    assert "returned NO matching suppliers" not in capsys.readouterr().err


def test_ordermentum_cancelled_invoices_still_excluded(monkeypatch):
    """Pagination must not have quietly dropped the cancelled-invoice filter."""
    monkeypatch.setattr(ordermentum, "VENUES", {"live-id": "Leible North"})
    req = _PagedOMRequest(
        pages={1: [_inv(1), dict(_inv(2), cancelled=True)]},
        suppliers=[{"supplierId": "s1", "supplier": {"name": "Fuel Bakery", "tradingName": ""}}],
    )
    rows = _om_conn().read_invoices(_PagedOMPage(req))
    assert [r["invoice_ref"] for r in rows] == ["INV1"]


# ---- --dry-run: read everything, POST nothing ---------------------------- #
#
# Added 2026-08-24 for the Ordermentum North Sydney backfill. A mapping fix can
# change how many rows a run produces by orders of magnitude, and doPost has no
# undo — so there had to be a way to see the rows before writing them.
#
# The load-bearing property is the negative one: dry_run must never reach
# post(). A dry run that quietly posts is worse than no dry run at all, because
# it is trusted.


class _DryRunConnector(b.BaseConnector):
    NAME = "dryrun_probe"
    SOURCE = "dryrun_probe"
    LOGIN_URL = "https://example.invalid/login"

    def __init__(self, rows, **kw):
        super().__init__(**kw)
        self._rows = rows
        self.post_calls = []

    def is_logged_in(self, page):
        return True

    def auth_state(self, page):
        return "ok"

    def read_invoices(self, page):
        return self._rows

    def post(self, rows):
        self.post_calls.append(rows)
        return {"result": "ok", "rowsAdded": len(rows)}


def _patch_playwright(monkeypatch, tmp_path):
    """Stub the browser so run() can be exercised without Playwright."""

    class _Ctx:
        def new_page(self):
            class _P:
                def goto(self, *a, **kw):
                    return None

            return _P()

        def storage_state(self, path=None):
            Path(path).write_text("{}", encoding="utf-8")

        def close(self):
            return None

    class _PW:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(b, "sync_playwright", lambda: _PW())
    monkeypatch.setattr(b.BaseConnector, "_new_context", lambda self, pw, headed: _Ctx())
    monkeypatch.setattr(b, "SESSIONS_DIR", tmp_path / "sessions")
    monkeypatch.setattr(b, "REPO_ROOT", tmp_path)


_DRY_ROWS = [
    {
        "date": "2026-08-03",
        "total": 10.5,
        "invoice_ref": "A1",
        "supplier": "Fuel Bakery",
        "location": "Leible North",
    },
    {
        "date": "2026-08-10",
        "total": 20.0,
        "invoice_ref": "A2",
        "supplier": "Fuel Bakery",
        "location": "Leible North",
    },
    {
        "date": "2026-08-10",
        "total": 5.25,
        "invoice_ref": "B1",
        "supplier": "Tuga",
        "location": "Leible Pitt",
    },
]


def test_dry_run_never_posts(monkeypatch, tmp_path):
    """THE assertion. Everything else about a dry run is cosmetic."""
    _patch_playwright(monkeypatch, tmp_path)
    conn = _DryRunConnector(_DRY_ROWS, exec_url="https://example.invalid/exec")
    result = conn.run(dry_run=True)
    assert conn.post_calls == [], "dry run must not reach post()"
    assert result["post"]["result"] == "dry-run"
    assert result["rows"] == 3


def test_real_run_does_post(monkeypatch, tmp_path):
    """Guards the inverse: the dry-run branch must not swallow a real run."""
    _patch_playwright(monkeypatch, tmp_path)
    conn = _DryRunConnector(_DRY_ROWS, exec_url="https://example.invalid/exec")
    result = conn.run(dry_run=False)
    assert len(conn.post_calls) == 1
    assert result["post"]["result"] == "ok"


def test_dry_run_needs_no_exec_url(monkeypatch, tmp_path):
    """_require_exec_url() must not block a dry run — it posts nothing, so a
    missing GAS URL is irrelevant, and demanding one makes the safe path harder
    to reach than the dangerous one."""
    _patch_playwright(monkeypatch, tmp_path)
    conn = _DryRunConnector(_DRY_ROWS, exec_url=None)
    conn.exec_url = None
    result = conn.run(dry_run=True)
    assert result["post"]["result"] == "dry-run"
    assert conn.post_calls == []


def test_real_run_still_requires_exec_url(monkeypatch, tmp_path):
    _patch_playwright(monkeypatch, tmp_path)
    conn = _DryRunConnector(_DRY_ROWS, exec_url=None)
    conn.exec_url = None
    with pytest.raises(RuntimeError, match="No GAS /exec URL"):
        conn.run(dry_run=False)


def test_dry_run_writes_the_full_dump_to_downloads(monkeypatch, tmp_path):
    """downloads/ is gitignored; the dump is business data and must land there,
    not in the terminal and not anywhere tracked."""
    _patch_playwright(monkeypatch, tmp_path)
    conn = _DryRunConnector(_DRY_ROWS, exec_url="https://example.invalid/exec")
    conn.run(dry_run=True)
    dump = tmp_path / "downloads" / "dryrun_probe-dryrun.json"
    assert dump.exists()
    assert json.loads(dump.read_text(encoding="utf-8")) == _DRY_ROWS


def test_dry_run_breaks_down_by_location_and_supplier(monkeypatch, tmp_path, capsys):
    """The on-screen summary is what a person checks a venue mapping against —
    per-shop counts and totals are exactly what exposed the North gap."""
    _patch_playwright(monkeypatch, tmp_path)
    conn = _DryRunConnector(_DRY_ROWS, exec_url="https://example.invalid/exec")
    conn.run(dry_run=True)
    out = capsys.readouterr().out
    assert "NOTHING POSTED" in out
    assert "Leible North" in out
    assert "Leible Pitt" in out
    assert "30.50" in out, "North's two Fuel Bakery rows must be summed"
    assert "2026-08-03 .. 2026-08-10" in out, "date span per group"


def test_dry_run_handles_zero_rows(monkeypatch, tmp_path):
    """A connector that reads nothing must not crash the safety gate."""
    _patch_playwright(monkeypatch, tmp_path)
    conn = _DryRunConnector([], exec_url="https://example.invalid/exec")
    result = conn.run(dry_run=True)
    assert result["rows"] == 0
    assert conn.post_calls == []


# ---- --since: backfill scope control ------------------------------------- #
#
# Fixing the Ordermentum North venue turned a routine run into 2,640 rows across
# three years. Two things make posting all of that a bad idea: GAS appends row
# by row inside a 6-minute limit, and ARCHIVE_RETENTION_DAYS (183) sweeps
# anything older than ~6 months into _archive without it ever reaching Summary.
# --since is the scope control, applied in run() so no subclass can forget it.

_SINCE_ROWS = [
    {
        "date": "2025-04-02",
        "total": 100.0,
        "invoice_ref": "OLD1",
        "supplier": "Tuga",
        "location": "Leible North",
    },
    {
        "date": "2026-06-28",
        "total": 200.0,
        "invoice_ref": "EDGE0",
        "supplier": "Tuga",
        "location": "Leible North",
    },
    {
        "date": "2026-06-29",
        "total": 300.0,
        "invoice_ref": "EDGE1",
        "supplier": "Fuel Bakery",
        "location": "Leible North",
    },
    {
        "date": "2026-08-24",
        "total": 400.0,
        "invoice_ref": "NEW1",
        "supplier": "Fuel Bakery",
        "location": "Leible North",
    },
]


def test_since_keeps_only_rows_on_or_after_the_cutoff(monkeypatch, tmp_path):
    _patch_playwright(monkeypatch, tmp_path)
    conn = _DryRunConnector(_SINCE_ROWS, exec_url="https://example.invalid/exec")
    conn.run(since="2026-06-29")
    posted = conn.post_calls[0]
    assert [r["invoice_ref"] for r in posted] == ["EDGE1", "NEW1"]


def test_since_is_inclusive_of_the_cutoff_date(monkeypatch, tmp_path):
    """Off-by-one here silently drops a whole day of invoices."""
    _patch_playwright(monkeypatch, tmp_path)
    conn = _DryRunConnector(_SINCE_ROWS, exec_url="https://example.invalid/exec")
    conn.run(since="2026-06-29")
    assert "EDGE1" in [r["invoice_ref"] for r in conn.post_calls[0]]


def test_since_absent_posts_everything(monkeypatch, tmp_path):
    _patch_playwright(monkeypatch, tmp_path)
    conn = _DryRunConnector(_SINCE_ROWS, exec_url="https://example.invalid/exec")
    conn.run()
    assert len(conn.post_calls[0]) == 4


def test_since_rejects_a_malformed_date(monkeypatch, tmp_path):
    """Fail loudly. A silently-ignored --since posts three years of rows."""
    _patch_playwright(monkeypatch, tmp_path)
    conn = _DryRunConnector(_SINCE_ROWS, exec_url="https://example.invalid/exec")
    for bad in ("2026-6-29", "29-06-2026", "yesterday", "2026/06/29", ""):
        with pytest.raises(ValueError, match="--since must be YYYY-MM-DD"):
            conn.run(since=bad)
    assert conn.post_calls == []


def test_since_keeps_undated_rows(monkeypatch, tmp_path):
    """An undated row is a parsing problem worth seeing. Dropping it here would
    hide it behind a flag that reads as 'just narrowing the window'."""
    _patch_playwright(monkeypatch, tmp_path)
    rows = _SINCE_ROWS + [
        {"date": "", "total": 9.0, "invoice_ref": "NODATE", "supplier": "?", "location": "?"}
    ]
    conn = _DryRunConnector(rows, exec_url="https://example.invalid/exec")
    conn.run(since="2026-06-29")
    assert "NODATE" in [r["invoice_ref"] for r in conn.post_calls[0]]


def test_since_composes_with_dry_run(monkeypatch, tmp_path, capsys):
    """--dry-run must report exactly what --since would post, or the preview is
    not a preview of the thing being approved."""
    _patch_playwright(monkeypatch, tmp_path)
    conn = _DryRunConnector(_SINCE_ROWS, exec_url="https://example.invalid/exec")
    result = conn.run(dry_run=True, since="2026-06-29")
    assert conn.post_calls == []
    assert result["rows"] == 2
    dump = json.loads(
        (tmp_path / "downloads" / "dryrun_probe-dryrun.json").read_text(encoding="utf-8")
    )
    assert [r["invoice_ref"] for r in dump] == ["EDGE1", "NEW1"]
    assert "700.00" in capsys.readouterr().out


# ---- attended login must RECOVER a dead session (2026-09-02 FDCo outage) --- #
#
# _new_context loads sessions/<name>.json unconditionally, so an expired
# session is already in the browser by the time the attended branch runs. Two
# defects compounded there: the branch gated on is_logged_in (presence, not
# validity) so the login prompt never fired, and nobody cleared the dead
# tokens, so the SPA booted against them and rendered a blank page with no
# login form. 46 scheduled runs and ~45 days of invoices were lost behind it.


class _FakeAttendedContext:
    def __init__(self):
        self.storage_state = _FakeStorageState()
        self.cleared_cookies = 0
        self.closed = False
        self.page = None

    def new_page(self):
        self.page = _FakeAttendedPage(self)
        return self.page

    def clear_cookies(self):
        self.cleared_cookies += 1

    def close(self):
        self.closed = True


class _FakeAttendedPage:
    def __init__(self, context):
        self.context = context
        self.gotos: list[str] = []
        self.evaluated: list[str] = []

    def goto(self, url, wait_until=None):
        self.gotos.append(url)

    def evaluate(self, script, *args):
        self.evaluated.append(script)
        return None


class _FakeAttendedBrowser:
    def __init__(self):
        self.context = _FakeAttendedContext()
        self.headless = None

    def new_context(self, storage_state=None):
        return self.context


class _FakeAttendedChromium:
    def __init__(self):
        self.browser = _FakeAttendedBrowser()

    def launch(self, headless=True):
        self.browser.headless = headless
        return self.browser


class _FakeAttendedPw:
    def __init__(self):
        self.chromium = _FakeAttendedChromium()


class _FakeAttendedCM:
    def __init__(self, pw):
        self._pw = pw

    def __enter__(self):
        return self._pw

    def __exit__(self, *exc_info):
        return False


class _AttendedProbeConnector(b.BaseConnector):
    """Reports a caller-chosen auth_state; records whether the human login
    prompt fired. post() is stubbed so run() needs no live exec URL."""

    NAME = "attended_probe"
    SOURCE = "attended_probe"
    LOGIN_URL = "https://portal.invalid/"

    def __init__(self, state):
        super().__init__("https://example.invalid/exec")
        self._state = state
        self.login_prompts = 0

    def auth_state(self, page):
        return self._state

    def is_logged_in(self, page):  # must NOT be what the attended branch gates on
        raise AssertionError("attended branch must gate on auth_state, not is_logged_in")

    def _attended_login(self, page):
        self.login_prompts += 1

    def read_invoices(self, page):
        return []

    def post(self, rows):
        return {"result": "ok", "rowsAdded": 0}


def _run_attended(monkeypatch, tmp_path, state):
    pw = _FakeAttendedPw()
    monkeypatch.setattr(b, "SESSIONS_DIR", tmp_path / "sessions")
    monkeypatch.setattr(b, "sync_playwright", lambda: _FakeAttendedCM(pw))
    conn = _AttendedProbeConnector(state)
    conn.run(attended=True)
    return conn, pw.chromium.browser.context


def test_attended_dead_session_is_cleared_before_the_login_prompt(monkeypatch, tmp_path):
    """A dead session must be wiped out of the live context AND the page
    reloaded, so the portal shows its real login form instead of a blank SPA."""
    _conn, ctx = _run_attended(monkeypatch, tmp_path, "dead")
    assert ctx.cleared_cookies == 1
    assert any("localStorage" in s for s in ctx.page.evaluated)
    assert len(ctx.page.gotos) == 2  # initial load + reload after the wipe


def test_attended_dead_session_still_prompts_the_human(monkeypatch, tmp_path):
    """The prompt is the whole point of --attended: it must fire on a dead
    session. A stale refreshToken used to suppress it entirely."""
    conn, _ctx = _run_attended(monkeypatch, tmp_path, "dead")
    assert conn.login_prompts == 1


def test_attended_live_session_is_never_destroyed(monkeypatch, tmp_path):
    """A healthy session must not be wiped or re-prompted — --attended stays
    a no-op re-save when the saved session is still good."""
    conn, ctx = _run_attended(monkeypatch, tmp_path, "ok")
    assert ctx.cleared_cookies == 0
    assert conn.login_prompts == 0
    assert len(ctx.page.gotos) == 1


def test_attended_transient_prompts_but_does_not_wipe(monkeypatch, tmp_path):
    """A 5xx/network blip is not proof the session is dead. Prompt (the human
    is right there) but never destroy a session that may still be valid."""
    conn, ctx = _run_attended(monkeypatch, tmp_path, "transient")
    assert conn.login_prompts == 1
    assert ctx.cleared_cookies == 0


# ---- FDCo is_logged_in must prove the token WORKS, not that it exists ----- #


def _jwt(exp_epoch):
    import base64 as _b64

    body = _b64.urlsafe_b64encode(json.dumps({"exp": exp_epoch}).encode()).decode().rstrip("=")
    return "header." + body + ".signature"


class _FakeCognitoResponse:
    def __init__(self, status, id_token=None):
        self.status = status
        self._id_token = id_token

    def json(self):
        if self._id_token is None:
            return {"message": "Refresh Token has expired"}
        return {"AuthenticationResult": {"IdToken": self._id_token}}


class _FakeFDCoPage:
    def __init__(self, id_token=None, refresh_token=None, refresh_response=None):
        self._ls = {".idToken": id_token, ".refreshToken": refresh_token}
        self._refresh_response = refresh_response
        self.refresh_calls = 0
        self.request = self

    def evaluate(self, script, suffix):
        return self._ls.get(suffix)

    def post(self, url, headers=None, data=None):
        self.refresh_calls += 1
        return self._refresh_response


def _fdco():
    return food_dairy_co.FoodDairyCoConnector(exec_url="https://example.invalid/exec")


def test_fdco_expired_token_with_stale_refresh_token_is_not_logged_in():
    """The exact 2026-07-18 state: both keys present, both dead. Reading
    presence alone returned True here and suppressed the login prompt."""
    page = _FakeFDCoPage(
        id_token=_jwt(int(time.time()) - 3600),
        refresh_token="stale-refresh-token",
        refresh_response=_FakeCognitoResponse(400),
    )
    assert _fdco().is_logged_in(page) is False


def test_fdco_expired_token_and_no_refresh_token_is_not_logged_in():
    page = _FakeFDCoPage(id_token=_jwt(int(time.time()) - 3600), refresh_token=None)
    assert _fdco().is_logged_in(page) is False


def test_fdco_valid_id_token_is_logged_in_without_calling_cognito():
    """A still-valid IdToken needs no network round trip."""
    page = _FakeFDCoPage(id_token=_jwt(int(time.time()) + 3600), refresh_token=None)
    assert _fdco().is_logged_in(page) is True
    assert page.refresh_calls == 0


def test_fdco_expired_token_but_working_refresh_is_logged_in():
    """Expired IdToken + a refresh token Cognito still honours = a live
    session. Must NOT force a needless attended re-login."""
    fresh_token = _jwt(int(time.time()) + 3600)
    page = _FakeFDCoPage(
        id_token=_jwt(int(time.time()) - 3600),
        refresh_token="good-refresh-token",
        refresh_response=_FakeCognitoResponse(200, id_token=fresh_token),
    )
    conn = _fdco()
    assert conn.is_logged_in(page) is True
    assert page.refresh_calls == 1
    assert conn._token == fresh_token  # cached, so the read path does not refetch
