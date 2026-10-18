/**
 * labour.gs — pure labour-cost calculation for the clock-in rebuild (ADR-008, pending).
 *
 * Phase `labour-clock` (PRD-15..PRD-20) fills this file in. Every function here is
 * PURE: it takes arrays/objects and returns values. No Sheet, property-store, network,
 * formatter or logger access, and no clock reads — reading the Labour Sheet, writing
 * results and raising alerts are wired in a LATER phase (weeklySummarize wiring).
 *
 * Name hygiene: Code.gs already owns LABOUR_TAB, LABOUR_HEADERS, getLabourSpreadsheet_
 * and labourWeeklyPull_ (the legacy Onboarding-sheet pull). Everything new in this file
 * is prefixed LABOUR_CLOCK_ / labour...Clock... / labour<Verb>_ and must not collide —
 * all .gs files share one global namespace in Apps Script.
 */

/* ------------------------------------------------------------------ *
 * Step 0 — config reader, multiplier lookup, NSW holiday table + alerts
 * (PRD-16, PRD-20). Seeds are data for the later labourSetupSheet(); the
 * lookup below reads cfg only.
 * ------------------------------------------------------------------ */

var LABOUR_CLOCK_AWARD_URL_ = 'https://awards.fairwork.gov.au/MA000119.html';

var LABOUR_CLOCK_MULTIPLIER_SEED_ = [
  ['employment_type', 'rate_basis', 'level_band', 'day_type', 'multiplier', 'source_url', 'as_of'],
  ['casual', 'unloaded', 'L0-2', 'weekday', 1.25, LABOUR_CLOCK_AWARD_URL_, '2026-10-14'],
  ['casual', 'unloaded', 'L3-6', 'weekday', 1.25, LABOUR_CLOCK_AWARD_URL_, '2026-10-14'],
  ['casual', 'unloaded', 'L0-2', 'saturday', 1.5, LABOUR_CLOCK_AWARD_URL_, '2026-10-14'],
  ['casual', 'unloaded', 'L3-6', 'saturday', 1.5, LABOUR_CLOCK_AWARD_URL_, '2026-10-14'],
  ['casual', 'unloaded', 'L3-6', 'sunday', 1.75, LABOUR_CLOCK_AWARD_URL_, '2026-10-14'],
  ['casual', 'unloaded', 'L0-2', 'sunday', 1.5, LABOUR_CLOCK_AWARD_URL_, '2026-10-14'],
  ['casual', 'unloaded', 'L0-2', 'public_holiday', 2.5, LABOUR_CLOCK_AWARD_URL_, '2026-10-14'],
  ['casual', 'unloaded', 'L3-6', 'public_holiday', 2.5, LABOUR_CLOCK_AWARD_URL_, '2026-10-14'],
  ['casual', 'loaded', 'L0-2', 'weekday', 1.0, LABOUR_CLOCK_AWARD_URL_, '2026-10-14'],
  ['casual', 'loaded', 'L3-6', 'weekday', 1.0, LABOUR_CLOCK_AWARD_URL_, '2026-10-14'],
  ['casual', 'loaded', 'L0-2', 'saturday', 1.2, LABOUR_CLOCK_AWARD_URL_, '2026-10-14'],
  ['casual', 'loaded', 'L3-6', 'saturday', 1.2, LABOUR_CLOCK_AWARD_URL_, '2026-10-14'],
  ['casual', 'loaded', 'L3-6', 'sunday', 1.4, LABOUR_CLOCK_AWARD_URL_, '2026-10-14'],
  ['casual', 'loaded', 'L0-2', 'sunday', 1.2, LABOUR_CLOCK_AWARD_URL_, '2026-10-14'],
  ['casual', 'loaded', 'L0-2', 'public_holiday', 2.0, LABOUR_CLOCK_AWARD_URL_, '2026-10-14'],
  ['casual', 'loaded', 'L3-6', 'public_holiday', 2.0, LABOUR_CLOCK_AWARD_URL_, '2026-10-14'],
  ['full_time', 'any', 'all', 'weekday', 1.0, LABOUR_CLOCK_AWARD_URL_, '2026-10-14'],
  ['full_time', 'any', 'all', 'saturday', 1.25, LABOUR_CLOCK_AWARD_URL_, '2026-10-14'],
  ['full_time', 'any', 'all', 'sunday', 1.5, LABOUR_CLOCK_AWARD_URL_, '2026-10-14'],
  ['full_time', 'any', 'all', 'public_holiday', 2.25, LABOUR_CLOCK_AWARD_URL_, '2026-10-14'],
  ['part_time', 'any', 'all', 'weekday', 1.0, LABOUR_CLOCK_AWARD_URL_, '2026-10-14'],
  ['part_time', 'any', 'all', 'saturday', 1.25, LABOUR_CLOCK_AWARD_URL_, '2026-10-14'],
  ['part_time', 'any', 'all', 'sunday', 1.5, LABOUR_CLOCK_AWARD_URL_, '2026-10-14'],
  ['part_time', 'any', 'all', 'public_holiday', 2.25, LABOUR_CLOCK_AWARD_URL_, '2026-10-14']
];

// Official NSW table (nsw.gov.au/about-nsw/public-holidays), incl. weekend-falling and "additional day" rows.
var LABOUR_NSW_HOLIDAYS_SEED_ = [
  { date: '2026-01-01', name: "New Year's Day" },
  { date: '2026-01-26', name: 'Australia Day' },
  { date: '2026-04-03', name: 'Good Friday' },
  { date: '2026-04-04', name: 'Easter Saturday' },
  { date: '2026-04-05', name: 'Easter Sunday' },
  { date: '2026-04-06', name: 'Easter Monday' },
  { date: '2026-04-25', name: 'Anzac Day' },
  { date: '2026-04-27', name: 'Anzac Day additional day' },
  { date: '2026-06-08', name: "King's Birthday" },
  { date: '2026-10-05', name: 'Labour Day' },
  { date: '2026-12-25', name: 'Christmas Day' },
  { date: '2026-12-26', name: 'Boxing Day' },
  { date: '2026-12-28', name: 'Boxing Day additional day' },
  { date: '2027-01-01', name: "New Year's Day" },
  { date: '2027-01-26', name: 'Australia Day' },
  { date: '2027-03-26', name: 'Good Friday' },
  { date: '2027-03-27', name: 'Easter Saturday' },
  { date: '2027-03-28', name: 'Easter Sunday' },
  { date: '2027-03-29', name: 'Easter Monday' },
  { date: '2027-04-25', name: 'Anzac Day' },
  { date: '2027-04-26', name: 'Anzac Day additional day' },
  { date: '2027-06-14', name: "King's Birthday" },
  { date: '2027-10-04', name: 'Labour Day' },
  { date: '2027-12-25', name: 'Christmas Day' },
  { date: '2027-12-26', name: 'Boxing Day' },
  { date: '2027-12-27', name: 'Christmas additional day' },
  { date: '2027-12-28', name: 'Boxing Day additional day' }
];

var LABOUR_HOLIDAY_ALERT_DAYS_ = 60;

var LABOUR_CLOCK_EXPECTED_HEADERS_ = {
  CONFIG: ['employment_type', 'rate_basis', 'level_band', 'day_type', 'multiplier', 'source_url', 'as_of'],
  HOLIDAYS: ['date', 'name'],
  LOCATIONS: ['location', 'code', 'department', 'live'],
  RATES: ['person_email', 'rate', 'effective_from'],
  PEOPLE: ['person_email', 'employment_type', 'level', 'rate_basis'],
  // Amendment A: optional rule tabs (a missing / empty tab = no rules of that kind).
  PAY_TABLE: ['role', 'level', 'rate', 'effective_from'],
  CASH_SHIFTS: ['person_email', 'location', 'days', 'rate'],
  FIXED: ['person_email', 'location', 'role', 'hours_per_week', 'rate', 'effective_from']
};

var LABOUR_CLOCK_RULE_TABS_ = ['PAY_TABLE', 'CASH_SHIFTS', 'FIXED'];

