const fs = require('fs').promises;
const path = require('path');

/**
 * BranchPolicyController
 * Lightweight contextual bandit (epsilon-greedy) that suggests
 * branch-level reasoning parameters based on observed rewards.
 *
 * This module is intentionally conservative; when insufficient data is
 * available it mirrors the caller's defaults so existing behaviour stays
 * intact. State is persisted under runtime/policies/branch-policy.json.
 */
class BranchPolicyController {
  constructor(config = {}, logger = console) {
    this.logger = logger;

    this.defaultConfig = {
      epsilon: 0.2,
      minSamples: 10,
      maxBranchCount: config.parallelBranches || 5
    };

    const projectRoot = path.join(__dirname, '..', '..');  // src/cognition -> src -> COSMO root
    this.policyDir = path.join(projectRoot, 'runtime', 'policies');
    this.policyPath = path.join(this.policyDir, 'branch-policy.json');

    this.state = {
      version: 1,
      epsilon: this.defaultConfig.epsilon,
      totalSamples: 0,
      efforts: {
        low: { reward: 0, count: 0 },
        medium: { reward: 0, count: 0 },
        high: { reward: 0, count: 0 }
      },
      webSearch: {
        enabledReward: 0,
        enabledCount: 0,
        disabledReward: 0,
        disabledCount: 0
      }
    };

    this.initialized = false;
    this.pendingSave = null;
  }

  async initialize() {
    if (this.initialized) return;

    try {
      await fs.mkdir(this.policyDir, { recursive: true });
      const raw = await fs.readFile(this.policyPath, 'utf-8');
      const parsed = JSON.parse(raw);

      if (parsed.version === 1) {
        this.state = { ...this.state, ...parsed };
        this.logger.info?.('Branch policy loaded', {
          epsilon: this.state.epsilon,
          samples: this.state.totalSamples
        });
      } else {
        this.logger.warn?.('Branch policy version mismatch, resetting state', {
          found: parsed.version,
          expected: 1
        });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger.warn?.('Failed to load branch policy state', {
          error: error.message
        });
      }
    }

    this.initialized = true;
  }

  /**
   * Compute decisions for current cycle.
   *
   * @param {Object} context - metadata from caller
   * @param {number} context.cycle - current cycle number
   * @param {number} context.defaultBranchCount - baseline branch count
   * @param {Array<string>} context.availableEfforts - allowed reasoning efforts
   * @param {number} context.maxWebSearchBranches - upper bound for web search branches
   * @returns {Object} decision payload
   */
  getDecisions(context = {}) {
    const {
      defaultBranchCount = 3,
      availableEfforts = ['low', 'medium'],
      maxWebSearchBranches = 2
    } = context;

    const branchCount = Math.min(defaultBranchCount, this.defaultConfig.maxBranchCount);

    const effortAssignments = [];
    for (let i = 0; i < branchCount; i++) {
      effortAssignments.push(this.pickEffort(availableEfforts));
    }

    const webSearchAssignments = this.pickWebSearch(branchCount, maxWebSearchBranches);

    return {
      source: 'policy',
      branchCount,
      effortAssignments,
      webSearchAssignments
    };
  }

  /**
   * Update bandit statistics with observed reward.
   *
   * @param {Object} outcome
   * @param {Array<string>} outcome.effortAssignments
   * @param {Array<number>} outcome.webSearchAssignments
   * @param {number} outcome.reward
   */
  async recordOutcome(outcome = {}) {
    const { effortAssignments = [], webSearchAssignments = [], reward = 0 } = outcome;

    this.logger.info?.('Recording branch policy outcome', {
      effortCount: effortAssignments.length,
      webSearchCount: webSearchAssignments.length,
      reward
    });

    if (!effortAssignments.length) {
      this.logger.warn?.('Skipping policy update - no effort assignments');
      return;
    }

    const rewardPerBranch = reward / effortAssignments.length || 0;

    effortAssignments.forEach((effort) => {
      if (!this.state.efforts[effort]) {
        this.state.efforts[effort] = { reward: 0, count: 0 };
      }
      this.state.efforts[effort].reward += rewardPerBranch;
      this.state.efforts[effort].count += 1;
    });

    // Web search reward comparison
    const enabledBranches = webSearchAssignments.filter(Boolean).length;
    const disabledBranches = effortAssignments.length - enabledBranches;

    if (enabledBranches > 0) {
      this.state.webSearch.enabledReward += rewardPerBranch * enabledBranches;
      this.state.webSearch.enabledCount += enabledBranches;
    }

    if (disabledBranches > 0) {
      this.state.webSearch.disabledReward += rewardPerBranch * disabledBranches;
      this.state.webSearch.disabledCount += disabledBranches;
    }

    this.state.totalSamples += effortAssignments.length;

    await this.save();
  }

  pickEffort(availableEfforts) {
    if (availableEfforts.length === 0) {
      return 'medium';
    }

    if (Math.random() < this.state.epsilon || this.state.totalSamples < this.defaultConfig.minSamples) {
      return availableEfforts[Math.floor(Math.random() * availableEfforts.length)];
    }

    let bestEffort = availableEfforts[0];
    let bestAverage = -Infinity;

    availableEfforts.forEach((effort) => {
      const stats = this.state.efforts[effort] || { reward: 0, count: 0 };
      const average = stats.count > 0 ? stats.reward / stats.count : 0;
      if (average > bestAverage) {
        bestAverage = average;
        bestEffort = effort;
      }
    });

    return bestEffort;
  }

  pickWebSearch(branchCount, maxWebSearchBranches) {
    const assignments = new Array(branchCount).fill(0);

    if (branchCount === 0) {
      return assignments;
    }

    if (Math.random() < this.state.epsilon || this.state.totalSamples < this.defaultConfig.minSamples) {
      const count = Math.min(maxWebSearchBranches, branchCount);
      for (let i = 0; i < count; i++) {
        assignments[i] = 1;
      }
      return assignments;
    }

    const enabledAvg = this.state.webSearch.enabledCount > 0
      ? this.state.webSearch.enabledReward / this.state.webSearch.enabledCount
      : 0;

    const disabledAvg = this.state.webSearch.disabledCount > 0
      ? this.state.webSearch.disabledReward / this.state.webSearch.disabledCount
      : 0;

    if (enabledAvg >= disabledAvg) {
      const count = Math.min(maxWebSearchBranches, branchCount);
      for (let i = 0; i < count; i++) {
        assignments[i] = 1;
      }
    }

    return assignments;
  }

  async save() {
    if (this.pendingSave) {
      return this.pendingSave;
    }

    this.pendingSave = (async () => {
      try {
        await fs.mkdir(this.policyDir, { recursive: true });
        await fs.writeFile(this.policyPath, JSON.stringify(this.state, null, 2), 'utf-8');
        this.logger.info?.('Branch policy saved', {
          path: this.policyPath,
          samples: this.state.totalSamples
        });
      } catch (error) {
        this.logger.warn?.('Failed to persist branch policy state', {
          path: this.policyPath,
          error: error.message
        });
      } finally {
        this.pendingSave = null;
      }
    })();

    return this.pendingSave;
  }
}

module.exports = {
  BranchPolicyController
};
