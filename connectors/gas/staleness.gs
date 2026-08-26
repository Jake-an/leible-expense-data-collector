/**
 * staleness.gs — ingest watchdog.
 *
 * Why this exists: every scheduled ingest failed silently for a month. Nothing
 * was watching, so "no new data" and "completely broken" looked identical.
 *
 * Signal = max(newest sheet extracted_at, Script-Properties heartbeat).
 * Neither half works alone:
 *   - Sheet alone measures LAST NEW DATA, not last run. Dedup means a healthy
 *     run that finds no new invoices writes nothing, so a quiet weekend would
 *     cry wolf.
 *   - Heartbeat alone doesn't exist until the first post-deploy run, so
 *     everything would alert on day 1.
 *
 * Alerts are orange all-day Google Calendar events (no popup — GAS can only fire
 * an all-day popup at midnight, which is useless).
 *
 * THIS FILE IS THE PRIMARY SOURCE OF THE CalendarApp OAuth SCOPE. orderapp.gs is
 * a known exception (it also touches CalendarApp for fail-open alerts, deliberately
 * out of scope for this phase). Deploy on its own (deploy.sh --push-only →
 * authorize → full deploy) so a scope change can never take /exec down with
 * un-consented code — /exec is the sole ingest path.
 */

var STALENESS_THRESHOLD_HOURS = 96;              // default: silent through a normal Fri→Mon (80h)
var STALENESS_CALENDAR_ID = 'mio.jake@gmail.com';
// Per-source thresholds for sources whose run cadence exceeds the 96h default.
// These exist because the orderapp fail-open counter can only fire INSIDE a
// running handler — a trigger that is deleted, disabled, or de-authorized
// fires no run at all, the heartbeat simply stops advancing, and only THIS
// file reads it. The daily 11:00 check gives clean margins on both sides:
//   shopify_orderapp — weekly, Mon 05:00. Healthy worst case is the following
//     Sun 11:00 check at ~150h < 168; a MISSED Monday run is caught the same
//     Mon 11:00 at ~174h > 168.
//   greenbean — weekly, Tue 05:00: same arithmetic, one day shifted.
//   recurring — monthly, 1st 05:00. 744h = 31 days: a 31-day month's last
//     healthy check (month-end 11:00, ~726h) stays silent; a missed run
//     alerts at ~750h — same day for 31-day months, 1–3 days later for
//     shorter ones (fine for rent-cadence money).
var STALENESS_THRESHOLD_OVERRIDES = {
  shopify_orderapp: 168,
  greenbean: 168,
  recurring: 744
};
// Every source that stamps a heartbeat is watched — at the 96h default or a
// per-source override above. Deliberately excluded:
//   'shopspend' — has its OWN dedicated weekly watchdog (shopSpendWatchdog,
//   Mon 14:00 Sydney, shopspend.gs) reading the ShopSpendPulls coverage tab;
//   watching its heartbeat here too would double-alert every incident.
//   'coffee_order_app' — NO LIVE WRITER today, so watching it would false-alarm
//   daily as a never-seen source. Its suppliers-kind path is mechanically
//   rejected (validateIngest_), but its wholesale-REVENUE path is still
//   sanctioned in docs/ingest-contract.md and doPost stamps body.source
//   generically — so the moment that writer ships, RE-ADD 'coffee_order_app'
//   here (and to STAMPS_HEARTBEAT in test_code.js) or it runs unwatched.
var STALENESS_SOURCES = ['food_dairy_co', 'fresh_and_chill', 'ordermentum', 'square', 'mayers', 'roastery',
  'shopify_orderapp', 'greenbean', 'recurring'];
var STALENESS_HEARTBEAT_PREFIX = 'LAST_INGEST_';

/* ------------------------------------------------------------------ *
 * Entry points
 * ------------------------------------------------------------------ */

/**
 * Trigger handler. Takes NO ARGUMENTS — deliberately.
 *
 * A time-based trigger passes an event object as arg 1; that is exactly what
 * corrupted the Sales tab (Fault 3). A zero-arg handler structurally cannot
 * receive one into anything meaningful. All logic lives in stalenessRun_(nowMs),
 * which is fully injectable for tests.
 */
