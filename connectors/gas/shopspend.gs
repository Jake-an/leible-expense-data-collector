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
 * Normalize + ingest a batch of ShopSpend rows with change detection.
 * Append-only: a row is written only when a figure changed. Tombstones mark
 * shop-weeks that disappear. If `pull` is present, one metadata row is
 * appended to ShopSpendPulls LAST, after the data rows, as the commit marker
 * for a chunked pull.
 * @returns {{rowsAdded:number, rowsUpdated:number, duplicatesSkipped:number}}
 */
function ingestShopSpendRows(source, rows, extractedAt, sheet, pullsSheet, pull) {
  var normalizedRows = [];
  for (var i = 0; i < rows.length; i++) {
    normalizedRows.push(normalizeShopSpendRow(rows[i], source, extractedAt));
  }

  // 1. Build latest-snapshot index: for each (shop_id, week_label) key,
  // keep LAST row encountered (append order).
  var allValues = sheet.getDataRange().getValues();
  var latestIndex = {}; // key -> row array
  for (var r = 1; r < allValues.length; r++) { // skip header
    var row = allValues[r];
    var key = rowKey_(row, [0, 1]); // shop_id, week_label
    latestIndex[key] = row;
  }

  // 2. Change detection: collect rows to append.
  var toAppend = [];
  var duplicatesSkipped = 0;
  var incomingKeys = {}; // keys present in this payload, scoped to weeks covered
  var weeksInPayload = {}; // weeks covered by this payload

  for (var i = 0; i < normalizedRows.length; i++) {
    var row = normalizedRows[i];
    var key = rowKey_(row, [0, 1]); // shop_id, week_label
    incomingKeys[key] = true;
    weeksInPayload[row[1]] = true; // week_label at index 1

    var latest = latestIndex[key];
    var isNew = latest === undefined;

    if (isNew) {
      toAppend.push(row);
    } else {
      // Compare the five numeric figures: order_count (4), amended_count (5),
      // total_ex_gst (6), gst (7), total_inc_gst (8).
      var figureChanged = false;
      for (var fIdx = 4; fIdx <= 8; fIdx++) {
        if (Number(row[fIdx]) !== Number(latest[fIdx])) {
          figureChanged = true;
          break;
        }
      }

      // A latest snapshot with presence='absent' counts as a difference —
      // the shop-week reappearing is a real change.
      var wasAbsent = latest[13] === 'absent'; // presence at index 13

      if (figureChanged || wasAbsent) {
        toAppend.push(row);
        latestIndex[key] = row; // update the latest snapshot for future tombstone checks
      } else {
        duplicatesSkipped++;
      }
    }
  }

  // 3. Tombstones for disappearing shop-weeks: build set of keys already on
  // the sheet with presence='present' for weeks in this payload, but missing
  // from the incoming payload.
  var tombstones = [];
  if (Object.keys(weeksInPayload).length > 0) {
    for (var existingKey in latestIndex) {
      if (!Object.prototype.hasOwnProperty.call(latestIndex, existingKey)) continue;

      var existingRow = latestIndex[existingKey];
      var existingWeek = existingRow[1]; // week_label
      var existingPresence = existingRow[13]; // presence

      // Only tombstone if: (a) week is in this payload, (b) presence is
      // 'present', and (c) key is absent from incoming.
      if (weeksInPayload[existingWeek] && existingPresence === 'present' && !incomingKeys[existingKey]) {
        // Build tombstone row: same shop_id/week_label/week_start/week_end,
        // zeros for figures, presence='absent', current fetched_at.
        var tombstone = [];
        for (var c = 0; c < SHOPSPEND_HEADERS.length; c++) {
          if (c === 0 || c === 1 || c === 2 || c === 3) {
            // shop_id, week_label, week_start, week_end
            tombstone.push(existingRow[c]);
          } else if (c >= 4 && c <= 8) {
            // order_count, amended_count, total_ex_gst, gst, total_inc_gst
            tombstone.push(0);
          } else if (c === 9) {
            // gst_treatment
            tombstone.push(existingRow[c]);
          } else if (c === 10) {
            // environment
            tombstone.push(existingRow[c]);
          } else if (c === 11) {
            // fetched_at (current time)
            tombstone.push(normalizedRows[0][c]); // use fetched_at from first incoming row
          } else if (c === 12) {
            // source
            tombstone.push(source);
          } else if (c === 13) {
            // presence
            tombstone.push('absent');
          } else {
            tombstone.push(existingRow[c]);
          }
        }
        tombstones.push(tombstone);
      }
    }
  }

  // 4. Block write: collect all rows to append and write once.
  var block = toAppend.concat(tombstones);
  if (block.length > 0) {
    var lastRow = sheet.getLastRow();
    sheet.getRange(lastRow + 1, 1, block.length, SHOPSPEND_HEADERS.length).setValues(block);
  }

  // Write ShopSpendPulls row as commit marker.
  if (pull) {
    appendNewRows_(pullsSheet, [normalizePullMetadataRow_(pull)]);
  }

  return {
    rowsAdded: toAppend.length + tombstones.length,
    rowsUpdated: 0,
    duplicatesSkipped: duplicatesSkipped
  };
}
