/**
 * mayers.gs — Mayers (chocolate) PDF-invoice connector → Suppliers tab.
 *
 * Invoices from F.Mayer Imports (mayers.com.au) arrive as PDF attachments,
 * forwarded from jake@leiblecoffee.com.au to mio.jake+mayers@gmail.com.
 * The connector: finds unprocessed emails via deliveredto: plus-alias match,
 * extracts PDF text via Drive OCR, parses date/total/invoice_ref, normalizes
 * via Code.gs normalizeSupplierRow(..., 'mayers'), and appends to Suppliers
 * (dedup source+invoice_ref). Processed threads are labelled so they aren't
 * re-ingested; dedup is the backstop.
 *
 * parseMayersInvoice_ is pure and unit-tested in connectors/gas/test_code.js.
 */

var MAYERS_LABEL = 'expense-ingested';
var MAYERS_SEARCH = 'deliveredto:(mio.jake+mayers@gmail.com) has:attachment -label:' + MAYERS_LABEL;
var MAYERS_TZ = 'Australia/Sydney';

/* --- Permanently-unparseable attachment memo -----------------------
 * A thread is only labelled once something parsed out of it (see mayersDailyPull),
 * so a document that can NEVER parse stays unlabelled, keeps matching
 * MAYERS_SEARCH, and is re-OCR'd every single day forever. Measured 2026-08-15:
 * 8 threads match the search, `expense-ingested` covers 7 — the eighth is the
 * monthly "Mayer's Fine Food statement", which is not an invoice and never will
 * parse. Drive OCR is the expensive, rate-limited step in this connector, so
 * that is a standing quota leak (and the likely cause of the rate-limiting that
 * truncated the 2026-08-14 OCR harvest).
 *
 * The memo remembers which attachments already came back unparseable and skips
 * the OCR for them. Deliberately NOT a Gmail label on the thread: the thread must
 * stay unlabelled so a NEW attachment added to it is still processed.
 */
var MAYERS_UNPARSEABLE_PROP = 'MAYERS_UNPARSEABLE';

/* Bump whenever parseMayersInvoice_ or the regexes it uses change. The memo
 * records "this text does not parse UNDER THIS PARSER", so a version bump
 * discards the whole memo and every remembered document is retried exactly once
 * against the new parser. That is what preserves the original "unparseable
 * threads stay unlabelled so they're retried after a fix" intent. */
var MAYERS_PARSER_VERSION = 1;

/* Runaway guard, not a working limit — real growth is ~1 statement/month.
 * Oldest entries are evicted first. */
var MAYERS_UNPARSEABLE_MAX_ = 200;

var MONTH_MAP_ = {
  'JAN': '01', 'FEB': '02', 'MAR': '03', 'APR': '04', 'MAY': '05', 'JUN': '06',
  'JUL': '07', 'AUG': '08', 'SEP': '09', 'OCT': '10', 'NOV': '11', 'DEC': '12'
};

var MAYERS_SHOP_RULES_ = [
  { re: /\bYORK\s*ST/i,                 shop: 'Leible York' },
  { re: /\bPITT\s*ST/i,                 shop: 'Leible Pitt' },
  { re: /\bBLUE\s*ST/i,                 shop: 'Leible North' },
  { re: /\bBURLINGTON|\bCROWS\s*NEST/i, shop: 'Leible Crowsnest' }
];

/* ------------------------------------------------------------------ *
 * Entry points
 * ------------------------------------------------------------------ */

/**
 * Pull unprocessed Mayers invoice emails into the Suppliers tab.
 * @returns {{rowsAdded:number, duplicatesSkipped:number, threadsProcessed:number, unparsed:number}}
 */