// Seed for PAY_TABLE (casual, loaded; Jake 2026-10-14). The Operations Manager has no award level.
var LABOUR_CLOCK_PAY_TABLE_SEED_ = [
  ['Barista', 1, 32.67, '2026-07-01'],
  ['Senior Barista', 3, 34.97, '2026-07-01'],
  ['Roasting Team', 4, 36.82, '2026-07-01'],
  ['Head Barista', 5, 39.12, '2026-07-01'],
  ['Operations Manager', '—', 47.13, '2026-07-01']
];

// Staff the roster names before RATES / PEOPLE know them (usually a new barista) are costed as a
// base Barista (Jake 2026-10-19): the PAY_TABLE 'Barista' row effective on the shift date, else this
// rate, as casual / loaded. They are listed in the labour_default_barista alert, never dropped.
var LABOUR_DEFAULT_ROLE_ = 'barista';
var LABOUR_DEFAULT_RATE_ = 32.67;
var LABOUR_DEFAULT_LEVEL_ = 1;

function labourDefaultBarista_(cfg, date) {
  var best = null;
  (cfg.payTable || []).forEach(function (p) {
    if (labourStr_(p.role).toLowerCase() !== LABOUR_DEFAULT_ROLE_) return;
    if (p.effective_from !== '' && p.effective_from > date) return;
    if (best === null || p.effective_from > best.effective_from) best = p;
  });
  return { rate: best ? best.rate : LABOUR_DEFAULT_RATE_,
    level: best && best.level !== '' ? best.level : LABOUR_DEFAULT_LEVEL_ };
}

var LABOUR_CLOCK_WEEKDAYS_ = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function labourPad2_(n) { return (n < 10 ? '0' : '') + n; }

function labourStr_(v) { return String(v === null || v === undefined ? '' : v).trim(); }

// Cell (string or Date) -> 'yyyy-MM-dd' via LOCAL components (never toISOString).
function labourDateKey_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return v.getFullYear() + '-' + labourPad2_(v.getMonth() + 1) + '-' + labourPad2_(v.getDate());
  }
  return labourStr_(v).slice(0, 10);
}

// Cell (string or Date) -> 'yyyy-MM-dd' that is a REAL calendar date, else throws naming `what`.
// The Sheet hands back Date objects; String(date) / 2026-02-30 must fail loud, never mis-bucket.
function labourDayKey_(v, what) {
  var k = labourDateKey_(v);
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k);
  var d = m && new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (!d || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) {
    throw new Error('labour: bad ' + (what || 'date') + ' ' + JSON.stringify(String(v)) + ' (want yyyy-MM-dd)');
  }
  return k;
}

// Maps each expected column to its index; throws naming the tab and column.
function labourTabIndex_(tabs, name) {
  var rows = tabs && tabs[name];
  if (!Array.isArray(rows) || rows.length === 0 || !Array.isArray(rows[0])) {
    throw new Error('labour: config tab ' + name + ' is missing or has no header row');
  }
  var hdr = rows[0].map(labourStr_);
  var idx = {};
  LABOUR_CLOCK_EXPECTED_HEADERS_[name].forEach(function (col) {
    var i = hdr.indexOf(col);
    if (i === -1) throw new Error('labour: config tab ' + name + ' is missing column "' + col + '"');
    idx[col] = i;
  });
  return {
    idx: idx,
    rows: rows.slice(1).filter(function (r) { return Array.isArray(r) && r.some(function (c) { return labourStr_(c) !== ''; }); })
  };
}

function labourIsLive_(v) {
  if (v === true) return true;
  var s = labourStr_(v).toLowerCase();
  return s === 'true' || s === 'y' || s === 'yes';
}

// An optional tab that is absent, empty, or has a blank row 1 counts as missing (no rules).
// A present tab with a real header row is validated like any other (drift throws naming it).
function labourOptionalTab_(tabs, name) {
  var rows = tabs && tabs[name];
  if (!Array.isArray(rows) || rows.length === 0 || !Array.isArray(rows[0]) ||
    !rows[0].some(function (c) { return labourStr_(c) !== ''; })) return null;
  return labourTabIndex_(tabs, name);
}

// PAY_TABLE -> [{role, level, rate, effective_from}]. A level of blank / dash is read as '' (R7):
// it never fills a level and is never passed to labourLevelBand_.
function labourParsePayTable_(tabs) {
  var t = labourOptionalTab_(tabs, 'PAY_TABLE');
  if (!t) return [];
  return t.rows.map(function (r, n) {
    var where = 'labour: PAY_TABLE row ' + (n + 2);
    var rate = labourPositiveNumber_(r[t.idx.rate]);
    if (rate === null) throw new Error(where + ' has invalid rate ' + JSON.stringify(r[t.idx.rate]));
    var ls = labourStr_(r[t.idx.level]);
    var level = '';
    if (ls !== '' && ls !== '—' && ls !== '–' && ls !== '-') {
      try { labourLevelBand_(ls); } catch (e) { throw new Error(where + ': ' + e.message); }
      level = ls.toLowerCase() === 'intro' ? 'intro' : Number(ls);
    }
    var eff = labourDateKey_(r[t.idx.effective_from]);
    if (eff !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(eff)) {
      throw new Error(where + ' has malformed effective_from ' + JSON.stringify(r[t.idx.effective_from]));
    }
    return { role: labourStr_(r[t.idx.role]), level: level, rate: rate, effective_from: eff };
  });
}

function labourMultKey_(type, basis, band, day) { return type + '|' + basis + '|' + band + '|' + day; }

