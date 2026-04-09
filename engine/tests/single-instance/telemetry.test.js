/**
 * Single-Instance Integration Test: Telemetry
 * 
 * Tests telemetry collection in actual COSMO orchestrator
 */

const { expect } = require('chai');
const { TelemetryCollector } = require('../../src/core/telemetry-collector');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

describe('Single-Instance: Telemetry', () => {
  let collector;
  let mockLogger;
  let mockConfig;
  let testLogsDir;

  beforeEach(async () => {
    mockLogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {}
    };
    mockConfig = {
      telemetry: {
        structuredLogs: true,
        metrics: true,
        events: true,
        flushIntervalMs: 10000,
        maxBufferSize: 10
      }
    };
    
    testLogsDir = path.join(os.tmpdir(), `cosmo-telemetry-int-test-${Date.now()}`);
    await fs.mkdir(testLogsDir, { recursive: true });
    
    collector = new TelemetryCollector(mockConfig, mockLogger, testLogsDir);
    await collector.initialize();
  });

  afterEach(async () => {
    if (collector.flushTimer) {
      clearInterval(collector.flushTimer);
    }
    
    try {
      await fs.rm(testLogsDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('Structured Logging', () => {
    it('should emit structured JSON logs', async () => {
      collector.logStructured('info', 'Test cycle started', { cycle: 1 });
      collector.logStructured('warn', 'Memory warning', { memoryMB: 200 });
      collector.logStructured('error', 'Cycle error', { error: 'test' });
      
      await collector.flush();
      
      const logPath = path.join(testLogsDir, 'telemetry.log');
      const content = await fs.readFile(logPath, 'utf8');
      const lines = content.trim().split('\n');
      
      expect(lines).to.have.lengthOf(3);
      
      const log1 = JSON.parse(lines[0]);
      expect(log1).to.have.property('timestamp');
      expect(log1).to.have.property('level', 'info');
      expect(log1).to.have.property('message', 'Test cycle started');
      expect(log1).to.have.property('cycle', 1);
    });

    it('should auto-flush when buffer full', async () => {
      // Fill buffer (maxBufferSize = 10)
      for (let i = 0; i < 10; i++) {
        collector.logStructured('info', `Message ${i}`);
      }
      
      // Give flush a moment
      await new Promise(resolve => setTimeout(resolve, 50));
      
      const logPath = path.join(testLogsDir, 'telemetry.log');
      const exists = await fs.access(logPath).then(() => true).catch(() => false);
      expect(exists).to.be.true;
    });
  });

  describe('Metrics Collection', () => {
    it('should collect cycle metrics', () => {
      for (let i = 1; i <= 10; i++) {
        collector.recordCycleMetrics(i, {
          cycleTimeMs: 1000 + i * 100,
          memoryMB: 100 + i * 10,
          activeGoals: i,
          errors: 0
        });
      }
      
      const summary = collector.getMetricSummary('cycle.time');
      
      expect(summary).to.not.be.null;
      expect(summary.count).to.equal(10);
      expect(summary.avg).to.be.above(1000);
      expect(summary).to.have.property('p50');
      expect(summary).to.have.property('p95');
      expect(summary).to.have.property('p99');
    });

    it('should calculate percentiles correctly', () => {
      // Add 100 cycle times
      for (let i = 1; i <= 100; i++) {
        collector.recordMetric('test.metric', i);
      }
      
      const summary = collector.getMetricSummary('test.metric');
      
      expect(summary.p50).to.be.closeTo(50, 5);
      expect(summary.p95).to.be.closeTo(95, 5);
      expect(summary.p99).to.be.closeTo(99, 5);
    });

    it('should track multiple metrics independently', () => {
      collector.recordMetric('metric.a', 100);
      collector.recordMetric('metric.b', 200);
      collector.recordMetric('metric.c', 300);
      
      const all = collector.getAllMetrics();
      
      expect(all).to.have.property('metric.a');
      expect(all).to.have.property('metric.b');
      expect(all).to.have.property('metric.c');
      expect(all['metric.a'].avg).to.equal(100);
      expect(all['metric.b'].avg).to.equal(200);
      expect(all['metric.c'].avg).to.equal(300);
    });
  });

  describe('Event Emission', () => {
    it('should emit lifecycle events', async () => {
      collector.emitLifecycleEvent('initialized', { version: '1.0.0' });
      collector.emitLifecycleEvent('cycle_started', { cycle: 1 });
      collector.emitLifecycleEvent('shutdown', { clean: true });
      
      await collector.flush();
      
      const eventPath = path.join(testLogsDir, 'events.log');
      const content = await fs.readFile(eventPath, 'utf8');
      const lines = content.trim().split('\n');
      
      expect(lines).to.have.lengthOf(3);
      
      const event1 = JSON.parse(lines[0]);
      expect(event1.eventType).to.equal('lifecycle');
      expect(event1.event).to.equal('initialized');
      expect(event1.version).to.equal('1.0.0');
    });

    it('should persist events to disk', async () => {
      for (let i = 1; i <= 5; i++) {
        collector.emitEvent('cycle_event', { cycle: i });
      }
      
      await collector.flush();
      
      const eventPath = path.join(testLogsDir, 'events.log');
      const content = await fs.readFile(eventPath, 'utf8');
      const lines = content.trim().split('\n');
      
      expect(lines).to.have.lengthOf(5);
    });
  });

  describe('Telemetry Stats', () => {
    it('should track telemetry counts', () => {
      collector.logStructured('info', 'log1');
      collector.logStructured('info', 'log2');
      collector.recordMetric('metric1', 100);
      collector.emitEvent('event1');
      
      const stats = collector.getStats();
      
      expect(stats.logsEmitted).to.equal(2);
      expect(stats.metricsEmitted).to.equal(1);
      expect(stats.eventsEmitted).to.equal(1);
      expect(stats.telemetryErrors).to.equal(0);
    });

    it('should report zero errors under normal operation', async () => {
      for (let i = 0; i < 50; i++) {
        collector.logStructured('info', `Log ${i}`);
        collector.recordMetric('test', i);
        collector.emitEvent('test_event', { iteration: i });
      }
      
      await collector.flush();
      
      const stats = collector.getStats();
      expect(stats.telemetryErrors).to.equal(0);
    });
  });

  describe('Baseline Metrics', () => {
    it('should provide comprehensive baseline metrics', () => {
      // Simulate COSMO running for several cycles
      for (let cycle = 1; cycle <= 20; cycle++) {
        collector.recordCycleMetrics(cycle, {
          cycleTimeMs: 1000 + Math.random() * 500,
          memoryMB: 100 + Math.random() * 50,
          activeGoals: Math.floor(Math.random() * 10),
          errors: 0
        });
        collector.emitLifecycleEvent('cycle_completed', { cycle });
      }
      
      const baseline = collector.getBaselineMetrics();
      
      expect(baseline).to.have.property('telemetry');
      expect(baseline.telemetry).to.have.property('logsEmitted');
      expect(baseline.telemetry).to.have.property('metricsEmitted');
      expect(baseline.telemetry).to.have.property('eventsEmitted');
      expect(baseline.telemetry).to.have.property('errorRate', 0);
      
      expect(baseline).to.have.property('metrics');
      expect(baseline.metrics).to.have.property('cycle.time');
      expect(baseline.metrics).to.have.property('cycle.memory');
      expect(baseline.metrics).to.have.property('cycle.goals');
    });
  });

  describe('Periodic Flushing', () => {
    it('should flush on interval', (done) => {
      // Create new collector with short flush interval
      const shortConfig = {
        telemetry: {
          flushIntervalMs: 100 // 100ms for testing
        }
      };
      const shortCollector = new TelemetryCollector(shortConfig, mockLogger, testLogsDir);
      shortCollector.initialize();
      
      shortCollector.logStructured('info', 'test');
      
      setTimeout(async () => {
        expect(shortCollector.logBuffer.length).to.be.below(1);
        clearInterval(shortCollector.flushTimer);
        done();
      }, 150);
    });
  });

  describe('Telemetry Cleanup', () => {
    it('should flush all buffers on cleanup', async () => {
      collector.logStructured('info', 'final log');
      collector.emitEvent('final_event');
      
      await collector.cleanup();
      
      expect(collector.logBuffer).to.be.empty;
      expect(collector.eventBuffer).to.be.empty;
      expect(collector.flushTimer).to.be.null;
    });
  });
});

