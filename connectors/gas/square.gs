/**
 * square.gs — Square daily gross-sales pull → Sales tab.
 *
 * API wrapper (squareCallApi_/squareSearchOrders_/squareListLocations_) is lifted
 * from LEIBLE_GM_COST_MONITOR/SquareAPI.gs, with the Config.getSquareEnvironment()
 * dependency dropped (production base URL is used directly). See docs/ADR.md ADR-001.
 *
 * Each LEIBLE site has its own Square access token in Script Properties. We sum
 * total_money across that token's COMPLETED orders for the day and write one
 * gross row per site to Sales (dedup date+location). Gross only, no backfill.
 *
 * squareSumOrderGross_ is pure and unit-tested in connectors/gas/test_code.js.
 */

var SQUARE_BASE_URL = 'https://connect.squareup.com/v2';
var SQUARE_VERSION = '2025-01-23';

// One Script Property token per site. listLocations() resolves the location id(s)
// behind each token; all orders under a token roll up to the site name below.
var SQUARE_SITES = [
  { name: 'York', prop: 'SQUARE_ACCESS_TOKEN_YORK' },
  { name: 'North Sydney', prop: 'SQUARE_ACCESS_TOKEN_NORTH_SYDNEY' },
  { name: 'Crows Nest', prop: 'SQUARE_ACCESS_TOKEN_CROWSNEST' },
  { name: 'Pitt', prop: 'SQUARE_ACCESS_TOKEN_PITT' }
];

var SQUARE_TZ = 'Australia/Sydney';

/* ------------------------------------------------------------------ *
 * Entry points
 * ------------------------------------------------------------------ */

/**
 * Pull one day's gross sales per site into the Sales tab.
 * @param {string} [dateStr] — 'YYYY-MM-DD'; defaults to yesterday (Australia/Sydney).
 * @returns {{date:string, rowsWritten:number, duplicatesSkipped:number}}
 */
function squareDailyPull(dateStr) {
  if (!dateStr) {
    var yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    dateStr = Utilities.formatDate(yesterday, SQUARE_TZ, 'yyyy-MM-dd');
  }

  var offset = Utilities.formatDate(new Date(dateStr + 'T12:00:00Z'), SQUARE_TZ, 'XXX'); // e.g. +10:00 / +11:00
  var startIso = dateStr + 'T00:00:00' + offset;
  var endIso = dateStr + 'T23:59:59' + offset;
  var extractedAt = Utilities.formatDate(new Date(), SQUARE_TZ, "yyyy-MM-dd'T'HH:mm:ssXXX");

  var props = PropertiesService.getScriptProperties();
  var ss = getHubSpreadsheet_();
  var sheet = ensureSheet(ss, SALES_TAB, SALES_HEADERS);

  var rowsWritten = 0;
  var duplicatesSkipped = 0;

  for (var i = 0; i < SQUARE_SITES.length; i++) {
    var site = SQUARE_SITES[i];
    var token = props.getProperty(site.prop);
    if (!token) {
      Logger.log('squareDailyPull: no token for ' + site.name + ' (' + site.prop + ') — skipping');
      continue;
    }

    var orders = [];
    var locations = squareListLocations_(token);
    for (var l = 0; l < locations.length; l++) {
      orders = orders.concat(squareSearchOrders_(token, locations[l].id, startIso, endIso));
    }

    var gross = squareSumOrderGross_(orders);
    var salesRow = [dateStr, site.name, gross, 'square', extractedAt];
    if (appendSalesRow_(sheet, salesRow)) rowsWritten++;
    else duplicatesSkipped++;
    Logger.log('squareDailyPull: ' + site.name + ' ' + dateStr + ' gross=$' + gross + ' from ' + orders.length + ' orders');
  }

  return { date: dateStr, rowsWritten: rowsWritten, duplicatesSkipped: duplicatesSkipped };
}

/**
 * Install a daily ~3am Australia/Sydney trigger for the previous day's pull.
 * Idempotent: removes any existing squareDailyPull triggers first.
 */
function installSquareTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'squareDailyPull') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('squareDailyPull').timeBased().atHour(3).everyDays(1).inTimezone(SQUARE_TZ).create();
  Logger.log('installSquareTrigger: daily 3am ' + SQUARE_TZ + ' trigger installed');
}

/* ------------------------------------------------------------------ *
 * Pure helper (unit-tested)
 * ------------------------------------------------------------------ */

/**
 * Sum order total_money (cents) → dollars, rounded to 2dp.
 * @param {Array} orders — Square order objects
 * @returns {number} gross dollars
 */
function squareSumOrderGross_(orders) {
  var cents = 0;
  for (var i = 0; i < orders.length; i++) {
    var o = orders[i];
    if (o && o.total_money && typeof o.total_money.amount === 'number') {
      cents += o.total_money.amount;
    }
  }
  return Math.round(cents) / 100;
}

/* ------------------------------------------------------------------ *
 * Square REST wrapper — lifted from GM Cost Monitor, Config dependency removed
 * ------------------------------------------------------------------ */

function squareCallApi_(endpoint, accessToken, method, payload) {
  var options = {
    method: method || 'GET',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
      'Square-Version': SQUARE_VERSION
    },
    muteHttpExceptions: true
  };
  if (payload && method === 'POST') options.payload = JSON.stringify(payload);

  try {
    var response = UrlFetchApp.fetch(SQUARE_BASE_URL + endpoint, options);
    var code = response.getResponseCode();
    var bodyText = response.getContentText();
    if (code === 200 || code === 201) return JSON.parse(bodyText);
    Logger.log('squareCallApi_ error ' + code + ' on ' + endpoint + ': ' + bodyText);
    return null;
  } catch (e) {
    Logger.log('squareCallApi_ exception on ' + endpoint + ': ' + e.message);
    return null;
  }
}

function squareSearchOrders_(accessToken, locationId, startDate, endDate) {
  var allOrders = [];
  var cursor = null;
  var maxPages = 50; // 50 × 500 = 25,000 orders max
  var page = 0;

  do {
    var payload = {
      location_ids: [locationId],
      limit: 500,
      query: {
        filter: {
          state_filter: { states: ['COMPLETED'] },
          date_time_filter: { closed_at: { start_at: startDate, end_at: endDate } }
        },
        sort: { sort_field: 'CLOSED_AT', sort_order: 'ASC' }
      }
    };
    if (cursor) payload.cursor = cursor;

    var result = squareCallApi_('/orders/search', accessToken, 'POST', payload);
    if (!result) break;

    allOrders = allOrders.concat(result.orders || []);
    cursor = result.cursor || null;
    page++;
  } while (cursor && page < maxPages);

  return allOrders;
}

function squareListLocations_(accessToken) {
  var result = squareCallApi_('/locations', accessToken, 'GET', null);
  if (!result || !result.locations) return [];
  return result.locations.map(function (loc) {
    return { id: loc.id, name: loc.name, status: loc.status };
  });
}
