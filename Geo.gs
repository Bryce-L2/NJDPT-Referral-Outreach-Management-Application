/**
 * Geo.gs
 * Places + Geocoding + Routes layer. Given an org name, finds the org's office
 * nearest to any of the four NJDPT clinics, pairs it to that clinic, and writes
 * back Address / Lat / Lng / driving Distance / Nearest Clinic (auto) — autofilling
 * phone + website only when blank.
 *
 * APIs: Geocoding, Places API (NEW, places.googleapis.com/v1), Routes.
 * Cost tiers: Text Search → Pro (5,000/mo); Place Details w/ contact → Enterprise
 * (1,000/mo, called ≤1×/org and only when contact is missing); Routes pinned to
 * Essentials (10,000/mo) via TRAFFIC_UNAWARE.
 *
 * Reuse: HEADERS, findRowById_, setupReferralTracker (Code.gs); normalizeName (Dedup.gs).
 * Dormant until Script Property MAPS_API_KEY is set — then every entry point runs.
 */

// ─── Config ──────────────────────────────────────────────────────────────────

const MAPS_KEY_PROP = 'MAPS_API_KEY';
const CLINIC_COORDS_PROP = 'CLINIC_COORDS_CACHE';
const SEARCH_RADIUS_MILES = 10;
const MOCK_MODE = false; // true = offline fixture, no network (for tests only)

const NJDPT_CLINICS = [
  { name: 'Montville', address: '2 Changebridge Rd, Building, Suite F, Montville, NJ 07045' },
  { name: 'Paramus',   address: '28 Farview Terrace, Paramus, NJ 07652' },
  { name: 'Riverdale', address: '69 Newark Pompton Turnpike, Riverdale, NJ 07457' },
  { name: 'Wayne',     address: '450 Hamburg Tpke #2f, Wayne, NJ 07470' }
];

// Approximate coords used ONLY in MOCK_MODE (real mode geocodes + caches).
const MOCK_CLINIC_COORDS = {
  Montville: { lat: 40.8879, lng: -74.3510 },
  Paramus:   { lat: 40.9260, lng: -74.0752 },
  Riverdale: { lat: 40.9971, lng: -74.3082 },
  Wayne:     { lat: 40.9450, lng: -74.2470 }
};

// ─── Key handling ────────────────────────────────────────────────────────────

function getMapsKey_() {
  const k = PropertiesService.getScriptProperties().getProperty(MAPS_KEY_PROP);
  return (k && String(k).trim()) ? String(k).trim() : null;
}

function requireConfig_() {
  if (MOCK_MODE) return null;
  if (!getMapsKey_()) return { configured: false, message: 'MAPS_API_KEY not set' };
  return null;
}

// ─── Monthly per-SKU call counter ────────────────────────────────────────────

function monthKey_() {
  const d = new Date();
  const m = ('0' + (d.getMonth() + 1)).slice(-2);
  return d.getFullYear() + '-' + m;
}

// Never throws — a counting hiccup must not break a real API call.
function bumpApiCounter_(api) {
  try {
    const props = PropertiesService.getScriptProperties();
    const key = 'apiCalls:' + monthKey_() + ':' + api;
    const n = parseInt(props.getProperty(key) || '0', 10) + 1;
    props.setProperty(key, String(n));
  } catch (e) { /* ignore */ }
}

// Usage for the current month. Places is split by billing SKU; `places` stays as
// a combined total for backward compatibility.
function getApiUsageThisMonth() {
  const props = PropertiesService.getScriptProperties();
  const month = monthKey_();
  const read = api => parseInt(props.getProperty('apiCalls:' + month + ':' + api) || '0', 10);
  const placesPro = read('places_pro');               // Text Search — Pro SKU (5,000/mo)
  const placesEnterprise = read('places_enterprise'); // Place Details w/ contact — Enterprise (1,000/mo)
  return {
    geocoding: read('geocoding'),
    places: placesPro + placesEnterprise,             // backward-compatible total
    places_pro: placesPro,
    places_enterprise: placesEnterprise,
    routes: read('routes'),
    month: month
  };
}