function checkIngestStaleness() {
  return stalenessRun_(Date.now());
}

/**
 * @param {number} nowMs — injected clock.
 * @returns {{checked:number, stale:Array, eventsCreated:number}}
 */
function stalenessRun_(nowMs) {
  var lastSeen = stalenessCollectLastSeen_();
  var report = stalenessEvaluate_(lastSeen, STALENESS_SOURCES, nowMs, STALENESS_THRESHOLD_HOURS,
    STALENESS_THRESHOLD_OVERRIDES);

  var stale = [];
  for (var i = 0; i < report.length; i++) {
    if (report[i].stale) stale.push(report[i]);
  }

  var eventsCreated = 0;
  if (stale.length) eventsCreated = stalenessRaiseAlerts_(stale, nowMs);

  Logger.log('checkIngestStaleness: checked=' + report.length +
    ', stale=' + stale.length + ', eventsCreated=' + eventsCreated);

  return { checked: report.length, stale: stale, eventsCreated: eventsCreated };
}

/* ------------------------------------------------------------------ *
 * Heartbeat — one Script Property per source
 * ------------------------------------------------------------------ */

/**
 * Record that `source` ingested successfully, right now.
 *
 * One key per source means no sheet read-modify-write and therefore no
 * LockService, even though StartWhenAvailable can fire all three connectors at
 * once on logon. The Properties store is serialized as a unit, so concurrent
 * setProperty on distinct keys could in principle still lose a write — this is
 * safe not because it's provably atomic but because the blast radius is trivial:
 * a lost stamp degrades to that source's newest sheet extracted_at, worst case
 * one spurious orange event that self-heals on the next run.
 *
 * NEVER THROWS. The watchdog must not be able to break the thing it watches —
 * this is called from doPost AFTER the data is already written.
 */
function stalenessStampHeartbeat_(source) {
  try {
    PropertiesService.getScriptProperties()
      .setProperty(STALENESS_HEARTBEAT_PREFIX + source, new Date().toISOString());
  } catch (err) {
    Logger.log('stalenessStampHeartbeat_: could not stamp ' + source + ' — ' + err.message);
  }
}

/** Merge the sheet signal with the heartbeat signal. */
function stalenessCollectLastSeen_() {
  var maps = [];

  try {
    var ss = getHubSpreadsheet_();

    var supp = ss.getSheetByName(SUPPLIERS_TAB);
    if (supp) {
      maps.push(stalenessScanSheet_(
        supp.getDataRange().getValues(),
        SUPPLIERS_HEADERS.indexOf('source'),
        SUPPLIERS_HEADERS.indexOf('extracted_at')));
    }

    var sales = ss.getSheetByName(SALES_TAB);
    if (sales) {
      maps.push(stalenessScanSheet_(
        sales.getDataRange().getValues(),
        SALES_HEADERS.indexOf('source'),
        SALES_HEADERS.indexOf('extracted_at')));
    }
  } catch (err) {
    Logger.log('stalenessCollectLastSeen_: sheet scan failed — ' + err.message);
  }

  maps.push(stalenessReadHeartbeats_());
  return stalenessMergeLastSeen_(maps);
}

