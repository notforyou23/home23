const test = require('node:test');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');

const { ConfigGenerator } = require('../../cosmo23/launcher/config-generator');

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
