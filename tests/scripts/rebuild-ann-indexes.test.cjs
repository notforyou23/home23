'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');

const sourceScript = path.resolve(__dirname, '../../scripts/rebuild-ann-indexes.sh');
const sourceHealthWriter = path.resolve(__dirname, '../../scripts/lib/ann-index-health.cjs');

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
  const scriptLibDir = path.join(scriptDir, 'lib');
  const builderDir = path.join(root, 'engine', 'src', 'merge');
  await fsp.mkdir(scriptDir, { recursive: true });
  await fsp.mkdir(scriptLibDir, { recursive: true });
  await fsp.mkdir(builderDir, { recursive: true });
  await fsp.copyFile(sourceScript, path.join(scriptDir, 'rebuild-ann-indexes.sh'));
  await fsp.copyFile(sourceHealthWriter, path.join(scriptLibDir, 'ann-index-health.cjs'));
  await fsp.chmod(path.join(scriptDir, 'rebuild-ann-indexes.sh'), 0o700);
  await fsp.writeFile(path.join(builderDir, 'build-ann-index.js'), builderSource);
  await createAgent(root, 'jerry');
  await createAgent(root, 'forrest');
  return root;
}

const successReceipt = "console.log(JSON.stringify({event:'ann_rebuild_receipt',status:'fresh',builtRevision:1,currentRevision:1,bridgeableGap:0,indexCount:1,stageDurations:{sourceOpenMs:1,sourceScanMs:1,indexWriteMs:1,metadataWriteMs:1,publishMs:1,reuseValidationMs:0,cleanupMs:1,totalMs:7},stageStatuses:{sourceOpen:'completed',sourceScan:'completed',indexWrite:'completed',metadataWrite:'completed',publish:'completed',reuseValidation:'skipped',cleanup:'completed',total:'completed'},semanticCoverage:{status:'complete',sourceNodes:1,indexed:1,skipped:0,usable:true,vectorCoverageBps:10000,minimumVectorCoverageBps:5000},reused:false}));\n";
const incompleteReceipt = "console.log(JSON.stringify({event:'ann_rebuild_receipt',status:'fresh',builtRevision:1,currentRevision:1,bridgeableGap:0,indexCount:1,stageDurations:{totalMs:1},semanticCoverage:{indexed:1,skipped:0}}));\n";

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
  assert.deepEqual(receipt.semanticCoverage, {
    status: 'complete', sourceNodes: 1, indexed: 1, skipped: 0,
    usable: true, vectorCoverageBps: 10000, minimumVectorCoverageBps: 5000,
  });
});

test('wrapper rejects zero-exit builder output without a semantic receipt', async (t) => {
  const root = await createFixture("console.log('DONE but not truthful'); process.exit(0);\n");
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const result = runFixture(root, ['jerry']);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /ann_receipt_invalid/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /jerry OK/);
});

test('wrapper rejects a receipt without audited per-stage status and complete coverage vocabulary', async (t) => {
  const root = await createFixture(incompleteReceipt);
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const result = runFixture(root, ['jerry']);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /ann_receipt_invalid/);
});

test('wrapper rejects internally inconsistent stage status claims', async (t) => {
  const inconsistent = successReceipt.replace("sourceScan:'completed'", "sourceScan:'skipped'");
  const root = await createFixture(inconsistent);
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const result = runFixture(root, ['jerry']);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /ann_receipt_invalid/);
});

test('wrapper rejects zero usable-vector coverage instead of writing healthy state', async (t) => {
  const empty = successReceipt
    .replace('indexCount:1', 'indexCount:0')
    .replace('sourceNodes:1,indexed:1,skipped:0,usable:true,vectorCoverageBps:10000',
      'sourceNodes:1,indexed:0,skipped:1,usable:false,vectorCoverageBps:0');
  const root = await createFixture(empty);
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const result = runFixture(root, ['jerry']);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /ann_receipt_invalid/);
  const health = JSON.parse(await fsp.readFile(
    path.join(root, 'instances', 'jerry', 'runtime', 'ann-index-health.json'), 'utf8',
  ));
  assert.equal(health.status, 'failed');
  assert.equal(health.coverageStatus, 'receipt_invalid');
});