// ─── Low-level API calls ─────────────────────────────────────────────────────

// Geocoding API (GET). Returns { lat, lng, formattedAddress } or null.
function geocode_(address) {
  const key = getMapsKey_();
  if (!key || MOCK_MODE) return null;
  const query = String(address || '').trim();
  if (!query) return null;

  const url = 'https://maps.googleapis.com/maps/api/geocode/json'
    + '?address=' + encodeURIComponent(query)
    + '&key=' + encodeURIComponent(key);

  bumpApiCounter_('geocoding');
  try {
    const data = JSON.parse(UrlFetchApp.fetch(url, { muteHttpExceptions: true }).getContentText());
    if (data.status === 'OK' && data.results && data.results.length) {
      const loc = data.results[0].geometry.location;
      return { lat: loc.lat, lng: loc.lng, formattedAddress: data.results[0].formatted_address || query };
    }
    Logger.log('geocode_: ' + data.status + ' for "' + query + '"');
  } catch (e) {
    Logger.log('geocode_ failed for "' + query + '": ' + e);
  }
  return null;
}

// Places API (New) Text Search (POST) — Pro SKU (Pro-tier fields only). Returns a
// NORMALIZED array of { placeId, name, address, lat, lng }, or [] on none / error.
function placesTextSearch_(query, biasLat, biasLng, radiusMeters) {
  const key = getMapsKey_();
  if (!key || MOCK_MODE) return [];

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location'
    },
    payload: JSON.stringify({
      textQuery: query,
      locationBias: {
        circle: { center: { latitude: biasLat, longitude: biasLng }, radius: radiusMeters }
      }
    }),
    muteHttpExceptions: true
  };

  bumpApiCounter_('places_pro');
  try {
    const resp = UrlFetchApp.fetch('https://places.googleapis.com/v1/places:searchText', options);
    const data = JSON.parse(resp.getContentText() || '{}');
    if (resp.getResponseCode() === 200 && Array.isArray(data.places)) {
      return data.places.map(p => ({
        placeId: p.id || '',
        name: (p.displayName && p.displayName.text) ? p.displayName.text : '',
        address: p.formattedAddress || '',
        lat: p.location ? p.location.latitude : null,
        lng: p.location ? p.location.longitude : null
      }));
    }
    if (data.error) {
      Logger.log('placesTextSearch_: ' + (data.error.status || resp.getResponseCode())
        + (data.error.message ? ' — ' + data.error.message : ''));
    }
  } catch (e) {
    Logger.log('placesTextSearch_ failed: ' + e);
  }
  return [];
}

// Places API (New) Place Details (GET .../v1/places/{id}) — Enterprise SKU (contact
// fields). Returns { phone, website } (empty strings if absent), or {} on error.
// Field mask on a single-resource GET has NO "places." prefix.
function placeDetails_(placeId) {
  const key = getMapsKey_();
  if (!key || MOCK_MODE || !placeId) return {};

  const options = {
    method: 'get',
    headers: {
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'id,nationalPhoneNumber,websiteUri'
    },
    muteHttpExceptions: true
  };

  bumpApiCounter_('places_enterprise');
  try {
    const resp = UrlFetchApp.fetch(
      'https://places.googleapis.com/v1/places/' + encodeURIComponent(placeId), options);
    const data = JSON.parse(resp.getContentText() || '{}');
    if (resp.getResponseCode() === 200) {
      return { phone: data.nationalPhoneNumber || '', website: data.websiteUri || '' };
    }
    if (data.error) {
      Logger.log('placeDetails_: ' + (data.error.status || resp.getResponseCode())
        + (data.error.message ? ' — ' + data.error.message : ''));
    }
  } catch (e) {
    Logger.log('placeDetails_ failed: ' + e);
  }
  return {};
}

