import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
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
} = require('../../../engine/src/dashboard/home23-tiles.js');

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

test('family-evening context suppresses project-facing home tiles but keeps enabled chat visible', () => {
  const normalized = normalizeDashboardTilesConfig({});
  const normalLayout = materializeHomeLayout(normalized);
  const contextual = materializeHomeLayoutForContext(normalized, {
    mode: 'family-evening',
    active: true,
  });

  assert.ok(normalLayout.some((item) => item.tileId === 'thought-feed'));
  assert.ok(normalLayout.some((item) => item.tileId === 'brain-log'));
  assert.ok(!contextual.layout.some((item) => item.tileId === 'thought-feed'));
  assert.ok(!contextual.layout.some((item) => item.tileId === 'brain-log'));
  assert.ok(contextual.layout.some((item) => item.tileId === 'chat'));
  assert.ok(contextual.layout.some((item) => item.tileId === 'system-summary'));
  assert.ok(contextual.layout.some((item) => item.tileId === 'good-life'));
  assert.deepEqual(contextual.hiddenTiles.map((item) => item.tileId).sort(), [
    'brain-log',
    'dream-log',
    'feeder',
    'thought-feed',
    'vibe',
  ]);
  assert.ok(normalized.homeLayout.some((item) => item.tileId === 'thought-feed'));
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

  await service.runTileAction('sauna-control', 'prestage', {
    targetTemperature: 185,
    duration: 90,
  });

  const startCall = calls.find((call) => call.url.endsWith('/start'));
  assert.ok(startCall);
  assert.equal(JSON.parse(startCall.options.body).duration, 90);
  assert.equal(Math.round(JSON.parse(startCall.options.body).targetTemperature), 85);
});