function labourReadConfig_(tabs) {
  var cfg = { multipliers: {}, holidays: {}, locations: {}, rates: {}, people: {}, payTable: [], cashShifts: [], fixed: [] };
  var t;

  t = labourTabIndex_(tabs, 'CONFIG');
  t.rows.forEach(function (r, n) {
    var raw = r[t.idx.multiplier];
    var m = (typeof raw === 'number') ? raw : (labourStr_(raw) === '' ? NaN : Number(labourStr_(raw)));
    if (!isFinite(m) || m <= 0) {
      throw new Error('labour: CONFIG row ' + (n + 2) + ' has invalid multiplier ' + JSON.stringify(raw));
    }
    var mk = labourMultKey_(labourStr_(r[t.idx.employment_type]).toLowerCase(),
      labourStr_(r[t.idx.rate_basis]).toLowerCase(), labourStr_(r[t.idx.level_band]),
      labourStr_(r[t.idx.day_type]).toLowerCase());
    if (Object.prototype.hasOwnProperty.call(cfg.multipliers, mk)) {
      throw new Error('labour: CONFIG row ' + (n + 2) + ' duplicates key ' + JSON.stringify(mk));
    }
    cfg.multipliers[mk] = m;
  });

  t = labourTabIndex_(tabs, 'HOLIDAYS');
  t.rows.forEach(function (r, n) {
    var d = labourDateKey_(r[t.idx.date]);
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      throw new Error('labour: HOLIDAYS row ' + (n + 2) + ' has malformed date ' + JSON.stringify(r[t.idx.date]));
    }
    if (!d) {
      if (labourStr_(r[t.idx.name]) !== '') throw new Error('labour: HOLIDAYS row ' + (n + 2) + ' has a name but no date');
      return;
    }
    cfg.holidays[d] = labourStr_(r[t.idx.name]);
  });

  t = labourTabIndex_(tabs, 'LOCATIONS');
  t.rows.forEach(function (r, n) {
    var dept = labourStr_(r[t.idx.department]);
    if (dept !== 'Cafe' && dept !== 'Roastery') {
      throw new Error('labour: LOCATIONS row ' + (n + 2) + ' has unknown department ' + JSON.stringify(dept));
    }
    cfg.locations[labourStr_(r[t.idx.location])] = {
      code: labourStr_(r[t.idx.code]), department: dept, live: labourIsLive_(r[t.idx.live])
    };
  });

  t = labourTabIndex_(tabs, 'RATES');
  t.rows.forEach(function (r, n) {
    var rate = Number(r[t.idx.rate]);
    if (labourStr_(r[t.idx.rate]) === '' || !isFinite(rate)) {
      throw new Error('labour: RATES row ' + (n + 2) + ' has invalid rate ' + JSON.stringify(r[t.idx.rate]));
    }
    var eff = labourDateKey_(r[t.idx.effective_from]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eff)) {
      throw new Error('labour: RATES row ' + (n + 2) + ' has malformed effective_from ' + JSON.stringify(r[t.idx.effective_from]));
    }
    var email = labourStr_(r[t.idx.person_email]).toLowerCase();
    (cfg.rates[email] = cfg.rates[email] || []).push({ rate: rate, effective_from: eff });
  });

  // PEOPLE is validated against CONFIG here, so a typo fails at read time naming the row,
  // not later as a 'no multiplier' throw. Blank fields stay legal (person_incomplete).
  var knownTypes = {};
  var knownBases = {};
  Object.keys(cfg.multipliers).forEach(function (k) {
    var parts = k.split('|');
    knownTypes[parts[0]] = true;
    knownBases[parts[1]] = true;
  });
  t = labourTabIndex_(tabs, 'PEOPLE');
  t.rows.forEach(function (r, n) {
    var email = labourStr_(r[t.idx.person_email]).toLowerCase();
    var type = labourStr_(r[t.idx.employment_type]).toLowerCase();
    var basis = labourStr_(r[t.idx.rate_basis]).toLowerCase();
    var where = 'labour: PEOPLE row ' + (n + 2) + ' (' + email + ')';
    if (type !== '' && !knownTypes[type]) {
      throw new Error(where + ' has unknown employment_type ' + JSON.stringify(r[t.idx.employment_type]) +
        ' (CONFIG has ' + Object.keys(knownTypes).sort().join(', ') + ')');
    }
    if (basis !== '' && !knownBases[basis]) {
      throw new Error(where + ' has unknown rate_basis ' + JSON.stringify(r[t.idx.rate_basis]) +
        ' (CONFIG has ' + Object.keys(knownBases).sort().join(', ') + ')');
    }
    if (labourStr_(r[t.idx.level]) !== '') {
      try { labourLevelBand_(r[t.idx.level]); } catch (e) { throw new Error(where + ': ' + e.message); }
    }
    cfg.people[email] = { employment_type: type, level: r[t.idx.level], rate_basis: basis };
  });

  cfg.payTable = labourParsePayTable_(tabs);

  // CASH_SHIFTS / FIXED are cross-validated against LOCATIONS and PEOPLE here, so a typo fails at
  // read time naming the tab and row (never the email). Optional: absent / empty = no rules.
  function ruleRef(where, r, idx) {
    if (!Object.prototype.hasOwnProperty.call(cfg.locations, labourStr_(r[idx.location]))) {
      throw new Error(where + ' has a location that is not in LOCATIONS');
    }
    var email = labourStr_(r[idx.person_email]).toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(cfg.people, email)) {
      throw new Error(where + ' has a person_email that is not in PEOPLE');
    }
    return email;
  }
  function ruleNumber(where, label, v) {
    var n = labourPositiveNumber_(v);
    if (n === null) throw new Error(where + ' has invalid ' + label + ' ' + JSON.stringify(v) + ' (want a positive number)');
    return n;
  }
  t = labourOptionalTab_(tabs, 'CASH_SHIFTS');
  if (t) t.rows.forEach(function (r, n) {
    var where = 'labour: CASH_SHIFTS row ' + (n + 2);
    var email = ruleRef(where, r, t.idx);
    var days = labourStr_(r[t.idx.days]).toLowerCase().split(',').map(labourStr_).filter(function (d) { return d !== ''; });
    if (days.length === 0) throw new Error(where + ' has no days (use mon,tue,wed,thu,fri,sat,sun)');
    days.forEach(function (d) {
      if (LABOUR_CLOCK_WEEKDAYS_.indexOf(d) === -1) {
        throw new Error(where + ' has invalid days token ' + JSON.stringify(d) + ' (use mon,tue,wed,thu,fri,sat,sun)');
      }
    });
    cfg.cashShifts.push({ email: email, location: labourStr_(r[t.idx.location]), days: days, rate: ruleNumber(where, 'rate', r[t.idx.rate]) });
  });
  t = labourOptionalTab_(tabs, 'FIXED');
  if (t) t.rows.forEach(function (r, n) {
    var where = 'labour: FIXED row ' + (n + 2);
    var email = ruleRef(where, r, t.idx);
    var eff = labourDateKey_(r[t.idx.effective_from]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eff)) {
      throw new Error(where + ' has malformed effective_from ' + JSON.stringify(r[t.idx.effective_from]));
    }
    cfg.fixed.push({ email: email, location: labourStr_(r[t.idx.location]), role: labourStr_(r[t.idx.role]),
      hours: ruleNumber(where, 'hours_per_week', r[t.idx.hours_per_week]), rate: ruleNumber(where, 'rate', r[t.idx.rate]),
      effective_from: eff });
  });

  return cfg;
}

function labourLevelBand_(level) {
  var s = labourStr_(level).toLowerCase();
  if (s === 'intro') return 'L0-2';
  var n = Number(s);
  if (s === '' || !isFinite(n) || n < 0 || n > 6 || n !== Math.floor(n)) {
    throw new Error('labour: unrecognised level ' + JSON.stringify(level));
  }
  return n <= 2 ? 'L0-2' : 'L3-6';
}

function labourMultiplier_(cfg, employmentType, rateBasis, level, dayType) {
  var band = labourLevelBand_(level);
  var tries = [[rateBasis, band], [rateBasis, 'all'], ['any', band], ['any', 'all']];
  for (var i = 0; i < tries.length; i++) {
    var k = labourMultKey_(employmentType, tries[i][0], tries[i][1], dayType);
    if (Object.prototype.hasOwnProperty.call(cfg.multipliers, k)) return cfg.multipliers[k];
  }
  throw new Error('labour: no multiplier for ' + employmentType + '/' + rateBasis + '/' + band + '/' + dayType);
}

function labourDayNumber_(key) {
  var p = key.split('-');
  return Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])) / 86400000;
}

function labourHolidayAlerts_(cfg, today) {
  today = labourDayKey_(today, 'today');
  var dates = Object.keys(cfg.holidays).sort();
  var year = today.slice(0, 4);
  var inYear = dates.filter(function (d) { return d.slice(0, 4) === year; }).length;
  if (inYear === 0) {
    return [{
      key: 'labour_holidays_empty',
      title: 'Labour: no NSW public holidays loaded for ' + year + ' - refresh from nsw.gov.au',
      lines: ['HOLIDAYS tab has no entries dated ' + year + '; public-holiday penalty rates cannot be applied.']
    }];
  }
  var end = dates[dates.length - 1];
  var left = labourDayNumber_(end) - labourDayNumber_(today);
  if (left <= LABOUR_HOLIDAY_ALERT_DAYS_) {
    return [{
      key: 'labour_holidays_expiring',
      title: 'Labour: NSW public-holiday table ends ' + end + ' - refresh from nsw.gov.au',
      lines: [left < 0 ? 'Table ended ' + (-left) + ' day(s) ago.' : 'Table ends in ' + left + ' day(s).']
    }];
  }
  return [];
}

/* ------------------------------------------------------------------ *
 * Step 1 — clock rows -> shifts (PRD-15). Columns are located by header
 * text via LABOUR_CLOCK_COLS, the single remap point for the Zap.
 * ------------------------------------------------------------------ */

var LABOUR_CLOCK_COLS = {
  person_email: 'person_email', person_name: 'person_name', clock_in: 'clock_in', clock_out: 'clock_out',
  hours: 'hours', break_minutes: 'break_minutes', location: 'location', rate: 'rate', record_id: 'record_id'
};

var LABOUR_CLOCK_MS_HOUR_ = 3600000;

// Epoch ms of the first Sunday of month `m` (0-based) in UTC year y, at hh:00 UTC-day-zero.
function labourFirstSundayUtc_(y, m) {
  var dow = new Date(Date.UTC(y, m, 1)).getUTCDay();
  return Date.UTC(y, m, 1 + ((7 - dow) % 7));
}

// NSW offset in hours at UTC instant ms: AEDT (11) from 02:00 std on the first Sunday of
// October to 03:00 daylight on the first Sunday of April, else AEST (10).
function labourSydneyOffsetHours_(ms) {
  var y = new Date(ms + 10 * LABOUR_CLOCK_MS_HOUR_).getUTCFullYear();
  var endMs = labourFirstSundayUtc_(y, 3) + 3 * LABOUR_CLOCK_MS_HOUR_ - 11 * LABOUR_CLOCK_MS_HOUR_;
  var startMs = labourFirstSundayUtc_(y, 9) + 2 * LABOUR_CLOCK_MS_HOUR_ - 10 * LABOUR_CLOCK_MS_HOUR_;
  return (ms < endMs || ms >= startMs) ? 11 : 10;
}

