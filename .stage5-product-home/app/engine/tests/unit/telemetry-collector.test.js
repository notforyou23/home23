/**
 * Unit tests for TelemetryCollector
 */

const { expect } = require('chai');
const { TelemetryCollector } = require('../../src/core/telemetry-collector');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

describe('TelemetryCollector', () => {
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
        flushIntervalMs: 10000, // 10s for tests
        maxBufferSize: 5
      }
    };
    
    // Create temp directory
    testLogsDir = path.join(os.tmpdir(), `cosmo-telemetry-test-${Date.now()}`);
    await fs.mkdir(testLogsDir, { recursive: true });
    
    collector = new TelemetryCollector(mockConfig, mockLogger, testLogsDir);
  });

  afterEach(async () => {
    // Stop flush timer
    if (collector.flushTimer) {
      clearInterval(collector.flushTimer);
    }
    
    // Cleanup test directory
    try {
      await fs.rm(testLogsDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('logStructured', () => {
    it('should buffer structured logs', () => {
      collector.logStructured('info', 'test message', { context: 'data' });
      
      expect(collector.logBuffer).to.have.lengthOf(1);
      expect(collector.logsEmitted).to.equal(1);
      
      const entry = collector.logBuffer[0];
      expect(entry).to.have.property('timestamp');
      expect(entry).to.have.property('level', 'info');
      expect(entry).to.have.property('message', 'test message');
      expect(entry).to.have.property('context', 'data');
    });

    it('should auto-flush when buffer full', async () => {
      // Buffer size is 5
      for (let i = 0; i < 5; i++) {
        collector.logStructured('info', `message ${i}`);
      }
      
      // Give flush a moment
      await new Promise(resolve => setTimeout(resolve, 50));
      
      expect(collector.logBuffer.length).to.be.below(5);
    });

    it('should handle errors gracefully', () => {
      expect(() => collector.logStructured('info', null)).to.not.throw();
    });
  });

  describe('recordMetric', () => {
    it('should record metric values', () => {
      collector.recordMetric('test.metric', 100, { tag: 'value' });
      
      expect(collector.metrics).to.have.property('test.metric');
      expect(collector.metricsEmitted).to.equal(1);
      
      const metric = collector.metrics['test.metric'];
      expect(metric.count).to.equal(1);
      expect(metric.sum).to.equal(100);
      expect(metric.min).to.equal(100);
      expect(metric.max).to.equal(100);
      expect(metric.avg).to.equal(100);
    });

    it('should calculate avg/min/max correctly', () => {
      collector.recordMetric('test', 10);
      collector.recordMetric('test', 20);
      collector.recordMetric('test', 30);
      
      const metric = collector.metrics['test'];
      expect(metric.count).to.equal(3);
      expect(metric.avg).to.equal(20);
      expect(metric.min).to.equal(10);
      expect(metric.max).to.equal(30);
    });

    it('should keep only last 1000 values', () => {
      for (let i = 0; i < 1500; i++) {
        collector.recordMetric('test', i);
      }
      
      const metric = collector.metrics['test'];
      expect(metric.values.length).to.equal(1000);
    });
  });

  describe('emitEvent', () => {
    it('should buffer events', () => {
      collector.emitEvent('test_event', { detail: 'data' });
      
      expect(collector.eventBuffer).to.have.lengthOf(1);
      expect(collector.eventsEmitted).to.equal(1);
      
      const event = collector.eventBuffer[0];
      expect(event).to.have.property('timestamp');
      expect(event).to.have.property('eventType', 'test_event');
      expect(event).to.have.property('detail', 'data');
    });
  });

  describe('getMetricSummary', () => {
    it('should calculate percentiles', () => {
      const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      for (const val of values) {
        collector.recordMetric('test', val);
      }
      
      const summary = collector.getMetricSummary('test');
      
      expect(summary).to.have.property('count', 10);
      expect(summary).to.have.property('avg', 5.5);
      expect(summary).to.have.property('min', 1);
      expect(summary).to.have.property('max', 10);
      expect(summary).to.have.property('p50');
      expect(summary).to.have.property('p95');
      expect(summary).to.have.property('p99');
    });

    it('should return null for non-existent metric', () => {
      const summary = collector.getMetricSummary('nonexistent');
      expect(summary).to.be.null;
    });
  });

  describe('getAllMetrics', () => {
    it('should return all metric summaries', () => {
      collector.recordMetric('metric1', 100);
      collector.recordMetric('metric2', 200);
      
      const all = collector.getAllMetrics();
      
      expect(all).to.have.property('metric1');
      expect(all).to.have.property('metric2');
    });
  });

  describe('flush', () => {
    it('should write logs to file', async () => {
      collector.logStructured('info', 'test log');
      await collector.flush();
      
      const logPath = path.join(testLogsDir, 'telemetry.log');
      const content = await fs.readFile(logPath, 'utf8');
      
      expect(content).to.include('test log');
      expect(collector.logBuffer).to.be.empty;
    });

    it('should write events to file', async () => {
      collector.emitEvent('test_event', { data: 'value' });
      await collector.flush();
      
      const eventPath = path.join(testLogsDir, 'events.log');
      const content = await fs.readFile(eventPath, 'utf8');
      
      expect(content).to.include('test_event');
      expect(collector.eventBuffer).to.be.empty;
    });

    it('should write metrics to file', async () => {
      collector.recordMetric('test', 100);
      await collector.flush();
      
      const metricsPath = path.join(testLogsDir, 'metrics.json');
      const content = await fs.readFile(metricsPath, 'utf8');
      const metrics = JSON.parse(content);
      
      expect(metrics).to.have.property('metrics');
      expect(metrics.metrics).to.have.property('test');
    });

    it('should handle flush errors gracefully', async () => {
      // Force error by using invalid path
      collector.structuredLogPath = '/invalid/path/file.log';
      collector.logStructured('info', 'test');
      
      await collector.flush();
      
      expect(collector.telemetryErrors).to.be.above(0);
    });
  });

  describe('recordCycleMetrics', () => {
    it('should record all cycle metrics', () => {
      collector.recordCycleMetrics(1, {
        cycleTimeMs: 1000,
        memoryMB: 128,
        activeGoals: 5,
        errors: 0
      });
      
      expect(collector.metrics).to.have.property('cycle.time');
      expect(collector.metrics).to.have.property('cycle.memory');
      expect(collector.metrics).to.have.property('cycle.goals');
    });
  });

  describe('emitLifecycleEvent', () => {
    it('should emit lifecycle events with proper structure', () => {
      collector.emitLifecycleEvent('initialized', { version: '1.0.0' });
      
      expect(collector.eventBuffer).to.have.lengthOf(1);
      const event = collector.eventBuffer[0];
      expect(event.eventType).to.equal('lifecycle');
      expect(event.event).to.equal('initialized');
      expect(event.version).to.equal('1.0.0');
    });
  });

  describe('getStats', () => {
    it('should return telemetry stats', () => {
      collector.logStructured('info', 'test');
      collector.recordMetric('test', 100);
      collector.emitEvent('test_event');
      
      const stats = collector.getStats();
      
      expect(stats.logsEmitted).to.equal(1);
      expect(stats.metricsEmitted).to.equal(1);
      expect(stats.eventsEmitted).to.equal(1);
      expect(stats.telemetryErrors).to.equal(0);
    });
  });

  describe('getBaselineMetrics', () => {
    it('should return baseline-compatible metrics', () => {
      collector.recordMetric('test', 100);
      
      const baseline = collector.getBaselineMetrics();
      
      expect(baseline).to.have.property('telemetry');
      expect(baseline.telemetry).to.have.property('logsEmitted');
      expect(baseline.telemetry).to.have.property('metricsEmitted');
      expect(baseline.telemetry).to.have.property('eventsEmitted');
      expect(baseline).to.have.property('metrics');
    });
  });

  describe('cleanup', () => {
    it('should stop timer and flush', async () => {
      await collector.initialize();
      collector.logStructured('info', 'test');
      
      await collector.cleanup();
      
      expect(collector.flushTimer).to.be.null;
      expect(collector.logBuffer).to.be.empty;
    });
  });

  describe('reset', () => {
    it('should reset all buffers and stats', () => {
      collector.logStructured('info', 'test');
      collector.recordMetric('test', 100);
      collector.emitEvent('test_event');
      
      collector.reset();
      
      expect(collector.logBuffer).to.be.empty;
      expect(collector.eventBuffer).to.be.empty;
      expect(collector.metrics).to.be.empty;
      expect(collector.logsEmitted).to.equal(0);
      expect(collector.metricsEmitted).to.equal(0);
      expect(collector.eventsEmitted).to.equal(0);
    });
  });
});

