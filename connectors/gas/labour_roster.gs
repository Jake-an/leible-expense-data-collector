/**
 * labour_roster.gs — doPost `roster` kind (Amendment B1, ADR-008).
 *
 * The weekly BrightHR roster CSV (posted by tools/roster/) is the labour source
 * for hours AND shop. It lands in the LABOUR Sheet's CLOCK_RAW tab, converted to
 * the existing LABOUR_CLOCK_COLS shape so labourRowsToShifts_ is UNCHANGED.
 *
 * Boundary rule (ADR-008): doPost's `roster` kind writes the Labour Sheet
 * (LABOUR_CLOCK_SHEET_ID), never the hub and never LABOUR_SHEET_ID.
 *
 * Pure pieces (unit-tested): labourRosterRowRefusal_, labourRosterToClockRows_.
 * Write: labourRosterIngest_(rows, ss) — date-level replace, one setValues.
 */

var MAX_ROSTER_ROWS_ = 1000;
var MAX_ROSTER_HOURS_ = 16;
var LABOUR_ROSTER_ID_PREFIX_ = 'roster:';
var LABOUR_ROSTER_TAB_ = 'CLOCK_RAW';
var LABOUR_ROSTER_TIME_RE_ = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Per-row shape gate for kind='roster'. Returns a refusal string (without the
 * 'row N ' prefix) or null. The generic validateIngest_ loop has already checked
 * `date`. Numbers use typeof/isFinite, never Number() coercion (a coerced null
 * or '' would read as 0 and slip a bad row through).
 */
function labourRosterRowRefusal_(r) {
  // Key PRESENT is the reject, even when empty/null: roster rows carry no
  // department at all (it comes from LOCATIONS at costing time).
  if (Object.prototype.hasOwnProperty.call(r, 'department')) {
    return 'must not carry a department (roster rows carry none; department comes from LOCATIONS)';
  }
  if (typeof r.email !== 'string' || r.email !== r.email.toLowerCase() || r.email.indexOf('@') === -1) {
    return 'invalid email (needs a lowercase address containing @)';
  }
  if (typeof r.start !== 'string' || !LABOUR_ROSTER_TIME_RE_.test(r.start)) {
    return 'invalid start (needs HH:MM, 24h)';
  }
  if (typeof r.end !== 'string' || !LABOUR_ROSTER_TIME_RE_.test(r.end)) {
    return 'invalid end (needs HH:MM, 24h)';
  }
  if (r.end === r.start) return 'end must differ from start';
  if (typeof r.hours !== 'number' || !isFinite(r.hours) || !(r.hours > 0) || r.hours > MAX_ROSTER_HOURS_) {
    return 'invalid hours (needs a finite JSON number, 0 < hours <= ' + MAX_ROSTER_HOURS_ + ')';
  }
  if (typeof r.location !== 'string' || r.location.trim() === '') {
    return 'invalid location (needs a non-empty string)';
  }
  return null;
}

function labourRosterNextDay_(iso) {
  var p = iso.split('-');
  var d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + 1));
  return d.getUTCFullYear() + '-' + labourPad2_(d.getUTCMonth() + 1) + '-' + labourPad2_(d.getUTCDate());
}

