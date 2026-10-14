/**
 * labour_setup.gs — one-off creation of the LEIBLE Labour Sheet (plan Phase 1).
 *
 * labourSetupSheet() is a zero-arg editor wrapper (the Run button passes no
 * args). It creates the Sheet ONCE: if LABOUR_CLOCK_SHEET_ID is already set it
 * refuses, so a second run can never mint a second data store. The seed is
 * built and validated (labourReadConfig_) BEFORE anything is created, and the
 * result it logs carries counts only — no names, emails or rates.
 */

var LABOUR_CLOCK_SHEET_NAME_ = 'LEIBLE Labour';
var LABOUR_SETUP_SOURCE_TABS_ = ['LC_LOCATIONS', 'STAFF_RATES', 'STAFF_ALIAS', 'STAFF_PROFILE'];

function labourSetupSheet() {
  var res = labourSetupSheet_(PropertiesService.getScriptProperties(), SpreadsheetApp);
  Logger.log('labourSetupSheet: ' + JSON.stringify(res));
  return res;
}

function labourSetupSheet_(props, app) {
  var existing = props.getProperty('LABOUR_CLOCK_SHEET_ID');
  if (existing) return { refused: 'already_set', id: existing };
  var srcId = props.getProperty('LABOUR_SHEET_ID');
  if (!srcId) return { refused: 'onboarding_sheet_unset' };

  var srcSS = app.openById(srcId);
  var src = {};
  LABOUR_SETUP_SOURCE_TABS_.forEach(function (n) {
    var sh = srcSS.getSheetByName(n);
    if (sh) src[n] = sh.getDataRange().getValues();
  });
  var seed = labourBuildSeed_(src);
  labourReadConfig_(seed.tabs);   // the engine must accept the seed before anything is created

  var ss = app.create(LABOUR_CLOCK_SHEET_NAME_);
  LABOUR_CLOCK_TAB_ORDER_.forEach(function (name, i) {
    var sh = i === 0 ? ss.getSheets()[0].setName(name) : ss.insertSheet(name);
    var rows = seed.tabs[name];
    sh.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
    sh.setFrozenRows(1);
  });
  props.setProperty('LABOUR_CLOCK_SHEET_ID', ss.getId());
  return { ok: true, id: ss.getId(), url: ss.getUrl(), counts: seed.counts };
}

/* ------------------------------------------------------------------ *
 * Amendment A — one-off wrappers for the rule tabs. Zero-arg (the Run
 * button passes no args); logic lives in the _(props, app) twins so the
 * tests can drive them with fakes. Results carry counts / row numbers
 * only — never names, emails or rates.
 * ------------------------------------------------------------------ */

function labourFillLevels() {
  var res = labourFillLevels_(PropertiesService.getScriptProperties(), SpreadsheetApp);
  Logger.log('labourFillLevels: ' + JSON.stringify(res));
  return res;
}

// Fills each BLANK PEOPLE level whose person's latest RATES rate equals a PAY_TABLE rate (+-$0.01) on a
// row that has a level. Never overwrites a set level; writes single level cells only (never the range).
function labourFillLevels_(props, app) {
  var id = props.getProperty('LABOUR_CLOCK_SHEET_ID');
  if (!id) return { refused: 'clock_sheet_unset' };
  var ss = app.openById(id);
  function vals(name) {
    var sh = ss.getSheetByName(name);
    return sh ? sh.getDataRange().getValues() : null;
  }
  var pay = labourParsePayTable_({ PAY_TABLE: vals('PAY_TABLE') }).filter(function (p) { return p.level !== ''; });
  if (pay.length === 0) return { refused: 'pay_table_missing' };

  var tabs = { PEOPLE: vals('PEOPLE'), RATES: vals('RATES') };
  var rt = labourTabIndex_(tabs, 'RATES');
  var latest = {};
  rt.rows.forEach(function (r) {
    var rate = labourPositiveNumber_(r[rt.idx.rate]);
    var eff = labourDateKey_(r[rt.idx.effective_from]);
    var email = labourStr_(r[rt.idx.person_email]).toLowerCase();
    if (rate === null || email === '') return;
    if (!Object.prototype.hasOwnProperty.call(latest, email) || eff >= latest[email].eff) latest[email] = { rate: rate, eff: eff };
  });

  var pt = labourTabIndex_(tabs, 'PEOPLE');
  var sheet = ss.getSheetByName('PEOPLE');
  var filledRows = [];
  var unmatchedRows = [];
  tabs.PEOPLE.forEach(function (row, i) {
    if (i === 0 || !Array.isArray(row)) return;
    var email = labourStr_(row[pt.idx.person_email]).toLowerCase();
    if (email === '' || labourStr_(row[pt.idx.level]) !== '') return;
    var levels = {};
    if (Object.prototype.hasOwnProperty.call(latest, email)) {
      pay.forEach(function (p) {
        if (Math.abs(p.rate - latest[email].rate) <= 0.01 + 1e-9) levels[p.level] = true;
      });
    }
    var found = Object.keys(levels);
    if (found.length !== 1) { unmatchedRows.push(i + 1); return; }
    sheet.getRange(i + 1, pt.idx.level + 1).setValue(isFinite(Number(found[0])) ? Number(found[0]) : found[0]);
    filledRows.push(i + 1);
  });
  return { ok: true, filled: filledRows.length, filledRows: filledRows, unmatched: unmatchedRows.length, unmatchedRows: unmatchedRows };
}

function labourAddRuleTabs() {
  var res = labourAddRuleTabs_(PropertiesService.getScriptProperties(), SpreadsheetApp);
  Logger.log('labourAddRuleTabs: ' + JSON.stringify(res));
  return res;
}

// Idempotent: creates only the MISSING rule tabs (header written in the same call; PAY_TABLE also seeded).
// An existing tab is never touched.
function labourAddRuleTabs_(props, app) {
  var id = props.getProperty('LABOUR_CLOCK_SHEET_ID');
  if (!id) return { refused: 'clock_sheet_unset' };
  var ss = app.openById(id);
  var created = [];
  var skipped = [];
  LABOUR_CLOCK_RULE_TABS_.forEach(function (name) {
    if (ss.getSheetByName(name)) { skipped.push(name); return; }
    var rows = [LABOUR_CLOCK_EXPECTED_HEADERS_[name].slice()];
    if (name === 'PAY_TABLE') rows = rows.concat(LABOUR_CLOCK_PAY_TABLE_SEED_.map(function (r) { return r.slice(); }));
    var sh = ss.insertSheet(name);
    sh.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
    sh.setFrozenRows(1);
    created.push(name);
  });
  return { ok: true, created: created, skipped: skipped };
}

// Zero-arg, read-only: what the Onboarding source holds for award levels.
function labourSeedSourceReport() {
  var id = PropertiesService.getScriptProperties().getProperty('LABOUR_SHEET_ID');
  if (!id) { Logger.log('labourSeedSourceReport: refused onboarding_sheet_unset'); return { refused: 'onboarding_sheet_unset' }; }
  var srcSS = SpreadsheetApp.openById(id);
  var src = {};
  ['STAFF_PROFILE', 'SUBMISSIONS', 'STAFF_RATES'].forEach(function (n) {
    var sh = srcSS.getSheetByName(n);
    if (sh) src[n] = sh.getDataRange().getValues();
  });
  var res = labourSeedSourceReport_(src);
  Logger.log('labourSeedSourceReport: ' + JSON.stringify(res));
  return res;
}
