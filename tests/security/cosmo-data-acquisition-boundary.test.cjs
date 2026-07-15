const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Database = require('better-sqlite3');
const {
  DataAcquisitionAgent,
} = require('../../cosmo23/engine/src/agents/data-acquisition-agent.js');

test('data acquisition treats hostile JSON keys as SQLite identifiers, never Python source', async (t) => {
  if (spawnSync('python3', ['--version'], { encoding: 'utf8' }).error) {
    t.skip('python3 is unavailable');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-data-acquisition-key-'));
  const outputDir = path.join(root, 'output');
  const markerPath = path.join(root, 'injected.txt');
  fs.mkdirSync(outputDir, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const hostileKey = `payload" TEXT)'); __import__("pathlib").Path(${JSON.stringify(
    markerPath,
  )}).write_text(__import__("os").environ.get("HOME23_BRAIN_OPERATIONS_CAPABILITY_KEY", "executed")); #`;
  fs.writeFileSync(path.join(outputDir, 'records.json'), JSON.stringify([
    { name: 'first', [hostileKey]: 'alpha' },
    { name: 'second', [hostileKey]: 'beta' },
  ]));

  const priorCapability = process.env.HOME23_BRAIN_OPERATIONS_CAPABILITY_KEY;
  process.env.HOME23_BRAIN_OPERATIONS_CAPABILITY_KEY = 'must-never-cross';
  t.after(() => {
    if (priorCapability === undefined) {
      delete process.env.HOME23_BRAIN_OPERATIONS_CAPABILITY_KEY;
    } else {
      process.env.HOME23_BRAIN_OPERATIONS_CAPABILITY_KEY = priorCapability;
    }
  });

  const agent = Object.create(DataAcquisitionAgent.prototype);
  agent._outputDir = outputDir;
  agent.acquisitionManifest = {};
  agent.logger = { debug() {} };
  agent._writeManifest = async () => {};
  agent.addFinding = async () => {};

  const result = await agent._consolidateToDatabase();

  assert.equal(fs.existsSync(markerPath), false);
  assert.equal(result.totalRecords, 2);
  const db = new Database(result.dbPath, { readonly: true });
  t.after(() => db.close());
  const columns = db.prepare('PRAGMA table_info("records")').all().map(row => row.name);
  assert.equal(columns.includes(hostileKey), true);
  const values = db.prepare(
    `SELECT ${'"' + hostileKey.replaceAll('"', '""') + '"'} AS value FROM "records" ORDER BY id`,
  ).all().map(row => row.value);
  assert.deepEqual(values, ['alpha', 'beta']);
});
