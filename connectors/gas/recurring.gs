/**
 * recurring.gs — Recurring cost generator (rent, subscriptions) -> Suppliers
 * tab (department='Roastery' for the entries below, but the shape is generic).
 *
 * Recurring costs have no external source to pull from: a human enters the
 * amount once (Script Property) and this generator mints one Suppliers row
 * per period. The whole crux of this file is idempotency — a monthly trigger
 * that misfires twice, or a manual re-run, must NEVER double-charge rent.
 * That is achieved by routing through ingestSupplierRows/upsertRows_ (the
 * SAME shared dedup every other connector uses) with a DETERMINISTIC
 * invoice_ref derived from the vendor + period — never a timestamp, never
 * random — so a re-run for the same period always resolves to the same key
 * and upserts in place instead of appending a duplicate.
 *
 * Amounts live ONLY in Script Properties, never in this file and never in
 * the repo (CLAUDE.md: no business data committed) — and never typed
 * directly into the deployed script via the Apps Script editor, because the
 * next `clasp push` would silently wipe it.
 *
 * Script Properties (never in the repo, never in chat):
 *   RECUR_RENT_ROASTERY — monthly rent amount, e.g. '2500'
 *   RECUR_SHOPIFY       — monthly Shopify subscription amount, e.g. '79'
 * A missing property means that entry is skipped and logged loudly — it is
 * NEVER written as 0 (a silent 0 looks like a legitimate free month).
 */

var RECURRING_TZ = 'Australia/Sydney';

// cadence:'weekly' is part of the shape so a future weekly recurring cost
// can be added without restructuring this array, but only 'monthly' is
// actually processed below — an ISO-week ref generator is unbuilt and
// untested, so a 'weekly' entry is skipped loudly rather than silently
// mis-billed. Wire it up (and add tests) when the first weekly cost exists.
var RECURRING_COSTS = [
  { vendor: 'Rent — Roastery', propKey: 'RECUR_RENT_ROASTERY', cadence: 'monthly', department: 'Roastery', source: 'recurring' },
  { vendor: 'Shopify',         propKey: 'RECUR_SHOPIFY',       cadence: 'monthly', department: 'Roastery', source: 'recurring' },
];

/* ------------------------------------------------------------------ *
 * Entry points
 * ------------------------------------------------------------------ */

/**
 * Generate this period's recurring-cost rows into Suppliers.
 * @param {string} [periodStr] — 'yyyy-MM'; defaults to the current month
 *   (Australia/Sydney).
 * @returns {{period:string, rowsAdded:number, rowsUpdated:number,
 *   duplicatesSkipped:number, skipped:Array<string>}}
 */
function recurringMonthlyRun_(periodStr) {
  var res = withScriptLock_(function () { return recurringMonthlyRun_impl_(periodStr); });
  if (res === LOCK_TIMEOUT_) {
    Logger.log('recurringMonthlyRun_: could not acquire script lock — skipped this run');
    return { period: null, rowsAdded: 0, rowsUpdated: 0, duplicatesSkipped: 0, skipped: [], locked: true };
  }
  return res;
}

function recurringMonthlyRun_impl_(periodStr) {
  // new Date(Date.now()), not bare new Date() — matches square.gs/orderapp.gs
  // convention so tests can pin "now" via a Date.now() override; a bare
  // new Date() reads the real system clock regardless of that override.
  var period = periodStr || Utilities.formatDate(new Date(Date.now()), RECURRING_TZ, 'yyyy-MM');
  var props = PropertiesService.getScriptProperties();
  var extractedAt = Utilities.formatDate(new Date(Date.now()), RECURRING_TZ, "yyyy-MM-dd'T'HH:mm:ssXXX");

  var rawRows = [];
  var skipped = [];
  for (var i = 0; i < RECURRING_COSTS.length; i++) {
    var entry = RECURRING_COSTS[i];

    if (entry.cadence !== 'monthly') {
      Logger.log('recurringMonthlyRun_: cadence "' + entry.cadence + '" not implemented for ' +
        entry.vendor + ' — skipping');
      skipped.push(entry.vendor);
      continue;
    }

    var amountStr = props.getProperty(entry.propKey);
    if (amountStr === null || amountStr === '') {
      Logger.log('recurringMonthlyRun_: missing script property ' + entry.propKey + ' for ' +
        entry.vendor + ' — skipping (never writing 0)');
      skipped.push(entry.vendor);
      continue;
    }
    var amount = Number(amountStr);
    if (isNaN(amount)) {
      Logger.log('recurringMonthlyRun_: script property ' + entry.propKey + ' is not a number ("' +
        amountStr + '") for ' + entry.vendor + ' — skipping');
      skipped.push(entry.vendor);
      continue;
    }

    rawRows.push({
      date: period + '-01',
      supplier: entry.vendor,
      total: amount,
      invoice_ref: recurringSlug_(entry.vendor) + '-' + period,
      location: '',
      department: entry.department
    });
  }

  var ss = getHubSpreadsheet_();
  var sheet = ensureSheet(ss, SUPPLIERS_TAB, SUPPLIERS_HEADERS);
  var res = rawRows.length
    ? ingestSupplierRows('recurring', rawRows, extractedAt, sheet)
    : { rowsAdded: 0, rowsUpdated: 0, duplicatesSkipped: 0 };

  // Heartbeat only when at least one entry actually resolved — mirrors
  // orderapp.gs's not-armed skip (orderAppRunSkipped_): an
  // all-properties-missing run has produced nothing to trust, so it must not
  // silently satisfy a staleness check.
  if (rawRows.length) {
    stalenessStampHeartbeat_('recurring');
  }

  Logger.log('recurringMonthlyRun_: ' + period + ' +' + res.rowsAdded + ' ~' + res.rowsUpdated +
    ' =' + res.duplicatesSkipped + (skipped.length ? ' skipped: ' + skipped.join(', ') : ''));

  return {
    period: period,
    rowsAdded: res.rowsAdded,
    rowsUpdated: res.rowsUpdated,
    duplicatesSkipped: res.duplicatesSkipped,
    skipped: skipped
  };
}

/**
 * Trigger handler — takes NO ARGUMENTS deliberately (a time-based trigger
 * passes an event object into arg 1; recurringMonthlyRun_ must not mistake
 * that for a period string). Always runs the CURRENT month.
 */
function recurringMonthlyTrigger_() {
  return recurringMonthlyRun_();
}

/**
 * Install the monthly trigger: 1st of the month, 05:00 Australia/Sydney.
 * Idempotent: removes any existing recurringMonthlyTrigger_ triggers first.
 */
function installRecurringTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'recurringMonthlyTrigger_') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('recurringMonthlyTrigger_').timeBased()
    .onMonthDay(1).atHour(5).inTimezone(RECURRING_TZ).create();
  Logger.log('installRecurringTrigger: monthly 1st 05:00 ' + RECURRING_TZ + ' trigger installed');
}

/* ------------------------------------------------------------------ *
 * Pure helpers (unit-tested)
 * ------------------------------------------------------------------ */

/**
 * Deterministic, dedup-safe slug: lowercase, non-alphanumeric runs collapsed
 * to a single hyphen, leading/trailing hyphens trimmed. Same input always
 * yields the same output — that stability is what makes invoice_ref
 * reproducible across runs (the whole idempotency mechanism depends on it).
 * @param {string} str
 * @returns {string}
 */
function recurringSlug_(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
