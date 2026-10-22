# Step 3 review response — round 1

No finding was factually wrong; all five were accepted.

1. **is_logged_in / credentials_login untested** — fixed. Added fake-page tests in `test_cropster.py`: 200 → True; 401/403/500 → False; no summaries response (timeout) → False; goto raises → False; captcha iframe → `BlockedError`.
2. **Range guard is request-integrity only** — documented in the `parse_and_reconcile` docstring. The check is kept. It cannot fail outside a redirect, because the body does not echo the range. Still open for the step-5 live run: confirm the guard is meaningful, or add an anchor cross-check.
3. **weight_loss_pct bounds** — `validate_rows` now rejects values outside 0..100, matching the GAS gate. Tests added.
4. **%2C in profiles path** — commas are now literal and each id is percent-encoded individually. Test added. Whether Cropster accepts this is still unverified until the step-5 live run; record the result in `contract.md` then.
5. **Unhandled exceptions in main()** — added `except Exception` that prints `ABORTED, nothing posted: <TypeName>` and exits 1, with no body or header content. Test added.

Verification: `python -m pytest connectors/playwright/test_cropster.py -q` → 62 passed.
