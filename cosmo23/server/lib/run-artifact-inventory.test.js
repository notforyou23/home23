const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  summarizeRunArtifacts,
  buildArtifactFirstContext
} = require('./run-artifact-inventory');

function withTempRun(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo-run-artifacts-'));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('summarizeRunArtifacts distinguishes extracted records from query exports', () => withTempRun((runPath) => {
  fs.mkdirSync(path.join(runPath, 'outputs', 'extracted'), { recursive: true });
  fs.mkdirSync(path.join(runPath, 'outputs', 'raw-anecdotes'), { recursive: true });
  fs.mkdirSync(path.join(runPath, 'exports', 'markdown'), { recursive: true });
  fs.mkdirSync(path.join(runPath, 'kv'), { recursive: true });

  fs.writeFileSync(
    path.join(runPath, 'outputs', 'extracted', 'archive-comments.json'),
    JSON.stringify({
      entries: [
        { source_url: 'https://archive.org/details/show-1', quote: 'Fan memory one.' },
        { source_url: 'https://archive.org/details/show-2', quote: 'Fan memory two.' }
      ]
    })
  );
  fs.writeFileSync(
    path.join(runPath, 'outputs', 'raw-anecdotes', 'archive-org-comments.json'),
    JSON.stringify({
      entries: [{ source_url: 'https://archive.org/details/show-1', text: 'raw record' }]
    })
  );
  fs.writeFileSync(
    path.join(runPath, 'kv', 'research_source_index.json'),
    JSON.stringify({ key: 'research_source_index', value: { urls: ['https://archive.org/details/show-1'] } })
  );
  fs.writeFileSync(path.join(runPath, 'exports', 'markdown', 'query.md'), '# Query\n\nA previous query answer.');

  const inventory = summarizeRunArtifacts(runPath);

  assert.equal(inventory.exists, true);
  assert.equal(inventory.answerSubstrate, 'records_present');
  assert.equal(inventory.categories.extractedRecords.records, 2);
  assert.equal(inventory.categories.rawAnecdotes.records, 1);
  assert.equal(inventory.categories.queryExports.files, 1);
  assert.equal(inventory.sourceEvidence.sourceIndexUrls, 1);
  assert.equal(inventory.warnings.includes('source_urls_missing'), false);

  const context = buildArtifactFirstContext(inventory);
  assert.match(context, /Answer substrate: records_present/);
  assert.match(context, /Raw anecdote files\/records: 1\/1/);
}));

test('summarizeRunArtifacts surfaces invalid JSON and meta-only runs', () => withTempRun((runPath) => {
  fs.mkdirSync(path.join(runPath, 'exports', 'markdown'), { recursive: true });
  fs.mkdirSync(path.join(runPath, 'outputs', 'research', 'agent_1'), { recursive: true });
  fs.writeFileSync(path.join(runPath, 'exports', 'markdown', 'query.md'), '# Query\n\nLooks researched.');
  fs.writeFileSync(path.join(runPath, 'outputs', 'research', 'agent_1', 'research_summary.md'), '# Summary\n\nNeeds extraction.');
  fs.writeFileSync(path.join(runPath, 'outputs', 'research', 'agent_1', 'research_findings.json'), '{"entries":[}\n');

  const inventory = summarizeRunArtifacts(runPath);

  assert.equal(inventory.answerSubstrate, 'meta_only');
  assert.equal(inventory.totals.invalidJsonFiles, 1);
  assert.equal(inventory.warnings.includes('invalid_json_artifacts_present'), true);
  assert.equal(inventory.warnings.includes('raw_anecdotes_missing'), true);
  assert.equal(inventory.warnings.includes('source_route_receipts_missing'), true);
}));

test('summarizeRunArtifacts fingerprint changes when artifact content changes', () => withTempRun((runPath) => {
  fs.mkdirSync(path.join(runPath, 'outputs', 'raw-anecdotes'), { recursive: true });
  const artifactPath = path.join(runPath, 'outputs', 'raw-anecdotes', 'archive-org-comments.json');

  fs.writeFileSync(
    artifactPath,
    JSON.stringify({ entries: [{ source_url: 'https://archive.org/details/show', text: 'first account' }] })
  );
  const first = summarizeRunArtifacts(runPath);

  fs.writeFileSync(
    artifactPath,
    JSON.stringify({ entries: [{ source_url: 'https://archive.org/details/show', text: 'second account' }] })
  );
  const second = summarizeRunArtifacts(runPath);

  assert.equal(first.categories.rawAnecdotes.records, 1);
  assert.equal(second.categories.rawAnecdotes.records, 1);
  assert.notEqual(first.fingerprint, second.fingerprint);
}));
