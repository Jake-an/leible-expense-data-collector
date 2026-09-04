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
var MAYERS_PARSER_VERSION = 2;

/* Runaway guard, not a working limit — real growth is ~1 statement/month.
 * Oldest entries are evicted first. */
var MAYERS_UNPARSEABLE_MAX_ = 200;

var MONTH_MAP_ = {
  'JAN': '01', 'FEB': '02', 'MAR': '03', 'APR': '04', 'MAY': '05', 'JUN': '06',
  'JUL': '07', 'AUG': '08', 'SEP': '09', 'OCT': '10', 'NOV': '11', 'DEC': '12'
};

/* BLUES? is not a typo. Every real North Sydney invoice reads '5 BLUES ST'
 * (plural), and /\bBLUE\s*ST/i cannot match it: \bBLUE matches inside BLUES,
 * \s* matches empty, then ST is required where an S stands. That single
 * character misfiled $1,976.90 across three weeks. Jake, 2026-08-20:
 * "if you see 5 blue street it is north sydney invoice". */
var MAYERS_SHOP_RULES_ = [
  { re: /\bYORK\s*ST/i,                 shop: 'Leible York' },
  { re: /\bPITT\s*ST/i,                 shop: 'Leible Pitt' },
  { re: /\bBLUES?\s*ST/i,               shop: 'Leible North' },
  { re: /\bBURLINGTON|\bCROWS\s*NEST/i, shop: 'Leible Crowsnest' }
];

/* How much text after the 'Deliver To' marker counts as the delivery block.
 * 120 chars comfortably covers the name + street + suburb + state/postcode on
 * all four real invoices (measured 2026-08-20) and stops short of the next
 * field. It is also the window the stored UNMAPPED: hints were cut from, so
 * changing it changes hints that Phase 2's repair matches against. */
var MAYERS_DELIVER_TO_WINDOW_ = 120;

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

/**
 * Which Leible shop an invoice was delivered to.
 *
 * TWO-PASS. Pass 1 runs the rules against the 'Deliver To' block alone, so an
 * address sitting in the Bill-To block can never claim an invoice whose goods
 * went somewhere else. Pass 2 is byte-identical to the whole-text scan this
 * function has always done, so scoping can only ever REASSIGN a shop — it can
 * never return emptier than the single-pass version did. That is what makes
 * the change safe for Pitt and Crowsnest, whose invoices we have less evidence
 * for; the strict Deliver-To-only variant was rejected for exactly that reason
 * (docs/mayers-location-fix-decisions.md, decision 2).
 *
 * Reassignment is the point, not a side effect: MAYERS_SHOP_RULES_ tests North
 * before Crowsnest, so a whole-text scan of a Crows Nest delivery billed to the
 * North Sydney entity resolves to North. Pass 1 is the only thing that fixes
 * that, and no widening of the regexes could.
 *
 * @param {string} text — extracted/OCR'd invoice text
 * @returns {string} a Leible shop name, 'UNMAPPED: <hint>', or ''
 */
function mayersShopFromText_(text) {
  var block = mayersDeliverToBlock_(text);

  if (block) {
    var scoped = mayersMatchShopRules_(block);
    if (scoped) return scoped;
  }

  var whole = mayersMatchShopRules_(text);
  if (whole) return whole;

  var hint = block.replace(/\s+/g, ' ').trim().slice(0, 60);
  return hint ? 'UNMAPPED: ' + hint : '';
}

/**
 * The delivery-address block, or '' when the invoice has no 'Deliver To'
 * marker (monthly statements, and every invoice ingested before this field
 * was parsed at all).
 * @returns {string}
 */
function mayersDeliverToBlock_(text) {
  var m = text.match(
    new RegExp('Deliver\\s*To[:\\s]*([\\s\\S]{0,' + MAYERS_DELIVER_TO_WINDOW_ + '})', 'i'));
  return m ? m[1] : '';
}

/**
 * First shop rule that matches, or '' if none do. Kept separate so both passes
 * run the identical rule set in the identical order — the moment they diverge,
 * pass 2 stops being the safety net it is documented to be.
 * @returns {string}
 */
