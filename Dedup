/**
 * Dedup.gs
 * Deduplication for the "Referral Tracker" sheet.
 * Self-contained: only reads/writes the Sheet, no external libraries, no cross-file imports.
 */

// Column order in "Referral Tracker" (0-indexed positions used below).
const TRACKER_SHEET_NAME = 'Referral Tracker';
const REVIEW_QUEUE_SHEET_NAME = 'Review Queue';

// Header labels we care about (must match the sheet exactly).
const COL_ORGANIZATION = 'Organization';
const COL_CONTACT_INFO = 'Contact Information';
const COL_WEBSITE = 'Website';
const COL_LOCATION = 'NJDPT Location';

// Review Queue header row.
const REVIEW_QUEUE_HEADERS = [
  'Incoming Organization',
  'Incoming Phone',
  'Incoming Domain',
  'Matched Organization',
  'Matched Phone',
  'Matched Domain',
  'Reason',
  'Decision'
];

// Similarity thresholds.
const DOMAIN_NAME_THRESHOLD = 0.7;
const NAME_STRONG_THRESHOLD = 0.85;

/**
 * Lowercases a name, strips punctuation, removes legal suffixes and "Dr." prefix,
 * and collapses extra whitespace — used to compare organization names fairly.
 */
function normalizeName(name) {
  if (!name) {
    return '';
  }
  let s = String(name).toLowerCase();

  // Strip a leading "dr." / "dr" prefix.
  s = s.replace(/^\s*dr\.?\s+/i, ' ');

  // Remove punctuation (keep letters, numbers, whitespace).
  s = s.replace(/[^a-z0-9\s]/g, ' ');

  // Strip common legal suffixes (as whole words).
  s = s.replace(/\b(llc|inc|pa|pc|dpt|md|corp|co)\b/g, ' ');

  // Collapse extra whitespace and trim.
  s = s.replace(/\s+/g, ' ').trim();

  return s;
}

/**
 * Reduces a phone value to digits only and returns the last 10 digits
 * (drops country codes / formatting so numbers compare consistently).
 */
function normalizePhone(phone) {
  if (!phone) {
    return '';
  }
  const digits = String(phone).replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/**
 * Reduces a URL to its bare host: strips protocol, strips "www.",
 * and keeps everything before the first slash. Returns '' for blank input.
 */
function normalizeDomain(url) {
  if (!url) {
    return '';
  }
  let s = String(url).trim().toLowerCase();
  s = s.replace(/^[a-z]+:\/\//, ''); // strip protocol
  s = s.replace(/^www\./, '');       // strip www.
  s = s.split('/')[0];               // everything before first slash
  return s.trim();
}

/**
 * Computes Levenshtein edit distance between two strings (iterative DP).
 */
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) {
    return n;
  }
  if (n === 0) {
    return m;
  }

  // Two-row rolling DP to keep memory small.
  let prev = [];
  let curr = [];
  for (let j = 0; j <= n; j++) {
    prev[j] = j;
  }

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,        // deletion
        curr[j - 1] + 1,    // insertion
        prev[j - 1] + cost  // substitution
      );
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }

  return prev[n];
}

/**
 * Returns a 0-1 similarity score from Levenshtein distance.
 * Returns 0 if either input is empty.
 */
function stringSimilarity(a, b) {
  const sa = a ? String(a) : '';
  const sb = b ? String(b) : '';
  if (sa.length === 0 || sb.length === 0) {
    return 0;
  }
  const distance = levenshtein(sa, sb);
  return 1 - (distance / Math.max(sa.length, sb.length));
}

/**
 * Compares one incoming record against all existing records and decides whether
 * it is a DISTINCT, LIKELY_DUPLICATE, or REVIEW candidate. Each record is a plain
 * object keyed by the sheet's column headers.
 * Returns { result, matchedRecord, reason }.
 */
