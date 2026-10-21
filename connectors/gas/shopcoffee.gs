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

// Mirrors the producer's parseSkuSize_ (-8K -> 8, -1K -> 1, -200 -> 0.2) plus
// -PT (partial tin, qty already kg -> 1 kg per unit). Unknown suffix -> null.
function shopCoffeeSizeKg_(sku) {
  if (typeof sku !== 'string') return null;
  var s = sku.trim().toUpperCase();
  if (/-PT$/.test(s)) return 1;
  var m = /-(\d+)K$/.exec(s);
  if (m) return Number(m[1]);
  m = /-(\d{3,})$/.exec(s);
  if (m) return Number(m[1]) / 1000;
  return null;
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
