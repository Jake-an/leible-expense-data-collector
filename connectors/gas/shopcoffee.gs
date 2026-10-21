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

/* ------------------------------------------------------------------ *
 * Pull orchestrator: fetch -> aggregate -> whole-row upsert (PRD-21)
 * ------------------------------------------------------------------ */

var SHOP_COFFEE_TAB = 'ShopCoffee';
var SHOP_COFFEE_SOURCE = 'shopcoffee';
var SHOP_COFFEE_SHOPS_PROP = 'SHOP_COFFEE_SHOPS'; // optional JSON override of SHOP_COFFEE_SHOPS_DEFAULT
var SHOP_COFFEE_BACKFILLED_PROP = 'SHOP_COFFEE_BACKFILLED';
var SHOP_COFFEE_BACKFILL_WEEKS = 12;
var SHOP_COFFEE_REPULL_WEEKS = 8; // late status flips
// Unmapped Leible-prefixed ids that are expected and only logged (non-Leible shops are always expected).
var SHOP_COFFEE_EXPECTED_UNMAPPED = ['Leible Taiwan'];

/**
 * ShopCoffee upsert on week_start||shop. A matching key is ALWAYS rewritten
 * whole (a changed retail_kg alone must self-heal); no match appends. A
 * within-batch duplicate key is a caller bug and throws rather than being
 * silently dropped.
 * @returns {{added:number, updated:number}}
 */
function shopCoffeeUpsert_(sheet, rows) {
  var seenKeys = {};
  rows.forEach(function (row) {
    var k = coerceDateStr_(row[0]) + '||' + String(row[3]);
    if (Object.prototype.hasOwnProperty.call(seenKeys, k)) throw new Error('shopCoffeeUpsert_: duplicate key in batch: ' + k);
    seenKeys[k] = true;
  });
  var data = sheet.getDataRange().getValues();
  var idx = {};
  for (var r = 1; r < data.length; r++) idx[coerceDateStr_(data[r][0]) + '||' + String(data[r][3])] = r;
  var added = 0, updated = 0;
  rows.forEach(function (row) {
    var key = coerceDateStr_(row[0]) + '||' + String(row[3]);
    if (Object.prototype.hasOwnProperty.call(idx, key)) {
      sheet.getRange(idx[key] + 1, 1, 1, row.length).setValues([sheetSafeRow_(row)]);
      updated++;
    } else {
      sheet.appendRow(sheetSafeRow_(row));
      data.push(row.slice());
      idx[key] = data.length - 1;
      added++;
    }
  });
  return { added: added, updated: updated };
}

