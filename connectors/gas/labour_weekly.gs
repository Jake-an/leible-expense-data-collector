/**
 * labour_weekly.gs — labour-clock Phase 3: wire the clock/roster costing (labour.gs) into
 * weeklySummarize, behind a separate switch.
 *
 *   LABOUR_CLOCK_SHEET_ID  WHERE the Labour Sheet is (the preview needs only this).
 *   LABOUR_SOURCE=clock    WHETHER the weekly run uses it. Off -> the legacy Onboarding pull
 *                          (labourWeeklyPull_, LABOUR_SHEET_ID) runs unchanged.
 *   CLOCK_START_WEEK       first week the new path may write; earlier weeks stay legacy.
 *
 * Per-location routing: with the switch on, the new path writes ONLY the LOCATIONS rows whose
 * `live` cell is yes/true; the legacy pull skips exactly those (week >= CLOCK_START_WEEK), so a
 * (week, location) is never written by both paths and never dropped by both. A blank or
 * unrecognised `live` cell is NOT live.
 *
 * labourWeeklyCompute_ opens ONLY LABOUR_CLOCK_SHEET_ID — never LABOUR_SHEET_ID.
 */

var LABOUR_SOURCE_CLOCK_ = 'clock';
var LABOUR_SNAPSHOT_TAB_ = '_labour_snapshot';
var LABOUR_CLOCK_READ_TABS_ = ['CLOCK_RAW', 'CONFIG', 'HOLIDAYS', 'LOCATIONS', 'RATES', 'PEOPLE',
  'PAY_TABLE', 'CASH_SHIFTS', 'FIXED', 'LABOUR_COST'];

function labourSourceIsClock_(props) {
  return labourStr_(props.getProperty('LABOUR_SOURCE')).toLowerCase() === LABOUR_SOURCE_CLOCK_;
}

// CLOCK_START_WEEK as a Monday 'yyyy-MM-dd', '' when unset. A non-Monday is snapped, never trusted.
function labourClockStart_(props) {
  var v = labourStr_(props.getProperty('CLOCK_START_WEEK'));
  return v === '' ? '' : weekStartForDate_(labourDayKey_(v, 'CLOCK_START_WEEK'));
}

// Opens the Labour Sheet once and reads every tab the costing needs. Throws on config drift.
function labourClockOpen_(props, app) {
  var id = props.getProperty('LABOUR_CLOCK_SHEET_ID');
  if (!id) return { refused: 'clock_sheet_unset' };
  var ss = app.openById(id);
  var tabs = {};
  LABOUR_CLOCK_READ_TABS_.forEach(function (n) {
    var sh = ss.getSheetByName(n);
    if (sh) tabs[n] = sh.getDataRange().getValues();
  });
  return { ss: ss, tabs: tabs, cfg: labourReadConfig_(tabs) };
}

// LABOUR_COST rows before `ws` -> { location: [total, ...] } newest week first (drop-check history).
function labourCostHistory_(costRows, ws) {
  var rows = costRows || [];
  var hdr = (rows[0] || []).map(labourStr_);
  var iw = hdr.indexOf('week_start'), il = hdr.indexOf('location'), it = hdr.indexOf('total');
  if (iw === -1 || il === -1 || it === -1) return {};
  var byLoc = {};
  rows.slice(1).forEach(function (r) {
    var w = labourDateKey_(r[iw]);
    if (w === '' || w >= ws) return;
    (byLoc[labourStr_(r[il])] = byLoc[labourStr_(r[il])] || []).push({ w: w, t: Number(r[it]) });
  });
  var out = {};
  Object.keys(byLoc).forEach(function (l) {
    out[l] = byLoc[l].sort(function (a, b) { return a.w < b.w ? 1 : -1; }).map(function (x) { return x.t; });
  });
  return out;
}

