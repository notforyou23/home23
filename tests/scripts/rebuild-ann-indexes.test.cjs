'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');

const sourceScript = path.resolve(__dirname, '../../scripts/rebuild-ann-indexes.sh');

async function createAgent(root, agent, { configured = true, manifest = true } = {}) {
  const instanceDir = path.join(root, 'instances', agent);
  const brainDir = path.join(instanceDir, 'brain');
  await fsp.mkdir(brainDir, { recursive: true });
  if (configured) await fsp.writeFile(path.join(instanceDir, 'config.yaml'), `name: ${agent}\n`);
  if (manifest) await fsp.writeFile(path.join(brainDir, 'memory-manifest.json'), '{}\n');
  await fsp.writeFile(path.join(brainDir, 'memory-nodes.jsonl.gz'), 'legacy-sidecar');
}

async function createFixture(builderSource) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-rebuild-ann-'));
  const scriptDir = path.join(root, 'scripts');
  const builderDir = path.join(root, 'engine', 'src', 'merge');
  await fsp.mkdir(scriptDir, { recursive: true });
  await fsp.mkdir(builderDir, { recursive: true });
  await fsp.copyFile(sourceScript, path.join(scriptDir, 'rebuild-ann-indexes.sh'));
  await fsp.chmod(path.join(scriptDir, 'rebuild-ann-indexes.sh'), 0o700);
  await fsp.writeFile(path.join(builderDir, 'build-ann-index.js'), builderSource);
  await createAgent(root, 'jerry');
  await createAgent(root, 'forrest');
  return root;
}

const successReceipt = "console.log(JSON.stringify({event:'ann_rebuild_receipt',status:'fresh',builtRevision:1,currentRevision:1,bridgeableGap:0,indexCount:1,stageDurations:{totalMs:1},semanticCoverage:{indexed:1,skipped:0}}));\n";

function runFixture(root, agents = []) {
  return spawnSync('bash', [path.join(root, 'scripts', 'rebuild-ann-indexes.sh'), ...agents], {
    cwd: root,
    encoding: 'utf8',
  });
}

test('wrapper propagates a nonzero builder exit and never prints agent OK', async (t) => {
  const root = await createFixture("console.error('typed_builder_failure'); process.exit(7);\n");
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const result = runFixture(root);
  const output = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /typed_builder_failure/);
  assert.doesNotMatch(output, /(?:jerry|forrest) OK/);
});

test('wrapper discovers every configured instance instead of hardcoding agent names', async (t) => {
  const root = await createFixture(`
const fs = require('node:fs');
fs.appendFileSync(process.env.INVOCATIONS, process.argv[2] + '\\n');
${successReceipt}
`);
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.rm(path.join(root, 'instances', 'jerry'), { recursive: true, force: true });
  await fsp.rm(path.join(root, 'instances', 'forrest'), { recursive: true, force: true });
  await createAgent(root, 'ada');
  await createAgent(root, 'morgan');
  await createAgent(root, 'orphan', { configured: false });
  const invocations = path.join(root, 'invocations.txt');

  const result = spawnSync('bash', [path.join(root, 'scripts', 'rebuild-ann-indexes.sh')], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, INVOCATIONS: invocations },
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const invokedBrains = (await fsp.readFile(invocations, 'utf8')).trim().split('\n');
  assert.deepEqual(invokedBrains, [
    path.join(root, 'instances', 'ada', 'brain'),
    path.join(root, 'instances', 'morgan', 'brain'),
  ]);
});