function mayersDailyPull() {
  var label = getOrCreateLabel_(MAYERS_LABEL);
  var threads = GmailApp.search(MAYERS_SEARCH);
  var extractedAt = Utilities.formatDate(new Date(), MAYERS_TZ, "yyyy-MM-dd'T'HH:mm:ssXXX");

  var rows = [];
  var unparsed = 0;
  var seenAttachments = {}; // PDF name → true; one OCR per unique invoice per run

  var unparseable = mayersLoadUnparseable_();
  var unparseableDirty = false;
  var ocrSkipped = 0;

  for (var t = 0; t < threads.length; t++) {
    var messages = threads[t].getMessages();
    var threadParsed = 0;
    for (var m = 0; m < messages.length; m++) {
      var msg = messages[m];
      var pdf = firstPdfAttachment_(msg);
      if (!pdf) continue; // no PDF on this message (e.g. inline image only)
      if (seenAttachments[pdf.getName()]) continue; // same invoice already handled this run
      seenAttachments[pdf.getName()] = true;

      // Known-unparseable under this parser version: skip the OCR, not the thread.
      var memoKey = mayersAttachmentKey_(pdf);
      if (unparseable[memoKey]) { ocrSkipped++; continue; }

      var fallbackDate = Utilities.formatDate(msg.getDate(), MAYERS_TZ, 'yyyy-MM-dd');
      var attempt = extractMayersInvoiceFromPdf_(pdf, fallbackDate);
      if (attempt.parsed) { rows.push(attempt.parsed); threadParsed++; }
      else {
        unparsed++;
        // Only a DETERMINISTIC failure earns a memo entry. A failed OCR is
        // transient (rate limit / Drive hiccup) — memoing it would permanently
        // discard a real invoice on a bad day.
        if (attempt.deterministic) {
          unparseable[memoKey] = Date.now();
          unparseableDirty = true;
        }
      }
    }
    // Only mark a thread done once we got data out of it; failed/unparseable
    // threads stay unlabelled so they're retried after a fix (dedup is the backstop).
    if (threadParsed > 0) threads[t].addLabel(label);
  }

  if (unparseableDirty) mayersSaveUnparseable_(unparseable);

  var sheet = ensureSheet(getHubSpreadsheet_(), SUPPLIERS_TAB, SUPPLIERS_HEADERS);
  var res = ingestSupplierRows('mayers', rows, extractedAt, sheet);

  Logger.log('mayersDailyPull: ' + res.rowsAdded + ' added, ' + res.duplicatesSkipped +
    ' dup, ' + unparsed + ' unparsed, ' + ocrSkipped + ' ocr-skipped, ' +
    threads.length + ' threads');

  // Stamp even when no invoice arrived: for Mayers a quiet day is normal
  // (no delivery ≠ broken), and GmailApp.search returning nothing is still a
  // successful run. Unlike Square there is no credential that can silently
  // revoke and fake success — a broken GmailApp scope throws instead.
  stalenessStampHeartbeat_('mayers');

  return {
    rowsAdded: res.rowsAdded,
    duplicatesSkipped: res.duplicatesSkipped,
    threadsProcessed: threads.length,
    unparsed: unparsed,
    ocrSkipped: ocrSkipped
  };
}

/* ------------------------------------------------------------------ *
 * Unparseable-attachment memo
 * ------------------------------------------------------------------ */

/**
 * Stable identity for an invoice attachment. Name alone is not enough — Mayers
 * reuses generic attachment names — so pair it with the byte size.
 * @param {GoogleAppsScript.Gmail.GmailAttachment} pdf
 * @returns {string}
 */
function mayersAttachmentKey_(pdf) {
  return pdf.getName() + ':' + pdf.getSize();
}

/**
 * Attachment keys known to fail parsing under the CURRENT parser version.
 * A version mismatch, absent property, or corrupt JSON all yield {} — i.e. the
 * safe direction, "we remember nothing, so OCR everything once".
 * @returns {Object<string, number>} key → epoch ms first memoed
 */
