#!/usr/bin/env bash
# Live-verification deploy/promote gate (PreToolUse hook).
#
# Blocks outward "ship" actions (clasp deploy, git push, wrangler/firebase/netlify/
# vercel/sam/serverless deploy) unless the /__test endpoint reports "pass": true.
# Dev-only pushes (e.g. `clasp push`) and all non-ship commands pass straight through.
#
# Config (env):  HARNESS_TEST_URL  (required to pass the gate)
#                HARNESS_TEST_KEY  (optional; appended as ?key=… — never printed)
# Override:      SKIP_VERIFY=1     (bypass — for docs-only / emergency pushes)
set -u

cmd="${CLAUDE_TOOL_INPUT:-}"

# Only gate ship/promote actions.
if ! printf '%s' "$cmd" | grep -qE 'clasp[[:space:]]+deploy|git[[:space:]]+push|wrangler[[:space:]]+deploy|firebase[[:space:]]+deploy|netlify[[:space:]]+deploy|vercel[[:space:]]+(deploy|--prod)|sam[[:space:]]+deploy|serverless[[:space:]]+deploy'; then
  exit 0
fi

# Override via env var OR inline in the command (the latter works through the hook,
# since an inline `SKIP_VERIFY=1 git push` does not export into the hook's own env).
if [ "${SKIP_VERIFY:-}" = "1" ] || printf '%s' "$cmd" | grep -q 'SKIP_VERIFY=1'; then
  echo "live-verify: SKIP_VERIFY=1 set — bypassing /__test gate." >&2
  exit 0
fi

if [ -z "${HARNESS_TEST_URL:-}" ]; then
  echo "BLOCKED: deploy/promote requires live verification, but HARNESS_TEST_URL is not set." >&2
  echo "  Set HARNESS_TEST_URL (and HARNESS_TEST_KEY), or export SKIP_VERIFY=1 to override." >&2
  exit 1
fi

url="$HARNESS_TEST_URL"
if [ -n "${HARNESS_TEST_KEY:-}" ]; then
  case "$url" in
    *\?*) url="${url}&key=${HARNESS_TEST_KEY}" ;;
    *)    url="${url}?key=${HARNESS_TEST_KEY}" ;;
  esac
fi

resp="$(curl -fsS --max-time 30 "$url" 2>/dev/null)"
if printf '%s' "$resp" | grep -qE '"pass"[[:space:]]*:[[:space:]]*true'; then
  echo "live-verify: /__test green — deploy/promote allowed." >&2
  exit 0
fi

echo "BLOCKED: /__test did not pass — fix live verification before deploy/promote (or SKIP_VERIFY=1 to override)." >&2
echo "  endpoint: ${HARNESS_TEST_URL}" >&2   # keyed URL is in \$url, not printed
echo "  response: ${resp:0:300}" >&2
exit 1
