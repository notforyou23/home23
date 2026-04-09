const { expect } = require('chai');

const { GuidedModePlanner } = require('../../src/core/guided-mode-planner');

function createPlanner(overrides = {}) {
  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {}
  };

  const config = {
    logsDir: '/tmp/cosmo-context-detection-test',
    architecture: {
      roleSystem: {
        explorationMode: 'guided',
        guidedFocus: {
          domain: 'Test Domain',
          context: 'Test context',
          executionMode: 'mixed',
          depth: 'deep'
        }
      }
    },
    coordinator: {
      agentTypeWeights: { research: 1, ide: 1 }
    },
    ideFirst: { enabled: true },
    models: { fast: 'test-fast-model' },
    mcp: { client: { enabled: false, servers: [] } },
    ...overrides.config
  };

  const subsystems = {
    client: {
      generate: async () => ({ content: '{"strategy":"plan","agentMissions":[],"initialGoals":[]}' })
    },
    memory: {
      query: async () => [],
      nodes: new Map()
    },
    goals: {
      getGoals: () => []
    },
    clusterStateStore: {
      getPlan: async () => null,
      listTasks: async () => [],
      listMilestones: async () => []
    },
    agentExecutor: {
      registry: { getActiveCount: () => 0 },
      resultsQueue: { queue: [], history: [], processed: [] }
    },
    ...overrides.subsystems
  };

  return new GuidedModePlanner(config, subsystems, logger);
}

