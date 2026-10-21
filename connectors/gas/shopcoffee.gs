/**
 * shopcoffee.gs — SKU size -> kg and bar/retail/unclassified/excluded
 * classification for the shop-coffee-kg phase. Pure functions only.
 *
 * The Order app producer sends RAW lines (sku, category, qty, shop); the hub
 * classifies here. Bar rule (Jake, 2026-10-22): bar = Single Origin 1kg
 * (-1K) + House Blend tins (-8K) + House Blend partial tins (-PT, qty is
 * already kg) + Decaf 1kg + Cold Brew 1kg. Every other coffee-bean line is
 * retail. Drip Bag / Tea / Packaging / Misc are excluded (kg 0). A null or
 * unknown category, or an unparseable size suffix, is unclassified (kg 0) —
 * never guessed, so it surfaces in the tab instead of hiding.
 */

var SHOP_COFFEE_BEAN_CATEGORIES = ['House Blend', 'Single Origin', 'Reserve Single Origin', 'Decaf', 'Cold Brew'];
var SHOP_COFFEE_EXCLUDED_CATEGORIES = ['Drip Bag', 'Tea', 'Packaging', 'Misc'];
// category -> size suffixes that count as bar (everything else in the bean list is retail).
var SHOP_COFFEE_BAR_RULES = {
  'Single Origin': ['-1K'],
  'House Blend': ['-8K', '-PT'],
  'Decaf': ['-1K'],
  'Cold Brew': ['-1K']
};

// Exact suffixes only, mirroring the producer's parseSkuSize_ (-8K -> 8, -1K -> 1,
// -200 -> 0.2) plus -PT (partial tin, qty already kg -> 1 kg per unit). Anything
// else (-5K, -500, -1000, ...) -> null, never guessed.
var SHOP_COFFEE_SIZE_KG = { '-8K': 8, '-1K': 1, '-200': 0.2, '-PT': 1 };

function shopCoffeeSizeKg_(sku) {
  if (typeof sku !== 'string') return null;
  var suffix = shopCoffeeSuffix_(sku);
  return Object.prototype.hasOwnProperty.call(SHOP_COFFEE_SIZE_KG, suffix) ? SHOP_COFFEE_SIZE_KG[suffix] : null;
}

function shopCoffeeSuffix_(sku) {
  var m = /(-[A-Z0-9]+)$/.exec(String(sku).trim().toUpperCase());
  return m ? m[1] : '';
}

function shopCoffeeClassify_(line) {
  var none = { bucket: 'unclassified', kg: 0 };
  if (!line || typeof line !== 'object') return none;
  var cat = line.category;
  if (typeof cat !== 'string') return none;
  if (SHOP_COFFEE_EXCLUDED_CATEGORIES.indexOf(cat) !== -1) return { bucket: 'excluded', kg: 0 };
  if (SHOP_COFFEE_BEAN_CATEGORIES.indexOf(cat) === -1) return none;
  var size = shopCoffeeSizeKg_(line.sku);
  var qty = line.qty;
  if (size === null || typeof qty !== 'number' || !isFinite(qty)) return none;
  var suffix = shopCoffeeSuffix_(line.sku);
  // -PT is only meaningful on House Blend; elsewhere it is never guessed.
  if (suffix === '-PT' && cat !== 'House Blend') return none;
  var rules = SHOP_COFFEE_BAR_RULES[cat] || [];
  var bucket = rules.indexOf(suffix) !== -1 ? 'bar' : 'retail';
  return { bucket: bucket, kg: Math.round(size * qty * 1000) / 1000 };
}

/* ------------------------------------------------------------------ *
 * Fetch + strict completeness gate (no Sheet access)
 * ------------------------------------------------------------------ */

var SHOP_COFFEE_PAGE_LIMIT = 200;
var SHOP_COFFEE_MAX_PAGES = 20; // page-cap backstop, mirrors WHOLESALE_MAX_PAGES

