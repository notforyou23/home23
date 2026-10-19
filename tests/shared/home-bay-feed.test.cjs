'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const {
  SCHEMA, PLACE, STATION_ID, TIDE_TTL_MS,
  cardinalFromDegrees, moonAt, selectNextTides, parseNoaaTime,
  tideUrl, windUrl, windFromCoops, windFromNdbc,
  refreshHomeBay, readHomeBay, formatHomeBay, bayPath,
} = require('../../shared/home-bay-feed.cjs');
const { publishHomeWeather, readHomeWorldContext, formatHomeWorldContext } = require('../../shared/home-world-context.cjs');

const AT = new Date('2026-09-27T03:00:00Z');

function home(t) {
  const root = mkdtempSync(join(tmpdir(), 'home-bay-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'config'));
  mkdirSync(join(root, 'instances/main'), { recursive: true });
  writeFileSync(join(root, 'config/home.yaml'), JSON.stringify({
    home: { primaryAgent: 'main', timezone: 'America/New_York' },
    dashboard: { tiles: { customTiles: [
      { id: 'outside-weather', kind: 'custom', mode: 'ecowitt-weather', connectionId: 'station' },
    ] } },
  }));
  return root;
}

function predictions() {
  return [
    { t: '2026-09-27 01:00', v: '4.10', type: 'H' },
    { t: '2026-09-27 07:10', v: '0.31', type: 'L' },
    { t: '2026-09-27 13:20', v: '4.82', type: 'H' },
    { t: '2026-09-27 19:30', v: '0.18', type: 'L' },
  ];
}

function noaaFetch() {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    const href = String(url);
    assert.doesNotMatch(href, /api[_-]?key|token|secret|application_key/i);
    if (href.includes('product=predictions')) {
      return new Response(JSON.stringify({ predictions: predictions() }), { status: 200 });
    }
    if (href.includes('product=wind')) {
      return new Response(JSON.stringify({
        data: [{ t: '2026-09-27 02:54', s: '8.4', d: '220', dr: 'SW', g: '11.0' }],
      }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${href}`);
  };
  return { urls, fetchImpl };
}

test('cardinal and moon are local calculations', () => {
  assert.equal(cardinalFromDegrees(0), 'N');
  assert.equal(cardinalFromDegrees(90), 'E');
  assert.equal(cardinalFromDegrees(180), 'S');
  assert.equal(cardinalFromDegrees(270), 'W');
  assert.equal(cardinalFromDegrees(220), 'SW');
  assert.equal(cardinalFromDegrees(-22.5), 'NNW');
  const neu = moonAt(new Date(Date.UTC(2000, 0, 6, 18, 14, 0)));
  assert.equal(neu.phase, 'New Moon');
  assert.ok(neu.illuminated < 0.05);
  const full = moonAt(new Date(Date.UTC(2000, 0, 6, 18, 14, 0) + 14.7652944265 * 86_400_000));
  assert.equal(full.phase, 'Full Moon');
  assert.ok(full.illuminated > 0.95);
});

test('next high and next low are the first future hilo events in ft MLLW', () => {
  const next = selectNextTides(predictions(), AT);
  assert.deepEqual(next.nextLow, { time: '2026-09-27T07:10:00.000Z', height: 0.31 });
  assert.deepEqual(next.nextHigh, { time: '2026-09-27T13:20:00.000Z', height: 4.82 });
  assert.equal(parseNoaaTime('2026-09-27 07:10'), '2026-09-27T07:10:00.000Z');
});

test('CO-OPS and NDBC wind parsers expose mph and cardinal', () => {
  const coops = windFromCoops({ data: [{ t: '2026-09-27 02:54', s: '8.4', d: '220', dr: 'SW' }] });
  assert.equal(coops.speedMph, 8.4);
  assert.equal(coops.cardinal, 'SW');
  assert.equal(coops.source, 'noaa-coops');
  const ndbc = windFromNdbc('#hdr\n2026 09 27 02 54 210 3.8 4.6 MM\n');
  assert.equal(ndbc.cardinal, 'SSW');
  assert.equal(ndbc.source, 'ndbc-sdhn4');
  assert.equal(ndbc.speedMph, 8.5);
});

test('house refreshes Sandy Hook once and caches tide predictions for hours', async (t) => {
  const root = home(t);
  const first = noaaFetch();
  const bay = await refreshHomeBay({ home23Root: root, now: AT, fetchImpl: first.fetchImpl });
  assert.equal(bay.schema, SCHEMA);
  assert.equal(bay.place, PLACE);
  assert.equal(bay.station.id, STATION_ID);
  assert.equal(bay.status, 'fresh');
  assert.equal(bay.tide.datum, 'MLLW');
  assert.equal(bay.tide.unit, 'ft');
  assert.equal(bay.tide.nextHigh.height, 4.82);
  assert.equal(bay.tide.nextLow.height, 0.31);
  assert.equal(bay.bayWind.speedMph, 8.4);
  assert.equal(bay.bayWind.cardinal, 'SW');
  assert.equal(bay.moon.phase, moonAt(AT).phase);
  assert.equal(first.urls.length, 2);
  assert.match(first.urls[0], /interval=hilo/);
  assert.match(first.urls[0], /datum=MLLW/);
  assert.match(first.urls[0], /station=8531680/);
  assert.match(first.urls[1], /product=wind/);
  assert.equal(new URL(tideUrl(AT)).origin, 'https://api.tidesandcurrents.noaa.gov');
  assert.equal(new URL(windUrl()).origin, 'https://api.tidesandcurrents.noaa.gov');

  const second = noaaFetch();
  const cached = await refreshHomeBay({
    home23Root: root,
    now: new Date(AT.getTime() + 20 * 60_000),
    fetchImpl: second.fetchImpl,
  });
  assert.equal(second.urls.length, 0, 'fresh tide and wind cache must not contact NOAA again');
  assert.equal(cached.tide.nextHigh.height, 4.82);
  assert.equal(readHomeBay({ home23Root: root, now: new Date(AT.getTime() + 20 * 60_000) }).bayWind.cardinal, 'SW');

  const later = noaaFetch();
  await refreshHomeBay({
    home23Root: root,
    now: new Date(AT.getTime() + TIDE_TTL_MS + 1),
    fetchImpl: later.fetchImpl,
  });
  assert.ok(later.urls.some(url => url.includes('product=predictions')));
  assert.doesNotMatch(readFileSync(bayPath(root), 'utf8'), /fixture|secret|apiKey/i);
});

test('Ecowitt weather fields stay intact when the bay snapshot is attached', async (t) => {
  const root = home(t);
  const at = AT;
  publishHomeWeather({
    home23Root: root, tileId: 'outside-weather', now: at,
    weather: { rawData: {
      outdoor: { temperature: { value: '12.5', unit: 'ºC', time: String(at.getTime() / 1000) },
        humidity: { value: '60', unit: '%', time: String(at.getTime() / 1000) } },
      wind: { wind_speed: { value: '3.5', unit: 'km/h', time: String(at.getTime() / 1000) },
        wind_direction: { value: '45', unit: 'º', time: String(at.getTime() / 1000) } },
    } },
  });
  const { fetchImpl } = noaaFetch();
  await refreshHomeBay({ home23Root: root, now: at, fetchImpl });
  const weatherFile = JSON.parse(readFileSync(join(root, 'instances/.house/world-context/weather.json'), 'utf8'));
  assert.equal(weatherFile.schema, 'home23.home-weather.v1');
  assert.equal(weatherFile.source, 'ecowitt');
  assert.equal(weatherFile.readings.temperature.value, 12.5);
  assert.equal(weatherFile.readings.wind.value, 3.5);
  assert.equal(weatherFile.readings.humidity.value, 60);
  assert.equal(weatherFile.readings.windDirection.value, 45);
  assert.equal(weatherFile.readings.windDirection.cardinal, 'NE');
  assert.equal(weatherFile.bay.schema, SCHEMA);
  assert.equal(weatherFile.bay.tide.nextHigh.height, 4.82);

  publishHomeWeather({
    home23Root: root, tileId: 'outside-weather', now: at,
    weather: { rawData: {
      outdoor: { temperature: { value: '13.0', unit: 'ºC', time: String(at.getTime() / 1000) } },
      wind: { wind_speed: { value: '4.0', unit: 'km/h', time: String(at.getTime() / 1000) } },
    } },
  });
  const republished = JSON.parse(readFileSync(join(root, 'instances/.house/world-context/weather.json'), 'utf8'));
  assert.equal(republished.readings.temperature.value, 13);
  assert.equal(republished.bay.tide.nextHigh.height, 4.82, 'an Ecowitt publish must keep the cached bay feed');

  const context = readHomeWorldContext({ home23Root: root, now: at });
  assert.equal(context.weather.readings.temperature.value, 13);
  assert.equal(context.bay.tide.nextHigh.height, 4.82);
  assert.match(formatHomeWorldContext(context), /Bay \(Leonardo \/ Sandy Hook\): fresh/);
  assert.match(formatHomeBay(context.bay), /4\.82 ft MLLW/);
});

test('CO-OPS wind failure falls back to NDBC SDHN4 without a paid key', async (t) => {
  const root = home(t);
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    const href = String(url);
    assert.doesNotMatch(href, /api[_-]?key|token|secret/i);
    if (href.includes('product=predictions')) {
      return new Response(JSON.stringify({ predictions: predictions() }), { status: 200 });
    }
    if (href.includes('product=wind')) {
      return new Response(JSON.stringify({ error: { message: 'No data was found' } }), { status: 200 });
    }
    if (href.includes('SDHN4')) {
      return new Response('#YY MM DD hh mm WDIR WSPD\n2026 09 27 02 48 180 4.0 5.0\n', { status: 200 });
    }
    throw new Error(href);
  };
  const bay = await refreshHomeBay({ home23Root: root, now: AT, fetchImpl });
  assert.equal(bay.bayWind.source, 'ndbc-sdhn4');
  assert.equal(bay.bayWind.cardinal, 'S');
  assert.ok(urls.some(url => url.includes('SDHN4')));
});
