#!/usr/bin/env bash
#
# deploy.sh — the "lets stop here" action: push to git AND deploy to GAS,
# reusing ONE web-app deployment ID forever (never minting a new /exec URL).
#
# Run from anywhere; it cd's to the repo root.
#   bash scripts/deploy.sh
#
# Single-deployment-ID rule (per Jake): config/deployment.json holds the one
# deploymentId. First run creates it once; every run after updates that same
# deployment in place via `clasp redeploy`. We never call create-deployment when
# an id already exists.
#
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
STAMP="$(date '+%Y-%m-%d %H:%M')"

# ------------------------------------------------------------------ #
# 1. Teammate-safe git sync (mirrors scripts/pre_push_sync.py, inline so this
#    works without a Python interpreter on PATH). Never push blind.
# ------------------------------------------------------------------ #
echo "==> git fetch origin $BRANCH"
if ! git fetch origin "$BRANCH" 2>/dev/null; then
  echo "BLOCKED: cannot reach origin/$BRANCH — refusing to push blind." >&2
  exit 1
fi

if git rev-parse --verify "origin/$BRANCH" >/dev/null 2>&1; then
  BEHIND="$(git rev-list --count "HEAD..origin/$BRANCH")"
  if [ "$BEHIND" -gt 0 ]; then
    echo "==> behind by $BEHIND; git pull --rebase --autostash"
    if ! git pull --rebase --autostash origin "$BRANCH"; then
      git rebase --abort 2>/dev/null || true
      echo "BLOCKED: rebase conflict — resolve manually, then re-run." >&2
      exit 1
    fi
  fi
fi

echo "==> git push origin $BRANCH"
git push origin "$BRANCH"

# ------------------------------------------------------------------ #
# 2. Sync code to the Apps Script project (.clasp.json is gitignored, so
#    regenerate it from the tracked config/clasp.json if missing).
# ------------------------------------------------------------------ #
if [ ! -f .clasp.json ]; then
  echo "==> writing .clasp.json from config/clasp.json"
  node -e 'const c=require("./config/clasp.json");require("fs").writeFileSync(".clasp.json",JSON.stringify({scriptId:c.scriptId,rootDir:c.rootDir,parentId:c.parentId},null,2))'
fi

echo "==> clasp push"
clasp push -f

# ------------------------------------------------------------------ #
# 3. Create an immutable version, then deploy ONE deployment in place.
# ------------------------------------------------------------------ #
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
    echo "       Inspect 'clasp list-deployments' and put the AKfyc... id into config/deployment.json by hand." >&2
    exit 1
  fi
fi

# ------------------------------------------------------------------ #
# 4. Record the single deployment id + /exec URL back into tracked config.
# ------------------------------------------------------------------ #
EXEC_URL="https://script.google.com/macros/s/${DID}/exec"
node -e 'const fs=require("fs");const p="./config/deployment.json";const c=require(p);c.deploymentId=process.argv[1];c.execUrl=process.argv[2];fs.writeFileSync(p,JSON.stringify(c,null,2)+"\n")' "$DID" "$EXEC_URL"

echo ""
echo "==> DONE. Pushed $BRANCH and deployed (single) deployment:"
echo "    deploymentId: $DID"
echo "    web app /exec: $EXEC_URL"
echo "    (Playwright connectors: set GAS_EXEC_URL to the /exec URL above.)"
