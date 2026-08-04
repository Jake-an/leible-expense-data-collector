/**
 * shopspend.gs — shopSpend silo.
 *
 * Separate from the Suppliers/Sales/Revenue/Summary ingest contract: ShopSpend
 * is an append-only snapshot store (never routed through upsertRows_), backed
 * by ShopSpendPulls (one row per pull attempt) and ShopSpend Report (derived,
 * rebuilt in place). See docs/schema.md for the full tab specs.
 *
 * Loaded by connectors/gas/test_code.js under the Node mock of SpreadsheetApp.
 */

/**
 * Ensure the three shopSpend tabs exist with their header rows.
 * @returns {{ data: Sheet, pulls: Sheet, report: Sheet }}
 */
function ensureShopSpendTabs_(ss) {
  return {
    data: ensureSheet(ss, SHOPSPEND_TAB, SHOPSPEND_HEADERS),
    pulls: ensureSheet(ss, SHOPSPEND_PULLS_TAB, SHOPSPEND_PULLS_HEADERS),
    report: ensureSheet(ss, SHOPSPEND_REPORT_TAB, [])
  };
}