// Pure: costs ONE week for EVERY location (live or not). Fixed-location clocks are split upstream
// (R9); zero clock rows or >10% exceptions still write the fixed-cost rows (R10).
function labourClockWeek_(cfg, rawRows, ws, ctx) {
  var we = addDaysStr_(ws, 6);
  var parsed = labourRowsToShifts_(rawRows, { start: ws, end: we }, cfg);
  var prev = labourRowsToShifts_(rawRows, { start: addDaysStr_(ws, -7), end: addDaysStr_(ws, -1) }, cfg);
  var fixedWeek = labourFixedWeek_(cfg, ws);
  var split = labourSplitFixedClocks_(parsed.shifts, parsed.exceptions, fixedWeek);
  var costed = [];
  var exceptions = split.exceptions.slice();
  split.shifts.forEach(function (s) {
    var c = labourCostShift_(s, cfg);
    if (c.ok) costed.push({ shift: s, cost: c }); else exceptions.push(c.exception);
  });
  var groups = labourGroup_(costed, exceptions, fixedWeek);
  var checks = labourRunChecks_({
    rowCount: parsed.shifts.length + parsed.exceptions.length, week: labourIsoWeek_(ws).isoWeek, weekStart: ws,
    cfg: cfg, fixedClocks: split.fixedClocks, shiftsTotal: costed.length, exceptions: exceptions,
    today: ctx.today, lastAlertedYear: ctx.lastAlertedYear,
    thisWeekShifts: split.shifts, prevWeekShifts: prev.shifts, groups: groups, history: ctx.history || {},
    observations: split.shifts.map(function (s) { return { personEmail: s.personEmail, rate: s.rate, date: s.date }; }),
    payGuide: LABOUR_PAYGUIDE_SEED_
  });
  if (checks.stop || checks.refuse) groups = labourGroup_([], [], fixedWeek);
  return {
    weekStart: ws, weekEnd: we, stop: checks.stop, refuse: checks.refuse, alerts: checks.alerts,
    lastAlertedYear: checks.lastAlertedYear,
    groups: groups.filter(function (g) { return g.weekStart === ws && g.location !== '(unknown)'; })
  };
}

// Hub Labour tab upsert on week_start||location. A changed total or department is REWRITTEN
// (the legacy append-only dedup froze a corrected total forever).
function labourHubUpsert_(labourSheet, rows) {
  var data = labourSheet.getDataRange().getValues();
  var idx = {};
  for (var r = 1; r < data.length; r++) idx[coerceDateStr_(data[r][0]) + '||' + String(data[r][2])] = r;
  var added = 0, updated = 0;
  rows.forEach(function (row) {
    var key = row[0] + '||' + row[2];
    if (!Object.prototype.hasOwnProperty.call(idx, key)) {
      labourSheet.appendRow(sheetSafeRow_(row));
      data.push(row.slice());
      idx[key] = data.length - 1;
      added++;
      return;
    }
    var cur = data[idx[key]];
    if (Math.round(Number(cur[3]) * 100) !== Math.round(Number(row[3]) * 100) || String(cur[6]) !== String(row[6])) {
      labourSheet.getRange(idx[key] + 1, 1, 1, row.length).setValues([sheetSafeRow_(row)]);
      data[idx[key]] = row.slice();
      updated++;
    }
  });
  return { added: added, updated: updated };
}

// Labour Sheet LABOUR_COST upsert on week_start||location (whole row rewritten).
function labourCostUpsert_(clockSS, groups, computedAt) {
  var sh = clockSS.getSheetByName('LABOUR_COST');
  if (!sh) { sh = clockSS.insertSheet('LABOUR_COST'); sh.appendRow(LABOUR_CLOCK_COST_HEADERS_.slice()); }
  var data = sh.getDataRange().getValues();
  if (data.length === 0) { sh.appendRow(LABOUR_CLOCK_COST_HEADERS_.slice()); data = [LABOUR_CLOCK_COST_HEADERS_.slice()]; }
  var idx = {};
  for (var r = 1; r < data.length; r++) idx[labourDateKey_(data[r][1]) + '||' + labourStr_(data[r][3])] = r;
  groups.forEach(function (g) {
    var row = [g.isoWeek, g.weekStart, g.weekEnd, g.location, g.locationCode, g.department, g.hours, g.base,
      g.uplift, g.gross, g.super, g.total, g.shiftCount, g.exceptionCount, computedAt];
    var key = g.weekStart + '||' + g.location;
    if (Object.prototype.hasOwnProperty.call(idx, key)) {
      sh.getRange(idx[key] + 1, 1, 1, row.length).setValues([row]);
    } else {
      sh.appendRow(row);
      data.push(row);
      idx[key] = data.length - 1;
    }
  });
}

