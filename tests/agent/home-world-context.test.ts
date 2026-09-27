import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { ContextManager } from '../../src/agent/context.js';
import { AgentLoop } from '../../src/agent/loop.js';
import { ConversationHistory } from '../../src/agent/history.js';
import { WeatherChannel } from '../../engine/src/channels/domain/weather-channel.js';
const require = createRequire(import.meta.url);
const { publishHomeWeather, readHomeWorldContext, formatHomeWorldContext } = require('../../shared/home-world-context.cjs');
const { Home23TileService } = require('../../engine/src/dashboard/home23-tiles.js');
const { buildTemporalContext } = require('../../engine/src/core/temporal-context.js');
const { Orchestrator } = require('../../engine/src/core/orchestrator.js');
const registry = require('../../engine/src/sensors/registry.js');
const AT = new Date('2026-09-27T03:00:00Z');
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'home-world-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'config')); mkdirSync(join(root, 'instances/main/workspace'), { recursive: true });
  const config = { home: { primaryAgent: 'main' }, dashboard: { tiles: { customTiles: [
    { id: 'outside-weather', kind: 'custom', mode: 'ecowitt-weather', connectionId: 'station', refreshMs: 600_000 },
  ] } } };
  writeFileSync(join(root, 'config/home.yaml'), JSON.stringify(config));
  writeFileSync(join(root, 'instances/main/config.yaml'), JSON.stringify({ agent: { timezone: 'America/Los_Angeles' } }));
  writeFileSync(join(root, 'config/secrets.yaml'), JSON.stringify({ dashboard: { tileConnections: { connections: [
    { id: 'station', type: 'ecowitt', secrets: { applicationKey: 'fixture-app', apiKey: 'fixture-key', mac: 'fixture-device' } },
  ] } } }));
  const raw = (at = AT) => ({ outdoor: { temperature: { value: '12.5', unit: 'ºC', time: String(at.getTime() / 1000) },
    humidity: { value: '60', unit: '%', time: String(at.getTime() / 1000) } },
    wind: { wind_speed: { value: '3.5', unit: 'km/h', time: String(at.getTime() / 1000) } },
    solar_and_uvi: { uvi: { value: '2', unit: '', time: String(at.getTime() / 1000) } } });
  return { root, config, raw };
}

test('one configured home supplies advancing local time and timestamped station readings; stale and unrelated homes remain honest', t => {
  const f = fixture(t);
  publishHomeWeather({ home23Root: f.root, tileId: 'outside-weather', weather: { rawData: f.raw() }, now: AT });
  const current = readHomeWorldContext({ home23Root: f.root, now: AT });
  assert.equal(current.timezone, 'America/Los_Angeles'); assert.equal(current.localHour, 20);
  assert.equal(current.weather.status, 'fresh'); assert.equal(current.weather.observedAt, AT.toISOString());
  assert.equal(current.weather.readings.temperature.unit, '°C'); assert.equal(current.weather.readings.wind.unit, 'km/h');
  const later = readHomeWorldContext({ home23Root: f.root, now: new Date(AT.getTime() + 21 * 60_000) });
  assert.equal(later.weather.status, 'stale'); assert.equal(later.weather.observedAt, current.weather.observedAt);
  assert.match(formatHomeWorldContext(later), /do not describe it as current/);
  const unknown = readHomeWorldContext({ home23Root: join(f.root, 'different-home'), now: AT });
  assert.equal(unknown.timezone, null); assert.equal(unknown.weather.status, 'unavailable');
  assert.match(unknown.localTime, /UTC; home timezone unavailable/);
  assert.doesNotMatch(readFileSync(join(f.root, 'instances/.house/world-context/weather.json'), 'utf8'), /fixture-key|fixture-app|fixture-device/);
});

