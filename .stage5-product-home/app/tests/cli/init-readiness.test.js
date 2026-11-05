import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { runInit } from '../../cli/lib/init.js';

function fixture(t, { missingPackage, fail } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'home23 init readiness '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ['', 'engine', 'evobrew']) {
    const path = join(root, directory);
    mkdirSync(path, { recursive: true });
    if (directory !== missingPackage) writeFileSync(join(path, 'package.json'), '{}');
  }
  const output = [];
  const calls = [];
  const imports = [];
  const actions = [];
  t.mock.method(console, 'log', (...values) => output.push(values.join(' ')));
  t.mock.method(console, 'error', (...values) => output.push(values.join(' ')));
  t.mock.method(process.stdout, 'write', (value) => { output.push(String(value)); return true; });
  const dependencies = {
    execute(command, args, options) {
      const call = { command, args, options };
      calls.push(call);
      if (fail?.(call, root)) {
        const error = new Error('simulated execution failure');
        error.stderr = Buffer.from('specific dependency or compiler diagnostic');
        throw error;
      }
      return command === 'ollama' && args[0] === 'list' ? 'nomic-embed-text' : '';
    },
    async loadModule(specifier) {
      imports.push(specifier);
      if (specifier === './brain-operations-capability.js') {
        return { ensureBrainOperationsCapabilityKey: async () => {
          actions.push('capability');
          return { permissionsRepaired: false };
        } };
      }
      if (specifier === './generate-ecosystem.js') {
        return { generateEcosystem: () => actions.push('ecosystem') };
      }
      throw new Error(`Unexpected lazy import: ${specifier}`);
    },
  };
  return { root, dependencies, output, calls, imports, actions };
}

for (const directory of ['engine', '', 'evobrew']) {
  test(`required ${directory || 'harness'} dependency failure stops setup before configuration or build`, async (t) => {
    const f = fixture(t, {
      fail: ({ command, options }, root) => command === 'npm' && options.cwd === join(root, directory),
    });
    await assert.rejects(runInit(f.root, {}, f.dependencies), (error) => {
      assert.equal(error.code, 'HOME23_INIT_REQUIRED_STEP_FAILED');
      assert.match(error.message, /dependency installation.*Setup stopped/);
      assert.match(error.message, /Run npm install/);
      assert.match(error.message, /specific dependency or compiler diagnostic/);
      assert.equal(error.cause.message, 'simulated execution failure');
      return true;
    });
    assert.deepEqual(f.imports, []);
    assert.equal(f.calls.at(-1).options.cwd, join(f.root, directory));
    assert.equal(f.calls.some(({ command, args }) => command === 'npm' && args[0] === 'run'), false);
    assert.equal(f.output.some((line) => /runtime prepared|Home23 is ready/.test(line)), false);
  });
}

test('missing required source is rejected before dependency installation', async (t) => {
  const f = fixture(t, { missingPackage: 'engine' });
  await assert.rejects(runInit(f.root, {}, f.dependencies), /package.json is missing; restore the complete Home23 source/);
  assert.equal(f.calls.some(({ command }) => command === 'npm'), false);
  assert.deepEqual(f.imports, []);
});

test('required TypeScript build failure stops setup and exposes diagnostic and recovery command', async (t) => {
  const f = fixture(t, { fail: ({ command, args }) => command === 'npm' && args[0] === 'run' });
  await assert.rejects(runInit(f.root, {}, f.dependencies), (error) => {
    assert.match(error.message, /TypeScript build.*Setup stopped/);
    assert.match(error.message, /npm run build/);
    assert.match(error.message, /specific dependency or compiler diagnostic/);
    return true;
  });
  assert.deepEqual(f.calls.at(-1).args, ['run', 'build']);
  assert.deepEqual(f.imports, []);
  assert.deepEqual(f.actions, []);
  assert.equal(f.output.some((line) => /runtime prepared|Home23 is ready/.test(line)), false);
});

test('missing PM2 rejects initialization instead of exiting the caller or advancing setup', async (t) => {
  const f = fixture(t, { fail: ({ command }) => command === 'pm2' });
  await assert.rejects(runInit(f.root, {}, f.dependencies), /PM2 not found.*npm install -g pm2/);
  assert.equal(f.calls.some(({ command }) => command === 'npm'), false);
  assert.deepEqual(f.imports, []);
});

test('optional Python failure preserves prepared runtime while reporting unavailable document conversion', async (t) => {
  const f = fixture(t, {
    fail: ({ command, args }) => command === 'python3' && args[0] === '-m',
  });
  const result = await runInit(f.root, {}, f.dependencies);
  assert.deepEqual(result, { status: 'prepared', documentConversion: 'unavailable' });
  assert.deepEqual(f.actions, ['capability', 'ecosystem']);
  assert.equal(f.output.some((line) => line.includes('runtime prepared; document conversion unavailable')), true);
  assert.equal(f.output.some((line) => line.includes('pip install "markitdown[pdf]" openai')), true);
});

test('successful init passes Python paths as arguments and reports prepared runtime', async (t) => {
  const f = fixture(t);
  const result = await runInit(f.root, { finalMessage: false }, f.dependencies);
  assert.deepEqual(result, { status: 'prepared', documentConversion: 'ready' });
  assert.deepEqual(f.calls.find(({ command, args }) => command === 'python3' && args[0] === '-m').args,
    ['-m', 'venv', join(f.root, 'engine', '.venv-markitdown')]);
  assert.equal(f.calls.at(-1).command, join(f.root, 'engine', '.venv-markitdown', 'bin', 'python3'));
  assert.deepEqual(f.calls.at(-1).args, ['-m', 'pip', 'install', '--quiet', '--upgrade', 'pip', 'markitdown[pdf]', 'openai']);
});

test('standalone init directs a new owner into canonical home setup', async (t) => {
  const f = fixture(t);
  await runInit(f.root, {}, f.dependencies);
  assert.equal(f.output.some((line) => line.includes('node cli/home23.js setup')), true);
  assert.equal(f.output.some((line) => line.includes('agent create <name>')), false);
});

test('init can be imported before npm packages or other CLI modules exist', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'home23-init-no-dependencies-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const modulePath = join(root, 'init.mjs');
  copyFileSync(new URL('../../cli/lib/init.js', import.meta.url), modulePath);
  const output = execFileSync(process.execPath, ['--input-type=module', '-e',
    `const module = await import(${JSON.stringify(pathToFileURL(modulePath).href)}); console.log(typeof module.runInit);`,
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(output.trim(), 'function');
});
