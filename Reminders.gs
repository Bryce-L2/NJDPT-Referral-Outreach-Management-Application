/**
 * Reminders.gs
 * Weekly outreach digest emailed to a hard-coded admin list every Monday at 7am.
 * Self-contained: reads the sheet directly, no imports from other .gs files,
 * no external libraries. Email HTML uses inline styles + table layout only.
 */

const REMINDERS_SHEET_NAME = 'Referral Tracker';

// ===========================================================================
// ADMINS — the only people who receive the weekly digest.
// EDIT THIS LIST to add or remove admins. This is the only place it is set.
// ===========================================================================
const ADMIN_EMAILS = [
  'kweite@njdpt.com',
  'lmanko@njdpt.com'
];

// Builds and sends the weekly outreach digest to every admin. Four sections:
// Due Today, Due Tomorrow, Due Later This Week, and Completed This Week.
function sendWeeklyDigest() {
  const admins = ADMIN_EMAILS.map(e => String(e).trim()).filter(Boolean);
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

  // Build header-keyed records (empty rows skipped).
  const records = [];
  if (data.length >= 2) {
    const headers = data[0];
    const col = {};
    headers.forEach((h, i) => { col[String(h).trim()] = i; });

    for (let r = 1; r < data.length; r++) {
      const row = data[r];
      if (!row.some(v => String(v).trim() !== '')) continue;
      records.push({
        organization: row[col['Organization']],
        category: row[col['Category']],
        location: row[col['NJDPT Location']],
        followUp: reminders_parseDate_(row[col['Follow-Up Date']]),
        lastContact: row[col['Last Contact']],
        lastContactDate: reminders_parseDate_(row[col['Last Contact']]),
        status: String(row[col['Status']] || '').trim(),
        connection: String(row[col['Connection Successful']] || '').trim(),
        opportunity: row[col['Outreach Opportunity']],
        notes: row[col['Notes']]
      });
    }
  }

  // Date boundaries (all at local midnight).
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
  const day2 = new Date(today); day2.setDate(day2.getDate() + 2);
  const day7 = new Date(today); day7.setDate(day7.getDate() + 7);
  const past7 = new Date(today); past7.setDate(past7.getDate() - 7);

  const dueToday = [], dueTomorrow = [], dueLater = [], completed = [];

  records.forEach(item => {
    const fu = reminders_atMidnight_(item.followUp);
    if (fu) {
      if (fu.getTime() === today.getTime()) {
        dueToday.push(item);
      } else if (fu.getTime() === tomorrow.getTime()) {
        dueTomorrow.push(item);
      } else if (fu >= day2 && fu <= day7) {
        dueLater.push(item);
      }
    }

    // Completed this week: (Active Relationship OR Connection Successful = Yes)
    // AND Last Contact within the past 7 days.
    const lc = reminders_atMidnight_(item.lastContactDate);
    const isCompleted = (item.status.toLowerCase() === 'active relationship')
      || (item.connection.toLowerCase() === 'yes');
    if (isCompleted && lc && lc >= past7 && lc <= today) {
      completed.push(item);
    }
  });

  const sections = [
    { title: 'Due Today',            accent: '#b91c1c', items: dueToday,    empty: 'Nothing due today' },
    { title: 'Due Tomorrow',         accent: '#c47d00', items: dueTomorrow, empty: 'Nothing due tomorrow' },
    { title: 'Due Later This Week',  accent: '#1f4e78', items: dueLater,    empty: 'Nothing else due this week' },
    { title: 'Completed This Week',  accent: '#0a7c4e', items: completed,   empty: 'No completions recorded this week' }
  ];

  const monday = reminders_mondayOf_(today);
  const weekLabel = Utilities.formatDate(monday, Session.getScriptTimeZone(), 'MMMM d, yyyy');
  const subject = 'NJDPT Weekly Outreach Digest — week of ' + weekLabel;
  const htmlBody = reminders_buildDigestHtml_(sections);

  admins.forEach(email => {
    MailApp.sendEmail({ to: email, subject: subject, htmlBody: htmlBody });
  });

  Logger.log('Sent weekly digest to: ' + admins.join(', '));
}

