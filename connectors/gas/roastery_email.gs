/**
 * roastery_email.gs — Gmail label + Drive OCR connector for Roastery-vendor
 * invoices that neither the coffee order app (Phase 4) nor the recurring
 * generator (Phase 3) already handles.
 *
 * Follows mayers.gs's pattern: Gmail label search → PDF attachment → Drive
 * OCR → parsed rows → ingestSupplierRows with department='Roastery'. Reuses
 * firstPdfAttachment_ / extractPdfText_ / getOrCreateLabel_ from mayers.gs —
 * same GAS project, no boundary crossed, no duplicate declarations.
 *
 * ONE vendor only, deliberately (see the plan's "resist a generic parser" —
 * a generic parser is the exact failure mode this phase guards against).
 * Start vendor: Sample Bean Co (see docs note — swap in the real first
 * roastery vendor's layout when Jake forwards a genuine invoice).
 *
 * parseRoasteryInvoice_ is pure and unit-tested in connectors/gas/test_code.js.
 * Unlike parseMayersInvoice_ (which returns null on a miss), this RAISES when
 * no total can be found — a deliberate departure matching the
 * fix-silent-ingest-failures precedent (phases/fix-silent-ingest-failures/):
 * a silently-returned null/empty here would mean an expense simply never
 * exists in the Suppliers tab, with nothing pointing at why. An invoice
 * number is not mandatory to parse successfully — the caller falls back to
 * the stable, always-present Gmail message id for invoice_ref.
 */

var ROASTERY_GMAIL_LABEL = 'roastery/invoices';
var ROASTERY_PROCESSED_LABEL = 'roastery-ingested';
var ROASTERY_SEARCH = 'label:' + ROASTERY_GMAIL_LABEL + ' has:attachment -label:' + ROASTERY_PROCESSED_LABEL;
var ROASTERY_TZ = 'Australia/Sydney';
var ROASTERY_DEPARTMENT = 'Roastery';

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

/**
 * Pull unprocessed Roastery invoice emails (label: roastery/invoices) into
 * the Suppliers tab, department='Roastery'. Not unit-tested (live Gmail/
 * Drive I/O) — same boundary as mayersDailyPull; parseRoasteryInvoice_ is
 * the pure, tested core.
 * @returns {{rowsAdded:number, duplicatesSkipped:number, threadsProcessed:number, unparsed:number}}
 */
function roasteryDailyPull() {
  var res = withScriptLock_(function () { return roasteryDailyPull_impl_(); });
  if (res === LOCK_TIMEOUT_) {
    Logger.log('roasteryDailyPull: could not acquire script lock — skipped this run');
    return { rowsAdded: 0, duplicatesSkipped: 0, threadsProcessed: 0, unparsed: 0, locked: true };
  }
  return res;
}

