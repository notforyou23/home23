const DEFAULT_SETTINGS = {
  heartbeatTimeoutMs: 90_000,
  maxUnhealthy: 1,
  maxTimeoutStreak: 3,
  overrideClearsOnUse: true
};

class GovernanceMonitor {
  constructor({ stateStore, logger, instanceId, config = {} }) {
    this.stateStore = stateStore;
    this.logger = logger;
    this.instanceId = (instanceId || 'cosmo-1').toLowerCase();

    this.settings = {
      ...DEFAULT_SETTINGS,
      ...config
    };

    this.timeoutStreak = 0;
    this.lastSnapshot = null;
  }

  async evaluatePreBarrier(cycle, context = {}) {
    const decision = {
      action: 'wait',
      reason: null,
      override: null,
      health: null,
      snapshot: null
    };

    const override = await this.safeCall('getGovernanceOverride');
    const activeOverride = this.filterOverride(override);

    if (activeOverride) {
      decision.override = activeOverride;

      if (activeOverride.mode === 'force_skip') {
        decision.action = 'skip';
        decision.reason = activeOverride.reason || 'override_force_skip';
      } else if (activeOverride.mode === 'force_proceed') {
        decision.action = 'force_proceed';
        decision.reason = activeOverride.reason || 'override_force_proceed';
      }

      await this.appendEvent({
        cycle,
        event: 'override_applied',
        mode: activeOverride.mode,
        reason: decision.reason,
        requestedBy: activeOverride.requestedBy || 'operator'
      });

      if (activeOverride.applyOnce !== false && this.settings.overrideClearsOnUse) {
        await this.safeCall('clearGovernanceOverride');
      }
    }

    if (decision.action !== 'wait') {
      decision.snapshot = await this.recordSnapshot(cycle, {
        phase: 'pre_barrier',
        decision: decision.action,
        reason: decision.reason,
        override: activeOverride || null,
        readiness: context.readiness || null
      });
      return decision;
    }

    const health = await this.evaluateClusterHealth();
    decision.health = health;

    if (!health.healthy && health.unhealthyInstances.length > this.settings.maxUnhealthy) {
      decision.action = 'skip';
      decision.reason = 'unhealthy_instances';

      await this.appendEvent({
        cycle,
        event: 'governance_skip_health',
        unhealthy: health.unhealthyInstances,
        stale: health.staleInstances
      });

      decision.snapshot = await this.recordSnapshot(cycle, {
        phase: 'pre_barrier',
        decision: 'skip_health',
        health,
        readiness: context.readiness || null
      });
      return decision;
    }

    decision.snapshot = null;
    return decision;
  }

  async evaluatePostBarrier(cycle, barrierResult, context = {}) {
    const outcome = {
      proceed: true,
      action: 'proceed',
      reason: null,
      snapshot: null
    };

    if (!barrierResult) {
      outcome.proceed = false;
      outcome.action = 'skip';
      outcome.reason = 'missing_barrier_result';
      outcome.snapshot = await this.recordSnapshot(cycle, {
        phase: 'post_barrier',
        decision: outcome.action,
        reason: outcome.reason
      });
      return outcome;
    }

    if (barrierResult.status === 'timeout' || barrierResult.status === 'error') {
      this.timeoutStreak += 1;
    } else {
      this.timeoutStreak = 0;
    }

    const health = await this.evaluateClusterHealth();

    if (!health.healthy && health.unhealthyInstances.length > this.settings.maxUnhealthy) {
      outcome.proceed = false;
      outcome.action = 'skip_health';
      outcome.reason = 'unhealthy_instances';

      await this.appendEvent({
        cycle,
        event: 'governance_skip_health_post',
        unhealthy: health.unhealthyInstances,
        stale: health.staleInstances
      });
    } else if (this.timeoutStreak >= this.settings.maxTimeoutStreak) {
      outcome.proceed = false;
      outcome.action = 'skip_timeouts';
      outcome.reason = 'repeated_barrier_timeouts';

      await this.appendEvent({
        cycle,
        event: 'governance_skip_timeouts',
        timeoutStreak: this.timeoutStreak,
        barrier: barrierResult
      });
    }

    outcome.snapshot = await this.recordSnapshot(cycle, {
      phase: 'post_barrier',
      decision: outcome.action,
      reason: outcome.reason,
      barrier: {
        status: barrierResult.status,
        readyCount: barrierResult.readyCount,
        quorum: barrierResult.quorum,
        durationMs: barrierResult.durationMs
      },
      health,
      readiness: context.readiness || null
    });

    return outcome;
  }