test('wrapper accepts explicit bounded agent selectors and rejects traversal', async (t) => {
  const root = await createFixture(`
const fs = require('node:fs');
fs.appendFileSync(process.env.INVOCATIONS, process.argv[2] + '\\n');
${successReceipt}
`);
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const invocations = path.join(root, 'invocations.txt');

  const selected = spawnSync('bash', [path.join(root, 'scripts', 'rebuild-ann-indexes.sh'), 'forrest'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, INVOCATIONS: invocations },
  });
  assert.equal(selected.status, 0, `${selected.stdout}${selected.stderr}`);
  assert.equal((await fsp.readFile(invocations, 'utf8')).trim(), path.join(root, 'instances', 'forrest', 'brain'));

  await fsp.rm(invocations);
  const invalid = spawnSync('bash', [path.join(root, 'scripts', 'rebuild-ann-indexes.sh'), '../jerry'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, INVOCATIONS: invocations },
  });
  assert.notEqual(invalid.status, 0);
  assert.match(`${invalid.stdout}${invalid.stderr}`, /FAILED code=ann_agent_selector_invalid/);
  assert.equal(fs.existsSync(invocations), false, 'invalid selectors must not invoke the builder');
});

test('wrapper fails a legacy brain without invoking the builder for it', async (t) => {
  const root = await createFixture(`
const fs = require('node:fs');
fs.appendFileSync(process.env.INVOCATIONS, process.argv[2] + '\\n');
${successReceipt}
process.exit(0);
`);
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.rm(path.join(root, 'instances', 'jerry', 'brain', 'memory-manifest.json'));
  const invocations = path.join(root, 'invocations.txt');

  const result = spawnSync('bash', [path.join(root, 'scripts', 'rebuild-ann-indexes.sh')], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, INVOCATIONS: invocations },
  });
  const output = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /jerry FAILED code=ann_manifest_missing/);
  assert.doesNotMatch(output, /jerry OK/);
  const invokedBrains = (await fsp.readFile(invocations, 'utf8')).trim().split('\n');
  assert.deepEqual(invokedBrains, [path.join(root, 'instances', 'forrest', 'brain')]);
});

test('wrapper emits one structured per-agent receipt', async (t) => {
  const root = await createFixture(successReceipt);
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const result = runFixture(root, ['jerry']);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const rows = result.stdout.trim().split('\n').filter((line) => line.startsWith('{'));
  assert.equal(rows.length, 1);
  const receipt = JSON.parse(rows[0]);
  assert.equal(receipt.agent, 'jerry');
  assert.equal(receipt.status, 'fresh');
  assert.equal(receipt.bridgeableGap, 0);
  assert.deepEqual(receipt.semanticCoverage, { indexed: 1, skipped: 0 });
});

test('wrapper rejects zero-exit builder output without a semantic receipt', async (t) => {
  const root = await createFixture("console.log('DONE but not truthful'); process.exit(0);\n");
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const result = runFixture(root, ['jerry']);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /ann_receipt_invalid/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /jerry OK/);
});

test('wrapper alerts only after a configured sustained excessive overlay gap', async (t) => {
  const lagReceipt = "console.log(JSON.stringify({event:'ann_rebuild_receipt',status:'overlay-covered',builtRevision:1,currentRevision:11,bridgeableGap:10,indexCount:1,stageDurations:{totalMs:1},semanticCoverage:{indexed:1,skipped:0}}));\n";
  const root = await createFixture(lagReceipt);
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    ANN_SUSTAINED_GAP_THRESHOLD: '2',
    ANN_MAX_OVERLAY_GAP_RECORDS: '5',
  };
  const first = spawnSync('bash', [path.join(root, 'scripts', 'rebuild-ann-indexes.sh'), 'jerry'], {
    cwd: root, encoding: 'utf8', env,
  });
  assert.equal(first.status, 0, `${first.stdout}${first.stderr}`);
  assert.doesNotMatch(`${first.stdout}${first.stderr}`, /ann_sustained_gap/);
  const second = spawnSync('bash', [path.join(root, 'scripts', 'rebuild-ann-indexes.sh'), 'jerry'], {
    cwd: root, encoding: 'utf8', env,
  });
  assert.notEqual(second.status, 0);
  assert.match(`${second.stdout}${second.stderr}`, /ann_sustained_gap/);
  const state = JSON.parse(await fsp.readFile(
    path.join(root, 'instances', 'jerry', 'runtime', 'ann-index-health.json'),
    'utf8',
  ));
  assert.equal(state.consecutiveExcessiveGaps, 2);
});