// Routes API (POST) — pinned to Essentials SKU (TRAFFIC_UNAWARE, distance only).
// Real driving miles for one origin→destination pair, or null.
function routeDriveMiles_(origin, dest) {
  const key = getMapsKey_();
  if (!key || MOCK_MODE) return null;

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'routes.distanceMeters'
    },
    payload: JSON.stringify({
      origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
      destination: { location: { latLng: { latitude: dest.lat, longitude: dest.lng } } },
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_UNAWARE'
    }),
    muteHttpExceptions: true
  };

  bumpApiCounter_('routes');
  try {
    const resp = UrlFetchApp.fetch('https://routes.googleapis.com/directions/v2:computeRoutes', options);
    const data = JSON.parse(resp.getContentText());
    if (data.routes && data.routes.length && typeof data.routes[0].distanceMeters === 'number') {
      return data.routes[0].distanceMeters / 1609.344;
    }
    Logger.log('routeDriveMiles_: no route (' + resp.getResponseCode() + ') ' + resp.getContentText().slice(0, 200));
  } catch (e) {
    Logger.log('routeDriveMiles_ failed: ' + e);
  }
  return null;
}

// ─── Geometry + name matching ────────────────────────────────────────────────

function haversineMiles_(lat1, lng1, lat2, lng2) {
  const R = 3958.7613; // Earth radius, miles
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function strongNameMatch_(a, b) {
  const na = normalizeName(a); // Dedup.gs
  const nb = normalizeName(b); // Dedup.gs
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.indexOf(nb) !== -1 || nb.indexOf(na) !== -1) return true;
  const ta = na.split(' ').filter(Boolean);
  const tb = nb.split(' ').filter(Boolean);
  return !!(ta.length && tb.length && ta[0] === tb[0]);
}

// ─── Clinic coordinates (lazily geocoded + cached) ───────────────────────────

function getClinicCoords_() {
  if (MOCK_MODE) {
    return NJDPT_CLINICS.map(c => ({
      name: c.name, lat: MOCK_CLINIC_COORDS[c.name].lat, lng: MOCK_CLINIC_COORDS[c.name].lng
    }));
  }

  const props = PropertiesService.getScriptProperties();
  const cached = props.getProperty(CLINIC_COORDS_PROP);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* fall through, re-geocode */ }
  }

  const coords = NJDPT_CLINICS.map(c => {
    const g = geocode_(c.address);
    return { name: c.name, lat: g ? g.lat : null, lng: g ? g.lng : null };
  });

  if (coords.every(c => c.lat != null && c.lng != null)) {
    props.setProperty(CLINIC_COORDS_PROP, JSON.stringify(coords));
  }
  return coords;
}

// ─── Core resolver ───────────────────────────────────────────────────────────

