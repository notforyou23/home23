'use strict';

// House-side Leonardo / Sandy Hook bay feed. NOAA public endpoints only —
// no keys. Tide predictions are cached for hours; wind is refreshed on a
// shorter cadence. Moon is computed locally. This module never loads secrets.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const SCHEMA = 'home23.bay-feed.v1';
const PLACE = 'Leonardo, NJ';
const STATION_ID = '8531680';
const STATION_NAME = 'Sandy Hook, NJ';
const NDBC_ID = 'SDHN4';
const APPLICATION = 'home23';
const COOPS = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';
const NDBC_REALTIME = `https://www.ndbc.noaa.gov/data/realtime2/${NDBC_ID}.txt`;
const TIDE_TTL_MS = 6 * 60 * 60 * 1000;
const WIND_TTL_MS = 30 * 60 * 1000;
const WIND_STALE_MS = 2 * 60 * 60 * 1000;
const PREDICTION_DAYS = 3;
const SYNODIC_DAYS = 29.530588853;
const KNOWN_NEW_MOON_MS = Date.UTC(2000, 0, 6, 18, 14, 0);
const CARDINALS = Object.freeze(['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']);
const PHASES = Object.freeze([
  [0.03, 'New Moon'], [0.22, 'Waxing Crescent'], [0.28, 'First Quarter'], [0.47, 'Waxing Gibbous'],
  [0.53, 'Full Moon'], [0.72, 'Waning Gibbous'], [0.78, 'Last Quarter'], [0.97, 'Waning Crescent'],
  [1, 'New Moon'],
]);

function bayPath(root) { return path.join(root, 'instances/.house/world-context/bay.json'); }
function weatherPath(root) { return path.join(root, 'instances/.house/world-context/weather.json'); }

function readBounded(file, parse, maximum = 64 * 1024) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > maximum) return null;
    return parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function cardinalFromDegrees(deg) {
  const d = ((Number(deg) % 360) + 360) % 360;
  return Number.isFinite(d) ? CARDINALS[Math.round(d / 22.5) % 16] : null;
}

function moonAt(date = new Date()) {
  const days = (date.getTime() - KNOWN_NEW_MOON_MS) / 86_400_000;
  const age = ((days % SYNODIC_DAYS) + SYNODIC_DAYS) % SYNODIC_DAYS;
  const cycle = age / SYNODIC_DAYS;
  const illuminated = Math.round(500 * (1 - Math.cos(2 * Math.PI * cycle))) / 1000;
  const phase = PHASES.find(([limit]) => cycle < limit)?.[1] || 'New Moon';
  return { illuminated, phase };
}

