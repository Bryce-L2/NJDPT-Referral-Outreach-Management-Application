/**
 * History.gs
 * Audit trail for deleted "Referral Tracker" records so they can be reviewed and
 * restored. Additive only — does not modify Code.gs or Dedup.gs. Reuses HEADERS,
 * saveReferralRecord, and other globals from Code.gs (reads/calls them, never edits).
 */

const DELETED_HISTORY_SHEET_NAME = 'Deleted History';

// Metadata columns kept in front of the archived record fields.
const HISTORY_META_HEADERS = ['History ID', 'Deleted At', 'Deleted By', 'Status', 'Restored At'];

// The full header row for the history sheet: metadata + every Referral Tracker field.
function historyHeaders_() {
  return HISTORY_META_HEADERS.concat(HEADERS);
}

// Creates the "Deleted History" tab with its header row if it doesn't exist.
function setupDeletedHistory() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(DELETED_HISTORY_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(DELETED_HISTORY_SHEET_NAME);
    const headers = historyHeaders_();
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// Archives one record (object keyed by the Referral Tracker headers) to the
// Deleted History tab, stamped with time + user. Called just before a row is deleted.
function archiveDeletedRecord(record) {
  const sheet = setupDeletedHistory();
  const headers = historyHeaders_();

  let deletedBy = '';
  try {
    deletedBy = Session.getActiveUser().getEmail() || '';
  } catch (e) {
    deletedBy = '';
  }

  const meta = {
    'History ID': Utilities.getUuid(),
    'Deleted At': new Date(),
    'Deleted By': deletedBy,
    'Status': 'Deleted',
    'Restored At': ''
  };

  const row = headers.map(header => {
    if (Object.prototype.hasOwnProperty.call(meta, header)) {
      return meta[header];
    }
    return (record && record[header] != null) ? record[header] : '';
  });

  sheet.appendRow(row);
  return { success: true, historyId: meta['History ID'] };
}

// Returns all archived deletions, newest first, as objects keyed by the history headers.
function getDeletedHistory() {
  const sheet = setupDeletedHistory();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return [];
  }

  const headers = historyHeaders_();
  const values = sheet.getRange(2, 1, lastRow - 1, headers.length).getDisplayValues();

  const rows = values
    .filter(row => row.some(value => String(value).trim() !== ''))
    .map(row => {
      const entry = {};
      headers.forEach((header, index) => {
        entry[header] = row[index] || '';
      });
      return entry;
    });

  return rows.reverse();
}

// Restores a previously deleted record into "Referral Tracker" and marks the
// history row as restored. Returns { success: true }.
function restoreDeletedRecord(historyId) {
  const sheet = setupDeletedHistory();
  const headers = historyHeaders_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    throw new Error('No deleted history to restore from.');
  }

  const idColIndex = headers.indexOf('History ID');
  const ids = sheet.getRange(2, idColIndex + 1, lastRow - 1, 1).getDisplayValues().flat();
  const offset = ids.findIndex(value => String(value) === String(historyId));
  if (offset === -1) {
    throw new Error('History entry not found.');
  }

  const rowNumber = offset + 2;
  const rowValues = sheet.getRange(rowNumber, 1, 1, headers.length).getValues()[0];

  // Rebuild the original record from the archived record-field columns.
  const record = {};
  HEADERS.forEach(header => {
    const colIndex = headers.indexOf(header);
    record[header] = colIndex === -1 ? '' : rowValues[colIndex];
  });

  // Re-add to the tracker (saveReferralRecord from Code.gs keeps the original ID).
  saveReferralRecord(record);

  // Mark this history row as restored (keeps the audit trail rather than deleting it).
  sheet.getRange(rowNumber, headers.indexOf('Status') + 1).setValue('Restored');
  sheet.getRange(rowNumber, headers.indexOf('Restored At') + 1).setValue(new Date());

  return { success: true, id: record['ID'] || '' };
}
