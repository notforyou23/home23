/**
 * Unit tests for IdempotencyTracker
 */

const { expect } = require('chai');
const { IdempotencyTracker } = require('../../src/cluster/idempotency-tracker');

describe('IdempotencyTracker', () => {
  let tracker;
  let mockLogger;

  beforeEach(() => {
    mockLogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {}
    };
    tracker = new IdempotencyTracker(mockLogger);
  });

  describe('generateDiffId', () => {
    it('should generate unique diff IDs', () => {
      const id1 = tracker.generateDiffId('cosmo-1', 1);
      const id2 = tracker.generateDiffId('cosmo-1', 1);
      
      expect(id1).to.be.a('string');
      expect(id2).to.be.a('string');
      expect(id1).to.not.equal(id2); // Should be unique (random component)
    });

    it('should include timestamp, cycle, and instanceId', () => {
      const diffId = tracker.generateDiffId('cosmo-test', 42);
      
      expect(diffId).to.include('cosmo-test');
      expect(diffId).to.include('42');
      expect(diffId).to.match(/^\d+_/); // Starts with timestamp
    });

    it('should generate sortable IDs (timestamp-based)', () => {
      const id1 = tracker.generateDiffId('cosmo-1', 1);
      
      // Wait a bit
      const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
      return wait(10).then(() => {
        const id2 = tracker.generateDiffId('cosmo-1', 2);
        
        // Lexicographic sort should match time order
        expect(id1 < id2).to.be.true;
      });
    });
  });

  describe('isApplied / markApplied', () => {
    it('should track applied diffs', () => {
      const diffId = 'test_diff_123';
      
      expect(tracker.isApplied(diffId)).to.be.false;
      
      tracker.markApplied(diffId);
      
      expect(tracker.isApplied(diffId)).to.be.true;
    });

    it('should store metadata with applied diff', () => {
      const diffId = 'test_diff_456';
      const metadata = {
        timestamp: Date.now(),
        instanceId: 'cosmo-1',
        cycle: 10
      };
      
      tracker.markApplied(diffId, metadata);
      
      const stored = tracker.getMetadata(diffId);
      expect(stored).to.have.property('appliedAt');
      expect(stored).to.have.property('timestamp', metadata.timestamp);
      expect(stored).to.have.property('instanceId', 'cosmo-1');
      expect(stored).to.have.property('cycle', 10);
    });
  });

  describe('cleanup', () => {
    it('should remove oldest diffs when limit exceeded', () => {
      // Set low limit for testing
      tracker.maxTrackedDiffs = 100;
      
      // Add 110 diffs
      for (let i = 0; i < 110; i++) {
        tracker.markApplied(`diff_${i}`, { appliedAt: Date.now() + i });
      }
      
      // Should have cleaned up
      expect(tracker.appliedDiffs.size).to.be.at.most(100);
    });

    it('should keep most recent diffs', () => {
      tracker.maxTrackedDiffs = 10;
      
      // Add diffs with timestamps
      for (let i = 0; i < 20; i++) {
        tracker.markApplied(`diff_${i}`, { appliedAt: 1000 + i });
      }
      
      // Should keep diffs 10-19 (most recent)
      expect(tracker.isApplied('diff_19')).to.be.true;
      expect(tracker.isApplied('diff_15')).to.be.true;
      expect(tracker.isApplied('diff_0')).to.be.false;
    });
  });

  describe('getMetadata', () => {
    it('should return metadata for applied diff', () => {
      const diffId = 'test_diff';
      const metadata = { cycle: 5, instanceId: 'cosmo-1' };
      
      tracker.markApplied(diffId, metadata);
      
      const retrieved = tracker.getMetadata(diffId);
      expect(retrieved).to.have.property('cycle', 5);
      expect(retrieved).to.have.property('instanceId', 'cosmo-1');
    });

    it('should return null for non-existent diff', () => {
      const result = tracker.getMetadata('nonexistent');
      expect(result).to.be.null;
    });
  });

  describe('getStats', () => {
    it('should return tracker stats', () => {
      tracker.markApplied('diff1');
      tracker.markApplied('diff2');
      tracker.markApplied('diff3');
      
      const stats = tracker.getStats();
      
      expect(stats).to.have.property('totalApplied', 3);
      expect(stats).to.have.property('maxTracked');
      expect(stats).to.have.property('utilizationPercent');
    });
  });

  describe('export / import', () => {
    it('should export applied diffs', () => {
      tracker.markApplied('diff1', { cycle: 1 });
      tracker.markApplied('diff2', { cycle: 2 });
      
      const exported = tracker.export();
      
      expect(exported).to.have.property('appliedDiffs');
      expect(exported.appliedDiffs).to.include('diff1');
      expect(exported.appliedDiffs).to.include('diff2');
      expect(exported).to.have.property('diffMetadata');
    });

    it('should import applied diffs', () => {
      const data = {
        appliedDiffs: ['diff1', 'diff2', 'diff3'],
        diffMetadata: {
          diff1: { cycle: 1, appliedAt: 1000 },
          diff2: { cycle: 2, appliedAt: 2000 },
          diff3: { cycle: 3, appliedAt: 3000 }
        }
      };
      
      tracker.import(data);
      
      expect(tracker.isApplied('diff1')).to.be.true;
      expect(tracker.isApplied('diff2')).to.be.true;
      expect(tracker.isApplied('diff3')).to.be.true;
      expect(tracker.appliedDiffs.size).to.equal(3);
    });

    it('should round-trip export/import', () => {
      tracker.markApplied('diff1');
      tracker.markApplied('diff2');
      
      const exported = tracker.export();
      
      const newTracker = new IdempotencyTracker(mockLogger);
      newTracker.import(exported);
      
      expect(newTracker.isApplied('diff1')).to.be.true;
      expect(newTracker.isApplied('diff2')).to.be.true;
    });
  });

  describe('clear', () => {
    it('should clear all tracked diffs', () => {
      tracker.markApplied('diff1');
      tracker.markApplied('diff2');
      
      expect(tracker.appliedDiffs.size).to.be.above(0);
      
      tracker.clear();
      
      expect(tracker.appliedDiffs.size).to.equal(0);
      expect(tracker.diffMetadata.size).to.equal(0);
    });
  });

  describe('Idempotency Guarantee', () => {
    it('should prevent duplicate diff application', () => {
      const diffId = tracker.generateDiffId('cosmo-1', 1);
      
      // First application
      expect(tracker.isApplied(diffId)).to.be.false;
      tracker.markApplied(diffId);
      expect(tracker.isApplied(diffId)).to.be.true;
      
      // Second application (should be rejected)
      expect(tracker.isApplied(diffId)).to.be.true;
    });
  });
});

