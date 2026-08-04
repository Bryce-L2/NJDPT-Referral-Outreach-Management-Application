/**
 * Reminders.gs
 * Daily follow-up reminder emails + admin access control for the "Referral Tracker".
 * Self-contained: reads the sheet directly, no imports from other .gs files,
 * no external libraries. Email HTML uses inline styles + table layout only.
 */

const REMINDERS_SHEET_NAME = 'Referral Tracker';

// ===========================================================================
// ADMIN ACCESS CONTROL
// Only these emails can see the Admin/History tools and run admin-only functions.
// EDIT THIS LIST to grant or revoke admin rights. Case-insensitive.
// (This is separate from ADMIN_EMAILS, which is just who RECEIVES reminder emails.)
// ===========================================================================
const ADMIN_ACCESS_EMAILS = [
  'bryce.lombardo09@gmail.com',
  'kweite@njdpt.com'
];

// Returns { email, isAdmin } for the current user. The dashboard calls this on load
// to decide whether to show admin tools. Enforcement also happens server-side below.
function getUserContext() {
  let email = '';
  try {
    email = Session.getActiveUser().getEmail() || '';
  } catch (e) {
    email = '';
  }
  return { email: email, isAdmin: isAdminUser_(email) };
}

// True if the given email (defaults to the active user) is in the admin whitelist.
function isAdminUser_(email) {
  let target = email;
  if (!target) {
    try {
      target = Session.getActiveUser().getEmail() || '';
    } catch (e) {
      target = '';
    }
  }
  target = String(target).trim().toLowerCase();
  if (!target) {
    return false;
  }
  return ADMIN_ACCESS_EMAILS.some(admin => String(admin).trim().toLowerCase() === target);
}

// Throws if the current user is not an admin. Guards admin-only backend functions.
function requireAdmin_() {
  if (!isAdminUser_()) {
    throw new Error('Not authorized: admin access required.');
  }
}

// ===========================================================================
// REMINDER RECIPIENT LIST (who gets the daily email)
// ===========================================================================

// Reads the ADMIN_EMAILS Script Property and returns it as an array of email
// strings. Returns [] if unset or malformed.
function getAdminEmails() {
  const raw = PropertiesService.getScriptProperties().getProperty('ADMIN_EMAILS');
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

// Writes an array of reminder-recipient emails to the ADMIN_EMAILS Script Property.
// Admin-only. Returns { success: true }.
function setAdminEmails(emailsArray) {
  requireAdmin_();
  const clean = Array.isArray(emailsArray)
    ? emailsArray.map(email => String(email).trim()).filter(Boolean)
    : [];
  PropertiesService.getScriptProperties().setProperty('ADMIN_EMAILS', JSON.stringify(clean));
  return { success: true };
}

// ===========================================================================
// FOLLOW-UP REMINDER EMAIL
// ===========================================================================

// Finds due follow-ups in "Referral Tracker" and emails a summary to every admin.
// A row is "due" when Follow-Up Date is filled and today-or-earlier, and Status is
// neither "Not Pursuing" nor "Active Relationship". Sends nothing if none are due.
function sendFollowUpReminders() {
  const admins = getAdminEmails();
  if (!admins.length) {
    Logger.log('No admin emails configured');
    return;
  }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REMINDERS_SHEET_NAME);
  if (!sheet) {
    Logger.log('Sheet "' + REMINDERS_SHEET_NAME + '" not found');
    return;
  }

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) {
    Logger.log('No follow-ups due today');
    return;
  }

  // Map column name -> index from the header row (self-contained, no HEADERS import).
  const headers = data[0];
  const col = {};
  headers.forEach((header, index) => { col[String(header).trim()] = index; });

  const today = new Date();
  const offset = today.getTimezoneOffset() * 60000;
  const localToday = new Date(today.getTime() - offset);
  localToday.setHours(0, 0, 0, 0);

  const excludedStatuses = ['not pursuing', 'active relationship'];
  const due = [];

  for (let r = 1; r < data.length; r++) {
    const row = data[r];

    const followUp = reminders_parseDate_(row[col['Follow-Up Date']]);
    if (!followUp) {
      continue;
    }
    followUp.setHours(0, 0, 0, 0);
    if (followUp > today) {
      continue;
    }

    const status = String(row[col['Status']] || '').trim();
    if (excludedStatuses.indexOf(status.toLowerCase()) !== -1) {
      continue;
    }

    due.push({
      organization: row[col['Organization']],
      category: row[col['Category']],
      location: row[col['NJDPT Location']],
      followUpDate: row[col['Follow-Up Date']],
      status: status,
      lastContact: row[col['Last Contact']],
      opportunity: row[col['Outreach Opportunity']],
      notes: row[col['Notes']]
    });
  }

  if (!due.length) {
    Logger.log('No follow-ups due today');
    return;
  }

  const todayLabel = reminders_formatDate_(today);
  const subject = 'NJDPT Follow-Up Reminder — ' + due.length
    + ' due today (' + todayLabel + ')';
  const htmlBody = reminders_buildEmailHtml_(due, todayLabel);

  admins.forEach(email => {
    MailApp.sendEmail({ to: email, subject: subject, htmlBody: htmlBody });
  });

  Logger.log('Sent ' + admins.length + ' reminder email(s) to: ' + admins.join(', '));
}

