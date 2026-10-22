/**
 * cropster.gs — Cropster Roasting weekly ingest (PRD-23).
 * RED scaffold: constants only; roastingIngest_/roastingUpsert_ land in GREEN.
 */
var ROASTING_TAB = 'Roasting';
var ROASTING_SOURCE = 'cropster';
var ROASTING_HEADERS = ['week_start', 'profile', 'green_kg_in', 'roasted_kg_out', 'weight_loss_pct', 'batch_count', 'pulled_at'];
