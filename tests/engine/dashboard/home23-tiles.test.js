import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  CORE_TILES,
  normalizeDashboardTilesConfig,
  materializeHomeLayout,
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
