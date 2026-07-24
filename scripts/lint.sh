#!/usr/bin/env bash
# lint.sh — one-command lint + format gate for the Python (Playwright) runtime.
# Config lives in pyproject.toml ([tool.ruff]). GAS code (connectors/gas/) is excluded.
#
# Autofix locally:   python -m ruff check --fix . && python -m ruff format .
# Check only (this): bash scripts/lint.sh
#
# Wired into the workflow via scripts/stop_gate.sh (Stop hook). Resilient by design:
# if ruff isn't installed it SKIPS with a hint rather than hard-blocking a machine
# that lacks dev deps — install with: python -m pip install -r requirements-dev.txt
set -u
cd "$(dirname "$0")/.." || exit 1

if ! python -m ruff --version >/dev/null 2>&1; then
  echo "lint: ruff not installed — skipping (install: python -m pip install -r requirements-dev.txt)" >&2
  exit 0
fi

echo "▶ ruff check" >&2
python -m ruff check . || exit 1
echo "▶ ruff format --check" >&2
python -m ruff format --check . || exit 1
echo "✓ lint clean" >&2
