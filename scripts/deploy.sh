#!/usr/bin/env bash
#
# deploy.sh — GAS deployment. Run this when GAS coding is FINISHED (not tied to
# git push). It is deploy-only: it does NOT touch git. (Git push happens
# separately, only when Jake says "lets stop here" — see scripts/pre_push_sync.py.)
#
#   bash scripts/deploy.sh
#
# Single-deployment-ID rule (Jake): config/deployment.json holds the ONE web-app
# deployment id. First run creates it once; every run after updates that same
# deployment in place via `clasp redeploy`, keeping the /exec URL stable. We never
# call create-deployment when an id already exists.
#
set -euo pipefail

cd "$(dirname "$0")/.."
STAMP="$(date '+%Y-%m-%d %H:%M')"

# .clasp.json is gitignored — regenerate from the tracked config if missing
# (e.g. on a fresh clone).
if [ ! -f .clasp.json ]; then
  echo "==> writing .clasp.json from config/clasp.json"
  node -e 'const c=require("./config/clasp.json");require("fs").writeFileSync(".clasp.json",JSON.stringify({scriptId:c.scriptId,rootDir:c.rootDir,parentId:c.parentId},null,2))'
fi

echo "==> clasp push"
clasp push -f

echo "==> clasp create-version"
VER="$(clasp create-version "deploy $STAMP" 2>&1 | grep -oE '[0-9]+' | tail -1)"
if [ -z "${VER:-}" ]; then echo "ERROR: could not determine version number" >&2; exit 1; fi
echo "    version $VER"

DID="$(node -e 'try{console.log(require("./config/deployment.json").deploymentId||"")}catch(e){console.log("")}')"

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
