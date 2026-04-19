const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { RunManager } = require('./run-manager');

function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

async function makeTmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cosmo-rm-'));
}

test('createRun with runPath creates at override location and symlinks default', async () => {
  const tmp = await makeTmp();
  try {
    const runsDir = path.join(tmp, 'runs');
    await fs.mkdir(runsDir, { recursive: true });
    const externalDir = path.join(tmp, 'agent-workspace', 'research-runs', 'test-run');
    const rm = new RunManager(runsDir, silentLogger());

    const result = await rm.createRun('test-run', { runPath: externalDir, owner: 'jerry', topic: 'test topic' });
    assert.equal(result.success, true);
    assert.equal(result.path, externalDir);

    const stat = await fs.stat(externalDir);
    assert.ok(stat.isDirectory());

    const linkStat = await fs.lstat(path.join(runsDir, 'test-run'));
    assert.ok(linkStat.isSymbolicLink());

    const runJson = JSON.parse(await fs.readFile(path.join(externalDir, 'run.json'), 'utf8'));
    assert.equal(runJson.owner, 'jerry');
    assert.equal(runJson.topic, 'test topic');
    assert.equal(runJson.runName, 'test-run');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('createRun without runPath preserves legacy behavior', async () => {
  const tmp = await makeTmp();
  try {
    const runsDir = path.join(tmp, 'runs');
    await fs.mkdir(runsDir, { recursive: true });
    const rm = new RunManager(runsDir, silentLogger());

    const result = await rm.createRun('legacy-run');
    assert.equal(result.success, true);
    assert.equal(result.path, path.join(runsDir, 'legacy-run'));

    const stat = await fs.lstat(path.join(runsDir, 'legacy-run'));
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink());

    // run.json still written with null owner/topic
    const runJson = JSON.parse(await fs.readFile(path.join(result.path, 'run.json'), 'utf8'));
    assert.equal(runJson.owner, null);
    assert.equal(runJson.topic, null);
    assert.equal(runJson.runName, 'legacy-run');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('createRun refuses when runPath already exists', async () => {
  const tmp = await makeTmp();
  try {
    const runsDir = path.join(tmp, 'runs');
    const externalDir = path.join(tmp, 'ext', 'collide');
    await fs.mkdir(externalDir, { recursive: true });
    const rm = new RunManager(runsDir, silentLogger());

    const result = await rm.createRun('collide', { runPath: externalDir });
    assert.equal(result.success, false);
    assert.match(result.error || '', /already exists/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