function labourSydneyParts_(v) {
  var ms = null;
  if (Object.prototype.toString.call(v) === '[object Date]') {
    ms = v.getTime();
  } else {
    var m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(labourStr_(v));
    if (m) {
      var local = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0));
      if (m[7] === 'Z') {
        ms = local;
      } else if (m[7]) {
        var sign = m[7].charAt(0) === '-' ? -1 : 1;
        var digits = m[7].slice(1).replace(':', '');
        ms = local - sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60000;
      } else {
        ms = local - labourSydneyOffsetHours_(local - 10 * LABOUR_CLOCK_MS_HOUR_) * LABOUR_CLOCK_MS_HOUR_;
      }
    }
  }
  if (ms === null || !isFinite(ms)) return null;
  var d = new Date(ms + labourSydneyOffsetHours_(ms) * LABOUR_CLOCK_MS_HOUR_);
  return {
    date: d.getUTCFullYear() + '-' + labourPad2_(d.getUTCMonth() + 1) + '-' + labourPad2_(d.getUTCDate()),
    ms: ms
  };
}

function labourPositiveNumber_(v) {
  if (labourStr_(v) === '') return null;
  var n = Number(v);
  return (isFinite(n) && n > 0) ? n : null;
}

function labourRateFallback_(cfg, email, date) {
  var list = (cfg.rates && Object.prototype.hasOwnProperty.call(cfg.rates, email)) ? cfg.rates[email] : [];
  var best = null;
  list.forEach(function (r) {
    if (r.effective_from <= date && (best === null || r.effective_from > best.effective_from)) best = r;
  });
  return best ? best.rate : null;
}

function labourRowsToShifts_(rows, range, cfg) {
  var hdr = (rows[0] || []).map(labourStr_);
  var ix = {};
  Object.keys(LABOUR_CLOCK_COLS).forEach(function (k) {
    var i = hdr.indexOf(LABOUR_CLOCK_COLS[k]);
    if (i === -1) throw new Error('labour: CLOCK_RAW is missing column "' + LABOUR_CLOCK_COLS[k] + '"');
    ix[k] = i;
  });

  // Parse every non-blank row, then dedup (latest clock-out wins; ties -> later row).
  var winners = {};
  var order = [];
  for (var n = 1; n < rows.length; n++) {
    var r = rows[n];
    if (!Array.isArray(r) || !r.some(function (c) { return labourStr_(c) !== ''; })) continue;
    var email = labourStr_(r[ix.person_email]).toLowerCase();
    var cin = labourSydneyParts_(r[ix.clock_in]);
    var cout = labourSydneyParts_(r[ix.clock_out]);
    var id = labourStr_(r[ix.record_id]);
    var key = id !== '' ? 'id:' + id : (cin ? 'pe:' + email + '|' + cin.ms : 'row:' + n);
    var rec = { row: r, n: n, email: email, cin: cin, cout: cout, id: id,
      outMs: cout ? cout.ms : -Infinity };
    if (!Object.prototype.hasOwnProperty.call(winners, key)) {
      order.push(key);
      winners[key] = rec;
    } else if (rec.outMs >= winners[key].outMs) {
      winners[key] = rec;
    }
  }

  var shifts = [];
  var exceptions = [];
  order.map(function (k) { return winners[k]; })
    .sort(function (a, b) { return a.n - b.n; })
    .forEach(function (rec) {
      var r = rec.row;
      var date = rec.cin ? rec.cin.date : '';
      if (rec.cin && (date < range.start || date > range.end)) return;
      var location = labourStr_(r[ix.location]);
      function raise(reason, detail) {
        exceptions.push({ reason: reason, recordId: rec.id, personEmail: rec.email, date: date, location: location, detail: detail });
      }

      var hours = null;
      var cell = labourPositiveNumber_(r[ix.hours]);
      if (!rec.cin) return raise('unpaired', 'clock-in missing or unparseable');
      if (rec.cout) {
        var brk = labourPositiveNumber_(r[ix.break_minutes]) || 0;
        hours = Math.round(((rec.cout.ms - rec.cin.ms) / LABOUR_CLOCK_MS_HOUR_ - brk / 60) * 10000) / 10000;
        if (rec.cout.ms < rec.cin.ms) return raise('negative', 'clock-out is before clock-in');
        if (hours <= 0) return raise('negative', 'computed hours ' + hours + ' <= 0 after break');
      } else if (cell !== null) {
        hours = cell;
      } else {
        return raise('unpaired', 'clock-out missing or unparseable and no hours cell');
      }
      if (hours > 16) return raise('over_16h', 'shift is ' + hours + ' hours');
      if (!Object.prototype.hasOwnProperty.call(cfg.locations, location)) {
        return raise('unknown_location', 'location "' + location + '" is not in LOCATIONS');
      }

      var rate = labourPositiveNumber_(r[ix.rate]);
      var rateSource = 'row';
      if (rate === null) {
        rate = labourRateFallback_(cfg, rec.email, date);
        rateSource = 'rates_fallback';
      }
      if (rate === null) {
        rate = labourDefaultBarista_(cfg, date).rate;
        rateSource = 'default_barista';
      }

      var loc = cfg.locations[location];
      shifts.push({
        recordId: rec.id, personEmail: rec.email, personName: labourStr_(r[ix.person_name]), date: date,
        clockInMs: rec.cin.ms, clockOutMs: rec.cout ? rec.cout.ms : null, hours: hours,
        location: location, locationCode: loc.code, department: loc.department,
        rate: rate, rateSource: rateSource,
        defaultPerson: !(cfg.people && Object.prototype.hasOwnProperty.call(cfg.people, rec.email))
      });
    });

  return { shifts: shifts, exceptions: exceptions };
}

/* ------------------------------------------------------------------ *
 * Step 2 — cost one shift (PRD-16, PRD-17). Pure: classification comes
 * from the PINNED PEOPLE row, never inferred from the rate. No rounding
 * here; rounding happens once at the group boundary.
 * ------------------------------------------------------------------ */

// Superannuation guarantee, ascending by effective date. The only legislated dated constant.
var LABOUR_SG_RATES_ = [{ from: '2024-07-01', rate: 0.115 }, { from: '2025-07-01', rate: 0.12 }];

function labourSgRate_(date) {
  var key = labourDayKey_(date, 'shift date');
  var best = null;
  LABOUR_SG_RATES_.forEach(function (r) { if (r.from <= key) best = r; });
  if (best === null) throw new Error('labour: no superannuation rate for ' + key + ' (table starts ' + LABOUR_SG_RATES_[0].from + ')');
  return best.rate;
}

function labourDayType_(date, cfg) {
  var key = labourDayKey_(date, 'shift date');
  if (Object.prototype.hasOwnProperty.call(cfg.holidays, key) && cfg.holidays[key]) return 'public_holiday';
  var p = key.split('-');
  var dow = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]))).getUTCDay();
  if (dow === 0) return 'sunday';
  if (dow === 6) return 'saturday';
  return 'weekday';
}

function labourCashRule_(cfg, shift) {
  var key = labourDayKey_(shift.date, 'shift date').split('-');
  var wd = LABOUR_CLOCK_WEEKDAYS_[new Date(Date.UTC(Number(key[0]), Number(key[1]) - 1, Number(key[2]))).getUTCDay()];
  var rules = cfg.cashShifts || [];
  for (var i = 0; i < rules.length; i++) {
    var c = rules[i];
    if (c.email === shift.personEmail && c.location === shift.location && c.days.indexOf(wd) !== -1) return c;
  }
  return null;
}

