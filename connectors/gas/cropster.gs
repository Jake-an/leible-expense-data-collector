/**
 * cropster.gs — Cropster Roasting weekly ingest (PRD-23).
 *
 * doPost kind='roasting' (source 'cropster') -> validateIngest_ (the
 * roasting*Refusal_ helpers below) -> roastingIngest_ -> the `Roasting` tab.
 * Row contract: {date, week_start, profile, green_kg_in, roasted_kg_out,
 * weight_loss_pct, batch_count} with date === week_start (a Sydney Monday).
 * kg only, no department. Key week_start||profile; a post REPLACES every row
 * of each week it carries (roastingUpsert_).
 */
var ROASTING_TAB = 'Roasting';
var ROASTING_SOURCE = 'cropster';
var ROASTING_HEADERS = ['week_start', 'profile', 'green_kg_in', 'roasted_kg_out', 'weight_loss_pct', 'batch_count', 'pulled_at'];

var ROASTING_ROW_FIELDS_ = ['date', 'week_start', 'profile', 'green_kg_in', 'roasted_kg_out', 'weight_loss_pct', 'batch_count'];
var ROASTING_MAX_ROWS_ = 500;
var ROASTING_MAX_WEEKS_ = 13;
var ROASTING_WINDOW_WEEKS_ = 16;
var ROASTING_MAX_KG_ = 100000;
var ROASTING_MAX_PROFILE_LEN_ = 200;
var ROASTING_SHRINK_FLOOR_ = 0.5;

function roastingIsKg_(v) {
  return typeof v === 'number' && isFinite(v) && v >= 0 && v <= ROASTING_MAX_KG_;
}

/** Payload-level checks that need no row walk. Returns a message or ''. */
function roastingPayloadRefusal_(body) {
  if (body.rows.length === 0) {
    return 'roasting_empty: a roasting post needs at least one row';
  }
  if (body.rows.length > ROASTING_MAX_ROWS_) {
    return 'roasting payload has ' + body.rows.length + ' rows; at most ' + ROASTING_MAX_ROWS_ + ' per payload (refused, not truncated)';
  }
  if (body.allow_shrink !== undefined && typeof body.allow_shrink !== 'boolean') {
    return 'allow_shrink must be a boolean';
  }
  return '';
}

/** One roasting row against the row contract. Returns a message or ''. */
function roastingRowRefusal_(r) {
  var keys = Object.keys(r);
  for (var k = 0; k < keys.length; k++) {
    if (ROASTING_ROW_FIELDS_.indexOf(keys[k]) === -1) return 'has unknown field ' + keys[k];
  }
  for (var f = 0; f < ROASTING_ROW_FIELDS_.length; f++) {
    if (!Object.prototype.hasOwnProperty.call(r, ROASTING_ROW_FIELDS_[f])) return 'missing ' + ROASTING_ROW_FIELDS_[f];
  }
  if (typeof r.week_start !== 'string' || !isValidIngestDate_(r.week_start) ||
      weekStartForDate_(r.week_start) !== r.week_start) {
    return 'week_start ' + r.week_start + ' is not a Monday YYYY-MM-DD';
  }
  if (r.date !== r.week_start) return 'date ' + r.date + ' must equal week_start ' + r.week_start;
  var thisMonday = weekStartForDate_(todayStr_());
  if (r.week_start > thisMonday) return 'week_start ' + r.week_start + ' is after the current week (' + thisMonday + ')';
  if (r.week_start < addDaysStr_(thisMonday, -7 * ROASTING_WINDOW_WEEKS_)) {
    return 'week_start ' + r.week_start + ' is more than ' + ROASTING_WINDOW_WEEKS_ + ' weeks before the current week';
  }
  if (typeof r.profile !== 'string' || r.profile.trim().length === 0 || r.profile.length > ROASTING_MAX_PROFILE_LEN_) {
    return 'profile must be a non-empty string of at most ' + ROASTING_MAX_PROFILE_LEN_ + ' chars';
  }
  if (!roastingIsKg_(r.green_kg_in)) return 'green_kg_in must be a finite number in [0, ' + ROASTING_MAX_KG_ + ']';
  if (!roastingIsKg_(r.roasted_kg_out)) return 'roasted_kg_out must be a finite number in [0, ' + ROASTING_MAX_KG_ + ']';
  if (typeof r.batch_count !== 'number' || !isFinite(r.batch_count) || Math.floor(r.batch_count) !== r.batch_count || r.batch_count < 0) {
    return 'batch_count must be an integer >= 0';
  }
  if (r.weight_loss_pct !== null &&
      !(typeof r.weight_loss_pct === 'number' && isFinite(r.weight_loss_pct) && r.weight_loss_pct >= 0 && r.weight_loss_pct <= 100)) {
    return 'weight_loss_pct must be null or a finite number in [0, 100]';
  }
  return '';
}