  async recordSnapshot(cycle, data) {
    if (!this.stateStore || typeof this.stateStore.recordGovernanceSnapshot !== 'function') {
      return null;
    }

    const snapshot = {
      cycle,
      timestamp: new Date().toISOString(),
      ...data
    };

    try {
      await this.stateStore.recordGovernanceSnapshot(snapshot);
      this.lastSnapshot = snapshot;
      return snapshot;
    } catch (error) {
      this.logger?.warn?.('[GovernanceMonitor] Failed to persist snapshot', {
        error: error.message
      });
      return snapshot;
    }
  }

  async evaluateClusterHealth() {
    if (!this.stateStore || typeof this.stateStore.getAllHealthBeacons !== 'function') {
      return { healthy: true, instances: {}, unhealthyInstances: [], staleInstances: [] };
    }

    try {
      const beacons = await this.stateStore.getAllHealthBeacons();
      const now = Date.now();
      const staleCutoff = now - this.settings.heartbeatTimeoutMs;

      const result = {
        healthy: true,
        instances: {},
        unhealthyInstances: [],
        staleInstances: []
      };

      Object.entries(beacons || {}).forEach(([instanceId, beacon]) => {
        const id = String(instanceId || '').toLowerCase();
        const lastHeartbeat = beacon?.timestamp || beacon?.heartbeatAt || beacon?.lastHeartbeat || 0;
        const stale = lastHeartbeat < staleCutoff;
        const explicitUnhealthy = beacon?.status === 'unhealthy' || beacon?.healthy === false;

        result.instances[id] = {
          lastHeartbeat,
          stale,
          status: beacon?.status || (stale ? 'stale' : 'ok'),
          healthy: !explicitUnhealthy && !stale
        };

        if (stale) {
          result.staleInstances.push(id);
        }

        if (explicitUnhealthy || stale) {
          result.unhealthyInstances.push(id);
        }
      });

      if (result.unhealthyInstances.length > 0) {
        result.healthy = false;
      }

      return result;
    } catch (error) {
      this.logger?.warn?.('[GovernanceMonitor] Failed to evaluate health', {
        error: error.message
      });
      return { healthy: true, instances: {}, unhealthyInstances: [], staleInstances: [] };
    }
  }

  filterOverride(override) {
    if (!override) return null;

    const expiresAt = override.expiresAt ? new Date(override.expiresAt).getTime() : null;
    if (expiresAt && expiresAt < Date.now()) {
      return null;
    }

    return override;
  }

  /**
   * Check for active governance override for a specific context
   * @param {string} context - Context to check (e.g., 'milestone_gate')
   * @returns {Object|null} Active override if exists and not expired, null otherwise
   */
  async checkOverride(context = null) {
    const override = await this.safeCall('getGovernanceOverride');
    const activeOverride = this.filterOverride(override);
    
    // If no context specified, return any active override
    if (!context) {
      return activeOverride;
    }
    
    // If context specified, check if override applies to that context
    if (activeOverride && (!activeOverride.context || activeOverride.context === context)) {
      return activeOverride;
    }
    
    return null;
  }

  async appendEvent(event) {
    if (!this.stateStore || typeof this.stateStore.appendGovernanceEvent !== 'function') {
      return false;
    }

    try {
      await this.stateStore.appendGovernanceEvent(event);
      return true;
    } catch (error) {
      this.logger?.warn?.('[GovernanceMonitor] Failed to append event', {
        error: error.message
      });
      return false;
    }
  }

  async safeCall(method) {
    if (!this.stateStore || typeof this.stateStore[method] !== 'function') {
      return null;
    }

    try {
      return await this.stateStore[method]();
    } catch (error) {
      this.logger?.warn?.(`[GovernanceMonitor] ${method} failed`, {
        error: error.message
      });
      return null;
    }
  }
}

module.exports = { GovernanceMonitor };