function stalenessReadHeartbeats_() {
  var out = {};
  try {
    var props = PropertiesService.getScriptProperties();
    for (var i = 0; i < STALENESS_SOURCES.length; i++) {
      var src = STALENESS_SOURCES[i];
      var ms = stalenessParseTs_(props.getProperty(STALENESS_HEARTBEAT_PREFIX + src));
      if (ms !== null) out[src] = ms;
    }
  } catch (err) {
    Logger.log('stalenessReadHeartbeats_: could not read properties — ' + err.message);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Pure helpers (unit-tested)
 * ------------------------------------------------------------------ */

/**
 * Parse an extracted_at cell to epoch ms, or null.
 * Sheets coerces date-looking text into real Date objects, so a column written
 * as an ISO string reads back as either a String or a Date depending on the row.
 */
function stalenessParseTs_(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) {
    return isNaN(v.getTime()) ? null : v.getTime();
  }
  var ms = new Date(String(v)).getTime();
  return isNaN(ms) ? null : ms;
}

/** Newest extracted_at per source. @returns {Object.<string, number>} */
function stalenessScanSheet_(values, sourceCol, tsCol) {
  var out = {};
  if (sourceCol < 0 || tsCol < 0) return out;

  for (var r = 1; r < values.length; r++) {
    var src = String(values[r][sourceCol]).trim();
    if (!src) continue;                       // blank/padding rows
    var ms = stalenessParseTs_(values[r][tsCol]);
    if (ms === null) continue;
    if (!(src in out) || ms > out[src]) out[src] = ms;
  }
  return out;
}

/** Merge {source: ms} maps, newest wins. */
function stalenessMergeLastSeen_(maps) {
  var out = {};
  for (var i = 0; i < maps.length; i++) {
    var m = maps[i];
    for (var k in m) {
      if (!Object.prototype.hasOwnProperty.call(m, k)) continue;
      if (!(k in out) || m[k] > out[k]) out[k] = m[k];
    }
  }
  return out;
}

/**
 * @param {Object.<string, number>} [overrides] — per-source threshold hours;
 *   a source absent from the map uses thresholdHours. Each report entry
 *   carries the threshold it was judged against (thresholdHours field) so the
 *   alert body can name the right number.
 * @returns {Array.<{source:string, ageHours:(number|null), stale:boolean, lastSeenMs:(number|null), thresholdHours:number}>}
 * Exactly at the threshold is FRESH (strictly greater is stale), so a 96h
 * threshold stays silent on an exactly-96h gap. Never-seen is always stale.
 */
function stalenessEvaluate_(lastSeen, sources, nowMs, thresholdHours, overrides) {
  var out = [];
  for (var i = 0; i < sources.length; i++) {
    var src = sources[i];
    var srcThreshold = (overrides && Object.prototype.hasOwnProperty.call(overrides, src))
      ? overrides[src] : thresholdHours;
    var seen = (src in lastSeen) ? lastSeen[src] : null;

    if (seen === null) {
      out.push({ source: src, ageHours: null, stale: true, lastSeenMs: null, thresholdHours: srcThreshold });
      continue;
    }
    var ageHours = (nowMs - seen) / 3600000;
    out.push({
      source: src,
      ageHours: Math.round(ageHours * 10) / 10,
      stale: ageHours > srcThreshold,
      lastSeenMs: seen,
      thresholdHours: srcThreshold
    });
  }
  return out;
}

/**
 * Stable title with NO varying number in it — the title IS the idempotency key
 * (an age in the title would create a new event every day). Age goes in the body.
 */
function stalenessEventTitle_(source) {
  return 'LEIBLE expense stale: ' + source;
}

/** @returns {string[]} body lines — joined by raiseCalendarAlert_, never hand-joined here. */
function stalenessEventBody_(entry, thresholdHours) {
  var age = (entry.ageHours === null)
    ? 'never seen since the watchdog was installed'
    : entry.ageHours + 'h ago (threshold ' + thresholdHours + 'h)';
  return [
    'Last successful ingest for "' + entry.source + '": ' + age + '.',
    '',
    'Where to look:',
    '  - Windows Task Scheduler → LastTaskResult for the connector task',
    '  - logs\\' + entry.source + '.log in the repo',
    '  - Apps Script → Executions (for square / mayers)',
    '  - Apps Script → Triggers (for shopify_orderapp / greenbean / recurring:',
    '    check the time trigger still exists and is not disabled)',
    '',
    'If the portal session expired, re-auth with: --attended'
  ];
}

/* ------------------------------------------------------------------ *
 * Calendar alerting — the ONLY functions in the project that touch
 * CalendarApp. Every other file raises an alert by calling
 * raiseCalendarAlert_(title, bodyLines, color, nowMs) below.
 * ------------------------------------------------------------------ */

/** Primary calendar (its id IS the account address), else the default. Never throws. */
function stalenessCalendar_() {
  try {
    var cal = CalendarApp.getCalendarById(STALENESS_CALENDAR_ID);
    if (cal) return cal;
  } catch (err) {
    Logger.log('stalenessCalendar_: getCalendarById failed — ' + err.message);
  }
  try {
    return CalendarApp.getDefaultCalendar();
  } catch (err2) {
    Logger.log('stalenessCalendar_: getDefaultCalendar failed — ' + err2.message);
  }
  return null;
}

/** Named color ('ORANGE'/'RED') -> CalendarApp.EventColor, so callers elsewhere
 *  in the project never need to import the CalendarApp symbol themselves. */
function stalenessResolveColor_(name) {
  if (CalendarApp.EventColor && Object.prototype.hasOwnProperty.call(CalendarApp.EventColor, name)) {
    return CalendarApp.EventColor[name];
  }
  return name;
}

/**
 * Shared calendar-alert primitive. Resolves the calendar via
 * stalenessCalendar_ (never throws), and is idempotent within a day: a title
 * already present among today's events is treated as "already raised" and
 * skipped — the title IS the idempotency key, so callers must keep it stable
 * (no varying number/date in it).
 *
 * @param {string} title stable event title
 * @param {string[]} bodyLines joined with '\n' here — callers must not hand-build one blob
 * @param {string} color 'ORANGE' | 'RED' (or any CalendarApp.EventColor key)
 * @param {number} nowMs injected clock
 * @returns {number} 1 if a new event was created, 0 otherwise (incl. on failure)
 */
function raiseCalendarAlert_(title, bodyLines, color, nowMs) {
  var cal = stalenessCalendar_();
  if (!cal) {
    Logger.log('raiseCalendarAlert_: no calendar available — logging only. ' + title);
    return 0;
  }

  var now = new Date(nowMs);

  var existing = {};
  try {
    var events = cal.getEventsForDay(now);
    for (var i = 0; i < events.length; i++) existing[events[i].getTitle()] = true;
  } catch (err) {
    Logger.log('raiseCalendarAlert_: getEventsForDay failed — ' + err.message);
  }
  if (existing[title]) return 0;

  try {
    var ev = cal.createAllDayEvent(title, now);
    ev.setColor(stalenessResolveColor_(color));
    ev.setDescription(bodyLines.join('\n'));
    return 1;
  } catch (err2) {
    Logger.log('raiseCalendarAlert_: could not create event for ' + title + ' — ' + err2.message);
    return 0;
  }
}

/** Raise one orange all-day event per stale source; idempotent within a day. */
function stalenessRaiseAlerts_(staleEntries, nowMs) {
  var created = 0;
  for (var s = 0; s < staleEntries.length; s++) {
    var entry = staleEntries[s];
    var title = stalenessEventTitle_(entry.source);
    var bodyLines = stalenessEventBody_(entry, entry.thresholdHours || STALENESS_THRESHOLD_HOURS);
    created += raiseCalendarAlert_(title, bodyLines, 'ORANGE', nowMs);
  }
  return created;
}

/* ------------------------------------------------------------------ *
 * Trigger installer
 * ------------------------------------------------------------------ */

/**
 * Daily 11:00 Australia/Sydney.
 *
 * 11:00 with a 96h threshold is load-bearing, not cosmetic: StartWhenAvailable
 * fires a missed connector run at LOGON, so an early-morning check could run
 * before the heartbeat it is waiting for and alert on a run that is about to
 * succeed. Worked example — Fri 03:00 → Mon 11:00 = 80h < 96 → silent;
 * Thu 03:00 → Mon 11:00 = 104h > 96 → alerts.
 *
 * Run this from the editor to grant the Calendar scope (Jake only).
 */
function installStalenessTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'checkIngestStaleness') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('checkIngestStaleness')
    .timeBased().atHour(11).everyDays(1).inTimezone('Australia/Sydney').create();
  Logger.log('installStalenessTrigger: daily 11:00 Australia/Sydney trigger installed');
}
