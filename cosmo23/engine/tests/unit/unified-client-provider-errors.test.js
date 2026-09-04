const { expect } = require('chai');

const {
  UnifiedClient,
  XAI_SEARCH_FALLBACK_MODEL,
  isWebSearchRequest,
  resolveXaiSearchFallback
} = require('../../src/core/unified-client');

describe('UnifiedClient provider error notifications', () => {
  it('notifies static listeners about provider failures', () => {
    const events = [];
    const unsubscribe = UnifiedClient.onProviderError(event => events.push(event));

    try {
      const client = Object.create(UnifiedClient.prototype);
      client.logger = { info() {}, warn() {}, error() {}, debug() {} };
      client.emitProviderError({
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        error: new Error('429 rate_limit_error')
      });

      expect(events).to.have.length(1);
      expect(events[0].provider).to.equal('anthropic');
      expect(events[0].model).to.equal('claude-opus-4-8');
      expect(events[0].error.message).to.include('429');
    } finally {
      unsubscribe();
    }
  });

  it('constructs every Chat Completions backend with an exact fixed provider id', () => {
    const client = new UnifiedClient({
      providers: {
        local: { enabled: true },
        'ollama-cloud': { enabled: true, apiKey: 'test-cloud-key' }
      }
    }, { info() {}, warn() {}, error() {}, debug() {} });

    expect(client.localClient.config.providerId).to.equal('local');
    expect(client.ollamaCloudClient.config.providerId).to.equal('ollama-cloud');
  });
});

describe('xAI search fallback', () => {
  it('uses grok-4.6 and never claude-fable-5', () => {
    expect(XAI_SEARCH_FALLBACK_MODEL).to.equal('grok-4.6');
    expect(isWebSearchRequest({ tools: [{ type: 'web_search' }] })).to.equal(true);
    const fallback = resolveXaiSearchFallback({
      provider: 'xai',
      model: 'grok-4',
      fallback: { provider: 'anthropic', model: 'claude-fable-5' }
    });
    expect(fallback.provider).to.equal('xai');
    expect(fallback.model).to.equal('grok-4.6');
    expect(fallback.model).to.not.include('fable');
    expect(fallback.model).to.not.include('claude');
  });

  it('keeps an xAI fallback model when one is already configured', () => {
    const fallback = resolveXaiSearchFallback({
      provider: 'xai',
      model: 'grok-4',
      fallback: { provider: 'xai', model: 'grok-4.6' }
    });
    expect(fallback).to.deep.equal({ provider: 'xai', model: 'grok-4.6' });
  });

  it('generate() search fallback calls xAI grok-4.6, not Fable', async () => {
    const client = Object.create(UnifiedClient.prototype);
    client.logger = { info() {}, warn() {}, error() {}, debug() {} };
    client.config = {};
    client.xai = {};
    client.emitProviderError = () => {};
    client.getModelAssignment = () => ({
      provider: 'xai',
      model: 'grok-4',
      fallback: { provider: 'anthropic', model: 'claude-fable-5' }
    });
    const used = [];
    client.generateXAI = async (assignment) => {
      used.push(assignment);
      if (assignment.model === 'grok-4') {
        throw new Error('xAI primary search failed');
      }
      return { content: 'xai-search-ok', model: assignment.model };
    };
    client.generateAnthropic = async () => {
      throw new Error('claude-fable-5 must not be the xAI search fallback');
    };

    const result = await client.generate({
      component: 'agents',
      purpose: 'research',
      query: 'Jerry Garcia',
      tools: [{ type: 'web_search' }]
    }, 1);

    expect(result.content).to.equal('xai-search-ok');
    expect(used.map((row) => row.model)).to.deep.equal(['grok-4', 'grok-4.6']);
  });
});