test('the existing background tile refresh publishes without UI; another agent does not start a second Ecowitt refresh', async t => {
  const f = fixture(t); const previous = globalThis.fetch;
  let calls = 0;
  const now = new Date();
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ code: 0, data: f.raw(now) }), { status: 200 }); };
  t.after(() => { globalThis.fetch = previous; registry.remove('tile.outside-weather'); });
  const primary = new Home23TileService({ home23Root: f.root, agentName: 'main', logger: { warn() {} } });
  const helper = new Home23TileService({ home23Root: f.root, agentName: 'another', logger: { warn() {} } });
  t.after(() => { primary.stopBackgroundRefresh(); helper.stopBackgroundRefresh(); });
  for (let n = 0; n < 20 && primary.backgroundRefreshInFlight.size; n++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(calls, 1);
  assert.equal(readHomeWorldContext({ home23Root: f.root }).weather.status, 'fresh');
  const stamp = readHomeWorldContext({ home23Root: f.root }).weather.observedAt;
  const beforeSecondary = readFileSync(join(f.root, 'instances/.house/world-context/weather.json'), 'utf8');
  globalThis.fetch = async () => { calls++; throw new Error('secondary dashboards must not fetch Ecowitt'); };
  const secondaryTile = await helper.getTileData('outside-weather');
  assert.equal(calls, 1, 'an actual secondary UI request consumes the primary snapshot');
  assert.equal(secondaryTile.content.value, '12.5 °C');
  assert.equal(secondaryTile.content.metrics.find((metric: { label: string }) => metric.label === 'Wind').value, '3.5 km/h');
  assert.equal(secondaryTile.content.metrics.find((metric: { label: string }) => metric.label === 'UV').value, '2 index');
  assert.equal(secondaryTile.observedAt, stamp);
  assert.equal(readFileSync(join(f.root, 'instances/.house/world-context/weather.json'), 'utf8'), beforeSecondary,
    'a secondary request cannot overwrite primary freshness or availability');
  primary.invalidateTileCache('outside-weather');
  globalThis.fetch = async () => new Response(JSON.stringify({ code: -1, msg: 'fixture limited' }), { status: 200 });
  await primary.getTileData('outside-weather');
  assert.equal(readHomeWorldContext({ home23Root: f.root }).weather.status, 'stale');
  assert.equal(readHomeWorldContext({ home23Root: f.root }).weather.observedAt, stamp);
  primary.invalidateTileCache('outside-weather');
  globalThis.fetch = async () => new Response(JSON.stringify({ code: 0, data: f.raw(now) }), { status: 200 });
  await primary.getTileData('outside-weather');
  assert.equal(registry.get('tile.outside-weather').stale, false, 'fresh success clears the merged old stale flag');
  assert.equal(registry.get('tile.outside-weather').ts, stamp, 'station time is not rewritten as refresh time');
});

test('the first scheduled weather refresh fetches after delayed initial completion instead of serving the UI cache', async t => {
  const f = fixture(t); const previous = globalThis.fetch;
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: AT });
  let calls = 0;
  let finishInitial!: (response: Response) => void;
  let finishScheduled!: (response: Response) => void;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return new Promise<Response>(resolve => { finishInitial = resolve; });
    return new Promise<Response>(resolve => { finishScheduled = resolve; });
  };
  t.after(() => { globalThis.fetch = previous; registry.remove('tile.outside-weather'); });
  const primary = new Home23TileService({ home23Root: f.root, agentName: 'main', logger: { warn() {} } });
  const helper = new Home23TileService({ home23Root: f.root, agentName: 'another', logger: { warn() {} } });
  t.after(() => { primary.stopBackgroundRefresh(); helper.stopBackgroundRefresh(); });
  assert.equal(calls, 1);
  assert.equal(helper.backgroundRefreshTimers.size, 0);
  t.mock.timers.tick(1000); // Initial fetch completes after the interval was scheduled.
  finishInitial(new Response(JSON.stringify({ code: 0, data: f.raw(AT) }), { status: 200 }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(primary.backgroundRefreshInFlight.size, 0);
  const initial = readHomeWorldContext({ home23Root: f.root }).weather;
  assert.equal(initial.checkedAt, new Date(AT.getTime() + 1000).toISOString());
  t.mock.timers.tick(599_000); // First 10-minute callback; UI cache would expire 1 second later.
  assert.equal(calls, 2, 'the scheduled refresh must contact the provider at its first interval');
  const concurrentPrimary = await primary.getTileData('outside-weather');
  assert.equal(concurrentPrimary.cache.hit, true, 'UI keeps its still-valid reading while the scheduled request runs');
  assert.equal(concurrentPrimary.observedAt, initial.observedAt);
  assert.equal(calls, 2, 'a concurrent primary UI read must not start a duplicate provider request');
  finishScheduled(new Response(JSON.stringify({ code: 0, data: f.raw(new Date()) }), { status: 200 }));
  await new Promise(resolve => setImmediate(resolve));
  const refreshed = readHomeWorldContext({ home23Root: f.root }).weather;
  assert.equal(refreshed.checkedAt, new Date(AT.getTime() + 600_000).toISOString());
  assert.equal(refreshed.observedAt, refreshed.checkedAt);
  assert.equal(refreshed.status, 'fresh');
  const secondary = await helper.getTileData('outside-weather');
  assert.equal(secondary.observedAt, refreshed.observedAt);
  assert.equal(calls, 2, 'secondary UI reads still use the shared snapshot');
});

