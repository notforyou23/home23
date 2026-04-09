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

    // PRODUCTION: Use COSMO_RUNTIME_PATH from environment (user-specific)
    // FALLBACK: Use engine/runtime for local development
    const projectRoot = path.join(__dirname, '..', '..');  // src/cognition -> src -> COSMO root
    const runtimeRoot = process.env.COSMO_RUNTIME_PATH || path.join(projectRoot, 'runtime');
    
    this.policyDir = path.join(runtimeRoot, 'policies');
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
   * Now uses weighted credit assignment: winner gets more credit.
   *
   * @param {Object} outcome
   * @param {Array<string>} outcome.effortAssignments
   * @param {Array<number>} outcome.webSearchAssignments
   * @param {number} outcome.reward
   * @param {number} outcome.selectedBranchIndex - which branch was chosen (optional)
   */
  async recordOutcome(outcome = {}) {
    const {
      effortAssignments = [],
      webSearchAssignments = [],
      reward = 0,
      selectedBranchIndex = null
    } = outcome;

    this.logger.info?.('Recording branch policy outcome', {
      effortCount: effortAssignments.length,
      webSearchCount: webSearchAssignments.length,
      reward,
      selectedBranch: selectedBranchIndex
    });

    if (!effortAssignments.length) {
      this.logger.warn?.('Skipping policy update - no effort assignments');
      return;
    }

    // Weighted credit assignment: winner gets 70%, others share 30%
    // If no winner specified, fall back to uniform distribution
    const winnerWeight = 0.7;
    const loserWeightTotal = 1 - winnerWeight;
    const hasWinner = selectedBranchIndex !== null &&
                      selectedBranchIndex >= 0 &&
                      selectedBranchIndex < effortAssignments.length;

    effortAssignments.forEach((effort, index) => {
      if (!this.state.efforts[effort]) {
        this.state.efforts[effort] = { reward: 0, count: 0 };
      }

      // Calculate this branch's share of the reward
      let branchReward;
      if (hasWinner) {
        if (index === selectedBranchIndex) {
          // Winner gets 70%
          branchReward = reward * winnerWeight;
        } else {
          // Losers share 30%
          const loserCount = effortAssignments.length - 1;
          branchReward = loserCount > 0 ? reward * loserWeightTotal / loserCount : 0;
        }
      } else {
        // No winner info - uniform distribution (backward compatible)
        branchReward = reward / effortAssignments.length;
      }

      this.state.efforts[effort].reward += branchReward;
      this.state.efforts[effort].count += 1;
    });

    // Web search reward comparison (also weighted by selection)
    if (hasWinner) {
      const selectedUsedWebSearch = webSearchAssignments[selectedBranchIndex] === 1;

      if (selectedUsedWebSearch) {
        // Winner used web search - give it 70% of reward
        this.state.webSearch.enabledReward += reward * winnerWeight;
        this.state.webSearch.enabledCount += 1;

        // Other web search branches share remaining enabled reward
        const otherWebSearchCount = webSearchAssignments.filter((ws, i) =>
          i !== selectedBranchIndex && ws === 1
        ).length;
        if (otherWebSearchCount > 0) {
          const otherReward = reward * loserWeightTotal / (effortAssignments.length - 1);
          this.state.webSearch.enabledReward += otherReward * otherWebSearchCount;
          this.state.webSearch.enabledCount += otherWebSearchCount;
        }

        // Non-web-search branches
        const nonWebSearchCount = webSearchAssignments.filter((ws, i) =>
          i !== selectedBranchIndex && ws === 0
        ).length;
        if (nonWebSearchCount > 0) {
          const otherReward = reward * loserWeightTotal / (effortAssignments.length - 1);
          this.state.webSearch.disabledReward += otherReward * nonWebSearchCount;
          this.state.webSearch.disabledCount += nonWebSearchCount;
        }
      } else {
        // Winner didn't use web search - give it 70% of reward
        this.state.webSearch.disabledReward += reward * winnerWeight;
        this.state.webSearch.disabledCount += 1;

        // Other branches (both types) share remaining reward
        const otherCount = effortAssignments.length - 1;
        if (otherCount > 0) {
          const otherReward = reward * loserWeightTotal / otherCount;

          const otherWebSearchCount = webSearchAssignments.filter((ws, i) =>
            i !== selectedBranchIndex && ws === 1
          ).length;
          const otherNonWebSearchCount = webSearchAssignments.filter((ws, i) =>
            i !== selectedBranchIndex && ws === 0
          ).length;

          this.state.webSearch.enabledReward += otherReward * otherWebSearchCount;
          this.state.webSearch.enabledCount += otherWebSearchCount;
          this.state.webSearch.disabledReward += otherReward * otherNonWebSearchCount;
          this.state.webSearch.disabledCount += otherNonWebSearchCount;
        }
      }
    } else {
      // No winner info - uniform distribution (backward compatible)
      const rewardPerBranch = reward / effortAssignments.length || 0;
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
