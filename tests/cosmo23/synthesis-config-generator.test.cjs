const test = require('node:test');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');

const { ConfigGenerator } = require('../../cosmo23/launcher/config-generator');

function withEnv(overrides, fn) {
  const previous = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

test('launcher config emits synthesis commit-step defaults', async () => {
  const generator = new ConfigGenerator(process.cwd(), console);
  const configYaml = await generator.generateConfig({
    domain: 'test run',
    primary_provider: 'openai',
    primary_model: 'gpt-5.5',
    fast_provider: 'openai',
    fast_model: 'gpt-5-mini',
    strategic_provider: 'anthropic',
    strategic_model: 'claude-opus-4-7'
  });

  const parsed = yaml.load(configYaml);
  assert.deepEqual(parsed.synthesis, {
    commitStep: true,
    spineCap: 5,
    bucketNames: {
      spine: 'SPINE',
      facet: 'FACET',
      artifact: 'ARTIFACT'
    },
    modeOverrides: {
      dive: true,
      pgs: true,
      compile: true,
      explore: false
    }
  });
  assert.deepEqual(parsed.commitmentGovernor, {
    enabled: true,
    preserveDifferentiatedRoles: true,
    requireCommittedArtifacts: true,
    rateLimitWindowCycles: 8,
    rateLimitThreshold: 3,
    rateLimitCooldownCycles: 5,
    maxStrategicSpawnsPerCycle: 1,
    maxUrgentSpawnsPerCycle: 1
  });
});

test('launcher config honors commit-step launch overrides', async () => {
  const generator = new ConfigGenerator(process.cwd(), console);
  const configYaml = await generator.generateConfig({
    domain: 'test run',
    synthesis_commit_step: false,
    synthesis_spine_cap: 8,
    primary_provider: 'openai',
    primary_model: 'gpt-5.5',
    fast_provider: 'openai',
    fast_model: 'gpt-5-mini',
    strategic_provider: 'anthropic',
    strategic_model: 'claude-opus-4-7'
  });

  const parsed = yaml.load(configYaml);
  assert.equal(parsed.synthesis.commitStep, false);
  assert.equal(parsed.synthesis.spineCap, 8);
});

test('launcher config prefers COSMO23 ports over inherited Home23 agent ports', async () => {
  await withEnv({
    COSMO23_DASHBOARD_PORT: '43244',
    COSMO23_MCP_HTTP_PORT: '43247',
    DASHBOARD_PORT: '5002',
    COSMO_DASHBOARD_PORT: '5002',
    MCP_HTTP_PORT: '5003',
    MCP_PORT: '5003'
  }, async () => {
    const generator = new ConfigGenerator(process.cwd(), console);
    const configYaml = await generator.generateConfig({
      domain: 'test run',
      primary_provider: 'anthropic',
      primary_model: 'claude-sonnet-4-7',
      fast_provider: 'anthropic',
      fast_model: 'claude-sonnet-4-7',
      strategic_provider: 'anthropic',
      strategic_model: 'claude-opus-4-7'
    });

    const parsed = yaml.load(configYaml);
    assert.equal(parsed.dashboard.port, 43244);
    assert.equal(parsed.mcp.server.port, 43247);
    assert.equal(parsed.mcp.client.servers[0].url, 'http://localhost:43247/mcp');
  });
});