function labourCostShift_(shift, cfg) {
  function fail(reason, detail) {
    return { ok: false, exception: { reason: reason, recordId: shift.recordId, personEmail: shift.personEmail,
      date: shift.date, location: shift.location, detail: detail } };
  }
  var p = (cfg.people && Object.prototype.hasOwnProperty.call(cfg.people, shift.personEmail))
    ? cfg.people[shift.personEmail]
    : { employment_type: LABOUR_SEED_EMPLOYMENT_TYPE_, level: labourDefaultBarista_(cfg, shift.date).level,
      rate_basis: LABOUR_SEED_RATE_BASIS_ };
  // Cash rule: after the PEOPLE lookup, BEFORE person_incomplete (a blank level must not turn a
  // cash shift into an exception). Matches on person + location + calendar weekday of the shift date.
  var cash = labourCashRule_(cfg, shift);
  if (cash) {
    var cbase = shift.hours * cash.rate;
    return { ok: true, cash: true, dayType: labourDayType_(shift.date, cfg), multiplier: 1, base: cbase, gross: cbase, uplift: 0,
      sgRate: 0, super: 0, total: cbase,
      employmentType: p.employment_type, level: p.level, rateBasis: p.rate_basis };
  }
  if (labourStr_(p.employment_type) === '' || labourStr_(p.level) === '' || labourStr_(p.rate_basis) === '') {
    return fail('person_incomplete', 'PEOPLE row needs employment_type, level and rate_basis');
  }
  var dayType = labourDayType_(shift.date, cfg);
  var multiplier = labourMultiplier_(cfg, p.employment_type, p.rate_basis, p.level, dayType);
  var sgRate = labourSgRate_(shift.date);
  var base = shift.hours * shift.rate;
  var gross = base * multiplier;
  var sup = gross * sgRate;
  return { ok: true, dayType: dayType, multiplier: multiplier, base: base, gross: gross, uplift: gross - base,
    sgRate: sgRate, super: sup, total: gross + sup,
    employmentType: p.employment_type, level: p.level, rateBasis: p.rate_basis };
}

/* ------------------------------------------------------------------ *
 * Step 3 — group costed shifts by ISO week x location (PRD-18). Pure.
 * Money is accumulated at full precision and rounded to cents ONCE per row.
 * ------------------------------------------------------------------ */

function labourRound2_(x) { return Math.round(x * 100) / 100; }

function labourIsoWeek_(date) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(labourDayKey_(date));
  var DAY = 86400000;
  var ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  var isoDay = new Date(ms).getUTCDay() || 7;           // Mon=1..Sun=7
  var monday = ms - (isoDay - 1) * DAY;
  var thursday = monday + 3 * DAY;
  var isoYear = new Date(thursday).getUTCFullYear();
  var week = Math.floor((thursday - Date.UTC(isoYear, 0, 1)) / DAY / 7) + 1;
  function key(t) {
    var d = new Date(t);
    return d.getUTCFullYear() + '-' + labourPad2_(d.getUTCMonth() + 1) + '-' + labourPad2_(d.getUTCDate());
  }
  return { weekStart: key(monday), weekEnd: key(monday + 6 * DAY), isoWeek: isoYear + '-W' + labourPad2_(week) };
}

// Fixed weekly cost per location (Amendment A3). A location is FIXED for a week only when at
// least one FIXED row has effective_from <= weekStart; the latest row per person+location wins.
// Super uses SG(weekStart) (the Monday): 12% is the last rate in the table, so a week straddling
// 1 July is a non-issue today. Returns { location: {hours, gross, super, total, department,
// locationCode, weekStart, rows} } with money rounded to cents; {} when nothing applies.
function labourFixedWeek_(cfg, weekStart) {
  var ws = labourDayKey_(weekStart, 'weekStart');
  var latest = {};
  ((cfg && cfg.fixed) || []).forEach(function (f) {
    if (f.effective_from > ws) return;
    var k = f.email + '|' + f.location;
    if (!Object.prototype.hasOwnProperty.call(latest, k) || f.effective_from >= latest[k].effective_from) latest[k] = f;
  });
  var acc = {};
  Object.keys(latest).forEach(function (k) {
    var f = latest[k];
    var a = acc[f.location] = acc[f.location] || { hours: 0, gross: 0, rows: 0 };
    a.hours += f.hours;
    a.gross += f.hours * f.rate;
    a.rows++;
  });
  var locs = Object.keys(acc);
  var out = {};
  if (locs.length === 0) return out;
  var sg = labourSgRate_(ws);
  locs.forEach(function (loc) {
    var a = acc[loc];
    var def = (cfg.locations && Object.prototype.hasOwnProperty.call(cfg.locations, loc)) ? cfg.locations[loc] : {};
    var sup = a.gross * sg;
    out[loc] = { hours: Math.round(a.hours * 10000) / 10000, gross: labourRound2_(a.gross), super: labourRound2_(sup),
      total: labourRound2_(a.gross + sup), department: def.department || '', locationCode: def.code || '',
      weekStart: ws, rows: a.rows };
  });
  return out;
}

// Splits clocked shifts / exceptions at locations that are FIXED this week into `fixedClocks`,
// upstream of costing and of the 10% exception ratio (R9). Entries carry counts only.
function labourSplitFixedClocks_(shifts, exceptions, fixedWeek) {
  var fx = fixedWeek || {};
  function isFixed(loc) { return Object.prototype.hasOwnProperty.call(fx, labourStr_(loc)); }
  var out = { shifts: [], exceptions: [], fixedClocks: [] };
  (shifts || []).forEach(function (s) {
    if (isFixed(s.location)) out.fixedClocks.push({ kind: 'shift', location: labourStr_(s.location), date: s.date, hours: s.hours });
    else out.shifts.push(s);
  });
  (exceptions || []).forEach(function (e) {
    if (isFixed(e && e.location)) out.fixedClocks.push({ kind: 'exception', location: labourStr_(e.location), date: e.date, hours: null });
    else out.exceptions.push(e);
  });
  return out;
}

// labour_fixed_zero: a location has FIXED rows but none apply this week (its clocks are costed
// normally - never a silent $0). labour_fixed_location_clock: one line per ignored clock record.
function labourFixedAlerts_(cfg, weekStart, fixedClocks) {
  var alerts = [];
  var fw = labourFixedWeek_(cfg, weekStart);
  var all = {};
  ((cfg && cfg.fixed) || []).forEach(function (f) { all[f.location] = true; });
  var zero = Object.keys(all).filter(function (l) { return !Object.prototype.hasOwnProperty.call(fw, l); });
  if (zero.length) {
    alerts.push(labourAlert_('labour_fixed_zero', 'Labour: fixed-cost location has no FIXED row effective this week - clocks costed normally', zero));
  }
  var lines = (fixedClocks || []).map(function (c) {
    return c.location + ' ' + c.date + ': clocked ' + (c.kind === 'exception' ? 'record' : 'shift of ' + c.hours + ' h') +
      ' not costed (fixed cost applies)';
  });
  if (lines.length) {
    alerts.push(labourAlert_('labour_fixed_location_clock', 'Labour: clock-ins at a fixed-cost location were ignored', lines));
  }
  return alerts;
}

