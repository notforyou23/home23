import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const {
  CORE_TILES,
  Home23TileService,
  normalizeDashboardTilesConfig,
  materializeHomeLayout,
  materializeHomeLayoutForContext,
  buildSaunaPrestageRecommendation,
  buildOfflineTilePayload,
} = require('../../../engine/src/dashboard/home23-tiles.js');
const { createContractValidator } = require('../../../tests/contracts/contract-validator.cjs');

test('Good Life is a core tile for every agent dashboard', () => {
  const tile = CORE_TILES.find((candidate) => candidate.id === 'good-life');

  assert.ok(tile, 'good-life must be registered as a core tile');
  assert.equal(tile.kind, 'core');
  assert.equal(tile.mode, 'core-good-life');
  assert.equal(tile.sizeDefault, 'full');
});

test('dashboard tile normalization appends Good Life to older layouts', () => {
  const normalized = normalizeDashboardTilesConfig({
    homeLayout: [
      { tileId: 'thought-feed', enabled: true, size: 'third' },
      { tileId: 'chat', enabled: true, size: 'third' },
    ],
    customTiles: [],
  });
  const item = normalized.homeLayout.find((layoutItem) => layoutItem.tileId === 'good-life');

  assert.ok(!normalized.homeLayout.some((layoutItem) => layoutItem.tileId === 'thought-feed'));
  assert.ok(item, 'good-life must be inserted when an existing layout is missing it');
  assert.equal(item.enabled, true);
  assert.equal(item.size, 'full');
});

test('materialized default layout exposes Good Life as a core tile', () => {
  const normalized = normalizeDashboardTilesConfig({});
  const materialized = materializeHomeLayout(normalized);
  const item = materialized.find((layoutItem) => layoutItem.tileId === 'good-life');

  assert.ok(item, 'default materialized layout must include good-life');
  assert.equal(item.enabled, true);
  assert.equal(item.tile.kind, 'core');
  assert.equal(item.tile.mode, 'core-good-life');
});

test('family-evening context suppresses project-facing home tiles but keeps enabled chat and vibe visible', () => {
  const normalized = normalizeDashboardTilesConfig({});
  const normalLayout = materializeHomeLayout(normalized);
  const contextual = materializeHomeLayoutForContext(normalized, {
    mode: 'family-evening',
    active: true,
  });

  assert.ok(normalLayout.some((item) => item.tileId === 'brain-log'));
  assert.ok(!contextual.layout.some((item) => item.tileId === 'brain-log'));
  assert.ok(contextual.layout.some((item) => item.tileId === 'vibe'));
  assert.ok(contextual.layout.some((item) => item.tileId === 'chat'));
  assert.ok(contextual.layout.some((item) => item.tileId === 'system-summary'));
  assert.ok(contextual.layout.some((item) => item.tileId === 'good-life'));
  assert.deepEqual(contextual.hiddenTiles.map((item) => item.tileId).sort(), [
    'brain-log',
    'dream-log',
    'feeder',
  ]);
  assert.ok(!normalized.homeLayout.some((item) => item.tileId === 'thought-feed'));
});

test('sauna rhythm produces a confirmed pre-stage recommendation', () => {
  const tile = {
    id: 'sauna-control',
    config: {
      startDefaults: {
        targetTemperature: 188,
        duration: 120,
      },
    },
  };

  assert.equal(buildSaunaPrestageRecommendation(tile, {
    jtrTime: { activeRhythms: ['deep-work'] },
  }), null);

  const recommendation = buildSaunaPrestageRecommendation(tile, {
    jtrTime: { activeRhythms: ['sauna'] },
  });

  assert.equal(recommendation.actionId, 'prestage');
  assert.equal(recommendation.posture, 'requires_confirmation');
  assert.equal(recommendation.targetTemperature, 188);
  assert.equal(recommendation.duration, 120);
  assert.equal(recommendation.lighting.status, 'operator-cue');
});

