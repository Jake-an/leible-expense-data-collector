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

/* ------------------------------------------------------------------ *
 * Report builder (step 6) — rebuilt in place from the snapshot store.
 * See docs/schema.md "Tab `ShopSpend Report`" for the full banner spec.
 * ------------------------------------------------------------------ */

/**
 * Parse a 'YYYY-Www' label (1 or 2 digit week number) for numeric sort.
 * Never sort week labels lexicographically — '2026-W10' < '2026-W9' as
 * strings, which is wrong.
 */
function parseShopSpendWeekLabel_(label) {
  var m = /^(\d{4})-W(\d{1,2})$/.exec(String(label));
  if (!m) return { year: 0, week: 0 };
  return { year: Number(m[1]), week: Number(m[2]) };
}

function compareShopSpendWeekLabels_(a, b) {
  var pa = parseShopSpendWeekLabel_(a);
  var pb = parseShopSpendWeekLabel_(b);
  if (pa.year !== pb.year) return pa.year - pb.year;
  return pa.week - pb.week;
}

function safeJsonArray_(v) {
  try {
    var parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

/** Render one grid cell from its latest snapshot row (or undefined). */
function shopSpendReportCell_(latestRow, pullUnpricedSkuCount, pullEmptyRangeInvalid) {
  if (!latestRow) {
    return pullEmptyRangeInvalid ? 'unconfirmed' : '';
  }
  if (latestRow[13] === 'absent') return 'stale'; // presence
  var cell = (pullUnpricedSkuCount > 0 ? '~' : '') + latestRow[8]; // total_inc_gst
  if (Number(latestRow[5]) > 0) cell += ' amended'; // amended_count
  return cell;
}

/**
 * Pure: (snapshotRows, latestPullRow) -> 2D array ready for a single
 * setValues(). snapshotRows is the ShopSpend data range with the header
 * row excluded, in append order. latestPullRow is the single most-recent
 * ShopSpendPulls row (SHOPSPEND_PULLS_HEADERS order).
 */
function shopSpendReportBlock_(snapshotRows, latestPullRow) {
  var pull = latestPullRow || [];

  // Latest-snapshot index: (shop_id, week_label) -> row. Overwriting on
  // every iteration means the LAST row in append order always wins — never
  // resolved by comparing fetched_at (see docs/schema.md DST rule).
  var latestIndex = {};
  var shopOrder = [];
  var weekSet = {};
  for (var i = 0; i < snapshotRows.length; i++) {
    var row = snapshotRows[i];
    var shopId = row[0];
    var weekLabel = row[1];
    var key = shopId + '||' + weekLabel;
    latestIndex[key] = row;
    weekSet[weekLabel] = true;
    if (shopOrder.indexOf(shopId) === -1) shopOrder.push(shopId);
  }

  var weeks = Object.keys(weekSet).sort(compareShopSpendWeekLabels_);

  var pullUnpricedSkuCount = Number(pull[9]) || 0; // unpriced_sku_count
  var pullEmptyRangeInvalid = pull[13] === true; // empty_range_with_invalid_labels
  var pullGstTreatment = pull[15]; // gst_treatment
  var pullDivergesFromLivePricing = pull[16] === true; // diverges_from_live_pricing
  var pullFetchedAt = pull[0]; // fetched_at
  var pullWarnings = safeJsonArray_(pull[8]); // warnings
  var pullDuplicateShopNames = safeJsonArray_(pull[12]); // possible_duplicate_shop_names

  var amendedShopWeekCount = 0;
  var absentShopWeekCount = 0;
  for (var k in latestIndex) {
    if (!Object.prototype.hasOwnProperty.call(latestIndex, k)) continue;
    var latestRow = latestIndex[k];
    if (Number(latestRow[5]) > 0) amendedShopWeekCount++; // amended_count
    if (latestRow[13] === 'absent') absentShopWeekCount++; // presence
  }

  var banners = [];

  for (var w = 0; w < pullWarnings.length; w++) {
    banners.push(['⚠ WARNING: ' + pullWarnings[w]]);
  }

  if (pullUnpricedSkuCount > 0) {
    banners.push(['⚠ TOTALS ARE APPROXIMATE — ' + pullUnpricedSkuCount +
      ' SKUs unpriced; those line items were skipped entirely.']);
  }

  if (amendedShopWeekCount > 0) {
    banners.push([amendedShopWeekCount +
      ' shop-weeks contain amended orders — provisional, may change.']);
  }

  if (pullDuplicateShopNames.length > 0) {
    banners.push(['Possible duplicate shop names — fix upstream. NOT merged automatically: ' +
      pullDuplicateShopNames.join(', ')]);
  }

  if (pullEmptyRangeInvalid) {
    banners.push(['Empty range with invalid week labels — affected cells show "unconfirmed", never a zero total.']);
  }

  if (absentShopWeekCount > 0) {
    banners.push([absentShopWeekCount +
      ' shop-weeks present in a prior pull are absent from the latest pull — values shown are stale.']);
  }

  banners.push(['GST treatment: ' + pullGstTreatment +
    ' (gst: 0 is normal — many coffee SKUs are GST-free).']);
  // "Drift", never "stale pricing" — divergesFromLivePricing counts ordinary
  // post-invoice price changes too, so it is a drift signal, not provenance.
  banners.push(['Pricing drift vs current live pricing: ' +
    (pullDivergesFromLivePricing ? 'diverges' : 'matches') + '.']);
  banners.push(['Confirmed orders only; excludes Shopify/online shops. Last fetched: ' + pullFetchedAt]);

  var header = ['Shop'].concat(weeks);
  var grid = [header];
  for (var s = 0; s < shopOrder.length; s++) {
    var gridShopId = shopOrder[s];
    var gridRow = [gridShopId];
    for (var wi = 0; wi < weeks.length; wi++) {
      var cellKey = gridShopId + '||' + weeks[wi];
      gridRow.push(shopSpendReportCell_(latestIndex[cellKey], pullUnpricedSkuCount, pullEmptyRangeInvalid));
    }
    grid.push(gridRow);
  }

  // Rectangular block: pad every banner row to the grid width so a single
  // setValues() call is valid.
  var maxCols = header.length;
  var paddedBanners = banners.map(function (bannerRow) {
    var padded = bannerRow.slice();
    while (padded.length < maxCols) padded.push('');
    return padded;
  });

  return paddedBanners.concat(grid);
}

function buildShopSpendReport_impl_() {
  var ss = getHubSpreadsheet_();
  var tabs = ensureShopSpendTabs_(ss);

  var snapshotRows = tabs.data.getDataRange().getValues().slice(1); // drop header
  var pullsValues = tabs.pulls.getDataRange().getValues();
  var latestPullRow = pullsValues.length > 1 ? pullsValues[pullsValues.length - 1] : [];

  var block = shopSpendReportBlock_(snapshotRows, latestPullRow);

  // Read-modify-write, never a per-row write: a run that dies mid-rebuild
  // must not leave a visibly half-broken report.
  tabs.report.clearContents();
  if (block.length > 0) {
    tabs.report.getRange(1, 1, block.length, block[0].length).setValues(block);
  }

  return { rowsWritten: block.length };
}

/**
 * Entry point — wraps the rebuild in withScriptLock_, mirroring
 * weeklySummarize (Code.gs:1595-1606). Zero-arg safe. Never mutates
 * ShopSpend or ShopSpendPulls — read-only inputs to this report.
 */
function buildShopSpendReport() {
  var res = withScriptLock_(buildShopSpendReport_impl_);
  if (res === LOCK_TIMEOUT_) {
    Logger.log('buildShopSpendReport: could not acquire script lock — skipped this run');
    return { refused: 'locked' };
  }
  return res;
}
