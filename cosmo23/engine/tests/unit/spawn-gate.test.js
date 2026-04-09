const { expect } = require('chai');

const { SpawnGate } = require('../../src/core/spawn-gate');

describe('SpawnGate', () => {
  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {}
  };

  it('blocks duplicate research waves when memory and productive results both match', async () => {
    const gate = new SpawnGate(
      {
        memory: {
          query: async () => [{ similarity: 0.94, content: 'Investigate JGB Health expansion evidence gaps' }]
        },
        resultsQueue: {
          queue: [],
          processed: [],
          history: [
            {
              agentId: 'agent-prev',
              status: 'completed',
              mission: { description: 'Investigate JGB Health expansion evidence gaps' },
              handoffSpec: { reason: 'Investigate JGB Health expansion evidence gaps' },
              results: [{ type: 'finding', content: 'Expansion claims remain under-sourced.' }]
            }
          ]
        }
      },
      logger
    );

    const decision = await gate.evaluate({
      agentType: 'research',
      description: 'Investigate JGB Health expansion evidence gaps',
      metadata: {}
    });

    expect(decision.allowed).to.equal(false);
    expect(decision.reason).to.include('duplicate_work_detected');
    expect(decision.evidence.memoryMatches).to.have.length.greaterThan(0);
    expect(decision.evidence.resultMatches).to.have.length.greaterThan(0);
  });

  it('allows distinct work when neither memory nor result history overlaps', async () => {
    const gate = new SpawnGate(
      {
        memory: {
          query: async () => [{ similarity: 0.42, content: 'Unrelated topic' }]
        },
        resultsQueue: {
          queue: [],
          processed: [],
          history: [
            {
              agentId: 'agent-prev',
              status: 'completed',
              mission: { description: 'Analyze unrelated logistics data' },
              results: [{ type: 'finding', content: 'Some unrelated finding.' }]
            }
          ]
        }
      },
      logger
    );

    const decision = await gate.evaluate({
      agentType: 'research',
      description: 'Investigate new payer network evidence',
      metadata: {
        sourceScope: 'payer announcements'
      }
    });

    expect(decision.allowed).to.equal(true);
    expect(decision.reason).to.equal(null);
  });
});
