/**
 * Unit tests for GracefulShutdownHandler
 */

const { expect } = require('chai');
const { GracefulShutdownHandler } = require('../../src/core/graceful-shutdown-handler');

describe('GracefulShutdownHandler', () => {
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
      shutdownTimeoutMs: 1000
    };
    
    mockOrchestrator = {
      running: true,
      stop: async () => {},
      saveState: async () => {},
      crashRecovery: {
        markCleanShutdown: async () => {}
      },
      timeoutManager: {
        cleanup: () => {}
      }
    };
    
    handler = new GracefulShutdownHandler(mockOrchestrator, mockLogger, mockConfig);
  });

  afterEach(() => {
    // Cleanup signal handlers
    for (const [signal, h] of handler.signalHandlers.entries()) {
      process.removeListener(signal, h);
    }
    handler.signalHandlers.clear();
  });

  describe('registerHandlers', () => {
    it('should register all signal handlers', () => {
      handler.registerHandlers();
      
      expect(handler.signalHandlers.size).to.equal(3);
      expect(handler.signalHandlers.has('SIGINT')).to.be.true;
      expect(handler.signalHandlers.has('SIGTERM')).to.be.true;
      expect(handler.signalHandlers.has('SIGHUP')).to.be.true;
    });

    it('should create handlers as functions', () => {
      handler.registerHandlers();
      
      for (const [signal, h] of handler.signalHandlers.entries()) {
        expect(h).to.be.a('function');
      }
    });
  });

  describe('registerCleanupTask', () => {
    it('should register cleanup tasks', () => {
      const task = async () => {};
      handler.registerCleanupTask('test_task', task);
      
      expect(handler.cleanupTasks).to.have.lengthOf(1);
      expect(handler.cleanupTasks[0].name).to.equal('test_task');
    });

    it('should register multiple tasks', () => {
      handler.registerCleanupTask('task1', async () => {});
      handler.registerCleanupTask('task2', async () => {});
      handler.registerCleanupTask('task3', async () => {});
      
      expect(handler.cleanupTasks).to.have.lengthOf(3);
    });
  });

  describe('runCleanupTasks', () => {
    it('should execute all cleanup tasks', async () => {
      let task1Run = false;
      let task2Run = false;
      
      handler.registerCleanupTask('task1', async () => { task1Run = true; });
      handler.registerCleanupTask('task2', async () => { task2Run = true; });
      
      await handler.runCleanupTasks();
      
      expect(task1Run).to.be.true;
      expect(task2Run).to.be.true;
    });

    it('should continue on task failure', async () => {
      let task2Run = false;
      
      handler.registerCleanupTask('failing', async () => {
        throw new Error('Task error');
      });
      handler.registerCleanupTask('task2', async () => { task2Run = true; });
      
      await handler.runCleanupTasks();
      
      expect(task2Run).to.be.true;
    });
  });

  describe('dumpState', () => {
    it('should call orchestrator saveState', async () => {
      let stateSaved = false;
      mockOrchestrator.saveState = async () => { stateSaved = true; };
      
      const result = await handler.dumpState();
      
      expect(stateSaved).to.be.true;
      expect(result.saved).to.be.true;
    });

    it('should return refused save result without throwing', async () => {
      mockOrchestrator.saveState = async () => ({
        saved: false,
        reason: 'catastrophic_node_loss',
        currentNodes: 12,
        existingNodes: 125,
        source: 'memory-sidecar',
        cycle: 77
      });

      const result = await handler.dumpState();

      expect(result.saved).to.be.false;
      expect(result.reason).to.equal('catastrophic_node_loss');
    });

    it('should throw if saveState fails', async () => {
      mockOrchestrator.saveState = async () => {
        throw new Error('Save failed');
      };
      
      try {
        await handler.dumpState();
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error.message).to.equal('Save failed');
      }
    });
  });

  describe('cleanup', () => {
    it('should cleanup timeout manager', async () => {
      let cleanupCalled = false;
      mockOrchestrator.timeoutManager = {
        cleanup: () => { cleanupCalled = true; }
      };
      
      await handler.cleanup();
      
      expect(cleanupCalled).to.be.true;
    });

    it('should unregister all signal handlers', async () => {
      handler.registerHandlers();
      expect(handler.signalHandlers.size).to.equal(3);
      
      await handler.cleanup();
      
      expect(handler.signalHandlers.size).to.equal(0);
    });
  });

  describe('getStats', () => {
    it('should return shutdown stats', () => {
      handler.registerCleanupTask('task1', async () => {});
      handler.registerCleanupTask('task2', async () => {});
      
      const stats = handler.getStats();
      
      expect(stats).to.have.property('isShuttingDown', false);
      expect(stats).to.have.property('shutdownComplete', false);
      expect(stats).to.have.property('registeredSignals');
      expect(stats.registeredSignals).to.deep.equal(['SIGINT', 'SIGTERM', 'SIGHUP']);
      expect(stats).to.have.property('cleanupTasks', 2);
    });
  });

  describe('Idempotent Shutdown', () => {
    it('should handle multiple shutdown calls', async () => {
      handler.shutdownComplete = true;
      
      // Should return immediately
      await handler.shutdown('test');
      
      // No errors should occur
      expect(handler.shutdownComplete).to.be.true;
    });

    it('should not mark clean shutdown when final save is refused', async () => {
      const originalExit = process.exit;
      let exitCode = null;
      let markedClean = false;

      process.exit = (code) => {
        exitCode = code;
      };
      mockOrchestrator.saveState = async () => ({
        saved: false,
        reason: 'catastrophic_node_loss',
        currentNodes: 12,
        existingNodes: 125,
        source: 'memory-sidecar',
        cycle: 77
      });
      mockOrchestrator.crashRecovery.markCleanShutdown = async () => {
        markedClean = true;
      };

      try {
        await handler.shutdown('test');
      } finally {
        process.exit = originalExit;
      }

      expect(exitCode).to.equal(0);
      expect(markedClean).to.be.false;
      expect(handler.shutdownComplete).to.be.true;
    });
  });
});
