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

/* --- Permanently-unparseable attachment memo -----------------------
 * Ported from mayers.gs (fixed there 2026-08-15, latent here until now).
 * A thread is only labelled once something parsed out of it (see
 * roasteryDailyPull_impl_), so a document that can NEVER parse stays
 * unlabelled, keeps matching ROASTERY_SEARCH, and is re-OCR'd every run
 * forever. Drive OCR is the expensive, rate-limited step, so that is a
 * standing quota leak the moment this feed goes live with any non-invoice
 * attachment (a statement, a price list, a signed credit application).
 *
 * The memo remembers which attachments already came back unparseable and
 * skips the OCR for them. Deliberately NOT a Gmail label on the thread: the
 * thread must stay unlabelled so a NEW attachment added to it is still
 * processed.
 */
var ROASTERY_UNPARSEABLE_PROP = 'ROASTERY_UNPARSEABLE';

/* Bump whenever parseRoasteryInvoice_ or the regexes it uses change. The memo
 * records "this text does not parse UNDER THIS PARSER", so a version bump
 * discards the whole memo and every remembered document is retried exactly
 * once against the new parser. That is what preserves the original
 * "unparseable threads stay unlabelled so they're retried after a fix" intent.
 * Start at 1: the Sample Bean Co parser is the first shipped version, and the
 * real first-vendor parser will bump it. */
var ROASTERY_PARSER_VERSION = 1;

/* Runaway guard, not a working limit. Oldest entries are evicted first —
 * guards the 9KB Script-Properties value limit. */
