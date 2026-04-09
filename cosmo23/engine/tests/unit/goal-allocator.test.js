/**
 * Unit tests for GoalAllocator
 */

const { expect } = require('chai');
const { GoalAllocator } = require('../../src/cluster/goal-allocator');

describe('GoalAllocator', () => {
  let allocator;
  let mockStateStore;
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
        claimTtlMs: 10000, // 10s for testing
        agingHalfLifeMs: 5000, // 5s
        stealThresholdMs: 2000 // 2s
      }
    };

    // Mock state store that tracks claims
    const claims = new Map();
    mockStateStore = {
      claimGoal: async (goalId, instanceId, ttlMs) => {
        if (claims.has(goalId)) {
          const claim = claims.get(goalId);
          if (claim.expiry > Date.now()) {
            return false; // Still claimed
          }
        }
        claims.set(goalId, {
          instanceId,
          expiry: Date.now() + ttlMs
        });
        return true;
      },
      completeGoal: async (goalId) => {
        claims.delete(goalId);
        return true;
      },
      releaseGoal: async (goalId, instanceId) => {
        const claim = claims.get(goalId);
        if (claim && claim.instanceId !== instanceId) {
          return false;
        }
        claims.delete(goalId);
        return true;
      }
    };

    allocator = new GoalAllocator(mockConfig, mockStateStore, 'test-instance-1', mockLogger);
  });

  describe('claimGoal', () => {
    it('should claim unclaimed goal', async () => {
      const claimed = await allocator.claimGoal('goal1', 1.0);
      expect(claimed).to.be.true;
      expect(allocator.claimSuccesses).to.equal(1);
    });

    it('should fail to claim already-claimed goal', async () => {
      await allocator.claimGoal('goal1', 1.0);
      
      // Second claim should fail
      const claimed = await allocator.claimGoal('goal1', 1.0);
      expect(claimed).to.be.false;
      expect(allocator.claimFailures).to.equal(1);
    });

    it('should track claim statistics', async () => {
      await allocator.claimGoal('goal1', 1.0);
      await allocator.claimGoal('goal2', 1.0);
      await allocator.claimGoal('goal1', 1.0); // Fail (already claimed)

      const stats = allocator.getStats();
      expect(stats.claimAttempts).to.equal(3);
      expect(stats.claimSuccesses).to.equal(2);
      expect(stats.claimFailures).to.equal(1);
    });
  });

  describe('completeGoal', () => {
    it('should mark goal as completed', async () => {
      await allocator.claimGoal('goal1', 1.0);
      const completed = await allocator.completeGoal('goal1');
      
      expect(completed).to.be.true;
      expect(allocator.completions).to.equal(1);
    });

    it('should release goal claims', async () => {
      await allocator.claimGoal('goal1', 1.0);
      const released = await allocator.releaseGoal('goal1');
      expect(released).to.be.true;
      expect(allocator.claimReleases).to.equal(1);

      const reclaimed = await allocator.claimGoal('goal1', 1.0);
      expect(reclaimed).to.be.true;
    });
  });

  describe('calculateAgingPriority', () => {
    it('should increase priority with age', () => {
      const basePriority = 1.0;
      const oldGoal = Date.now() - 10000; // 10s ago
      const newGoal = Date.now() - 1000;  // 1s ago

      const oldPriority = allocator.calculateAgingPriority(basePriority, oldGoal);
      const newPriority = allocator.calculateAgingPriority(basePriority, newGoal);

      expect(oldPriority).to.be.above(newPriority);
    });

    it('should double priority after aging half-life', () => {
      const basePriority = 1.0;
      const halfLifeAgo = Date.now() - allocator.agingHalfLifeMs;

      const aged = allocator.calculateAgingPriority(basePriority, halfLifeAgo);

      expect(aged).to.be.closeTo(2.0, 0.1); // ~2.0 (base + aging)
    });

    it('should prevent negative priorities', () => {
      const basePriority = 1.0;
      const futureGoal = Date.now() + 1000; // Future timestamp (shouldn't happen)

      const priority = allocator.calculateAgingPriority(basePriority, futureGoal);

      expect(priority).to.be.at.least(0);
    });
  });

  describe('selectNextGoal', () => {
    it('should select highest priority goal', () => {
      const goals = [
        { id: 'g1', priority: 1.0, created_at: Date.now(), completed: false },
        { id: 'g2', priority: 5.0, created_at: Date.now(), completed: false },
        { id: 'g3', priority: 3.0, created_at: Date.now(), completed: false }
      ];

      const selected = allocator.selectNextGoal(goals);
      expect(selected.id).to.equal('g2'); // Highest priority
    });

    it('should boost old goals via aging', () => {
      const now = Date.now();
      const goals = [
        { id: 'new', priority: 2.0, created_at: now - 1000, completed: false },
        { id: 'old', priority: 1.0, created_at: now - 20000, completed: false } // Much older
      ];

      const selected = allocator.selectNextGoal(goals);
      
      // Old goal should win despite lower base priority
      expect(selected.id).to.equal('old');
    });

    it('should skip completed goals', () => {
      const goals = [
        { id: 'g1', priority: 10.0, created_at: Date.now(), completed: true },
        { id: 'g2', priority: 1.0, created_at: Date.now(), completed: false }
      ];

      const selected = allocator.selectNextGoal(goals);
      expect(selected.id).to.equal('g2');
    });

    it('should skip currently claimed goals', () => {
      const goals = [
        { id: 'g1', priority: 5.0, created_at: Date.now(), completed: false, claimed_by: 'other-instance', claim_expires: Date.now() + 10000 },
        { id: 'g2', priority: 1.0, created_at: Date.now(), completed: false }
      ];

      const selected = allocator.selectNextGoal(goals);
      expect(selected.id).to.equal('g2');
    });

    it('should return null if no workable goals', () => {
      const goals = [
        { id: 'g1', priority: 1.0, created_at: Date.now(), completed: true },
        { id: 'g2', priority: 1.0, created_at: Date.now(), completed: true }
      ];

      const selected = allocator.selectNextGoal(goals);
      expect(selected).to.be.null;
    });

    it('should return null for empty goal list', () => {
      const selected = allocator.selectNextGoal([]);
      expect(selected).to.be.null;
    });
  });

  describe('findStealableGoals', () => {
    it('should find goals with expired claims', () => {
      const goals = [
        { 
          id: 'expired', 
          priority: 1.0, 
          created_at: Date.now(), 
          completed: false,
          claimed_by: 'other-instance',
          claim_expires: Date.now() - 1000 // Expired 1s ago
        }
      ];

      const stealable = allocator.findStealableGoals(goals);
      expect(stealable).to.have.lengthOf(1);
      expect(stealable[0].id).to.equal('expired');
    });

    it('should find goals expiring soon', () => {
      const goals = [
        { 
          id: 'expiring', 
          priority: 1.0, 
          created_at: Date.now(), 
          completed: false,
          claimed_by: 'other-instance',
          claim_expires: Date.now() + 1000 // Expires in 1s (within threshold of 2s)
        }
      ];

      const stealable = allocator.findStealableGoals(goals);
      expect(stealable).to.have.lengthOf(1);
    });

    it('should not find goals with active claims', () => {
      const goals = [
        { 
          id: 'active', 
          priority: 1.0, 
          created_at: Date.now(), 
          completed: false,
          claimed_by: 'other-instance',
          claim_expires: Date.now() + 10000 // Expires in 10s (beyond threshold)
        }
      ];

      const stealable = allocator.findStealableGoals(goals);
      expect(stealable).to.be.empty;
    });

    it('should sort by expiry (most expired first)', () => {
      const goals = [
        { id: 'g1', claimed_by: 'i1', claim_expires: Date.now() + 500, completed: false },
        { id: 'g2', claimed_by: 'i2', claim_expires: Date.now() + 100, completed: false },
        { id: 'g3', claimed_by: 'i3', claim_expires: Date.now() + 1000, completed: false }
      ];

      const stealable = allocator.findStealableGoals(goals);
      
      expect(stealable[0].id).to.equal('g2'); // Expires soonest
      expect(stealable[1].id).to.equal('g1');
      expect(stealable[2].id).to.equal('g3');
    });
  });

  describe('attemptWorkStealing', () => {
    it('should steal expired goals', async () => {
      const stealableGoals = [
        { 
          id: 'steal1', 
          priority: 1.0, 
          created_at: Date.now(),
          claimed_by: 'other-instance',
          claim_expires: Date.now() - 1000, // Already expired
          canStealAt: Date.now() - 1000
        }
      ];

      const result = await allocator.attemptWorkStealing(stealableGoals);
      
      expect(result.stolen).to.equal(1);
      expect(result.failed).to.equal(0);
      expect(allocator.workSteals).to.equal(1);
    });

    it('should handle steal failures gracefully', async () => {
      // Mock store that always fails claims
      const failingStore = {
        claimGoal: async () => false,
        completeGoal: async () => true
      };

      const failingAllocator = new GoalAllocator(
        mockConfig,
        failingStore,
        'test',
        mockLogger
      );

      const stealableGoals = [
        { 
          id: 'fail', 
          priority: 1.0, 
          created_at: Date.now(),
          canStealAt: Date.now()
        }
      ];

      const result = await failingAllocator.attemptWorkStealing(stealableGoals);
      
      expect(result.stolen).to.equal(0);
      expect(result.failed).to.equal(1);
    });
  });

  describe('getStats', () => {
    it('should return comprehensive stats', async () => {
      await allocator.claimGoal('g1', 1.0);
      await allocator.claimGoal('g2', 1.0);
      await allocator.completeGoal('g1');

      const stats = allocator.getStats();
      
      expect(stats).to.have.property('claimAttempts', 2);
      expect(stats).to.have.property('claimSuccesses', 2);
      expect(stats).to.have.property('completions', 1);
      expect(stats).to.have.property('successRate');
    });

    it('should calculate success rate correctly', async () => {
      await allocator.claimGoal('g1', 1.0); // Success
      await allocator.claimGoal('g1', 1.0); // Fail (already claimed)

      const stats = allocator.getStats();
      expect(stats.successRate).to.equal('50.0%');
    });
  });

  describe('Fairness', () => {
    it('should prevent starvation via aging', () => {
      const now = Date.now();
      
      // Old low-priority goal vs new high-priority goal
      const oldGoal = {
        id: 'old',
        priority: 1.0,
        created_at: now - 30000, // 30s ago
        completed: false
      };

      const newGoal = {
        id: 'new',
        priority: 2.0,
        created_at: now - 100, // Very recent
        completed: false
      };

      const selected = allocator.selectNextGoal([oldGoal, newGoal]);
      
      // Old goal should win (aging boost overcomes priority difference)
      expect(selected.id).to.equal('old');
    });
  });

  describe('Specialization heuristics', () => {
    const specializationConfig = {
      goals: {
        claimTtlMs: 5000,
        agingHalfLifeMs: 2000,
        stealThresholdMs: 500
      },
      cluster: {
        specialization: {
          enabled: true,
          defaults: {
            boost: 2,
            penalty: 0.5,
            unmatchedPenalty: 0.9,
            minMultiplier: 0.3,
            maxMultiplier: 3,
            nonPreferredPenalty: 0.05
          },
          profiles: {
            'analysis-node': {
              agentTypes: ['analysis'],
              domains: ['governance'],
              keywords: ['audit', 'assessment']
            },
            'synthesis-node': {
              agentTypes: ['synthesis'],
              keywords: ['synthesize']
            }
          }
        }
      }
    };

    const createStateStore = () => {
      const claims = new Map();
      return {
        claimGoal: async (goalId, instanceId, ttlMs) => {
          if (claims.has(goalId)) {
            const claim = claims.get(goalId);
            if (claim.expiry > Date.now()) {
              return false;
            }
          }
          claims.set(goalId, { instanceId, expiry: Date.now() + ttlMs });
          return true;
        },
        completeGoal: async () => true,
        releaseGoal: async (goalId, instanceId) => {
          const claim = claims.get(goalId);
          if (claim && claim.instanceId !== instanceId) {
            return false;
          }
          claims.delete(goalId);
          return true;
        }
      };
    };

    it('boosts goals aligned with configured agent types', () => {
      const specializedAllocator = new GoalAllocator(
        specializationConfig,
        createStateStore(),
        'analysis-node',
        mockLogger
      );

      const goals = [
        {
          id: 'analysis-goal',
          priority: 1.0,
          created_at: Date.now(),
          completed: false,
          metadata: {
            agentTypeHint: 'analysis',
            guidedDomain: 'governance'
          }
        },
        {
          id: 'code-goal',
          priority: 2.5,
          created_at: Date.now(),
          completed: false,
          metadata: {
            agentTypeHint: 'code_execution'
          }
        }
      ];

      const selected = specializedAllocator.selectNextGoal(goals);
      expect(selected.id).to.equal('analysis-goal');
    });

    it('honors preferredInstance metadata when prioritizing goals', () => {
      const allocatorA = new GoalAllocator(
        specializationConfig,
        createStateStore(),
        'analysis-node',
        mockLogger
      );
      const allocatorB = new GoalAllocator(
        specializationConfig,
        createStateStore(),
        'synthesis-node',
        mockLogger
      );

      const sharedGoals = [
        {
          id: 'shared-task',
          priority: 4.0,
          created_at: Date.now(),
          completed: false,
          metadata: {
            preferredInstance: 'synthesis-node'
          }
        },
        {
          id: 'fallback-task',
          priority: 2.0,
          created_at: Date.now(),
          completed: false,
          metadata: {
            agentTypeHint: 'analysis'
          }
        }
      ];

      const selectionA = allocatorA.selectNextGoal(sharedGoals);
      const selectionB = allocatorB.selectNextGoal(sharedGoals);

      expect(selectionA.id).to.equal('fallback-task');
      expect(selectionB.id).to.equal('shared-task');
    });

    it('records specialization claim telemetry', () => {
      const allocator = new GoalAllocator(
        specializationConfig,
        createStateStore(),
        'analysis-node',
        mockLogger
      );

      const goal = {
        id: 'spec-goal',
        priority: 1.0,
        created_at: Date.now(),
        metadata: {
          preferredInstance: 'analysis-node'
        }
      };

      allocator.recordClaim(goal);
      const stats = allocator.getStats();

      expect(stats.specializationStats.totalClaims).to.equal(1);
      expect(stats.specializationStats.preferredMatches).to.equal(1);
      expect(stats.specializationStats.claimsByPreferredInstance['analysis-node']).to.equal(1);
    });
  });

  describe('resetStats', () => {
    it('should reset all statistics', async () => {
      await allocator.claimGoal('g1', 1.0);
      await allocator.completeGoal('g1');

      allocator.resetStats();

      const stats = allocator.getStats();
      expect(stats.claimAttempts).to.equal(0);
      expect(stats.claimSuccesses).to.equal(0);
      expect(stats.completions).to.equal(0);
      expect(stats.specializationStats.totalClaims).to.equal(0);
    });
  });
});
