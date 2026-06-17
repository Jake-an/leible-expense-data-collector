/**
 * myers.gs — Myers (chocolate) email-invoice connector → Suppliers tab.
 *
 * GmailApp searches for Myers invoice emails, parses date / total / invoice_ref,
 * normalizes via Code.gs normalizeSupplierRow(..., 'myers'), and appends to
 * Suppliers (dedup source+invoice_ref). Processed threads are labelled so they
 * aren't re-ingested; dedup is the backstop.
 *
 * parseMyersInvoice_ is pure and unit-tested in connectors/gas/test_code.js.
 *
 * NOTE: the parser regexes are first-pass and MUST be tuned against a real Myers
 * invoice email (see TODO(tune-parser) below) before the live trigger is trusted.
 */

var MYERS_LABEL = 'expense-ingested';
// Restrict to Myers invoices not yet ingested. Tune the from:/subject: terms to
// the real Myers sender once a sample is in hand.
var MYERS_SEARCH = 'from:(myers) subject:(invoice) newer_than:60d -label:' + MYERS_LABEL;
var MYERS_TZ = 'Australia/Sydney';

/**
 * Pull unprocessed Myers invoice emails into the Suppliers tab.
 * @returns {{rowsAdded:number, duplicatesSkipped:number, threadsProcessed:number, unparsed:number}}
 */
function myersDailyPull() {
  var label = getOrCreateLabel_(MYERS_LABEL);
  var threads = GmailApp.search(MYERS_SEARCH);
  var extractedAt = Utilities.formatDate(new Date(), MYERS_TZ, "yyyy-MM-dd'T'HH:mm:ssXXX");

  var rows = [];
  var unparsed = 0;

  for (var t = 0; t < threads.length; t++) {
    var messages = threads[t].getMessages();
    for (var m = 0; m < messages.length; m++) {
      var msg = messages[m];
      var parsed = parseMyersInvoice_(
        msg.getSubject() || '',
        msg.getPlainBody() || '',
        Utilities.formatDate(msg.getDate(), MYERS_TZ, 'yyyy-MM-dd')
      );
      if (parsed) rows.push(parsed);
      else unparsed++;
    }
  }

  var sheet = ensureSheet(getHubSpreadsheet_(), SUPPLIERS_TAB, SUPPLIERS_HEADERS);
  var res = ingestSupplierRows('myers', rows, extractedAt, sheet);

  for (var i = 0; i < threads.length; i++) threads[i].addLabel(label);

  Logger.log('myersDailyPull: ' + res.rowsAdded + ' added, ' + res.duplicatesSkipped +
    ' dup, ' + unparsed + ' unparsed, ' + threads.length + ' threads');
  return {
    rowsAdded: res.rowsAdded,
    duplicatesSkipped: res.duplicatesSkipped,
    threadsProcessed: threads.length,
    unparsed: unparsed
  };
}

/** Install a daily trigger for myersDailyPull. Idempotent. */
function installMyersTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'myersDailyPull') ScriptApp.deleteTrigger(triggers[i]);
  }
  ScriptApp.newTrigger('myersDailyPull').timeBased().atHour(6).everyDays(1).inTimezone(MYERS_TZ).create();
  Logger.log('installMyersTrigger: daily 6am ' + MYERS_TZ + ' trigger installed');
}

/* ------------------------------------------------------------------ *
 * Pure parsing (unit-tested) — TODO(tune-parser) against a real Myers email
 * ------------------------------------------------------------------ */

/**
 * Extract { date, total, invoice_ref } from a Myers invoice email.
 * @param {string} subject
 * @param {string} body — plain-text body
 * @param {string} receivedDate — 'YYYY-MM-DD' fallback if no date in the text
 * @returns {Object|null} row, or null if total or invoice_ref can't be found
 */
function parseMyersInvoice_(subject, body, receivedDate) {
  var text = (subject || '') + '\n' + (body || '');

  var refMatch = text.match(/invoice\s*(?:no\.?|number|#)?\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-\/]{2,})/i);
  var totalMatch = text.match(/(?:total|amount\s*due|grand\s*total)\s*[:\-]?\s*\$?\s*([\d,]+\.\d{2})/i);
  var dateMatch = text.match(/(\d{4}-\d{2}-\d{2})/) ||
                  text.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);

  if (!refMatch || !totalMatch) return null; // can't dedup or value it — leave for manual review

  return {
    date: dateMatch ? normalizeMyersDate_(dateMatch[1], receivedDate) : receivedDate,
    total: Number(totalMatch[1].replace(/,/g, '')),
    invoice_ref: refMatch[1]
  };
}

/** Normalize a matched date token to YYYY-MM-DD; assumes DD/MM/YYYY (Australian). */
function normalizeMyersDate_(token, fallback) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(token)) return token;
  var parts = token.split('/');
  if (parts.length === 3) {
    var d = parts[0].length === 1 ? '0' + parts[0] : parts[0];
    var mo = parts[1].length === 1 ? '0' + parts[1] : parts[1];
    var y = parts[2].length === 2 ? '20' + parts[2] : parts[2];
    return y + '-' + mo + '-' + d;
  }
  return fallback;
}

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}
