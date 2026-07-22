'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { LatentProjector } = require('../../cosmo23/engine/src/cognition/latent-projector.js');

// Fix 3.6: the latent training dataset is append-only JSONL (one line per
// cycle, no rotation) and shouldAutoTrain() runs every cycle. Reading the
// whole file back as one utf-8 string re-introduced V8's ~536MB single-string
// ceiling. These pins hold _countDatasetSamples() to the exact legacy
// split('\n').filter(l => l.trim().length > 0) semantics, streamed.

function makeProjector(datasetPath, config = {}) {
  const projector = Object.create(LatentProjector.prototype);
  projector.logger = { info() {}, warn() {}, error() {}, debug() {} };
  projector.config = {
    autoTrain: true,
    autoTrainThreshold: 3,
    autoTrainInterval: 2,
    ...config,
  };
  projector.datasetPath = datasetPath;
  projector.trainingInProgress = false;
  projector.lastTrainingSampleCount = 0;
  return projector;
}

const legacyCount = (content) => content.split('\n').filter((line) => line.trim().length > 0).length;

test('Fix 3.6: streamed sample count matches legacy split/filter semantics exactly', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo23-latent-count-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const fixtures = [
    ['empty file', ''],
    ['single entry, trailing newline', '{"cycle":1,"reward":0.5}\n'],
    ['three entries', '{"a":1}\n{"b":2}\n{"c":3}\n'],
    ['torn tail from a crash mid-append', '{"a":1}\n{"b":2}'],
    ['interior blank line', '{"a":1}\n\n{"b":2}\n'],
    ['CRLF endings', '{"a":1}\r\n{"b":2}\r\n'],
    ['whitespace-only lines', '   \n\t\n{"a":1}\n'],
  ];

  for (let i = 0; i < fixtures.length; i += 1) {
    const [name, content] = fixtures[i];
    const datasetPath = path.join(dir, `dataset-${i}.jsonl`);
    fs.writeFileSync(datasetPath, content);
    const projector = makeProjector(datasetPath);
    assert.equal(await projector._countDatasetSamples(), legacyCount(content), name);
  }
});

test('Fix 3.6: a missing dataset rejects with ENOENT so shouldAutoTrain stays quiet', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo23-latent-enoent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const projector = makeProjector(path.join(dir, 'missing.jsonl'));
  await assert.rejects(projector._countDatasetSamples(), (err) => err.code === 'ENOENT');

  const warnings = [];
  projector.logger = { info() {}, warn: (...args) => warnings.push(args), error() {}, debug() {} };
  assert.equal(await projector.shouldAutoTrain(), false, 'no dataset means no training');
  assert.equal(warnings.length, 0, 'ENOENT is expected on fresh runs — never warned about');
});

test('Fix 3.6: shouldAutoTrain threshold behavior is unchanged through the streamed counter', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo23-latent-threshold-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const datasetPath = path.join(dir, 'latent-dataset.jsonl');
  const entry = (i) => `${JSON.stringify({ cycle: i, reward: 0.1, vector: [0.1, 0.2] })}\n`;

  // Below threshold: 2 samples < autoTrainThreshold 3.
  fs.writeFileSync(datasetPath, entry(1) + entry(2));
  const projector = makeProjector(datasetPath);
  assert.equal(await projector.shouldAutoTrain(), false, 'below threshold');

  // At threshold with 3 new samples >= autoTrainInterval 2.
  fs.appendFileSync(datasetPath, entry(3));
  assert.equal(await projector.shouldAutoTrain(), true, 'threshold and interval reached');

  // After training, fewer than autoTrainInterval new samples: quiet again.
  projector.lastTrainingSampleCount = 3;
  fs.appendFileSync(datasetPath, entry(4));
  assert.equal(await projector.shouldAutoTrain(), false, 'only 1 new sample since training');

  assert.equal(await projector.shouldAutoTrain.call(
    { ...projector, config: { ...projector.config, autoTrain: false } },
  ), false, 'autoTrain: false is still an absolute off switch');
});