// Creates the daily 7am trigger for sendFollowUpReminders, but only if one does not
// already exist. Returns { success: true }.
function setupDailyTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  const exists = triggers.some(trigger => trigger.getHandlerFunction() === 'sendFollowUpReminders');

  if (exists) {
    Logger.log('Trigger already set');
    return { success: true };
  }

  ScriptApp.newTrigger('sendFollowUpReminders')
    .timeBased()
    .everyDays(1)
    .atHour(7)
    .create();

  return { success: true };
}

// One-time setup entry point: wires up the daily trigger. Run this manually once.
function initReminders() {
  setupDailyTrigger();
  Logger.log('Reminder system initialized');
}

// ---------------------------------------------------------------------------
// Private helpers (prefixed to avoid clashing with functions in other files)
// ---------------------------------------------------------------------------

// Parses a cell value into a valid Date, or returns null.
function reminders_parseDate_(value) {
  if (!value) {
    return null;
  }
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return isNaN(value.getTime()) ? null : new Date(value.getTime());
  }
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? null : parsed;
}

// Formats a date value as M/d/yyyy in the script's timezone; passes through
// non-date strings unchanged and returns '' for blanks.
function reminders_formatDate_(value) {
  const date = reminders_parseDate_(value);
  if (!date) {
    return value ? String(value) : '';
  }
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'M/d/yyyy');
}

