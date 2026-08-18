// ─── Configuration ───────────────────────────────────────────────────────────

const SHEET_NAME = 'Referral Tracker';

// Column order matters — the Sheet and all read/write logic depend on this sequence.
const HEADERS = [
  'ID',
  'Organization',
  'Category',
  'NJDPT Location',
  'Distance',
  'Contact Person',
  'Contact Information',
  'Contact Method',
  'Website',
  'Outreach Opportunity',
  'Last Contact',
  'Follow-Up Date',
  'Status',
  'Relationship Value',
  'Connection Successful',
  'Outcome',
  'Estimated ROI',
  'Notes',
  'Date Added',
  'Last Updated'
];

// ─── Entry Point ─────────────────────────────────────────────────────────────

// Serves the Dashboard HTML page when the web app URL is opened.
function doGet() {
  setupReferralTracker();
  return HtmlService.createTemplateFromFile('Dashboard')
    .evaluate()
    .setTitle('NJDPT Community & Referral Relationship Finder')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ─── Sheet Setup ─────────────────────────────────────────────────────────────

// Creates the Referral Tracker tab with headers and formatting if it doesn't exist.
// Safe to call multiple times — checks before doing anything.
function setupReferralTracker() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(SHEET_NAME);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(SHEET_NAME);
  }

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    formatHeader_(sheet);
    sheet.setFrozenRows(1);
    sheet.getRange('S:T').setNumberFormat('m/d/yyyy h:mm am/pm');
    sheet.getRange('K:L').setNumberFormat('m/d/yyyy');
    sheet.autoResizeColumns(1, HEADERS.length);
  }

  return sheet;
}

// ─── Data Access ─────────────────────────────────────────────────────────────

// Reads all non-blank rows from the Sheet and returns them as an array of
// objects keyed by HEADERS. Called by the frontend on every page load.
function getReferralRecords() {
  const sheet = setupReferralTracker();
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return [];
  }

  const values = sheet
    .getRange(2, 1, lastRow - 1, HEADERS.length)
    .getDisplayValues();

  return values
    .filter(row => row.some(value => String(value).trim() !== ''))
    .map(row => {
      const record = {};
      HEADERS.forEach((header, index) => {
        record[header] = row[index] || '';
      });
      return record;
    });
}

// Writes one record to the Sheet. Updates the existing row if the ID is found,
// appends a new row otherwise. Always stamps Last Updated; preserves Date Added.
function saveReferralRecord(record) {
  if (!record || !String(record['Organization'] || '').trim()) {
    throw new Error('Organization is required.');
  }

  const sheet = setupReferralTracker();
  const now = new Date();
  const id = String(record['ID'] || '').trim() || Utilities.getUuid();

  const existingRow = findRowById_(sheet, id);
  const existingDateAdded = existingRow
    ? sheet.getRange(existingRow, HEADERS.indexOf('Date Added') + 1).getValue()
    : now;

  const rowData = HEADERS.map(header => {
    if (header === 'ID') return id;
    if (header === 'Date Added') return existingDateAdded || now;
    if (header === 'Last Updated') return now;

    const value = record[header] ?? '';

    // Parse date strings as local midnight to avoid UTC timezone shift.
    if ((header === 'Last Contact' || header === 'Follow-Up Date') && value) {
      return parseDate_(value);
    }

    return value;
  });

  if (existingRow) {
    sheet.getRange(existingRow, 1, 1, HEADERS.length).setValues([rowData]);
  } else {
    sheet.appendRow(rowData);
  }

  applyRowFormatting_(sheet);
  return { success: true, id: id };
}

// Runs a duplicate check before saving a new record. Edits (records with an
// existing ID) skip the check entirely. Returns { status: 'saved' } on success
// or { status: 'duplicate', ... } when a match is found — nothing is written
// in the duplicate case, letting the frontend prompt the user.
function checkAndSaveRecord(record) {
  const hasId = record && String(record['ID'] || '').trim() !== '';

  if (!hasId) {
    const existingRecords = getReferralRecords();
    const outcome = checkDuplicate(record, existingRecords); // defined in Dedup.gs

    if (outcome.result === 'LIKELY_DUPLICATE' || outcome.result === 'REVIEW') {
      const matched = outcome.matchedRecord || {};
      return {
        status: 'duplicate',
        result: outcome.result,
        reason: outcome.reason,
        matchedOrg: matched['Organization'] || '',
        matchedId: matched['ID'] || ''
      };
    }
  }

  const saved = saveReferralRecord(record);
  return { status: 'saved', id: saved.id };
}

