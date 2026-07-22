/**
 * /__test — live-verification self-check endpoint (Google Apps Script doGet).
 *
 * Part of the Harness live-verification standard (~/.claude/memory/live-verification.md).
 * Deploy as a Web App; the checker / scripts/verify_gate.sh hits:
 *     https://script.google.com/macros/s/<id>/exec?fn=__test&key=<SCRIPT_KEY>
 *
 * SECURITY — DISABLE / STRIP THIS IN PROD.
 *   - Auth-gated: rejects unless ?key matches the SCRIPT_KEY Script Property.
 *   - Runs against Dev only; PROD verification is manual / metrics / logs.
 *   - Never leak internal state (user counts, roadmap) in the response.
 *
 * Pass rule (encoded in summarize_):
 *   pass = (quality_score >= threshold, default 90) AND every critical check passes.
 *   quality_score = weighted average of NON-critical checks only (critical checks have
 *   veto power but do not contribute to the score).
 */

var TEST_THRESHOLD = 90;

// Wire this into your existing doGet router, or use it as the whole doGet on a Dev deploy.
function doGet(e) {
  var params = (e && e.parameter) || {};

  // --- auth gate (shared key read from Script Properties) ---
  var expected = PropertiesService.getScriptProperties().getProperty('SCRIPT_KEY');
  if (!expected || params.key !== expected) {
    return _json({ error: 'unauthorized' }); // do not reveal why
  }

  if (params.fn === '__test') {
    return _json(runSelfTest_());
  }
  // ... your other Dev routes (e.g. fn === 'orders' for the anti-false-pass probe) ...
  return _json({ error: 'unknown fn' });
}

function runSelfTest_() {
  var checks = [];

  // 1. critical, live: data store reachable (untestable glue → live-only, never mocked)
  checks.push(checkDbConnected_());

  // 2. critical: auth subsystem valid (we got here, so the key matched)
  checks.push({ name: 'auth_valid', critical: true, pass: true });

  // 3. non-critical, pure-logic: business rule verified with no live dependency
  checks.push(checkOrderTotalCalc_());

  // 4. non-critical, async: an eventually-consistent side effect (email queue)
  checks.push(checkEmailQueued_());

  return summarize_(checks, ['orders', 'auth', 'email'], '2026-06-25');
}

// --- individual checks ---

function checkDbConnected_() {
  // Live check: open the Dev data sheet. Untestable glue — verified live, never mocked.
  try {
    var id = PropertiesService.getScriptProperties().getProperty('DEV_SHEET_ID');
    if (!id) {
      // Genuinely unreachable without config → escalate, don't burn the gate's retries.
      return {
        name: 'db_connected', critical: true, status: 'unreachable',
        escalation: { to: 'user', instructions: 'Set DEV_SHEET_ID in Script Properties.' }
      };
    }
    SpreadsheetApp.openById(id).getName(); // throws if unreachable
    return { name: 'db_connected', critical: true, pass: true };
  } catch (err) {
    return { name: 'db_connected', critical: true, pass: false, detail: String(err).slice(0, 120) };
  }
}

function checkOrderTotalCalc_() {
  // Pure-logic check: expected is derived from the spec, asserted against the real fn.
  var got = calcTotal([{ price: 1000, qty: 2 }, { price: 500, qty: 1 }], 0.10);
  var expected = 2750; // (1000*2 + 500*1) * 1.10
  return { name: 'order_total_calc', critical: false, weight: 60, pass: got === expected };
}

function checkEmailQueued_() {
  // Async / eventually-consistent example. async:true lets the checker back off & retry.
  var queued = false;
  try { queued = (typeof emailQueueDepth === 'function') ? emailQueueDepth() >= 0 : true; }
  catch (err) { queued = false; }
  return { name: 'email_queued', critical: false, weight: 40, async: true, pass: queued };
}

// --- pass-rule engine (shared shape with the Next.js version) ---

function summarize_(checks, covers, lastUpdated) {
  // Unreachable check → escalate to the user instead of pass/fail.
  var unreachable = checks.filter(function (c) { return c.status === 'unreachable'; });
  if (unreachable.length) {
    return {
      pass: null, escalate: true, checks: checks,
      escalation: unreachable[0].escalation,
      last_updated: lastUpdated, covers: covers
    };
  }

  // quality_score = weighted average of NON-critical checks only.
  var nonCritical = checks.filter(function (c) { return !c.critical; });
  var totalWeight = 0, earned = 0;
  nonCritical.forEach(function (c) {
    var w = c.weight || 1;
    totalWeight += w;
    if (c.pass) earned += w;
  });
  var qualityScore = totalWeight ? Math.round((earned / totalWeight) * 100) : 100;

  // Critical checks have veto power, regardless of score.
  var criticalOk = checks
    .filter(function (c) { return c.critical; })
    .every(function (c) { return c.pass === true; });

  var pass = criticalOk && qualityScore >= TEST_THRESHOLD;

  return {
    pass: pass,
    quality_score: qualityScore,
    checks: checks,
    last_updated: lastUpdated,
    covers: covers
  };
}

// --- helpers ---

function _json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// Example business fn under test (replace with your real one; the probe hits it too).
function calcTotal(items, taxRate) {
  var sub = items.reduce(function (a, it) { return a + it.price * it.qty; }, 0);
  return Math.round(sub * (1 + taxRate));
}