// Escapes text so it can't break the email HTML.
function reminders_escapeHtml_(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Truncates a string to a max length, adding an ellipsis when cut.
function reminders_truncate_(value, max) {
  const text = String(value == null ? '' : value).trim();
  if (text.length <= max) {
    return text;
  }
  return text.slice(0, max).trimEnd() + '…';
}

// Returns an inline-styled status badge span for the email.
function reminders_statusBadge_(status) {
  const clean = String(status || '').trim();
  const styles = {
    'New Opportunity':     'background:#f1f3f5;color:#4a5568;',
    'Contacted':           'background:#dbeafe;color:#1e40af;',
    'Follow-Up Needed':    'background:#fef3c7;color:#92400e;',
    'Active Relationship': 'background:#d1fae5;color:#065f46;',
    'Not Pursuing':        'background:#fee2e2;color:#991b1b;'
  };
  const style = styles[clean] || 'background:#f1f3f5;color:#4a5568;';
  return '<span style="display:inline-block;padding:2px 10px;border-radius:12px;'
    + 'font-size:12px;font-weight:bold;font-family:Arial,Helvetica,sans-serif;' + style + '">'
    + reminders_escapeHtml_(clean || '—') + '</span>';
}

// Renders one label/value row inside a card.
function reminders_fieldRow_(label, value) {
  const shown = (value == null || String(value).trim() === '')
    ? '—'
    : reminders_escapeHtml_(value);
  return '<tr>'
    + '<td style="padding:3px 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;'
    + 'color:#6b7a8d;width:150px;vertical-align:top;">' + reminders_escapeHtml_(label) + '</td>'
    + '<td style="padding:3px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;'
    + 'color:#1a2330;vertical-align:top;">' + shown + '</td>'
    + '</tr>';
}

// Builds one org card as a table row.
function reminders_buildCard_(item) {
  let fields = '';
  fields += reminders_fieldRow_('Category', item.category);
  fields += reminders_fieldRow_('NJDPT Location', item.location);
  fields += reminders_fieldRow_('Follow-Up Date', reminders_formatDate_(item.followUpDate));
  fields += reminders_fieldRow_('Last Contact', reminders_formatDate_(item.lastContact));
  fields += reminders_fieldRow_('Outreach Opportunity', item.opportunity);
  fields += reminders_fieldRow_('Notes', reminders_truncate_(item.notes, 120));

  const orgName = reminders_escapeHtml_(item.organization || 'Untitled');

  return ''
    + '<tr><td style="padding:8px 24px;">'
    + '<table width="100%" cellpadding="0" cellspacing="0" border="0" '
    + 'style="border:1px solid #d0dae6;border-radius:8px;background:#ffffff;">'
    + '<tr><td style="padding:14px 16px;">'
    + '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;'
    + 'color:#163a5f;">' + orgName + '</div>'
    + '<div style="margin:6px 0 10px;">' + reminders_statusBadge_(item.status) + '</div>'
    + '<table width="100%" cellpadding="0" cellspacing="0" border="0">' + fields + '</table>'
    + '</td></tr></table>'
    + '</td></tr>';
}

// Assembles the full inline-styled, table-based HTML email body.
function reminders_buildEmailHtml_(due, todayLabel) {
  const plural = due.length === 1 ? '' : 's';

  let cards = '';
  due.forEach(item => { cards += reminders_buildCard_(item); });

  return ''
    + '<table width="100%" cellpadding="0" cellspacing="0" border="0" '
    + 'style="background:#f0f4f8;margin:0;padding:0;">'
    + '<tr><td align="center" style="padding:24px 12px;">'

    + '<table width="600" cellpadding="0" cellspacing="0" border="0" '
    + 'style="width:600px;max-width:600px;background:#ffffff;border-radius:10px;overflow:hidden;'
    + 'border:1px solid #d0dae6;">'

    + '<tr><td style="background:#163a5f;padding:20px 24px;">'
    + '<div style="font-family:Arial,Helvetica,sans-serif;font-size:18px;font-weight:bold;'
    + 'color:#ffffff;">NJDPT Community &amp; Referral Relationship Finder</div>'
    + '<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;'
    + 'color:#c7d3e0;margin-top:4px;">Follow-Up Reminders</div>'
    + '</td></tr>'

    + '<tr><td style="padding:18px 24px 4px;font-family:Arial,Helvetica,sans-serif;'
    + 'font-size:14px;color:#1a2330;">You have <b>' + due.length + '</b> follow-up' + plural
    + ' due as of ' + reminders_escapeHtml_(todayLabel) + '.</td></tr>'

    + cards

    + '<tr><td style="padding:14px 24px 22px;font-family:Arial,Helvetica,sans-serif;'
    + 'font-size:12px;color:#6b7a8d;border-top:1px solid #eef1f5;">'
    + 'This is an automated reminder from the NJDPT Referral Tracker.</td></tr>'

    + '</table>'
    + '</td></tr></table>';
}
