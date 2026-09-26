import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { domainReaderSpecs } from '../../../../engine/src/channels/domain/reader-config.js';

// A Host process: HOME is Home23's private runtime home, the owner home is named.
const hostEnv = { HOME23_PRODUCT_HOST: 'true', HOME: '/fixture/home/runtime/user', HOME23_OWNER_HOME: '/fixture/owner' };

test("domain readers resolve '~' to the owner home, never the runtime HOME", () => {
  const specs = domainReaderSpecs({
    readers: {
      pressure: { path: '~/.pressure_log.jsonl', tail: true, enabled: true },
      health: { path: '~/.health_log.jsonl', tail: true },
      sauna: { path: '/data/sauna.jsonl', enabled: true },
    },
  }, hostEnv);
  assert.deepEqual(specs, [
    { kind: 'pressure', path: join('/fixture/owner', '.pressure_log.jsonl') },
    { kind: 'health', path: join('/fixture/owner', '.health_log.jsonl') },
    { kind: 'sauna', path: '/data/sauna.jsonl' },
  ]);
});

test('a reader marked enabled: false or without a path is not registered', () => {
  // The shipped template names all three logs with enabled: false.
  const template = {
    readers: {
      pressure: { path: '~/.pressure_log.jsonl', tail: true, enabled: false },
      health: { path: '~/.health_log.jsonl', tail: true, enabled: false },
      sauna: { path: '~/.sauna_usage_log.jsonl', tail: true, enabled: false },
      weather: { enabled: false },
    },
  };
  assert.deepEqual(domainReaderSpecs(template, hostEnv), []);
  assert.deepEqual(domainReaderSpecs({ readers: { pressure: { enabled: true }, health: { path: '  ' } } }, hostEnv), []);
  assert.deepEqual(domainReaderSpecs(undefined, hostEnv), []);
});
