/**
 * CRDT Determinism Fuzzing Tests
 * 
 * Runs 1000× concurrent update scenarios to verify CRDT convergence
 * Phase B-R critical test: all instances must converge to identical state
 */

const { expect } = require('chai');
const { CRDTMerger } = require('../../src/cluster/backends/crdt-merger');

describe('CRDT Determinism Fuzzing', function() {
  this.timeout(60000); // 60s for 1000 scenarios

  let merger;

  beforeEach(() => {
    merger = new CRDTMerger();
  });

  describe('LWW Convergence (1000× scenarios)', () => {
    it('should converge to same state regardless of merge order', () => {
      const scenarios = 1000;
      let failures = 0;

      for (let i = 0; i < scenarios; i++) {
        // Generate 3 concurrent updates with random timestamps
        const updates = [
          { value: 'a', timestamp: Math.floor(Math.random() * 1000), instanceId: 'i1' },
          { value: 'b', timestamp: Math.floor(Math.random() * 1000), instanceId: 'i2' },
          { value: 'c', timestamp: Math.floor(Math.random() * 1000), instanceId: 'i3' }
        ];

        // Try all 6 merge orders
        const order1 = merger.mergeLWW(merger.mergeLWW(updates[0], updates[1]), updates[2]);
        const order2 = merger.mergeLWW(merger.mergeLWW(updates[0], updates[2]), updates[1]);
        const order3 = merger.mergeLWW(merger.mergeLWW(updates[1], updates[0]), updates[2]);
        const order4 = merger.mergeLWW(merger.mergeLWW(updates[1], updates[2]), updates[0]);
        const order5 = merger.mergeLWW(merger.mergeLWW(updates[2], updates[0]), updates[1]);
        const order6 = merger.mergeLWW(merger.mergeLWW(updates[2], updates[1]), updates[0]);

        // All should converge to same value
        if (!(order1.value === order2.value && 
              order2.value === order3.value &&
              order3.value === order4.value &&
              order4.value === order5.value &&
              order5.value === order6.value)) {
          failures++;
        }
      }

      expect(failures).to.equal(0, `${failures} scenarios failed to converge`);
    });

    it('should handle delete vs update races (1000× scenarios)', () => {
      const scenarios = 1000;
      let deleteWins = 0;
      let updateWins = 0;

      for (let i = 0; i < scenarios; i++) {
        const deleteTimestamp = Math.floor(Math.random() * 1000);
        const updateTimestamp = Math.floor(Math.random() * 1000);

        const deleteOp = {
          tombstone: true,
          deleted: true,
          timestamp: deleteTimestamp,
          instanceId: 'i1',
          value: null
        };

        const updateOp = {
          value: 'data',
          timestamp: updateTimestamp,
          instanceId: 'i2'
        };

        // Merge both orders
        const result1 = merger.mergeLWW(deleteOp, updateOp);
        const result2 = merger.mergeLWW(updateOp, deleteOp);

        // Both orders should produce same result
        expect(result1.tombstone === result2.tombstone).to.be.true;

        // Track which wins
        if (result1.tombstone) {
          deleteWins++;
        } else {
          updateWins++;
        }
      }

      // Should have both wins and deletes (random timestamps)
      expect(deleteWins).to.be.above(0);
      expect(updateWins).to.be.above(0);
      expect(deleteWins + updateWins).to.equal(scenarios);
    });
  });

  describe('OR-Set Convergence (1000× scenarios)', () => {
    it('should converge via union', () => {
      const scenarios = 1000;
      let failures = 0;

      for (let i = 0; i < scenarios; i++) {
        // Random sets
        const set1 = new Set(Array.from({ length: 5 }, () => Math.floor(Math.random() * 100)));
        const set2 = new Set(Array.from({ length: 5 }, () => Math.floor(Math.random() * 100)));
        const set3 = new Set(Array.from({ length: 5 }, () => Math.floor(Math.random() * 100)));

        // Different merge orders
        const result1 = merger.mergeORSet(merger.mergeORSet(set1, set2), set3);
        const result2 = merger.mergeORSet(set1, merger.mergeORSet(set2, set3));
        const result3 = merger.mergeORSet(merger.mergeORSet(set2, set3), set1);

        // Convert to sorted arrays for comparison
        const arr1 = Array.from(result1).sort();
        const arr2 = Array.from(result2).sort();
        const arr3 = Array.from(result3).sort();

        if (JSON.stringify(arr1) !== JSON.stringify(arr2) ||
            JSON.stringify(arr2) !== JSON.stringify(arr3)) {
          failures++;
        }
      }

      expect(failures).to.equal(0, `${failures} scenarios failed to converge`);
    });
  });

  describe('PN-Counter Convergence (1000× scenarios)', () => {
    it('should converge regardless of merge order', () => {
      const scenarios = 1000;
      let failures = 0;

      for (let i = 0; i < scenarios; i++) {
        // Random counters from 3 instances
        const counter1 = {
          increments: new Map([['i1', Math.floor(Math.random() * 100)]]),
          decrements: new Map([['i1', Math.floor(Math.random() * 50)]])
        };
        const counter2 = {
          increments: new Map([['i2', Math.floor(Math.random() * 100)]]),
          decrements: new Map([['i2', Math.floor(Math.random() * 50)]])
        };
        const counter3 = {
          increments: new Map([['i3', Math.floor(Math.random() * 100)]]),
          decrements: new Map([['i3', Math.floor(Math.random() * 50)]])
        };

        // Different merge orders
        const result1 = merger.mergeCounter(merger.mergeCounter(counter1, counter2), counter3);
        const result2 = merger.mergeCounter(counter1, merger.mergeCounter(counter2, counter3));
        const result3 = merger.mergeCounter(merger.mergeCounter(counter2, counter3), counter1);

        // All should have same value
        const value1 = merger.getCounterValue(result1);
        const value2 = merger.getCounterValue(result2);
        const value3 = merger.getCounterValue(result3);

        if (value1 !== value2 || value2 !== value3) {
          failures++;
        }
      }

      expect(failures).to.equal(0, `${failures} scenarios failed to converge`);
    });
  });

  describe('Multi-Instance Simulation (100× scenarios)', () => {
    it('should handle 3-instance concurrent updates', () => {
      const scenarios = 100;
      let failures = 0;

      for (let s = 0; s < scenarios; s++) {
        // Simulate 3 instances updating same node
        const instance1Update = { value: 'i1-data', timestamp: 1000 + s, instanceId: 'i1' };
        const instance2Update = { value: 'i2-data', timestamp: 1000 + s + 1, instanceId: 'i2' };
        const instance3Update = { value: 'i3-data', timestamp: 1000 + s + 2, instanceId: 'i3' };

        // Each instance merges in different order (simulating network delays)
        // Instance 1 sees: self, i2, i3
        const i1View = merger.mergeLWW(merger.mergeLWW(instance1Update, instance2Update), instance3Update);

        // Instance 2 sees: self, i3, i1
        const i2View = merger.mergeLWW(merger.mergeLWW(instance2Update, instance3Update), instance1Update);

        // Instance 3 sees: self, i1, i2
        const i3View = merger.mergeLWW(merger.mergeLWW(instance3Update, instance1Update), instance2Update);

        // All instances must converge
        if (!(i1View.value === i2View.value && i2View.value === i3View.value)) {
          failures++;
        }

        // Should converge to i3 (highest timestamp)
        expect(i1View.value).to.equal('i3-data');
      }

      expect(failures).to.equal(0, `${failures} scenarios failed to converge`);
    });
  });

  describe('Stress Test: Rapid Concurrent Updates', () => {
    it('should handle 1000 concurrent updates per instance (9 instances)', () => {
      const numInstances = 9;
      const updatesPerInstance = 1000;
      
      // Each instance generates updates
      const allUpdates = [];
      for (let i = 0; i < numInstances; i++) {
        for (let u = 0; u < updatesPerInstance; u++) {
          allUpdates.push({
            value: `i${i}-update${u}`,
            timestamp: Date.now() + u,
            instanceId: `instance-${i}`
          });
        }
      }

      // Shuffle updates (simulate network reordering)
      for (let i = allUpdates.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [allUpdates[i], allUpdates[j]] = [allUpdates[j], allUpdates[i]];
      }

      // Merge all updates
      let finalState = allUpdates[0];
      for (let i = 1; i < allUpdates.length; i++) {
        finalState = merger.mergeLWW(finalState, allUpdates[i]);
      }

      // Final state should be deterministic (newest timestamp wins)
      expect(finalState).to.have.property('value');
      expect(finalState).to.have.property('timestamp');
      
      // Verify it's the newest
      const newestUpdate = allUpdates.reduce((a, b) => 
        a.timestamp > b.timestamp ? a : b
      );
      expect(finalState.timestamp).to.be.at.least(newestUpdate.timestamp - 1);
    });
  });

  describe('Idempotency (Replay Protection)', () => {
    it('should produce same result on replay (1000× scenarios)', () => {
      const scenarios = 1000;

      for (let i = 0; i < scenarios; i++) {
        const update = {
          value: `data-${i}`,
          timestamp: 1000 + i,
          instanceId: 'i1'
        };

        // Apply once
        const result1 = merger.mergeLWW(null, update);

        // Replay same update
        const result2 = merger.mergeLWW(result1, update);

        // Should be idempotent (no change)
        expect(result2.value).to.equal(result1.value);
        expect(result2.timestamp).to.equal(result1.timestamp);
      }
    });
  });

  describe('CRDT Mathematical Properties', () => {
    it('should be commutative for all types (1000× scenarios)', () => {
      const scenarios = 1000;

      for (let i = 0; i < scenarios; i++) {
        // LWW
        const v1 = { value: 'a', timestamp: Math.random() * 1000, instanceId: 'i1' };
        const v2 = { value: 'b', timestamp: Math.random() * 1000, instanceId: 'i2' };
        
        const lww1 = merger.mergeLWW(v1, v2);
        const lww2 = merger.mergeLWW(v2, v1);
        expect(lww1.value).to.equal(lww2.value);

        // OR-Set
        const s1 = new Set([Math.floor(Math.random() * 10)]);
        const s2 = new Set([Math.floor(Math.random() * 10)]);
        
        const set1 = merger.mergeORSet(s1, s2);
        const set2 = merger.mergeORSet(s2, s1);
        expect(set1.size).to.equal(set2.size);

        // PN-Counter
        const c1 = {
          increments: new Map([['i1', Math.floor(Math.random() * 100)]]),
          decrements: new Map([['i1', Math.floor(Math.random() * 50)]])
        };
        const c2 = {
          increments: new Map([['i2', Math.floor(Math.random() * 100)]]),
          decrements: new Map([['i2', Math.floor(Math.random() * 50)]])
        };
        
        const cnt1 = merger.mergeCounter(c1, c2);
        const cnt2 = merger.mergeCounter(c2, c1);
        expect(merger.getCounterValue(cnt1)).to.equal(merger.getCounterValue(cnt2));
      }
    });
  });
});

