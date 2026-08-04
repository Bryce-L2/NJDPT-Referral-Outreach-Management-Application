const SHEET_NAME = 'Referral Tracker';

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
    sheet.getRange('S:T').setNumberFormat('m/d/yyyy h:mm am/pm');
    sheet.getRange('K:L').setNumberFormat('m/d/yyyy');
    sheet.autoResizeColumns(1, HEADERS.length);
  }

  return sheet;
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

  const rowData = HEADERS.map(header => {
    if (header === 'ID') return id;
    if (header === 'Date Added') return existingDateAdded || now;
    if (header === 'Last Updated') return now;

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

  applyRowFormatting_(sheet);
  return { success: true, id: id };
}

function deleteReferralRecord(id) {
  const sheet = setupReferralTracker();
  const row = findRowById_(sheet, id);

  if (!row) {
    throw new Error('Record not found.');
  }

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

  sheet.getRange(2, 11, lastRow - 1, 2).setNumberFormat('m/d/yyyy');
  sheet.getRange(2, 19, lastRow - 1, 2).setNumberFormat('m/d/yyyy h:mm am/pm');
  sheet.autoResizeColumns(1, HEADERS.length);
}
