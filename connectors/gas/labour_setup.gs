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