function mayersMatchShopRules_(text) {
  for (var i = 0; i < MAYERS_SHOP_RULES_.length; i++) {
    if (MAYERS_SHOP_RULES_[i].re.test(text)) return MAYERS_SHOP_RULES_[i].shop;
  }
  return '';
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

/* ==================================================================== *
 * Location repair (applied 2026-08-24) — RETAINED artifacts + rollback
 *
 * THE REPAIR IS DONE. Four Mayers rows carried a wrong `location`
 * ($2,713.64): three read `UNMAPPED: …5 BLUES ST…` because /\bBLUE\s*ST/i
 * cannot match the plural, and one was blank because it was ingested before
 * shop attribution existed. Applied and verified 2026-08-24 — Mayers span
 * total held at $5,127.89, North +$1,976.90, York +$736.74.
 *
 * connectors/gas/mayers_repair.gs performed it and has been DELETED. This
 * section deliberately stays, in the file that survives, because the repair
 * left two artifacts in production ON PURPOSE and they are still there:
 *
 *   - Summary_mayers_location_backup — the ONLY copy of the four deleted
 *     Summary rows. It is the audit trail; a later tidy-up must not remove it.
 *   - MAYERS_REPAIR_SNAPSHOT_2026-06-15 / _2026-07-06 / _2026-07-20 /
 *     _2026-07-27 — the original Suppliers locations. Write-once per week, so
 *     a "already-exists" refusal means that week already ran.
 *
 * restoreMayersLocationSnapshot() is the only code that knows how to consume
 * them. Deleting it with the repair file would have left a retained rollback
 * artifact with no rollback — worse than keeping no artifact at all. It is
 * zero-arg (the editor Run button passes no arguments), idempotent, and
 * covered by tests in test_code.js that hand-build the post-apply state so the
 * coverage outlives the file that produced it.
 * ==================================================================== */

var MAYERS_REPAIR_BACKUP_TAB = 'Summary_mayers_location_backup';
var MAYERS_REPAIR_SNAPSHOT_PREFIX_ = 'MAYERS_REPAIR_SNAPSHOT_';

/**
 * Normalize a cell the way rowKey_ does (Code.gs:607-615). BOTH sides of every
 * comparison in this repair go through it: rowKey_ lowercases and trims, and
 * every comparable predicate in Code.gs follows suit, so a stray trailing space
 * or a different case in one Sheet cell must never make a guard silently miss.
 */
function mayersNorm_(v) {
  return sheetKeyPart_(v);
}

function mayersRepairSnapshotKey_(week) {
  return MAYERS_REPAIR_SNAPSHOT_PREFIX_ + week;
}

/**
 * @returns {Object|null} the parsed snapshot, null if absent, or
 *   {corrupt:true} — which callers must treat as "stop", never as "absent".
 */
function mayersRepairLoadSnapshot_(week) {
  var raw = PropertiesService.getScriptProperties().getProperty(mayersRepairSnapshotKey_(week));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    Logger.log('mayersRepairLoadSnapshot_: CORRUPT snapshot for ' + week + ' — ' + err.message +
      '. Treating as a hard stop, not as absent: an absent snapshot means "first run, ' +
      'safe to proceed", and this is the opposite of that.');
    return { corrupt: true, week: week };
  }
}

/**
 * WRITE-ONCE, per week. The key is MAYERS_REPAIR_SNAPSHOT_<week_start> and it
 * refuses to overwrite ITS OWN key.
 *
 * A single shared key would break the moment the second week ran: it would
 * either abort (leaving the Sheet partly repaired) or skip the write (leaving
 * three weeks mutated with no rollback artifact for the step that deletes
 * production rows). Per-week plus refuse-to-overwrite means a second run of the
 * SAME week cannot clobber the real snapshot with an empty one taken after the
 * locations were already rewritten.
 *
 * @returns {{written:boolean, reason:string}}
 */