// fixedWeek (optional) = labourFixedWeek_ result. Its rows are merged into the (week, location) slot
// and marked fixed:true. One week per run: costed spanning weeks, or a costed week that differs from
// the fixed week, throws (R11); a costed shift at a fixed location throws (split it upstream, R9).
function labourGroup_(costed, exceptions, fixedWeek) {
  var groups = {};
  var costedWeeks = {};
  // Costed shifts carry money, so a bad date throws; exceptions may legitimately lack one.
  function exceptionWeek(date) {
    try { return labourIsoWeek_(date); } catch (e) { return { weekStart: '', weekEnd: '', isoWeek: '(unknown)' }; }
  }
  function slot(wk, location, code) {
    var loc = labourStr_(location) === '' ? '(unknown)' : labourStr_(location);
    var k = wk.weekStart + '|' + loc;
    if (!Object.prototype.hasOwnProperty.call(groups, k)) {
      groups[k] = { weekStart: wk.weekStart, weekEnd: wk.weekEnd, isoWeek: wk.isoWeek, location: loc,
        locationCode: code || '', department: '', hours: 0, base: 0, uplift: 0, gross: 0, super: 0, total: 0,
        shiftCount: 0, exceptionCount: 0 };
    }
    var g = groups[k];
    if (!g.locationCode && code) g.locationCode = code;
    return g;
  }

  (costed || []).forEach(function (c) {
    if (!c || !c.cost || c.cost.ok !== true) throw new Error('labour: labourGroup_ got a cost that is not ok');
    var s = c.shift;
    var wk = labourIsoWeek_(s.date);
    if (fixedWeek) {
      if (Object.prototype.hasOwnProperty.call(fixedWeek, labourStr_(s.location))) {
        throw new Error('labour: costed shift at fixed location "' + labourStr_(s.location) + '" - split fixed-location clocks upstream');
      }
      costedWeeks[wk.weekStart] = true;
    }
    var g = slot(wk, s.location, s.locationCode);
    if (g.department !== '' && g.department !== s.department) {
      throw new Error('labour: department disagrees within ' + g.isoWeek + ' / ' + g.location +
        ' ("' + g.department + '" vs "' + s.department + '")');
    }
    g.department = s.department;
    g.hours += s.hours;
    g.base += c.cost.base;
    g.uplift += c.cost.uplift;
    g.gross += c.cost.gross;
    g.super += c.cost.super;
    g.total += c.cost.gross + c.cost.super;
    g.shiftCount++;
  });
  (exceptions || []).forEach(function (e) { slot(exceptionWeek(e && e.date), e && e.location, '').exceptionCount++; });

  if (fixedWeek) {
    var cw = Object.keys(costedWeeks);
    if (cw.length > 1) throw new Error('labour: labourGroup_ got costed shifts spanning ' + cw.length + ' weeks with a fixedWeek (one week per run)');
    Object.keys(fixedWeek).forEach(function (loc) {
      var f = fixedWeek[loc];
      if (cw.length === 1 && cw[0] !== labourIsoWeek_(f.weekStart).weekStart) {
        throw new Error('labour: costed week ' + cw[0] + ' differs from the fixed week ' + f.weekStart);
      }
      var g = slot(labourIsoWeek_(f.weekStart), loc, f.locationCode);
      if (g.department !== '' && g.department !== f.department) {
        throw new Error('labour: department disagrees within ' + g.isoWeek + ' / ' + g.location +
          ' ("' + g.department + '" vs "' + f.department + '")');
      }
      g.department = f.department;
      g.hours += f.hours;
      g.base += f.gross;
      g.gross += f.gross;
      g.super += f.super;
      g.total += f.total;
      g.fixed = true;
    });
  }

  return Object.keys(groups).map(function (k) {
    var g = groups[k];
    g.hours = Math.round(g.hours * 10000) / 10000;
    ['base', 'uplift', 'gross', 'super', 'total'].forEach(function (f) { g[f] = labourRound2_(g[f]); });
    return g;
  }).sort(function (a, b) {
    return a.weekStart < b.weekStart ? -1 : a.weekStart > b.weekStart ? 1 : a.location < b.location ? -1 : a.location > b.location ? 1 : 0;
  });
}

/* ------------------------------------------------------------------ *
 * Step 4 — data-quality checks and alerts (PRD-19, PRD-20). Pure: every
 * clock-dependent check takes `today` as a parameter; nothing is persisted
 * or raised here. An alert is {key, title, lines[]}, ONE line per item.
 * ------------------------------------------------------------------ */

var LABOUR_DROP_MIN_HISTORY_ = 4;
var LABOUR_DROP_FLOOR_PCT_ = 70;
var LABOUR_PAYGUIDE_TOLERANCE_ = 0.01;

// Seed from docs/labour-award-research.md. THIRD-PARTY (rosterelf), UNVERIFIED against the
// official pay guide - a smoke alarm only, never a source of truth for classification.
// 'loaded' = casual rate incl. 25% loading; 'unloaded' = ordinary (FT/PT) rate.
var LABOUR_PAYGUIDE_SEED_ = [
  { effective_from: '2026-07-01', employment_type: 'casual', rate_basis: 'loaded', level: 'intro', rate: 32.18 },
  { effective_from: '2026-07-01', employment_type: 'casual', rate_basis: 'loaded', level: 1, rate: 33.05 },
  { effective_from: '2026-07-01', employment_type: 'casual', rate_basis: 'loaded', level: 2, rate: 33.85 },
  { effective_from: '2026-07-01', employment_type: 'casual', rate_basis: 'loaded', level: 3, rate: 34.96 },
  { effective_from: '2026-07-01', employment_type: 'casual', rate_basis: 'loaded', level: 4, rate: 36.81 },
  { effective_from: '2026-07-01', employment_type: 'casual', rate_basis: 'loaded', level: 5, rate: 39.13 },
  { effective_from: '2026-07-01', employment_type: 'casual', rate_basis: 'loaded', level: 6, rate: 40.16 },
  { effective_from: '2026-07-01', employment_type: 'casual', rate_basis: 'unloaded', level: 'intro', rate: 25.74 },
  { effective_from: '2026-07-01', employment_type: 'casual', rate_basis: 'unloaded', level: 1, rate: 26.44 },
  { effective_from: '2026-07-01', employment_type: 'casual', rate_basis: 'unloaded', level: 2, rate: 27.08 },
  { effective_from: '2026-07-01', employment_type: 'casual', rate_basis: 'unloaded', level: 3, rate: 27.97 },
  { effective_from: '2026-07-01', employment_type: 'casual', rate_basis: 'unloaded', level: 4, rate: 29.45 },
  { effective_from: '2026-07-01', employment_type: 'casual', rate_basis: 'unloaded', level: 5, rate: 31.30 },
  { effective_from: '2026-07-01', employment_type: 'casual', rate_basis: 'unloaded', level: 6, rate: 32.13 }
];

function labourAlert_(key, title, lines) { return { key: key, title: title, lines: lines }; }

function labourCheckZeroRows_(rowCount, week) {
  if (rowCount === 0) {
    return { stop: true, alerts: [labourAlert_('labour_zero_rows',
      'Labour: no clock rows for ' + week + ' - nothing written',
      ['CLOCK_RAW has 0 rows in the ' + week + ' date range.'])] };
  }
  return { stop: false, alerts: [] };
}

function labourCheckExceptions_(shiftsTotal, exceptionsTotal) {
  var total = shiftsTotal + exceptionsTotal;
  var rate = total === 0 ? 0 : exceptionsTotal / total;
  var pct = Math.round(rate * 1000) / 10;
  var line = exceptionsTotal + ' of ' + total + ' clock records (' + pct + '%) are exceptions.';
  if (total > 0 && exceptionsTotal * 10 > total) {
    return { refuse: true, rate: rate, alerts: [labourAlert_('labour_exceptions_refused',
      'Labour: exceptions above 10% - week NOT written', [line])] };
  }
  if (exceptionsTotal > 0) {
    return { refuse: false, rate: rate, alerts: [labourAlert_('labour_exceptions',
      'Labour: some clock records could not be costed', [line])] };
  }
  return { refuse: false, rate: rate, alerts: [] };
}

function labourExceptionAlerts_(exceptions) {
  var seen = {};
  var lines = [];
  (exceptions || []).forEach(function (e) {
    if (!e || e.reason !== 'person_not_in_people') return;
    var email = labourStr_(e.personEmail);
    if (Object.prototype.hasOwnProperty.call(seen, email)) return;
    seen[email] = true;
    lines.push(email);
  });
  return lines.length === 0 ? [] : [labourAlert_('labour_person_missing',
    'Labour: staff clocked on but missing from PEOPLE - their hours cost nothing', lines)];
}

// Staff costed on the base-Barista default (no RATES row and/or no PEOPLE row): one line per person.
function labourDefaultBaristaAlerts_(shifts) {
  var seen = {};
  var lines = [];
  (shifts || []).forEach(function (s) {
    if (!s || (s.rateSource !== 'default_barista' && s.defaultPerson !== true)) return;
    var email = labourStr_(s.personEmail);
    if (Object.prototype.hasOwnProperty.call(seen, email)) return;
    seen[email] = true;
    lines.push(email + ': costed at ' + s.rate + (s.rateSource === 'default_barista' ? ' (no RATES row)' : '') +
      (s.defaultPerson === true ? ' (no PEOPLE row)' : '') + ' - add their rows if they are not a base Barista');
  });
  return lines.length === 0 ? [] : [labourAlert_('labour_default_barista',
    'Labour: staff costed as a base Barista (no rate on file)', lines)];
}