test('sauna tile exposes pre-stage action during sauna rhythm and runs it through HUUM start', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'home23-tiles-'));
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'config', 'home.yaml'), `
dashboard:
  tiles:
    customTiles:
      - id: sauna-control
        kind: custom
        title: Sauna
        mode: huum-sauna
        connectionId: jtr-huum
        refreshMs: 15000
        config:
          startDefaults:
            targetTemperature: 190
            duration: 180
    homeLayout:
      - tileId: sauna-control
        enabled: true
        size: third
`, 'utf8');
  writeFileSync(join(root, 'config', 'secrets.yaml'), `
dashboard:
  tileConnections:
    connections:
      - id: jtr-huum
        name: Huum
        type: huum
        config:
          baseUrl: http://huum.local/api/
        secrets:
          username: test-user
          password: test-pass
`, 'utf8');

  const calls = [];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/status')) {
      return new Response(JSON.stringify({
        statusCode: 232,
        temperature: 20,
        targetTemperature: 88,
        duration: 0,
        door: true,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (String(url).endsWith('/start')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  };

  const service = new Home23TileService({
    home23Root: root,
    autoStartBackgroundRefresh: false,
    getTemporalContext: () => ({ jtrTime: { activeRhythms: ['sauna'] } }),
  });

  const data = await service.getTileData('sauna-control');
  const prestage = data.actions.find((action) => action.id === 'prestage');
  assert.ok(prestage);
  assert.equal(data.content.recommendation.actionId, 'prestage');
  assert.equal(prestage.fields[0].defaultValue, 190);
  assert.equal(prestage.fields[0].min, 100);
  assert.equal(prestage.fields[0].max, 240);
  assert.equal(prestage.fields[0].unit, '°F');
  assert.equal(prestage.fields[1].step, 15);
  assert.equal(prestage.fields[1].unit, 'minutes');

  await service.runTileAction('sauna-control', 'prestage', {
    targetTemperature: 185,
    duration: 90,
  });

  const startCall = calls.find((call) => call.url.endsWith('/start'));
  assert.ok(startCall);
  assert.equal(JSON.parse(startCall.options.body).duration, 90);
  assert.equal(Math.round(JSON.parse(startCall.options.body).targetTemperature), 85);
});

test('sauna action contract can be described without calling HUUM', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'home23-tiles-'));
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'config', 'home.yaml'), `
dashboard:
  tiles:
    customTiles:
      - id: sauna-control
        kind: custom
        title: Sauna
        mode: huum-sauna
        connectionId: jtr-huum
        refreshMs: 15000
        config:
          startDefaults:
            targetTemperature: 190
            duration: 180
    homeLayout:
      - tileId: sauna-control
        enabled: true
        size: third
`, 'utf8');
  writeFileSync(join(root, 'config', 'secrets.yaml'), `
dashboard:
  tileConnections:
    connections:
      - id: jtr-huum
        name: Huum
        type: huum
        config:
          baseUrl: http://huum.local/api/
        secrets:
          username: test-user
          password: test-pass
`, 'utf8');

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => {
    throw new Error('describeTileAction must not call fetch');
  };

  const service = new Home23TileService({
    home23Root: root,
    autoStartBackgroundRefresh: false,
  });

  const action = service.describeTileAction('sauna-control', 'start');

  assert.equal(action.id, 'start');
  assert.equal(action.fields[0].id, 'targetTemperature');
  assert.equal(action.fields[0].min, 100);
  assert.equal(action.fields[0].max, 240);
  assert.equal(action.fields[0].step, 1);
  assert.equal(action.fields[0].unit, '°F');
  assert.equal(action.fields[1].id, 'duration');
  assert.equal(action.fields[1].min, 15);
  assert.equal(action.fields[1].max, 720);
  assert.equal(action.fields[1].step, 15);
  assert.equal(action.fields[1].unit, 'minutes');
});