test('domain weather and background thoughts consume the same home snapshot without a cloud fetch', async t => {
  const f = fixture(t);
  publishHomeWeather({ home23Root: f.root, tileId: 'outside-weather', weather: { rawData: f.raw() }, now: AT });
  const channel = new WeatherChannel({ home23Root: f.root, now: () => AT });
  const observation = channel.verify(channel.parse((await channel.poll())[0]));
  assert.equal(observation.flag, 'COLLECTED'); assert.equal(observation.producedAt, AT.toISOString());
  const stale = new WeatherChannel({ home23Root: f.root, now: () => new Date(AT.getTime() + 21 * 60_000) });
  assert.equal(stale.verify(stale.parse((await stale.poll())[0])).flag, 'ZERO_CONTEXT');
  const temporal = buildTemporalContext({ home23Root: f.root, workspacePath: join(f.root, 'instances/main/workspace'), now: AT });
  assert.equal(temporal.jtrTime.timezone, 'America/Los_Angeles'); assert.equal(temporal.jtrTime.phase, 'evening');
  assert.match(temporal.homeContext, /12.5 °C/);
  assert.equal(buildTemporalContext({ home23Root: join(f.root, 'unconfigured'), now: AT }).jtrTime.phase, 'unknown');
  const orchestrator = Object.create(Orchestrator.prototype);
  orchestrator.home23Root = f.root;
  orchestrator.processStartedAt = Date.now() - 60_000;
  orchestrator.currentTemporalContext = temporal;
  const machine = orchestrator.createThinkingMachine({ unifiedClient: {}, memory: {}, discoveryEngine: {}, logger: { warn() {} } });
  publishHomeWeather({ home23Root: f.root, tileId: 'outside-weather', weather: { rawData: f.raw(new Date()) } });
  const first = machine.getTemporalContext();
  assert.equal(first.homeWeather.status, 'fresh');
  assert.equal(first.jtrTime.timezone, 'America/Los_Angeles');
  assert.ok(first.loopDuration.continuousRunMs >= 60_000);
  await new Promise(resolve => setTimeout(resolve, 5));
  publishHomeWeather({ home23Root: f.root, tileId: 'outside-weather', weather: { rawData: f.raw(new Date(Date.now() - 21 * 60_000)) } });
  const next = machine.getTemporalContext();
  assert.ok(Date.parse(next.now) > Date.parse(first.now), 'the actual thinking callback advances without executeCycle');
  assert.equal(next.homeWeather.status, 'stale', 'each independent thought re-reads station freshness');
});

test('the actual shared AgentLoop injects live context into consecutive resident/helper turns without changing static identity', async t => {
  const f = fixture(t);
  publishHomeWeather({ home23Root: f.root, tileId: 'outside-weather', weather: { rawData: f.raw(new Date()) } });
  const workspace = join(f.root, 'instances/main/workspace');
  const context = new ContextManager({ projectRoot: f.root, workspacePath: workspace, identityFiles: [], heartbeatRefreshMs: 0, enginePort: 5001 });
  const staticBefore = context.getSystemPrompt();
  const oldFetch = globalThis.fetch;
  const captured: string[] = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    captured.push(JSON.stringify(body.system));
    return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'fixture stops at actual provider boundary' } }),
      {status: 400, headers: {'content-type': 'application/json'}});
  };
  t.after(() => { globalThis.fetch = oldFetch; });
  const loop = new AgentLoop({ apiKey: 'fixture-not-real', model: 'claude-test', provider: 'anthropic',
    registry: {getAnthropicTools: () => [], getOpenAITools: () => [], get: () => undefined, execute: async () => ({content: ''})} as never,
    contextManager: context, history: new ConversationHistory(join(f.root, 'history'), 400_000, 'fixture'),
    toolContext: {} as never, workspacePath: workspace });
  for (const chat of ['resident:one', 'helper:one']) await loop.run(chat, 'What is happening around home?').catch(() => {});
  assert.equal(captured.length, 2);
  for (const request of captured) { assert.match(request, /CURRENT HOME CONTEXT/); assert.match(request, /America\/Los_Angeles/); assert.match(request, /Home Ecowitt station: fresh/); }
  assert.equal(context.getSystemPrompt(), staticBefore, 'time belongs to a dynamic suffix, preserving identity cache');
});