function mayersLoadUnparseable_() {
  var raw = PropertiesService.getScriptProperties().getProperty(MAYERS_UNPARSEABLE_PROP);
  if (!raw) return {};
  var memo;
  try {
    memo = JSON.parse(raw);
  } catch (err) {
    Logger.log('mayersLoadUnparseable_: corrupt memo discarded — ' + err.message);
    return {};
  }
  if (!memo || memo.version !== MAYERS_PARSER_VERSION) return {};
  return memo.keys || {};
}

/**
 * Persist the memo, evicting oldest entries beyond MAYERS_UNPARSEABLE_MAX_.
 * @param {Object<string, number>} keys
 */
function mayersSaveUnparseable_(keys) {
  var names = Object.keys(keys);
  if (names.length > MAYERS_UNPARSEABLE_MAX_) {
    names.sort(function (a, b) { return keys[a] - keys[b]; }); // oldest first
    var trimmed = {};
    for (var i = names.length - MAYERS_UNPARSEABLE_MAX_; i < names.length; i++) {
      trimmed[names[i]] = keys[names[i]];
    }
    keys = trimmed;
  }
  PropertiesService.getScriptProperties().setProperty(
    MAYERS_UNPARSEABLE_PROP,
    JSON.stringify({ version: MAYERS_PARSER_VERSION, keys: keys })
  );
}

/**
 * Forget the memo so every attachment is OCR'd again on the next run.
 * Zero-arg: the editor Run button passes no arguments.
 */
function resetMayersUnparseableMemo() {
  PropertiesService.getScriptProperties().deleteProperty(MAYERS_UNPARSEABLE_PROP);
  Logger.log('resetMayersUnparseableMemo: memo cleared — next run re-OCRs everything');
}

/** Install a daily trigger for mayersDailyPull. Idempotent. */
function installMayersTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'mayersDailyPull') ScriptApp.deleteTrigger(triggers[i]);
  }
  ScriptApp.newTrigger('mayersDailyPull').timeBased().atHour(6).everyDays(1).inTimezone(MAYERS_TZ).create();
  Logger.log('installMayersTrigger: daily 6am ' + MAYERS_TZ + ' trigger installed');
}

/* ------------------------------------------------------------------ *
 * Live I/O — PDF extraction (NOT unit-tested; see step3.md)
 * ------------------------------------------------------------------ */

/** @returns {GoogleAppsScript.Gmail.GmailAttachment|null} first application/pdf attachment */
function firstPdfAttachment_(msg) {
  var attachments = msg.getAttachments();
  for (var i = 0; i < attachments.length; i++) {
    if (attachments[i].getContentType() === 'application/pdf') return attachments[i];
  }
  return null;
}

/**
 * Extract invoice data from a PDF attachment.
 *
 * Returns the failure MODE alongside the result, because the two failures are
 * not equivalent: OCR falling over is transient and must be retried, whereas
 * text that OCR'd fine and still didn't parse will never parse under this
 * parser. Only the latter may be memoed (see mayersLoadUnparseable_).
 *
 * @param {GoogleAppsScript.Gmail.GmailAttachment} pdfBlob
 * @param {string} fallbackDate — 'YYYY-MM-DD'
 * @returns {{parsed: Object|null, deterministic: boolean}}
 *   parsed — { date, total, invoice_ref, location } or null
 *   deterministic — true if OCR succeeded (so a null parse is reproducible);
 *                   false if OCR itself threw.
 */
function extractMayersInvoiceFromPdf_(pdfBlob, fallbackDate) {
  var text = null;
  try {
    text = extractPdfText_(pdfBlob);
  } catch (err) {
    Logger.log('extractMayersInvoiceFromPdf_: PDF extraction failed — ' + err.message);
    return { parsed: null, deterministic: false };
  }
  return { parsed: parseMayersInvoice_(text, fallbackDate), deterministic: true };
}