// Finds the org's office nearest to any clinic and returns it + clinic + driving
// miles. `needContact` (default true): when false, skips the Enterprise Place
// Details call because the row already has phone + website.
function resolveOrg_(orgName, hintTown, needContact) {
  const notCfg = requireConfig_();
  if (notCfg) return notCfg;

  // Default: fetch contact details unless the caller says the row already has them.
  if (needContact === undefined) needContact = true;

  const name = String(orgName || '').trim();
  if (!name) return { configured: true, resolved: false, reason: 'No organization name.' };

  const clinics = getClinicCoords_().filter(c => c.lat != null && c.lng != null);
  if (!clinics.length) return { configured: true, resolved: false, reason: 'Clinic coordinates unavailable.' };

  // 1 + 2: gather candidate offices near each clinic, dedupe by place id, keep only
  // those whose normalized name strongly matches the intended org.
  let offices;
  if (MOCK_MODE) {
    offices = mockOffices_(name);
  } else {
    const radiusMeters = Math.round(SEARCH_RADIUS_MILES * 1609.344);
    const query = hintTown ? (name + ' ' + hintTown) : name;
    const byPlaceId = {};
    clinics.forEach(c => {
      placesTextSearch_(query, c.lat, c.lng, radiusMeters).forEach(r => {
        if (r && r.placeId && !byPlaceId[r.placeId]) {
          byPlaceId[r.placeId] = {
            placeId: r.placeId,
            name: r.name || '',
            address: r.address || '',
            lat: r.lat,
            lng: r.lng
          };
        }
      });
    });
    offices = Object.keys(byPlaceId).map(k => byPlaceId[k])
      .filter(o => o.lat != null && o.lng != null)
      .filter(o => strongNameMatch_(name, o.name));
  }

  if (!offices.length) {
    return { configured: true, resolved: false, reason: 'No matching offices found near the clinics.' };
  }

  // 3: nearest (office, clinic) pair by free straight-line distance.
  let best = null;
  offices.forEach(o => {
    clinics.forEach(c => {
      const miles = haversineMiles_(o.lat, o.lng, c.lat, c.lng);
      if (!best || miles < best.straightMiles) best = { office: o, clinic: c, straightMiles: miles };
    });
  });

  // 4: one real driving-distance call on just the winning pair.
  let driveMiles;
  if (MOCK_MODE) {
    driveMiles = Math.round(best.straightMiles * 1.3 * 10) / 10; // fake road factor
  } else {
    const rm = routeDriveMiles_(
      { lat: best.office.lat, lng: best.office.lng },
      { lat: best.clinic.lat, lng: best.clinic.lng }
    );
    driveMiles = (rm == null) ? Math.round(best.straightMiles * 10) / 10 : Math.round(rm * 10) / 10;
  }

  // One Place Details (Enterprise SKU) call for phone/website — only when the row
  // still needs them (caller passes needContact) and only in real mode.
  let phone = best.office.phone || '';
  let website = best.office.website || '';
  if (!MOCK_MODE && needContact && best.office.placeId) {
    const details = placeDetails_(best.office.placeId);
    phone = details.phone || phone;
    website = details.website || website;
  }

  return {
    configured: true,
    resolved: true,
    office: {
      name: best.office.name,
      address: best.office.address,
      lat: best.office.lat,
      lng: best.office.lng,
      phone: phone,
      website: website
    },
    nearestClinic: best.clinic.name,
    driveMiles: driveMiles
  };
}

// Resolves coords/clinic/distance from an address string alone (geocode → nearest
// clinic → one Routes call). Returns a resolved-shaped result, or null. Phone/website
// left empty (not sourced here).
function resolveFromAddress_(orgName, address) {
  const query = String(address || '').trim();
  if (!query) return null;
  const g = geocode_(query);
  if (!g) return null;

  const clinics = getClinicCoords_().filter(c => c.lat != null && c.lng != null);
  if (!clinics.length) return null;

  let best = null;
  clinics.forEach(c => {
    const miles = haversineMiles_(g.lat, g.lng, c.lat, c.lng);
    if (!best || miles < best.straightMiles) best = { clinic: c, straightMiles: miles };
  });

  const rm = routeDriveMiles_({ lat: g.lat, lng: g.lng }, { lat: best.clinic.lat, lng: best.clinic.lng });
  const driveMiles = (rm == null) ? Math.round(best.straightMiles * 10) / 10 : Math.round(rm * 10) / 10;

  return {
    configured: true, resolved: true,
    office: { name: orgName, address: g.formattedAddress || query, lat: g.lat, lng: g.lng, phone: '', website: '' },
    nearestClinic: best.clinic.name,
    driveMiles: driveMiles
  };
}

// ─── Write-back ──────────────────────────────────────────────────────────────

// Writes a resolved result to one row. Fills office identity + computed clinic/
// distance; autofills phone/website ONLY when empty; never touches Organization,
// Category, or the human-set NJDPT Location.
function writeResolvedToRow_(sheet, row, res) {
  const set = (header, value) => {
    const col = HEADERS.indexOf(header);
    if (col !== -1) sheet.getRange(row, col + 1).setValue(value);
  };
  const cell = header => {
    const col = HEADERS.indexOf(header);
    return col === -1 ? '' : String(sheet.getRange(row, col + 1).getDisplayValue()).trim();
  };

  set('Address', res.office.address);
  set('Latitude', res.office.lat);
  set('Longitude', res.office.lng);
  set('Distance', res.driveMiles + ' mi');
  set('Nearest Clinic (auto)', res.nearestClinic);

  if (res.office.phone && !cell('Contact Information')) set('Contact Information', res.office.phone);
  if (res.office.website && !cell('Website')) set('Website', res.office.website);
}

