# Harness Workflow — How to Use the Phase/Step Runner

This project uses the Harness Framework to orchestrate multi-step work. Each connector or major task is a **phase** (a folder under `phases/`), broken into sequential **steps** (markdown files).

## Workflow

### A. Explore
Read `docs/` (PRD, ARCHITECTURE, ADR, schema, rules) to understand the project.

### B. Discuss
Clarify any open questions or technical decisions before implementation.

### C. Step Design
Draft steps broken into small, self-contained units. Each step file runs in an independent Claude session.

Design principles:
1. **Minimize scope** — one module or layer per step.
2. **Self-contained** — no "as discussed previously." All context inside the file.
3. **Enforce prerequisites** — list file paths to read, including files from prior steps.
4. **Signature-level instructions** — present interfaces, not implementations. State core rules that must not deviate.
5. **AC as executable commands** — `python -m pytest`, `python -m py_compile`, etc.
6. **Specific prohibitions** — "Do not do X. Reason: Y." not "be careful."
7. **Naming** — kebab-case slugs: `dopost-endpoint`, `square-connector`, `session-manager`.

### D. File Creation

#### `phases/index.json` (top-level index)
```json
{
  "phases": [
    { "dir": "0-foundation", "status": "pending" }
  ]
}
```

#### `phases/<phase-name>/index.json` (phase detail)
```json
{
  "project": "leible-expense-data-collector",
  "phase": "<phase-name>",
  "steps": [
    { "step": 0, "name": "sheet-setup", "status": "pending" },
    { "step": 1, "name": "dopost-endpoint", "status": "pending" }
  ]
}
```

#### `phases/<phase-name>/step<N>.md` (one per step)
See `.claude/commands/harness.md` for the full template. Key sections: Files to Read, Task, Acceptance Criteria, Verification Procedure, Prohibitions.

### E. Execution
```bash
python scripts/execute.py <phase-dir>          # Sequential execution
python scripts/execute.py <phase-dir> --push   # Execute then push
```

The executor handles: branch checkout (`feat-<phase>`), guardrail injection, context accumulation, self-correction (3 retries), two-stage commits, timestamps.

### F. Error Recovery
- **On error:** in `phases/<phase>/index.json`, set the step's status to `"pending"`, delete `error_message`, re-run.
- **On blocked:** resolve the issue in `blocked_reason`, set status to `"pending"`, delete `blocked_reason`, re-run.