/** Cross-row checks (distinct weeks, in-payload duplicate keys). Returns a message or ''. */
function roastingRowsetRefusal_(rows) {
  var seen = {}, weeks = {}, nWeeks = 0;
  for (var i = 0; i < rows.length; i++) {
    var key = rows[i].week_start + '||' + rows[i].profile;
    if (Object.prototype.hasOwnProperty.call(seen, key)) return 'duplicate key in payload: ' + key;
    seen[key] = true;
    if (!Object.prototype.hasOwnProperty.call(weeks, rows[i].week_start)) { weeks[rows[i].week_start] = true; nWeeks++; }
  }
  if (nWeeks > ROASTING_MAX_WEEKS_) {
    return 'roasting payload spans ' + nWeeks + ' distinct weeks; at most ' + ROASTING_MAX_WEEKS_ + ' per payload';
  }
  return '';
}

/** doPost's lock-held body for kind='roasting'. Throws to refuse (doPost turns it into result:error). */
function roastingIngest_(body) {
  var sheet = ensureSheet(getHubSpreadsheet_(), ROASTING_TAB, ROASTING_HEADERS);
  return roastingUpsert_(sheet, body.rows, { allow_shrink: body.allow_shrink === true });
}

/**
 * Week-scoped atomic replace. Rows of every week in the batch are replaced by
 * the batch rows; all other weeks are kept. The new body is built in memory
 * and written (header + body, padded with blanks to the old height) in ONE
 * setValues; the trailing-blank trim afterwards is best effort.
 * @param {Object} sheet
 * @param {Array<Object>} rows validated roasting rows
 * @param {{allow_shrink?:boolean}} [opts]
 * @return {{rowsAdded:number, rowsUpdated:number, weeks:Array<string>}}
 */
function roastingUpsert_(sheet, rows, opts) {
  var width = ROASTING_HEADERS.length;
  var lastRow = sheet.getLastRow();
  var existing = lastRow >= 2 ? sheet.getDataRange().getValues().slice(1) : [];

  var batchWeeks = {}, newSum = {}, oldSum = {}, oldKeys = {}, weekList = [];
  rows.forEach(function (r) {
    if (!batchWeeks[r.week_start]) { batchWeeks[r.week_start] = true; newSum[r.week_start] = 0; oldSum[r.week_start] = 0; weekList.push(r.week_start); }
    newSum[r.week_start] += r.roasted_kg_out;
  });
  var kept = [];
  existing.forEach(function (s) {
    if (s[0] === '' || s[0] === null || s[0] === undefined) return; // blank / trim leftover
    var row = s.slice();
    row[0] = coerceDateStr_(row[0]);
    if (batchWeeks[row[0]]) {
      oldSum[row[0]] += Number(row[3]) || 0;
      oldKeys[row[0] + '||' + sheetUnguardCell_(row[1])] = true;
    } else {
      kept.push(row);
    }
  });

  if (!(opts && opts.allow_shrink === true)) {
    var shrunk = weekList.filter(function (w) {
      return oldSum[w] > 0 && newSum[w] < ROASTING_SHRINK_FLOOR_ * oldSum[w];
    });
    if (shrunk.length) {
      throw new Error('roasting shrink guard: week(s) ' + shrunk.join(', ') + ' would drop below ' +
        Math.round(ROASTING_SHRINK_FLOOR_ * 100) + '% of the stored roasted_kg_out; nothing written ' +
        '(re-post with allow_shrink:true if intended)');
    }
  }

  var stamp = ingestServerStamp_();
  var added = 0, updated = 0;
  var fresh = rows.map(function (r) {
    if (Object.prototype.hasOwnProperty.call(oldKeys, r.week_start + '||' + r.profile)) updated++; else added++;
    return [r.week_start, r.profile, r.green_kg_in, r.roasted_kg_out, r.weight_loss_pct, r.batch_count, stamp];
  });
  var body = kept.concat(fresh).sort(function (a, b) {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    var pa = String(a[1]), pb = String(b[1]);
    return pa < pb ? -1 : (pa > pb ? 1 : 0);
  }).map(sheetSafeRow_);

  var oldHeight = Math.max(lastRow, 1);
  var out = [ROASTING_HEADERS.slice()].concat(body);
  while (out.length < oldHeight) {
    var blank = [];
    for (var c = 0; c < width; c++) blank.push('');
    out.push(blank);
  }
  // The grid is fixed (~1000 rows) and rows are never purged: grow it first or
  // setValues throws "exceeds grid limits" and ingest stops for good.
  var maxRows = sheet.getMaxRows();
  if (out.length > maxRows) sheet.insertRowsAfter(maxRows, out.length - maxRows);
  sheet.getRange(1, 1, out.length, width).setValues(out);

  var firstBlank = body.length + 2;
  if (oldHeight >= firstBlank) {
    try { sheet.deleteRows(firstBlank, oldHeight - firstBlank + 1); } catch (err) { Logger.log('roastingUpsert_: trailing-blank trim failed — ' + err); }
  }
  return { rowsAdded: added, rowsUpdated: updated, weeks: weekList.sort() };
}
