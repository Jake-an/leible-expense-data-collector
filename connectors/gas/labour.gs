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
  PEOPLE: ['person_email', 'employment_type', 'level', 'rate_basis']
};

function labourPad2_(n) { return (n < 10 ? '0' : '') + n; }

function labourStr_(v) { return String(v === null || v === undefined ? '' : v).trim(); }

// Cell (string or Date) -> 'yyyy-MM-dd' via LOCAL components (never toISOString).
function labourDateKey_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return v.getFullYear() + '-' + labourPad2_(v.getMonth() + 1) + '-' + labourPad2_(v.getDate());
  }
  return labourStr_(v).slice(0, 10);
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

function labourMultKey_(type, basis, band, day) { return type + '|' + basis + '|' + band + '|' + day; }

function labourReadConfig_(tabs) {
  var cfg = { multipliers: {}, holidays: {}, locations: {}, rates: {}, people: {} };
  var t;

  t = labourTabIndex_(tabs, 'CONFIG');
  t.rows.forEach(function (r, n) {
    var raw = r[t.idx.multiplier];
    var m = (typeof raw === 'number') ? raw : (labourStr_(raw) === '' ? NaN : Number(labourStr_(raw)));
    if (!isFinite(m) || m <= 0) {
      throw new Error('labour: CONFIG row ' + (n + 2) + ' has invalid multiplier ' + JSON.stringify(raw));
    }
    var mk = labourMultKey_(labourStr_(r[t.idx.employment_type]), labourStr_(r[t.idx.rate_basis]),
      labourStr_(r[t.idx.level_band]), labourStr_(r[t.idx.day_type]));
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
    if (d) cfg.holidays[d] = labourStr_(r[t.idx.name]);
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

  t = labourTabIndex_(tabs, 'PEOPLE');
  t.rows.forEach(function (r) {
    cfg.people[labourStr_(r[t.idx.person_email]).toLowerCase()] = {
      employment_type: labourStr_(r[t.idx.employment_type]),
      level: r[t.idx.level],
      rate_basis: labourStr_(r[t.idx.rate_basis])
    };
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
  var dates = Object.keys(cfg.holidays).sort();
  var year = String(today).slice(0, 4);
  var inYear = dates.filter(function (d) { return d.slice(0, 4) === year; }).length;
  if (inYear === 0) {
    return [{
      key: 'labour_holidays_empty',
      title: 'Labour: no NSW public holidays loaded for ' + year + ' - refresh from nsw.gov.au',
      lines: ['HOLIDAYS tab has no entries dated ' + year + '; public-holiday penalty rates cannot be applied.']
    }];
  }
  var end = dates[dates.length - 1];
  var left = labourDayNumber_(end) - labourDayNumber_(String(today));
  if (left <= LABOUR_HOLIDAY_ALERT_DAYS_) {
    return [{
      key: 'labour_holidays_expiring',
      title: 'Labour: NSW public-holiday table ends ' + end + ' - refresh from nsw.gov.au',
      lines: [left < 0 ? 'Table ended ' + (-left) + ' day(s) ago.' : 'Table ends in ' + left + ' day(s).']
    }];
  }
  return [];
}
