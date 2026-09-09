import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { defaultSeeds, seedAll } = require('../../../engine/src/live-problems/seed.js');
const options = { agentName: 'milo', dashboardPort: 24002, bridgePort: 24004, homeRoot: '/independent/Home/app', productHost: true, monitoring: {} };

test('new Host monitors its own provisioned services without assuming hardware, account or mature memory', () => {
  const seeds = defaultSeeds(options);
  assert.deepEqual(seeds.map(seed => seed.id), [
    'milo_harness_online', 'milo_dashboard_ping', 'milo_dashboard_port_owner', 'milo_engine_admin_ping',
  ]);
  assert.equal(seeds.find(seed => seed.id === 'milo_dashboard_ping').verifier.args.url, 'http://127.0.0.1:24002/home23/agents.json');
  assert.doesNotMatch(JSON.stringify(seeds), /jerry|forrest|Casey Jones|health_log|sauna|weather|\.codex|9222/);
});

test('Host can explicitly select built-in monitoring and leave custom problems intact', () => {
  const original = defaultSeeds({ ...options, productHost: false });
  const data = new Map(original.map(seed => [seed.id, { ...seed, lastCheckedAt: 'retained' }]));
  data.set('my_sensor', { id: 'my_sensor', seedOrigin: 'operator', state: 'open' });
  data.set('sauna_sensor_fresh', { ...data.get('sauna_sensor_fresh'), seedOrigin: 'operator' });
  const store = {
    all: () => [...data.values()], remove: id => data.delete(id),
    upsert: seed => data.set(seed.id, { ...data.get(seed.id), ...seed }),
  };
  const seeds = seedAll(store, { ...options, monitoring: { liveProblems: { seedIds: ['milo_harness_online', 'weather_sensor_fresh'] } } });
  assert.deepEqual(seeds.map(seed => seed.id), ['milo_harness_online', 'weather_sensor_fresh']);
  assert.equal(data.get('milo_harness_online').lastCheckedAt, 'retained');
  assert.equal(data.has('codex_oauth_lineage_current'), false);
  assert.equal(data.has('brain_graph_populated'), false);
  assert.equal(data.get('sauna_sensor_fresh').seedOrigin, 'operator');
  assert.equal(data.has('my_sensor'), true);
});

test('legacy defaults remain available and Host rejects unknown explicit IDs', () => {
  const ids = defaultSeeds({ ...options, productHost: false }).map(seed => seed.id);
  for (const id of ['health_log_fresh', 'sauna_sensor_fresh', 'weather_sensor_fresh', 'codex_oauth_lineage_current']) assert.ok(ids.includes(id));
  assert.throws(() => defaultSeeds({ ...options, monitoring: { liveProblems: { seedIds: ['typo'] } } }), /known live-problem IDs/);
  assert.deepEqual(defaultSeeds({ ...options, monitoring: { liveProblems: { seedIds: [] } } }), []);
});