test('wrapper enforces its configured minimum usable-vector floor', async (t) => {
  const insufficient = successReceipt.replace(
    'sourceNodes:1,indexed:1,skipped:0,usable:true,vectorCoverageBps:10000,minimumVectorCoverageBps:5000',
    'sourceNodes:10000,indexed:1,skipped:9999,usable:true,vectorCoverageBps:1,minimumVectorCoverageBps:1',
  );
  const root = await createFixture(insufficient);
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const result = runFixture(root, ['jerry']);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /ann_receipt_invalid/);
});

test('wrapper accepts rebuilt-overlay-covered and rejects impossible sequential timing totals', async (t) => {
  const rebuilt = successReceipt
    .replace("status:'fresh'", "status:'rebuilt-overlay-covered'")
    .replace('currentRevision:1,bridgeableGap:0', 'currentRevision:2,bridgeableGap:1');
  const root = await createFixture(rebuilt);
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const accepted = runFixture(root, ['jerry']);
  assert.equal(accepted.status, 0, `${accepted.stdout}${accepted.stderr}`);
  assert.match(accepted.stdout, /rebuilt-overlay-covered/);

  await fsp.writeFile(
    path.join(root, 'engine', 'src', 'merge', 'build-ann-index.js'),
    successReceipt.replace('totalMs:7', 'totalMs:1'),
  );
  const impossible = runFixture(root, ['jerry']);
  assert.notEqual(impossible.status, 0);
  assert.match(`${impossible.stdout}${impossible.stderr}`, /ann_receipt_invalid/);
});

test('wrapper records each hard failure instead of leaving stale healthy state', async (t) => {
  const root = await createFixture(successReceipt);
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const healthPath = path.join(root, 'instances', 'jerry', 'runtime', 'ann-index-health.json');
  assert.equal(runFixture(root, ['jerry']).status, 0);

  await fsp.writeFile(
    path.join(root, 'engine', 'src', 'merge', 'build-ann-index.js'),
    "console.error('typed hard failure'); process.exit(7);\n",
  );
  const builderFailure = runFixture(root, ['jerry']);
  assert.notEqual(builderFailure.status, 0);
  let health = JSON.parse(await fsp.readFile(healthPath, 'utf8'));
  assert.equal(health.status, 'failed');
  assert.equal(health.coverageStatus, 'builder_failed');
  assert.equal(health.consecutiveCoverageFailures, 1);

  await fsp.writeFile(
    path.join(root, 'engine', 'src', 'merge', 'build-ann-index.js'),
    "console.log('not a receipt');\n",
  );
  const invalidReceipt = runFixture(root, ['jerry']);
  assert.notEqual(invalidReceipt.status, 0);
  health = JSON.parse(await fsp.readFile(healthPath, 'utf8'));
  assert.equal(health.coverageStatus, 'receipt_invalid');
  assert.equal(health.consecutiveCoverageFailures, 2);

  await fsp.rm(path.join(root, 'instances', 'jerry', 'brain', 'memory-manifest.json'));
  const missingManifest = runFixture(root, ['jerry']);
  assert.notEqual(missingManifest.status, 0);
  health = JSON.parse(await fsp.readFile(healthPath, 'utf8'));
  assert.equal(health.coverageStatus, 'manifest_missing');
  assert.equal(health.consecutiveCoverageFailures, 3);
});

test('wrapper refuses a symlinked runtime health target without writing outside Home23', async (t) => {
  const root = await createFixture(successReceipt);
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-ann-health-outside-'));
  t.after(() => Promise.all([
    fsp.rm(root, { recursive: true, force: true }),
    fsp.rm(outside, { recursive: true, force: true }),
  ]));
  await fsp.symlink(outside, path.join(root, 'instances', 'jerry', 'runtime'));
  const result = runFixture(root, ['jerry']);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /ann_health_write_failed/);
  assert.equal(fs.existsSync(path.join(outside, 'ann-index-health.json')), false);
});

test('wrapper alerts only after a configured sustained excessive overlay gap', async (t) => {
  const lagReceipt = successReceipt
    .replace("status:'fresh'", "status:'rebuilt-overlay-covered'")
    .replace('currentRevision:1,bridgeableGap:0', 'currentRevision:11,bridgeableGap:10');
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
  assert.equal(state.coverageStatus, 'coverage_gap');
  assert.equal(state.alertStatus, 'sustained_failure');
  assert.equal(state.consecutiveCoverageFailures, 2);
});
