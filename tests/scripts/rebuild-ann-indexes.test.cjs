'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');

const sourceScript = path.resolve(__dirname, '../../scripts/rebuild-ann-indexes.sh');

async function createFixture(builderSource) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-rebuild-ann-'));
  const scriptDir = path.join(root, 'scripts');
  const builderDir = path.join(root, 'engine', 'src', 'merge');
  await fsp.mkdir(scriptDir, { recursive: true });
  await fsp.mkdir(builderDir, { recursive: true });
  await fsp.copyFile(sourceScript, path.join(scriptDir, 'rebuild-ann-indexes.sh'));
  await fsp.chmod(path.join(scriptDir, 'rebuild-ann-indexes.sh'), 0o700);
  await fsp.writeFile(path.join(builderDir, 'build-ann-index.js'), builderSource);
  for (const agent of ['jerry', 'forrest']) {
    const brainDir = path.join(root, 'instances', agent, 'brain');
    await fsp.mkdir(brainDir, { recursive: true });
    await fsp.writeFile(path.join(brainDir, 'memory-manifest.json'), '{}\n');
    await fsp.writeFile(path.join(brainDir, 'memory-nodes.jsonl.gz'), 'legacy-sidecar');
  }
  return root;
}

function runFixture(root) {
  return spawnSync('bash', [path.join(root, 'scripts', 'rebuild-ann-indexes.sh')], {
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

test('wrapper fails a legacy brain without invoking the builder for it', async (t) => {
  const root = await createFixture(`
const fs = require('node:fs');
fs.appendFileSync(process.env.INVOCATIONS, process.argv[2] + '\\n');
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