// ─── Public entry points ─────────────────────────────────────────────────────

// Resolve every row that has no coordinates yet, and write back. Resilient — one
// org failing never aborts the run. Never re-resolves a row that already has coords.
function backfillUnresolvedOrgs() {
  const notCfg = requireConfig_();
  if (notCfg) return notCfg;

  const sheet = setupReferralTracker();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { configured: true, resolved: 0, failed: 0, skipped: 0, failures: [] };

  const orgCol = HEADERS.indexOf('Organization');
  const latCol = HEADERS.indexOf('Latitude');
  const lngCol = HEADERS.indexOf('Longitude');
  const locCol = HEADERS.indexOf('NJDPT Location');
  const contactCol = HEADERS.indexOf('Contact Information');
  const webCol = HEADERS.indexOf('Website');

  const rows = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getDisplayValues();
  let resolved = 0, failed = 0, skipped = 0;
  const failures = [];

  rows.forEach((vals, i) => {
    const row = i + 2;
    const orgName = String(vals[orgCol] || '').trim();
    const hasCoords = String(vals[latCol] || '').trim() !== '' && String(vals[lngCol] || '').trim() !== '';

    if (!orgName) { skipped++; return; }
    if (hasCoords) { skipped++; return; }

    try {
      const needContact = !String(vals[contactCol] || '').trim()
        || !String(vals[webCol] || '').trim();
      const res = resolveOrg_(orgName, String(vals[locCol] || '').trim(), needContact);
      if (res && res.resolved) {
        writeResolvedToRow_(sheet, row, res);
        resolved++;
      } else {
        failed++;
        failures.push(orgName + ' — ' + ((res && res.reason) || 'unresolved'));
      }
    } catch (e) {
      failed++;
      failures.push(orgName + ' — error: ' + e);
    }
    Utilities.sleep(150);
  });

  Logger.log('backfillUnresolvedOrgs: resolved ' + resolved + ', failed ' + failed + ', skipped ' + skipped + '.');
  if (failures.length) Logger.log('Unresolved:\n - ' + failures.join('\n - '));
  return { configured: true, resolved: resolved, failed: failed, skipped: skipped, failures: failures };
}

// Save-flow hook: resolve a single record when it has an Org/Address but no coords
// yet. Wired into saveReferralRecord (Code.gs). When preferAddress is true (the
// Address just changed), resolve from the typed address instead of the name lookup.
function resolveOnSave(record, preferAddress) {
  const notCfg = requireConfig_();
  if (notCfg) return notCfg;

  const orgName = String((record && record['Organization']) || '').trim();
  const address = String((record && record['Address']) || '').trim();
  if (!orgName && !address) return { configured: true, resolved: false, reason: 'Nothing to resolve.' };

  const sheet = setupReferralTracker();
  const id = String((record && record['ID']) || '').trim();
  const row = id ? findRowById_(sheet, id) : null;
  if (!row) return { configured: true, resolved: false, reason: 'Row not found.' };

  const latCol = HEADERS.indexOf('Latitude') + 1;
  const lngCol = HEADERS.indexOf('Longitude') + 1;
  const hasCoords = String(sheet.getRange(row, latCol).getDisplayValue()).trim() !== ''
    && String(sheet.getRange(row, lngCol).getDisplayValue()).trim() !== '';
  if (hasCoords) return { configured: true, resolved: false, reason: 'Already resolved.' };

  // Address just changed → trust the typed address over the name-based Places lookup.
  if (preferAddress && address) {
    const fromAddr = resolveFromAddress_(orgName, address);
    if (fromAddr) { writeResolvedToRow_(sheet, row, fromAddr); return fromAddr; }
  }

  const needContact = !String((record && record['Contact Information']) || '').trim()
    || !String((record && record['Website']) || '').trim();
  const res = resolveOrg_(orgName, String((record && record['NJDPT Location']) || '').trim(), needContact);
  if (res && res.resolved) {
    writeResolvedToRow_(sheet, row, res);
    return res;
  }

  // Fallback: no office found by name, but there's an Address — resolve from it.
  if (address) {
    const fromAddr = resolveFromAddress_(orgName, address);
    if (fromAddr) { writeResolvedToRow_(sheet, row, fromAddr); return fromAddr; }
  }

  return res || { configured: true, resolved: false, reason: 'Unresolved.' };
}

