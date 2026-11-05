const assert = require('node:assert/strict');
const test = require('node:test');

const { ProviderRegistry } = require('../../evobrew/server/providers/registry.js');

test('listModels can be constrained to the Home23 allowed model catalog', () => {
  const registry = new ProviderRegistry();

  registry.registerModel('claude-sonnet-4-6', 'anthropic');
  registry.registerModel('claude-sonnet-4-7', 'anthropic');
  registry.registerModel('gpt-4o', 'openai');
  registry.registerModel('gpt-5.5', 'openai');
  registry.registerModel('grok-3', 'xai');
  registry.registerModel('grok-4.5', 'xai');
  registry.registerModel('grok-4.3', 'xai');

  const models = registry.listModels({
    includeAliases: false,
    allowedModels: {
      anthropic: ['claude-sonnet-4-7'],
      openai: ['gpt-5.5'],
      xai: ['grok-4.5', 'grok-4.3']
    }
  });
  const values = models.map((model) => model.value);

  assert.deepEqual(new Set(values), new Set([
    'anthropic/claude-sonnet-4-7',
    'openai/gpt-5.5',
    'xai/grok-4.5',
    'xai/grok-4.3'
  ]));
  assert.equal(values.includes('anthropic/claude-sonnet-4-6'), false);
  assert.equal(values.includes('openai/gpt-4o'), false);
  assert.equal(values.includes('xai/grok-3'), false);
});