function labourRosterMinutes_(hhmm) {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

/**
 * Roster rows -> objects keyed by LABOUR_CLOCK_COLS keys. break_minutes makes
 * labourRowsToShifts_ (which prefers out - in - break over the hours cell) land
 * on the CSV's paid hours; rate stays blank so the RATES fallback applies.
 */
function labourRosterToClockRows_(rows) {
  return rows.map(function (r) {
    var s = labourRosterMinutes_(r.start), e = labourRosterMinutes_(r.end);
    var crosses = r.end < r.start;
    var span = (crosses ? e + 1440 : e) - s;
    return {
      person_email: r.email,
      person_name: typeof r.name === 'string' ? r.name : '',
      clock_in: r.date + ' ' + r.start,
      clock_out: (crosses ? labourRosterNextDay_(r.date) : r.date) + ' ' + r.end,
      hours: r.hours,
      break_minutes: Math.max(0, Math.round(span - r.hours * 60)),
      location: r.location,
      rate: '',
      record_id: LABOUR_ROSTER_ID_PREFIX_ + r.email + '|' + r.date + '|' + r.start
    };
  });
}

// 'YYYY-MM-DD HH:MM' in Sydney local time for a labourSydneyParts_ result.
function labourRosterFmt_(parts) {
  var d = new Date(parts.ms + labourSydneyOffsetHours_(parts.ms) * LABOUR_CLOCK_MS_HOUR_);
  return parts.date + ' ' + labourPad2_(d.getUTCHours()) + ':' + labourPad2_(d.getUTCMinutes());
}

// Re-normalise a kept clock cell (string or Date) to plain text; leave blanks and
// unparseable cells exactly as they are.
function labourRosterNormaliseCell_(v) {
  var p = labourSydneyParts_(v);
  return p ? labourRosterFmt_(p) : v;
}

/**
 * Date-level replace into CLOCK_RAW.
 *  - The set of DATES in the payload is replaced: every existing row whose
 *    clock-in Sydney date is in that set AND whose record_id starts 'roster:' is
 *    dropped, then the new rows are added. Other dates / non-roster rows stay.
 *  - The existing row's date comes from labourSydneyParts_ (string OR Date),
 *    never a string slice: a real Sheet turns 'YYYY-MM-DD HH:MM' text into a Date.
 *  - The whole table is built in memory; clock_in/clock_out are set to plain text
 *    (RB3), the table is written with ONE setValues (RB4), then only the leftover
 *    tail is cleared. Kept rows' clock cells are re-normalised to text (RB9).
 * @returns {{rowsAdded:number, rowsReplaced:number, rowsReplacedByDate:Object, dates:string[]}|{refused:string}}
 */
function labourRosterIngest_(rows, ss) {
  var sheet = ss.getSheetByName(LABOUR_ROSTER_TAB_);
  if (!sheet) return { refused: 'clock_raw_missing' };
  var data = sheet.getDataRange().getValues();
  var hdr = (data[0] || []).map(labourStr_);
  var ix = {};
  var missing = [];
  Object.keys(LABOUR_CLOCK_COLS).forEach(function (k) {
    var i = hdr.indexOf(LABOUR_CLOCK_COLS[k]);
    if (i === -1) missing.push(LABOUR_CLOCK_COLS[k]); else ix[k] = i;
  });
  if (missing.length) return { refused: 'clock_raw_columns_missing', missing: missing };
  var width = hdr.length;

  var newObjs = labourRosterToClockRows_(rows);
  var dateSet = {};
  rows.forEach(function (r) { dateSet[r.date] = true; });
  var dates = Object.keys(dateSet).sort();

  var kept = [];
  var replacedByDate = {};
  var replaced = 0;
  for (var n = 1; n < data.length; n++) {
    var row = data[n];
    if (!row.some(function (c) { return labourStr_(c) !== ''; })) continue;   // blank rows fall into the tail
    var id = labourStr_(row[ix.record_id]);
    if (id.indexOf(LABOUR_ROSTER_ID_PREFIX_) === 0) {
      var p = labourSydneyParts_(row[ix.clock_in]);
      var d = p ? p.date : (id.split('|')[1] || '');
      if (dateSet[d] === true) {
        replacedByDate[d] = (replacedByDate[d] || 0) + 1;
        replaced++;
        continue;
      }
    }
    var out = row.slice();
    while (out.length < width) out.push('');
    out[ix.clock_in] = labourRosterNormaliseCell_(out[ix.clock_in]);
    out[ix.clock_out] = labourRosterNormaliseCell_(out[ix.clock_out]);
    kept.push(out);
  }

  var added = newObjs.map(function (o) {
    var line = [];
    for (var c = 0; c < width; c++) line.push('');
    Object.keys(LABOUR_CLOCK_COLS).forEach(function (k) { line[ix[k]] = o[k]; });
    return line;
  });
  var table = kept.concat(added);
  var oldDataRows = data.length - 1;

  // Text format first, over every row we are about to touch, so Sheets cannot
  // re-convert the datetime strings back to Dates on write.
  var fmtRows = Math.max(table.length, oldDataRows);
  if (fmtRows > 0) {
    sheet.getRange(2, ix.clock_in + 1, fmtRows, 1).setNumberFormat('@');
    sheet.getRange(2, ix.clock_out + 1, fmtRows, 1).setNumberFormat('@');
  }
  if (table.length > 0) sheet.getRange(2, 1, table.length, width).setValues(table);
  if (oldDataRows > table.length) {
    sheet.getRange(2 + table.length, 1, oldDataRows - table.length, width).clearContent();
  }
  return { rowsAdded: added.length, rowsReplaced: replaced, rowsReplacedByDate: replacedByDate, dates: dates };
}

/**
 * doPost branch for kind='roster'. Called after checkIngestToken_ and
 * validateIngest_ have passed. Opens ONLY LABOUR_CLOCK_SHEET_ID inside the
 * script lock; the hub and LABOUR_SHEET_ID are never opened.
 */
function labourRosterDoPost_(body) {
  var res = withScriptLock_(function () {
    var id = PropertiesService.getScriptProperties().getProperty('LABOUR_CLOCK_SHEET_ID');
    if (!id) return { refused: 'clock_sheet_unset' };
    return labourRosterIngest_(body.rows, SpreadsheetApp.openById(id));
  });
  if (res === LOCK_TIMEOUT_) return jsonOut_({ result: 'error', code: 'LOCKED', retryable: true });
  if (res.refused) return jsonOut_({ result: 'error', code: res.refused, message: res.refused });
  // A run that reached here SUCCEEDED; stamp the watchdog heartbeat. Never throws.
  stalenessStampHeartbeat_(body.source);
  return jsonOut_({
    result: 'ok',
    rowsAdded: res.rowsAdded,
    rowsReplaced: res.rowsReplaced,
    rowsReplacedByDate: res.rowsReplacedByDate,
    dates: res.dates
  });
}
