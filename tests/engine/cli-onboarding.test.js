import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import yaml from 'js-yaml';
import { runAgentCreate } from '../../cli/lib/agent-create.js';
import { generateEcosystem } from '../../cli/lib/generate-ecosystem.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function makeHome23Root() {
  const root = mkdtempSync(join(tmpdir(), 'home23-cli-onboarding-'));
  mkdirSync(join(root, 'config'), { recursive: true });
  mkdirSync(join(root, 'cli', 'templates'), { recursive: true });
  mkdirSync(join(root, 'starter-project'), { recursive: true });
  mkdirSync(join(root, 'claude-export'), { recursive: true });
  if (existsSync(join(process.cwd(), 'node_modules'))) {
    symlinkSync(join(process.cwd(), 'node_modules'), join(root, 'node_modules'), 'dir');
  }

  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.0.0' }, null, 2), 'utf8');
  writeFileSync(join(root, 'config', 'home.yaml'), yaml.dump({ home: { name: 'home23', version: '1.0.0' } }), 'utf8');
  writeFileSync(join(root, 'config', 'secrets.yaml'), yaml.dump({ providers: {}, cosmo23: { encryptionKey: 'test-key' } }), 'utf8');
  writeFileSync(join(root, 'cli', 'templates', 'MISSION.md'), '# Mission\n\n{{purpose}}\n', 'utf8');
  return root;
}

function promptFromAnswers(answers) {
  return {
    askWithDefault: async (_question, defaultValue = '') => {
      const answer = answers.shift() ?? '';
      return answer || defaultValue || '';
    },
    askSecret: async () => '',
    close: () => {},
  };
}

test('agent create records fresh onboarding purpose, imports, and primary agent', async () => {
  const root = makeHome23Root();
  const starter = join(root, 'starter-project');
  const claudeExport = join(root, 'claude-export');

  try {
    const answers = [
      'Ada',
      'JTR',
      'Prefers direct evidence before claims.\nWorks across active project folders.',
      'Help JTR turn fresh projects into durable working memory.',
      `${starter}, ${claudeExport}`,
      '',
      'America/New_York',
      'kimi-k2.6',
      'ollama-cloud',
    ];

    await runAgentCreate(root, 'ada', {
      prompt: promptFromAnswers(answers),
    });

    const homeConfig = yaml.load(readFileSync(join(root, 'config', 'home.yaml'), 'utf8'));
    assert.equal(homeConfig.home.primaryAgent, 'ada');

    const agentConfig = yaml.load(readFileSync(join(root, 'instances', 'ada', 'config.yaml'), 'utf8'));
    assert.equal(agentConfig.agent.purpose, 'Help JTR turn fresh projects into durable working memory.');
    assert.deepEqual(agentConfig.agent.owner.facts, ['Prefers direct evidence before claims.', 'Works across active project folders.']);
    assert.equal(agentConfig.ports.bridge, 5004);
    assert.equal(agentConfig.chat.defaultProvider, 'ollama-cloud');
    assert.equal(agentConfig.chat.defaultModel, 'kimi-k2.6');
    assert.equal(agentConfig.chat.memorySearch.enabled, true);

    const watchPaths = agentConfig.feeder.additionalWatchPaths.map((entry) => entry.path);
    assert.ok(watchPaths.includes(starter));
    assert.ok(watchPaths.includes(claudeExport));

    const mission = readFileSync(join(root, 'instances', 'ada', 'workspace', 'MISSION.md'), 'utf8');
    assert.match(mission, /fresh projects into durable working memory/);

    const projects = readFileSync(join(root, 'instances', 'ada', 'workspace', 'PROJECTS.md'), 'utf8');
    assert.match(projects, new RegExp(starter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(projects, new RegExp(claudeExport.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const personal = readFileSync(join(root, 'instances', 'ada', 'workspace', 'PERSONAL.md'), 'utf8');
    assert.match(personal, /Prefers direct evidence before claims\./);
    assert.match(personal, /Works across active project folders\./);

    assert.ok(existsSync(join(root, 'ecosystem.config.cjs')));
    assert.ok(existsSync(join(root, 'config', 'agents.json')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('agent create auto-heals an existing missing primary by port order', async () => {
  const root = makeHome23Root();
  mkdirSync(join(root, 'instances', 'later'), { recursive: true });
  mkdirSync(join(root, 'instances', 'first'), { recursive: true });
  writeFileSync(
    join(root, 'instances', 'later', 'config.yaml'),
    yaml.dump({ agent: { owner: { name: 'JTR' }, timezone: 'America/New_York' }, ports: { engine: 5011, dashboard: 5012 } }),
    'utf8'
  );
  writeFileSync(
    join(root, 'instances', 'first', 'config.yaml'),
    yaml.dump({ agent: { owner: { name: 'JTR' }, timezone: 'America/New_York' }, ports: { engine: 5001, dashboard: 5002 } }),
    'utf8'
  );

  try {
    await runAgentCreate(root, 'new-agent', {
      prompt: promptFromAnswers(['New Agent', 'JTR', '', 'Help with new work.', '', '', 'America/New_York', 'kimi-k2.6', 'ollama-cloud']),
    });

    const homeConfig = yaml.load(readFileSync(join(root, 'config', 'home.yaml'), 'utf8'));
    assert.equal(homeConfig.home.primaryAgent, 'first');

    const manifest = JSON.parse(readFileSync(join(root, 'config', 'agents.json'), 'utf8'));
    assert.equal(manifest.find((agent) => agent.name === 'first')?.isPrimary, true);
    assert.equal(manifest.find((agent) => agent.name === 'new-agent')?.isPrimary, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ecosystem generation uses configured embedding provider instead of hardcoded local Ollama', () => {
  const root = makeHome23Root();
  mkdirSync(join(root, 'instances', 'ada'), { recursive: true });
  writeFileSync(
    join(root, 'instances', 'ada', 'config.yaml'),
    yaml.dump({ agent: { owner: { name: 'JTR' }, timezone: 'America/New_York' }, ports: { engine: 5001, dashboard: 5002, mcp: 5003, bridge: 5004 } }),
    'utf8'
  );
  writeFileSync(
    join(root, 'config', 'home.yaml'),
    yaml.dump({
      home: { name: 'home23', version: '1.0.0' },
      providers: {
        openai: {},
        'ollama-local': { baseUrl: 'http://127.0.0.1:11434' },
      },
      embeddings: {
        providers: [
          { provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536 },
        ],
      },
    }),
    'utf8'
  );
  writeFileSync(
    join(root, 'config', 'secrets.yaml'),
    yaml.dump({ providers: { openai: { apiKey: 'sk-test-embedding' } }, cosmo23: { encryptionKey: 'test-key' } }),
    'utf8'
  );

  try {
    generateEcosystem(root);
    const ecosystemPath = join(root, 'ecosystem.config.cjs');
    delete require.cache[ecosystemPath];
    const ecosystem = require(ecosystemPath);
    const app = ecosystem.apps.find((entry) => entry.name === 'home23-ada');

    assert.equal(app.env.EMBEDDING_PROVIDER, 'openai');
    assert.equal(app.env.EMBEDDING_BASE_URL, 'https://api.openai.com/v1');
    assert.equal(app.env.EMBEDDING_API_KEY, 'sk-test-embedding');
    assert.equal(app.env.EMBEDDING_MODEL, 'text-embedding-3-small');
    assert.equal(app.env.EMBEDDING_DIMENSIONS, '1536');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