// Modal rate (to the cent) per person; ties go to the first rate seen.
function labourModalRates_(shifts) {
  var counts = {};
  var order = {};
  (shifts || []).forEach(function (s) {
    var email = labourStr_(s.personEmail);
    var c = Math.round(s.rate * 100);
    counts[email] = counts[email] || {};
    if (!Object.prototype.hasOwnProperty.call(counts[email], c)) {
      counts[email][c] = 0;
      order[email] = order[email] || [];
      order[email].push(c);
    }
    counts[email][c]++;
  });
  var out = {};
  Object.keys(counts).forEach(function (email) {
    var best = null;
    order[email].forEach(function (c) { if (best === null || counts[email][c] > counts[email][best]) best = c; });
    out[email] = best;
  });
  return out;
}

function labourCheckRateChange_(thisWeekShifts, prevWeekShifts) {
  var now = labourModalRates_(thisWeekShifts);
  var prev = labourModalRates_(prevWeekShifts);
  var lines = [];
  Object.keys(now).sort().forEach(function (email) {
    if (!Object.prototype.hasOwnProperty.call(prev, email) || prev[email] === now[email]) return;
    lines.push(email + ': ' + prev[email] / 100 + ' -> ' + now[email] / 100);
  });
  return lines.length === 0 ? [] : [labourAlert_('labour_rate_change',
    'Labour: hourly rate changed since last week', lines)];
}

function labourMedian_(nums) {
  var s = nums.slice().sort(function (a, b) { return a - b; });
  var m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function labourCheckDrop_(groups, history) {
  var drops = [];
  var unchecked = [];
  (groups || []).forEach(function (g) {
    if (g.fixed === true) return;   // fixed cost is constant by design - nothing to drop-check
    var prior = (history && Object.prototype.hasOwnProperty.call(history, g.location)) ? history[g.location] : [];
    if (prior.length < LABOUR_DROP_MIN_HISTORY_) {
      unchecked.push(g.location + ': drop check UNCHECKED - only ' + prior.length +
        ' prior week(s) of history, need ' + LABOUR_DROP_MIN_HISTORY_);
      return;
    }
    var med = labourMedian_(prior.slice(0, LABOUR_DROP_MIN_HISTORY_));
    if (g.total * 100 < med * LABOUR_DROP_FLOOR_PCT_) {
      drops.push(g.location + ': total ' + g.total + ' is below ' + LABOUR_DROP_FLOOR_PCT_ +
        '% of the 4-week median ' + med);
    }
  });
  var alerts = [];
  if (drops.length) alerts.push(labourAlert_('labour_drop', 'Labour: weekly cost dropped sharply vs recent weeks', drops));
  if (unchecked.length) alerts.push(labourAlert_('labour_drop_unchecked', 'Labour: drop check UNCHECKED for some locations', unchecked));
  return alerts;
}

function labourJulyAlert_(today, lastAlertedYear) {
  var key = labourDayKey_(today, 'today');
  var year = Number(key.slice(0, 4));
  var md = key.slice(5, 10);
  if (md < '07-01' || lastAlertedYear >= year) return { alert: null, lastAlertedYear: lastAlertedYear };
  return {
    alert: labourAlert_('labour_reverify_multipliers', 'Labour: re-verify award multipliers (new financial year)',
      ['Award rates change 1 July; re-check CONFIG multipliers against docs/labour-award-research.md.']),
    lastAlertedYear: year
  };
}

function labourPayGuideCheck_(observations, cfg, payGuide) {
  var buckets = { mismatch: [], ambiguous: [], nomatch: [], stale: [] };
  (observations || []).forEach(function (o) {
    var email = labourStr_(o.personEmail).toLowerCase();
    var p = cfg && cfg.people && Object.prototype.hasOwnProperty.call(cfg.people, email) ? cfg.people[email] : null;
    if (!p) return;
    var date = labourDayKey_(o.date, 'observation date');
    var type = labourStr_(p.employment_type).toLowerCase();
    var basis = labourStr_(p.rate_basis).toLowerCase();
    var latest = {};
    (payGuide || []).forEach(function (r) {
      if (labourStr_(r.employment_type).toLowerCase() !== type || labourStr_(r.rate_basis).toLowerCase() !== basis ||
        labourDateKey_(r.effective_from) > date) return;
      var k = String(r.level);
      if (!Object.prototype.hasOwnProperty.call(latest, k) ||
        labourDateKey_(r.effective_from) > labourDateKey_(latest[k].effective_from)) latest[k] = r;
    });
    var levels = Object.keys(latest);
    if (levels.length === 0) {
      buckets.stale.push(email + ': no pay-guide row effective on or before ' + date);
      return;
    }
    var fits = levels.filter(function (k) {
      return Math.abs(o.rate - latest[k].rate) <= latest[k].rate * LABOUR_PAYGUIDE_TOLERANCE_ + 1e-9;
    });
    var pinned = String(p.level);
    if (fits.indexOf(pinned) !== -1) return;
    if (fits.length === 0) {
      buckets.nomatch.push(email + ': rate ' + o.rate + ' on ' + date + ' fits no award level (pinned L' + pinned + ')');
    } else if (fits.length === 1) {
      buckets.mismatch.push(email + ': pinned L' + pinned + ', rate fits L' + fits[0]);
    } else {
      buckets.ambiguous.push(email + ': pinned L' + pinned + ', rate fits ' + fits.map(function (k) { return 'L' + k; }).join(' and '));
    }
  });
  var alerts = [];
  if (buckets.mismatch.length) alerts.push(labourAlert_('labour_payguide_mismatch', 'Labour: pay rate matches a different award level than PEOPLE pins', buckets.mismatch));
  if (buckets.ambiguous.length) alerts.push(labourAlert_('labour_payguide_ambiguous', 'Labour: pay rate fits more than one award level - not classified', buckets.ambiguous));
  if (buckets.nomatch.length) alerts.push(labourAlert_('labour_payguide_nomatch', 'Labour: pay rate is above/below every award level (informational)', buckets.nomatch));
  if (buckets.stale.length) alerts.push(labourAlert_('labour_payguide_stale', 'Labour: pay guide has no row for this date - refresh it', buckets.stale));
  return alerts;
}

function labourRunChecks_(ctx) {
  var alerts = [];
  var z = labourCheckZeroRows_(ctx.rowCount, ctx.week);
  alerts = alerts.concat(z.alerts);
  // Fixed-location alerts only when the caller says which week this is (pre-amendment ctx has none).
  var fixedAlerts = ctx.weekStart ? labourFixedAlerts_(ctx.cfg, ctx.weekStart, ctx.fixedClocks) : [];
  if (z.stop) {
    return { stop: true, refuse: false, alerts: alerts.concat(fixedAlerts, labourHolidayAlerts_(ctx.cfg, ctx.today)),
      lastAlertedYear: ctx.lastAlertedYear };
  }
  var exc = ctx.exceptions || [];
  var ex = labourCheckExceptions_(ctx.shiftsTotal, exc.length);
  var july = labourJulyAlert_(ctx.today, ctx.lastAlertedYear);
  alerts = alerts.concat(ex.alerts, labourExceptionAlerts_(exc), labourDefaultBaristaAlerts_(ctx.thisWeekShifts), fixedAlerts,
    labourCheckRateChange_(ctx.thisWeekShifts, ctx.prevWeekShifts),
    labourCheckDrop_(ctx.groups, ctx.history),
    july.alert ? [july.alert] : [],
    labourPayGuideCheck_(ctx.observations, ctx.cfg, ctx.payGuide),
    labourHolidayAlerts_(ctx.cfg, ctx.today));
  return { stop: false, refuse: ex.refuse, alerts: alerts, lastAlertedYear: july.lastAlertedYear };
}

/* ------------------------------------------------------------------ *
 * Phase 1 — seed the LEIBLE Labour Sheet from the old Onboarding tabs.
 * Pure: takes the source tabs as 2-D arrays (row 0 = header, read by
 * header NAME) and returns the new Sheet's tabs. Only emails, rates,
 * dates and award levels are copied — never names, bank or profile data.
 * ------------------------------------------------------------------ */

var LABOUR_CLOCK_TAB_ORDER_ = ['CLOCK_RAW', 'CONFIG', 'HOLIDAYS', 'LOCATIONS', 'RATES', 'PEOPLE', 'LABOUR_COST'];

var LABOUR_CLOCK_COST_HEADERS_ = ['iso_week', 'week_start', 'week_end', 'location', 'location_code', 'department',
  'hours', 'base', 'uplift', 'gross', 'super', 'total', 'shift_count', 'exception_count', 'computed_at'];

// The Onboarding app writes employmentType as the literal 'casual' for everyone
// (Engine_Onboarding.js:75), and its award rates are casual-LOADED (AWARD_RATES
// Level 1 = 31.19 = 24.95 x 1.25). Phase 4's payroll check is the backstop.
var LABOUR_SEED_EMPLOYMENT_TYPE_ = 'casual';
var LABOUR_SEED_RATE_BASIS_ = 'loaded';

// 'Level 3' / 'L3' / 3 -> 3; 'Intro' / 'Introductory' -> 'intro'; anything else -> ''.
function labourParseAwardLevel_(v) {
  var s = labourStr_(v).toLowerCase();
  if (s === 'intro' || s === 'introductory') return 'intro';
  var m = /^(?:level\s*|l)?(\d+)$/.exec(s);
  if (!m) return '';
  var n = Number(m[1]);
  return n >= 0 && n <= 6 ? n : '';
}

// Header-name index for a source tab; throws naming the tab and column.
function labourSourceIndex_(src, tab, cols, optional) {
  var rows = src && src[tab];
  if (!rows || !rows.length) {
    if (optional) return null;
    throw new Error('labour seed: source tab ' + tab + ' is missing or empty');
  }
  var hdr = rows[0].map(function (h) { return labourStr_(h).toLowerCase(); });
  var idx = {};
  cols.forEach(function (c) {
    var i = hdr.indexOf(c.toLowerCase());
    if (i === -1) throw new Error('labour seed: source tab ' + tab + ' has no column ' + c);
    idx[c] = i;
  });
  return { rows: rows.slice(1), idx: idx };
}

function labourBuildSeed_(src) {
  var loc = labourSourceIndex_(src, 'LC_LOCATIONS', ['roster_location', 'shop_code']);
  var rates = labourSourceIndex_(src, 'STAFF_RATES', ['email', 'base_rate', 'effective_from', 'shop_code']);
  var alias = labourSourceIndex_(src, 'STAFF_ALIAS', ['email'], true);
  var prof = labourSourceIndex_(src, 'STAFF_PROFILE', ['email', 'currentAwardLevel']);

  var locations = [LABOUR_CLOCK_EXPECTED_HEADERS_.LOCATIONS.slice()];
  loc.rows.forEach(function (r) {
    var name = labourStr_(r[loc.idx.roster_location]);
    if (name === '') return;
    var code = labourStr_(r[loc.idx.shop_code]);
    locations.push([name, code, code.toLowerCase() === 'roastery' ? 'Roastery' : 'Cafe', '']);
  });

  // One rate per email + effective date: an any-shop row ('' or '*') wins;
  // otherwise the first shop-specific row, counted as a conflict if others differ.
  // A blank / zero / non-numeric rate is skipped (Number('') is 0 — never seed a $0
  // fallback); a shift with no usable rate then goes to exceptions, loudly.
  var byKey = {};
  var order = [];
  var ratesSkipped = 0;
  rates.rows.forEach(function (r) {
    var email = labourStr_(r[rates.idx.email]).toLowerCase();
    if (email === '') return;
    var rate = labourPositiveNumber_(r[rates.idx.base_rate]);
    if (rate === null) { ratesSkipped++; return; }
    var eff = labourDayKey_(r[rates.idx.effective_from], 'STAFF_RATES effective_from');
    var shop = labourStr_(r[rates.idx.shop_code]);
    var anyShop = shop === '' || shop === '*';
    var k = email + '|' + eff;
    if (!Object.prototype.hasOwnProperty.call(byKey, k)) {
      byKey[k] = { email: email, eff: eff, rate: rate, anyShop: anyShop, rates: {} };
      order.push(k);
    } else if (anyShop && !byKey[k].anyShop) {
      byKey[k].rate = rate;
      byKey[k].anyShop = true;
    }
    if (!anyShop) byKey[k].rates[rate] = true;
  });
  var rateConflicts = 0;
  var rateRows = order.map(function (k) {
    var e = byKey[k];
    if (!e.anyShop && Object.keys(e.rates).length > 1) rateConflicts++;
    return [e.email, e.rate, e.eff];
  }).sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0; });

  var levels = {};
  prof.rows.forEach(function (r) {
    var email = labourStr_(r[prof.idx.email]).toLowerCase();
    if (email !== '') levels[email] = labourParseAwardLevel_(r[prof.idx.currentAwardLevel]);
  });
  var emails = {};
  rateRows.forEach(function (r) { emails[r[0]] = true; });
  if (alias) alias.rows.forEach(function (r) { var e = labourStr_(r[alias.idx.email]).toLowerCase(); if (e) emails[e] = true; });
  Object.keys(levels).forEach(function (e) { emails[e] = true; });
  var peopleWithoutLevel = 0;
  var people = [LABOUR_CLOCK_EXPECTED_HEADERS_.PEOPLE.slice()].concat(Object.keys(emails).sort().map(function (e) {
    var lvl = Object.prototype.hasOwnProperty.call(levels, e) ? levels[e] : '';
    if (lvl === '') peopleWithoutLevel++;
    return [e, LABOUR_SEED_EMPLOYMENT_TYPE_, lvl, LABOUR_SEED_RATE_BASIS_];
  }));

  var tabs = {
    CLOCK_RAW: [Object.keys(LABOUR_CLOCK_COLS).map(function (k) { return LABOUR_CLOCK_COLS[k]; })],
    CONFIG: LABOUR_CLOCK_MULTIPLIER_SEED_.map(function (r) { return r.slice(); }),
    HOLIDAYS: [LABOUR_CLOCK_EXPECTED_HEADERS_.HOLIDAYS.slice()].concat(
      LABOUR_NSW_HOLIDAYS_SEED_.map(function (h) { return [h.date, h.name]; })),
    LOCATIONS: locations,
    RATES: [LABOUR_CLOCK_EXPECTED_HEADERS_.RATES.slice()].concat(rateRows),
    PEOPLE: people,
    LABOUR_COST: [LABOUR_CLOCK_COST_HEADERS_.slice()]
  };
  return { tabs: tabs, counts: { locations: locations.length - 1, rates: rateRows.length, people: people.length - 1,
    holidays: tabs.HOLIDAYS.length - 1, rateConflicts: rateConflicts, ratesSkipped: ratesSkipped, peopleWithoutLevel: peopleWithoutLevel } };
}

