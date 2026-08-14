/**
 * mayers_harvest.gs — ONE-SHOT DIAGNOSTIC. Captures REAL Drive OCR text for Mayers
 * invoices so parser fixes can be built against reality instead of guesses.
 *
 * WHY THIS EXISTS: `pdftotext` is not a valid proxy for Drive OCR. Measured
 * 2026-08-14 on a real Mayers PDF, `pdftotext` output failed ALL THREE regexes in
 * parseMayersInvoice_ (ref, total, date → NULL) while that same invoice is on
 * record as OCR-parsed and ingested live. pdftotext splits labels from values onto
 * separate lines ("Ex Tax: GST Total:" … "733.75 2.99" … "736.74"); Drive OCR
 * evidently keeps them adjacent. So no offline extractor can settle:
 *   (a) whether shop-attribution rules should scope to the Deliver-To block, and
 *   (b) TODO #8 — whether the total regex grabs the wrong number.
 * The only way to know is to read what DocumentApp.getBody().getText() actually
 * returns. That is all this file does.
 *
 * READ-ONLY against the hub Sheet and against Gmail: it never writes Suppliers or
 * Summary rows, and never applies the `expense-ingested` label. Its one side effect
 * is creating a Google Doc in Drive holding the harvested text (plus the temp OCR
 * docs extractPdfText_ already creates and trashes).
 *
 * Entry point: runMayersOcrHarvest()  — zero-arg, for the editor Run button.
 * Delete this file once the Mayers parser work is closed.
 */

// Full history INCLUDING already-labelled threads — deliberately NOT the
// '-label:expense-ingested' filter mayersDailyPull uses. The labelled invoices are
// precisely the ones whose rows are already in the Sheet, so they are the only ones
// whose parse we can compare against stored data.
var MAYERS_HARVEST_SEARCH_ = 'deliveredto:(mio.jake+mayers@gmail.com) has:attachment';

// Drive OCR is rate-limited (extractPdfText_ carries a 20s retry) and GAS caps
// execution at ~6 min. Cap the work and leave headroom to write the Doc.
var MAYERS_HARVEST_MAX_ = 10;
var MAYERS_HARVEST_BUDGET_MS_ = 270000; // 4.5 min
var MAYERS_HARVEST_CHUNK_ = 8000;

// Coverage bookkeeping ONLY — "have we seen an invoice for each shop yet?".
// Deliberately loose and matched against the WHOLE text. This is NOT the
// attribution fix and must never be copied into MAYERS_SHOP_RULES_.
var MAYERS_HARVEST_SHOP_HINTS_ = [
  { shop: 'York',      re: /YORK\s*ST/i },
  { shop: 'Pitt',      re: /PITT\s*ST/i },
  { shop: 'North',     re: /BLUES?\s*ST|NORTH\s+SYDNEY/i },
  { shop: 'Crowsnest', re: /BURLINGTON|CROWS\s*NEST/i }
];

// Every money label that could plausibly win the first-match race in
// parseMayersInvoice_'s total regex. Longest alternatives first so that at a given
// position "Sub Total" is tried before "Total". Enumerating ALL of them in document
// order is the evidence TODO #8 needs: its stated premise ("Sub Total may match
// first") is already disproven — real Mayers invoices use "Ex Tax:" and carry a
// "Line Total" column header — so the question is which label actually wins.
var MAYERS_HARVEST_MONEY_RE_ =
  /(?:^|\s)(Sub\s*Total|Line\s*Total|Ex\s*Tax|GST|Total)\s*[:\-]?\s*\$?\s*([0-9][\d,]*\.\d{2})/gi;

// The strict regex above shares the production regex's blind spot BY DESIGN: it only
// matches when a number follows the label separated by whitespace alone. That is the
// right question for "what would today's code grab?" but the wrong one for "where is
// the money?" — verified 2026-08-14, on column-split text it found 1 label where 4
// exist. So also enumerate every money label UNCONDITIONALLY and dump the raw
// characters that follow it. Whatever Drive OCR's layout turns out to be, this shows
// it rather than silently reporting nothing.
var MAYERS_HARVEST_LABEL_RE_ = /(Sub\s*Total|Line\s*Total|Ex\s*Tax|GST|Total)/gi;
var MAYERS_HARVEST_CONTEXT_ = 100;

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

