/**
 * Multi-Instance Goal Claiming Tests
 * 
 * Verifies zero duplicate claims under contention
 */

const { expect } = require('chai');
const { GoalAllocator } = require('../../src/cluster/goal-allocator');

describe('Multi-Instance: Goal Claiming', function() {
  this.timeout(30000);

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
        claimTtlMs: 5000,
        agingHalfLifeMs: 3000,
        stealThresholdMs: 1000
      }
    };
  });

  describe('Concurrent Claiming (Simulated)', () => {
    it('should prevent duplicate claims', async () => {
      // Simulate shared state with proper locking
      const sharedClaims = new Map();
      
      // Create mock store that simulates atomic claiming
      const createMockStore = () => ({
        claimGoal: async (goalId, instanceId, ttlMs) => {
          // Simulate race condition with small random delay
          await new Promise(resolve => setTimeout(resolve, Math.random() * 10));
          
          if (sharedClaims.has(goalId)) {
            const claim = sharedClaims.get(goalId);
            if (claim.expiry > Date.now()) {
              return false; // Already claimed
            }
          }
          
          sharedClaims.set(goalId, {
            instanceId,
            expiry: Date.now() + ttlMs
          });
          return true;
        },
        completeGoal: async (goalId) => {
          sharedClaims.delete(goalId);
          return true;
        }
      });

      // Create 3 allocators (simulating 3 instances)
      const allocator1 = new GoalAllocator(mockConfig, createMockStore(), 'instance-1', mockLogger);
      const allocator2 = new GoalAllocator(mockConfig, createMockStore(), 'instance-2', mockLogger);
      const allocator3 = new GoalAllocator(mockConfig, createMockStore(), 'instance-3', mockLogger);

      // All try to claim same goal concurrently
      const results = await Promise.all([
        allocator1.claimGoal('contested-goal', 1.0),
        allocator2.claimGoal('contested-goal', 1.0),
        allocator3.claimGoal('contested-goal', 1.0)
      ]);

      // Exactly one should succeed
      const successes = results.filter(r => r === true).length;
      expect(successes).to.equal(1);
    });

    it('should distribute goals fairly across instances', async () => {
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

      const allocator1 = new GoalAllocator(mockConfig, createMockStore(), 'instance-1', mockLogger);
      const allocator2 = new GoalAllocator(mockConfig, createMockStore(), 'instance-2', mockLogger);
      const allocator3 = new GoalAllocator(mockConfig, createMockStore(), 'instance-3', mockLogger);

      // Each instance tries to claim different goals
      await allocator1.claimGoal('goal1', 1.0);
      await allocator2.claimGoal('goal2', 1.0);
      await allocator3.claimGoal('goal3', 1.0);

      // All should succeed (different goals)
      expect(allocator1.claimSuccesses).to.equal(1);
      expect(allocator2.claimSuccesses).to.equal(1);
      expect(allocator3.claimSuccesses).to.equal(1);
      expect(sharedClaims.size).to.equal(3);
    });
  });

  describe('Work-Stealing', () => {
    it('should reclaim expired goals', async function() {
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

      const allocator1 = new GoalAllocator(
        { goals: { claimTtlMs: 500, agingHalfLifeMs: 1000, stealThresholdMs: 200 } },
        createMockStore(),
        'instance-1',
        mockLogger
      );

      const allocator2 = new GoalAllocator(
        { goals: { claimTtlMs: 500, agingHalfLifeMs: 1000, stealThresholdMs: 200 } },
        createMockStore(),
        'instance-2',
        mockLogger
      );

      // Instance 1 claims goal
      await allocator1.claimGoal('steal-test', 1.0);
      
      // Wait for claim to expire
      await new Promise(resolve => setTimeout(resolve, 600));

      // Instance 2 steals
      const stolen = await allocator2.claimGoal('steal-test', 1.0);
      expect(stolen).to.be.true;
      expect(allocator2.claimSuccesses).to.equal(1);
    });

    it('should find multiple stealable goals', () => {
      const createMockStore = () => ({ claimGoal: async () => true, completeGoal: async () => true });
      const testAllocator = new GoalAllocator(mockConfig, createMockStore(), 'test', mockLogger);
      
      const now = Date.now();
      const goals = [
        { id: 'g1', claimed_by: 'i1', claim_expires: now - 1000, completed: false }, // Expired
        { id: 'g2', claimed_by: 'i2', claim_expires: now + 500, completed: false },  // Expiring soon
        { id: 'g3', claimed_by: 'i3', claim_expires: now + 10000, completed: false } // Active
      ];

      const stealable = testAllocator.findStealableGoals(goals);
      expect(stealable).to.have.lengthOf(2); // g1 and g2
    });
  });

  describe('No Starvation', () => {
    it('aging priority prevents low-priority goals from starving', () => {
      const createMockStore = () => ({ claimGoal: async () => true, completeGoal: async () => true });
      const testAllocator = new GoalAllocator(mockConfig, createMockStore(), 'test', mockLogger);
      
      const now = Date.now();
      
      // Create goals with different priorities and ages
      const goals = [];
      for (let i = 0; i < 10; i++) {
        goals.push({
          id: `goal-${i}`,
          priority: Math.random() * 5, // Random priority 0-5
          created_at: now - (Math.random() * 60000), // Random age 0-60s
          completed: false
        });
      }

      // Select goals repeatedly
      const selected = [];
      for (let i = 0; i < goals.length; i++) {
        const goal = testAllocator.selectNextGoal(goals.filter(g => !selected.includes(g.id)));
        if (goal) {
          selected.push(goal.id);
        }
      }

      // All goals should eventually be selected
      expect(selected).to.have.lengthOf(goals.length);
    });
  });

  describe('Performance Under Load', () => {
    it('should handle rapid claim attempts', async () => {
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

      const allocator = new GoalAllocator(mockConfig, createMockStore(), 'rapid', mockLogger);

      // Rapid claims
      const claims = [];
      for (let i = 0; i < 100; i++) {
        claims.push(allocator.claimGoal(`goal-${i}`, 1.0));
      }

      await Promise.all(claims);

      const stats = allocator.getStats();
      expect(stats.claimAttempts).to.equal(100);
      expect(stats.claimSuccesses).to.equal(100);
    });
  });

  describe('Stress Distribution', () => {
    function createSharedStore(ttlMs = 150) {
      const claims = new Map();

      return {
        claimGoal: async (goalId, instanceId, ttlMsOverride = ttlMs) => {
          await new Promise(resolve => setTimeout(resolve, Math.random() * 5));

          const now = Date.now();
          const existing = claims.get(goalId);
          if (existing && existing.expiry > now && existing.instanceId !== instanceId) {
            return false;
          }

          claims.set(goalId, {
            instanceId,
            expiry: now + ttlMsOverride
          });
          return true;
        },
        completeGoal: async (goalId) => {
          claims.delete(goalId);
          return true;
        },
        releaseGoal: async (goalId, instanceId) => {
          const existing = claims.get(goalId);
          if (existing && existing.instanceId !== instanceId) {
            return false;
          }
          claims.delete(goalId);
          return true;
        }
      };
    }

    it('maintains unique ownership and balanced distribution under high churn', async function() {
      this.timeout(10000);

      const sharedStore = createSharedStore();
      const churnConfig = {
        goals: {
          claimTtlMs: 150,
          agingHalfLifeMs: 400,
          stealThresholdMs: 120
        }
      };

      const allocators = Array.from({ length: 4 }).map((_, index) =>
        new GoalAllocator(churnConfig, sharedStore, `inst-${index + 1}`, mockLogger)
      );

      const totalGoals = 60;
      const successCounts = Array(allocators.length).fill(0);

      for (let i = 0; i < totalGoals; i++) {
        const goalId = `stress-goal-${i}`;

        const order = allocators.map((_, index) => index);
        for (let j = order.length - 1; j > 0; j--) {
          const swapIndex = Math.floor(Math.random() * (j + 1));
          const temp = order[j];
          order[j] = order[swapIndex];
          order[swapIndex] = temp;
        }

        const results = await Promise.all(
          order.map(idx => allocators[idx].claimGoal(goalId, Math.random() * 5 + 1))
        );

        const winners = results
          .map((result, orderIdx) => ({ result, idx: order[orderIdx] }))
          .filter(entry => entry.result === true);

        expect(winners, 'exactly one instance should win the claim race').to.have.lengthOf(1);

        const winnerIndex = winners[0].idx;
        successCounts[winnerIndex]++;

        await allocators[winnerIndex].releaseGoal(goalId);
      }

      const totalClaims = allocators.reduce((sum, allocator) => sum + allocator.claimSuccesses, 0);
      const totalAttempts = allocators.reduce((sum, allocator) => sum + allocator.claimAttempts, 0);

      expect(totalClaims).to.equal(totalGoals);
      expect(totalAttempts).to.equal(totalGoals * allocators.length);

      successCounts.forEach(count => {
        expect(count).to.be.greaterThan(5);
      });

      const maxClaims = Math.max(...successCounts);
      const minClaims = Math.min(...successCounts);
      const meanClaims = totalGoals / allocators.length;

      expect(maxClaims, 'no instance should capture more than twice the mean workload').to.be.at.most(meanClaims * 2);
      expect(minClaims, 'all instances should receive a meaningful share of goals').to.be.at.least(meanClaims * 0.25);
    });
  });
});