// Manual single-org refresh that ignores the "already has coords" skip.
function forceReresolve(id) {
  const notCfg = requireConfig_();
  if (notCfg) return notCfg;

  const sheet = setupReferralTracker();
  const row = findRowById_(sheet, String(id || '').trim());
  if (!row) return { configured: true, resolved: false, reason: 'Record not found.' };

  const vals = sheet.getRange(row, 1, 1, HEADERS.length).getDisplayValues()[0];
  const orgName = String(vals[HEADERS.indexOf('Organization')] || '').trim();
  const hint = String(vals[HEADERS.indexOf('NJDPT Location')] || '').trim();

  const contactCol = HEADERS.indexOf('Contact Information');
  const webCol = HEADERS.indexOf('Website');
  const needContact = !String(vals[contactCol] || '').trim() || !String(vals[webCol] || '').trim();
  const res = resolveOrg_(orgName, hint, needContact);
  if (res && res.resolved) writeResolvedToRow_(sheet, row, res);
  return res || { configured: true, resolved: false, reason: 'Unresolved.' };
}

// ─── Mock mode (verify the math offline, zero API calls) ─────────────────────

function mockOffices_(orgName) {
  return [
    { name: orgName + ' - Wayne', address: '500 Hamburg Tpke, Wayne, NJ 07470',
      lat: 40.9455, lng: -74.2475, phone: '(973) 555-0100', website: 'https://example.com' },
    { name: orgName + ' - Morristown', address: '100 Madison Ave, Morristown, NJ 07960',
      lat: 40.7968, lng: -74.4815, phone: '', website: '' }
  ];
}

function testResolverMath() {
  const results = [];
  const assert = (label, cond) => results.push((cond ? 'PASS' : 'FAIL') + ' — ' + label);

  assert('haversine self is ~0', haversineMiles_(40.9, -74.2, 40.9, -74.2) < 0.001);
  assert('Wayne office nearer Wayne clinic than Montville clinic',
    haversineMiles_(40.9455, -74.2475, MOCK_CLINIC_COORDS.Wayne.lat, MOCK_CLINIC_COORDS.Wayne.lng)
    < haversineMiles_(40.9455, -74.2475, MOCK_CLINIC_COORDS.Montville.lat, MOCK_CLINIC_COORDS.Montville.lng));

  if (!MOCK_MODE) {
    results.push('SKIP — set MOCK_MODE = true to run the resolver assertions offline.');
    Logger.log(results.join('\n'));
    return { ran: false, results: results };
  }

  const res = resolveOrg_('Mock Ortho', '');
  assert('resolver returns resolved', !!(res && res.resolved === true));
  assert('nearest clinic is Wayne', !!(res && res.nearestClinic === 'Wayne'));
  assert('winning office is the Wayne office', !!(res && /Wayne/.test(res.office.name)));
  assert('drive miles is a positive number', !!(res && typeof res.driveMiles === 'number' && res.driveMiles > 0));

  Logger.log(results.join('\n'));
  return { ran: true, results: results };
}

