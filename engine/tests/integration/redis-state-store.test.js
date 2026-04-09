/**
 * Integration tests for RedisStateStore
 * 
 * Requires Redis running on localhost:6379
 * Run with: npm run test:integration
 */

const { expect } = require('chai');
const RedisStateStore = require('../../src/cluster/backends/redis-state-store');

describe('Integration: RedisStateStore', function() {
  this.timeout(10000); // Redis operations may take time

  let store;
  let mockConfig;
  let mockLogger;

  before(function() {
    // Check if Redis is available (skip tests if not)
    // This will be handled by try/catch in beforeEach
  });

  beforeEach(async function() {
    mockLogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {}
    };
    
    mockConfig = {
      instanceId: 'test-instance-1',
      stateStore: {
        url: process.env.REDIS_URL || 'redis://localhost:6379',
        compressionThreshold: 1024 // 1KB for testing
      },
      orchestrator: {
        leaderLeaseMs: 5000
      },
      healthCheckInterval: 3000,
      failureThreshold: 3
    };
    
    store = new RedisStateStore(mockConfig, mockLogger);
    
    try {
      await store.connect();
    } catch (error) {
      this.skip(); // Skip tests if Redis not available
    }
  });

  afterEach(async function() {
    if (store && store.client) {
      // Cleanup test keys
      try {
        const keys = await store.client.keys('cosmo:test:*');
        if (keys.length > 0) {
          await store.client.del(...keys);
        }
        await store.disconnect();
      } catch (error) {
        // Ignore cleanup errors
      }
    }
  });

  describe('Connection', () => {
    it('should connect to Redis', async () => {
      expect(store.client).to.not.be.null;
      expect(store.client.status).to.equal('ready');
    });

    it('should load Lua scripts', () => {
      expect(store.luaScripts.applyMerge).to.be.a('string');
      expect(store.luaScripts.goalClaim).to.be.a('string');
      expect(store.luaScripts.leaderRenew).to.be.a('string');
    });
  });

  describe('Memory Operations', () => {
    it('should set and get memory nodes', async () => {
      const nodeId = 'test_node_1';
      const value = { concept: 'test', data: 'value' };
      const versionVector = { 'test-instance-1': 1 };
      
      await store.setMemory(nodeId, value, versionVector);
      const retrieved = await store.getMemory(nodeId);
      
      expect(retrieved).to.not.be.null;
      expect(retrieved.value.concept).to.equal('test');
      expect(retrieved.sourceInstance).to.equal('test-instance-1');
    });

    it('should handle CRDT merge on conflict', async () => {
      const nodeId = 'test_node_conflict';
      
      // First write
      await store.setMemory(nodeId, { data: 'old' }, { 'i1': 1 });
      
      // Wait a moment to ensure timestamp difference
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Second write (newer)
      await store.setMemory(nodeId, { data: 'new' }, { 'i1': 2 });
      
      const retrieved = await store.getMemory(nodeId);
      expect(retrieved.value.data).to.equal('new');
    });

    it('should return null for non-existent node', async () => {
      const result = await store.getMemory('nonexistent_node');
      expect(result).to.be.null;
    });
  });

  describe('Diff Submission', () => {
    it('should submit diff', async () => {
      const diff = {
        versionVector: { 'test-instance-1': 5 },
        fields: {
          'node1': { op: 'set', value: 'data', timestamp: Date.now() }
        }
      };
      
      const result = await store.submitDiff(1, 'test-instance-1', diff);
      expect(result).to.be.true;
      expect(diff.diff_id).to.be.a('string');
    });

    it('should reject duplicate diff (idempotency)', async () => {
      const diff = {
        diff_id: 'test_diff_unique_123',
        versionVector: { 'test-instance-1': 5 },
        fields: {}
      };
      
      // First submission
      store.idempotency.markApplied(diff.diff_id);
      
      // Second submission (should be rejected)
      const result = await store.submitDiff(1, 'test-instance-1', diff);
      expect(result).to.be.false;
    });
  });

  describe('Config Hash Validation', () => {
    it('should store and validate config hash', async () => {
      const hash = store.calculateConfigHash({ test: 'config' });
      
      // First validation stores the hash
      const result1 = await store.validateConfigHash(hash);
      expect(result1).to.be.true;
      
      // Second validation with same hash
      const result2 = await store.validateConfigHash(hash);
      expect(result2).to.be.true;
    });

    it('should reject mismatched config hash', async () => {
      const hash1 = store.calculateConfigHash({ test: 'config1' });
      const hash2 = store.calculateConfigHash({ test: 'config2' });
      
      // Store first hash
      await store.setConfigHash(hash1);
      
      // Validate with different hash
      const result = await store.validateConfigHash(hash2);
      expect(result).to.be.false;
    });
  });

  describe('Health Beacons', () => {
    it('should set and get health beacon', async () => {
      const health = {
        cycle: 10,
        memoryHash: 'abc123',
        ramUsage: 150.5,
        errorCount: 0
      };
      
      await store.setHealthBeacon('test-instance-1', health);
      const retrieved = await store.getHealthBeacon('test-instance-1');
      
      expect(retrieved).to.not.be.null;
      expect(retrieved.cycle).to.equal(10);
      expect(retrieved.memoryHash).to.equal('abc123');
      expect(retrieved.ramUsage).to.equal(150.5);
    });

    it('should get all health beacons', async () => {
      await store.setHealthBeacon('instance-1', { cycle: 1, ramUsage: 100, errorCount: 0 });
      await store.setHealthBeacon('instance-2', { cycle: 2, ramUsage: 120, errorCount: 0 });
      
      const all = await store.getAllHealthBeacons();
      
      expect(all).to.have.property('instance-1');
      expect(all).to.have.property('instance-2');
    });
  });

  describe('Goal Operations', () => {
    it('should claim goal atomically', async () => {
      const goalId = 'test_goal_1';
      const ttl = 10000; // 10s
      
      const claimed = await store.claimGoal(goalId, 'test-instance-1', ttl);
      expect(claimed).to.be.true;
    });

    it('should reject duplicate claim', async () => {
      const goalId = 'test_goal_2';
      const ttl = 10000;
      
      // First claim
      const claimed1 = await store.claimGoal(goalId, 'instance-1', ttl);
      expect(claimed1).to.be.true;
      
      // Second claim (should fail)
      const claimed2 = await store.claimGoal(goalId, 'instance-2', ttl);
      expect(claimed2).to.be.false;
    });

    it('should complete goal', async () => {
      const goalId = 'test_goal_3';
      
      const result = await store.completeGoal(goalId);
      expect(result).to.be.true;
    });
  });

  describe('Journal Operations', () => {
    it('should append to journal', async () => {
      const entry = {
        type: 'test_event',
        cycle: 1,
        data: 'test data'
      };
      
      const result = await store.appendJournal(entry);
      expect(result).to.be.true;
    });

    it('should retrieve journal entries by cycle range', async () => {
      // Append multiple entries
      for (let i = 1; i <= 5; i++) {
        await store.appendJournal({ cycle: i, event: `event_${i}` });
      }
      
      const entries = await store.getJournal(2, 4);
      
      expect(entries.length).to.be.at.least(3);
      // Verify cycles 2, 3, 4 are included
      const cycles = entries.map(e => e.cycle);
      expect(cycles).to.include(2);
      expect(cycles).to.include(3);
      expect(cycles).to.include(4);
    });
  });

  describe('Cycle Barriers', () => {
    it('should mark instance ready', async () => {
      const result = await store.markReady(1, 'test-instance-1');
      expect(result).to.be.true;
      
      const count = await store.getReadyCount(1);
      expect(count).to.equal(1);
    });

    it('should track multiple ready instances', async () => {
      await store.markReady(1, 'instance-1');
      await store.markReady(1, 'instance-2');
      await store.markReady(1, 'instance-3');
      
      const count = await store.getReadyCount(1);
      expect(count).to.equal(3);
    });
  });

  describe('Pub/Sub', () => {
    it('should publish sync signal', async () => {
      const result = await store.publishSyncSignal(1);
      expect(result).to.be.true;
    });

    it('should subscribe to sync signals', function(done) {
      this.timeout(5000);
      
      let received = false;
      
      store.subscribeSyncSignal((signal) => {
        received = true;
        expect(signal).to.have.property('cycle');
        if (!done.called) {
          done.called = true;
          done();
        }
      });
      
      // Give subscription a moment to register
      setTimeout(async () => {
        await store.publishSyncSignal(99);
      }, 100);
    });

    it('should publish and receive heartbeats', function(done) {
      this.timeout(5000);
      
      const testBeacon = {
        instanceId: 'test-instance',
        cycle: 1,
        timestamp: Date.now()
      };
      
      store.subscribeHeartbeats((beacon) => {
        expect(beacon).to.have.property('instanceId');
        if (!done.called) {
          done.called = true;
          done();
        }
      });
      
      setTimeout(async () => {
        await store.publishHeartbeat(testBeacon);
      }, 100);
    });
  });
});