// Archives the record to Deleted History, then removes the row from the Sheet.
function deleteReferralRecord(id) {
  const sheet = setupReferralTracker();
  const row = findRowById_(sheet, id);

  if (!row) {
    throw new Error('Record not found.');
  }

  // Read the full row into an object before deleting so it can be archived.
  const values = sheet.getRange(row, 1, 1, HEADERS.length).getValues()[0];
  const record = {};
  HEADERS.forEach((header, index) => {
    record[header] = values[index];
  });
  archiveDeletedRecord(record); // defined in History.gs

  sheet.deleteRow(row);
  return { success: true };
}

// Returns the four summary counts shown on the dashboard cards.
function getDashboardSummary() {
  const records = getReferralRecords();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let followUpsDue = 0;
  let successfulConnections = 0;
  let activeRelationships = 0;

  records.forEach(record => {
    const followUp = parseDate_(record['Follow-Up Date']);
    if (followUp && followUp <= today) {
      followUpsDue++;
    }

    if (String(record['Connection Successful']).toLowerCase() === 'yes') {
      successfulConnections++;
    }

    if (String(record['Status']).toLowerCase() === 'active relationship') {
      activeRelationships++;
    }
  });

  return {
    total: records.length,
    followUpsDue: followUpsDue,
    successfulConnections: successfulConnections,
    activeRelationships: activeRelationships
  };
}

// ─── Dev / Setup Utilities ───────────────────────────────────────────────────

// Seeds two example rows for testing. Run once manually from the editor.
function seedSampleData() {
  const sampleRecords = [
    {
      'Organization': 'ABC Orthopedics',
      'Category': 'Physician Practice',
      'NJDPT Location': 'Wayne',
      'Distance': '2.1 mi',
      'Contact Person': 'Office Manager',
      'Contact Information': 'Public phone/email',
      'Contact Method': 'Email',
      'Website': 'https://www.example.com',
      'Outreach Opportunity': 'Physician introduction',
      'Last Contact': '',
      'Follow-Up Date': '',
      'Status': 'New Opportunity',
      'Relationship Value': 'High',
      'Connection Successful': 'Pending',
      'Outcome': 'Pending',
      'Estimated ROI': '',
      'Notes': 'Identified through public research.'
    },
    {
      'Organization': 'Wayne Senior Center',
      'Category': 'Senior Center',
      'NJDPT Location': 'Wayne',
      'Distance': '1.4 mi',
      'Contact Person': 'Program Director',
      'Contact Information': 'Public phone/email',
      'Contact Method': 'Phone',
      'Website': 'https://www.example.com',
      'Outreach Opportunity': 'Fall prevention presentation',
      'Last Contact': '2026-07-15',
      'Follow-Up Date': '2026-08-05',
      'Status': 'Follow-Up Needed',
      'Relationship Value': 'Medium',
      'Connection Successful': 'Yes',
      'Outcome': 'Presentation Scheduled',
      'Estimated ROI': 'Community visibility',
      'Notes': 'Interested in scheduling a community presentation.'
    }
  ];

  sampleRecords.forEach(saveReferralRecord);
  return { success: true, count: sampleRecords.length };
}

// ─── Private Helpers ─────────────────────────────────────────────────────────

// Returns the 1-based row number for a given ID, or null if not found.
function findRowById_(sheet, id) {
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

// Converts a value to a Date object. Date-only strings (YYYY-MM-DD) are parsed
// as local midnight to prevent UTC timezone from shifting them a day earlier.
function parseDate_(value) {
  if (!value) return '';

  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value)) {
    return value;
  }

  const text = String(value).trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) {
    return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  }

  const parsed = new Date(text);
  return isNaN(parsed.getTime()) ? '' : parsed;
}

// Applies navy header styling to row 1.
function formatHeader_(sheet) {
  sheet
    .getRange(1, 1, 1, HEADERS.length)
    .setFontWeight('bold')
    .setBackground('#1f4e78')
    .setFontColor('#ffffff')
    .setHorizontalAlignment('center');
}

// Applies consistent formatting to all data rows after a write.
function applyRowFormatting_(sheet) {
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) return;

  sheet.getRange(2, 1, lastRow - 1, HEADERS.length)
    .setVerticalAlignment('top')
    .setWrap(true);

  sheet.getRange(2, 11, lastRow - 1, 2).setNumberFormat('m/d/yyyy');
  sheet.getRange(2, 19, lastRow - 1, 2).setNumberFormat('m/d/yyyy h:mm am/pm');
  sheet.autoResizeColumns(1, HEADERS.length);
}
