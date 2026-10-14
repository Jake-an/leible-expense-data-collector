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
      if (rate === null) return raise('no_rate', 'no row rate and no RATES entry effective on ' + date);

      var loc = cfg.locations[location];
      shifts.push({
        recordId: rec.id, personEmail: rec.email, personName: labourStr_(r[ix.person_name]), date: date,
        clockInMs: rec.cin.ms, clockOutMs: rec.cout ? rec.cout.ms : null, hours: hours,
        location: location, locationCode: loc.code, department: loc.department,
        rate: rate, rateSource: rateSource
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
  var key = String(date);
  var best = null;
  LABOUR_SG_RATES_.forEach(function (r) { if (r.from <= key) best = r; });
  if (best === null) throw new Error('labour: no superannuation rate for ' + key + ' (table starts ' + LABOUR_SG_RATES_[0].from + ')');
  return best.rate;
}

function labourDayType_(date, cfg) {
  var key = String(date);
  if (Object.prototype.hasOwnProperty.call(cfg.holidays, key) && cfg.holidays[key]) return 'public_holiday';
  var p = key.split('-');
  var dow = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]))).getUTCDay();
  if (dow === 0) return 'sunday';
  if (dow === 6) return 'saturday';
  return 'weekday';
}

function labourCostShift_(shift, cfg) {
  function fail(reason, detail) {
    return { ok: false, exception: { reason: reason, recordId: shift.recordId, personEmail: shift.personEmail,
      date: shift.date, location: shift.location, detail: detail } };
  }
  if (!cfg.people || !Object.prototype.hasOwnProperty.call(cfg.people, shift.personEmail)) {
    return fail('person_not_in_people', shift.personEmail + ' is not in PEOPLE');
  }
  var p = cfg.people[shift.personEmail];
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
