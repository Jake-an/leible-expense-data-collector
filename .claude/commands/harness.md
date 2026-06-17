This project uses the Harness framework. Follow the workflow below when working on tasks.

---

## Workflow

### A. Explore

Read documents under `/docs/` (PRD, ARCHITECTURE, ADR, schema, rules) to understand the project's planning, architecture, and design intent. Use Explore agents in parallel when needed.

### B. Discuss

If anything needs to be clarified or technically decided before implementation, present it to the user and discuss.

### C. Step Design

When the user asks you to write an implementation plan, draft it broken into multiple steps and request feedback.

Design principles:

1. **Minimize scope** — Each step covers only one layer or module.
2. **Self-contained** — Each step file runs in an independent Claude session. "As discussed previously" is forbidden. All context inside the file.
3. **Enforce prerequisites** — List relevant doc paths and files from previous steps. Guide the session to read and understand context first.
4. **Signature-level instructions** — Present interfaces, not implementations. State core rules that must not deviate from design intent.
5. **AC as executable commands** — `python -m pytest`, `python -c "..."`, `grep -q`, etc.
6. **Specific prohibitions** — "Do not do X. Reason: Y."
7. **Naming** — kebab-case slugs: `dopost-endpoint`, `square-connector`, `session-manager`.

### D. File Creation

#### D-1. `phases/index.json` (overall status)
```json
{ "phases": [{ "dir": "0-foundation", "status": "pending" }] }
```

#### D-2. `phases/{task-name}/index.json` (task detail)
```json
{
  "project": "leible-expense-data-collector",
  "phase": "<task-name>",
  "steps": [
    { "step": 0, "name": "setup", "status": "pending" }
  ]
}
```

#### D-3. `phases/{task-name}/step{N}.md` (one per step)

Standard template: Files to Read → Task → Acceptance Criteria → Verification Procedure → Prohibitions.
See `docs/harness-workflow.md` for full details.

### E. Execution

```bash
python scripts/execute.py {task-name}          # Sequential execution
python scripts/execute.py {task-name} --push   # Execute then push
```

### F. Error Recovery

- **On error**: Set step status to `"pending"`, delete `error_message`, re-run.
- **On blocked**: Resolve the `blocked_reason`, set status to `"pending"`, re-run.
