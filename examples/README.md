# `/__test` live-verification examples

Reference implementations of the auth-gated `/__test` self-check endpoint that the
Harness live-verification gate hits. Copy the one matching your platform, replace the
example checks with your real ones, and point the task's `verify` block at the deployed
URL. Full standard: `~/.claude/memory/live-verification.md`.

| File | Platform | Auth gate |
|------|----------|-----------|
| `__test.gas.js` | Google Apps Script `doGet` | `?key=` vs `SCRIPT_KEY` Script Property |
| `__test.route.ts` | Next.js App Router (`app/__test/route.ts`) | `x-test-key` header vs `TEST_KEY` env |
| `expected.orders.json` | — | committed sample for the anti-false-pass probe |

## The contract

`GET /__test` returns:

```json
{
  "pass": true,
  "quality_score": 95,
  "checks": [
    { "name": "db_connected",     "critical": true,  "pass": true },
    { "name": "auth_valid",       "critical": true,  "pass": true },
    { "name": "order_total_calc", "critical": false, "pass": true, "weight": 60 },
    { "name": "email_queued",     "critical": false, "pass": true, "weight": 40, "async": true }
  ],
  "last_updated": "2026-06-25",
  "covers": ["orders", "auth", "email"]
}
```

**Pass rule** (encoded in `summarize`/`summarize_`):
`pass = (quality_score >= threshold, default 90) AND every critical:true check has pass:true`.
`quality_score` is the weighted average of **non-critical** checks only — critical checks
have veto power but do not contribute to the score.

**Unreachable / escalate:** a check may return `{name, status:"unreachable",
escalation:{to, instructions}}`; the endpoint then returns top-level `"escalate": true`
(and `pass: null`) so the gate stops for the user instead of burning retries.

## Anti-false-pass probe

`expected.orders.json` is the spec-derived expectation for the real `orders` feature
endpoint. The gate's independent probe asserts the live endpoint's response **equals this
committed file** — written test-first from the spec, never copied from the feature code —
so a bug shared by the feature and its self-check can't produce a false pass. The sample
encodes the same rule the checks use: `(1000·2 + 500·1) = 2500`, `× 1.10 = 2750`.

## Security

Auth-gate every variant, run it against **Dev only**, and **disable/strip it in PROD**.
Never leak internal state (user counts, roadmap) in the response.
