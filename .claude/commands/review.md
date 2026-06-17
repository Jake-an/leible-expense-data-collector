Review the changes in this project.

First, read the following documents:
- `/CLAUDE.md`
- `/docs/ARCHITECTURE.md`
- `/docs/ADR.md`
- `/docs/schema.md`

Then check the changed files and verify against the checklist below:

## Checklist

1. **Architecture compliance**: Does it follow the directory structure in ARCHITECTURE.md?
2. **Schema compliance**: Do data rows match the normalized schema in schema.md?
3. **Security rules**: No credentials, PII, or business data committed? Sessions gitignored?
4. **Tests exist**: Are tests written for new functionality?
5. **CRITICAL rules**: Does it not violate the rules in CLAUDE.md or docs/rules.md?
6. **Connector contract**: Do Playwright connectors POST in the documented shape?

## Output Format

| Item | Result | Notes |
|------|--------|-------|
| Architecture compliance | pass/fail | {details} |
| Schema compliance | pass/fail | {details} |
| Security rules | pass/fail | {details} |
| Tests exist | pass/fail | {details} |
| CRITICAL rules | pass/fail | {details} |
| Connector contract | pass/fail | {details} |

If there are any violations, provide specific remediation steps.