/**
 * The new write path (switch on). Writes ONLY live locations, for weeks >= CLOCK_START_WEEK:
 * LABOUR_COST in the Labour Sheet, the hub Labour tab, and Summary with the real department.
 * Refuses: clock_start_unset, clock_sheet_unset, config_error. Per week: before_clock_start.
 */
function labourWeeklyCompute_(weeks, ss, summSheet, pulledAt, props, app, opts) {
  opts = opts || {};
  var start;
  try { start = labourClockStart_(props); } catch (e) { return { refused: 'clock_start_invalid', error: e.message }; }
  if (start === '') return { refused: 'clock_start_unset' };
  var clk;
  try { clk = labourClockOpen_(props, app); } catch (e) { return { refused: 'config_error', error: e.message }; }
  if (clk.refused) return clk;

  var live = {};
  Object.keys(clk.cfg.locations).forEach(function (l) { if (clk.cfg.locations[l].live) live[l] = true; });
  var today = opts.today || todayStr_();
  var julyYear = Number(props.getProperty('LABOUR_JULY_ALERTED_YEAR')) || 0;
  var startYear = julyYear;
  var out = { clockStartWeek: start, liveLocations: Object.keys(live).sort(), weeks: [], alerts: [],
    labourAdded: 0, labourUpdated: 0, summaryAdded: 0, summaryUpdated: 0 };
  var groups = [];

  weeks.forEach(function (w) {
    var ws = w.start;
    if (ws < start) { out.weeks.push({ week: ws, action: 'before_clock_start' }); return; }
    var res;
    try {
      res = labourClockWeek_(clk.cfg, clk.tabs.CLOCK_RAW || [], ws,
        { today: today, lastAlertedYear: julyYear, history: labourCostHistory_(clk.tabs.LABOUR_COST, ws) });
    } catch (e) {
      out.weeks.push({ week: ws, action: 'error', error: e.message });
      return;
    }
    julyYear = res.lastAlertedYear;
    res.alerts.forEach(function (a) { out.alerts.push({ week: ws, alert: a }); });
    var mine = res.groups.filter(function (g) { return live[g.location] === true; });
    out.weeks.push({ week: ws, action: res.refuse ? 'refused_exceptions' : res.stop ? 'zero_rows' : 'write',
      written: mine.map(function (g) { return g.location; }) });
    groups = groups.concat(mine);
  });

  if (groups.length > 0) {
    labourCostUpsert_(clk.ss, groups, pulledAt);
    var hubRes = labourHubUpsert_(ensureSheet(ss, LABOUR_TAB, LABOUR_HEADERS), groups.map(function (g) {
      return [g.weekStart, g.weekEnd, g.location, g.total, g.isoWeek, pulledAt, g.department];
    }));
    var sumRes = upsertRows_(summSheet, groups.map(function (g) {
      return [g.weekStart, g.weekEnd, 'Labour', g.location, g.total, pulledAt, g.department, 'spend'];
    }), SUMMARY_KEY_COLS, SUMMARY_TOTAL_COL, SUMMARY_STAMP_COL);
    out.labourAdded = hubRes.added;
    out.labourUpdated = hubRes.updated;
    out.summaryAdded = sumRes.rowsAdded;
    out.summaryUpdated = sumRes.rowsUpdated;
  }
  if (julyYear !== startYear) props.setProperty('LABOUR_JULY_ALERTED_YEAR', String(julyYear));
  return out;
}

/**
 * weeklySummarize's single labour entry point. Switch off -> legacy pull, unchanged. Switch on ->
 * the new path for live locations, then the legacy pull for everything else. If the new path
 * refuses outright, the legacy pull still runs for every location (nothing is dropped).
 */
