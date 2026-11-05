/**
 * Phase A: Single-Instance Hardening
 *
 * Acceptance Criteria:
 * - Single COSMO runs 24h without OOM, deadlock, or timeout
 * - Restart from crash → resume from last clean cycle
 * - All telemetry emitted (logs, metrics, JSON events)
 */

const path = require('path');
const os = require('os');
const { promises: fsp } = require('fs');
const { expect } = require('chai');

const { StateValidator } = require('../../src/core/state-validator');
const { CrashRecoveryManager } = require('../../src/core/crash-recovery-manager');
const { ResourceMonitor } = require('../../src/core/resource-monitor');
const { TimeoutManager } = require('../../src/core/timeout-manager');
const { GracefulShutdownHandler } = require('../../src/core/graceful-shutdown-handler');
const { TelemetryCollector } = require('../../src/core/telemetry-collector');

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {}
};

async function withTempDir(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cosmo-accept-'));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

describe('Phase A: Single-Instance Hardening', () => {
  describe('State Validation', () => {
    it('should validate state at boot', () => {
      const validator = new StateValidator(noopLogger);
      const state = {
        cycleCount: 0,
        journal: [],
        memory: {
          nodes: [{ id: 'node-1', concept: 'Mission context' }],
          edges: []
        }
      };

      const result = validator.validateBoot(state);
      expect(result.valid).to.be.true;
      expect(result.errors).to.be.empty;
      expect(result.corrected.cycleCount).to.equal(0);
    });

    it('should validate state at cycle boundaries', () => {
      const validator = new StateValidator(noopLogger);
      const state = {
        cycleCount: 7,
        journal: [{ cycle: 7, entries: [] }],
        memory: { nodes: [], edges: [] }
      };

      const validation = validator.validateCycle(state, 7);
      expect(validation.valid).to.be.true;
      expect(validation.errors).to.be.empty;
    });

    it('should reject invalid state on load', () => {
      const validator = new StateValidator(noopLogger);
      const invalidState = {
        cycleCount: -3,
        journal: null,
        memory: {
          nodes: [{ id: null, concept: null }],
          edges: [{ from: 'missing', to: 'node' }]
        }
      };

      const result = validator.validateBoot(invalidState);
      expect(result.valid).to.be.false;
      expect(result.corrected.cycleCount).to.equal(0);
      expect(result.corrected.journal).to.be.an('array');
      expect(result.errors).to.not.be.empty;
    });
  });

  describe('Crash Recovery', () => {
    it('should resume from last complete cycle', () => {
      return withTempDir(async (dir) => {
        const manager = new CrashRecoveryManager({ recovery: { checkpointInterval: 1, maxCheckpoints: 3 } }, noopLogger, dir);
        const state = { cycleCount: 12, journal: [], memory: { nodes: [], edges: [] } };

        await manager.saveCheckpoint(state, 12);

        const recovered = await manager.recover();
        expect(recovered).to.deep.include({ cycleCount: 12 });
      });
    });

    it('should recover partial state', () => {
      return withTempDir(async (dir) => {
        const manager = new CrashRecoveryManager({ recovery: { checkpointInterval: 1, maxCheckpoints: 2 } }, noopLogger, dir);
        const healthyState = { cycleCount: 20 };
        const latestState = { cycleCount: 21 };

        await manager.saveCheckpoint(healthyState, 20);
        await manager.saveCheckpoint(latestState, 21);

        const checkpointsDir = path.join(dir, 'checkpoints');
        const corruptFile = path.join(checkpointsDir, 'checkpoint-21.json');
        await fsp.writeFile(corruptFile, '{corrupted', 'utf8');

        const recovered = await manager.recover();
        expect(recovered.cycleCount).to.equal(20);
      });
    });

    it('should handle missing state file', () => {
      return withTempDir(async (dir) => {
        const manager = new CrashRecoveryManager({ recovery: { checkpointInterval: 1 } }, noopLogger, dir);
        const recovered = await manager.recover();
        expect(recovered).to.equal(null);
      });
    });
  });

  describe('Resource Limits', () => {
    it('should flag memory usage near and above threshold', () => {
      const warnings = [];
      const errors = [];
      const monitor = new ResourceMonitor({ resources: { memoryLimitMB: 50, memoryWarningThreshold: 0.5 } }, {
        ...noopLogger,
        warn: (...args) => warnings.push(args),
        error: (...args) => errors.push(args)
      });

      monitor.checkLimits({ memUsedMB: 30, cpuPercent: 5 });
      monitor.checkLimits({ memUsedMB: 60, cpuPercent: 5 });

      expect(warnings.length).to.be.greaterThan(0);
      expect(errors.length).to.equal(1);
      expect(monitor.limitExceededCount).to.equal(1);
    });

    it('should warn when CPU usage stays high', () => {
      const warnings = [];
      const monitor = new ResourceMonitor({ resources: { cpuWarningThreshold: 0.5, memoryLimitMB: 512 } }, {
        ...noopLogger,
        warn: (...args) => warnings.push(args)
      });

      monitor.checkLimits({ memUsedMB: 10, cpuPercent: 75 });
      expect(warnings.some(([msg]) => msg.includes('High CPU usage'))).to.be.true;
    });

    it('should enforce cycle timeout', async () => {
      const events = [];
      const manager = new TimeoutManager({ timeouts: { cycleTimeoutMs: 15 } }, {
        ...noopLogger,
        error: (...args) => events.push(args)
      });

      manager.startCycleTimer(1, 15, (cycle) => events.push(['timeout', cycle]));
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(manager.cycleTimeouts).to.equal(1);
      expect(events.length).to.be.greaterThan(0);
    });
  });

  describe('Timeout Protection', () => {
    it('should not hang on I/O', async () => {
      const manager = new TimeoutManager({ timeouts: { operationTimeoutMs: 20 } }, noopLogger);
      const slowPromise = new Promise((resolve) => setTimeout(resolve, 50));

      try {
        await manager.wrapWithTimeout(slowPromise, 10, 'io-test');
        expect.fail('Expected promise to time out');
      } catch (error) {
        expect(error.code).to.equal('OPERATION_TIMEOUT');
        expect(manager.operationTimeouts).to.equal(1);
      }
    });

    it('should not hang on async operations', async () => {
      const manager = new TimeoutManager({ timeouts: { operationTimeoutMs: 10 } }, noopLogger);

      try {
        await manager.wrapWithTimeout(new Promise(() => {}), 10, 'async-test');
        expect.fail('Expected promise to time out');
      } catch (error) {
        expect(error.code).to.equal('OPERATION_TIMEOUT');
        expect(manager.getActiveOperationCount()).to.equal(0);
      }
    });
  });

  describe('Graceful Shutdown', () => {
    it('should dump state on shutdown', async () => {
      let saved = false;
      const orchestrator = {
        saveState: async () => {
          saved = true;
        }
      };

      const handler = new GracefulShutdownHandler(orchestrator, noopLogger, { shutdownTimeoutMs: 50 });
      await handler.dumpState();
      expect(saved).to.be.true;
    });

    it('should cleanup resources', async () => {
      let cleaned = false;
      const orchestrator = {
        timeoutManager: {
          cleanup: () => {
            cleaned = true;
          }
        }
      };

      const handler = new GracefulShutdownHandler(orchestrator, noopLogger, {});
      await handler.cleanup();
      expect(cleaned).to.be.true;
    });

    it('should be idempotent (shutdown twice)', async () => {
      const orchestrator = {
        stop: async () => {},
        saveState: async () => {},
        crashRecovery: { markCleanShutdown: async () => {} },
        timeoutManager: { cleanup: () => {} }
      };

      const handler = new GracefulShutdownHandler(orchestrator, noopLogger, { shutdownTimeoutMs: 50 });
      const exitCalls = [];
      const originalExit = process.exit;
      process.exit = (code) => {
        exitCalls.push(code);
      };

      try {
        await handler.shutdown('manual');
        await handler.shutdown('manual');
        expect(exitCalls).to.have.lengthOf(1);
        expect(handler.shutdownComplete).to.be.true;
      } finally {
        process.exit = originalExit;
      }
    });
  });

  describe('Telemetry', () => {
    let tempDir;
    let collector;

    beforeEach(async () => {
      tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cosmo-telemetry-'));
      collector = new TelemetryCollector({ telemetry: { flushIntervalMs: 25, maxBufferSize: 100 } }, noopLogger, tempDir);
      await collector.initialize();
    });

    afterEach(async () => {
      await collector.cleanup();
      await fsp.rm(tempDir, { recursive: true, force: true });
    });

    it('should emit structured logs', async () => {
      collector.logStructured('info', 'cycle started', { cycleCount: 1 });
      await collector.flush();

      const logContent = await fsp.readFile(path.join(tempDir, 'telemetry.log'), 'utf8');
      expect(logContent).to.contain('cycle started');
    });

    it('should emit metrics', async () => {
      collector.recordMetric('cycle_time_ms', 120, { cycle: 1 });
      await collector.flush();

      const metricsContent = await fsp.readFile(path.join(tempDir, 'metrics.json'), 'utf8');
      expect(metricsContent).to.contain('cycle_time_ms');
    });

    it('should emit JSON events', async () => {
      collector.emitEvent('cycle.completed', { cycle: 1 });
      await collector.flush();

      const eventsContent = await fsp.readFile(path.join(tempDir, 'events.log'), 'utf8');
      expect(eventsContent).to.contain('cycle.completed');
    });

    it('should have zero telemetry errors', async () => {
      collector.logStructured('info', 'noop', {});
      collector.recordMetric('noop_metric', 1);
      collector.emitEvent('noop_event', {});
      await collector.cleanup();
      expect(collector.telemetryErrors).to.equal(0);
      // restart for afterEach cleanup flush
      collector = new TelemetryCollector({ telemetry: { flushIntervalMs: 25, maxBufferSize: 100 } }, noopLogger, tempDir);
      await collector.initialize();
    });
  });

  describe('24-Hour Stability', () => {
    it('should maintain healthy resource stats over simulated cycles', () => {
      const monitor = new ResourceMonitor({ resources: { memoryLimitMB: 1024 } }, noopLogger);

      for (let i = 0; i < 10; i++) {
        monitor.snapshot();
      }

      const stats = monitor.getStats();
      expect(stats.snapshotCount).to.be.at.least(1);
      expect(stats.healthy).to.be.true;
    });

    it('should avoid lingering cycle timers across iterations', async () => {
      const manager = new TimeoutManager({ timeouts: { cycleTimeoutMs: 20 } }, noopLogger);

      for (let cycle = 0; cycle < 5; cycle++) {
        manager.startCycleTimer(cycle, 20);
        manager.cancelCycleTimer();
      }

      expect(manager.cycleTimeouts).to.equal(0);
      expect(manager.isCycleActive()).to.be.false;
    });

    it('should complete operations before timeout under nominal load', async () => {
      const manager = new TimeoutManager({ timeouts: { operationTimeoutMs: 50 } }, noopLogger);

      const results = await Promise.all(
        Array.from({ length: 5 }, (_, idx) => {
          const promise = new Promise((resolve) => setTimeout(() => resolve(idx), 10));
          return manager.wrapWithTimeout(promise, 50, `op-${idx}`);
        })
      );

      expect(results).to.deep.equal([0, 1, 2, 3, 4]);
      expect(manager.operationTimeouts).to.equal(0);
    });
  });
});
