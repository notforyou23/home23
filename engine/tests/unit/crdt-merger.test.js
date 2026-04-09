/**
 * Unit tests for CRDTMerger
 * 
 * Tests CRDT merge algorithms for correctness and convergence
 */

const { expect } = require('chai');
const { CRDTMerger } = require('../../src/cluster/backends/crdt-merger');

describe('CRDTMerger', () => {
  let merger;
  let mockLogger;

  beforeEach(() => {
    mockLogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {}
    };
    merger = new CRDTMerger(mockLogger);
  });

  describe('mergeLWW (Last-Writer-Wins)', () => {
    it('should keep newer value', () => {
      const local = {
        value: 'old',
        timestamp: 1000,
        instanceId: 'cosmo-1'
      };
      const remote = {
        value: 'new',
        timestamp: 2000,
        instanceId: 'cosmo-2'
      };
      
      const result = merger.mergeLWW(local, remote);
      expect(result.value).to.equal('new');
      expect(result.timestamp).to.equal(2000);
    });

    it('should keep local if newer', () => {
      const local = {
        value: 'newer',
        timestamp: 3000,
        instanceId: 'cosmo-1'
      };
      const remote = {
        value: 'older',
        timestamp: 1000,
        instanceId: 'cosmo-2'
      };
      
      const result = merger.mergeLWW(local, remote);
      expect(result.value).to.equal('newer');
    });

    it('should use instanceId as tiebreaker when timestamps equal', () => {
      const local = {
        value: 'from-a',
        timestamp: 1000,
        instanceId: 'cosmo-a'
      };
      const remote = {
        value: 'from-z',
        timestamp: 1000,
        instanceId: 'cosmo-z'
      };
      
      const result = merger.mergeLWW(local, remote);
      // cosmo-z > cosmo-a lexicographically
      expect(result.value).to.equal('from-z');
    });

    it('should handle tombstones (deletes)', () => {
      const local = {
        value: 'exists',
        timestamp: 1000,
        instanceId: 'cosmo-1',
        tombstone: false
      };
      const remote = {
        value: null,
        timestamp: 2000,
        instanceId: 'cosmo-2',
        tombstone: true,
        deleted: true
      };
      
      const result = merger.mergeLWW(local, remote);
      expect(result.tombstone).to.be.true;
      expect(result.timestamp).to.equal(2000);
    });

    it('should reject old tombstone', () => {
      const local = {
        value: 'current',
        timestamp: 3000,
        instanceId: 'cosmo-1'
      };
      const remote = {
        tombstone: true,
        timestamp: 1000,
        instanceId: 'cosmo-2'
      };
      
      const result = merger.mergeLWW(local, remote);
      expect(result.value).to.equal('current');
      expect(result.tombstone).to.not.be.true;
    });

    it('should handle null local (first write)', () => {
      const remote = {
        value: 'first',
        timestamp: 1000,
        instanceId: 'cosmo-1'
      };
      
      const result = merger.mergeLWW(null, remote);
      expect(result).to.deep.equal(remote);
    });

    it('should handle null remote', () => {
      const local = {
        value: 'exists',
        timestamp: 1000,
        instanceId: 'cosmo-1'
      };
      
      const result = merger.mergeLWW(local, null);
      expect(result).to.deep.equal(local);
    });
  });

  describe('mergeORSet (Add-Wins Set)', () => {
    it('should union two sets', () => {
      const local = new Set(['a', 'b', 'c']);
      const remote = new Set(['c', 'd', 'e']);
      
      const result = merger.mergeORSet(local, remote);
      
      expect(result).to.be.instanceOf(Set);
      expect(result.size).to.equal(5);
      expect(result.has('a')).to.be.true;
      expect(result.has('b')).to.be.true;
      expect(result.has('c')).to.be.true;
      expect(result.has('d')).to.be.true;
      expect(result.has('e')).to.be.true;
    });

    it('should handle arrays', () => {
      const local = ['a', 'b'];
      const remote = ['b', 'c'];
      
      const result = merger.mergeORSet(local, remote);
      
      expect(result.size).to.equal(3);
      expect(result.has('a')).to.be.true;
      expect(result.has('b')).to.be.true;
      expect(result.has('c')).to.be.true;
    });

    it('should handle empty sets', () => {
      const local = new Set();
      const remote = new Set(['a', 'b']);
      
      const result = merger.mergeORSet(local, remote);
      expect(result.size).to.equal(2);
    });

    it('should be commutative (local ∪ remote = remote ∪ local)', () => {
      const set1 = new Set(['a', 'b']);
      const set2 = new Set(['c', 'd']);
      
      const result1 = merger.mergeORSet(set1, set2);
      const result2 = merger.mergeORSet(set2, set1);
      
      expect(Array.from(result1).sort()).to.deep.equal(Array.from(result2).sort());
    });

    it('should be idempotent (merge(A, A) = A)', () => {
      const set1 = new Set(['a', 'b', 'c']);
      
      const result = merger.mergeORSet(set1, set1);
      
      expect(result.size).to.equal(3);
      expect(Array.from(result).sort()).to.deep.equal(['a', 'b', 'c']);
    });
  });

  describe('mergeCounter (PN-Counter)', () => {
    it('should merge increments and decrements independently', () => {
      const local = {
        increments: new Map([['cosmo-1', 5]]),
        decrements: new Map([['cosmo-1', 2]])
      };
      const remote = {
        increments: new Map([['cosmo-2', 3]]),
        decrements: new Map([['cosmo-2', 1]])
      };
      
      const result = merger.mergeCounter(local, remote);
      
      expect(result.increments.get('cosmo-1')).to.equal(5);
      expect(result.increments.get('cosmo-2')).to.equal(3);
      expect(result.decrements.get('cosmo-1')).to.equal(2);
      expect(result.decrements.get('cosmo-2')).to.equal(1);
    });

    it('should take max for same instance', () => {
      const local = {
        increments: new Map([['cosmo-1', 10]]),
        decrements: new Map([['cosmo-1', 3]])
      };
      const remote = {
        increments: new Map([['cosmo-1', 15]]), // Higher
        decrements: new Map([['cosmo-1', 2]])  // Lower
      };
      
      const result = merger.mergeCounter(local, remote);
      
      expect(result.increments.get('cosmo-1')).to.equal(15); // Max
      expect(result.decrements.get('cosmo-1')).to.equal(3);  // Max
    });

    it('should handle object format', () => {
      const local = {
        increments: { 'cosmo-1': 5 },
        decrements: { 'cosmo-1': 2 }
      };
      const remote = {
        increments: { 'cosmo-2': 3 },
        decrements: { 'cosmo-2': 1 }
      };
      
      const result = merger.mergeCounter(local, remote);
      
      expect(result.increments).to.be.instanceOf(Map);
      expect(result.decrements).to.be.instanceOf(Map);
    });

    it('should be commutative', () => {
      const counter1 = {
        increments: new Map([['cosmo-1', 5]]),
        decrements: new Map([['cosmo-1', 2]])
      };
      const counter2 = {
        increments: new Map([['cosmo-2', 3]]),
        decrements: new Map([['cosmo-2', 1]])
      };
      
      const result1 = merger.mergeCounter(counter1, counter2);
      const result2 = merger.mergeCounter(counter2, counter1);
      
      expect(merger.getCounterValue(result1)).to.equal(merger.getCounterValue(result2));
    });
  });

  describe('getCounterValue', () => {
    it('should calculate sum of increments - decrements', () => {
      const counter = {
        increments: new Map([
          ['cosmo-1', 10],
          ['cosmo-2', 5]
        ]),
        decrements: new Map([
          ['cosmo-1', 3],
          ['cosmo-2', 2]
        ])
      };
      
      const value = merger.getCounterValue(counter);
      expect(value).to.equal(10); // (10+5) - (3+2) = 10
    });

    it('should handle empty counter', () => {
      const value = merger.getCounterValue(null);
      expect(value).to.equal(0);
    });
  });

  describe('mergeVersionVector', () => {
    it('should take component-wise max', () => {
      const local = {
        'cosmo-1': 10,
        'cosmo-2': 5
      };
      const remote = {
        'cosmo-1': 8,
        'cosmo-2': 12,
        'cosmo-3': 3
      };
      
      const result = merger.mergeVersionVector(local, remote);
      
      expect(result['cosmo-1']).to.equal(10); // max(10, 8)
      expect(result['cosmo-2']).to.equal(12); // max(5, 12)
      expect(result['cosmo-3']).to.equal(3);  // max(0, 3)
    });
  });

  describe('compareVersionVectors', () => {
    it('should detect equal vectors', () => {
      const v1 = { 'cosmo-1': 5, 'cosmo-2': 3 };
      const v2 = { 'cosmo-1': 5, 'cosmo-2': 3 };
      
      expect(merger.compareVersionVectors(v1, v2)).to.equal('equal');
    });

    it('should detect v1 newer', () => {
      const v1 = { 'cosmo-1': 10, 'cosmo-2': 5 };
      const v2 = { 'cosmo-1': 8, 'cosmo-2': 5 };
      
      expect(merger.compareVersionVectors(v1, v2)).to.equal('v1_newer');
    });

    it('should detect v2 newer', () => {
      const v1 = { 'cosmo-1': 5 };
      const v2 = { 'cosmo-1': 10 };
      
      expect(merger.compareVersionVectors(v1, v2)).to.equal('v2_newer');
    });

    it('should detect concurrent updates', () => {
      const v1 = { 'cosmo-1': 10, 'cosmo-2': 3 };
      const v2 = { 'cosmo-1': 5, 'cosmo-2': 8 };
      
      // Neither dominates the other = concurrent
      expect(merger.compareVersionVectors(v1, v2)).to.equal('concurrent');
    });
  });

  describe('Tombstones', () => {
    it('should create tombstone', () => {
      const tombstone = merger.createTombstone('cosmo-1', 12345);
      
      expect(tombstone.tombstone).to.be.true;
      expect(tombstone.deleted).to.be.true;
      expect(tombstone.deletedBy).to.equal('cosmo-1');
      expect(tombstone.timestamp).to.equal(12345);
      expect(tombstone.value).to.be.null;
    });

    it('should detect tombstone', () => {
      const tombstone = {
        tombstone: true,
        value: null
      };
      
      expect(merger.isTombstone(tombstone)).to.be.true;
    });

    it('should detect deleted marker', () => {
      const deleted = {
        deleted: true,
        value: null
      };
      
      expect(merger.isTombstone(deleted)).to.be.true;
    });

    it('should not detect regular value as tombstone', () => {
      const regular = {
        value: 'data',
        timestamp: 1000
      };
      
      expect(merger.isTombstone(regular)).to.be.false;
    });
  });

  describe('mergeField (Generic)', () => {
    it('should route to LWW for register type', () => {
      const local = { value: 'old', timestamp: 1000, instanceId: 'a' };
      const remote = { value: 'new', timestamp: 2000, instanceId: 'b' };
      
      const result = merger.mergeField('register', local, remote);
      expect(result.value).to.equal('new');
    });

    it('should route to OR-Set for set type', () => {
      const local = new Set(['a', 'b']);
      const remote = new Set(['c', 'd']);
      
      const result = merger.mergeField('set', local, remote);
      expect(result.size).to.equal(4);
    });

    it('should route to PN-Counter for counter type', () => {
      const local = {
        increments: new Map([['cosmo-1', 5]]),
        decrements: new Map([['cosmo-1', 2]])
      };
      const remote = {
        increments: new Map([['cosmo-2', 3]]),
        decrements: new Map([['cosmo-2', 1]])
      };
      
      const result = merger.mergeField('counter', local, remote);
      expect(result.increments.size).to.equal(2);
    });

    it('should default to LWW for unknown type', () => {
      const local = { value: 'old', timestamp: 1000, instanceId: 'a' };
      const remote = { value: 'new', timestamp: 2000, instanceId: 'b' };
      
      const result = merger.mergeField('unknown_type', local, remote);
      expect(result.value).to.equal('new');
    });
  });

  describe('CRDT Properties', () => {
    describe('Commutativity (merge(A,B) = merge(B,A))', () => {
      it('LWW should be commutative', () => {
        const v1 = { value: 'a', timestamp: 1000, instanceId: 'x' };
        const v2 = { value: 'b', timestamp: 2000, instanceId: 'y' };
        
        const result1 = merger.mergeLWW(v1, v2);
        const result2 = merger.mergeLWW(v2, v1);
        
        expect(result1.value).to.equal(result2.value);
      });

      it('OR-Set should be commutative', () => {
        const set1 = new Set(['a', 'b']);
        const set2 = new Set(['c', 'd']);
        
        const result1 = merger.mergeORSet(set1, set2);
        const result2 = merger.mergeORSet(set2, set1);
        
        expect(Array.from(result1).sort()).to.deep.equal(Array.from(result2).sort());
      });

      it('PN-Counter should be commutative', () => {
        const c1 = {
          increments: new Map([['i1', 5]]),
          decrements: new Map([['i1', 2]])
        };
        const c2 = {
          increments: new Map([['i2', 3]]),
          decrements: new Map([['i2', 1]])
        };
        
        const result1 = merger.mergeCounter(c1, c2);
        const result2 = merger.mergeCounter(c2, c1);
        
        expect(merger.getCounterValue(result1)).to.equal(merger.getCounterValue(result2));
      });
    });

    describe('Associativity (merge(merge(A,B),C) = merge(A,merge(B,C)))', () => {
      it('OR-Set should be associative', () => {
        const s1 = new Set(['a']);
        const s2 = new Set(['b']);
        const s3 = new Set(['c']);
        
        const result1 = merger.mergeORSet(merger.mergeORSet(s1, s2), s3);
        const result2 = merger.mergeORSet(s1, merger.mergeORSet(s2, s3));
        
        expect(Array.from(result1).sort()).to.deep.equal(Array.from(result2).sort());
      });
    });

    describe('Idempotence (merge(A,A) = A)', () => {
      it('LWW should be idempotent', () => {
        const v = { value: 'test', timestamp: 1000, instanceId: 'i1' };
        
        const result = merger.mergeLWW(v, v);
        expect(result).to.deep.equal(v);
      });

      it('OR-Set should be idempotent', () => {
        const set = new Set(['a', 'b', 'c']);
        
        const result = merger.mergeORSet(set, set);
        expect(result.size).to.equal(3);
        expect(Array.from(result).sort()).to.deep.equal(['a', 'b', 'c']);
      });
    });
  });

  describe('Convergence', () => {
    it('should converge to same state regardless of merge order', () => {
      // Three concurrent updates
      const v1 = { value: 'a', timestamp: 1000, instanceId: 'cosmo-1' };
      const v2 = { value: 'b', timestamp: 2000, instanceId: 'cosmo-2' };
      const v3 = { value: 'c', timestamp: 3000, instanceId: 'cosmo-3' };
      
      // Different merge orders
      const path1 = merger.mergeLWW(merger.mergeLWW(v1, v2), v3);
      const path2 = merger.mergeLWW(merger.mergeLWW(v1, v3), v2);
      const path3 = merger.mergeLWW(v1, merger.mergeLWW(v2, v3));
      
      // All should converge to v3 (newest timestamp)
      expect(path1.value).to.equal('c');
      expect(path2.value).to.equal('c');
      expect(path3.value).to.equal('c');
    });
  });
});

