/**
 * orderapp.gs — shared plumbing for the LEIBLE_Order_app read-API pulls.
 *
 * These pulls live in GAS (not a Python connector) because they need the
 * hub's internal upsert helpers and Google-side scheduling; the doPost
 * boundary is for external connectors only.
 *
 * RED phase (TDD): implementation intentionally not yet written. See
 * phases/orderapp-pulls/index.json step 0.
 */
