'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const publicInstructions = ['README.md', 'docs/MANIFEST.md'];
const localInstructions = [
  'instances/jerry/workspace/SOUL.md',
  'instances/jerry/workspace/cron-prompts/weekly-deep-dive.md',
];
const existingInstructions = [...publicInstructions, ...localInstructions]
  .filter((relativePath) => fs.existsSync(path.join(root, relativePath)));

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('active and public instructions expose no removed PGS invocation, raw fraction, fixed sleep, or route bypass', () => {
  for (const relativePath of existingInstructions) {
    const source = read(relativePath);
    const removedReferences = [...source.matchAll(/\bbrain_pgs\b/g)];
    if (relativePath === 'README.md') {
      assert.equal(removedReferences.length, 1, 'README may mention brain_pgs only once as migration history');
      assert.match(source, /`brain_pgs` was merged into `brain_query`/);
    } else {
      assert.equal(removedReferences.length, 0, `${relativePath} still invokes brain_pgs`);
    }
    assert.doesNotMatch(source, /\bsweepFraction\b/, `${relativePath} exposes raw sweepFraction`);
    assert.doesNotMatch(source, /\b(?:wait|sleep)\s+(?:for\s+)?\d+\s*(?:seconds?|minutes?)\b/i,
      `${relativePath} prescribes a fixed sleep`);
    assert.doesNotMatch(source, /\/api\/(?:brain|query)[^\s`"']*\/query\b/i,
      `${relativePath} bypasses the durable brain tools with a direct route`);
  }
});

test('public Brain inventory and examples describe named durable PGS and evidence scope', () => {
  const readme = read('README.md');
  for (const tool of [
    'brain_catalog', 'brain_operations_list', 'brain_pgs_partitions',
    'brain_search', 'brain_query', 'brain_query_export',
    'brain_memory_graph', 'brain_synthesize', 'brain_status',
  ]) {
    const rowMarker = '| `' + tool + '` |';
    assert.ok(readme.includes(rowMarker), `${tool} missing from README inventory`);
  }
  assert.match(readme, /`quick`, `full`, `expert`, and `dive`/);
  assert.match(readme, /`skim`, `sample`, `deep`, and `full`/);
  assert.match(readme, /`fresh`, `continue`, and `targeted`/);
  assert.match(readme, /`continueFromOperationId`/);
  assert.match(readme, /`fullCoverage: true`/);
  assert.match(readme, /requested scope/i);
  assert.match(readme, /graph-wide absence claim/i);
  assert.doesNotMatch(readme, /\b49 registered tools\b/);
});

test('active Jerry instructions use discovery, named PGS, continuation, and durable waits', { skip: !fs.existsSync(path.join(root, localInstructions[0])) }, () => {
  const soul = read(localInstructions[0]);
  const weekly = read(localInstructions[1]);
  for (const source of [soul, weekly]) {
    assert.match(source, /brain_catalog/);
    assert.match(source, /pgsLevel/);
    assert.match(source, /pgsMode/);
    assert.match(source, /brain_status/);
  }
  assert.match(soul, /brain_operations_list/);
  assert.match(soul, /brain_pgs_partitions/);
  assert.match(weekly, /continueFromOperationId/);
  assert.match(weekly, /requested scope/i);
  assert.match(weekly, /fullCoverage/);
});