function yyyymmdd(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function parseNoaaTime(value) {
  if (typeof value !== 'string') return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}:00.000Z` : value;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function selectNextTides(predictions, now = new Date()) {
  let nextHigh = null;
  let nextLow = null;
  const at = now.getTime();
  for (const row of Array.isArray(predictions) ? predictions : []) {
    const time = parseNoaaTime(row?.t);
    const height = Number(row?.v);
    const type = row?.type;
    if (!time || !Number.isFinite(height) || Date.parse(time) <= at) continue;
    const event = { time, height };
    if (type === 'H' && !nextHigh) nextHigh = event;
    if (type === 'L' && !nextLow) nextLow = event;
    if (nextHigh && nextLow) break;
  }
  return { nextHigh, nextLow };
}

function publicBay(snapshot) {
  if (!snapshot || snapshot.schema !== SCHEMA) return unavailableBay(snapshot?.checkedAt || null);
  return {
    schema: SCHEMA, place: snapshot.place || PLACE,
    station: snapshot.station || { id: STATION_ID, name: STATION_NAME, source: 'noaa-coops' },
    status: snapshot.status, checkedAt: snapshot.checkedAt || null,
    ...(snapshot.tide ? { tide: snapshot.tide } : {}),
    ...(snapshot.bayWind ? { bayWind: snapshot.bayWind } : {}),
    ...(snapshot.moon ? { moon: snapshot.moon } : {}),
    ...(snapshot.reason ? { reason: snapshot.reason } : {}),
  };
}

function unavailableBay(checkedAt = null, reason = 'No house bay reading is available.') {
  return { schema: SCHEMA, place: PLACE, station: { id: STATION_ID, name: STATION_NAME, source: 'noaa-coops' },
    status: 'unavailable', checkedAt, moon: moonAt(), reason };
}

function deriveSnapshot(stored, now = new Date()) {
  if (!stored || stored.schema !== SCHEMA) return unavailableBay(now.toISOString());
  const tide = { datum: 'MLLW', unit: 'ft', ...selectNextTides(stored._cache?.predictions, now) };
  const moon = moonAt(now);
  const wind = stored.bayWind && Number.isFinite(stored.bayWind.speedMph) ? stored.bayWind : null;
  const windAge = wind?.observedAt ? now.getTime() - Date.parse(wind.observedAt) : NaN;
  const predAge = stored._cache?.predictionsFetchedAt
    ? now.getTime() - Date.parse(stored._cache.predictionsFetchedAt) : NaN;
  const hasTide = Boolean(tide.nextHigh && tide.nextLow);
  const status = !hasTide && !wind ? 'unavailable'
    : !hasTide || predAge > TIDE_TTL_MS * 2 || (wind && Number.isFinite(windAge) && windAge > WIND_STALE_MS) ? 'stale'
    : 'fresh';
  return {
    schema: SCHEMA, place: PLACE,
    station: { id: STATION_ID, name: STATION_NAME, source: 'noaa-coops' },
    status, checkedAt: stored.checkedAt || now.toISOString(),
    tide: hasTide || tide.nextHigh || tide.nextLow ? tide : undefined,
    ...(wind ? { bayWind: wind } : {}),
    moon,
    ...(status === 'fresh' ? {} : { reason: status === 'stale'
      ? 'Last bay reading; do not describe it as current.' : 'Bay data unavailable.' }),
    _cache: stored._cache || null,
  };
}

function tideUrl(now) {
  const begin = yyyymmdd(now);
  const end = yyyymmdd(new Date(now.getTime() + PREDICTION_DAYS * 86_400_000));
  const url = new URL(COOPS);
  url.searchParams.set('begin_date', begin);
  url.searchParams.set('end_date', end);
  url.searchParams.set('station', STATION_ID);
  url.searchParams.set('product', 'predictions');
  url.searchParams.set('datum', 'MLLW');
  url.searchParams.set('time_zone', 'gmt');
  url.searchParams.set('interval', 'hilo');
  url.searchParams.set('units', 'english');
  url.searchParams.set('format', 'json');
  url.searchParams.set('application', APPLICATION);
  return url.toString();
}

function windUrl() {
  const url = new URL(COOPS);
  url.searchParams.set('date', 'latest');
  url.searchParams.set('station', STATION_ID);
  url.searchParams.set('product', 'wind');
  url.searchParams.set('time_zone', 'gmt');
  url.searchParams.set('units', 'english');
  url.searchParams.set('format', 'json');
  url.searchParams.set('application', APPLICATION);
  return url.toString();
}

async function getJson(fetchImpl, url) {
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(15_000),
    headers: { Accept: 'application/json', 'User-Agent': APPLICATION },
  });
  if (!response.ok) throw new Error(`NOAA ${response.status}`);
  const body = await response.json();
  if (body?.error) throw new Error(String(body.error.message || body.error));
  return body;
}

async function fetchTidePredictions(fetchImpl, now) {
  const body = await getJson(fetchImpl, tideUrl(now));
  const rows = Array.isArray(body?.predictions) ? body.predictions : [];
  const predictions = rows.filter(row => row && (row.type === 'H' || row.type === 'L') && parseNoaaTime(row.t) && Number.isFinite(Number(row.v)))
    .map(row => ({ t: row.t, v: String(row.v), type: row.type }));
  if (!predictions.length) throw new Error('NOAA tide predictions empty');
  return predictions;
}

function windFromCoops(body) {
  const row = Array.isArray(body?.data) ? body.data[body.data.length - 1] : null;
  const speedMph = Number(row?.s);
  const directionDeg = Number(row?.d);
  const observedAt = parseNoaaTime(row?.t);
  const cardinal = (typeof row?.dr === 'string' && CARDINALS.includes(row.dr) ? row.dr : null)
    || cardinalFromDegrees(directionDeg);
  if (!Number.isFinite(speedMph) || !Number.isFinite(directionDeg) || !observedAt || !cardinal) return null;
  return { speedMph, directionDeg, cardinal, observedAt, source: 'noaa-coops' };
}

function windFromNdbc(text) {
  const line = String(text).split(/\r?\n/).find(row => row && !row.startsWith('#'));
  if (!line) return null;
  const cols = line.trim().split(/\s+/);
  const year = Number(cols[0]); const month = Number(cols[1]); const day = Number(cols[2]);
  const hour = Number(cols[3]); const minute = Number(cols[4]);
  const directionDeg = Number(cols[5]);
  const speedMs = Number(cols[6]);
  if (![year, month, day, hour, minute, directionDeg, speedMs].every(Number.isFinite)) return null;
  const observedAt = new Date(Date.UTC(year < 100 ? 2000 + year : year, month - 1, day, hour, minute)).toISOString();
  const cardinal = cardinalFromDegrees(directionDeg);
  if (!cardinal) return null;
  return { speedMph: Math.round(speedMs * 2.23694 * 10) / 10, directionDeg, cardinal, observedAt, source: 'ndbc-sdhn4' };
}

async function fetchBayWind(fetchImpl) {
  try {
    const wind = windFromCoops(await getJson(fetchImpl, windUrl()));
    if (wind) return wind;
  } catch { /* Sandy Hook met can drop; try the NDBC twin. */ }
  const response = await fetchImpl(NDBC_REALTIME, {
    signal: AbortSignal.timeout(15_000),
    headers: { Accept: 'text/plain', 'User-Agent': APPLICATION },
  });
  if (!response.ok) throw new Error(`NDBC ${response.status}`);
  const wind = windFromNdbc(await response.text());
  if (!wind) throw new Error('NDBC wind empty');
  return wind;
}

function attachBayToWeather(home23Root, bay) {
  const file = weatherPath(home23Root);
  const weather = readBounded(file, JSON.parse, 32 * 1024);
  if (!weather || weather.schema !== 'home23.home-weather.v1') return;
  weather.bay = publicBay(bay);
  writeJson(file, weather);
}

function readStoredBay(home23Root) {
  if (typeof home23Root !== 'string' || !path.isAbsolute(home23Root)) return null;
  return readBounded(bayPath(home23Root), JSON.parse)
    || readBounded(weatherPath(home23Root), JSON.parse, 32 * 1024)?.bay || null;
}

function readHomeBay({ home23Root, now = new Date() } = {}) {
  return publicBay(deriveSnapshot(readStoredBay(home23Root), now));
}

function needsTide(cache, now) {
  const predictions = cache?.predictions;
  const fetchedAt = cache?.predictionsFetchedAt;
  if (!Array.isArray(predictions) || !predictions.length || !fetchedAt) return true;
  if (now.getTime() - Date.parse(fetchedAt) > TIDE_TTL_MS) return true;
  const next = selectNextTides(predictions, now);
  return !next.nextHigh || !next.nextLow;
}

function needsWind(cache, stored, now) {
  if (!stored?.bayWind || !cache?.windFetchedAt) return true;
  return now.getTime() - Date.parse(cache.windFetchedAt) > WIND_TTL_MS;
}

async function refreshHomeBay({ home23Root, now = new Date(), fetchImpl = globalThis.fetch } = {}) {
  if (typeof home23Root !== 'string' || !path.isAbsolute(home23Root)) return unavailableBay(now.toISOString());
  if (typeof fetchImpl !== 'function') fetchImpl = globalThis.fetch;
  const stored = readStoredBay(home23Root) || {};
  const cache = stored._cache && typeof stored._cache === 'object' ? { ...stored._cache } : {};
  let tideError = null;
  let windError = null;
  if (needsTide(cache, now)) {
    try {
      cache.predictions = await fetchTidePredictions(fetchImpl, now);
      cache.predictionsFetchedAt = now.toISOString();
    } catch (err) { tideError = err; }
  }
  if (needsWind(cache, stored, now)) {
    try {
      stored.bayWind = await fetchBayWind(fetchImpl);
      cache.windFetchedAt = now.toISOString();
    } catch (err) { windError = err; }
  }
  stored.schema = SCHEMA;
  stored.place = PLACE;
  stored.station = { id: STATION_ID, name: STATION_NAME, source: 'noaa-coops' };
  stored.checkedAt = now.toISOString();
  stored._cache = cache;
  const snapshot = deriveSnapshot(stored, now);
  if (snapshot.status === 'unavailable' && (tideError || windError)) {
    snapshot.reason = 'Bay data unavailable.';
  }
  writeJson(bayPath(home23Root), snapshot);
  try { attachBayToWeather(home23Root, snapshot); } catch { /* weather.json is optional */ }
  return publicBay(snapshot);
}

function formatHomeBay(bay) {
  if (!bay || bay.status === 'unavailable') return 'Bay (Leonardo / Sandy Hook): unavailable.';
  const tide = bay.tide || {};
  const high = tide.nextHigh ? `next high ${tide.nextHigh.time} ${tide.nextHigh.height} ft ${tide.datum || 'MLLW'}` : 'next high unknown';
  const low = tide.nextLow ? `next low ${tide.nextLow.time} ${tide.nextLow.height} ft ${tide.datum || 'MLLW'}` : 'next low unknown';
  const wind = bay.bayWind
    ? `bay wind ${bay.bayWind.speedMph} mph ${bay.bayWind.cardinal}` : 'bay wind unknown';
  const moon = bay.moon ? `moon ${bay.moon.phase} (${Math.round(bay.moon.illuminated * 100)}%)` : 'moon unknown';
  const stale = bay.status === 'stale' ? ' Last bay reading; do not describe it as current.' : '';
  return `Bay (Leonardo / Sandy Hook): ${bay.status}; ${high}; ${low}; ${wind}; ${moon}.${stale}`;
}

module.exports = {
  SCHEMA, PLACE, STATION_ID, STATION_NAME, TIDE_TTL_MS, WIND_TTL_MS,
  bayPath, cardinalFromDegrees, moonAt, selectNextTides, parseNoaaTime,
  tideUrl, windUrl, windFromCoops, windFromNdbc, publicBay, readHomeBay,
  refreshHomeBay, formatHomeBay, attachBayToWeather, deriveSnapshot,
};