function labourWeeklyRoute_(weeks, ss, summSheet, pulledAt, props, app) {
  var out = { labourAdded: 0, labourUpdated: 0, summaryAdded: 0, summaryUpdated: 0 };
  var skip = null;
  if (labourSourceIsClock_(props)) {
    var c = labourWeeklyCompute_(weeks, ss, summSheet, pulledAt, props, app);
    out.clock = c;
    if (c.refused) {
      out.clockRefused = c.refused;
      Logger.log('labourWeeklyRoute_: clock path REFUSED ' + c.refused + (c.error ? ' — ' + c.error : '') +
        ' — legacy pull covers every location');
    } else {
      var live = {};
      c.liveLocations.forEach(function (l) { live[l] = true; });
      skip = function (ws, location) { return ws >= c.clockStartWeek && live[location] === true; };
      ['labourAdded', 'labourUpdated', 'summaryAdded', 'summaryUpdated'].forEach(function (k) { out[k] += c[k]; });
      c.weeks.forEach(function (w) {
        Logger.log('labourWeeklyRoute_: clock ' + w.week + ' ' + w.action +
          (w.written ? ' written=' + w.written.join(',') : '') + (w.error ? ' — ' + w.error : ''));
      });
    }
  }
  var old = labourWeeklyPull_(weeks, ss, summSheet, pulledAt, skip) || {};
  ['labourAdded', 'labourUpdated', 'summaryAdded', 'summaryUpdated'].forEach(function (k) { out[k] += old[k] || 0; });
  return out;
}

/* ------------------------------------------------------------------ *
 * Zero-arg editor wrappers (the Run button passes no args; options come from
 * Script Properties). Each logs ONE line per item.
 * ------------------------------------------------------------------ */

// Read-only: clock-based totals beside the current Summary figures for one week.
// Week = LABOUR_PREVIEW_WEEK (snapped to Monday) or the last completed week. Writes nothing.
function labourClockPreview() {
  var res = labourClockPreview_(PropertiesService.getScriptProperties(), SpreadsheetApp, getHubSpreadsheet_());
  if (res.refused) { Logger.log('labourClockPreview: refused ' + res.refused + (res.error ? ' — ' + res.error : '')); return res; }
  Logger.log('labourClockPreview: week ' + res.week + ' clockTotal=' + res.clockTotal + ' currentTotal=' + res.currentTotal +
    (res.refuse ? ' (clock week would be REFUSED: exceptions >10%)' : '') + (res.stop ? ' (no clock rows)' : ''));
  res.rows.forEach(function (r) {
    Logger.log('labourClockPreview: ' + r.location + ' [' + r.department + (r.live ? ', live' : '') + (r.fixed ? ', fixed' : '') +
      '] clock=' + r.clock + ' current=' + r.current + ' diff=' + r.diff);
  });
  res.alerts.forEach(function (a) { Logger.log('labourClockPreview: alert ' + a); });
  return res;
}

function labourClockPreview_(props, app, hub, opts) {
  opts = opts || {};
  var clk;
  try { clk = labourClockOpen_(props, app); } catch (e) { return { refused: 'config_error', error: e.message }; }
  if (clk.refused) return clk;
  var ovr = labourStr_(props.getProperty('LABOUR_PREVIEW_WEEK'));
  var ws = ovr !== '' ? weekStartForDate_(labourDayKey_(ovr, 'LABOUR_PREVIEW_WEEK'))
    : getLastCompletedWeek_(opts.today || todayStr_()).start;
  var wk;
  try {
    // lastAlertedYear 9999: the preview never consumes the once-a-year July alert.
    wk = labourClockWeek_(clk.cfg, clk.tabs.CLOCK_RAW || [], ws,
      { today: opts.today || todayStr_(), lastAlertedYear: 9999, history: labourCostHistory_(clk.tabs.LABOUR_COST, ws) });
  } catch (e) { return { refused: 'config_error', error: e.message }; }

  var current = {};
  var summ = hub.getSheetByName(SUMMARY_TAB);
  var data = summ ? summ.getDataRange().getValues() : [];
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][2]) !== 'Labour' || coerceDateStr_(data[r][0]) !== ws) continue;
    var l = String(data[r][3]);
    current[l] = labourRound2_((current[l] || 0) + Number(data[r][4] || 0));
  }
  var byLoc = {};
  wk.groups.forEach(function (g) { byLoc[g.location] = g; });
  var locs = {};
  Object.keys(byLoc).concat(Object.keys(current)).forEach(function (l) { locs[l] = true; });
  var rows = Object.keys(locs).sort().map(function (l) {
    var g = byLoc[l];
    var def = clk.cfg.locations[l] || {};
    var clock = g ? g.total : null;
    var cur = Object.prototype.hasOwnProperty.call(current, l) ? current[l] : null;
    return { location: l, department: def.department || (g && g.department) || '', live: def.live === true,
      fixed: !!(g && g.fixed), hours: g ? g.hours : null, clock: clock, current: cur,
      diff: (clock !== null && cur !== null) ? labourRound2_(clock - cur) : null };
  });
  function sum(k) { return labourRound2_(rows.reduce(function (a, x) { return a + (x[k] || 0); }, 0)); }
  return { week: ws, rows: rows, clockTotal: sum('clock'), currentTotal: sum('current'), refuse: wk.refuse, stop: wk.stop,
    alerts: wk.alerts.map(function (a) { return a.key + ': ' + a.title; }) };
}

