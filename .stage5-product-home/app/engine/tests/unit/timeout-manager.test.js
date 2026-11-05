/**
 * Unit tests for TimeoutManager
 */

const { expect } = require('chai');
const { TimeoutManager } = require('../../src/core/timeout-manager');

describe('TimeoutManager', () => {
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
        cycleTimeoutMs: 5000,
        operationTimeoutMs: 1000
      }
    };
    manager = new TimeoutManager(mockConfig, mockLogger);
  });

  afterEach(() => {
    manager.cleanup();
  });

  describe('startCycleTimer', () => {
    it('should start cycle timeout timer', (done) => {
      const result = manager.startCycleTimer(1, 100, (cycle) => {
        expect(cycle).to.equal(1);
        done();
      });
      
      expect(result).to.have.property('cycle', 1);
      expect(result).to.have.property('timeoutMs', 100);
      expect(result).to.have.property('startTime');
    });

    it('should track total cycles', () => {
      manager.startCycleTimer(1);
      manager.cancelCycleTimer();
      
      expect(manager.totalCycles).to.equal(1);
    });

    it('should cancel previous timer when starting new one', (done) => {
      let firstFired = false;
      
      manager.startCycleTimer(1, 50, () => {
        firstFired = true;
      });
      
      // Immediately start another
      manager.startCycleTimer(2, 100, () => {
        expect(firstFired).to.be.false;
        done();
      });
    });
  });

  describe('cancelCycleTimer', () => {
    it('should cancel active timer', (done) => {
      let timedOut = false;
      
      manager.startCycleTimer(1, 50, () => {
        timedOut = true;
      });
      
      manager.cancelCycleTimer();
      
      setTimeout(() => {
        expect(timedOut).to.be.false;
        done();
      }, 100);
    });

    it('should be safe to call when no timer active', () => {
      expect(() => manager.cancelCycleTimer()).to.not.throw();
    });
  });

  describe('wrapWithTimeout', () => {
    it('should resolve if promise completes before timeout', async () => {
      const promise = new Promise(resolve => setTimeout(() => resolve('success'), 10));
      const result = await manager.wrapWithTimeout(promise, 100);
      expect(result).to.equal('success');
    });

    it('should reject if promise exceeds timeout', async () => {
      const promise = new Promise(resolve => setTimeout(() => resolve('late'), 200));
      
      try {
        await manager.wrapWithTimeout(promise, 50);
        expect.fail('Should have timed out');
      } catch (error) {
        expect(error.code).to.equal('OPERATION_TIMEOUT');
        expect(error.message).to.match(/timeout/i);
      }
    });

    it('should reject if promise rejects', async () => {
      const promise = Promise.reject(new Error('test error'));
      
      try {
        await manager.wrapWithTimeout(promise, 1000);
        expect.fail('Should have rejected');
      } catch (error) {
        expect(error.message).to.equal('test error');
      }
    });

    it('should track operation timeouts', async () => {
      const promise = new Promise(resolve => setTimeout(() => resolve(), 200));
      
      try {
        await manager.wrapWithTimeout(promise, 50);
      } catch (error) {
        // Expected timeout
      }
      
      expect(manager.operationTimeouts).to.be.above(0);
    });

    it('should track total operations', async () => {
      const promise = Promise.resolve('done');
      await manager.wrapWithTimeout(promise, 1000);
      
      expect(manager.totalOperations).to.equal(1);
    });
  });

  describe('cancelAllOperationTimeouts', () => {
    it('should cancel all active operation timeouts', (done) => {
      const p1 = new Promise(resolve => setTimeout(() => resolve(), 200));
      const p2 = new Promise(resolve => setTimeout(() => resolve(), 200));
      
      manager.wrapWithTimeout(p1, 150).catch(() => {});
      manager.wrapWithTimeout(p2, 150).catch(() => {});
      
      setTimeout(() => {
        expect(manager.getActiveOperationCount()).to.be.above(0);
        manager.cancelAllOperationTimeouts();
        expect(manager.getActiveOperationCount()).to.equal(0);
        done();
      }, 50);
    });
  });

  describe('isCycleActive', () => {
    it('should return true when cycle timer active', () => {
      manager.startCycleTimer(1, 1000);
      expect(manager.isCycleActive()).to.be.true;
    });

    it('should return false when no cycle timer', () => {
      expect(manager.isCycleActive()).to.be.false;
    });
  });

  describe('getStats', () => {
    it('should return comprehensive stats', () => {
      manager.startCycleTimer(1, 1000);
      
      const stats = manager.getStats();
      
      expect(stats).to.have.property('cycleTimeouts');
      expect(stats).to.have.property('totalCycles');
      expect(stats).to.have.property('totalOperations');
      expect(stats).to.have.property('cycleTimeoutRate');
      expect(stats).to.have.property('operationTimeoutRate');
      expect(stats).to.have.property('currentCycle');
      expect(stats).to.have.property('activeOperations');
    });
  });

  describe('getBaselineMetrics', () => {
    it('should return baseline-compatible metrics', () => {
      const baseline = manager.getBaselineMetrics();
      
      expect(baseline).to.have.property('cycleTimeouts');
      expect(baseline).to.have.property('operationTimeouts');
      expect(baseline).to.have.property('totalCycles');
      expect(baseline).to.have.property('totalOperations');
      expect(baseline).to.have.property('cycleTimeoutRate');
      expect(baseline).to.have.property('operationTimeoutRate');
    });
  });

  describe('cleanup', () => {
    it('should cleanup all timers', () => {
      manager.startCycleTimer(1, 5000);
      const p = new Promise(resolve => setTimeout(resolve, 5000));
      manager.wrapWithTimeout(p, 5000).catch(() => {});
      
      manager.cleanup();
      
      expect(manager.isCycleActive()).to.be.false;
      expect(manager.getActiveOperationCount()).to.equal(0);
    });
  });

  describe('reset', () => {
    it('should reset all stats and timers', () => {
      manager.startCycleTimer(1, 1000);
      manager.cancelCycleTimer();
      
      expect(manager.totalCycles).to.be.above(0);
      
      manager.reset();
      
      expect(manager.totalCycles).to.equal(0);
      expect(manager.cycleTimeouts).to.equal(0);
      expect(manager.operationTimeouts).to.equal(0);
    });
  });
});

