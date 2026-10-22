# Step 0: contract-probe

## Requirements Covered

- none (discovery). De-risks PRD-23/PRD-25.

## Status

**Executed inline by the orchestrator on 2026-10-22** via Chrome on the already signed-in session (no password needed), read-only. Output: `phases/cropster-roasting/contract.md`. Anchor values: untracked `downloads/cropster-probe/anchor.json` (gitignored). Anchor check: PASS (PROFILE Σ = summary card = MACHINE Σ; sample profile + UI loss % match).

Leak check before commit: `grep -rE "\b353\.7\b|\b387(\.0)?\b" phases/cropster-roasting/` must exit non-zero.
