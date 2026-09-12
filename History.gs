/**
 * History.gs
 * Audit trail for deleted "Referral Tracker" records so they can be reviewed and
 * restored. Reuses HEADERS, saveReferralRecord, findRowById_, setupReferralTracker
 * from Code.gs.
 */

const DELETED_HISTORY_SHEET_NAME = 'Deleted History';

// Metadata columns kept in front of the archived record fields.
// 'History Status' (NOT 'Status') so it never collides with the record's own
// 'Status' field that comes from HEADERS.
const HISTORY_META_HEADERS = ['History ID', 'Deleted At', 'Deleted By', 'History Status', 'Restored At'];

function historyHeaders_() {
  return HISTORY_META_HEADERS.concat(HEADERS);
}

// Creates the "Deleted History" tab if missing; otherwise migrates an older
// header row (e.g. the meta column previously named 'Status') to current names.
function setupDeletedHistory() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(DELETED_HISTORY_SHEET_NAME);
  const headers = historyHeaders_();

  if (!sheet) {
    sheet = ss.insertSheet(DELETED_HISTORY_SHEET_NAME);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    return sheet;
  }

  // Only the header cell names change; data columns keep their positions,
  // so existing rows stay valid.
  const existing = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  const mismatch = headers.some((h, i) => String(existing[i]).trim() !== h);
  if (mismatch) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  return sheet;
}

// Archives one record to the Deleted History tab, stamped with time + user.
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
    'History Status': 'Deleted',
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

// Returns still-deleted records, newest first. Restored records drop out of the list.
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
    })
    // Once a record is restored it is no longer "deleted" — hide it from the list.
    .filter(entry => String(entry['History Status']).toLowerCase() !== 'restored');

  return rows.reverse();
}

// Restores a deleted record into "Referral Tracker" and marks the history row restored.
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

  // If a record with this ID still exists in the tracker (e.g. the surviving half
  // of a duplicate pair that shared the same ID), restore as a NEW row instead of
  // overwriting that record.
  const tracker = setupReferralTracker();
  if (record['ID'] && findRowById_(tracker, record['ID'])) {
    record['ID'] = '';
  }

  const saved = saveReferralRecord(record);

  // Mark this history row restored: it leaves the active list but stays in the
  // sheet as an audit trail.
  sheet.getRange(rowNumber, headers.indexOf('History Status') + 1).setValue('Restored');
  sheet.getRange(rowNumber, headers.indexOf('Restored At') + 1).setValue(new Date());

  return { success: true, id: saved.id };
}