function geoSelfTest() {
  const lines = [];
  let pass = 0, fail = 0;
  const ok = label => { pass++; lines.push('PASS  ' + label); };
  const no = label => { fail++; lines.push('FAIL  ' + label); };
  const info = label => lines.push('info  ' + label);
  const check = (label, cond) => cond ? ok(label) : no(label);

  lines.push('────── Geo.gs self-test ──────');
  info('MOCK_MODE = ' + MOCK_MODE + '  |  API key set: ' + (getMapsKey_() ? 'yes' : 'no'));

  ['Nearest Clinic (auto)', 'Address', 'Latitude', 'Longitude'].forEach(h => {
    check('HEADERS contains "' + h + '"', HEADERS.indexOf(h) !== -1);
  });
  check('"Nearest Clinic (auto)" sits right after "NJDPT Location"',
    HEADERS.indexOf('Nearest Clinic (auto)') === HEADERS.indexOf('NJDPT Location') + 1);

  try {
    const sheet = setupReferralTracker();
    const headerRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
    if (headerRow.indexOf('Nearest Clinic (auto)') !== -1) {
      ok('Sheet has the "Nearest Clinic (auto)" column');
    } else {
      info('Sheet is missing "Nearest Clinic (auto)" — run migrateAddGeoColumns to add it.');
    }
  } catch (e) {
    info('Could not read the sheet header row: ' + e);
  }

  check('haversine of a point to itself is ~0', haversineMiles_(40.9, -74.2, 40.9, -74.2) < 0.001);
  const dWayne = haversineMiles_(40.9455, -74.2475, MOCK_CLINIC_COORDS.Wayne.lat, MOCK_CLINIC_COORDS.Wayne.lng);
  const dMont  = haversineMiles_(40.9455, -74.2475, MOCK_CLINIC_COORDS.Montville.lat, MOCK_CLINIC_COORDS.Montville.lng);
  check('a Wayne-area point is nearer the Wayne clinic than the Montville clinic', dWayne < dMont);

  const clinics = Object.keys(MOCK_CLINIC_COORDS).map(name => ({
    name: name, lat: MOCK_CLINIC_COORDS[name].lat, lng: MOCK_CLINIC_COORDS[name].lng
  }));
  const offices = mockOffices_('Mock Ortho');
  let best = null;
  offices.forEach(o => clinics.forEach(c => {
    const m = haversineMiles_(o.lat, o.lng, c.lat, c.lng);
    if (!best || m < best.m) best = { office: o.name, clinic: c.name, m: m };
  }));
  check('nearest-pair math picks the Wayne clinic', !!(best && best.clinic === 'Wayne'));
  check('nearest-pair math picks the Wayne office', !!(best && /Wayne/.test(best.office)));

  if (!getMapsKey_() && !MOCK_MODE) {
    const r = backfillUnresolvedOrgs(); // returns immediately, writes nothing
    check('backfillUnresolvedOrgs reports not-configured (no key) and writes nothing',
      !!(r && r.configured === false));
  } else {
    info('Skipped not-configured check (a key is set or MOCK_MODE is on).');
  }

  const usage = getApiUsageThisMonth();
  check('getApiUsageThisMonth returns numeric counters + month',
    !!(usage && typeof usage.geocoding === 'number' && typeof usage.places === 'number'
       && typeof usage.routes === 'number' && usage.month));

  if (MOCK_MODE) {
    const res = resolveOrg_('Mock Ortho', '');
    check('resolveOrg_ resolves in MOCK_MODE', !!(res && res.resolved === true));
    check('resolveOrg_ picks Wayne as nearest clinic', !!(res && res.nearestClinic === 'Wayne'));
    check('resolveOrg_ returns a positive drive distance',
      !!(res && typeof res.driveMiles === 'number' && res.driveMiles > 0));
  } else {
    info('Skipped live-resolver check — set MOCK_MODE = true and re-run to exercise it offline.');
  }

  lines.push('────── ' + pass + ' passed, ' + fail + ' failed ──────');
  Logger.log(lines.join('\n'));
  return { passed: pass, failed: fail, log: lines.join('\n') };
}
