import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { writeProductManifest, verifyProductPayload, installProductPayload } from '../../cli/lib/product-payload.js';
import { auditSharedSkills, executeSharedSkill, listSharedSkills, syncSharedSkillsRegistry } from '../../src/skills/runtime.js';

const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);

function fixture(t: any, productHost: boolean) {
  const previous = process.env.HOME23_PRODUCT_HOST;
  if (productHost) process.env.HOME23_PRODUCT_HOST = 'true';
  else delete process.env.HOME23_PRODUCT_HOST;
  t.after(() => {
    if (previous === undefined) delete process.env.HOME23_PRODUCT_HOST;
    else process.env.HOME23_PRODUCT_HOST = previous;
  });
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home23-skill-state-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const payload = path.join(base, 'payload'), homeRoot = path.join(base, 'New home');
  const files = {
    'bin/node': 'fixture executable\n',
    'tools/node_modules/pm2/bin/pm2': 'fixture process manager\n',
    'app/cli/home23.js': 'export {};\n',
    'app/cli/lib/product-payload.js': 'export {};\n',
    'app/scripts/product/host.mjs': 'export {};\n',
    'app/package.json': JSON.stringify({ type: 'module' }),
    'app/workspace/skills/REGISTRY.md': '# Packaged registry snapshot\n',
    'app/workspace/skills/fixture/manifest.json': JSON.stringify({ id: 'fixture', actions: ['inspect'] }),
    'app/workspace/skills/fixture/SKILL.md': '# Fixture\nA local skill with no external effects.\n',
    'app/workspace/skills/fixture/index.js': 'export function inspect() { return "fixture-result"; }\n',
  };
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(payload, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    fs.writeFileSync(file, contents, { mode: relative === 'bin/node' ? 0o755 : 0o644 });
  }
  for (const name of ['index.js', 'skill-loader.js']) {
    fs.copyFileSync(path.join(sourceRoot, 'workspace/skills', name), path.join(payload, 'app/workspace/skills', name));
  }
  fs.cpSync(path.dirname(require.resolve('js-yaml/package.json')), path.join(payload, 'app/node_modules/js-yaml'), { recursive: true });
  // Match the package builder's normalized public modes, regardless of local npm's modes.
  function normalizeModes(directory: string) {
    fs.chmodSync(directory, 0o755);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) normalizeModes(file);
      else fs.chmodSync(file, file === path.join(payload, 'bin/node') ? 0o755 : 0o644);
    }
  }
  normalizeModes(payload);
  const manifest = writeProductManifest(payload, {
    sourceCommit: 'a'.repeat(40), platform: process.platform, arch: process.arch, nodeVersion: 'v22.23.2',
  });
  installProductPayload({ payloadPath: payload, homeRoot });
  return { payload, homeRoot, appRoot: path.join(homeRoot, 'app'), manifest };
}

test('packaged registry and usage are home state; discovery, execution, audit and integrity still agree', async t => {
  const { payload, homeRoot, appRoot, manifest } = fixture(t, true);
  const packagedRegistry = path.join(appRoot, 'workspace/skills/REGISTRY.md');
  const snapshot = fs.readFileSync(packagedRegistry, 'utf8');
  const registry: any = await syncSharedSkillsRegistry(appRoot);
  assert.equal(registry.path, path.join(appRoot, 'runtime/skills/REGISTRY.md'));
  assert.equal(registry.skillCount, 1);
  assert.match(fs.readFileSync(registry.path, 'utf8'), /## fixture/);
  assert.equal(fs.readFileSync(packagedRegistry, 'utf8'), snapshot);
  assert.equal(fs.statSync(registry.path).mode & 0o777, 0o600);

  // Audit works before there is any usage file, and reads the writer's exact location after a run.
  const empty: any = await auditSharedSkills(appRoot, { skillId: 'fixture' });
  assert.equal(empty.skills[0].usage.runCount, 0);
  assert.equal((await listSharedSkills(appRoot)).length, 1);
  assert.equal(await executeSharedSkill(appRoot, 'fixture', 'inspect', {}, {
    projectRoot: appRoot, workspacePath: path.join(appRoot, 'instances/milo/workspace'),
  } as any), 'fixture-result');
  const audit: any = await auditSharedSkills(appRoot, { skillId: 'fixture' });
  assert.equal(audit.skills[0].usage.runCount, 1);
  const telemetryDir = path.join(appRoot, 'runtime/skills/.telemetry');
  const telemetryFile = path.join(telemetryDir, fs.readdirSync(telemetryDir)[0]);
  assert.equal(fs.statSync(telemetryDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(telemetryFile).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(appRoot, 'workspace/skills/.telemetry')), false);

  assert.equal(verifyProductPayload(homeRoot, { allowRuntimeState: true }).packageId, manifest.packageId);
  assert.equal(installProductPayload({ payloadPath: payload, homeRoot }).replayed, true);
  assert.equal((await auditSharedSkills(appRoot, { skillId: 'fixture' }) as any).skills[0].usage.runCount, 1);
  fs.appendFileSync(path.join(appRoot, 'workspace/skills/fixture/index.js'), '// changed packaged skill\n');
  assert.throws(() => verifyProductPayload(homeRoot, { allowRuntimeState: true }), /Product file changed: app\/workspace\/skills\/fixture\/index.js/);
});

test('legacy installations retain registry and audit telemetry under workspace/skills', async t => {
  const { appRoot } = fixture(t, false);
  const registry: any = await syncSharedSkillsRegistry(appRoot);
  assert.equal(registry.path, path.join(appRoot, 'workspace/skills/REGISTRY.md'));
  await executeSharedSkill(appRoot, 'fixture', 'inspect', {}, {
    projectRoot: appRoot, workspacePath: path.join(appRoot, 'instances/milo/workspace'),
  } as any);
  assert.equal((await auditSharedSkills(appRoot, { skillId: 'fixture' }) as any).skills[0].usage.runCount, 1);
  assert.equal(fs.existsSync(path.join(appRoot, 'workspace/skills/.telemetry')), true);
  assert.equal(fs.existsSync(path.join(appRoot, 'runtime')), false);
});
