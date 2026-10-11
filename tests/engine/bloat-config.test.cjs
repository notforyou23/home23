const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DocumentFeeder } = require('../../engine/src/ingestion/document-feeder.js');
const { ConfigLoader } = require('../../engine/src/core/config-loader.js');

function brainDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bloat-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('AgencyKernel forwards inbox rotation configuration to its store', async (t) => {
  const { AgencyKernel } = await import('../../engine/src/agency/resident-kernel.js');
  const kernel = new AgencyKernel({
    brainDir: brainDir(t),
    initializeState: false,
    config: { inboxPersistence: { maxBytes: 1, keep: 1 } },
  });
  kernel.store.appendInbox({ id: 'first' });
  kernel.store.appendInbox({ id: 'second' });
  assert.ok(fs.existsSync(`${kernel.store.inboxPath}.1.gz`));
  assert.deepEqual(kernel.store.listInbox().map((row) => row.id), ['second']);
});

for (const enabled of [true, false]) {
  test(`DocumentFeeder forwards queue compaction configuration (enabled=${enabled})`, async (t) => {
    const feeder = new DocumentFeeder({
      memory: {},
      logger: { info() {}, warn() {}, debug() {} },
      config: {
        maintenanceMode: true,
        converter: { enabled: false },
        compiler: { enabled: false },
        queueCompaction: { enabled, minBytes: 1, archive: false },
      },
    });
    await feeder.start(brainDir(t));
    const queue = feeder.manifest._queue;
    queue.upsert('/fixture.md', [{ filePath: '/fixture.md', content: 'one chunk' }]);
    queue.commit(queue.peekBatch(10).token);
    assert.equal(fs.statSync(queue.eventsPath).size === 0, enabled);
    await feeder.shutdown();
  });
}

test('per-agent queue compaction overrides preserve shared feeder settings', () => {
  const loader = new ConfigLoader();
  loader.config = { feeder: { queueCompaction: { enabled: true, minBytes: 4096, archive: true } } };
  loader.applyInstanceFeederOverrides({ feeder: { queueCompaction: { archive: false } } });
  assert.deepEqual(loader.config.feeder.queueCompaction, { enabled: true, minBytes: 4096, archive: false });
  assert.ok(loader.config._instanceFeederOverridesApplied.includes('feeder.queueCompaction'));
});