// Run ONLY after flipping the roastery location to live: removes the stale Cafe-tagged Labour
// Summary rows that now duplicate a Roastery row (the upsert key includes department). Scope:
// weeks >= CLOCK_START_WEEK that HAVE a Roastery row. Snapshots every row before deleting it.
function labourRunRoasteryCleanup() {
  var res = labourRunRoasteryCleanup_(PropertiesService.getScriptProperties(), SpreadsheetApp, getHubSpreadsheet_());
  Logger.log('labourRunRoasteryCleanup: ' + (res.refused ? 'refused ' + res.refused : 'deleted=' + res.deleted));
  (res.rows || []).forEach(function (r) { Logger.log('labourRunRoasteryCleanup: removed ' + r); });
  return res;
}

function labourRunRoasteryCleanup_(props, app, hub) {
  if (!labourSourceIsClock_(props)) return { refused: 'source_not_clock' };
  var start = labourClockStart_(props);
  if (start === '') return { refused: 'clock_start_unset' };
  var clk;
  try { clk = labourClockOpen_(props, app); } catch (e) { return { refused: 'config_error', error: e.message }; }
  if (clk.refused) return clk;
  var roast = {};
  Object.keys(clk.cfg.locations).forEach(function (l) {
    var d = clk.cfg.locations[l];
    if (d.department === 'Roastery' && d.live) roast[l] = true;
  });
  if (Object.keys(roast).length === 0) return { refused: 'roastery_not_live' };

  var summ = hub.getSheetByName(SUMMARY_TAB);
  if (!summ) return { ok: true, deleted: 0, rows: [] };
  var data = summ.getDataRange().getValues();
  function isLab(r) { return String(r[2]) === 'Labour' && roast[String(r[3])] === true && coerceDateStr_(r[0]) >= start; }
  var hasRoastery = {};
  for (var i = 1; i < data.length; i++) {
    if (isLab(data[i]) && String(data[i][6]) === 'Roastery') hasRoastery[coerceDateStr_(data[i][0]) + '||' + data[i][3]] = true;
  }
  var targets = [];
  for (var j = 1; j < data.length; j++) {
    if (isLab(data[j]) && String(data[j][6]) === DEFAULT_DEPARTMENT && hasRoastery[coerceDateStr_(data[j][0]) + '||' + data[j][3]]) targets.push(j);
  }
  if (targets.length === 0) return { ok: true, deleted: 0, rows: [] };
  var snap = ensureSheet(hub, LABOUR_SNAPSHOT_TAB_, SUMMARY_HEADERS.concat(['snapshot_at']));
  var at = Utilities.formatDate(new Date(Date.now()), 'Australia/Sydney', "yyyy-MM-dd'T'HH:mm:ssXXX");
  targets.forEach(function (t) {
    var row = data[t].slice(0, SUMMARY_HEADERS.length);
    row[0] = coerceDateStr_(row[0]);
    row[1] = coerceDateStr_(row[1]);
    snap.appendRow(sheetSafeRow_(row.concat([at])));
  });
  var labels = [];
  targets.slice().sort(function (a, b) { return b - a; }).forEach(function (t) {
    labels.push(coerceDateStr_(data[t][0]) + ' ' + data[t][3] + ' ' + data[t][4]);
    summ.deleteRow(t + 1);
  });
  return { ok: true, deleted: targets.length, rows: labels };
}

