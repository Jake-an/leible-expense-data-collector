# Step 4: docs-closeout

## Requirements Covered

None — documents the PRD-9 contract implemented in steps 0 and 3; writes no code.

If the Task section below appears to contradict `docs/ADR.md` or a CRITICAL rule in CLAUDE.md,
do NOT resolve the conflict yourself — set `"status": "needs_context"` with the contradiction
spelled out in `needs_context_detail`, and stop.

## Files to Read

- `docs/api.md` — the mass-absence remediation section (~lines 164-181, the documented curl) and
  the doGet token wording (~line 251) to mirror
- `TODO.md` — the `🔒 DECISION NEEDED` block (~lines 39-64) and the 4 minors block (~lines 21-37)
- `docs/PRD.md` — the PRD-9 row (added at scaffold time, status `planned`)
- Steps 0-3 diffs on this branch — the contract you are documenting

Read the current text before editing.

## Task

### 1. `docs/api.md` — document the write-side token

- The remediation curl gains `"token":"$GAS_READ_TOKEN"` inside the JSON body. It stays a bare
  `curl -sL -d` — do NOT add `-X POST` or a `Content-Type` header, and keep the existing note
  explaining that gotcha intact. The token appears ONLY as the shell variable
  `$GAS_READ_TOKEN`; a literal value never appears in docs, chat, or commits.
- Add a short write-side auth note mirroring the doGet token wording: any `doPost` payload
  carrying `weeks_verified_empty` must include `token` (in the body, not the query) matching
  the `API_READ_TOKEN` script property; all other doPost payloads are tokenless. Failure
  response: `{ "result": "error", "message": "unauthorized" }`.
- One sentence of scope honesty: the gate covers the anonymous network surface only — the Apps
  Script editor path still bypasses it (consistent with the existing editor prohibition note).
- One sentence on poster degradation: when the poster cannot resolve `GAS_READ_TOKEN` it drops
  `weeks_verified_empty` (tombstone bypass skipped, warned + recorded in the pull marker) rather
  than failing the pull.

### 2. `TODO.md` — close the queue

- Delete the entire `### 🔒 DECISION NEEDED — doPost is unauthenticated...` block. Replace it
  with a one-line record under the shopspend-hardening heading, e.g.:
  `- [x] doPost auth decision: option (a) — weeks_verified_empty token-gated on API_READ_TOKEN (phase dopost-auth-minors, 2026-08-05).`
- Tick all four minors in the `shopspend-hardening — 4 minors` block (truncated-branch warning →
  step 2, log wording → step 1, W01-W53 bound → step 1, api.md curl → this step), or move the
  block to `TODO_ARCHIVE.md` per TODO hygiene if nothing else remains in it.

### 3. `docs/PRD.md`

Leave PRD-9's status as `planned` — it flips to `built` only after the post-phase deploy + live
probes verify it end to end (the controller does this, not this step).

## Acceptance Criteria

```bash
grep -n 'token' docs/api.md                          # write-side note + curl token present
grep -c 'GAS_READ_TOKEN' docs/api.md                 # >= 1, all as shell-variable references
grep -n 'DECISION NEEDED' TODO.md; test $? -eq 1     # decision block gone
node connectors/gas/test_code.js                     # unchanged code still green
pytest connectors/shopspend -q                       # unchanged code still green
```

## Verification Procedure

1. Run the AC commands above.
2. Confirm no literal secret value appears in the diff (`git diff` — every token reference is
   `$GAS_READ_TOKEN` or the property NAME `API_READ_TOKEN`).
3. Update this step in `phases/dopost-auth-minors/index.json`:
   - Success → `"status": "completed"`, `"summary": "one-line summary of output"`
   - Failure after 3 retry attempts → `"status": "error"`, `"error_message": "specific details"`
   - User intervention required → `"status": "blocked"`, `"blocked_reason": "specific reason"`,
     then stop immediately

## Prohibitions

- **Do NOT run any deploy command in this step.** Reason: the controller deploys post-phase,
  after the phase-end gate.
- Do not change any `.gs` or `.py` file. Reason: docs-only step; code changes belong to steps
  0-3.
- Do not remove or alter the bare-curl gotcha note in api.md. Reason: `-X POST` /
  `-H Content-Type` genuinely breaks the endpoint probe (recorded incident); the note prevents
  a recurring misdiagnosis.
- Do not write a literal token value anywhere. Reason: secrets stay out of the repo and docs
  (CLAUDE.md Absolute Rule).
- Do not flip PRD-9 to `built`. Reason: "built" requires live verification, which happens after
  deploy, outside this phase.
- Do not break existing tests.
