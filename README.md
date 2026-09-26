# NJDPT Community & Referral Relationship Finder

Internal web app for tracking community outreach relationships across four 
NJDPT clinic locations: Montville, Paramus, Riverdale, and Wayne.

Built with Google Apps Script, Google Sheets, and HTML/CSS/JS. Deployed as 
a Google Workspace web app.

---

## What It Does

- Track outreach organizations by clinic, category, status, and relationship value
- Auto-assign each org to the nearest NJDPT clinic using real driving distance
- Weekly automated discovery of new physician practices, senior centers, gyms, 
  and schools near each clinic
- Duplicate detection on save and on load
- Weekly email digest to admins with follow-ups and new orgs to review
- Full CRUD with delete history and restore
- Quick update panel for logging notes without opening the full form

---

## File Structure

| File | Purpose |
|---|---|
| `Code.gs` | CRUD, sheet setup, summary counts, dedup-on-save |
| `Dedup.gs` | Levenshtein similarity engine, on-load duplicate scan, dismissed pairs |
| `Geo.gs` | Places + Geocoding + Routes layer — nearest clinic, driving distance, auto-resolve |
| `Discovery.gs` | Weekly Places scan for new orgs, Suggestions tab, dedup against existing records |
| `Reminders.gs` | Monday 7am weekly email digest — follow-ups and new orgs to review |
| `History.gs` | Deleted record archive and restore |
| `Dashboard.html` | Full frontend — Chart.js analytics, modals, toasts, animations |

---

## Sheet Structure

**Referral Tracker** — main database  
**Deleted History** — archive of deleted records  

Key columns: ID, Organization, Category, NJDPT Location, Nearest Clinic (auto), 
Distance, Address, Latitude, Longitude, Contact Person, Contact Information, 
Contact Method, Website, Outreach Opportunity, Last Contact, Follow-Up Date, 
Status, Relationship Value, Connection Successful, Outcome, Estimated ROI, 
Notes, Date Added, Last Updated

---

## APIs Used

All on Google Maps Platform. Requires one API key restricted to these three:

| API | SKU Tier | Free/month | Used for |
|---|---|---|---|
| Geocoding API | Essentials | 10,000 | Clinic address geocoding |
| Places API (New) | Pro / Enterprise | 5,000 / 1,000 | Org discovery, office lookup |
| Routes API | Essentials | 10,000 | Driving distance to nearest clinic |

Projected usage: 200–400 calls/month. No charges expected.

---

## Setup

### First-time setup

1. Deploy as a Google Workspace web app from the Apps Script editor
2. Run `migrateAddGeoColumns()` from Code.gs to add geo columns to the sheet
3. Add your Google Maps API key as a Script Property:
   - Apps Script → Project Settings → Script Properties
   - Name: `MAPS_API_KEY`
   - Value: your key
4. Run `geoSelfTest()` from Geo.gs — should return 11/0 passed
5. Run `backfillUnresolvedOrgs()` from Geo.gs to resolve all existing orgs
6. Run `setupDiscoveryTrigger()` from Discovery.gs to install the weekly scan

### Triggers installed

| Function | Schedule |
|---|---|
| `runDiscoveryScan` | Every Monday at 6am |
| `sendWeeklyDigest` | Every Monday at 7am |

### Google Cloud quota settings

| Quota | Recommended limit |
|---|---|
| Geocoding v3 requests/day | 300 |
| Geocoding v3 requests/minute | 60 |
| Places SearchTextRequest/day | 300 |
| Places SearchTextRequest/minute | 120 |
| Places SearchNearbyRequest/day | 300 |
| Places SearchNearbyRequest/minute | 120 |
| Places GetPlaceRequest/day | 150 |
| Places GetPlaceRequest/minute | 60 |
| Routes ComputeRoutes/day | 300 |
| Routes ComputeRoutes/minute | 60 |

**Before running the initial backfill**, temporarily raise SearchTextRequest/day 
to 500, then set it back to 300 after.

---

## Key Behaviors

**Auto-resolve on save:** When a new org is saved with an address, it 
automatically geocodes, finds the nearest clinic, and computes driving distance. 
Editing an address triggers a re-resolve.

**Multi-office orgs:** For chains with multiple locations (e.g. an orthopedic 
group with Wayne, Paramus, and Morristown offices), the resolver finds all 
offices within 10 miles of any clinic and picks the closest office↔clinic pair.

**Discovery scan:** Runs every Monday at 6am. Searches Places for physician 
practices, senior centers, gyms, schools, and community orgs near each clinic. 
Dedupes against existing records by phone, domain, and name similarity. Adds 
up to 25 new orgs per run with "Needs Review" status.

**Duplicate detection:** Levenshtein similarity on org name + phone match + 
domain match. Flags likely duplicates on save and on dashboard load. Dismissed 
pairs are stored in Script Properties and never re-flagged.

**Weekly digest:** Emails admins every Monday at 7am with follow-ups due today, 
tomorrow, and later this week, completions from the past week, and new orgs 
discovered for review.

---

## Admin Configuration

**Email recipients:** Edit `ADMIN_EMAILS` in `Reminders.gs`  
**Discovery search radius:** Edit `DISCOVERY_RADIUS_MILES` in `Discovery.gs`  
**Resolver search radius:** Edit `SEARCH_RADIUS_MILES` in `Geo.gs`  
**Max new orgs per scan:** Edit `MAX_NEW_PER_RUN` in `Discovery.gs`  
**API key:** Script Property `MAPS_API_KEY`  

---

## Built By

Bryce Lombardo — CS Intern, NJDPT 2026
