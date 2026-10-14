/**
 * labour.gs — pure labour-cost calculation for the clock-in rebuild (ADR-008, pending).
 *
 * Phase `labour-clock` (PRD-15..PRD-20) fills this file in. Every function here is
 * PURE: it takes arrays/objects and returns values. No SpreadsheetApp,
 * PropertiesService, UrlFetchApp, Utilities or Logger access — reading the
 * Labour Sheet, writing results and raising alerts are wired in a LATER phase
 * (weeklySummarize wiring), not here.
 *
 * Name hygiene: Code.gs already owns LABOUR_TAB, LABOUR_HEADERS, getLabourSpreadsheet_
 * and labourWeeklyPull_ (the legacy Onboarding-sheet pull). Everything new in this file
 * is prefixed LABOUR_CLOCK_ / labour...Clock... / labour<Verb>_ and must not collide —
 * all .gs files share one global namespace in Apps Script.
 */