/**
 * Convert a PDF blob to plain text via Drive OCR (temp Google Doc, trashed after).
 * Retries once on Drive's transient "rate limit exceeded for OCR" throttle.
 * @param {GoogleAppsScript.Base.Blob} pdfBlob
 * @returns {string}
 */
function extractPdfText_(pdfBlob) {
  var fileId = null;
  try {
    // Insert the PDF with ocr:true — Drive OCRs it and returns a Google Doc whose
    // id DocumentApp can read. The resource mimeType must be the SOURCE type
    // (application/pdf); declaring it as a Google Doc makes Drive reject OCR.
    var resource = { title: 'TempMayers_' + new Date().getTime(), mimeType: pdfBlob.getContentType() };
    var opts = { ocr: true, ocrLanguage: 'en' };
    var docMeta;
    try {
      docMeta = Drive.Files.insert(resource, pdfBlob, opts);
    } catch (rateErr) {
      if (String(rateErr.message || '').indexOf('rate limit') === -1) throw rateErr;
      Logger.log('extractPdfText_: OCR rate-limited, waiting 20s then retrying once');
      Utilities.sleep(20000);
      docMeta = Drive.Files.insert(resource, pdfBlob, opts);
    }
    fileId = docMeta.id;
    return DocumentApp.openById(fileId).getBody().getText();
  } finally {
    if (fileId) {
      try { DriveApp.getFileById(fileId).setTrashed(true); }
      catch (e) { Logger.log('extractPdfText_: orphaned temp doc ' + fileId + ' — ' + e.message); }
    }
  }
}

/* ------------------------------------------------------------------ *
 * Pure parsing (unit-tested)
 * ------------------------------------------------------------------ */

/**
 * Extract { date, total, invoice_ref, location } from Mayers invoice text.
 * @param {string} text — extracted/linearized PDF text
 * @param {string} fallbackDate — 'YYYY-MM-DD' if no date in text
 * @returns {Object|null} or null if ref or total can't be found
 */
function parseMayersInvoice_(text, fallbackDate) {
  var refMatch = text.match(/Invoice\s+(?:No\.?|Number|#)?\s*[:\-]?\s*([0-9]{6,8})/i);
  var totalMatch = text.match(/(?:^|\s)Total\s*[:\-]?\s*\$?\s*([0-9][\d,]*\.\d{2})/m);
  var dateMatch = text.match(/Invoice\s+Date[:\-]?\s*(\d{1,2})\-([A-Z]{3})\-(\d{2})/i);

  if (!refMatch || !totalMatch) return null;

  var date = fallbackDate;
  if (dateMatch) {
    var parsed = parseMayersDate_(dateMatch[1], dateMatch[2], dateMatch[3]);
    if (parsed) date = parsed;
  }

  return {
    date: date,
    total: Number(totalMatch[1].replace(/,/g, '')),
    invoice_ref: refMatch[1],
    location: mayersShopFromText_(text)
  };
}

function mayersShopFromText_(text) {
  for (var i = 0; i < MAYERS_SHOP_RULES_.length; i++) {
    if (MAYERS_SHOP_RULES_[i].re.test(text)) return MAYERS_SHOP_RULES_[i].shop;
  }
  var deliv = text.match(/Deliver\s*To[:\s]*([\s\S]{0,120})/i);
  var hint = deliv ? deliv[1].replace(/\s+/g, ' ').trim().slice(0, 60) : '';
  return hint ? 'UNMAPPED: ' + hint : '';
}

/**
 * Convert DD-MMM-YY components to YYYY-MM-DD.
 * @returns {string|null}
 */
function parseMayersDate_(dayStr, monthStr, yearStr) {
  var month = MONTH_MAP_[monthStr.toUpperCase()];
  if (!month) return null;
  var day = dayStr.length === 1 ? '0' + dayStr : dayStr;
  var year = (parseInt(yearStr, 10) >= 70) ? '19' + yearStr : '20' + yearStr;
  return year + '-' + month + '-' + day;
}

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}
