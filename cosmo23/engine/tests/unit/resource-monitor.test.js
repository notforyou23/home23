/**
 * Unit tests for ResourceMonitor
 */

const { expect } = require('chai');
const { ResourceMonitor } = require('../../src/core/resource-monitor');

describe('ResourceMonitor', () => {
  let monitor;
  let mockLogger;
  let mockConfig;

  beforeEach(() => {
    mockLogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: ()=> {}
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

  describe('snapshot', () => {
    it('should take resource snapshot', () => {
      const snapshot = monitor.snapshot();
      
      expect(snapshot).to.have.property('timestamp');
      expect(snapshot).to.have.property('memUsedMB');
      expect(snapshot).to.have.property('memTotalMB');
      expect(snapshot).to.have.property('rss');
      expect(snapshot).to.have.property('cpuPercent');
    });

    it('should track peak memory', () => {
      monitor.snapshot();
      const initialPeak = monitor.peakMemoryMB;
      
      monitor.snapshot();
      const secondPeak = monitor.peakMemoryMB;
      
      expect(secondPeak).to.be.at.least(initialPeak);
    });

    it('should limit snapshots to 100', () => {
      for (let i = 0; i < 150; i++) {
        monitor.snapshot();
      }
      
      expect(monitor.memorySnapshots.length).to.equal(100);
    });

    it('should calculate averages', () => {
      for (let i = 0; i < 10; i++) {
        monitor.snapshot();
      }
      
      expect(monitor.avgMemoryMB).to.be.a('number');
      expect(monitor.avgMemoryMB).to.be.above(0);
    });
  });

  describe('checkLimits', () => {
    it('should detect when memory limit exceeded', () => {
      // Force high memory usage detection
      const snapshot = {
        memUsedMB: 300, // Over 256MB limit
        cpuPercent: 50
      };
      
      monitor.checkLimits(snapshot);
      
      // Should have logged error (limitExceededCount incremented)
      expect(monitor.limitExceededCount).to.be.above(0);
    });

    it('should issue warning at threshold', () => {
      const snapshot = {
        memUsedMB: 256 * 0.85, // 85% (above 80% threshold)
        cpuPercent: 50
      };
      
      monitor.checkLimits(snapshot);
      
      expect(monitor.warningCount).to.be.above(0);
    });
  });

  describe('isHealthy', () => {
    it('should return true when under limit', () => {
      monitor.memorySnapshots.push({
        memUsedMB: 100, // Well under 256MB limit
        cpuPercent: 50
      });
      
      expect(monitor.isHealthy()).to.be.true;
    });

    it('should return false when over limit', () => {
      monitor.memorySnapshots.push({
        memUsedMB: 300, // Over 256MB limit
        cpuPercent: 50
      });
      
      expect(monitor.isHealthy()).to.be.false;
    });
  });

  describe('getStats', () => {
    it('should return comprehensive stats', () => {
      monitor.snapshot();
      
      const stats = monitor.getStats();
      
      expect(stats).to.have.property('uptimeMs');
      expect(stats).to.have.property('memory');
      expect(stats.memory).to.have.property('currentMB');
      expect(stats.memory).to.have.property('avgMB');
      expect(stats.memory).to.have.property('peakMB');
      expect(stats.memory).to.have.property('limitMB');
      expect(stats).to.have.property('cpu');
      expect(stats).to.have.property('warnings');
      expect(stats).to.have.property('healthy');
    });
  });

  describe('getBaselineMetrics', () => {
    it('should return metrics for baseline capture', () => {
      monitor.snapshot();
      
      const baseline = monitor.getBaselineMetrics();
      
      expect(baseline).to.have.property('memory');
      expect(baseline.memory).to.have.property('avg');
      expect(baseline.memory).to.have.property('peak');
      expect(baseline.memory).to.have.property('limit');
      expect(baseline).to.have.property('cpu');
      expect(baseline).to.have.property('uptime');
    });
  });

  describe('formatUptime', () => {
    it('should format seconds', () => {
      const formatted = monitor.formatUptime(45000); // 45s
      expect(formatted).to.equal('45s');
    });

    it('should format minutes', () => {
      const formatted = monitor.formatUptime(150000); // 2m 30s
      expect(formatted).to.equal('2m 30s');
    });

    it('should format hours', () => {
      const formatted = monitor.formatUptime(3665000); // 1h 1m 5s
      expect(formatted).to.match(/1h/);
    });

    it('should format days', () => {
      const formatted = monitor.formatUptime(90000000); // >1 day
      expect(formatted).to.match(/\dd/);
    });
  });

  describe('reset', () => {
    it('should reset all stats', () => {
      monitor.snapshot();
      monitor.snapshot();
      
      expect(monitor.memorySnapshots.length).to.be.above(0);
      
      monitor.reset();
      
      expect(monitor.memorySnapshots).to.be.empty;
      expect(monitor.peakMemoryMB).to.equal(0);
      expect(monitor.avgMemoryMB).to.equal(0);
      expect(monitor.warningCount).to.equal(0);
    });
  });
});

