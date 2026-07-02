const { expect } = require('chai');

const { UnifiedClient } = require('../../src/core/unified-client');

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
});
