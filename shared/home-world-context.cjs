'use strict';

// The existing authenticated tile refresh owns station intake. This module
// carries only bounded readings between processes in the same home; it never
// fetches weather, loads secrets, or borrows another home's observations.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const yaml = require('js-yaml');
const MAX_AGE_MS = 20 * 60 * 1000;
const READING_NAMES = ['temperature', 'humidity', 'wind', 'gust', 'pressure', 'rainToday', 'feelsLike', 'uv', 'indoorTemperature', 'indoorHumidity'];
function readBounded(file, parse, maximum = 256 * 1024) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > maximum) return null;
    return parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}
function homeProfile(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) return { timezone: null, tileId: null };
  const config = readBounded(path.join(root, 'config/home.yaml'), yaml.load) || {};
  const primary = config.home?.primaryAgent;
  const resident = typeof primary === 'string' && /^[a-z][a-z0-9-]{0,62}$/.test(primary)
    ? readBounded(path.join(root, 'instances', primary, 'config.yaml'), yaml.load) : null;
  const tiles = (Array.isArray(config.dashboard?.tiles?.customTiles) ? config.dashboard.tiles.customTiles : [])
    .filter(tile => tile?.mode === 'ecowitt-weather' && typeof tile.id === 'string');
  const selected = config.home?.weatherTileId;
  const tile = typeof selected === 'string' ? tiles.find(tile => tile.id === selected) : tiles.length === 1 ? tiles[0] : null;
  return { timezone: config.home?.timezone || config.agent?.timezone || resident?.agent?.timezone || null, tileId: tile?.id || null };
}
function weatherPath(root) { return path.join(root, 'instances/.house/world-context/weather.json'); }
function stamp(value) {
  const n = Number(value);
  const ms = typeof value === 'string' && /[-T:]/.test(value) ? Date.parse(value) : n > 1e12 ? n : n * 1000;
  const date = new Date(ms);
  return Number.isFinite(ms) && ms > 0 && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function measure(raw, dimensionlessUnit = null) {
  if (!raw || raw.value === '' || raw.value === null || raw.value === undefined) return null;
  const value = Number(raw.value);
  const unit = (typeof raw.unit === 'string' ? raw.unit.replaceAll('º', '°').trim().slice(0, 24) : '') || dimensionlessUnit;
  const observedAt = stamp(raw.time);
  return Number.isFinite(value) && unit && observedAt ? { value, unit, observedAt } : null;
}
function weatherSnapshot({ tileId, weather, failed = false, now = new Date() }) {
  const raw = weather?.rawData || {};
  const readings = {};
  for (const [name, source] of [
    ['temperature', raw.outdoor?.temperature], ['humidity', raw.outdoor?.humidity],
    ['wind', raw.wind?.wind_speed], ['gust', raw.wind?.wind_gust],
    ['pressure', raw.pressure?.relative], ['rainToday', raw.rainfall?.daily],
    ['feelsLike', raw.outdoor?.feels_like], ['uv', raw.solar_and_uvi?.uvi],
    ['indoorTemperature', raw.indoor?.temperature], ['indoorHumidity', raw.indoor?.humidity],
  ]) {
    const reading = measure(source, name === 'uv' ? 'index' : null);
    if (reading) readings[name] = reading;
  }
  const observedAt = readings.temperature?.observedAt || null;
  const age = observedAt ? now.getTime() - Date.parse(observedAt) : NaN;
  const status = !observedAt || !Number.isFinite(age) || age < -60_000 ? 'unavailable'
    : failed || age > MAX_AGE_MS ? 'stale' : 'fresh';
  return { schema: 'home23.home-weather.v1', source: 'ecowitt', tileId,
    observedAt, checkedAt: now.toISOString(), status, readings: status === 'unavailable' ? {} : readings };
}
function publishHomeWeather({ home23Root, ...input }) {
  if (homeProfile(home23Root).tileId !== input.tileId) return null;
  const snapshot = weatherSnapshot(input);
  const file = weatherPath(home23Root);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(snapshot) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, file);
  return snapshot;
}
function readHomeWorldContext({ home23Root, timezone, now = new Date() } = {}) {
  const profile = homeProfile(home23Root);
  const configuredZone = profile.timezone || timezone || null;
  let zone = null;
  let localTime = `${now.toISOString()} (UTC; home timezone unavailable)`;
  let localHour = null;
  let localDay = null;
  if (typeof configuredZone === 'string') {
    try {
      const formatter = new Intl.DateTimeFormat('en-US', { timeZone: configuredZone, weekday: 'long', year: 'numeric',
        month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });
      localTime = `${formatter.format(now)} (${configuredZone})`;
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: configuredZone, weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(now);
      localHour = Number(parts.find(p => p.type === 'hour').value) % 24;
      localDay = parts.find(p => p.type === 'weekday').value.toLowerCase();
      zone = configuredZone;
    } catch { localTime = `${now.toISOString()} (UTC; configured home timezone invalid)`; }
  }
  let weather = { status: 'unavailable', source: 'ecowitt', observedAt: null, checkedAt: null, readings: {}, reason: 'No configured home station reading is available.' };
  if (profile.tileId) {
    const saved = readBounded(weatherPath(home23Root), JSON.parse, 16 * 1024);
    if (saved?.schema === 'home23.home-weather.v1' && saved.source === 'ecowitt' && saved.tileId === profile.tileId
        && ['fresh', 'stale', 'unavailable'].includes(saved.status)) {
      const age = now.getTime() - Date.parse(saved.observedAt);
      const readings = {};
      for (const name of READING_NAMES) {
        const r = saved.readings?.[name];
        if (r && Number.isFinite(r.value) && typeof r.unit === 'string' && r.unit.length <= 24 && Number.isFinite(Date.parse(r.observedAt))) readings[name] = r;
      }
      const status = saved.status === 'unavailable' || !readings.temperature || !Number.isFinite(age) || age < -60_000 ? 'unavailable'
        : saved.status === 'stale' || age > MAX_AGE_MS ? 'stale' : 'fresh';
      weather = { status, source: 'ecowitt', tileId: saved.tileId, observedAt: saved.observedAt, checkedAt: saved.checkedAt,
        readings: status === 'unavailable' ? {} : readings,
        reason: status === 'fresh' ? '' : status === 'stale' ? 'Last station reading; do not describe it as current weather.' : 'Station data unavailable.' };
    }
  }
  return { now: now.toISOString(), timezone: zone, localTime, localHour, localDay, weather };
}
function formatHomeWorldContext(context) {
  const lines = ['[CURRENT HOME CONTEXT — observed now; older conversation dates are historical]', `Current local time: ${context.localTime}.`, `UTC: ${context.now}.`];
  const weather = context.weather;
  if (weather.status === 'unavailable') lines.push('Home weather: unavailable. Do not infer conditions from older messages or another location.');
  else {
    const values = Object.entries(weather.readings).map(([name, reading]) => {
      const old = Date.parse(context.now) - Date.parse(reading.observedAt) > MAX_AGE_MS;
      return `${name}: ${reading.value} ${reading.unit}${reading.observedAt !== weather.observedAt ? ` (observed ${reading.observedAt}${old ? '; stale' : ''})` : ''}`;
    });
    lines.push(`Home Ecowitt station: ${weather.status}; observed ${weather.observedAt}; checked ${weather.checkedAt}.`, values.join('; ') + '.');
    if (weather.status === 'stale') lines.push(weather.reason);
  }
  return lines.join('\n');
}
module.exports = { readHomeWorldContext, formatHomeWorldContext, publishHomeWeather, weatherSnapshot };
