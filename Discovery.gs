/**
 * Discovery.gs
 * Weekly Places scan: finds outreach orgs near the four NJDPT clinics that aren't
 * in the tracker yet and adds them as "Needs Review" rows, so they surface in
 * Monday's digest. Reuses Geo.gs (placesTextSearch_, placeDetails_,
 * getClinicCoords_, haversineMiles_, requireConfig_), Dedup.gs (normalizeName),
 * and Code.gs (setupReferralTracker, saveReferralRecord, getReferralRecords).
 * Dormant until MAPS_API_KEY is set.
 */

const REVIEW_STATUS = 'Needs Review';
const DISCOVERY_RADIUS_MILES = 8;              // search radius around each clinic
const DISCOVERED_IDS_PROP = 'DISCOVERED_PLACE_IDS';
const DISCOVERY_FETCH_DETAILS = true;          // fetch phone/website per new find
const MAX_NEW_PER_RUN = 25;     // stop after adding this many new orgs per run
const RESULTS_PER_SEARCH = 5;   // take only the top N of each search's ~20 results
const NAME_MATCH_SKIP = 0.85;   // fuzzy-name pre-filter threshold vs existing orgs

// Never add NJDPT's own practices to the tracker. A candidate whose normalized
// name contains any of these is dropped from discovery. Add variants as needed.
const EXCLUDED_ORG_KEYWORDS = ['njdpt', 'new jersey doctors of physical therapy'];

// What to look for, and the Category each result maps to. Sent to Places near
// EACH clinic. Tune freely.
const DISCOVERY_SEARCHES = [
  // Physician practices — the specialties named in the brief
  { query: 'orthopedic practice',        category: 'Physician Practice' },
  { query: 'orthopedic surgeon',         category: 'Physician Practice' },
  { query: 'neurology practice',         category: 'Physician Practice' },
  { query: 'primary care practice',      category: 'Physician Practice' },
  { query: 'rheumatology practice',      category: 'Physician Practice' },
  { query: 'pain management clinic',     category: 'Physician Practice' },
  { query: 'podiatrist',                 category: 'Physician Practice' },
  { query: 'sports medicine physician',  category: 'Physician Practice' },

  // Seniors
  { query: 'senior center',              category: 'Senior Center' },
  { query: 'senior living community',    category: 'Senior Living' },
  { query: 'assisted living facility',   category: 'Senior Living' },

  // Schools & athletics
  { query: 'high school',                category: 'School' },
  { query: 'athletic club',              category: 'Athletic Program' },
  { query: 'youth sports organization',  category: 'Athletic Program' },

  // Gyms & fitness
  { query: 'gym',                        category: 'Gym/Fitness' },
  { query: 'fitness center',             category: 'Gym/Fitness' },

  // Community & wellness
  { query: 'community center',           category: 'Community Organization' },
  { query: 'wellness center',            category: 'Community Organization' },
  { query: 'YMCA',                       category: 'Community Organization' },

  // Support groups — the conditions named in the brief
  { query: "Parkinson's support group",  category: 'Support Group' },
  { query: 'osteoporosis support group', category: 'Support Group' },
  { query: 'arthritis support group',    category: 'Support Group' },
  { query: 'caregiver support group',    category: 'Support Group' },
  { query: 'fall prevention program',    category: 'Support Group' }
];
// ─── Surfaced place-id memory (never re-add the same place) ───────────────────