function checkDuplicate(incomingRecord, existingRecords) {
  const inName = normalizeName(incomingRecord[COL_ORGANIZATION]);
  const inPhone = normalizePhone(incomingRecord[COL_CONTACT_INFO]);
  const inDomain = normalizeDomain(incomingRecord[COL_WEBSITE]);
  const inLocation = incomingRecord[COL_LOCATION]
    ? String(incomingRecord[COL_LOCATION]).trim().toLowerCase()
    : '';

  for (let i = 0; i < existingRecords.length; i++) {
    const existing = existingRecords[i];
    const exName = normalizeName(existing[COL_ORGANIZATION]);
    const exPhone = normalizePhone(existing[COL_CONTACT_INFO]);
    const exDomain = normalizeDomain(existing[COL_WEBSITE]);
    const exLocation = existing[COL_LOCATION]
      ? String(existing[COL_LOCATION]).trim().toLowerCase()
      : '';

    // Signal 1: phone match — both are full 10-digit numbers and equal.
    if (inPhone.length === 10 && exPhone.length === 10 && inPhone === exPhone) {
      return {
        result: 'LIKELY_DUPLICATE',
        matchedRecord: existing,
        reason: 'Phone match (' + inPhone + ')'
      };
    }

    const nameSim = stringSimilarity(inName, exName);

    // Signal 2: same domain + reasonably similar name.
    if (inDomain && exDomain && inDomain === exDomain && nameSim > DOMAIN_NAME_THRESHOLD) {
      return {
        result: 'LIKELY_DUPLICATE',
        matchedRecord: existing,
        reason: 'Domain match (' + inDomain + ') with name similarity ' + nameSim.toFixed(2)
      };
    }

    // Signal 3: very similar name + same NJDPT Location → needs human review.
    if (nameSim > NAME_STRONG_THRESHOLD && inLocation && exLocation && inLocation === exLocation) {
      return {
        result: 'REVIEW',
        matchedRecord: existing,
        reason: 'Name similarity ' + nameSim.toFixed(2) + ' with same NJDPT Location'
      };
    }

    // Signal 4: very similar name alone → treat as distinct (different areas can be different orgs).
    if (nameSim > NAME_STRONG_THRESHOLD) {
      return {
        result: 'DISTINCT',
        matchedRecord: existing,
        reason: 'Name similarity ' + nameSim.toFixed(2) + ' but different NJDPT Location'
      };
    }
  }

  return {
    result: 'DISTINCT',
    matchedRecord: null,
    reason: 'No matching signals found'
  };
}

/**
 * Creates the "Review Queue" tab with its header row if it does not already exist.
 * Returns the Review Queue sheet.
 */
