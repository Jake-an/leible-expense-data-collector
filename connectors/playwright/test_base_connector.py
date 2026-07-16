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

import json

import pytest

import base_connector as b


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
