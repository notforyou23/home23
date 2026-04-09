/**
 * Single-Instance Integration Test: Resource Limits
 * 
 * Tests resource monitoring and limit enforcement in actual COSMO
 */

const { expect } = require('chai');
const { ResourceMonitor } = require('../../src/core/resource-monitor');

describe('Single-Instance: Resource Limits', () => {
  let monitor;
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
      resources: {
        memoryLimitMB: 256,
        memoryWarningThreshold: 0.8,
        cpuWarningThreshold: 0.9
      }
    };
    monitor = new ResourceMonitor(mockConfig, mockLogger);
  });

  describe('Memory Tracking', () => {
    it('should track memory usage over multiple cycles', () => {
      // Simulate 10 cycles
      for (let i = 0; i < 10; i++) {
        monitor.snapshot();
      }
      
      const stats = monitor.getStats();
      expect(stats.snapshotCount).to.equal(10);
      expect(parseFloat(stats.memory.avgMB)).to.be.above(0);
      expect(parseFloat(stats.memory.peakMB)).to.be.above(0);
    });

    it('should track peak memory across cycles', () => {
      monitor.snapshot();
      const firstPeak = monitor.peakMemoryMB;
      
      // Take more snapshots
      for (let i = 0; i < 5; i++) {
        monitor.snapshot();
      }
      
      const stats = monitor.getStats();
      expect(parseFloat(stats.memory.peakMB)).to.be.at.least(firstPeak);
    });

    it('should calculate running average', () => {
      for (let i = 0; i < 20; i++) {
        monitor.snapshot();
      }
      
      const stats = monitor.getStats();
      expect(parseFloat(stats.memory.avgMB)).to.be.above(0);
      expect(parseFloat(stats.memory.avgMB)).to.be.below(parseFloat(stats.memory.peakMB) + 1);
    });
  });

  describe('CPU Monitoring', () => {
    it('should track CPU usage', () => {
      monitor.snapshot();
      
      const stats = monitor.getStats();
      expect(stats.cpu).to.have.property('currentPercent');
      expect(stats.cpu).to.have.property('avgPercent');
    });
  });

  describe('Limit Enforcement', () => {
    it('should detect memory warnings', () => {
      // Simulate high memory (85% of 256MB = ~217MB)
      const snapshot = {
        memUsedMB: 217,
        cpuPercent: 50
      };
      
      monitor.checkLimits(snapshot);
      expect(monitor.warningCount).to.be.above(0);
    });

    it('should detect limit exceeded', () => {
      // Simulate over limit (300MB > 256MB)
      const snapshot = {
        memUsedMB: 300,
        cpuPercent: 50
      };
      
      monitor.checkLimits(snapshot);
      expect(monitor.limitExceededCount).to.be.above(0);
    });

    it('should report healthy when under limit', () => {
      monitor.memorySnapshots.push({
        memUsedMB: 100, // Well under limit
        cpuPercent: 40
      });
      
      expect(monitor.isHealthy()).to.be.true;
    });

    it('should report unhealthy when over limit', () => {
      monitor.memorySnapshots.push({
        memUsedMB: 300, // Over limit
        cpuPercent: 40
      });
      
      expect(monitor.isHealthy()).to.be.false;
    });
  });

  describe('Baseline Metrics', () => {
    it('should provide metrics for baseline capture', () => {
      // Simulate running for a bit
      for (let i = 0; i < 10; i++) {
        monitor.snapshot();
      }
      
      const baseline = monitor.getBaselineMetrics();
      
      expect(baseline).to.have.property('memory');
      expect(baseline.memory).to.have.property('avg');
      expect(baseline.memory).to.have.property('peak');
      expect(baseline.memory).to.have.property('limit');
      expect(baseline).to.have.property('cpu');
      expect(baseline.cpu).to.have.property('avg');
      expect(baseline).to.have.property('uptime');
      expect(baseline.uptime).to.have.property('ms');
      expect(baseline.uptime).to.have.property('seconds');
    });
  });

  describe('Uptime Tracking', () => {
    it('should track uptime', () => {
      const stats = monitor.getStats();
      expect(stats).to.have.property('uptimeMs');
      expect(stats).to.have.property('uptimeHuman');
      expect(stats.uptimeMs).to.be.above(0);
    });
  });
});