// Read-only diagnostic for the seed: counts and award-level LABELS only (labels
// truncated to 40 chars) - never emails, names or rates - so it is safe to log.
function labourSeedSourceReport_(src) {
  function labels(rows, col) {
    var counts = {};
    rows.forEach(function (r) {
      var l = labourStr_(r[col]).slice(0, 40) || '(blank)';
      counts[l] = (counts[l] || 0) + 1;
    });
    return Object.keys(counts).sort().map(function (l) {
      return { label: l, count: counts[l], parsed: l === '(blank)' ? '' : labourParseAwardLevel_(l) };
    });
  }
  var prof = labourSourceIndex_(src, 'STAFF_PROFILE', ['email', 'currentAwardLevel'], true);
  var subs = labourSourceIndex_(src, 'SUBMISSIONS', ['awardLevel'], true);
  var rates = labourSourceIndex_(src, 'STAFF_RATES', ['email'], true);
  var profEmails = {};
  if (prof) prof.rows.forEach(function (r) { var e = labourStr_(r[prof.idx.email]).toLowerCase(); if (e) profEmails[e] = true; });
  var rateEmails = {};
  if (rates) rates.rows.forEach(function (r) { var e = labourStr_(r[rates.idx.email]).toLowerCase(); if (e) rateEmails[e] = true; });
  return {
    profileRows: prof ? prof.rows.length : 0,
    profileRowsWithEmail: prof ? prof.rows.filter(function (r) { return labourStr_(r[prof.idx.email]) !== ''; }).length : 0,
    profileLevels: prof ? labels(prof.rows, prof.idx.currentAwardLevel) : [],
    submissionRows: subs ? subs.rows.length : 0,
    submissionLevels: subs ? labels(subs.rows, subs.idx.awardLevel) : [],
    rateEmails: Object.keys(rateEmails).length,
    rateEmailsWithProfile: Object.keys(rateEmails).filter(function (e) { return profEmails[e]; }).length
  };
}