// Creates the Monday-7am trigger for sendWeeklyDigest, but only if one does not
// already exist. Returns { success: true }.
function setupWeeklyTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  const exists = triggers.some(t => t.getHandlerFunction() === 'sendWeeklyDigest');

  if (exists) {
    Logger.log('Trigger already set');
    return { success: true };
  }

  ScriptApp.newTrigger('sendWeeklyDigest')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(7)
    .create();

  return { success: true };
}

// One-time setup entry point: wires up the weekly trigger. Run this manually once.
function initReminders() {
  setupWeeklyTrigger();
  Logger.log('Reminder system initialized');
}

// One-time migration: removes any old daily sendFollowUpReminders trigger and
// installs the new weekly digest trigger. Run this once from the editor after deploying.
function migrateTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  let removed = 0;
  triggers.forEach(t => {
    if (t.getHandlerFunction() === 'sendFollowUpReminders') {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });

  setupWeeklyTrigger(); // dedup-checked; won't create a second weekly trigger
  Logger.log('Migration complete: removed ' + removed + ' old daily trigger(s); weekly digest scheduled.');
  return { success: true };
}

// ---------------------------------------------------------------------------
// Private helpers (prefixed to avoid clashing with functions in other files)
// ---------------------------------------------------------------------------

function reminders_parseDate_(value) {
  if (!value) return null;
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return isNaN(value.getTime()) ? null : new Date(value.getTime());
  }
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? null : parsed;
}

// Returns a copy of the date at local midnight, or null.
function reminders_atMidnight_(date) {
  if (!date) return null;
  const d = new Date(date.getTime());
  d.setHours(0, 0, 0, 0);
  return d;
}

// Returns the Monday (local midnight) of the week containing the given date.
function reminders_mondayOf_(date) {
  const d = new Date(date.getTime());
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();               // 0 = Sun .. 6 = Sat
  const diff = (day === 0) ? -6 : (1 - day);
  d.setDate(d.getDate() + diff);
  return d;
}

// Formats a date value as M/d/yyyy in the script's timezone; '' for blanks.
function reminders_formatDate_(value) {
  const date = reminders_parseDate_(value);
  if (!date) {
    return value ? String(value) : '';
  }
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'M/d/yyyy');
}

