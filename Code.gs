const SHEET_NAME = 'Referral Tracker';

 const HEADERS = [
   'ID',
   'Organization',
   'Category',
   'NJDPT Location',
   'Nearest Clinic (auto)',
   'Distance',
   'Address',
   'Latitude',
   'Longitude',
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

// One round-trip that returns everything the dashboard needs on load.
function getInitialData() {
  return {
    records: getReferralRecords(),
    summary: getDashboardSummary(),
    duplicateFlags: getDuplicateFlags()
  };
}

function doGet() {
  setupReferralTracker();
  return HtmlService.createTemplateFromFile('Dashboard')
    .evaluate()
    .setTitle('NJDPT Community & Referral Relationship Finder')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

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
    // Column positions come from HEADERS so they survive column additions.
    // (Date Added + Last Updated are adjacent; Last Contact + Follow-Up Date are adjacent.)
    const dtCol = HEADERS.indexOf('Date Added') + 1;
    const dCol = HEADERS.indexOf('Last Contact') + 1;
    sheet.getRange(1, dtCol, sheet.getMaxRows(), 2).setNumberFormat('m/d/yyyy h:mm am/pm');
    sheet.getRange(1, dCol, sheet.getMaxRows(), 2).setNumberFormat('m/d/yyyy');
    sheet.autoResizeColumns(1, HEADERS.length);
  }

  return sheet;
}

// One-time migration: adds the geocoding columns (Address, Latitude, Longitude)
// to an existing "Referral Tracker" sheet. Inserts each missing column in its
// correct position per HEADERS so existing row data shifts intact — no full-sheet
// rewrite, nothing deleted or reordered. Idempotent: a second run does nothing.
// Run once manually from the editor after deploying the HEADERS change.
function migrateAddGeoColumns() {
  const sheet = setupReferralTracker();
  const newHeaders = ['Nearest Clinic (auto)', 'Address', 'Latitude', 'Longitude'];
  const added = [];

  newHeaders.forEach(header => {
    // Re-read the header row each pass — a prior insert shifts the columns.
    const current = sheet
      .getRange(1, 1, 1, sheet.getLastColumn())
      .getValues()[0]
      .map(String);

    if (current.indexOf(header) !== -1) {
      return; // already present — idempotent, nothing to do
    }

    // Insert right after the nearest header that precedes this one in HEADERS
    // and actually exists in the sheet today (handles them one at a time in order).
    const headerPos = HEADERS.indexOf(header);
    let insertAfterCol = 0;
    for (let i = headerPos - 1; i >= 0; i--) {
      const col = current.indexOf(HEADERS[i]);
      if (col !== -1) {
        insertAfterCol = col + 1; // 1-based column of the predecessor
        break;
      }
    }
    if (insertAfterCol === 0) {
      insertAfterCol = sheet.getLastColumn(); // safe fallback: append at far right
    }

    sheet.insertColumnAfter(insertAfterCol);
    sheet.getRange(1, insertAfterCol + 1).setValue(header);
    added.push(header);
  });

  // Re-apply header styling so the new header cells match the navy row.
  formatHeader_(sheet);

  if (added.length) {
    Logger.log('migrateAddGeoColumns: added column(s) → ' + added.join(', '));
  } else {
    Logger.log('migrateAddGeoColumns: no changes — all geo columns already present.');
  }

  return { success: true, added: added };
}

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

  // rowData maps over HEADERS, so new columns flow through automatically. Address
  // comes from the form; Latitude, Longitude, and Nearest Clinic (auto) are written
  // by the resolver and are NOT in the form — so on edit we PRESERVE whatever is
  // already in the sheet for those instead of blanking them.
  const preserveOnEdit = ['Latitude', 'Longitude', 'Nearest Clinic (auto)'];
  const rowData = HEADERS.map(header => {
    if (header === 'ID') return id;
    if (header === 'Date Added') return existingDateAdded || now;
    if (header === 'Last Updated') return now;

    if (preserveOnEdit.indexOf(header) !== -1 && existingRow
        && !String(record[header] ?? '').trim()) {
      return sheet.getRange(existingRow, HEADERS.indexOf(header) + 1).getValue();
    }

    const value = record[header] ?? '';

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

  const targetRow = existingRow || sheet.getLastRow();

  // Format only the row we just wrote (fast) instead of reformatting the whole sheet.
  sheet.getRange(targetRow, 1, 1, HEADERS.length)
    .setVerticalAlignment('top')
    .setWrap(true);
  sheet.getRange(targetRow, HEADERS.indexOf('Last Contact') + 1, 1, 2).setNumberFormat('m/d/yyyy');
  sheet.getRange(targetRow, HEADERS.indexOf('Date Added') + 1, 1, 2).setNumberFormat('m/d/yyyy h:mm am/pm');

  // Auto-resolve this org (find office → nearest clinic → driving distance) when it
  // has no coordinates yet. Set the id first so the resolver can locate the row we
  // just wrote. No-ops instantly until MAPS_API_KEY is set, and skips orgs that are
  // already resolved, so a plain edit never burns an API call. (resolveOnSave, Geo.gs)
  record['ID'] = id;
  try {
    resolveOnSave(record);
  } catch (e) {
    Logger.log('resolveOnSave skipped: ' + e);
  }

  return { success: true, id: id };
}

// Checks a NEW record for duplicates before saving. Edits (records that already have
// an ID) skip the check entirely. Returns { status: 'saved', id } when written, or
// { status: 'duplicate', ... } when a likely/review match is found (nothing written).
function checkAndSaveRecord(record) {
  const hasId = record && String(record['ID'] || '').trim() !== '';

  if (!hasId) {
    const existingRecords = getReferralRecords();
    const outcome = checkDuplicate(record, existingRecords); // from Dedup.gs

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

function deleteReferralRecord(id) {
  const sheet = setupReferralTracker();
  const row = findRowById_(sheet, id);

  if (!row) {
    throw new Error('Record not found.');
  }

  // Archive a copy to Deleted History before removing the row.
  const values = sheet.getRange(row, 1, 1, HEADERS.length).getValues()[0];
  const record = {};
  HEADERS.forEach((header, index) => {
    record[header] = values[index];
  });
  archiveDeletedRecord(record);

  sheet.deleteRow(row);
  return { success: true };
}

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

function parseDate_(value) {
  if (!value) return '';

  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value)) {
    return value;
  }

  // Date-only strings like "2026-08-15" (from <input type="date">) must be parsed as
  // LOCAL midnight, not UTC — otherwise a behind-UTC timezone shifts them a day earlier.
  const text = String(value).trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) {
    return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  }

  const parsed = new Date(text);
  return isNaN(parsed.getTime()) ? '' : parsed;
}

function formatHeader_(sheet) {
  sheet
    .getRange(1, 1, 1, HEADERS.length)
    .setFontWeight('bold')
    .setBackground('#1f4e78')
    .setFontColor('#ffffff')
    .setHorizontalAlignment('center');
}

function applyRowFormatting_(sheet) {
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) return;

  sheet.getRange(2, 1, lastRow - 1, HEADERS.length)
    .setVerticalAlignment('top')
    .setWrap(true);

  sheet.getRange(2, HEADERS.indexOf('Last Contact') + 1, lastRow - 1, 2).setNumberFormat('m/d/yyyy');
  sheet.getRange(2, HEADERS.indexOf('Date Added') + 1, lastRow - 1, 2).setNumberFormat('m/d/yyyy h:mm am/pm');
  sheet.autoResizeColumns(1, HEADERS.length);
}