function getDiscoveredIds_() {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(DISCOVERED_IDS_PROP);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

function addDiscoveredIds_(ids) {
  if (!ids || !ids.length) return;
  const set = getDiscoveredIds_();
  const merged = set.concat(ids.filter(id => set.indexOf(id) === -1));
  PropertiesService.getScriptProperties().setProperty(DISCOVERED_IDS_PROP, JSON.stringify(merged));
}

// Clears the surfaced-place-id memory so previously-found places can appear again.
// Use sparingly — e.g. after changing DISCOVERY_SEARCHES. Normally leave it alone.
function resetDiscoveredMemory() {
  PropertiesService.getScriptProperties().deleteProperty(DISCOVERED_IDS_PROP);
  return { success: true };
}

// True if this looks like one of NJDPT's own practices (never a discovery candidate).
function isOwnClinic_(name) {
  const n = normalizeName(name); // Dedup.gs
  if (!n) return false;
  return EXCLUDED_ORG_KEYWORDS.some(kw => n.indexOf(kw) !== -1);
}

// Default Relationship Value for a freshly discovered org, by category.
function discoveryRelationshipValue_(category) {
  const high = ['Physician Practice'];
  const medium = ['Senior Center', 'Senior Living', 'School', 'Athletic Program'];
  if (high.indexOf(category) !== -1) return 'High';
  if (medium.indexOf(category) !== -1) return 'Medium';
  return 'Potential';
}

// Default Outreach Opportunity for a freshly discovered org, by category.
function discoveryOutreachOpportunity_(category) {
  const map = {
    'Physician Practice':     'Physician referral relationship',
    'Senior Center':          'Fall prevention presentation',
    'Senior Living':          'Fall prevention presentation',
    'School':                 'Athletic injury prevention program',
    'Athletic Program':       'Sports injury prevention and recovery',
    'Gym/Fitness':            'Injury prevention and recovery partnership',
    'Community Organization': 'Community wellness presentation',
    'Support Group':          'Physical therapy education and support'
  };
  return map[category] || 'Outreach opportunity';
}

// ─── The scan ─────────────────────────────────────────────────────────────────

// Searches, dedupes by place-id + fuzzy name (both free), and returns NEW candidates
// with their nearest clinic. Shared core: makes Text Search calls only — no details/
// routes calls, writes nothing. Also returns existingRecords for the add-time gate.
function discoverNewCandidates_() {
  const clinics = getClinicCoords_().filter(c => c.lat != null && c.lng != null);
  if (!clinics.length) return { clinics: [], candidates: [], reason: 'Clinic coordinates unavailable.' };

  const existingRecords = getReferralRecords();
  const existingNorms = [];
  existingRecords.forEach(r => {
    const n = normalizeName(r['Organization']); // Dedup.gs
    if (n) existingNorms.push(n);
  });

  const alreadySurfaced = {};
  getDiscoveredIds_().forEach(id => { alreadySurfaced[id] = true; });

  const radiusMeters = Math.round(DISCOVERY_RADIUS_MILES * 1609.344);

  const byId = {};
  clinics.forEach(clinic => {
    DISCOVERY_SEARCHES.forEach(s => {
      placesTextSearch_(s.query, clinic.lat, clinic.lng, radiusMeters)
        .slice(0, RESULTS_PER_SEARCH)
        .forEach(r => {
          if (!r || !r.placeId || byId[r.placeId]) return;
          byId[r.placeId] = {
            placeId: r.placeId, name: r.name || '', address: r.address || '',
            lat: r.lat, lng: r.lng,
            category: s.category
          };
        });
    });
  });

  let alreadyHave = 0, alreadySeen = 0, incomplete = 0;
  const newOnes = [];
  Object.keys(byId).forEach(pid => {
    const c = byId[pid];
    if (!c.name || c.lat == null || c.lng == null) { incomplete++; return; }
    if (alreadySurfaced[pid]) { alreadySeen++; return; }

    // Never add NJDPT's own practices.
    if (isOwnClinic_(c.name)) { alreadyHave++; return; }

    // Fuzzy name pre-filter (no API): skip if it closely matches an org we track.
    const norm = normalizeName(c.name);
    let nameDup = false;
    if (norm) {
      for (let k = 0; k < existingNorms.length; k++) {
        if (stringSimilarity(norm, existingNorms[k]) >= NAME_MATCH_SKIP) { nameDup = true; break; }
      }
    }
    if (nameDup) { alreadyHave++; return; }

    let nearest = null;
    clinics.forEach(cl => {
      const m = haversineMiles_(c.lat, c.lng, cl.lat, cl.lng);
      if (!nearest || m < nearest.m) nearest = { name: cl.name, lat: cl.lat, lng: cl.lng, m: m };
    });
    c.nearest = nearest;
    newOnes.push(c);
  });

  return { clinics: clinics, candidates: newOnes, existingRecords: existingRecords,
    stats: { alreadyHave: alreadyHave, alreadySurfaced: alreadySeen, incomplete: incomplete } };
}

// Weekly scan — adds up to MAX_NEW_PER_RUN new orgs. Each survivor passes the full
// checkDuplicate gate (phone/domain/name) before it's added, and EVERY place processed
// (added or rejected) is remembered so it never comes back.
function runDiscoveryScan() {
  const notCfg = requireConfig_(); // Geo.gs key guard
  if (notCfg) return notCfg;

  const found = discoverNewCandidates_();
  if (found.reason) return { configured: true, added: 0, reason: found.reason };

  const candidates = found.candidates;
  const existingRecords = found.existingRecords; // grows as we add, for within-run dedup
  let added = 0, skippedDup = 0;
  const processedIds = [], addedNames = [];

  for (let i = 0; i < candidates.length && added < MAX_NEW_PER_RUN; i++) {
    const c = candidates[i];

    // Details (phone/website) — used to enrich AND to dedup by phone/domain.
    let phone = '', website = '';
    if (DISCOVERY_FETCH_DETAILS) {
      const d = placeDetails_(c.placeId);
      phone = d.phone || '';
      website = d.website || '';
    }

    // Full dedup gate — your real engine (Dedup.gs).
    const dup = checkDuplicate({
      'Organization': c.name,
      'Contact Information': phone,
      'Website': website,
      'NJDPT Location': c.nearest ? c.nearest.name : ''
    }, existingRecords);

    if (dup.result === 'LIKELY_DUPLICATE' || dup.result === 'REVIEW') {
      processedIds.push(c.placeId); // remember so we never re-fetch/re-check it
      skippedDup++;
      Logger.log('Discovery skip (dup): "' + c.name + '" — ' + dup.reason
        + (dup.matchedRecord ? ' [matches "' + dup.matchedRecord['Organization'] + '"]' : ''));
      Utilities.sleep(120);
      continue;
    }

    // Real driving distance (one Routes call).
    let distance = '';
    if (c.nearest) {
      const rm = routeDriveMiles_({ lat: c.lat, lng: c.lng }, { lat: c.nearest.lat, lng: c.nearest.lng });
      const miles = (rm == null) ? c.nearest.m : rm;
      distance = (Math.round(miles * 10) / 10) + ' mi';
    }

    const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'M/d/yyyy');
    const record = {
      'Organization': c.name, 'Category': c.category, 'Distance': distance,
      'Address': c.address, 'Latitude': c.lat, 'Longitude': c.lng,
      'Nearest Clinic (auto)': c.nearest ? c.nearest.name : '',
      'NJDPT Location': c.nearest ? c.nearest.name : '',
      'Status': REVIEW_STATUS,
      'Connection Successful': 'Pending',
      'Outcome': 'Pending',
      'Relationship Value': discoveryRelationshipValue_(c.category),
      'Outreach Opportunity': discoveryOutreachOpportunity_(c.category),
      'Contact Information': phone, 'Website': website,
      'Notes': 'Auto-discovered ' + today + ' near ' + (c.nearest ? c.nearest.name : 'a') + ' clinic.'
    };

    try {
      saveReferralRecord(record);
      added++;
      processedIds.push(c.placeId);
      addedNames.push(c.name);
      existingRecords.push(record); // later listings this run are caught as dups
    } catch (e) {
      Logger.log('runDiscoveryScan: failed to add "' + c.name + '": ' + e);
    }
    Utilities.sleep(120);
  }

  addDiscoveredIds_(processedIds); // remember EVERYTHING processed (added + rejected)

  const remaining = Math.max(0, candidates.length - added - skippedDup);
  Logger.log('runDiscoveryScan: added ' + added + ' (cap ' + MAX_NEW_PER_RUN + '), '
    + 'skipped as duplicate: ' + skippedDup + ', ~' + remaining + ' still pending. '
    + 'Pre-filtered — name match: ' + found.stats.alreadyHave
    + ', already surfaced: ' + found.stats.alreadySurfaced + '.');
  if (addedNames.length) Logger.log('Added for review:\n - ' + addedNames.join('\n - '));

  return { configured: true, added: added, skippedDuplicate: skippedDup, remainingPending: remaining,
    skippedNameMatch: found.stats.alreadyHave, skippedAlreadySurfaced: found.stats.alreadySurfaced,
    names: addedNames };
}

