/**
 * /__test — live-verification self-check endpoint (DORMANT — not yet wired in).
 *
 * Standard: ~/.claude/memory/live-verification.md.  Setup: LIVE_VERIFICATION_SETUP.md.
 *
 * This file is INERT until you do two things (see the setup doc):
 *   1. Arm it — add ONE line to the TOP of your existing doGet(e):
 *          if (e && e.parameter && e.parameter.fn === '__test') return serveLiveTest_(e);
 *   2. Set a Script Property `SCRIPT_KEY` (the shared test key) — and replace the
 *      placeholder checks below with REAL ones for this app.
 *
 * SECURITY — Dev only. Disable/strip in PROD. Auth-gated by ?key= vs SCRIPT_KEY.
 * Never leak internal state (user counts, roadmap) in the response.
 *
 * Pass rule (encoded in liveTestSummarize_):
 *   pass = (quality_score >= threshold, default 90) AND every critical check passes.
 *   quality_score = weighted average of NON-critical checks only.
 */

var LIVE_TEST_THRESHOLD = 90;

function serveLiveTest_(e) {
  var params = (e && e.parameter) || {};
  var expected = PropertiesService.getScriptProperties().getProperty('SCRIPT_KEY');
  if (!expected || params.key !== expected) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: 'unauthorized' }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  return ContentService
    .createTextOutput(JSON.stringify(runLiveSelfTest_()))
    .setMimeType(ContentService.MimeType.JSON);
}

function runLiveSelfTest_() {
  var checks = [];

  // 1. critical, live: data store reachable. REPLACE with this app's real store check.
  checks.push(liveCheckDbConnected_());

  // 2. critical: auth subsystem valid (we got here, so the key matched).
  checks.push({ name: 'auth_valid', critical: true, pass: true });

  // 3. non-critical, pure-logic: PLACEHOLDER. Replace with a real business-rule assert.
  checks.push({ name: 'placeholder_logic', critical: false, weight: 100,
                pass: liveCalcTotal_([{ price: 1000, qty: 2 }, { price: 500, qty: 1 }], 0.10) === 2750 });

  return liveTestSummarize_(checks, ['REPLACE_WITH_THIS_APPS_FEATURES'], '2026-06-25');
}

function liveCheckDbConnected_() {
  // Until you wire a real store check, this escalates (honest "not configured yet").
  var id = PropertiesService.getScriptProperties().getProperty('DEV_SHEET_ID');
  if (!id) {
    return { name: 'db_connected', critical: true, status: 'unreachable',
             escalation: { to: 'user', instructions: 'Set DEV_SHEET_ID Script Property, or replace this check.' } };
  }
  try {
    SpreadsheetApp.openById(id).getName();
    return { name: 'db_connected', critical: true, pass: true };
  } catch (err) {
    return { name: 'db_connected', critical: true, pass: false, detail: String(err).slice(0, 120) };
  }
}

function liveTestSummarize_(checks, covers, lastUpdated) {
  var unreachable = checks.filter(function (c) { return c.status === 'unreachable'; });
  if (unreachable.length) {
    return { pass: null, escalate: true, checks: checks,
             escalation: unreachable[0].escalation, last_updated: lastUpdated, covers: covers };
  }
  var nonCritical = checks.filter(function (c) { return !c.critical; });
  var totalWeight = 0, earned = 0;
  nonCritical.forEach(function (c) { var w = c.weight || 1; totalWeight += w; if (c.pass) earned += w; });
  var qualityScore = totalWeight ? Math.round((earned / totalWeight) * 100) : 100;
  var criticalOk = checks.filter(function (c) { return c.critical; })
                         .every(function (c) { return c.pass === true; });
  return { pass: criticalOk && qualityScore >= LIVE_TEST_THRESHOLD,
           quality_score: qualityScore, checks: checks,
           last_updated: lastUpdated, covers: covers };
}

function liveCalcTotal_(items, taxRate) {
  var sub = items.reduce(function (a, it) { return a + it.price * it.qty; }, 0);
  return Math.round(sub * (1 + taxRate));
}
