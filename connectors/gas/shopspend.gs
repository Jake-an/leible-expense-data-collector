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

/**
 * Normalize + append a batch of ShopSpend rows — straightforward append, no
 * dedup/upsert (change detection + tombstones land in step 3; routing this
 * through upsertRows_ would mutate prior rows in place and collapse
 * same-key rows within a batch, the opposite of an append-only snapshot
 * store). If `pull` is present, one metadata row is appended to
 * ShopSpendPulls LAST, after the data rows, as the commit marker for a
 * chunked pull.
 * @returns {{rowsAdded:number, rowsUpdated:number, duplicatesSkipped:number}}
 */
function ingestShopSpendRows(source, rows, extractedAt, sheet, pullsSheet, pull) {
  var normalizedRows = [];
  for (var i = 0; i < rows.length; i++) {
    normalizedRows.push(normalizeShopSpendRow(rows[i], source, extractedAt));
  }
  appendNewRows_(sheet, normalizedRows);

  if (pull) {
    appendNewRows_(pullsSheet, [normalizePullMetadataRow_(pull)]);
  }

  return { rowsAdded: normalizedRows.length, rowsUpdated: 0, duplicatesSkipped: 0 };
}