var ROASTERY_UNPARSEABLE_MAX_ = 200;

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
    return { rowsAdded: 0, duplicatesSkipped: 0, threadsProcessed: 0, unparsed: 0, ocrSkipped: 0, locked: true };
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

  var unparseable = roasteryLoadUnparseable_();
  var unparseableDirty = false;
  var ocrSkipped = 0;

  for (var t = 0; t < threads.length; t++) {
    var messages = threads[t].getMessages();
    var threadParsed = 0;
    for (var m = 0; m < messages.length; m++) {
      var msg = messages[m];
      var pdf = firstPdfAttachment_(msg);
      if (!pdf) continue; // no PDF on this message
      if (seenAttachments[pdf.getName()]) continue; // same invoice already handled this run
      seenAttachments[pdf.getName()] = true;

      // Known-unparseable under this parser version: skip the OCR, not the
      // thread. The thread stays unlabelled either way.
      var memoKey = roasteryAttachmentKey_(pdf);
      if (unparseable[memoKey]) { ocrSkipped++; continue; }

      var fallbackDate = Utilities.formatDate(msg.getDate(), ROASTERY_TZ, 'yyyy-MM-dd');
      var attempt = extractRoasteryInvoiceFromPdf_(pdf, fallbackDate);
      if (attempt.parsed) {
        attempt.parsed.invoice_ref = attempt.parsed.invoice_ref || msg.getId();
        rows.push(attempt.parsed);
        threadParsed++;
      } else {
        // LOUD, not silent — this is exactly the failure mode
        // fix-silent-ingest-failures exists to close (see phases/
        // fix-silent-ingest-failures/). Log with enough detail to act on, and
        // leave the thread WITHOUT the processed label so it's retried on
        // every run until the parser is fixed or the invoice is handled by
        // hand; dedup on invoice_ref (or message id) makes a later
        // successful parse safe to re-ingest.
        Logger.log('roasteryDailyPull: UNPARSEABLE attachment "' + pdf.getName() +
          '" in thread ' + threads[t].getId() + ', message ' + msg.getId() + ' — ' + attempt.error);
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
    // Only mark a thread done once we got data out of it — failed/unparseable
    // threads stay unlabelled so they're retried after a fix.
    if (threadParsed > 0) threads[t].addLabel(label);
  }

  if (unparseableDirty) roasterySaveUnparseable_(unparseable);

  var sheet = ensureSheet(getHubSpreadsheet_(), SUPPLIERS_TAB, SUPPLIERS_HEADERS);
  var res = ingestSupplierRows('roastery', rows, extractedAt, sheet);

  Logger.log('roasteryDailyPull: ' + res.rowsAdded + ' added, ' + res.duplicatesSkipped +
    ' dup, ' + unparsed + ' unparsed, ' + ocrSkipped + ' ocr-skipped, ' +
    threads.length + ' threads');

  // Heartbeat gate mirrors square.gs's sitesOk pattern, NOT mayers's
  // always-stamp: mayers can always stamp because GmailApp.search returning
  // nothing is a normal quiet day for one high-volume vendor. Here, threads
  // can be non-empty while EVERY attachment fails to parse — that is a real
  // failure, not a quiet day, so it must not look healthy to the staleness
  // watchdog. ('roastery' is NOT YET in STALENESS_SOURCES — the feed is unarmed
  // (no Gmail label, no trigger, one synthetic parser), so a withheld heartbeat
  // raises NO alert today. This gate is pre-staged for the re-add; the exact
  // re-add condition is in the NOT YET ARMED block in staleness.gs.)
  if (threads.length === 0 || res.rowsAdded > 0 || res.duplicatesSkipped > 0) {
    stalenessStampHeartbeat_('roastery');
  } else {
    Logger.log('roasteryDailyPull: threads present but nothing ingested (' + unparsed +
      ' unparsed) — NOT stamping heartbeat, so staleness will alert');
  }

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
 * OCR a PDF and parse it, separating a TRANSIENT extraction failure from a
 * DETERMINISTIC parse failure. Only the latter may be memoed — memoing a Drive
 * rate-limit would permanently discard a real invoice on a bad day.
 *
 * parseRoasteryInvoice_ RAISES rather than returning null (see its docstring),
 * so both arms are try/catch here; the distinction is WHICH call threw.
 * @param {GoogleAppsScript.Gmail.GmailAttachment} pdfBlob
 * @param {string} fallbackDate — 'YYYY-MM-DD'
 * @returns {{parsed:?Object, deterministic:boolean, error:?string}}
 */
function extractRoasteryInvoiceFromPdf_(pdfBlob, fallbackDate) {
  var text = null;
  try {
    text = extractPdfText_(pdfBlob);
  } catch (err) {
    Logger.log('extractRoasteryInvoiceFromPdf_: PDF extraction failed — ' + err.message);
    return { parsed: null, deterministic: false, error: err.message };
  }
  try {
    return { parsed: parseRoasteryInvoice_(text, fallbackDate), deterministic: true, error: null };
  } catch (err) {
    return { parsed: null, deterministic: true, error: err.message };
  }
}

/**
 * Stable identity for an invoice attachment. Name alone is not enough — vendors
 * reuse generic attachment names ('invoice.pdf') — so pair it with the byte size.
 * @param {GoogleAppsScript.Gmail.GmailAttachment} pdf
 * @returns {string}
 */
function roasteryAttachmentKey_(pdf) {
  return pdf.getName() + ':' + pdf.getSize();
}

/**
 * Attachment keys known to fail parsing under the CURRENT parser version.
 * A version mismatch, absent property, or corrupt JSON all yield {} — i.e. the
 * safe direction, "we remember nothing, so OCR everything once".
 * @returns {Object<string, number>} key → epoch ms first memoed
 */
function roasteryLoadUnparseable_() {
  var raw = PropertiesService.getScriptProperties().getProperty(ROASTERY_UNPARSEABLE_PROP);
  if (!raw) return {};
  var memo;
  try {
    memo = JSON.parse(raw);
  } catch (err) {
    Logger.log('roasteryLoadUnparseable_: corrupt memo discarded — ' + err.message);
    return {};
  }
  if (!memo || memo.version !== ROASTERY_PARSER_VERSION) return {};
  return memo.keys || {};
}

/**
 * Persist the memo, evicting oldest entries beyond ROASTERY_UNPARSEABLE_MAX_.
 * @param {Object<string, number>} keys
 */
function roasterySaveUnparseable_(keys) {
  var names = Object.keys(keys);
  if (names.length > ROASTERY_UNPARSEABLE_MAX_) {
    names.sort(function (a, b) { return keys[a] - keys[b]; }); // oldest first
    var trimmed = {};
    for (var i = names.length - ROASTERY_UNPARSEABLE_MAX_; i < names.length; i++) {
      trimmed[names[i]] = keys[names[i]];
    }
    keys = trimmed;
  }
  PropertiesService.getScriptProperties().setProperty(
    ROASTERY_UNPARSEABLE_PROP,
    JSON.stringify({ version: ROASTERY_PARSER_VERSION, keys: keys })
  );
}

/**
 * Forget the memo so every attachment is OCR'd again on the next run.
 * Zero-arg: the editor Run button passes no arguments.
 */
function resetRoasteryUnparseableMemo() {
  PropertiesService.getScriptProperties().deleteProperty(ROASTERY_UNPARSEABLE_PROP);
  Logger.log('resetRoasteryUnparseableMemo: memo cleared — next run re-OCRs everything');
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
