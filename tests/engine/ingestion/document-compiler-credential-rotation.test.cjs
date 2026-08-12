'use strict';

/**
 * The ingestion compiler builds its SDK client per model selection, which
 * froze the credential at build time. It must now track which provider
 * credential the client was built with and rebuild before compiling when
 * the resolved credential has rotated.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/engine/src/ingestion/document-compiler.js')
      || key.includes('/engine/src/services/openai-codex-oauth-engine.js')
      || key.includes('/engine/src/core/provider-credentials.js')) {
      delete require.cache[key];
    }
  }
  return require('../../../engine/src/ingestion/document-compiler');
}

function credentialsModule() {
  return require('../../../engine/src/core/provider-credentials');
}

function writeSecrets(filePath, providers) {
  const lines = ['providers:'];
  for (const [name, key] of Object.entries(providers)) {
    lines.push(`  ${name}:`);
    lines.push(`    apiKey: "${key}"`);
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
}

async function withHarness(fn) {
  const saved = {};
  for (const key of ['HOME23_SECRETS_PATH', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY',
    'MINIMAX_API_KEY', 'OLLAMA_CLOUD_API_KEY', 'COMPILER_LLM_BASE_URL', 'COMPILER_LLM_API_KEY']) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-compiler-'));
  const secretsPath = path.join(dir, 'secrets.yaml');
  const workspacePath = path.join(dir, 'workspace');
  fs.mkdirSync(workspacePath);
  process.env.HOME23_SECRETS_PATH = secretsPath;
  try {
    return await fn({ secretsPath, workspacePath });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('_ensureFreshClient rebuilds when the tracked provider credential rotates', async () => {
  await withHarness(async ({ secretsPath, workspacePath }) => {
    writeSecrets(secretsPath, { anthropic: 'sk-ant-oat01-old' });
    const { DocumentCompiler } = freshModules();
    const compiler = new DocumentCompiler({
      workspacePath,
      config: { model: 'test-model', baseURL: 'http://localhost:1', apiKey: 'pinned' },
    });

    // Simulate a client that was built from the anthropic provider credential.
    compiler._builtWithProvider = 'anthropic';
    compiler._builtWithKey = 'sk-ant-oat01-old';
    let rebuilds = 0;
    compiler._buildClient = () => { rebuilds++; };

    // Unchanged credential: no rebuild.
    compiler._ensureFreshClient();
    assert.equal(rebuilds, 0);

    // Rotation lands in the file.
    writeSecrets(secretsPath, { anthropic: 'sk-ant-oat01-new' });
    credentialsModule()._resetCredentialCache(); // stand-in for the 15s window elapsing

    compiler._ensureFreshClient();
    assert.equal(rebuilds, 1);
  });
});

/** A (provider, model) pair from the real config/home.yaml — the compiler
 * resolves its provider by looking the model up there. */
function providerFromHomeYaml() {
  const repoRoot = path.resolve(__dirname, '../../..');
  const yaml = require(path.join(repoRoot, 'node_modules', 'js-yaml'));
  const home = yaml.load(fs.readFileSync(path.join(repoRoot, 'config', 'home.yaml'), 'utf8')) || {};
  const entry = Object.entries(home.providers || {})
    .find(([name, prov]) => name !== 'openai-codex' && (prov.defaultModels || []).length > 0);
  assert.ok(entry, 'config/home.yaml should declare a provider with defaultModels');
  return { providerName: entry[0], model: entry[1].defaultModels[0] };
}

test('_buildClient tracks the provider credential it resolved from home.yaml', async () => {
  await withHarness(async ({ secretsPath, workspacePath }) => {
    const { providerName, model } = providerFromHomeYaml();
    writeSecrets(secretsPath, { [providerName]: 'sk-tracked-credential' });

    const { DocumentCompiler } = freshModules();
    const compiler = new DocumentCompiler({ workspacePath, config: { model } });

    assert.equal(compiler._builtWithProvider, providerName);
    assert.equal(compiler._builtWithKey, 'sk-tracked-credential');
  });
});

test('a deliberate pin is never tracked, even when it equals the current file value', async () => {
  await withHarness(async ({ secretsPath, workspacePath }) => {
    // The pin and the file agree TODAY. Without the pin guard the compiler
    // would track this and silently rebuild away from the operator's pin on
    // the next rotation — the pin has to win regardless.
    const { providerName, model } = providerFromHomeYaml();
    writeSecrets(secretsPath, { [providerName]: 'sk-same-value-as-pin' });

    const { DocumentCompiler } = freshModules();
    const compiler = new DocumentCompiler({
      workspacePath,
      config: { model, apiKey: 'sk-same-value-as-pin' },
    });

    assert.equal(compiler._builtWithProvider, null);
    assert.equal(compiler._builtWithKey, null);
  });
});

test('_ensureFreshClient is inert for clients not built from a provider credential', async () => {
  await withHarness(async ({ workspacePath }) => {
    const { DocumentCompiler } = freshModules();
    const compiler = new DocumentCompiler({
      workspacePath,
      config: { model: 'test-model', baseURL: 'http://localhost:1', apiKey: 'pinned' },
    });

    let rebuilds = 0;
    compiler._buildClient = () => { rebuilds++; };
    compiler._ensureFreshClient();
    assert.equal(rebuilds, 0);
  });
});