// Undo the switch: unset LABOUR_SOURCE (first, so no new-path run can start mid-rollback), clear
// every LOCATIONS live cell, delete live-week Roastery Labour rows, then restore ONLY the rows the
// cleanup snapshot owns — skipping any whose key is already back in Summary (no double count).
function labourRunRollback() {
  var res = labourRunRollback_(PropertiesService.getScriptProperties(), SpreadsheetApp, getHubSpreadsheet_());
  Logger.log('labourRunRollback: ' + (res.refused ? 'refused ' + res.refused :
    'liveCleared=' + res.liveCleared + ' roasteryDeleted=' + res.roasteryDeleted +
    ' restored=' + res.restored + ' restoreSkipped=' + res.restoreSkipped));
  return res;
}

function labourRunRollback_(props, app, hub) {
  if (typeof labourWeeklyPull_ !== 'function') return { refused: 'legacy_removed' };
  if (!labourSourceIsClock_(props)) return { refused: 'source_not_clock' };
  var start = labourClockStart_(props);
  if (start === '') return { refused: 'clock_start_unset' };
  var id = props.getProperty('LABOUR_CLOCK_SHEET_ID');
  if (!id) return { refused: 'clock_sheet_unset' };

  props.deleteProperty('LABOUR_SOURCE');

  var liveCleared = 0;
  var locSheet = app.openById(id).getSheetByName('LOCATIONS');
  if (locSheet) {
    var lv = locSheet.getDataRange().getValues();
    var col = (lv[0] || []).map(labourStr_).indexOf('live');
    for (var r = 1; col !== -1 && r < lv.length; r++) {
      if (labourStr_(lv[r][col]) !== '') { locSheet.getRange(r + 1, col + 1).setValue(''); liveCleared++; }
    }
  }

  var summ = ensureSheet(hub, SUMMARY_TAB, SUMMARY_HEADERS);
  var data = summ.getDataRange().getValues();
  var roasteryDeleted = 0;
  for (var i = data.length - 1; i >= 1; i--) {
    if (String(data[i][2]) === 'Labour' && String(data[i][6]) === 'Roastery' && coerceDateStr_(data[i][0]) >= start) {
      summ.deleteRow(i + 1);
      roasteryDeleted++;
    }
  }

  var restored = 0, restoreSkipped = 0;
  var snap = hub.getSheetByName(LABOUR_SNAPSHOT_TAB_);
  var snapRows = snap ? snap.getDataRange().getValues().slice(1) : [];
  if (snapRows.length > 0) {
    var present = {};
    summ.getDataRange().getValues().slice(1).forEach(function (row) { present[rowKey_(row, SUMMARY_KEY_COLS)] = true; });
    snapRows.forEach(function (s) {
      var row = s.slice(0, SUMMARY_HEADERS.length);
      row[0] = coerceDateStr_(row[0]);
      row[1] = coerceDateStr_(row[1]);
      var k = rowKey_(row, SUMMARY_KEY_COLS);
      if (present[k]) { restoreSkipped++; return; }
      summ.appendRow(sheetSafeRow_(row));
      present[k] = true;
      restored++;
    });
    snap.deleteRows(2, snapRows.length);
  }
  return { ok: true, liveCleared: liveCleared, roasteryDeleted: roasteryDeleted, restored: restored, restoreSkipped: restoreSkipped };
}

// Calendar alerts for the clock path (weeklySummarize). Titles are stable per condition (dedup on
// the exact title); details go in the body, one line per item.
function labourRaiseClockAlerts_(res, eventsCache) {
  if (!res) return;
  if (res.clockRefused) {
    healRaiseAlert_('labour', 'Labour clock path refused: ' + res.clockRefused,
      ['LABOUR_SOURCE=clock but the clock path refused (' + res.clockRefused + ').',
       (res.clock && res.clock.error) ? 'detail: ' + res.clock.error : 'detail: none',
       'The legacy Onboarding pull wrote every location this run.'], true, eventsCache);
    return;
  }
  if (!res.clock) return;
  res.clock.weeks.forEach(function (w) {
    if (w.action === 'error') {
      healRaiseAlert_(w.week, 'Labour clock week failed', ['error: ' + w.error,
        'Live locations were NOT written for this week by either path.'], true, eventsCache);
    }
  });
  res.clock.alerts.forEach(function (a) {
    healRaiseAlert_(a.week, a.alert.title, a.alert.lines, a.alert.key === 'labour_exceptions_refused', eventsCache);
  });
}
