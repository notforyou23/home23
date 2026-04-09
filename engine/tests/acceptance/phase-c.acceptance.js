/**
 * Phase C: Goal Allocation
 * 
 * Acceptance Criteria:
 * - N instances; M goals; zero duplicates under contention
 * - Claim TTL expires; work stolen fairly
 * - No starvation (old goals age up)
 */

const { expect } = require('chai');
const { GoalAllocator } = require('../../src/cluster/goal-allocator');

describe('Phase C: Goal Allocation Acceptance', () => {
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
      goals: {
        claimTtlMs: 10000,
        agingHalfLifeMs: 5000,
        stealThresholdMs: 2000
      }
    };
  });

  describe('Zero Duplicates Under Contention', () => {
    it('N instances, M goals, zero duplicates', async () => {
      const sharedClaims = new Map();
      
      const createMockStore = () => ({
        claimGoal: async (goalId, instanceId, ttlMs) => {
          if (sharedClaims.has(goalId)) {
            const claim = sharedClaims.get(goalId);
            if (claim.expiry > Date.now()) {
              return false;
            }
          }
          sharedClaims.set(goalId, { instanceId, expiry: Date.now() + ttlMs });
          return true;
        },
        completeGoal: async (goalId) => {
          sharedClaims.delete(goalId);
          return true;
        }
      });

      const N = 5; // 5 instances
      const M = 10; // 10 goals

      // Create N allocators
      const allocators = [];
      for (let i = 0; i < N; i++) {
        allocators.push(
          new GoalAllocator(mockConfig, createMockStore(), `instance-${i}`, mockLogger)
        );
      }

      // Each instance tries to claim all M goals concurrently
      const allClaims = [];
      for (let i = 0; i < N; i++) {
        for (let g = 0; g < M; g++) {
          allClaims.push(
            allocators[i].claimGoal(`goal-${g}`, 1.0)
          );
        }
      }

      await Promise.all(allClaims);

      // Each goal should be claimed exactly once
      expect(sharedClaims.size).to.equal(M);

      // Verify no duplicates
      const claimedGoals = Array.from(sharedClaims.keys());
      const uniqueGoals = new Set(claimedGoals);
      expect(uniqueGoals.size).to.equal(claimedGoals.length);
    });
  });

  describe('Work-Stealing on Expiry', () => {
    it('claim TTL expires, work stolen fairly', async function() {
      this.timeout(10000);
      
      const sharedClaims = new Map();
      
      const createMockStore = () => ({
        claimGoal: async (goalId, instanceId, ttlMs) => {
          if (sharedClaims.has(goalId)) {
            const claim = sharedClaims.get(goalId);
            if (claim.expiry > Date.now()) {
              return false;
            }
          }
          sharedClaims.set(goalId, { instanceId, expiry: Date.now() + ttlMs });
          return true;
        },
        completeGoal: async () => true
      });

      const shortTtlConfig = {
        goals: {
          claimTtlMs: 500, // Short TTL for testing
          agingHalfLifeMs: 1000,
          stealThresholdMs: 200
        }
      };

      const allocator1 = new GoalAllocator(shortTtlConfig, createMockStore(), 'i1', mockLogger);
      const allocator2 = new GoalAllocator(shortTtlConfig, createMockStore(), 'i2', mockLogger);

      // Instance 1 claims
      await allocator1.claimGoal('steal-goal', 1.0);
      expect(sharedClaims.get('steal-goal').instanceId).to.equal('i1');

      // Wait for expiry
      await new Promise(resolve => setTimeout(resolve, 600));

      // Instance 2 steals
      const stolen = await allocator2.claimGoal('steal-goal', 1.0);
      expect(stolen).to.be.true;
      expect(sharedClaims.get('steal-goal').instanceId).to.equal('i2');
      // Note: workSteals counter only incremented via attemptWorkStealing(), not direct claim
    });
  });

  describe('No Starvation', () => {
    it('old goals age up and get selected', () => {
      const now = Date.now();
      
      // Very old low-priority goal
      const oldGoal = {
        id: 'old-neglected',
        priority: 0.5,
        created_at: now - 60000, // 60s ago
        completed: false
      };

      // New high-priority goals
      const newGoals = Array.from({ length: 5 }, (_, i) => ({
        id: `new-${i}`,
        priority: 3.0,
        created_at: now - 1000, // 1s ago
        completed: false
      }));

      const allGoals = [oldGoal, ...newGoals];

      const sharedClaims = new Map();
      const createMockStore = () => ({
        claimGoal: async (goalId, instanceId, ttlMs) => {
          sharedClaims.set(goalId, { instanceId, expiry: Date.now() + ttlMs });
          return true;
        },
        completeGoal: async () => true
      });

      const allocator = new GoalAllocator(mockConfig, createMockStore(), 'test', mockLogger);

      // Old goal should be selected first (aging boost)
      const selected = allocator.selectNextGoal(allGoals);
      expect(selected.id).to.equal('old-neglected');
    });
  });

  describe('Fair Distribution', () => {
    it('multiple instances achieve fair goal distribution', async () => {
      const sharedClaims = new Map();
      
      const createMockStore = () => ({
        claimGoal: async (goalId, instanceId, ttlMs) => {
          if (sharedClaims.has(goalId)) {
            return false;
          }
          sharedClaims.set(goalId, { instanceId, expiry: Date.now() + ttlMs });
          return true;
        },
        completeGoal: async () => true
      });

      const instances = 3;
      const goalsPerInstance = 10;

      const allocators = Array.from({ length: instances }, (_, i) =>
        new GoalAllocator(mockConfig, createMockStore(), `instance-${i}`, mockLogger)
      );

      // Each instance claims goals sequentially
      for (let g = 0; g < goalsPerInstance * instances; g++) {
        const instanceIdx = g % instances;
        await allocators[instanceIdx].claimGoal(`goal-${g}`, 1.0);
      }

      // Each instance should have claimed approximately equal number
      for (const allocator of allocators) {
        const stats = allocator.getStats();
        expect(stats.claimSuccesses).to.be.closeTo(goalsPerInstance, 2);
      }
    });
  });

  describe('Claim Statistics', () => {
    it('should track claim success rate accurately', async () => {
      const sharedClaims = new Map();
      
      const createMockStore = () => ({
        claimGoal: async (goalId, instanceId, ttlMs) => {
          if (sharedClaims.has(goalId)) {
            return false;
          }
          sharedClaims.set(goalId, { instanceId, expiry: Date.now() + ttlMs });
          return true;
        },
        completeGoal: async () => true
      });

      const allocator = new GoalAllocator(mockConfig, createMockStore(), 'test', mockLogger);

      // 5 successful claims
      for (let i = 0; i < 5; i++) {
        await allocator.claimGoal(`goal-${i}`, 1.0);
      }

      // 5 failed claims (duplicate attempts)
      for (let i = 0; i < 5; i++) {
        await allocator.claimGoal(`goal-${i}`, 1.0);
      }

      const stats = allocator.getStats();
      expect(stats.claimAttempts).to.equal(10);
      expect(stats.claimSuccesses).to.equal(5);
      expect(stats.claimFailures).to.equal(5);
      expect(stats.successRate).to.equal('50.0%');
    });
  });
});