// Preview — up to how many NEW orgs would be added, writes nothing, no details/routes
// calls (only the Text Searches). Reflects place-id + name dedup; the phone/domain gate
// runs only at add-time, so the real number may be a bit lower.
function discoveryDryRun() {
  const notCfg = requireConfig_();
  if (notCfg) return notCfg;

  const found = discoverNewCandidates_();
  if (found.reason) return { configured: true, wouldAdd: 0, reason: found.reason };

  const names = found.candidates.map(c => c.name);
  const sample = names.slice(0, 30);

  Logger.log('discoveryDryRun: up to ' + names.length + ' NEW orgs (after place-id + name dedup; '
    + 'phone/website dedup applies at add-time, so the real count may be lower). '
    + 'Next scan would add up to ' + MAX_NEW_PER_RUN + '. '
    + 'Pre-filtered — name match: ' + found.stats.alreadyHave
    + ', already surfaced: ' + found.stats.alreadySurfaced + '.');
  Logger.log('Sample:\n - ' + sample.join('\n - ')
    + (names.length > sample.length ? '\n ...and ' + (names.length - sample.length) + ' more' : ''));

  return { configured: true, wouldAddUpperBound: names.length, cappedPerRun: MAX_NEW_PER_RUN,
    skippedNameMatch: found.stats.alreadyHave, skippedAlreadySurfaced: found.stats.alreadySurfaced,
    sample: sample };
}

// ─── Weekly trigger (Monday 6am — one hour before the 7am digest) ─────────────

function setupDiscoveryTrigger() {
  const exists = ScriptApp.getProjectTriggers()
    .some(t => t.getHandlerFunction() === 'runDiscoveryScan');
  if (exists) { Logger.log('Discovery trigger already set.'); return { success: true }; }

  ScriptApp.newTrigger('runDiscoveryScan')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(6)
    .create();
  Logger.log('Discovery trigger created (Mondays 6am).');
  return { success: true };
}

function removeDiscoveryTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'runDiscoveryScan') ScriptApp.deleteTrigger(t);
  });
  return { success: true };
}
