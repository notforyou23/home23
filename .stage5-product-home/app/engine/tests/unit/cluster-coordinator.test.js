/**
 * Unit tests for ClusterCoordinator (Stage 4 Milestone A)
 */

const { expect } = require('chai');
const { ClusterCoordinator } = require('../../src/cluster/cluster-coordinator');

class MemoryStateStore {
  constructor() {
    this.records = new Map(); // cycle -> Map(instanceId -> record)
    this.plans = new Map(); // cycle -> plan
    this.artifacts = new Map(); // `${cycle}:${id}` -> artifact
    this.events = [];
    this.governanceSnapshot = null;
    this.governanceOverride = null;
    this.governanceEvents = [];
    this.healthBeacons = {};
  }

  _getCycleMap(cycle) {
    if (!this.records.has(cycle)) {
      this.records.set(cycle, new Map());
    }
    return this.records.get(cycle);
  }

  async recordReviewReadiness(cycle, instanceId, payload) {
    const cycleMap = this._getCycleMap(cycle);
    cycleMap.set(instanceId, {
      instanceId,
      timestamp: Date.now(),
      payload
    });
    return cycleMap.get(instanceId);
  }

  async awaitReviewBarrier(cycle, quorum, timeoutMs) {
    const pollInterval = 20;
    const start = Date.now();

    while (true) {
      const cycleMap = this.records.get(cycle) || new Map();
      const readyInstances = Array.from(cycleMap.values());
      const readyCount = readyInstances.length;
      const durationMs = Date.now() - start;

      if (readyCount >= quorum) {
        return {
          status: 'proceed',
          readyCount,
          readyInstances,
          quorum,
          durationMs
        };
      }

      if (durationMs >= timeoutMs) {
        return {
          status: 'timeout',
          readyCount,
          readyInstances,
          quorum,
          durationMs
        };
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
  }

  async clearReviewBarrier(cycle) {
    this.records.delete(cycle);
    return true;
  }

  async createReviewPlan(cycle, plan) {
    if (!this.plans.has(cycle)) {
      const record = {
        ...plan,
        persistedBy: 'memory',
        persistedAt: new Date().toISOString()
      };
      this.plans.set(cycle, record);
    }
    return this.plans.get(cycle);
  }

  async getReviewPlan(cycle) {
    return this.plans.get(cycle) || null;
  }

  async appendReviewEvent(cycle, event) {
    this.events.push({ cycle, ...event });
    return true;
  }

  async recordReviewArtifact(cycle, artifact) {
    const key = `${cycle}:${artifact.artifactId || artifact.instanceId || Math.random().toString(36).slice(2)}`;
    const record = {
      ...artifact,
      cycle,
      persistedAt: new Date().toISOString()
    };
    this.artifacts.set(key, record);
    return record;
  }

  async getReviewArtifacts(cycle) {
    return Array.from(this.artifacts.entries())
      .filter(([key]) => key.startsWith(`${cycle}:`))
      .map(([, value]) => value);
  }

  async recordGovernanceSnapshot(snapshot) {
    this.governanceSnapshot = {
      timestamp: new Date().toISOString(),
      ...snapshot
    };
    return this.governanceSnapshot;
  }

  async getGovernanceSnapshot() {
    return this.governanceSnapshot;
  }

  async setGovernanceOverride(override) {
    this.governanceOverride = override
      ? { updatedAt: new Date().toISOString(), ...override }
      : null;
    return this.governanceOverride;
  }

  async getGovernanceOverride() {
    return this.governanceOverride;
  }

  async clearGovernanceOverride() {
    this.governanceOverride = null;
    return true;
  }

  async appendGovernanceEvent(event) {
    this.governanceEvents.push({
      timestamp: new Date().toISOString(),
      ...event
    });
    return true;
  }

  async getAllHealthBeacons() {
    return this.healthBeacons;
  }
}

describe('ClusterCoordinator', () => {
  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {}
  };

  it('proceeds when quorum is reached', async () => {
    const stateStore = new MemoryStateStore();
    // Pre-populate readiness for other instances
    await stateStore.recordReviewReadiness(42, 'cosmo-2', {});
    await stateStore.recordReviewReadiness(42, 'cosmo-3', {});

    const coordinator = new ClusterCoordinator({
      stateStore,
      instanceId: 'cosmo-1',
      clusterSize: 3,
      config: {
        coordinator: {
          timeoutMs: 200,
          pollIntervalMs: 10
        }
      },
      logger
    });

    const result = await coordinator.coordinateReview(42, { clusterSize: 3 });

    expect(result.proceed).to.equal(true);
    expect(result.readyCount).to.equal(3);
    expect(coordinator.lastBarrier.decision).to.equal('proceed');
    expect(result.plan).to.be.an('object');
    expect(result.plan.assignments.authors).to.include('cosmo-1');
    expect(result.plan.pipeline).to.be.an('array');
    expect(result.planSummary).to.be.an('object');
    expect(coordinator.lastPlanSummary).to.deep.equal(result.planSummary);
  });

  it('skips review when quorum times out and skipOnTimeout is true', async () => {
    const stateStore = new MemoryStateStore();

    const coordinator = new ClusterCoordinator({
      stateStore,
      instanceId: 'cosmo-1',
      clusterSize: 3,
      config: {
        coordinator: {
          timeoutMs: 100,
          pollIntervalMs: 10,
          skipOnTimeout: true,
          minQuorum: 2
        }
      },
      logger
    });

    const result = await coordinator.coordinateReview(7, { clusterSize: 3 });

    expect(result.proceed).to.equal(false);
    expect(result.status).to.equal('timeout');
    expect(coordinator.lastBarrier.decision).to.equal('skip');
    expect(result.plan).to.equal(null);
  });

  it('forces proceed when quorum times out and skipOnTimeout is false', async () => {
    const stateStore = new MemoryStateStore();

    const coordinator = new ClusterCoordinator({
      stateStore,
      instanceId: 'cosmo-1',
      clusterSize: 3,
      config: {
        coordinator: {
          timeoutMs: 120,
          pollIntervalMs: 10,
          skipOnTimeout: false,
          minQuorum: 2
        }
      },
      logger
    });

    const result = await coordinator.coordinateReview(11, { clusterSize: 3 });

    expect(result.proceed).to.equal(true);
    expect(result.status).to.equal('timeout');
    expect(coordinator.lastBarrier.decision).to.equal('proceed');
    expect(result.plan).to.be.an('object');
  });

  it('applies governance override to skip review', async () => {
    const stateStore = new MemoryStateStore();
    await stateStore.setGovernanceOverride({ mode: 'force_skip', reason: 'manual_test', applyOnce: true });

    const coordinator = new ClusterCoordinator({
      stateStore,
      instanceId: 'cosmo-1',
      clusterSize: 3,
      config: {
        coordinator: {
          timeoutMs: 80,
          pollIntervalMs: 10,
          skipOnTimeout: true,
          minQuorum: 2
        }
      },
      logger
    });

    const result = await coordinator.coordinateReview(21, { clusterSize: 3 });

    expect(result.proceed).to.equal(false);
    expect(result.reason).to.equal('manual_test');
    expect(result.status).to.equal('governance_skip');
    expect(stateStore.governanceOverride).to.equal(null);
  });

  it('skips review when governance detects unhealthy peers', async () => {
    const stateStore = new MemoryStateStore();
    stateStore.healthBeacons = {
      'cosmo-2': {
        timestamp: Date.now() - 200000,
        status: 'unhealthy'
      }
    };

    const coordinator = new ClusterCoordinator({
      stateStore,
      instanceId: 'cosmo-1',
      clusterSize: 3,
      config: {
        coordinator: {
          timeoutMs: 80,
          pollIntervalMs: 10,
          skipOnTimeout: false,
          minQuorum: 2
        },
        governance: {
          maxUnhealthy: 0
        }
      },
      logger
    });

    const result = await coordinator.coordinateReview(33, { clusterSize: 3 });

    expect(result.proceed).to.equal(false);
    expect(result.reason).to.equal('unhealthy_instances');
    expect(result.status).to.equal('governance_skip');
  });
});