function roasteryDailyPull_impl_() {
  var label = getOrCreateLabel_(ROASTERY_PROCESSED_LABEL);
  var threads = GmailApp.search(ROASTERY_SEARCH);
  var extractedAt = Utilities.formatDate(new Date(), ROASTERY_TZ, "yyyy-MM-dd'T'HH:mm:ssXXX");

  var rows = [];
  var unparsed = 0;
  var seenAttachments = {}; // PDF name → true; one OCR per unique invoice per run

  for (var t = 0; t < threads.length; t++) {
    var messages = threads[t].getMessages();
    var threadParsed = 0;
    for (var m = 0; m < messages.length; m++) {
      var msg = messages[m];
      var pdf = firstPdfAttachment_(msg);
      if (!pdf) continue; // no PDF on this message
      if (seenAttachments[pdf.getName()]) continue; // same invoice already handled this run
      seenAttachments[pdf.getName()] = true;

      var fallbackDate = Utilities.formatDate(msg.getDate(), ROASTERY_TZ, 'yyyy-MM-dd');
      try {
        var text = extractPdfText_(pdf);
        var row = parseRoasteryInvoice_(text, fallbackDate);
        row.invoice_ref = row.invoice_ref || msg.getId();
        rows.push(row);
        threadParsed++;
      } catch (err) {
        // LOUD, not silent — this is exactly the failure mode
        // fix-silent-ingest-failures exists to close (see phases/
        // fix-silent-ingest-failures/). Log with enough detail to act on, and
        // leave the thread WITHOUT the processed label so it's retried on
        // every run until the parser is fixed or the invoice is handled by
        // hand; dedup on invoice_ref (or message id) makes a later
        // successful parse safe to re-ingest.
        Logger.log('roasteryDailyPull: UNPARSEABLE attachment "' + pdf.getName() +
          '" in thread ' + threads[t].getId() + ', message ' + msg.getId() + ' — ' + err.message);
        unparsed++;
      }
    }
    // Only mark a thread done once we got data out of it — failed/unparseable
    // threads stay unlabelled so they're retried after a fix.
    if (threadParsed > 0) threads[t].addLabel(label);
  }

  var sheet = ensureSheet(getHubSpreadsheet_(), SUPPLIERS_TAB, SUPPLIERS_HEADERS);
  var res = ingestSupplierRows('roastery', rows, extractedAt, sheet);

  Logger.log('roasteryDailyPull: ' + res.rowsAdded + ' added, ' + res.duplicatesSkipped +
    ' dup, ' + unparsed + ' unparsed, ' + threads.length + ' threads');

  // Heartbeat gate mirrors square.gs's sitesOk pattern, NOT mayers's
  // always-stamp: mayers can always stamp because GmailApp.search returning
  // nothing is a normal quiet day for one high-volume vendor. Here, threads
  // can be non-empty while EVERY attachment fails to parse — that is a real
  // failure, not a quiet day, so it must not look healthy to the staleness
  // watchdog. (Note: 'roastery' still needs adding to STALENESS_SOURCES in
  // staleness.gs — out of this phase's file scope; see the execution report.)
  if (threads.length === 0 || res.rowsAdded > 0 || res.duplicatesSkipped > 0) {
    stalenessStampHeartbeat_('roastery');
  } else {
    Logger.log('roasteryDailyPull: threads present but nothing ingested (' + unparsed +
      ' unparsed) — NOT stamping heartbeat, so staleness can alert once wired in');
  }

  return {
    rowsAdded: res.rowsAdded,
    duplicatesSkipped: res.duplicatesSkipped,
    threadsProcessed: threads.length,
    unparsed: unparsed
  };
}

/** Install a daily trigger for roasteryDailyPull. Idempotent. */
function installRoasteryTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'roasteryDailyPull') ScriptApp.deleteTrigger(triggers[i]);
  }
  ScriptApp.newTrigger('roasteryDailyPull').timeBased().atHour(6).everyDays(1).inTimezone(ROASTERY_TZ).create();
  Logger.log('installRoasteryTrigger: daily 6am ' + ROASTERY_TZ + ' trigger installed');
}

/* ------------------------------------------------------------------ *
 * Pure parsing (unit-tested) — ONE vendor: Sample Bean Co
 * ------------------------------------------------------------------ */

/**
 * Extract { date, total, invoice_ref, department } from a Sample Bean Co
 * invoice text. RAISES (does not return null/empty) when no total can be
 * found — an invoice with no readable amount cannot be recorded as an
 * expense, and a silent skip would mean it simply never exists.
 * @param {string} text — extracted/linearized PDF text
 * @param {string} fallbackDate — 'YYYY-MM-DD' used when no date is in the text
 * @returns {{date:string, total:number, invoice_ref:(string|null), department:string}}
 */
function parseRoasteryInvoice_(text, fallbackDate) {
  var totalMatch = text.match(/(?:^|\s)(?:Total\s*Due|Total)\s*[:\-]?\s*\$?\s*([0-9][\d,]*\.\d{2})/im);
  if (!totalMatch) {
    throw new Error('parseRoasteryInvoice_: no total found in text — cannot record an expense with no amount');
  }

  var refMatch = text.match(/Invoice\s*(?:No\.?|Number|#)\s*[:\-]?\s*([A-Z0-9\-]{2,20})/i);
  var dateMatch = text.match(/Invoice\s*Date\s*[:\-]?\s*(\d{4})-(\d{2})-(\d{2})/i);

  var date = fallbackDate;
  if (dateMatch) date = dateMatch[1] + '-' + dateMatch[2] + '-' + dateMatch[3];

  return {
    date: date,
    total: Number(totalMatch[1].replace(/,/g, '')),
    invoice_ref: refMatch ? refMatch[1] : null,
    department: ROASTERY_DEPARTMENT
  };
}
