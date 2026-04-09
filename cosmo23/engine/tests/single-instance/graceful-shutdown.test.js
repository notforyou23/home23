/**
 * Single-Instance Integration Test: Graceful Shutdown
 * 
 * Tests graceful shutdown handling in actual COSMO orchestrator
 */

const { expect } = require('chai');
const { GracefulShutdownHandler } = require('../../src/core/graceful-shutdown-handler');

describe('Single-Instance: Graceful Shutdown', () => {
  let handler;
  let mockOrchestrator;
  let mockLogger;
  let mockConfig;

  beforeEach(() => {
    mockLogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {}
    };
    mockConfig = {
      shutdownTimeoutMs: 5000
    };
    
    // Mock orchestrator
    mockOrchestrator = {
      running: true,
      stop: async () => {
        mockOrchestrator.running = false;
      },
      saveState: async () => {},
      crashRecovery: {
        markCleanShutdown: async () => {}
      },
      timeoutManager: {
        cleanup: () => {}
      },
      resourceMonitor: {},
      agentExecutor: {
        registry: {
          getActiveCount: () => 0
        }
      }
    };
    
    handler = new GracefulShutdownHandler(mockOrchestrator, mockLogger, mockConfig);
  });

  afterEach(() => {
    // Cleanup any registered signal handlers
    for (const [signal, h] of handler.signalHandlers.entries()) {
      process.removeListener(signal, h);
    }
    handler.signalHandlers.clear();
  });

  describe('Signal Handler Registration', () => {
    it('should register signal handlers', () => {
      handler.registerHandlers();
      
      expect(handler.signalHandlers.size).to.equal(3);
      expect(handler.signalHandlers.has('SIGINT')).to.be.true;
      expect(handler.signalHandlers.has('SIGTERM')).to.be.true;
      expect(handler.signalHandlers.has('SIGHUP')).to.be.true;
    });

    it('should create handlers for all registered signals', () => {
      handler.registerHandlers();
      
      for (const signal of handler.registeredSignals) {
        const h = handler.signalHandlers.get(signal);
        expect(h).to.be.a('function');
      }
    });
  });

  describe('Idempotent Shutdown', () => {
    it('should be safe to call shutdown twice', async () => {
      // First shutdown
      const p1 = handler.shutdown('test');
      
      // Second shutdown (should be ignored)
      const p2 = handler.shutdown('test');
      
      // Both should complete without error
      await Promise.all([p1, p2]);
      
      expect(handler.shutdownComplete).to.be.true;
    });

    it('should ignore shutdown if already in progress', async () => {
      handler.isShuttingDown = true;
      
      // Should return immediately
      await handler.shutdown('test');
      
      // Should not have set shutdownComplete
      expect(handler.shutdownComplete).to.be.false;
    });
  });

  describe('Cleanup Tasks', () => {
    it('should register custom cleanup tasks', () => {
      const task1 = async () => {};
      const task2 = async () => {};
      
      handler.registerCleanupTask('task1', task1);
      handler.registerCleanupTask('task2', task2);
      
      expect(handler.cleanupTasks).to.have.lengthOf(2);
    });

    it('should execute cleanup tasks on shutdown', async () => {
      let task1Executed = false;
      let task2Executed = false;
      
      handler.registerCleanupTask('task1', async () => {
        task1Executed = true;
      });
      handler.registerCleanupTask('task2', async () => {
        task2Executed = true;
      });
      
      await handler.runCleanupTasks();
      
      expect(task1Executed).to.be.true;
      expect(task2Executed).to.be.true;
    });

    it('should continue cleanup even if task fails', async () => {
      let task2Executed = false;
      
      handler.registerCleanupTask('failing_task', async () => {
        throw new Error('Task failed');
      });
      handler.registerCleanupTask('task2', async () => {
        task2Executed = true;
      });
      
      await handler.runCleanupTasks();
      
      // task2 should still execute despite task1 failure
      expect(task2Executed).to.be.true;
    });
  });

  describe('State Dump', () => {
    it('should dump state before shutdown', async () => {
      let stateSaved = false;
      mockOrchestrator.saveState = async () => {
        stateSaved = true;
      };
      
      await handler.dumpState();
      
      expect(stateSaved).to.be.true;
    });

    it('should throw error if state dump fails', async () => {
      mockOrchestrator.saveState = async () => {
        throw new Error('Failed to save');
      };
      
      try {
        await handler.dumpState();
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error.message).to.equal('Failed to save');
      }
    });
  });

  describe('Resource Cleanup', () => {
    it('should cleanup timeout manager', async () => {
      let cleanupCalled = false;
      mockOrchestrator.timeoutManager.cleanup = () => {
        cleanupCalled = true;
      };
      
      await handler.cleanup();
      
      expect(cleanupCalled).to.be.true;
    });

    it('should wait for agents to complete', async () => {
      let agentWaitCalled = false;
      mockOrchestrator.agentExecutor = {
        registry: {
          getActiveCount: () => {
            if (!agentWaitCalled) {
              agentWaitCalled = true;
              return 1; // First call: 1 active agent
            }
            return 0; // Second call: no agents
          }
        }
      };
      
      await handler.cleanup();
      
      expect(agentWaitCalled).to.be.true;
    });

    it('should unregister signal handlers', async () => {
      handler.registerHandlers();
      expect(handler.signalHandlers.size).to.equal(3);
      
      await handler.cleanup();
      
      expect(handler.signalHandlers.size).to.equal(0);
    });
  });

  describe('Shutdown Stats', () => {
    it('should provide shutdown stats', () => {
      const stats = handler.getStats();
      
      expect(stats).to.have.property('isShuttingDown');
      expect(stats).to.have.property('shutdownComplete');
      expect(stats).to.have.property('registeredSignals');
      expect(stats).to.have.property('cleanupTasks');
    });
  });
});