/** Pure. First problem with one raw line, or null if it is well-formed. */
function shopCoffeeLineProblem_(line) {
  if (!line || typeof line !== 'object') return 'not an object';
  if (typeof line.qty !== 'number' || !isFinite(line.qty) || line.qty <= 0) return 'bad qty';
  if (typeof line.sku !== 'string' || !line.sku) return 'bad sku';
  if (typeof line.orderId !== 'string' || !line.orderId) return 'bad orderId';
  if (typeof line.shopId !== 'string' || !line.shopId) return 'bad shopId';
  return null;
}

/**
 * Pages ?api=shopCoffeeLines for one week via orderAppFetch_ and returns the
 * week ONLY if every gate holds; any failure is ok:false (never partial lines).
 * @param {string} weekLabel e.g. '2026-W42'
 * @returns {{ok:true, lines:Array, matched:number, diagnostics:Object, meta:Object, duplicates:number}|{ok:false, reason:string}}
 */
function shopCoffeeFetchWeekLines_(weekLabel) {
  var offset = 0;
  var collected = [];
  var seen = {};
  var duplicates = 0;
  var pages = 0;
  var matched = null;
  var diagnostics = null;
  var meta = null;

  while (true) {
    var res = orderAppFetch_({
      api: 'shopCoffeeLines',
      week: weekLabel,
      limit: SHOP_COFFEE_PAGE_LIMIT,
      offset: offset
    });
    if (!res.ok) return { ok: false, reason: 'fetch: ' + res.reason };

    var body = res.body;
    var tag = 'page ' + pages + ': ';
    if (!body || body.ok !== true) return { ok: false, reason: tag + 'body ok !== true' };
    if (!body.diagnostics || body.diagnostics.rowsOk !== true || body.diagnostics.linesOk !== true) {
      return { ok: false, reason: tag + 'diagnostics rowsOk/linesOk not both true' };
    }
    if (!Array.isArray(body.lines)) return { ok: false, reason: tag + 'lines is not an array' };
    var paging = body.meta && body.meta.paging;
    var pageMatched = paging ? paging.matched : undefined;
    if (typeof pageMatched !== 'number' || !isFinite(pageMatched) || pageMatched < 0) {
      return { ok: false, reason: tag + 'meta.paging.matched missing or invalid' };
    }

    // The producer recomputes matched over the live sheet on every request.
    if (pages === 0) {
      matched = pageMatched;
      diagnostics = body.diagnostics;
      meta = body.meta;
    } else if (pageMatched !== matched) {
      return { ok: false, reason: tag + 'matched shifted mid-scan: ' + matched + ' -> ' + pageMatched };
    }

    var pageLines = body.lines;
    for (var i = 0; i < pageLines.length; i++) {
      var line = pageLines[i];
      var problem = shopCoffeeLineProblem_(line);
      if (problem) return { ok: false, reason: tag + 'malformed line ' + i + ' (' + problem + ')' };
      var key = line.orderId + '|' + line.sku;
      if (Object.prototype.hasOwnProperty.call(seen, key)) {
        if (seen[key].qty !== line.qty) {
          return { ok: false, reason: tag + 'duplicate line key with different qty' };
        }
        duplicates++;
        continue;
      }
      seen[key] = line;
      collected.push(line);
    }

    offset += pageLines.length;
    pages++;
    if (body.meta.paging.truncated !== true) break; // producer says done; mismatch caught below
    if (pageLines.length === 0 || collected.length >= matched) {
      return { ok: false, reason: 'truncated page ' + (pages - 1) + ' made no progress: ' + collected.length + ' of ' + matched + ' collected' };
    }
    if (pages >= SHOP_COFFEE_MAX_PAGES) {
      return { ok: false, reason: 'exceeded ' + SHOP_COFFEE_MAX_PAGES + ' pages — aborting (suspect non-advancing paging)' };
    }
  }

  // Deliberate (per step spec): the gate compares the POST-dedup count to the
  // producer's matched. Dropped same-qty duplicates are reported in `duplicates`
  // for the caller to log. Ceiling: PAGE_LIMIT x MAX_PAGES = 4000 lines/week; a
  // bigger week fails loudly here, it is not a producer fault.
  if (collected.length !== matched) {
    return { ok: false, reason: 'collected ' + collected.length + ' !== matched ' + matched };
  }
  return { ok: true, lines: collected, matched: matched, diagnostics: diagnostics, meta: meta, duplicates: duplicates };
}

