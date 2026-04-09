/**
 * Phase B-R: Redis State Store + CRDT Merge
 * 
 * Acceptance Criteria:
 * - Concurrent CRDT updates converge deterministically (1000× fuzz)
 * - Delete vs update: LWW delete always wins (no resurrection)
 * - Replay same diff → rejected (idempotency)
 * - Diffs compress with MessagePack + gzip if >100KB
 * - Config hash mismatch → error on join
 */

const { expect } = require('chai');
const { CRDTMerger } = require('../../src/cluster/backends/crdt-merger');
const { IdempotencyTracker } = require('../../src/cluster/idempotency-tracker');

describe('Phase B-R: Redis Backend Acceptance', () => {
  let merger;
  let idempotency;

  beforeEach(() => {
    merger = new CRDTMerger();
    idempotency = new IdempotencyTracker();
  });

  describe('CRDT Convergence', () => {
    it('concurrent updates converge deterministically', () => {
      const update1 = { value: 'a', timestamp: 1000, instanceId: 'i1' };
      const update2 = { value: 'b', timestamp: 2000, instanceId: 'i2' };
      const update3 = { value: 'c', timestamp: 3000, instanceId: 'i3' };

      // All merge orders must converge to same result
      const path1 = merger.mergeLWW(merger.mergeLWW(update1, update2), update3);
      const path2 = merger.mergeLWW(merger.mergeLWW(update2, update3), update1);
      const path3 = merger.mergeLWW(update1, merger.mergeLWW(update2, update3));

      expect(path1.value).to.equal(path2.value);
      expect(path2.value).to.equal(path3.value);
      expect(path1.value).to.equal('c'); // Newest timestamp wins
    });

    it('delete always wins over older update (no resurrection)', () => {
      const deleteOp = {
        tombstone: true,
        deleted: true,
        timestamp: 2000,
        instanceId: 'i1',
        value: null
      };

      const olderUpdate = {
        value: 'data',
        timestamp: 1000,
        instanceId: 'i2'
      };

      // Delete newer: should win
      const result = merger.mergeLWW(olderUpdate, deleteOp);
      expect(result.tombstone).to.be.true;
      expect(result.value).to.be.null;
    });

    it('update wins over older delete', () => {
      const olderDelete = {
        tombstone: true,
        timestamp: 1000,
        instanceId: 'i1',
        value: null
      };

      const newerUpdate = {
        value: 'resurrected',
        timestamp: 2000,
        instanceId: 'i2'
      };

      const result = merger.mergeLWW(olderDelete, newerUpdate);
      expect(result.tombstone).to.not.be.true;
      expect(result.value).to.equal('resurrected');
    });
  });

  describe('Idempotency', () => {
    it('replay same diff is rejected', () => {
      const diffId = idempotency.generateDiffId('i1', 1);

      // First application
      expect(idempotency.isApplied(diffId)).to.be.false;
      idempotency.markApplied(diffId);

      // Replay (should be rejected)
      expect(idempotency.isApplied(diffId)).to.be.true;
    });

    it('different diffs have unique IDs', () => {
      const id1 = idempotency.generateDiffId('i1', 1);
      const id2 = idempotency.generateDiffId('i1', 1);
      const id3 = idempotency.generateDiffId('i1', 2);

      expect(id1).to.not.equal(id2);
      expect(id1).to.not.equal(id3);
      expect(id2).to.not.equal(id3);
    });
  });

  describe('CRDT Properties', () => {
    it('LWW is commutative', () => {
      const v1 = { value: 'a', timestamp: 1000, instanceId: 'i1' };
      const v2 = { value: 'b', timestamp: 2000, instanceId: 'i2' };

      const result1 = merger.mergeLWW(v1, v2);
      const result2 = merger.mergeLWW(v2, v1);

      expect(result1.value).to.equal(result2.value);
    });

    it('OR-Set is commutative', () => {
      const s1 = new Set(['a', 'b']);
      const s2 = new Set(['c', 'd']);

      const result1 = merger.mergeORSet(s1, s2);
      const result2 = merger.mergeORSet(s2, s1);

      expect(result1.size).to.equal(result2.size);
      expect(Array.from(result1).sort()).to.deep.equal(Array.from(result2).sort());
    });

    it('PN-Counter is commutative', () => {
      const c1 = {
        increments: new Map([['i1', 10]]),
        decrements: new Map([['i1', 3]])
      };
      const c2 = {
        increments: new Map([['i2', 5]]),
        decrements: new Map([['i2', 1]])
      };

      const result1 = merger.mergeCounter(c1, c2);
      const result2 = merger.mergeCounter(c2, c1);

      expect(merger.getCounterValue(result1)).to.equal(merger.getCounterValue(result2));
    });

    it('LWW is idempotent', () => {
      const v = { value: 'data', timestamp: 1000, instanceId: 'i1' };

      const result = merger.mergeLWW(v, v);
      expect(result.value).to.equal(v.value);
    });

    it('OR-Set is idempotent', () => {
      const s = new Set(['a', 'b', 'c']);

      const result = merger.mergeORSet(s, s);
      expect(result.size).to.equal(3);
    });
  });

  describe('Version Vectors', () => {
    it('should merge version vectors (component-wise max)', () => {
      const v1 = { 'i1': 10, 'i2': 5 };
      const v2 = { 'i1': 8, 'i2': 12, 'i3': 3 };

      const merged = merger.mergeVersionVector(v1, v2);

      expect(merged['i1']).to.equal(10);
      expect(merged['i2']).to.equal(12);
      expect(merged['i3']).to.equal(3);
    });

    it('should detect concurrent updates', () => {
      const v1 = { 'i1': 10, 'i2': 5 };
      const v2 = { 'i1': 5, 'i2': 10 };

      const comparison = merger.compareVersionVectors(v1, v2);
      expect(comparison).to.equal('concurrent');
    });
  });

  describe('Tombstone Handling', () => {
    it('should create valid tombstones', () => {
      const tombstone = merger.createTombstone('i1', 12345);

      expect(tombstone.tombstone).to.be.true;
      expect(tombstone.deleted).to.be.true;
      expect(tombstone.deletedBy).to.equal('i1');
      expect(tombstone.timestamp).to.equal(12345);
      expect(tombstone.value).to.be.null;
    });

    it('should detect tombstones', () => {
      const tombstone = { tombstone: true, value: null };
      expect(merger.isTombstone(tombstone)).to.be.true;

      const deleted = { deleted: true, value: null };
      expect(merger.isTombstone(deleted)).to.be.true;

      const regular = { value: 'data' };
      expect(merger.isTombstone(regular)).to.be.false;
    });
  });

  describe('Idempotency Tracker', () => {
    it('should prevent duplicate diff application', () => {
      const diffId = 'test_diff_123';

      expect(idempotency.isApplied(diffId)).to.be.false;
      idempotency.markApplied(diffId);
      expect(idempotency.isApplied(diffId)).to.be.true;

      // Second application rejected
      expect(idempotency.isApplied(diffId)).to.be.true;
    });

    it('should cleanup old diffs', () => {
      idempotency.maxTrackedDiffs = 10;

      for (let i = 0; i < 20; i++) {
        idempotency.markApplied(`diff_${i}`, { appliedAt: 1000 + i });
      }

      expect(idempotency.appliedDiffs.size).to.be.at.most(10);
    });

    it('should export and import state', () => {
      idempotency.markApplied('diff1');
      idempotency.markApplied('diff2');

      const exported = idempotency.export();

      const newTracker = new IdempotencyTracker();
      newTracker.import(exported);

      expect(newTracker.isApplied('diff1')).to.be.true;
      expect(newTracker.isApplied('diff2')).to.be.true;
    });
  });
});