function setupReviewQueue() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(REVIEW_QUEUE_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(REVIEW_QUEUE_SHEET_NAME);
    sheet.getRange(1, 1, 1, REVIEW_QUEUE_HEADERS.length).setValues([REVIEW_QUEUE_HEADERS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * Reads every row of "Referral Tracker", checks each row against all earlier rows,
 * and writes any LIKELY_DUPLICATE or REVIEW hits to "Review Queue". Never modifies
 * the tracker — read-only there, write-only to Review Queue. Logs a summary.
 */
function runDedupOnSheet() {
  const reviewSheet = setupReviewQueue();

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tracker = ss.getSheetByName(TRACKER_SHEET_NAME);
  if (!tracker) {
    Logger.log('Sheet "' + TRACKER_SHEET_NAME + '" not found. Nothing to do.');
    return;
  }

  const values = tracker.getDataRange().getValues();
  if (values.length < 2) {
    Logger.log('No data rows in "' + TRACKER_SHEET_NAME + '".');
    return;
  }

  const headers = values[0];

  // Build an array of records (objects keyed by header) for each data row.
  const records = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const record = {};
    for (let c = 0; c < headers.length; c++) {
      record[headers[c]] = row[c];
    }
    records.push(record);
  }

  const flaggedRows = [];
  let checkedCount = 0;

  // Compare each record only against the ones before it (catches intra-dataset dupes once).
  for (let i = 0; i < records.length; i++) {
    checkedCount++;
    const priorRecords = records.slice(0, i);
    const outcome = checkDuplicate(records[i], priorRecords);

    if (outcome.result === 'LIKELY_DUPLICATE' || outcome.result === 'REVIEW') {
      const incoming = records[i];
      const matched = outcome.matchedRecord || {};
      flaggedRows.push([
        incoming[COL_ORGANIZATION] || '',
        normalizePhone(incoming[COL_CONTACT_INFO]),
        normalizeDomain(incoming[COL_WEBSITE]),
        matched[COL_ORGANIZATION] || '',
        normalizePhone(matched[COL_CONTACT_INFO]),
        normalizeDomain(matched[COL_WEBSITE]),
        outcome.result + ': ' + outcome.reason,
        '' // Decision — human fills this in.
      ]);
    }
  }

  // Append flagged rows below whatever is already in Review Queue.
  if (flaggedRows.length > 0) {
    const startRow = reviewSheet.getLastRow() + 1;
    reviewSheet
      .getRange(startRow, 1, flaggedRows.length, REVIEW_QUEUE_HEADERS.length)
      .setValues(flaggedRows);
  }

  Logger.log('Dedup complete. Rows checked: ' + checkedCount + ', rows flagged: ' + flaggedRows.length);
}

/**
 * Builds the normalized "smaller|larger" key for a pair of IDs so that a pair
 * always has one canonical representation regardless of comparison direction.
 */
function pairKey_(id1, id2) {
  const a = String(id1 || '');
  const b = String(id2 || '');
  return a <= b ? a + '|' + b : b + '|' + a;
}

/**
 * Reads and parses the DISMISSED_PAIRS Script Property into an array of
 * "id1|id2" keys. Returns [] if unset or malformed.
 */
function getDismissedPairs_() {
  const raw = PropertiesService.getScriptProperties().getProperty('DISMISSED_PAIRS');
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

/**
 * True if the given pair has been dismissed as "not a duplicate".
 */
function isPairDismissed_(id1, id2, dismissed) {
  return dismissed.indexOf(pairKey_(id1, id2)) !== -1;
}

/**
 * Read-only scan for the dashboard. Runs checkDuplicate across every row pair
 * and returns an array of flag objects for LIKELY_DUPLICATE / REVIEW hits,
 * skipping any pair the user has already dismissed. Never modifies the sheet.
 */
function getDuplicateFlags() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tracker = ss.getSheetByName(TRACKER_SHEET_NAME);
  if (!tracker) {
    return [];
  }

  const values = tracker.getDataRange().getValues();
  if (values.length < 2) {
    return [];
  }

  const headers = values[0];

  // Build header-keyed record objects, skipping fully blank rows.
  const records = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (!row.some(value => String(value).trim() !== '')) {
      continue;
    }
    const record = {};
    for (let c = 0; c < headers.length; c++) {
      record[headers[c]] = row[c];
    }
    records.push(record);
  }

  const dismissed = getDismissedPairs_();
  const flags = [];

  // Compare each record against the ones before it (each pair surfaces once).
  for (let i = 0; i < records.length; i++) {
    const priorRecords = records.slice(0, i);
    const outcome = checkDuplicate(records[i], priorRecords);

    if (outcome.result !== 'LIKELY_DUPLICATE' && outcome.result !== 'REVIEW') {
      continue;
    }

    const incoming = records[i];
    const matched = outcome.matchedRecord || {};
    const incomingId = String(incoming['ID'] || '');
    const matchedId = String(matched['ID'] || '');

    // Skip pairs the user has already resolved as "not a duplicate".
    if (isPairDismissed_(incomingId, matchedId, dismissed)) {
      continue;
    }

    flags.push({
      incomingId: incomingId,
      incomingOrg: String(incoming[COL_ORGANIZATION] || ''),
      incomingPhone: normalizePhone(incoming[COL_CONTACT_INFO]),
      incomingDomain: normalizeDomain(incoming[COL_WEBSITE]),
      matchedId: matchedId,
      matchedOrg: String(matched[COL_ORGANIZATION] || ''),
      matchedPhone: normalizePhone(matched[COL_CONTACT_INFO]),
      matchedDomain: normalizeDomain(matched[COL_WEBSITE]),
      reason: outcome.reason,
      result: outcome.result
    });
  }

  return flags;
}

/**
 * Records a pair as "not a duplicate" by appending its normalized key to the
 * DISMISSED_PAIRS Script Property (smaller ID first, deduplicated).
 * Returns { success: true }.
 */
function dismissPair(id1, id2) {
  const dismissed = getDismissedPairs_();
  const key = pairKey_(id1, id2);

  if (dismissed.indexOf(key) === -1) {
    dismissed.push(key);
    PropertiesService.getScriptProperties()
      .setProperty('DISMISSED_PAIRS', JSON.stringify(dismissed));
  }

  return { success: true };
}

/**
 * Deletes a single record from "Referral Tracker" by ID.
 * Returns { success: true }.
 */
function deleteFlaggedRecord(id) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(TRACKER_SHEET_NAME);
  if (!sheet) {
    throw new Error('Sheet "' + TRACKER_SHEET_NAME + '" not found.');
  }

  const row = findTrackerRowById_(sheet, id);
  if (!row) {
    throw new Error('Record not found.');
  }

  sheet.deleteRow(row);
  return { success: true };
}

/**
 * Finds the 1-based sheet row for a given ID in "Referral Tracker", or null.
 * Replicates the findRowById_ pattern from Code.gs (kept local, not imported).
 */
function findTrackerRowById_(sheet, id) {
  if (!id || sheet.getLastRow() < 2) {
    return null;
  }

  const ids = sheet
    .getRange(2, 1, sheet.getLastRow() - 1, 1)
    .getDisplayValues()
    .flat();

  const index = ids.findIndex(value => String(value) === String(id));
  return index === -1 ? null : index + 2;
}
