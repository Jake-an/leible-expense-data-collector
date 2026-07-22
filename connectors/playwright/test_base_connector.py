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

import pytest

import base_connector as b
import ordermentum
import fresh_and_chill


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
        "# a full-line comment\n"
        "\n"
        "FOO=bar\n"
        "QUOTED=\"hello world\"\n"
        "SINGLE_QUOTED='single value'\n"
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

    def __init__(self, *, logged_in_result=True, credentials_login_result=True,
                 credentials_login_raises=None):
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
    conn.LOGIN_SETTLE_TRIES = 5  # small, so a bug that didn't mock wait_for_timeout would be obvious
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
    page = _FakeFCPage(url="https://shop.zupply.com.au/orders", email_input=True, password_input=True)
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