function reminders_escapeHtml_(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function reminders_truncate_(value, max) {
  const text = String(value == null ? '' : value).trim();
  if (text.length <= max) {
    return text;
  }
  return text.slice(0, max).trimEnd() + '…';
}

// Inline-styled status pill for the email.
function reminders_statusBadge_(status) {
  const clean = String(status || '').trim();
  if (!clean) return '';
  const styles = {
    'New Opportunity':     'background-color:#f1f3f5;color:#4a5568;',
    'Contacted':           'background-color:#dbeafe;color:#1e40af;',
    'Follow-Up Needed':    'background-color:#fef3c7;color:#92400e;',
    'Active Relationship': 'background-color:#d1fae5;color:#065f46;',
    'Not Pursuing':        'background-color:#fee2e2;color:#991b1b;'
  };
  const style = styles[clean] || 'background-color:#f1f3f5;color:#4a5568;';
  return '<span style="display:inline-block;padding:2px 10px;border-radius:12px;'
    + 'font-size:11px;font-weight:bold;font-family:Arial,Helvetica,sans-serif;' + style + '">'
    + reminders_escapeHtml_(clean) + '</span>';
}

// One org card for the digest.
function reminders_digestCard_(item) {
  const org = reminders_escapeHtml_(item.organization || 'Untitled');
  const catLoc = [item.category, item.location]
    .filter(v => String(v == null ? '' : v).trim() !== '')
    .map(reminders_escapeHtml_)
    .join(' · ');
  const opp = String(item.opportunity == null ? '' : item.opportunity).trim();
  const lastContact = reminders_formatDate_(item.lastContact);
  const notes = reminders_truncate_(item.notes, 120);

  let inner = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#163a5f;">'
    + org + '</div>';
  if (catLoc) {
    inner += '<div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#6b7a8d;margin-top:2px;">'
      + catLoc + '</div>';
  }
  if (opp) {
    inner += '<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;font-style:italic;color:#1a2330;margin-top:6px;">'
      + reminders_escapeHtml_(opp) + '</div>';
  }
  if (lastContact) {
    inner += '<div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#6b7a8d;margin-top:6px;">Last contact: '
      + reminders_escapeHtml_(lastContact) + '</div>';
  }
  if (notes) {
    inner += '<div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#6b7a8d;margin-top:4px;">'
      + reminders_escapeHtml_(notes) + '</div>';
  }
  if (String(item.status || '').trim()) {
    inner += '<div style="margin-top:8px;">' + reminders_statusBadge_(item.status) + '</div>';
  }

  return '<table width="100%" cellpadding="0" cellspacing="0" border="0" '
    + 'style="background:#ffffff;border:1px solid #e3e9f1;border-radius:6px;margin-bottom:8px;">'
    + '<tr><td style="padding:12px;">' + inner + '</td></tr></table>';
}

// One section (header + cards, or the muted empty message).
function reminders_digestSection_(section) {
  let inner = '';
  if (section.items.length) {
    section.items.forEach(it => { inner += reminders_digestCard_(it); });
  } else {
    inner = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#9aa8b8;">'
      + reminders_escapeHtml_(section.empty) + '</div>';
  }

  return '<tr><td style="padding:18px 24px 0;">'
    + '<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;text-transform:uppercase;'
    + 'letter-spacing:0.08em;font-weight:bold;color:#1a2330;border-left:4px solid ' + section.accent + ';'
    + 'padding-left:10px;margin-bottom:12px;">' + reminders_escapeHtml_(section.title) + '</div>'
    + inner
    + '</td></tr>';
}

// Assembles the full inline-styled, table-based digest email.
function reminders_buildDigestHtml_(sections) {
  let body = '';
  sections.forEach(s => { body += reminders_digestSection_(s); });

  return ''
    + '<table width="100%" cellpadding="0" cellspacing="0" border="0" '
    + 'style="background:#f0f4f8;margin:0;padding:0;">'
    + '<tr><td align="center" style="padding:24px 12px;">'

    + '<table width="600" cellpadding="0" cellspacing="0" border="0" '
    + 'style="width:600px;max-width:600px;background:#ffffff;border-radius:10px;overflow:hidden;'
    + 'border:1px solid #d0dae6;">'

    // Header block
    + '<tr><td style="background:#163a5f;padding:20px 24px;">'
    + '<div style="font-family:Arial,Helvetica,sans-serif;font-size:18px;font-weight:bold;'
    + 'color:#ffffff;">NJDPT Community &amp; Referral Relationship Finder</div>'
    + '<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;'
    + 'color:#c7d3e0;margin-top:4px;">Weekly Outreach Digest</div>'
    + '</td></tr>'

    // Sections
    + body

    // Spacer
    + '<tr><td style="height:20px;line-height:20px;font-size:0;">&nbsp;</td></tr>'

    // Footer
    + '<tr><td style="background:#f0f4f8;padding:14px 24px;font-family:Arial,Helvetica,sans-serif;'
    + 'font-size:12px;color:#6b7a8d;border-top:1px solid #eef1f5;">'
    + 'Weekly digest from the NJDPT Referral Tracker · Sent every Monday at 7am</td></tr>'

    + '</table>'
    + '</td></tr></table>';
}