/**
 * Harvest real Drive OCR text for Mayers invoices into a Google Doc.
 * Zero-arg: the editor Run button passes no arguments.
 * @returns {{docUrl:string, harvested:number, shopsCovered:Array<string>, shopsMissing:Array<string>}}
 */
function runMayersOcrHarvest() {
  var out = harvestMayersOcr_();

  // Diagnostics as their own early entry — Logger.log truncates PER ENTRY, so a
  // single blob would lose exactly the fields worth reading.
  Logger.log('=== MAYERS OCR HARVEST ===');
  Logger.log('doc:        ' + out.docUrl);
  Logger.log('harvested:  ' + out.harvested + ' invoice(s) of ' + out.pdfsSeen + ' PDF(s) seen');
  Logger.log('shops seen: ' + (out.shopsCovered.join(', ') || '(none)'));
  Logger.log('shops MISSING: ' + (out.shopsMissing.join(', ') || '(none — all four covered)'));
  Logger.log('stopped by: ' + out.stoppedBy);
  if (out.errors.length) Logger.log('errors:     ' + out.errors.join(' | '));

  // Self-check: say plainly whether this run produced usable evidence.
  if (out.harvested === 0) {
    Logger.log('RESULT: FAIL — nothing harvested. Check the Gmail search matches any thread.');
  } else if (out.shopsMissing.length) {
    Logger.log('RESULT: PARTIAL — open the doc; ' + out.shopsMissing.length +
      ' shop(s) still unharvested. Re-run raises no new invoices unless more exist.');
  } else {
    Logger.log('RESULT: PASS — all four shops covered. Open the doc and hand its text back.');
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Harvest
 * ------------------------------------------------------------------ */

function harvestMayersOcr_() {
  var t0 = Date.now();
  var threads = GmailApp.search(MAYERS_HARVEST_SEARCH_);
  var records = [];
  var errors = [];
  var seenPdf = {};
  var covered = {};
  var pdfsSeen = 0;
  var stoppedBy = 'exhausted the search';

  for (var t = 0; t < threads.length; t++) {
    if (records.length >= MAYERS_HARVEST_MAX_) { stoppedBy = 'hit MAYERS_HARVEST_MAX_ (' + MAYERS_HARVEST_MAX_ + ')'; break; }
    if (Date.now() - t0 > MAYERS_HARVEST_BUDGET_MS_) { stoppedBy = 'hit the 4.5 min time budget'; break; }

    var messages = threads[t].getMessages();
    for (var m = 0; m < messages.length; m++) {
      if (records.length >= MAYERS_HARVEST_MAX_) break;

      var msg = messages[m];
      var pdf = firstPdfAttachment_(msg);
      if (!pdf) continue;
      if (seenPdf[pdf.getName()]) continue;
      seenPdf[pdf.getName()] = true;
      pdfsSeen++;

      // Skip a PDF whose shop we already have — OCR is the expensive part, and
      // coverage across all four shops matters more than depth on one.
      var msgDate = Utilities.formatDate(msg.getDate(), MAYERS_TZ, 'yyyy-MM-dd');

      var text;
      try {
        text = extractPdfText_(pdf); // the EXACT production OCR path
      } catch (err) {
        errors.push(pdf.getName() + ': ' + err.message);
        continue;
      }

      var hint = mayersHarvestShopHint_(text);
      if (hint && covered[hint]) continue; // already have this shop
      if (hint) covered[hint] = true;

      records.push({
        pdfName: pdf.getName(),
        msgDate: msgDate,
        shopHint: hint || '(no hint matched)',
        text: text,
        diag: mayersHarvestDiagnose_(text, msgDate)
      });
    }
  }

  var shopsCovered = [];
  var shopsMissing = [];
  for (var i = 0; i < MAYERS_HARVEST_SHOP_HINTS_.length; i++) {
    var s = MAYERS_HARVEST_SHOP_HINTS_[i].shop;
    if (covered[s]) shopsCovered.push(s); else shopsMissing.push(s);
  }

  var docUrl = mayersHarvestWriteDoc_(records, mayersHarvestStoredRows_(), {
    pdfsSeen: pdfsSeen, threads: threads.length, stoppedBy: stoppedBy, errors: errors
  });

  return {
    docUrl: docUrl,
    harvested: records.length,
    pdfsSeen: pdfsSeen,
    shopsCovered: shopsCovered,
    shopsMissing: shopsMissing,
    stoppedBy: stoppedBy,
    errors: errors
  };
}

/* ------------------------------------------------------------------ *
 * Diagnosis — what the CURRENT production code makes of this text
 * ------------------------------------------------------------------ */

/**
 * Run today's production regexes against real OCR text and record the verdicts.
 * Reports what IS, never what should be — the fix is decided from this output.
 */
function mayersHarvestDiagnose_(text, fallbackDate) {
  var refMatch = text.match(/Invoice\s+(?:No\.?|Number|#)?\s*[:\-]?\s*([0-9]{6,8})/i);
  var totalMatch = text.match(/(?:^|\s)Total\s*[:\-]?\s*\$?\s*([0-9][\d,]*\.\d{2})/m);
  var dateMatch = text.match(/Invoice\s+Date[:\-]?\s*(\d{1,2})\-([A-Z]{3})\-(\d{2})/i);
  var deliv = text.match(/Deliver\s*To[:\s]*([\s\S]{0,120})/i);

  // Every money label in document order — the raw material for the TODO #8 call.
  var money = [];
  MAYERS_HARVEST_MONEY_RE_.lastIndex = 0;
  var mm;
  while ((mm = MAYERS_HARVEST_MONEY_RE_.exec(text)) !== null) {
    money.push({ label: mm[1].replace(/\s+/g, ' '), value: mm[2], at: mm.index });
  }

  // Unconditional: every money label plus the raw characters after it, so the layout
  // is legible even when no number immediately follows.
  var contexts = [];
  MAYERS_HARVEST_LABEL_RE_.lastIndex = 0;
  var lm;
  while ((lm = MAYERS_HARVEST_LABEL_RE_.exec(text)) !== null) {
    contexts.push({
      label: lm[1].replace(/\s+/g, ' '),
      at: lm.index,
      after: text.substr(lm.index + lm[1].length, MAYERS_HARVEST_CONTEXT_)
    });
  }

  return {
    parsed: parseMayersInvoice_(text, fallbackDate), // null = would be skipped entirely
    ref: refMatch ? refMatch[1] : null,
    total: totalMatch ? totalMatch[1] : null,
    date: dateMatch ? dateMatch.slice(1, 4).join('-') : null,
    shopFromText: mayersShopFromText_(text),
    deliverToBlock: deliv ? deliv[1] : null,
    deliverToFound: !!deliv,
    moneyLabels: money,
    moneyContexts: contexts,
    flags: {
      hasBLUES_ST: /BLUES\s*ST/i.test(text),
      hasBLUE_ST: /\bBLUE\s*ST/i.test(text),
      hasSubTotal: /Sub\s*Total/i.test(text),
      hasLineTotal: /Line\s*Total/i.test(text),
      hasExTax: /Ex\s*Tax/i.test(text),
      billToBeforeDeliverTo: (function () {
        var b = text.search(/Bill\s*To/i), d = text.search(/Deliver\s*To/i);
        return (b !== -1 && d !== -1) ? (b < d) : null;
      })()
    }
  };
}

function mayersHarvestShopHint_(text) {
  for (var i = 0; i < MAYERS_HARVEST_SHOP_HINTS_.length; i++) {
    if (MAYERS_HARVEST_SHOP_HINTS_[i].re.test(text)) return MAYERS_HARVEST_SHOP_HINTS_[i].shop;
  }
  return null;
}

/**
 * Read (never write) the Mayers rows already stored in Suppliers, so a harvested
 * invoice's true total can be compared against what was actually ingested.
 * @returns {Array<Object>}
 */
function mayersHarvestStoredRows_() {
  var sheet = getHubSpreadsheet_().getSheetByName(SUPPLIERS_TAB);
  if (!sheet || sheet.getLastRow() < 2) return [];
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, SUPPLIERS_HEADERS.length).getValues();
  var rows = [];
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][5]).toLowerCase() !== 'mayers') continue; // col 5 = source
    rows.push({
      date: values[i][0], total: values[i][2], invoice_ref: values[i][3],
      location: values[i][4], extracted_at: values[i][6]
    });
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * Output — a Google Doc, because Logger.log truncates per entry and OCR
 * text runs to thousands of characters.
 * ------------------------------------------------------------------ */

function mayersHarvestWriteDoc_(records, storedRows, meta) {
  var stamp = Utilities.formatDate(new Date(), MAYERS_TZ, 'yyyy-MM-dd HH:mm');
  var doc = DocumentApp.create('Mayers OCR harvest ' + stamp);
  var body = doc.getBody();

  body.appendParagraph('MAYERS OCR HARVEST — ' + stamp);
  body.appendParagraph(
    'Real Drive OCR text (DocumentApp.getBody().getText()) for Mayers invoices. ' +
    'Read-only harvest: no Suppliers/Summary rows written, no Gmail labels applied.');
  body.appendParagraph(
    'threads searched: ' + meta.threads + ' | PDFs seen: ' + meta.pdfsSeen +
    ' | harvested: ' + records.length + ' | stopped by: ' + meta.stoppedBy);
  if (meta.errors.length) body.appendParagraph('ERRORS: ' + meta.errors.join(' | '));

  body.appendParagraph('');
  body.appendParagraph('--- STORED MAYERS ROWS (Suppliers tab, read-only) ---');
  if (!storedRows.length) {
    body.appendParagraph('(none)');
  } else {
    for (var s = 0; s < storedRows.length; s++) {
      var r = storedRows[s];
      body.appendParagraph('  ' + r.date + ' | ref ' + r.invoice_ref + ' | $' + r.total +
        ' | location: ' + r.location);
    }
  }

  for (var i = 0; i < records.length; i++) {
    var rec = records[i];
    var d = rec.diag;
    body.appendParagraph('');
    body.appendParagraph('==================================================');
    body.appendParagraph('INVOICE ' + (i + 1) + ' — ' + rec.pdfName +
      '  (email date ' + rec.msgDate + ', shop hint: ' + rec.shopHint + ')');
    body.appendParagraph('==================================================');
    body.appendParagraph('CURRENT PARSER VERDICTS');
    body.appendParagraph('  parseMayersInvoice_ -> ' +
      (d.parsed ? JSON.stringify(d.parsed) : 'NULL  (invoice would be SKIPPED)'));
    body.appendParagraph('  invoice_ref regex   -> ' + d.ref);
    body.appendParagraph('  total regex         -> ' + d.total + '   <-- compare to money labels below');
    body.appendParagraph('  date regex          -> ' + d.date);
    body.appendParagraph('  mayersShopFromText_ -> ' + d.shopFromText);
    body.appendParagraph('  Deliver-To found    -> ' + d.deliverToFound);
    body.appendParagraph('  Bill To precedes Deliver To -> ' + d.flags.billToBeforeDeliverTo);
    body.appendParagraph('  flags -> ' + JSON.stringify(d.flags));
    body.appendParagraph('MONEY LABELS IN DOCUMENT ORDER (first one wins today)');
    if (!d.moneyLabels.length) {
      body.appendParagraph('  (none matched)');
    } else {
      for (var k = 0; k < d.moneyLabels.length; k++) {
        body.appendParagraph('  [' + k + '] @' + d.moneyLabels[k].at + '  ' +
          d.moneyLabels[k].label + ' = ' + d.moneyLabels[k].value);
      }
    }
    body.appendParagraph('EVERY MONEY LABEL + WHAT FOLLOWS IT (raw; \\n = newline)');
    if (!d.moneyContexts.length) {
      body.appendParagraph('  (no money label of any kind found)');
    } else {
      for (var q = 0; q < d.moneyContexts.length; q++) {
        body.appendParagraph('  [' + q + '] @' + d.moneyContexts[q].at + '  ' +
          d.moneyContexts[q].label + ' >>> ' + JSON.stringify(d.moneyContexts[q].after));
      }
    }
    body.appendParagraph('DELIVER-TO CAPTURE (current 120-char window)');
    body.appendParagraph(d.deliverToBlock === null ? '  (no Deliver To marker)' : d.deliverToBlock);
    body.appendParagraph('--- FULL OCR TEXT (' + rec.text.length + ' chars) ---');
    for (var c = 0; c < rec.text.length; c += MAYERS_HARVEST_CHUNK_) {
      body.appendParagraph(rec.text.substring(c, c + MAYERS_HARVEST_CHUNK_));
    }
  }

  doc.saveAndClose();
  return doc.getUrl();
}
