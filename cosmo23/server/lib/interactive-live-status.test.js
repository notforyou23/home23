const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildInteractiveLiveStatus } = require('./interactive-live-status');

function withTempRun(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo-live-status-'));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('buildInteractiveLiveStatus includes artifact substrate from current run files', () => withTempRun((runPath) => {
  fs.mkdirSync(path.join(runPath, 'outputs', 'extracted'), { recursive: true });
  fs.writeFileSync(
    path.join(runPath, 'outputs', 'extracted', 'records.json'),
    JSON.stringify({ entries: [{ source_url: 'https://archive.org/details/show', quote: 'fan note' }] })
  );
  fs.writeFileSync(
    path.join(runPath, 'metadata.json'),
    JSON.stringify({ runName: 'artifact-run', topic: 'artifact topic' })
  );

  const status = buildInteractiveLiveStatus({
    runPath,
    activeContext: { runName: 'artifact-run', runPath, topic: 'active topic' },
    processStatus: { running: [{ name: 'cosmo-main', pid: 123 }], count: 1 },
    now: new Date('2026-06-30T12:00:00Z')
  });

  assert.equal(status.running, true);
  assert.equal(status.artifactStatus, 'records_present');
  assert.equal(status.artifactInventory.categories.extractedRecords.records, 1);
  assert.equal(status.runName, 'artifact-run');
}));