/** Shop map: Script Property override if set, else the code default. Returns null when set but unparseable. */
function shopCoffeeShopMap_(props) {
  var raw = props.getProperty(SHOP_COFFEE_SHOPS_PROP);
  if (raw === null || raw === undefined || String(raw).trim() === '') return SHOP_COFFEE_SHOPS_DEFAULT;
  try {
    var parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch (e) { /* fall through */ }
  return null;
}

/** An unmapped Leible-owned shop we did not expect (Taiwan and external shops are expected). */
function shopCoffeeUnexpectedUnmapped_(shopId) {
  return /^Leible/.test(shopId) && SHOP_COFFEE_EXPECTED_UNMAPPED.indexOf(shopId) === -1;
}

/**
 * Weekly ShopCoffee pull. orderAppRunStart_ runs BEFORE the lock so a lock
 * timeout still counts as a non-completion. A dry run does no run accounting.
 * @param {{dryRun?:boolean}} [opts]
 */
function shopCoffeePull(opts) {
  var dryRun = !!opts && opts.dryRun === true;
  if (!dryRun) orderAppRunStart_(SHOP_COFFEE_SOURCE);
  var res = withScriptLock_(function () { return shopCoffeePull_impl_(dryRun); });
  if (res === LOCK_TIMEOUT_) {
    Logger.log('shopCoffeePull: could not acquire script lock — skipped this run');
    return { locked: true };
  }
  return res;
}

function shopCoffeePull_impl_(dryRun) {
  var props = PropertiesService.getScriptProperties();
  var skip = function (why) {
    if (!dryRun) orderAppRunSkipped_(SHOP_COFFEE_SOURCE);
    Logger.log('shopCoffeePull: skipped — ' + why + '; nothing written, no heartbeat');
    return { skipped: why, dryRun: dryRun };
  };
  if (!getOrderAppToken_()) return skip('ORDER_APP_COST_TOKEN unset');
  var shopMap = shopCoffeeShopMap_(props);
  if (!shopMap) return skip(SHOP_COFFEE_SHOPS_PROP + ' is set but not a parseable JSON object');

  var firstRun = !props.getProperty(SHOP_COFFEE_BACKFILLED_PROP);
  var weeks = lastCompletedWeeks_(todayStr_(), firstRun ? SHOP_COFFEE_BACKFILL_WEEKS : SHOP_COFFEE_REPULL_WEEKS);
  var nowIso = Utilities.formatDate(new Date(Date.now()), 'Australia/Sydney', "yyyy-MM-dd'T'HH:mm:ssXXX");
  var sheet = null;
  if (!dryRun) sheet = ensureSheet(getHubSpreadsheet_(), SHOP_COFFEE_TAB, SHOP_COFFEE_HEADERS);

  var out = { weeksRequested: weeks.length, weeksWritten: 0, weeksSkipped: 0, rowsWritten: 0, unmapped: [], dryRun: dryRun };
  var clean = true;
  weeks.forEach(function (w) {
    var tag = 'shopCoffeePull ' + w.label + ': ';
    try {
      var f = shopCoffeeFetchWeekLines_(w.label);
      if (!f.ok) { out.weeksSkipped++; clean = false; Logger.log(tag + 'SKIPPED — ' + f.reason); return; }
      var agg = shopCoffeeAggregate_(f.lines, w.start, w.end, w.label, shopMap, nowIso);
      if (!agg.totals.reconciled) { out.weeksSkipped++; clean = false; Logger.log(tag + 'SKIPPED — aggregate did not reconcile'); return; }
      if (!dryRun) shopCoffeeUpsert_(sheet, agg.rows);
      out.weeksWritten++;
      out.rowsWritten += agg.rows.length;
      var um = agg.unmappedShopIds.map(function (u) {
        var unexpected = shopCoffeeUnexpectedUnmapped_(u.shopId);
        out.unmapped.push({ week: w.label, shopId: u.shopId, lines: u.lines, kg: u.kg });
        if (unexpected) clean = false;
        return u.shopId + ' (' + u.lines + ' lines, ' + u.kg + ' kg' + (unexpected ? ', UNEXPECTED' : '') + ')';
      });
      Logger.log(tag + (dryRun ? 'would write ' : 'wrote ') + agg.rows.length + ' rows; bar ' + agg.totals.bar + ' kg, retail ' +
        agg.totals.retail + ' kg, unclassified ' + agg.totals.unclassified + ' kg; unmapped: ' + (um.length ? um.join(', ') : 'none'));
    } catch (e) {
      out.weeksSkipped++; clean = false;
      Logger.log(tag + 'SKIPPED — error: ' + (e && e.message));
    }
  });

  if (dryRun) return out;
  if (clean) {
    if (firstRun) props.setProperty(SHOP_COFFEE_BACKFILLED_PROP, nowIso);
    orderAppRunSuccess_(SHOP_COFFEE_SOURCE);
  } else {
    Logger.log('shopCoffeePull: run not clean (week(s) skipped or unexpected unmapped shop) — no heartbeat');
  }
  return out;
}

/** Editor Run-button wrappers (the dropdown passes no arguments). */
function shopCoffeePullRun() {
  var res = shopCoffeePull({});
  Logger.log('shopCoffeePullRun: ' + JSON.stringify(res));
  return res;
}

function shopCoffeePullDry() {
  var res = shopCoffeePull({ dryRun: true });
  Logger.log('shopCoffeePullDry: ' + JSON.stringify(res));
  return res;
}

/* ---- read API (doGet fn=shopCoffee) — called only from Code.gs doGet, after the token check ---- */

function shopCoffeeValidDate_(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  var d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function shopCoffeeReadError_(message) {
  return { ok: false, result: 'error', message: message };
}

/**
 * ShopCoffee rows with week_start in [from, to] (inclusive). Neither param ->
 * the last completed week. Invalid/inverted/half-supplied bounds -> error body.
 * @returns {Object} plain response body (caller wraps with jsonOut_)
 */
function shopCoffeeRead_(from, to) {
  if (!from && !to) {
    var lw = getLastCompletedWeek_(todayStr_());
    from = lw.start;
    to = lw.start;
  }
  if (!shopCoffeeValidDate_(from) || !shopCoffeeValidDate_(to)) {
    return shopCoffeeReadError_('from and to must both be valid yyyy-MM-dd dates');
  }
  if (from > to) return shopCoffeeReadError_('from must not be after to');

  var out = { ok: true, fn: 'shopCoffee', from: from, to: to, rows: [] };
  var sheet = getHubSpreadsheet_().getSheetByName(SHOP_COFFEE_TAB);
  if (!sheet) {
    out.note = 'ShopCoffee tab not found; no rows yet';
    return out;
  }
  var data = sheet.getDataRange().getValues();
  var numCols = ['bar_kg', 'retail_kg', 'unclassified_kg', 'excluded_lines', 'line_count'];
  for (var r = 1; r < data.length; r++) {
    var ws = coerceDateStr_(data[r][0]);
    if (ws < from || ws > to) continue;
    var obj = {};
    SHOP_COFFEE_HEADERS.forEach(function (h, c) {
      var v = data[r][c];
      if (h === 'week_start' || h === 'week_end') obj[h] = coerceDateStr_(v);
      else if (numCols.indexOf(h) !== -1) obj[h] = Number(v);
      else obj[h] = v instanceof Date ? v.toISOString() : String(v);
    });
    out.rows.push(obj);
  }
  return out;
}