/* ------------------------------------------------------------------ *
 * Aggregate (pure: no Sheet, no clock — pulled_at is passed in)
 * ------------------------------------------------------------------ */

// Default shop map (Jake, 2026-10-22); a Script Property may override it (step 4).
var SHOP_COFFEE_SHOPS_DEFAULT = { 'Leible York': 'York', 'Leible Pitt': 'Pitt', 'Leible Crows Nest': 'Crowsnest', 'Leible Blue': 'North' };
// Fixed row order: the tab holds exactly these shops, zero rows included.
var SHOP_COFFEE_SHOP_ORDER = ['York', 'Pitt', 'Crowsnest', 'North'];
var SHOP_COFFEE_HEADERS = ['week_start', 'week_end', 'iso_week', 'shop', 'bar_kg', 'retail_kg', 'unclassified_kg', 'excluded_lines', 'line_count', 'pulled_at'];

/**
 * @returns {{rows:Array<Array>, unmappedShopIds:Array<{shopId:string,lines:number,kg:number}>,
 *            totals:{bar:number,retail:number,unclassified:number,unmappedKg:number,reconciled:boolean}}}
 */
function shopCoffeeAggregate_(lines, weekStart, weekEnd, isoWeek, shopMap, nowIso) {
  var acc = {};
  SHOP_COFFEE_SHOP_ORDER.forEach(function (s) { acc[s] = { bar: 0, retail: 0, unclassified: 0, excluded: 0, count: 0 }; });
  var unmapped = {};
  var unmappedOrder = [];
  var inputMg = 0;
  var map = shopMap || {};

  (lines || []).forEach(function (line) {
    var c = shopCoffeeClassify_(line);
    inputMg += Math.round(c.kg * 1000);
    var id = line && line.shopId;
    var shop = Object.prototype.hasOwnProperty.call(map, id) ? map[id] : null;
    if (shop === null) {
      if (!Object.prototype.hasOwnProperty.call(unmapped, id)) { unmapped[id] = { shopId: id, lines: 0, kg: 0 }; unmappedOrder.push(id); }
      unmapped[id].lines++;
      unmapped[id].kg += c.kg;
      return;
    }
    // A mapped name outside the fixed set has no row: its kg goes missing and reconciliation flags it.
    if (!Object.prototype.hasOwnProperty.call(acc, shop)) return;
    var a = acc[shop];
    a.count++;
    if (c.bucket === 'excluded') a.excluded++;
    else a[c.bucket] += c.kg;
  });

  var r3 = function (n) { return Math.round(n * 1000) / 1000; };
  var rowsMg = 0;
  var tot = { bar: 0, retail: 0, unclassified: 0 };
  var rows = SHOP_COFFEE_SHOP_ORDER.map(function (s) {
    var a = acc[s];
    var bar = r3(a.bar), retail = r3(a.retail), unc = r3(a.unclassified);
    rowsMg += Math.round(bar * 1000) + Math.round(retail * 1000) + Math.round(unc * 1000);
    tot.bar += bar; tot.retail += retail; tot.unclassified += unc;
    return [weekStart, weekEnd, isoWeek, s, bar, retail, unc, a.excluded, a.count, nowIso];
  });
  var unmappedKg = 0;
  var unmappedList = unmappedOrder.map(function (id) {
    var u = unmapped[id];
    u.kg = r3(u.kg);
    unmappedKg += Math.round(u.kg * 1000);
    return u;
  });

  return {
    rows: rows,
    unmappedShopIds: unmappedList,
    totals: {
      bar: r3(tot.bar), retail: r3(tot.retail), unclassified: r3(tot.unclassified),
      unmappedKg: unmappedKg / 1000,
      reconciled: rowsMg + unmappedKg === inputMg
    }
  };
}