function mayersRepairSaveSnapshot_(week, snapshot) {
  var props = PropertiesService.getScriptProperties();
  var key = mayersRepairSnapshotKey_(week);
  if (props.getProperty(key) !== null) {
    Logger.log('mayersRepairSaveSnapshot_: ' + key + ' already exists — keeping the original. ' +
      'This is a resume, not a first run.');
    return { written: false, reason: 'already-exists' };
  }
  props.setProperty(key, JSON.stringify(snapshot));
  Logger.log('mayersRepairSaveSnapshot_: wrote ' + key);
  return { written: true, reason: 'written' };
}

/** Every week that has a retained snapshot, oldest first. */
function mayersRepairSnapshotWeeks_() {
  var props = PropertiesService.getScriptProperties();
  var keys = props.getKeys ? props.getKeys() : [];
  var weeks = [];
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].indexOf(MAYERS_REPAIR_SNAPSHOT_PREFIX_) === 0) {
      weeks.push(keys[i].slice(MAYERS_REPAIR_SNAPSHOT_PREFIX_.length));
    }
  }
  return weeks.sort();
}

/** A Summary-shaped row array, for feeding rowKey_(row, SUMMARY_KEY_COLS). */
function mayersSummaryKeyRow_(weekStart, department, kind, supplier, location) {
  return [weekStart, addDaysStr_(weekStart, 6), supplier, location, 0, '', department, kind];
}

/**
 * 1-based Summary row numbers whose FULL SUMMARY_KEY_COLS tuple equals keyRow's.
 *
 * NEVER match on (week, location) alone. A ~$14,219 Bennetts row sits at
 * location='' in week 2026-07-20, written straight to Summary by
 * orderapp.gs:406 and NOT rebuildable by weeklySummarize (which derives only
 * from Suppliers + Revenue). A (week, location='') predicate would destroy it
 * permanently — nothing in this repo could regenerate it.
 *
 * @returns {number[]}
 */
function mayersFindSummaryRows_(summData, keyRow) {
  var want = rowKey_(keyRow, SUMMARY_KEY_COLS);
  var hits = [];
  for (var r = 1; r < summData.length; r++) {
    if (rowKey_(summData[r], SUMMARY_KEY_COLS) === want) hits.push(r + 1);
  }
  return hits;
}

/**
 * Roll the location repair back. Three parts, per week:
 *   1. restore the Suppliers `location` cells from the snapshot;
 *   2. undo the target-location Summary rows — delete the ones the repair
 *      created, restore the pre-repair amount on any that already existed;
 *   3. re-append the deleted stale Summary rows from MAYERS_REPAIR_BACKUP_TAB.
 *
 * Zero-arg-safe: the editor Run button passes no arguments, so calling this
 * with nothing rolls back EVERY week that has a retained snapshot. Idempotent —
 * a second run finds nothing left to undo and reports zeros.
 *
 * @param {string} [weekStart] 'yyyy-MM-dd' to roll back a single week
 */
function restoreMayersLocationSnapshot(weekStart) {
  var only = resolveDateArg_(weekStart, null);
  var weeks = only ? [only] : mayersRepairSnapshotWeeks_();

  if (!weeks.length) {
    Logger.log('restoreMayersLocationSnapshot: no ' + MAYERS_REPAIR_SNAPSHOT_PREFIX_ +
      '* properties — nothing to roll back.');
    return { weeks: 0, results: [] };
  }

  var res = withScriptLock_(function () {
    var out = [];
    for (var i = 0; i < weeks.length; i++) out.push(mayersRestoreWeek_(weeks[i]));
    return out;
  });

  // withScriptLock_ RETURNS a sentinel rather than throwing (Code.gs:115), so an
  // unchecked call would report a clean rollback having done nothing at all.
  if (res === LOCK_TIMEOUT_) {
    Logger.log('restoreMayersLocationSnapshot: could not acquire the script lock — ' +
      'NOTHING was rolled back. Re-run away from the 6am mayersDailyPull window.');
    return { refused: 'locked', weeks: 0, results: [] };
  }

  Logger.log('ROLLED BACK: ' + JSON.stringify({ weeks: weeks.length, results: res }, null, 2));
  return { weeks: weeks.length, results: res };
}

