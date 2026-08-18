'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  classifyDrillFile,
  listDrillFiles,
  normalizeRelativePath,
  readDrillFile,
  readJsonlTape,
  resolveAllowedFile
} = require('./drill-inspector');

function makeRun() {
  const runPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo-drill-inspector-'));
  fs.mkdirSync(path.join(runPath, 'outputs', 'raw'), { recursive: true });
  fs.mkdirSync(path.join(runPath, 'outputs', 'candidates'), { recursive: true });
  fs.mkdirSync(path.join(runPath, 'drill'), { recursive: true });
  fs.writeFileSync(path.join(runPath, 'outputs', 'report.md'), '# Report\nA durable writeup.');
  fs.writeFileSync(path.join(runPath, 'outputs', 'raw', 'harvest.json'), '{"records":[1,2]}');
  fs.writeFileSync(path.join(runPath, 'drill', 'state.json'), '{"mode":"drilling"}');
  return runPath;
}

function appendJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}

test('lists the existing outputs/ and drill/ files with useful kinds', async () => {
  const runPath = makeRun();
  appendJsonl(path.join(runPath, 'outputs', 'stream.jsonl'), [
    { at: 1, kind: 'goal', content: 'Goal one' }
  ]);
  appendJsonl(path.join(runPath, 'outputs', 'sources.jsonl'), [
    { at: 2, tool: 'run_command', query: 'curl x' }
  ]);
  appendJsonl(path.join(runPath, 'drill', 'progress.jsonl'), [
    { at: 3, type: 'cycle_started' }
  ]);

  const listing = await listDrillFiles(runPath);

  assert.equal(listing.truncated, false);
  assert.deepEqual(listing.roots, ['outputs', 'drill']);
  assert.ok(listing.totalFiles >= 6);
  const byPath = new Map(listing.files.map(file => [file.path, file]));
  assert.equal(byPath.get('outputs/report.md').kind, 'writeup');
  assert.equal(byPath.get('outputs/raw/harvest.json').kind, 'data');
  assert.equal(byPath.get('outputs/stream.jsonl').kind, 'brain_tape');
  assert.equal(byPath.get('outputs/sources.jsonl').kind, 'source_tape');
  assert.equal(byPath.get('drill/progress.jsonl').kind, 'drill_tape');
  assert.equal(byPath.get('drill/state.json').kind, 'drill_state');
  assert.equal(listing.counts.writeup, 1);
});

test('reads a safe run-relative text preview and reports truncation', async () => {
  const runPath = makeRun();
  fs.writeFileSync(path.join(runPath, 'outputs', 'long.txt'), 'x'.repeat(4096));

  const file = await readDrillFile(runPath, 'outputs/long.txt', { maxBytes: 1024 });

  assert.equal(file.path, 'outputs/long.txt');
  assert.equal(file.previewable, true);
  assert.equal(file.truncated, true);
  assert.equal(file.content.length, 1024);
  assert.equal(file.size, 4096);
});

test('refuses traversal, non-artifact roots, and symlink escapes', async () => {
  const runPath = makeRun();
  const outside = path.join(path.dirname(runPath), `${path.basename(runPath)}-outside.txt`);
  fs.writeFileSync(outside, 'private');
  fs.symlinkSync(outside, path.join(runPath, 'outputs', 'escape.txt'));

  assert.throws(() => normalizeRelativePath('../config.yaml'), /traversal/i);
  assert.throws(() => normalizeRelativePath('config.yaml'), /limited to outputs\/ and drill\//i);
  await assert.rejects(
    resolveAllowedFile(runPath, 'outputs/escape.txt'),
    /Symlink target is outside/
  );

  const listing = await listDrillFiles(runPath);
  assert.equal(listing.files.some(file => file.path === 'outputs/escape.txt'), false);
});

test('pages and filters the existing stream tape without creating another trail', async () => {
  const runPath = makeRun();
  const streamFile = path.join(runPath, 'outputs', 'stream.jsonl');
  appendJsonl(streamFile, [
    { at: 100, kind: 'goal', content: 'Goal one', workerId: null },
    { at: 200, kind: 'thought', content: 'Worker one thinking', workerId: 'w1', phaseNumber: 1 },
    { at: 300, kind: 'harvest', content: 'Fetched archive', workerId: 'w1', phaseNumber: 1 },
    { at: 400, kind: 'thought', content: 'Worker two thinking', workerId: 'w2', phaseNumber: 2 },
    { at: 500, kind: 'finding', content: 'A finding', workerId: 'w2', phaseNumber: 2 }
  ]);

  const first = await readJsonlTape(runPath, 'stream', { limit: 2 });
  assert.deepEqual(first.entries.map(entry => entry.at), [500, 400]);
  assert.equal(first.nextBefore, 400);
  assert.equal(first.hasMore, true);

  const second = await readJsonlTape(runPath, 'stream', {
    before: first.nextBefore,
    limit: 2
  });
  assert.deepEqual(second.entries.map(entry => entry.at), [300, 200]);

  const filtered = await readJsonlTape(runPath, 'stream', {
    kind: 'thought',
    workerId: 'w1',
    search: 'thinking'
  });
  assert.deepEqual(filtered.entries.map(entry => entry.at), [200]);
});

test('pages source receipts from outputs/sources.jsonl', async () => {
  const runPath = makeRun();
  appendJsonl(path.join(runPath, 'outputs', 'sources.jsonl'), [
    { at: 100, tool: 'web_search', query: 'one', urls: ['https://one.example'] },
    { at: 200, tool: 'run_command', query: 'curl two', urls: ['https://two.example'] }
  ]);

  const page = await readJsonlTape(runPath, 'sources', { tool: 'run_command' });
  assert.equal(page.entries.length, 1);
  assert.equal(page.entries[0].urls[0], 'https://two.example');
});

test('classifies the core tape and artifact paths deterministically', () => {
  assert.equal(classifyDrillFile('outputs/stream.jsonl'), 'brain_tape');
  assert.equal(classifyDrillFile('outputs/sources.jsonl'), 'source_tape');
  assert.equal(classifyDrillFile('outputs/candidates/findings.jsonl'), 'findings');
  assert.equal(classifyDrillFile('drill/notes.jsonl'), 'drill_tape');
  assert.equal(classifyDrillFile('outputs/final.md'), 'writeup');
  assert.equal(classifyDrillFile('outputs/raw/data.csv'), 'data');
});