describe('GuidedModePlanner — Semantic Context Change Detection', () => {

  describe('_isContextDirectionChanged()', () => {

    it('returns false for identical strings (fast path, no LLM call)', async () => {
      let llmCalled = false;
      const planner = createPlanner({
        subsystems: {
          client: {
            generate: async () => {
              llmCalled = true;
              return { content: 'different' };
            }
          }
        }
      });

      const result = await planner._isContextDirectionChanged(
        'Investigate market trends in healthcare',
        'Investigate market trends in healthcare',
        'Healthcare'
      );

      expect(result).to.equal(false);
      expect(llmCalled).to.equal(false);
    });

    it('returns true when old context is empty (fast path)', async () => {
      let llmCalled = false;
      const planner = createPlanner({
        subsystems: {
          client: {
            generate: async () => {
              llmCalled = true;
              return { content: 'same' };
            }
          }
        }
      });

      const result = await planner._isContextDirectionChanged(
        '',
        'Investigate market trends in healthcare',
        'Healthcare'
      );

      expect(result).to.equal(true);
      expect(llmCalled).to.equal(false);
    });

    it('returns true when new context is empty (fast path)', async () => {
      let llmCalled = false;
      const planner = createPlanner({
        subsystems: {
          client: {
            generate: async () => {
              llmCalled = true;
              return { content: 'same' };
            }
          }
        }
      });

      const result = await planner._isContextDirectionChanged(
        'Investigate market trends in healthcare',
        '',
        'Healthcare'
      );

      expect(result).to.equal(true);
      expect(llmCalled).to.equal(false);
    });

    it('returns false when LLM says "same"', async () => {
      const planner = createPlanner({
        subsystems: {
          client: {
            generate: async () => ({ content: 'same' })
          }
        }
      });

      const result = await planner._isContextDirectionChanged(
        'Investigate market trends in healthcare',
        'Look into healthcare market trends',
        'Healthcare'
      );

      expect(result).to.equal(false);
    });

    it('returns true when LLM says "different"', async () => {
      const planner = createPlanner({
        subsystems: {
          client: {
            generate: async () => ({ content: 'different' })
          }
        }
      });

      const result = await planner._isContextDirectionChanged(
        'Investigate market trends in healthcare',
        'Build a mobile app for patient scheduling',
        'Healthcare'
      );

      expect(result).to.equal(true);
    });

    it('returns true when LLM says "Different" (case-insensitive)', async () => {
      const planner = createPlanner({
        subsystems: {
          client: {
            generate: async () => ({ content: 'Different' })
          }
        }
      });

      const result = await planner._isContextDirectionChanged(
        'Investigate market trends',
        'Build a new product',
        'Business'
      );

      expect(result).to.equal(true);
    });

    it('falls back to exact comparison (returns true) when LLM throws', async () => {
      let warnCalled = false;
      const planner = createPlanner({
        subsystems: {
          client: {
            generate: async () => { throw new Error('API timeout'); }
          }
        }
      });
      planner.logger = {
        info: () => {},
        debug: () => {},
        error: () => {},
        warn: (msg) => { warnCalled = true; }
      };

      const result = await planner._isContextDirectionChanged(
        'Investigate market trends in healthcare',
        'Look into healthcare market trends',
        'Healthcare'
      );

      // Strings differ, so fallback exact comparison returns true
      expect(result).to.equal(true);
      expect(warnCalled).to.equal(true);
    });

    it('passes correct parameters to client.generate', async () => {
      let capturedArgs = null;
      const planner = createPlanner({
        subsystems: {
          client: {
            generate: async (args) => {
              capturedArgs = args;
              return { content: 'same' };
            }
          }
        }
      });

      await planner._isContextDirectionChanged(
        'Old context here',
        'New context here',
        'TestDomain'
      );

      expect(capturedArgs).to.not.be.null;
      expect(capturedArgs.component).to.equal('planner');
      expect(capturedArgs.purpose).to.equal('context_comparison');
      expect(capturedArgs.model).to.equal('test-fast-model');
      expect(capturedArgs.maxTokens).to.equal(10);
      expect(capturedArgs.reasoningEffort).to.equal('low');
      expect(capturedArgs.messages).to.have.length(1);
      expect(capturedArgs.messages[0].role).to.equal('user');
      expect(capturedArgs.messages[0].content).to.include('Old context here');
      expect(capturedArgs.messages[0].content).to.include('New context here');
      expect(capturedArgs.messages[0].content).to.include('TestDomain');
    });
  });

  describe('Full detection block behavior', () => {

    it('domain change always triggers contextRedirect regardless of context', async () => {
      const logMessages = [];
      const planner = createPlanner({
        subsystems: {
          client: {
            generate: async () => ({ content: 'same' })
          }
        }
      });
      planner.logger = {
        info: (msg, meta) => { logMessages.push({ msg, meta }); },
        warn: () => {},
        error: () => {},
        debug: () => {}
      };

      // Simulate the detection block logic directly
      const guidedFocus = { context: 'Same context', domain: 'New Domain' };
      const existingPlan = {
        _sourceContext: 'Same context',
        _sourceDomain: 'Old Domain'
      };

      const currentContext = (guidedFocus.context || '').trim();
      const planContext = (existingPlan._sourceContext || '').trim();
      const currentDomain = (guidedFocus.domain || '').trim();
      const planDomain = (existingPlan._sourceDomain || '').trim();

      const domainChanged = currentDomain.toLowerCase() !== planDomain.toLowerCase();

      let contextChanged = false;
      if (!domainChanged && currentContext !== planContext) {
        contextChanged = await planner._isContextDirectionChanged(planContext, currentContext, currentDomain);
      }

      const contextRedirect = domainChanged || contextChanged;

      expect(domainChanged).to.equal(true);
      expect(contextRedirect).to.equal(true);
    });

    it('same domain + semantically same context does NOT trigger replan', async () => {
      const planner = createPlanner({
        subsystems: {
          client: {
            generate: async () => ({ content: 'same' })
          }
        }
      });

      const guidedFocus = { context: 'Investigate market trends', domain: 'Healthcare' };
      const existingPlan = {
        _sourceContext: 'Look into market trends',
        _sourceDomain: 'Healthcare'
      };

      const currentContext = (guidedFocus.context || '').trim();
      const planContext = (existingPlan._sourceContext || '').trim();
      const currentDomain = (guidedFocus.domain || '').trim();
      const planDomain = (existingPlan._sourceDomain || '').trim();

      const domainChanged = currentDomain.toLowerCase() !== planDomain.toLowerCase();

      let contextChanged = false;
      if (!domainChanged && currentContext !== planContext) {
        contextChanged = await planner._isContextDirectionChanged(planContext, currentContext, currentDomain);
      }

      const contextRedirect = domainChanged || contextChanged;

      expect(domainChanged).to.equal(false);
      expect(contextChanged).to.equal(false);
      expect(contextRedirect).to.equal(false);
    });

    it('same domain + semantically different context triggers replan', async () => {
      const planner = createPlanner({
        subsystems: {
          client: {
            generate: async () => ({ content: 'different' })
          }
        }
      });

      const guidedFocus = { context: 'Build a mobile app', domain: 'Healthcare' };
      const existingPlan = {
        _sourceContext: 'Investigate market trends',
        _sourceDomain: 'Healthcare'
      };

      const currentContext = (guidedFocus.context || '').trim();
      const planContext = (existingPlan._sourceContext || '').trim();
      const currentDomain = (guidedFocus.domain || '').trim();
      const planDomain = (existingPlan._sourceDomain || '').trim();

      const domainChanged = currentDomain.toLowerCase() !== planDomain.toLowerCase();

      let contextChanged = false;
      if (!domainChanged && currentContext !== planContext) {
        contextChanged = await planner._isContextDirectionChanged(planContext, currentContext, currentDomain);
      }

      const contextRedirect = domainChanged || contextChanged;

      expect(domainChanged).to.equal(false);
      expect(contextChanged).to.equal(true);
      expect(contextRedirect).to.equal(true);
    });

    it('domain comparison is case-insensitive', async () => {
      const planner = createPlanner({
        subsystems: {
          client: {
            generate: async () => ({ content: 'same' })
          }
        }
      });

      const currentDomain = 'Healthcare';
      const planDomain = 'healthcare';

      const domainChanged = currentDomain.toLowerCase() !== planDomain.toLowerCase();

      expect(domainChanged).to.equal(false);
    });

    it('skips semantic check when domain already changed', async () => {
      let llmCalled = false;
      const planner = createPlanner({
        subsystems: {
          client: {
            generate: async () => {
              llmCalled = true;
              return { content: 'different' };
            }
          }
        }
      });

      const currentDomain = 'Finance';
      const planDomain = 'Healthcare';
      const currentContext = 'Different context text';
      const planContext = 'Original context text';

      const domainChanged = currentDomain.toLowerCase() !== planDomain.toLowerCase();

      let contextChanged = false;
      if (!domainChanged && currentContext !== planContext) {
        contextChanged = await planner._isContextDirectionChanged(planContext, currentContext, currentDomain);
      }

      expect(domainChanged).to.equal(true);
      expect(llmCalled).to.equal(false);
    });

    it('identical context strings skip LLM check even with same domain', async () => {
      let llmCalled = false;
      const planner = createPlanner({
        subsystems: {
          client: {
            generate: async () => {
              llmCalled = true;
              return { content: 'different' };
            }
          }
        }
      });

      const currentDomain = 'Healthcare';
      const planDomain = 'Healthcare';
      const currentContext = 'Same context text';
      const planContext = 'Same context text';

      const domainChanged = currentDomain.toLowerCase() !== planDomain.toLowerCase();

      let contextChanged = false;
      if (!domainChanged && currentContext !== planContext) {
        contextChanged = await planner._isContextDirectionChanged(planContext, currentContext, currentDomain);
      }

      expect(domainChanged).to.equal(false);
      // The outer `currentContext !== planContext` guard prevents the call
      expect(llmCalled).to.equal(false);
      expect(contextChanged).to.equal(false);
    });
  });
});
