import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DocumentConverter } = require('../../../engine/src/ingestion/document-converter');
const { DocumentFeeder } = require('../../../engine/src/ingestion/document-feeder');

const silentLogger = { info() {}, warn() {}, debug() {}, error() {} };

// A stand-in "python": answers the MarkItDown probe (-c ...) and converts
// by sleeping, then printing markdown. No real python or network needed.
function stubPython(t, { convertSleepSeconds = 0, probeExit = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-converter-stub-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'python-stub');
  fs.writeFileSync(script, [
    '#!/bin/sh',
    'if [ "$1" = "-c" ]; then',
    `  exit ${probeExit}`,
    'fi',
    `sleep ${convertSleepSeconds}`,
    'echo "# converted"',
    '',
  ].join('\n'), { mode: 0o755 });
  const doc = path.join(dir, 'report.pdf');
  fs.writeFileSync(doc, 'pdf bytes');
  return { script, doc };
}

test('the converter never uses a synchronous child process', () => {
  const source = fs.readFileSync(new URL('../../../engine/src/ingestion/document-converter.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /execFileSync|execSync|spawnSync/);
});

test('a slow conversion leaves the event loop free', async (t) => {
  const { script, doc } = stubPython(t, { convertSleepSeconds: 1 });
  const converter = new DocumentConverter({ logger: silentLogger, pythonPath: script });
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 20);
  try {
    const result = await converter.convertDetailed(doc);
    assert.equal(result.ok, true);
    assert.match(result.text, /# converted/);
  } finally {
    clearInterval(timer);
  }
  // The old execFileSync path allowed zero ticks for the whole second.
  assert.ok(ticks >= 20, `expected the interval to keep firing, saw ${ticks} ticks`);
});

test('conversions run one at a time', async (t) => {
  const { script, doc } = stubPython(t);
  let active = 0;
  let maxActive = 0;
  const execFileImpl = (file, args, options, callback) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    setTimeout(() => {
      active -= 1;
      callback(null, args[0] === '-c' ? '' : '# converted\n', '');
    }, 30);
  };
  const converter = new DocumentConverter({ logger: silentLogger, pythonPath: script, execFileImpl });

  const results = await Promise.all([doc, doc, doc].map(file => converter.convertDetailed(file)));

  assert.equal(results.every(result => result.ok), true);
  assert.equal(maxActive, 1);
});

test('closing the converter cancels an in-flight conversion promptly and retryably', async (t) => {
  const { script, doc } = stubPython(t, { convertSleepSeconds: 5 });
  const converter = new DocumentConverter({ logger: silentLogger, pythonPath: script });
  await converter.checkAvailability();

  const started = Date.now();
  const pending = converter.convertDetailed(doc);
  setTimeout(() => converter.close(), 100);
  const result = await pending;

  assert.equal(result.ok, false);
  assert.equal(result.status, 'conversion_aborted');
  assert.equal(result.retryable, true);
  assert.ok(Date.now() - started < 2000, 'cancellation must not wait for the child to finish');
  assert.equal((await converter.convertDetailed(doc)).status, 'conversion_aborted');
});

test('feeder shutdown closes the converter', async (t) => {
  const runPath = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-feeder-close-'));
  t.after(() => fs.rmSync(runPath, { recursive: true, force: true }));
  const feeder = new DocumentFeeder({
    memory: { embed: async () => null },
    config: { compiler: { enabled: false } },
    logger: silentLogger,
  });
  feeder._scanDirectory = async () => {};
  await feeder.start(runPath);
  let closed = 0;
  const close = feeder.converter.close.bind(feeder.converter);
  feeder.converter.close = () => { closed += 1; close(); };

  await feeder.shutdown();

  assert.equal(closed, 1);
});

test('the availability probe is async, cached, and re-probes early while absent', async (t) => {
  const { script } = stubPython(t);
  let probes = 0;
  let installed = false;
  let clock = 0;
  const execFileImpl = (file, args, options, callback) => {
    probes += 1;
    setImmediate(() => (installed ? callback(null, '', '') : callback(new Error('No module named markitdown'), '', '')));
  };
  const converter = new DocumentConverter({ logger: silentLogger, pythonPath: script, execFileImpl, now: () => clock });

  assert.equal(converter.available, false, 'reading availability never spawns');
  assert.equal(probes, 0);
  assert.equal(await converter.checkAvailability(), false);
  assert.equal(await converter.checkAvailability(), false);
  assert.equal(probes, 1, 'cached within the unavailable TTL');

  installed = true;
  clock += 61_000;
  assert.equal(await converter.checkAvailability(), true, 'installing MarkItDown needs no restart');
  clock += 61_000;
  assert.equal(await converter.checkAvailability(), true);
  assert.equal(probes, 2, 'a present converter is cached longer');
  assert.equal(await converter.checkAvailability({ force: true }), true);
  assert.equal(probes, 3);
});
