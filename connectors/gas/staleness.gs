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
 * THIS FILE IS THE ONLY SOURCE OF THE CalendarApp OAuth SCOPE. Deploy it on its
 * own (deploy.sh --push-only → authorize → full deploy) so a scope change can
 * never take /exec down with un-consented code — /exec is the sole ingest path.
 */

var STALENESS_THRESHOLD_HOURS = 96;              // silent through a normal Fri→Mon (80h)
var STALENESS_CALENDAR_ID = 'mio.jake@gmail.com';
// Every source that stamps a heartbeat should be watched, EXCEPT where its run
// cadence is longer than STALENESS_THRESHOLD_HOURS. Deliberately excluded:
//   'recurring' — runs MONTHLY (recurring.gs). At a 96h threshold it would sit
//   stale ~26 days of every month and cry wolf continuously. Watching it needs
//   per-source thresholds, which this file does not have. See TODO.md.
//   'shopify_orderapp' (weekly, Mon 05:00) and 'greenbean' (weekly, Tue 05:00)
//   are deliberately NOT in the 96h watchdog — their cadence is 168h and their
//   failure detection is the orderapp fail-open counter/alert (orderapp.gs).
//   'coffee_order_app' — NO LIVE WRITER today, so watching it would false-alarm
//   daily as a never-seen source. Its suppliers-kind path is mechanically
//   rejected (validateIngest_), but its wholesale-REVENUE path is still
//   sanctioned in docs/ingest-contract.md and doPost stamps body.source
//   generically — so the moment that writer ships, RE-ADD 'coffee_order_app'
//   here (and to STAMPS_HEARTBEAT in test_code.js) or it runs unwatched.
var STALENESS_SOURCES = ['food_dairy_co', 'fresh_and_chill', 'ordermentum', 'square', 'mayers', 'roastery'];
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
  var report = stalenessEvaluate_(lastSeen, STALENESS_SOURCES, nowMs, STALENESS_THRESHOLD_HOURS);

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
 * @returns {Array.<{source:string, ageHours:(number|null), stale:boolean, lastSeenMs:(number|null)}>}
 * Exactly at the threshold is FRESH (strictly greater is stale), so a 96h
 * threshold stays silent on an exactly-96h gap. Never-seen is always stale.
 */
function stalenessEvaluate_(lastSeen, sources, nowMs, thresholdHours) {
  var out = [];
  for (var i = 0; i < sources.length; i++) {
    var src = sources[i];
    var seen = (src in lastSeen) ? lastSeen[src] : null;

    if (seen === null) {
      out.push({ source: src, ageHours: null, stale: true, lastSeenMs: null });
      continue;
    }
    var ageHours = (nowMs - seen) / 3600000;
    out.push({
      source: src,
      ageHours: Math.round(ageHours * 10) / 10,
      stale: ageHours > thresholdHours,
      lastSeenMs: seen
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
    '',
    'If the portal session expired, re-auth with: --attended'
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * Calendar alerting
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

/** Raise one orange all-day event per stale source; idempotent within a day. */
function stalenessRaiseAlerts_(staleEntries, nowMs) {
  var cal = stalenessCalendar_();
  if (!cal) {
    Logger.log('stalenessRaiseAlerts_: no calendar available — logging only. Stale: ' +
      staleEntries.map(function (e) { return e.source; }).join(', '));
    return 0;
  }

  var now = new Date(nowMs);

  // One read → titles already on the day = alerts already raised.
  var existing = {};
  try {
    var events = cal.getEventsForDay(now);
    for (var i = 0; i < events.length; i++) existing[events[i].getTitle()] = true;
  } catch (err) {
    Logger.log('stalenessRaiseAlerts_: getEventsForDay failed — ' + err.message);
  }

  var created = 0;
  for (var s = 0; s < staleEntries.length; s++) {
    var title = stalenessEventTitle_(staleEntries[s].source);
    if (existing[title]) continue;
    try {
      var ev = cal.createAllDayEvent(title, now);
      ev.setColor(CalendarApp.EventColor.ORANGE);
      ev.setDescription(stalenessEventBody_(staleEntries[s], STALENESS_THRESHOLD_HOURS));
      created++;
    } catch (err2) {
      Logger.log('stalenessRaiseAlerts_: could not create event for ' +
        staleEntries[s].source + ' — ' + err2.message);
    }
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
