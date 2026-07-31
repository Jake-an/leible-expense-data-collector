/**
 * shopify.gs — Shopify online-order revenue pull -> Revenue tab (kind:'revenue').
 *
 * Mirrors square.gs's shape: loop (single shop/token) -> fetch (paginated
 * REST Admin API) -> normalize (raw rows) -> shared ingest. Unlike square.gs
 * (which writes Sales directly via appendSalesRow_), this routes through the
 * SAME ingest helper doPost's kind:'revenue' path uses (ingestRevenueRows ->
 * normalizeRevenueRow -> upsertRows_, keyed on REVENUE_KEY_COLS = source +
 * order_ref) — no separate dedup mechanism is invented here.
 *
 * Script Properties (never in the repo, never in chat):
 *   SHOPIFY_SHOP_DOMAIN  — e.g. 'your-store.myshopify.com'
 *   SHOPIFY_ACCESS_TOKEN — Admin API access token, scope read_orders.
 *     (Orders older than 60 days need read_all_orders, which requires
 *     Shopify approval — irrelevant here, there is no historical backfill.)
 *
 * shopifyOrdersToRows_ and shopifyParseLinkHeader_ are pure and unit-tested
 * in connectors/gas/test_code.js.
 */

// Confirm the current stable Shopify Admin API version against Shopify's own
// docs at build/deploy time — this is a placeholder, not a value to trust
// from memory long after the fact.
var SHOPIFY_API_VERSION = '2024-10';
var SHOPIFY_TZ = 'Australia/Sydney';
var SHOPIFY_PAGE_LIMIT = 250;
var SHOPIFY_MAX_PAGES = 50; // 50 x 250 = 12,500 orders/day max

/* ------------------------------------------------------------------ *
 * Entry points
 * ------------------------------------------------------------------ */

/**
 * Pull one Sydney-day of Shopify orders into the Revenue tab.
 * @param {string} [dateStr] — 'YYYY-MM-DD'; defaults to yesterday (Australia/Sydney).
 * @returns {{date:string, rowsAdded:number, rowsUpdated:number, duplicatesSkipped:number}}
 */
function shopifyDailyPull(dateStr) {
  // Entry-point lock (same convention as squareDailyPull): shopifyDailyPull
  // is a scan-then-write against Revenue, so the WHOLE entry is wrapped, not
  // just the write half.
  var res = withScriptLock_(function () { return shopifyDailyPull_impl_(dateStr); });
  if (res === LOCK_TIMEOUT_) {
    Logger.log('shopifyDailyPull: could not acquire script lock — skipped this run');
    return { date: null, rowsAdded: 0, rowsUpdated: 0, duplicatesSkipped: 0, locked: true };
  }
  return res;
}

function shopifyDailyPull_impl_(dateStr) {
  // Same event-object guard as squareDailyPull_impl_: a time-based trigger
  // passes its event object here — truthy, so accept only a real date arg.
  var yesterday = Utilities.formatDate(new Date(Date.now() - 24 * 60 * 60 * 1000), SHOPIFY_TZ, 'yyyy-MM-dd');
  var resolved = resolveDateArg_(dateStr, yesterday);
  if (dateStr !== undefined && resolved !== dateStr) {
    Logger.log('shopifyDailyPull: ignoring non-date arg (' + String(dateStr).slice(0, 60) + ') — using ' + resolved);
  }
  dateStr = resolved;

  var props = PropertiesService.getScriptProperties();
  var shopDomain = props.getProperty('SHOPIFY_SHOP_DOMAIN');
  var token = props.getProperty('SHOPIFY_ACCESS_TOKEN');
  if (!shopDomain || !token) {
    Logger.log('shopifyDailyPull: missing SHOPIFY_SHOP_DOMAIN/SHOPIFY_ACCESS_TOKEN — skipping, not stamping heartbeat');
    return { date: dateStr, rowsAdded: 0, rowsUpdated: 0, duplicatesSkipped: 0, apiFailed: false, noToken: true };
  }

  var offset = Utilities.formatDate(new Date(dateStr + 'T12:00:00Z'), SHOPIFY_TZ, 'XXX'); // e.g. +10:00 / +11:00
  var startIso = dateStr + 'T00:00:00' + offset;
  var endIso = dateStr + 'T23:59:59' + offset;
  var extractedAt = Utilities.formatDate(new Date(), SHOPIFY_TZ, "yyyy-MM-dd'T'HH:mm:ssXXX");

  var orders = shopifyFetchAllOrders_(shopDomain, token, startIso, endIso);
  if (orders === null) {
    Logger.log('shopifyDailyPull: Shopify API FAILED — not writing, not counting toward heartbeat');
    return { date: dateStr, rowsAdded: 0, rowsUpdated: 0, duplicatesSkipped: 0, apiFailed: true };
  }

  var rawRows = shopifyOrdersToRows_(orders);

  var ss = getHubSpreadsheet_();
  var sheet = ensureSheet(ss, REVENUE_TAB, REVENUE_HEADERS);
  var res = ingestRevenueRows('shopify', rawRows, extractedAt, sheet);

  // Heartbeat only on a genuinely successful pull — an API failure above
  // already returned before this point, so reaching here means the fetch
  // (even if it returned zero orders for a quiet day) actually succeeded.
  stalenessStampHeartbeat_('shopify');
  Logger.log('shopifyDailyPull: ' + dateStr + ' ' + orders.length + ' orders -> +' +
    res.rowsAdded + ' ~' + res.rowsUpdated + ' =' + res.duplicatesSkipped);

  return {
    date: dateStr, rowsAdded: res.rowsAdded, rowsUpdated: res.rowsUpdated, duplicatesSkipped: res.duplicatesSkipped
  };
}

