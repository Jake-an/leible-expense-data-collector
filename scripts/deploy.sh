#!/usr/bin/env bash
#
# deploy.sh — GAS deployment. Run this when GAS coding is FINISHED (not tied to
# git push). It is deploy-only: it does NOT touch git. (Git push happens
# separately, only when Jake says "lets stop here" — see scripts/pre_push_sync.py.)
#
#   bash scripts/deploy.sh              # push + version + redeploy (normal)
#   bash scripts/deploy.sh --push-only  # push ONLY — live /exec keeps serving the old version
#
# --push-only exists for OAuth scope changes. push/version/redeploy is otherwise
# atomic, which would leave a window where live /exec serves code needing a scope
# nobody has consented to yet — and /exec is the sole ingest path. So: push-only,
# authorize the new scope in the editor, THEN run the full deploy.
#
# Single-deployment-ID rule (Jake): config/deployment.json holds the ONE web-app
# deployment id. First run creates it once; every run after updates that same
# deployment in place via `clasp redeploy`, keeping the /exec URL stable. We never
# call create-deployment when an id already exists.
#
set -euo pipefail

cd "$(dirname "$0")/.."
STAMP="$(date '+%Y-%m-%d %H:%M')"

PUSH_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --push-only) PUSH_ONLY=1 ;;
    *) echo "usage: deploy.sh [--push-only]" >&2; exit 2 ;;
  esac
done

# .clasp.json is gitignored — regenerate from the tracked config if missing
# (e.g. on a fresh clone).
if [ ! -f .clasp.json ]; then
  echo "==> writing .clasp.json from config/clasp.json"
  node -e 'const c=require("./config/clasp.json");require("fs").writeFileSync(".clasp.json",JSON.stringify({scriptId:c.scriptId,rootDir:c.rootDir,parentId:c.parentId},null,2))'
fi

DID="$(node -e 'try{console.log(require("./config/deployment.json").deploymentId||"")}catch(e){console.log("")}')"

# Rollback anchor: whatever version the deployment serves RIGHT NOW. Capture it
# before we change anything — after redeploy this is unrecoverable from clasp,
# and "just roll back" is not actionable without the number.
PREV_VER=""
if [ -n "$DID" ]; then
  PREV_VER="$(clasp list-deployments 2>/dev/null | grep -F "$DID" | grep -oE '@[0-9]+' | tail -1 | tr -d '@' || true)"
  if [ -n "$PREV_VER" ]; then
    echo "==> rollback anchor: deployment currently serves version $PREV_VER"
    echo "    to undo this deploy:  clasp redeploy $DID -V $PREV_VER -d 'rollback to $PREV_VER'"
  else
    echo "==> WARNING: could not read the currently-served version — no rollback anchor." >&2
  fi
fi

echo "==> clasp push"
clasp push -f

if [ "$PUSH_ONLY" -eq 1 ]; then
  echo ""
  echo "==> --push-only: STOPPING before create-version/redeploy."
  echo "    Live /exec still serves version ${PREV_VER:-<unchanged>} — pushing alone cannot move it."
  echo "    Next: authorize any new scopes in the editor, then run: bash scripts/deploy.sh"
  exit 0
fi

echo "==> clasp create-version"
VER="$(clasp create-version "deploy $STAMP" 2>&1 | grep -oE '[0-9]+' | tail -1)"
if [ -z "${VER:-}" ]; then echo "ERROR: could not determine version number" >&2; exit 1; fi
echo "    version $VER"

if [ -n "$DID" ]; then
  echo "==> redeploy existing deployment $DID @ version $VER"
  clasp redeploy "$DID" -V "$VER" -d "deploy $STAMP"
else
  echo "==> first deploy — creating the single deployment"
  OUT="$(clasp create-deployment -V "$VER" -d "deploy $STAMP" 2>&1)"
  echo "$OUT"
  DID="$(printf '%s\n' "$OUT" | grep -oE 'AKfyc[A-Za-z0-9_-]+' | head -1)"
  if [ -z "$DID" ]; then
    echo "ERROR: could not parse new deploymentId from clasp output above." >&2
    echo "       Run 'clasp list-deployments', put the AKfyc... id into config/deployment.json, and re-run." >&2
    exit 1
  fi
fi

# Record the single deployment id + /exec URL back into tracked config.
EXEC_URL="https://script.google.com/macros/s/${DID}/exec"
node -e 'const fs=require("fs");const p="./config/deployment.json";const c=require(p);c.deploymentId=process.argv[1];c.execUrl=process.argv[2];fs.writeFileSync(p,JSON.stringify(c,null,2)+"\n")' "$DID" "$EXEC_URL"

echo ""
echo "==> DEPLOYED (single deployment):"
echo "    deploymentId: $DID"
echo "    web app /exec: $EXEC_URL"
echo "    (Set GAS_EXEC_URL to that /exec URL for the Playwright connectors.)"
