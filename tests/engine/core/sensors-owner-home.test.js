import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

test('the sensors poller appends sauna transitions to the owner home log, not the runtime HOME', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-sensors-owner-'));
  const owner = path.join(base, 'owner');
  const runtime = path.join(base, 'runtime-user');
  fs.mkdirSync(owner);
  fs.mkdirSync(runtime);
  const keys = ['HOME', 'HOME23_OWNER_HOME', 'HOME23_PRODUCT_HOST', 'HUUM_API_URL'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const sensorsPath = require.resolve('../../../engine/src/core/sensors.js');
  const saunaPath = require.resolve('../../../engine/src/core/integrations/sauna.js');
  const cachePath = path.join(path.dirname(sensorsPath), '..', '..', 'data', 'sensor-cache.json');
  const { writeFileSync } = fs;
  const readings = [{ isHeating: true, isLocked: false, status: 'Heating' }, { isHeating: false, isLocked: false, status: 'Off' }];
  t.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    fs.writeFileSync = writeFileSync;
    delete require.cache[sensorsPath];
    delete require.cache[saunaPath];
    fs.rmSync(base, { recursive: true, force: true });
  });
  // No Huum account or network: the integration answers from fixtures, and the
  // poller's own sensor cache (engine/data) is not written by this test.
  require.cache[saunaPath] = { id: saunaPath, filename: saunaPath, loaded: true,
    exports: { fetchSaunaStatus: async () => ({ temperature: 80, targetTemperature: 90, ...readings.shift() }), toggleSauna: async () => ({}) } };
  fs.writeFileSync = (file, ...rest) => (path.resolve(String(file)) === path.resolve(cachePath) ? undefined : writeFileSync(file, ...rest));
  Object.assign(process.env, { HOME: runtime, HOME23_OWNER_HOME: owner, HOME23_PRODUCT_HOST: 'true', HUUM_API_URL: 'http://huum.fixture.invalid' });
  delete require.cache[sensorsPath];
  const { pollSauna } = require(sensorsPath);

  await pollSauna();
  await pollSauna();

  const events = fs.readFileSync(path.join(owner, '.sauna_usage_log.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line).event);
  assert.deepEqual(events, ['start', 'stop']);
  assert.equal(fs.existsSync(path.join(runtime, '.sauna_usage_log.jsonl')), false);
});