test('mocked tile action response envelope validates against the dashboard action contract', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'home23-tiles-'));
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'config', 'home.yaml'), `
dashboard:
  tiles:
    customTiles:
      - id: sauna-control
        kind: custom
        title: Sauna
        mode: huum-sauna
        connectionId: jtr-huum
        refreshMs: 15000
        config:
          startDefaults:
            targetTemperature: 190
            duration: 180
    homeLayout:
      - tileId: sauna-control
        enabled: true
        size: third
`, 'utf8');
  writeFileSync(join(root, 'config', 'secrets.yaml'), `
dashboard:
  tileConnections:
    connections:
      - id: jtr-huum
        name: Huum
        type: huum
        config:
          baseUrl: http://huum.local/api/
        secrets:
          username: test-user
          password: test-pass
`, 'utf8');

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/start')) {
      return new Response(JSON.stringify({ ok: true, started: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (String(url).endsWith('/status')) {
      return new Response(JSON.stringify({
        statusCode: 232,
        temperature: 68,
        targetTemperature: 88,
        duration: 90,
        door: false,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  };

  const service = new Home23TileService({
    home23Root: root,
    autoStartBackgroundRefresh: false,
  });
  const envelope = {
    ok: true,
    action: await service.runTileAction('sauna-control', 'start', {
      targetTemperature: 190,
      duration: 90,
    }),
    data: await service.getTileData('sauna-control'),
  };

  const validator = createContractValidator(process.cwd());
  const manifest = require('../../../contracts/manifest.json');
  const entry = manifest.entries.find((candidate) => candidate.id === 'home-tile-action-response');
  assert.ok(entry, 'home-tile-action-response manifest entry must exist');
  const result = validator.validateValue(entry, envelope);
  assert.equal(result.valid, true, result.errorsText);
});

test('pool ScreenLogic tile returns an offline payload when the bridge is unreachable', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'home23-tiles-'));
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'config', 'home.yaml'), `
dashboard:
  tiles:
    customTiles:
      - id: pool-screenlogic
        kind: custom
        title: Pool
        mode: generic-http-json
        connectionId: jtr-screenlogic
        refreshMs: 30000
        config:
          request:
            path: /status
            method: GET
    homeLayout:
      - tileId: pool-screenlogic
        enabled: true
        size: half
`, 'utf8');
  writeFileSync(join(root, 'config', 'secrets.yaml'), `
dashboard:
  tileConnections:
    connections:
      - id: jtr-screenlogic
        name: ScreenLogic
        type: generic-http
        config:
          baseUrl: http://127.0.0.1:5023
          authType: none
          headers: {}
        secrets: {}
`, 'utf8');

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => {
    throw new Error('fetch failed');
  };

  const service = new Home23TileService({
    home23Root: root,
    autoStartBackgroundRefresh: false,
    logger: { warn() {} },
  });

  const data = await service.getTileData('pool-screenlogic');
  assert.equal(data.tileId, 'pool-screenlogic');
  assert.equal(data.offline, true);
  assert.equal(data.content.status, 'Offline');
  assert.equal(data.content.subtitle, 'ScreenLogic unavailable');
  assert.equal(data.cache.hit, false);
});

test('offline tile payload keeps the dashboard display shape stable', () => {
  const payload = buildOfflineTilePayload('pool-screenlogic', {
    subtitle: 'ScreenLogic unavailable',
    error: new Error('fetch failed'),
  });

  assert.equal(payload.tileId, 'pool-screenlogic');
  assert.equal(payload.content.status, 'Offline');
  assert.deepEqual(payload.content.metrics, []);
  assert.equal(payload.actions.length, 0);
  assert.equal(payload.error, 'fetch failed');
});

test('sauna start and stop events append to the owner home log, not the runtime HOME', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'home23-sauna-owner-'));
  const owner = join(base, 'owner');
  const runtime = join(base, 'runtime-user');
  mkdirSync(owner);
  mkdirSync(runtime);
  const keys = ['HOME', 'HOME23_OWNER_HOME', 'HOME23_PRODUCT_HOST'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  let statusCode = 231;
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ statusCode, temperature: 80, targetTemperature: 90, duration: 60 }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await new Promise((resolve) => server.close(resolve));
    rmSync(base, { recursive: true, force: true });
  });
  // A Host dashboard: HOME is Home23's private runtime home.
  Object.assign(process.env, { HOME: runtime, HOME23_OWNER_HOME: owner, HOME23_PRODUCT_HOST: 'true' });
  const service = new Home23TileService({ home23Root: base, autoStartBackgroundRefresh: false, logger: { warn() {} } });
  service.resolveTile = () => ({ id: 'owner-sauna', kind: 'custom', mode: 'huum-sauna', connectionId: 'huum', refreshMs: 0, title: 'Sauna' });
  service.resolveConnection = () => ({ id: 'huum', type: 'huum', config: { baseUrl: `http://127.0.0.1:${server.address().port}/` },
    secrets: { username: 'fixture', password: 'fixture' } });

  await service.getTileData('owner-sauna');
  statusCode = 232;
  await service.getTileData('owner-sauna');

  const events = readFileSync(join(owner, '.sauna_usage_log.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line).event);
  assert.deepEqual(events, ['start', 'stop']);
  assert.equal(existsSync(join(runtime, '.sauna_usage_log.jsonl')), false);
});
