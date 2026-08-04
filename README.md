# NJDPT Community & Referral Relationship Finder

An internal web app built with Google Apps Script for New Jersey Doctors of Physical Therapy. Helps staff discover, track, and manage community outreach and referral relationships across all four clinic locations.

## What It Does

- Add, edit, and delete community organizations and referral partners
- Search and filter by clinic location, category, and status
- Auto duplicate detection on load with staff-facing resolution modal
- Quick update panel to log a call, bump a status, and append a timestamped note in two clicks
- Daily email reminders for due follow-ups sent to a configurable admin group
- Analytics charts on each summary card showing category distribution, connection rates, and relationship value
- Fully branded — feels like an internal tool, not a spreadsheet

## File Structure

- `Code.gs` — backend CRUD, sheet setup, summary counts
- `Dedup.gs` — duplicate detection engine
- `Reminders.gs` — daily email trigger and admin email management
- `Dashboard.html` — full frontend including charts, modals, and quick update panel

## Setup

1. Create a Google Sheet in the NJDPT Workspace account
2. Open **Extensions → Apps Script** from inside the sheet
3. Paste all four files into the project
4. Run `setupReferralTracker()`, `setupReviewQueue()`, and `initReminders()` once each from the editor
5. Open the deployed web app, go to Admin Settings (gear icon), and add reminder email recipients
6. Deploy as a web app — Execute as Me, access to anyone at NJDPT

## Planned

- Geocoding and auto nearest-clinic distance assignment
- Places API weekly discovery trigger with staff approval flow
- Industry Watch feed for newly opened practices and community orgs

## Built By

Bryce — CS Intern, NJDPT 2026 · GitHub: Bryce-L2