/**
 * Trigger handler: re-pulls yesterday AND the day before, so a refund posted
 * after yesterday's pull still lands — same order_ref, changed
 * current_total_price, upserted in place by upsertRows_.
 */
function shopifyTriggerPull_() {
  var yesterday = Utilities.formatDate(new Date(Date.now() - 24 * 60 * 60 * 1000), SHOPIFY_TZ, 'yyyy-MM-dd');
  var dayBefore = addDaysStr_(yesterday, -1);
  var dayBeforeResult = shopifyDailyPull(dayBefore);
  var yesterdayResult = shopifyDailyPull(yesterday);
  return { dayBefore: dayBeforeResult, yesterday: yesterdayResult };
}

/**
 * Install a daily trigger alongside squareDailyPull's. Idempotent: removes
 * any existing shopifyTriggerPull_ triggers first.
 */
function installShopifyTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'shopifyTriggerPull_') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('shopifyTriggerPull_').timeBased().atHour(3).everyDays(1).inTimezone(SHOPIFY_TZ).create();
  Logger.log('installShopifyTrigger: daily 3am ' + SHOPIFY_TZ + ' trigger installed (re-pulls last 2 days)');
}

/* ------------------------------------------------------------------ *
 * Pure helpers (unit-tested)
 * ------------------------------------------------------------------ */

/**
 * Map raw Shopify order objects to raw Revenue rows — the same shape a
 * connector POST body row takes ({date, channel, customer, amount,
 * order_ref, department}), ready for ingestRevenueRows/normalizeRevenueRow.
 * - amount = current_total_price (reflects edits/refunds), NEVER total_price
 *   (the original) — that distinction is what makes a later refund actually
 *   change the upserted amount instead of silently no-op'ing as a duplicate.
 * - date is derived from created_at via LOCAL Sydney components
 *   (Utilities.formatDate), NEVER toISOString() — the documented AEST
 *   off-by-one trap.
 * - customer = "first last" when a customer record is attached, else
 *   '#<order_number>' for guest checkouts.
 * @param {Array} orders — Shopify order objects (already de-paginated)
 * @returns {Array<Object>} raw revenue rows
 */
function shopifyOrdersToRows_(orders) {
  var rows = [];
  for (var i = 0; i < orders.length; i++) {
    var o = orders[i];
    if (!o) continue;
    var dateStr = Utilities.formatDate(new Date(o.created_at), SHOPIFY_TZ, 'yyyy-MM-dd');
    rows.push({
      date: dateStr,
      channel: 'online',
      customer: shopifyCustomerName_(o),
      amount: Number(o.current_total_price),
      order_ref: String(o.id),
      department: 'Roastery'
    });
  }
  return rows;
}

function shopifyCustomerName_(order) {
  var c = order.customer;
  if (c && (c.first_name || c.last_name)) {
    return String((c.first_name || '') + ' ' + (c.last_name || '')).trim();
  }
  return '#' + order.order_number;
}

/**
 * Parse a Shopify `Link` response header and return the rel="next" URL, or
 * null if there is no next page. Format:
 *   <https://x/orders.json?...>; rel="previous", <https://x/orders.json?...>; rel="next"
 * @param {string} linkHeader
 * @returns {string|null}
 */
function shopifyParseLinkHeader_(linkHeader) {
  if (!linkHeader || typeof linkHeader !== 'string') return null;
  var parts = linkHeader.split(',');
  for (var i = 0; i < parts.length; i++) {
    var m = parts[i].match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Shopify REST wrapper — cursor pagination via the Link header
 * ------------------------------------------------------------------ */

/**
 * Fetch every order in [startIso, endIso), following Link: rel="next" pages.
 * A single-request implementation silently truncates at SHOPIFY_PAGE_LIMIT
 * (250) orders on a busy day — this loop follows the Link header until it
 * stops offering a next page (or SHOPIFY_MAX_PAGES, as a hard backstop).
 * @returns {Array|null} orders, or null on API failure (do NOT trust partial pages)
 */
function shopifyFetchAllOrders_(shopDomain, token, startIso, endIso) {
  var allOrders = [];
  var url = 'https://' + shopDomain + '/admin/api/' + SHOPIFY_API_VERSION + '/orders.json' +
    '?status=any&limit=' + SHOPIFY_PAGE_LIMIT +
    '&created_at_min=' + encodeURIComponent(startIso) +
    '&created_at_max=' + encodeURIComponent(endIso);
  var page = 0;

  while (url && page < SHOPIFY_MAX_PAGES) {
    var options = {
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      },
      muteHttpExceptions: true
    };

    var response;
    try {
      response = UrlFetchApp.fetch(url, options);
    } catch (e) {
      Logger.log('shopifyFetchAllOrders_ exception: ' + e.message);
      return null;
    }

    var code = response.getResponseCode();
    if (code !== 200) {
      Logger.log('shopifyFetchAllOrders_ error ' + code + ': ' + response.getContentText());
      return null;
    }

    var body;
    try {
      body = JSON.parse(response.getContentText());
    } catch (e2) {
      Logger.log('shopifyFetchAllOrders_ JSON parse error: ' + e2.message);
      return null;
    }

    allOrders = allOrders.concat(body.orders || []);

    var headers = response.getAllHeaders();
    var linkHeader = headers && (headers['Link'] || headers['link']);
    url = shopifyParseLinkHeader_(linkHeader);
    page++;
  }

  return allOrders;
}
