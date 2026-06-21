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
8. **TDD per step** — Mark each step `tdd: true`/`false`. Logic-bearing steps (business rules, data transforms, endpoints, validation) must be `tdd: true` (test-first); pure scaffolding may be `false`. For `tdd: true` steps, enumerate the concrete test cases in that step's Acceptance Criteria *at design time* — written before the implementation.

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
    { "step": 0, "name": "sheet-setup", "status": "pending", "tdd": false },
    { "step": 1, "name": "dopost-endpoint", "status": "pending", "tdd": true }
  ]
}
```

#### `phases/<phase-name>/step<N>.md` (one per step)
See `.claude/commands/harness.md` for the full template. Key sections: Files to Read, Task, Acceptance Criteria, Verification Procedure, Prohibitions.

For `tdd: true` steps, add a **Test First** section between Task and Acceptance Criteria:
1. Write the failing test(s) for the AC cases *before* implementation — use the `ecc:tdd-guide` agent for the red-green-refactor loop.
2. Confirm red (fails for the right reason), implement to green, then refactor.
3. The enumerated test cases from Step Design are the definition of "done."

### E. Execution
```bash
python scripts/execute.py <phase-dir>          # Sequential execution
python scripts/execute.py <phase-dir> --push   # Execute then push
```

The executor handles: branch checkout (`feat-<phase>`), guardrail injection, context accumulation, self-correction (3 retries), two-stage commits, timestamps.

### F. Error Recovery
- **On error:** in `phases/<phase>/index.json`, set the step's status to `"pending"`, delete `error_message`, re-run.
- **On blocked:** resolve the issue in `blocked_reason`, set status to `"pending"`, delete `blocked_reason`, re-run.
