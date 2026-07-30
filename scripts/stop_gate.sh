#!/usr/bin/env bash
# Stop gate — runs lint/build/test only when non-docs files actually changed.
# Wired as a Stop hook in .claude/settings.json.
#
# Exit codes: 0 = pass/skip; 2 = checks failed (blocks stop, feeds output back to Claude).
# Bypass: export SKIP_STOP_GATE=1 (docs-only sessions, emergencies).
#
# CHECKS is stack-specific. This is a Python (harness) + GAS project. The pre-stop
# gate is ruff lint/format (scripts/lint.sh — config in pyproject.toml) followed by
# the pytest suite (harness self-tests in scripts/test_execute.py + connector tests),
# then the GAS Node-mock suite (connectors/gas/test_code.js).
# Lint runs first (cheap, fails fast).
CHECKS=("bash scripts/lint.sh" "python -m pytest -q" "node connectors/gas/test_code.js")

[ -n "$SKIP_STOP_GATE" ] && exit 0

# Loop guard: if this hook already blocked once this turn, let the stop through.
INPUT=$(cat 2>/dev/null)
echo "$INPUT" | grep -q '"stop_hook_active":\s*true' && exit 0

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

# Only run when code-shaped changes exist (skip pure docs/markdown churn).
CHANGED=$(git status --porcelain -- . ':(exclude)*.md' ':(exclude)docs/**' 2>/dev/null)
[ -z "$CHANGED" ] && exit 0

for cmd in "${CHECKS[@]}"; do
  OUT=$($cmd 2>&1) || {
    echo "Stop gate failed: $cmd" >&2
    echo "$OUT" | tail -40 >&2
    exit 2
  }
done
exit 0
