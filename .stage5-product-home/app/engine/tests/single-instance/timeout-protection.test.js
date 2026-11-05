/**
 * Single-Instance Integration Test: Timeout Protection
 * 
 * Tests timeout enforcement in actual COSMO orchestrator
 */

const { expect } = require('chai');
const { TimeoutManager } = require('../../src/core/timeout-manager');

describe('Single-Instance: Timeout Protection', () => {
  let manager;
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
      timeouts: {
        cycleTimeoutMs: 1000, // 1s for tests
        operationTimeoutMs: 500 // 0.5s for tests
      }
    };
    manager = new TimeoutManager(mockConfig, mockLogger);
  });

  afterEach(() => {
    manager.cleanup();
  });

  describe('Cycle Timeout Enforcement', () => {
    it('should enforce cycle timeout', (done) => {
      let timedOut = false;
      
      manager.startCycleTimer(1, 100, (cycle) => {
        timedOut = true;
        expect(cycle).to.equal(1);
        expect(manager.cycleTimeouts).to.equal(1);
        done();
      });
      
      // Don't cancel - let it timeout
    });

    it('should prevent timeout if cycle completes', (done) => {
      let timedOut = false;
      
      manager.startCycleTimer(1, 100, () => {
        timedOut = true;
      });
      
      // Cancel before timeout
      setTimeout(() => {
        manager.cancelCycleTimer();
      }, 50);
      
      // Verify didn't timeout
      setTimeout(() => {
        expect(timedOut).to.be.false;
        expect(manager.cycleTimeouts).to.equal(0);
        done();
      }, 150);
    });

    it('should track cycle timeout rate', (done) => {
      manager.startCycleTimer(1, 50);
      manager.cancelCycleTimer();
      
      manager.startCycleTimer(2, 50);
      // Let this one timeout
      
      setTimeout(() => {
        const stats = manager.getStats();
        expect(stats.totalCycles).to.equal(2);
        expect(stats.cycleTimeouts).to.equal(1);
        expect(stats.cycleTimeoutRate).to.equal('50.00%');
        done();
      }, 100);
    });
  });

  describe('Operation Timeout Protection', () => {
    it('should timeout slow operations', async () => {
      const slowOp = new Promise(resolve => setTimeout(() => resolve('too slow'), 200));
      
      try {
        await manager.wrapWithTimeout(slowOp, 50);
        expect.fail('Should have timed out');
      } catch (error) {
        expect(error.code).to.equal('OPERATION_TIMEOUT');
        expect(error.operationId).to.be.a('string');
        expect(manager.operationTimeouts).to.equal(1);
      }
    });

    it('should not timeout fast operations', async () => {
      const fastOp = new Promise(resolve => setTimeout(() => resolve('done'), 10));
      
      const result = await manager.wrapWithTimeout(fastOp, 100);
      expect(result).to.equal('done');
      expect(manager.operationTimeouts).to.equal(0);
    });

    it('should track operation timeout rate', async () => {
      // Fast operation (completes)
      const fast = Promise.resolve('done');
      await manager.wrapWithTimeout(fast, 1000);
      
      // Slow operation (timeouts)
      const slow = new Promise(resolve => setTimeout(resolve, 200));
      try {
        await manager.wrapWithTimeout(slow, 50);
      } catch (error) {
        // Expected timeout
      }
      
      const stats = manager.getStats();
      expect(stats.totalOperations).to.equal(2);
      expect(stats.operationTimeouts).to.equal(1);
      expect(stats.operationTimeoutRate).to.equal('50.00%');
    });
  });

  describe('No Hanging Operations', () => {
    it('should cleanup all active timeouts on shutdown', (done) => {
      const p1 = new Promise(resolve => setTimeout(resolve, 5000));
      const p2 = new Promise(resolve => setTimeout(resolve, 5000));
      
      manager.wrapWithTimeout(p1, 5000).catch(() => {});
      manager.wrapWithTimeout(p2, 5000).catch(() => {});
      
      setTimeout(() => {
        expect(manager.getActiveOperationCount()).to.equal(2);
        
        manager.cleanup();
        
        expect(manager.getActiveOperationCount()).to.equal(0);
        expect(manager.isCycleActive()).to.be.false;
        done();
      }, 50);
    });
  });

  describe('Timeout Metrics', () => {
    it('should provide comprehensive timeout stats', () => {
      manager.startCycleTimer(1, 1000);
      manager.cancelCycleTimer();
      
      const stats = manager.getStats();
      
      expect(stats).to.have.property('cycleTimeouts');
      expect(stats).to.have.property('operationTimeouts');
      expect(stats).to.have.property('totalCycles');
      expect(stats).to.have.property('totalOperations');
      expect(stats).to.have.property('cycleTimeoutRate');
      expect(stats).to.have.property('operationTimeoutRate');
      expect(stats).to.have.property('activeOperations');
    });

    it('should provide baseline metrics', () => {
      const baseline = manager.getBaselineMetrics();
      
      expect(baseline).to.have.property('cycleTimeouts');
      expect(baseline).to.have.property('operationTimeouts');
      expect(baseline).to.have.property('cycleTimeoutRate');
      expect(baseline).to.have.property('operationTimeoutRate');
    });
  });
});

