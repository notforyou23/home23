'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { CODEX_CATALOG_COMPATIBILITY_VERSION, CODEX_REGISTRY_VERSION_URL, createCodexCatalogVersionDetector,
  fetchCodexRegistryVersion, maxStableVersion, parseCodexVersion, resolveBinFrom } = require('../../shared/cli-binary.cjs');

test('Codex version probe shares configured/PATH resolver, scrubs secrets, bounds work and memoizes binary identity', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-cli-version-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configured = path.join(root, 'configured'); const normal = path.join(root, 'codex');
  fs.writeFileSync(configured, 'first'); fs.writeFileSync(normal, 'normal');
  assert.equal(resolveBinFrom(['codex'], configured, { PATH: root }), configured);
  assert.equal(resolveBinFrom(['codex'], '/nonexistent-fixture-bin', { PATH: root }), normal);
  let calls = 0; let version = 'codex-cli 0.159.0\n';
  const detect = createCodexCatalogVersionDetector({ env: { PATH: root, HOME: root, OPENAI_API_KEY: 'secret', OPENAI_CODEX_AUTH_TOKEN: 'secret',
    HOME23_BRAIN_OPERATIONS_CAPABILITY_KEY: 'secret', NODE_OPTIONS: '--require /untrusted', OTHER_SECRET: 'secret' },
    runVersion(binary, args, options) {
      calls++; assert.equal(binary, configured); assert.deepEqual(args, ['--version']);
      assert.deepEqual(options.env, { PATH: root, HOME: root });
      assert.equal(options.timeout, 1500); assert.equal(options.maxBuffer, 4096);
      return version;
    } });
  assert.equal(detect(configured).version, CODEX_CATALOG_COMPATIBILITY_VERSION, 'an older installed CLI cannot lower compatibility');
  detect(configured); assert.equal(calls, 1);
  version = 'codex-cli 0.164.0\n'; fs.writeFileSync(configured, 'replaced-binary');
  assert.equal(detect(configured).version, '0.164.0'); assert.equal(calls, 2);
  version = 'invalid version'; fs.writeFileSync(configured, 'broken-replaced-binary');
  assert.equal(detect(configured).version, '0.164.0', 'probe failure retains its last validated version');
  assert.equal(detect(configured).errorCode, 'model_discovery_client_version');
  const missing = createCodexCatalogVersionDetector({ resolveBin: () => null, runVersion() { assert.fail('missing CLI must not execute'); } });
  assert.deepEqual(missing(), { version: '0.162.0', fingerprint: 'compatibility-no-cli', errorCode: null });
  const failed = createCodexCatalogVersionDetector({ resolveBin: () => configured, runVersion() { throw Error('timeout'); } });
  assert.equal(failed().errorCode, 'model_discovery_client_version');
  for (const invalid of ['0.0162.0', 'v0.162.0', '0.162.0-beta.1', '0.162.0\nextra', 'garbage', '0.162', '9007199254740992.0.0', '9'.repeat(65) + '.0.0']) assert.equal(parseCodexVersion(invalid), null);
  assert.equal(maxStableVersion('0.159.0', '0.163.0', '0.162.0'), '0.163.0');
});

test('official version hint reads only a bounded fixed public document and rejects nonstable metadata', async () => {
  const read = value => fetchCodexRegistryVersion(async (url, options) => {
    assert.equal(url, CODEX_REGISTRY_VERSION_URL);
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
    assert.deepEqual(options.headers, { accept: 'application/json' }); assert(options.signal instanceof AbortSignal);
    return new Response(value);
  });
  assert.equal(await read(JSON.stringify({ name: '@openai/codex', version: '0.163.0', dist: { tarball: 'https://untrusted.example/never-read' } })), '0.163.0');
  for (const version of ['0.164.0-beta.1', 'codex-cli 0.164.0', 'latest', '0.0164.0']) {
    await assert.rejects(read(JSON.stringify({ name: '@openai/codex', version })), /Invalid stable/);
  }
  await assert.rejects(read(JSON.stringify({ name: 'wrong-package', version: '0.163.0' })), /Invalid Codex metadata package/);
  await assert.rejects(read('x'.repeat(64 * 1024 + 1)), /too large/);
  await assert.rejects(fetchCodexRegistryVersion(async () => new Response('down', { status: 503 })), /unavailable/);
});