/** One week of the 3-part rollback. Assumes the script lock is already held. */
function mayersRestoreWeek_(week) {
  var snap = mayersRepairLoadSnapshot_(week);
  if (!snap) return { week: week, refused: 'no-snapshot' };
  if (snap.corrupt) return { week: week, refused: 'corrupt-snapshot' };

  var ss = getHubSpreadsheet_();
  var suppSheet = ss.getSheetByName(SUPPLIERS_TAB);
  var summSheet = ss.getSheetByName(SUMMARY_TAB);
  if (!suppSheet || !summSheet) return { week: week, refused: 'missing-tab' };

  /* 1. Suppliers locations. Re-find each row by invoice_ref rather than trusting
   *    the row number recorded at snapshot time — rows shift under archive/purge. */
  var suppData = suppSheet.getDataRange().getValues();
  var locationsRestored = 0;
  var suppRows = snap.rows || [];
  for (var i = 0; i < suppRows.length; i++) {
    for (var r = 1; r < suppData.length; r++) {
      if (mayersNorm_(suppData[r][5]) !== 'mayers') continue;
      if (mayersNorm_(suppData[r][3]) !== mayersNorm_(suppRows[i].invoice_ref)) continue;
      // Unguard BOTH sides before comparing: the sheet cell may carry the
      // formula text-guard while the snapshot value (captured pre-guard, or
      // built in memory) does not. Comparing raw would read "not yet
      // restored" forever and rewrite the cell on every run. Not mayersNorm_
      // — that lowercases, and location is case-significant here.
      if (String(sheetUnguardCell_(suppData[r][4])) === String(sheetUnguardCell_(suppRows[i].location))) break;
      suppSheet.getRange(r + 1, 5).setValue(sheetSafeCell_(suppRows[i].location));
      locationsRestored++;
      break;
    }
  }

  /* 2. Undo the target-location Summary rows. Collect first, delete bottom-up so
   *    the collected row numbers stay valid as rows shift up. */
  var summData = summSheet.getDataRange().getValues();
  var toDelete = [];
  var amountsRestored = 0;
  var targets = snap.targetKeys || [];
  for (var t = 0; t < targets.length; t++) {
    var tk = targets[t];
    var keyRow = mayersSummaryKeyRow_(week, tk.department, tk.kind, tk.supplier, tk.location);
    var hits = mayersFindSummaryRows_(summData, keyRow);
    for (var h = 0; h < hits.length; h++) {
      if (tk.existedBefore) {
        summSheet.getRange(hits[h], SUMMARY_TOTAL_COL + 1).setValue(tk.totalBefore);
        amountsRestored++;
      } else {
        toDelete.push(hits[h]);
      }
    }
  }
  toDelete.sort(function (a, b) { return a - b; });
  for (var d = toDelete.length - 1; d >= 0; d--) summSheet.deleteRow(toDelete[d]);

  /* 3. Re-append the stale rows from the backup tab. Guarded on presence, so a
   *    second rollback is a no-op rather than a double-append. */
  var backup = ss.getSheetByName(MAYERS_REPAIR_BACKUP_TAB);
  var staleRestored = 0;
  var stale = snap.staleKeys || [];
  if (backup) {
    var backupData = backup.getDataRange().getValues();
    summData = summSheet.getDataRange().getValues();
    for (var s = 0; s < stale.length; s++) {
      var sk = stale[s];
      var staleRow = mayersSummaryKeyRow_(week, sk.department, sk.kind, sk.supplier, sk.location);
      if (mayersFindSummaryRows_(summData, staleRow).length) continue; // already back
      var want = rowKey_(staleRow, SUMMARY_KEY_COLS);
      for (var b = 1; b < backupData.length; b++) {
        if (rowKey_(backupData[b], SUMMARY_KEY_COLS) !== want) continue;
        summSheet.appendRow(sheetSafeRow_(backupData[b]));
        summData.push(backupData[b]);
        staleRestored++;
        break; // first (earliest) backup copy only
      }
    }
  }

  var result = {
    week: week,
    locationsRestored: locationsRestored,
    targetRowsDeleted: toDelete.length,
    targetAmountsRestored: amountsRestored,
    staleRowsRestored: staleRestored,
    staleRowsExpected: stale.length
  };
  Logger.log('mayersRestoreWeek_: ' + JSON.stringify(result));
  return result;
}
