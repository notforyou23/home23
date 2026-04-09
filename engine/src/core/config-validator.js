/**
 * Configuration Validator
 * Validates config at startup and provides clear warnings
 * Non-breaking: only warns, doesn't fail
 */

class ConfigValidator {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.warnings = [];
    this.errors = [];
    this.info = [];
  }

  /**
   * Run all validation checks
   * @returns {Object} { valid: boolean, warnings: [], errors: [], info: [] }
   */
  validate() {
    this.warnings = [];
    this.errors = [];
    this.info = [];

    // Run validation checks
    this.validateReasoningMode();
    this.validateMemoryDecay();
    this.validateDreamRewiring();
    this.validateTimezone();
    this.validateModelTokenLimits();
    this.validateContainerSettings();
    this.validateCoordinatorSettings();
    this.validateGoalSettings();
    this.validateClusterSettings();
    this.validateCapabilities(); // NEW: Validate Capabilities config

    // Log results
    this.logResults();

    return {
      valid: this.errors.length === 0,
      warnings: this.warnings,
      errors: this.errors,
      info: this.info
    };
  }

  /**
   * Validate reasoning mode configuration
   */
  validateReasoningMode() {
    const mode = this.config.architecture?.reasoning?.mode;
    const validModes = ['single', 'quantum', 'ensemble'];
    
    if (!validModes.includes(mode)) {
      this.warnings.push(`Unknown reasoning mode: "${mode}". Valid modes: ${validModes.join(', ')}`);
    } else {
      this.info.push(`✓ Reasoning mode: ${mode}`);
    }

    if (mode === 'quantum') {
      const branches = this.config.architecture.reasoning.parallelBranches;
      if (branches < 2 || branches > 10) {
        this.warnings.push(`Parallel branches (${branches}) outside recommended range (2-10)`);
      } else {
        this.info.push(`✓ Quantum reasoning: ${branches} parallel branches`);
      }
    }
  }

  /**
   * Validate memory decay settings
   */
  validateMemoryDecay() {
    const decay = this.config.architecture?.memory?.decay;
    if (!decay) return;

    const { baseFactor, decayInterval, exemptTags } = decay;

    // Check decay rate
    if (baseFactor < 0.99) {
      this.warnings.push(`Memory decay factor (${baseFactor}) is aggressive. Consider >= 0.995 for better long-term retention.`);
    } else {
      this.info.push(`✓ Memory decay factor: ${baseFactor} (gentle)`);
    }

    // Check decay interval
    if (decayInterval < 3600) {
      this.warnings.push(`Memory decay interval (${decayInterval}s) is short. Consider >= 3600s (1 hour) to protect long-term memories.`);
    } else {
      this.info.push(`✓ Memory decay interval: ${decayInterval}s (${Math.round(decayInterval/60)} min)`);
    }

    // Check protection tags
    if (exemptTags && exemptTags.length > 0) {
      this.info.push(`✓ Protected memory tags: ${exemptTags.join(', ')}`);
    }
  }

  /**
   * Validate dream rewiring settings
   */
  validateDreamRewiring() {
    const temporal = this.config.architecture?.temporal;
    if (!temporal || !temporal.dreamRewiring) return;

    const probability = temporal.dreamRewiringProbability;

    if (probability > 0.15) {
      this.warnings.push(`Dream rewiring probability (${probability}) is high. Consider <= 0.1 to prevent behavioral drift.`);
    } else if (probability > 0.05) {
      this.info.push(`✓ Dream rewiring: ${(probability * 100).toFixed(0)}% (moderate)`);
    } else {
      this.info.push(`✓ Dream rewiring: ${(probability * 100).toFixed(0)}% (gentle)`);
    }
  }

  /**
   * Validate timezone configuration
   */
  validateTimezone() {
    const temporal = this.config.architecture?.temporal;
    if (!temporal || !temporal.sleepEnabled) {
      this.info.push('ℹ Sleep disabled - no timezone validation needed');
      return;
    }

    if (!temporal.timezone) {
      this.warnings.push('No timezone specified for sleep schedule. Add temporal.timezone (e.g., "America/New_York")');
    } else {
      this.info.push(`✓ Timezone: ${temporal.timezone}`);
      this.info.push(`  Sleep: ${temporal.sleepSchedule}, Wake: ${temporal.wakeSchedule}`);
    }
  }

  /**
   * Validate model and token limit consistency
   */
  validateModelTokenLimits() {
    const models = this.config.models;
    if (!models) return;

    const maxTokens = models.defaultMaxTokens;
    const primary = models.primary;

    // Model OUTPUT token limits (all GPT-5.2 family share same output cap)
    // Note: These are OUTPUT limits only. Input context is ~128K for GPT-5.2
    const modelOutputLimits = {
      'gpt-5.2': 16384,
      'gpt-5-mini': 16384,
      'gpt-5-nano': 16384,
      'gpt-5.1-codex-max': 16384
    };

    if (modelOutputLimits[primary] && maxTokens > modelOutputLimits[primary]) {
      this.warnings.push(
        `defaultMaxTokens (${maxTokens}) exceeds ${primary} OUTPUT limit (${modelOutputLimits[primary]}). ` +
        `API will cap at ${modelOutputLimits[primary]}. Consider reducing to avoid confusion.`
      );
    } else if (modelOutputLimits[primary]) {
      this.info.push(`✓ Token limits: ${maxTokens} tokens (${primary}, max output: ${modelOutputLimits[primary]})`);
    } else {
      this.info.push(`✓ Token limits: ${maxTokens} tokens (${primary})`);
    }

    // Check coordinator settings
    const coordinator = this.config.coordinator;
    if (coordinator && coordinator.maxTokens && modelOutputLimits[coordinator.model]) {
      if (coordinator.maxTokens > modelOutputLimits[coordinator.model]) {
        this.warnings.push(
          `Coordinator maxTokens (${coordinator.maxTokens}) exceeds ${coordinator.model} OUTPUT limit (${modelOutputLimits[coordinator.model]})`
        );
      }
    }
  }

  /**
   * Validate container settings (code execution)
   */
  validateContainerSettings() {
    const codeExec = this.config.coordinator?.codeExecution;
    if (!codeExec || !codeExec.enabled) {
      this.info.push('ℹ Code execution disabled');
      return;
    }

    const timeout = codeExec.containerTimeout;
    if (timeout > 600000) { // 10 minutes
      this.warnings.push(`Container timeout (${timeout}ms) is very long. Consider <= 600000ms (10 min)`);
    } else {
      this.info.push(`✓ Container timeout: ${timeout/1000}s`);
    }

    this.info.push(`✓ Max containers per review: ${codeExec.maxContainersPerReview}`);
    
    // Validate execution backend settings
    this.validateLocalExecutionSettings();
  }
  
  /**
   * Validate local execution settings
   */
  validateLocalExecutionSettings() {
    const execution = this.config.execution;
    if (!execution) {
      return; // No execution config, use defaults
    }
    
    const backend = execution.backend;
    if (backend && backend !== 'container' && backend !== 'local') {
      this.warnings.push(`Invalid execution backend: ${backend}. Must be 'container' or 'local'`);
      return;
    }
    
    if (backend === 'local') {
      const local = execution.local;
      if (!local) {
        this.warnings.push('Local execution backend selected but no local settings provided');
        return;
      }
      
      // Validate Python path (if specified)
      if (local.pythonPath) {
        this.info.push(`✓ Local Python path: ${local.pythonPath}`);
      } else {
        this.info.push('ℹ Local Python path: auto-detect');
      }
      
      // Validate timeout
      const timeout = local.timeout || 30000;
      if (timeout < 1000) {
        this.warnings.push(`Local execution timeout (${timeout}ms) is very short. Consider >= 1000ms`);
      } else if (timeout > 300000) {
        this.warnings.push(`Local execution timeout (${timeout}ms) is very long. Consider <= 300000ms (5 min)`);
      } else {
        this.info.push(`✓ Local execution timeout: ${timeout/1000}s`);
      }
      
      // Validate working directory
      if (local.workingDir) {
        this.info.push(`✓ Local working directory: ${local.workingDir}`);
      }
    } else {
      this.info.push('ℹ Using container execution backend (default)');
    }
  }

  /**
   * Validate coordinator settings
   */
  validateCoordinatorSettings() {
    const coordinator = this.config.coordinator;
    if (!coordinator || !coordinator.enabled) {
      this.info.push('ℹ Coordinator disabled');
      return;
    }

    this.info.push(`✓ Coordinator: Reviews every ${coordinator.reviewCyclePeriod} cycles`);
    this.info.push(`✓ Max concurrent agents: ${coordinator.maxConcurrent}`);
    
    // Clarify quantum branches vs agent concurrency (separate systems)
    const quantumBranches = this.config.architecture?.reasoning?.parallelBranches || 0;
    const maxAgents = coordinator.maxConcurrent || 0;
    
    if (quantumBranches > 0 && maxAgents > 0) {
      this.info.push(`  Note: Quantum branches (${quantumBranches}) and agent concurrency (${maxAgents}) are separate systems`);
    }
  }

  /**
   * Validate goal management settings
   */
  validateGoalSettings() {
    const goals = this.config.architecture?.goals;
    if (!goals || !goals.intrinsicEnabled) {
      this.info.push('ℹ Intrinsic goals disabled');
      return;
    }

    const maxGoals = goals.maxGoals || 0;
    const rotation = goals.rotation || {};
    
    this.info.push(`✓ Goal portfolio: Max ${maxGoals} active goals`);
    
    if (rotation.enabled) {
      this.info.push(`✓ Goal rotation: Complete at ${(rotation.satisfactionThreshold * 100).toFixed(0)}%, archive after ${rotation.staleArchiveAfterDays} days`);
      
      if (rotation.autoArchiveThreshold) {
        this.info.push(`✓ Auto-archive: Priority < ${(rotation.autoArchiveThreshold * 100).toFixed(0)}% or progress < ${(rotation.minProgressPerPursuit * 100).toFixed(0)}%/pursuit`);
      }
    }
  }

  /**
   * Validate clustering configuration (solo vs cooperative modes)
   */
  validateClusterSettings() {
    const cluster = this.config.cluster;
    if (!cluster || cluster.enabled === false) {
      this.info.push('ℹ Cluster disabled — single-instance mode active');
      return;
    }

    if (typeof cluster.enabled !== 'boolean') {
      this.errors.push('cluster.enabled must be a boolean (true/false)');
      return;
    }

    const validBackends = ['redis', 'filesystem'];
    if (!cluster.backend || !validBackends.includes(cluster.backend)) {
      this.errors.push(`Invalid cluster backend "${cluster.backend}". Supported backends: ${validBackends.join(', ')}`);
      return;
    }

    const instanceCount = Number(cluster.instanceCount || 0);
    if (!Number.isInteger(instanceCount) || instanceCount < 2) {
      this.warnings.push(`Cluster enabled with instanceCount=${cluster.instanceCount}. Recommended minimum is 2 instances for cooperative gains.`);
    } else {
      this.info.push(`✓ Cluster instance count: ${instanceCount}`);
    }

    if (cluster.backend === 'redis') {
      const url = cluster.redis?.url || cluster.stateStore?.url;
      if (!url) {
        this.errors.push('Redis cluster backend requires cluster.redis.url configuration');
      } else {
        this.info.push(`✓ Redis cluster URL configured (${url.split('@').pop()})`);
      }
    }

    if (cluster.backend === 'filesystem') {
      const root = cluster.filesystem?.root;
      if (!root) {
        this.errors.push('Filesystem cluster backend requires cluster.filesystem.root configuration');
      } else {
        this.info.push(`✓ Filesystem cluster root: ${root}`);
      }
    }

    const coordinatorCfg = cluster.coordinator || {};
    if (coordinatorCfg.enabled === false) {
      this.info.push('ℹ Cluster review coordinator disabled (running in independent review mode).');
    } else {
      const quorumRatio = Number(coordinatorCfg.quorumRatio ?? 0.67);
      if (!Number.isFinite(quorumRatio) || quorumRatio <= 0 || quorumRatio > 1) {
        this.warnings.push('cluster.coordinator.quorumRatio should be between 0 and 1 (exclusive). Using default 0.67.');
      }

      const minQuorum = Number(coordinatorCfg.minQuorum ?? 2);
      if (!Number.isFinite(minQuorum) || minQuorum < 1) {
        this.warnings.push('cluster.coordinator.minQuorum should be >= 1. Using default 2.');
      }

      const timeoutMs = Number(coordinatorCfg.timeoutMs ?? 60000);
      if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) {
        this.warnings.push('cluster.coordinator.timeoutMs should be >= 1000 ms.');
      }

      this.info.push('✓ Cluster coordinator enabled for synchronized reviews');
    }

    const specialization = cluster.specialization;
    if (specialization && specialization.enabled !== false) {
      const profiles = specialization.profiles || {};
      const profileCount = Object.keys(profiles).length;

      if (profileCount === 0) {
        this.warnings.push('Cluster specialization enabled but no profiles configured (cluster.specialization.profiles)');
      } else {
        this.info.push(`✓ Cluster specialization: ${profileCount} profile(s)`);
      }

      Object.entries(profiles).forEach(([profileName, profileConfig]) => {
        if (!profileConfig || typeof profileConfig !== 'object') {
          this.warnings.push(`Specialization profile "${profileName}" must be an object`);
          return;
        }

        const hasFocus = Boolean(profileConfig.agentTypes || profileConfig.domains || profileConfig.keywords || profileConfig.tags);
        if (!hasFocus) {
          this.warnings.push(`Specialization profile "${profileName}" has no focus fields (agentTypes/domains/keywords/tags)`);
        }

        if (profileConfig.boost && profileConfig.boost < 1) {
          this.warnings.push(`Specialization profile "${profileName}" boost (${profileConfig.boost}) should be >= 1`);
        }

        if (profileConfig.penalty && (profileConfig.penalty <= 0 || profileConfig.penalty >= 1)) {
          this.info.push(`ℹ Specialization profile "${profileName}" penalty set to ${profileConfig.penalty}`);
        }
      });
    }
  }

  /**
   * Validate capabilities configuration
   */
  validateCapabilities() {
    const capabilities = this.config.capabilities;
    
    if (!capabilities) {
      this.info.push('ℹ Capabilities config not found - using defaults (enabled: true)');
      return;
    }
    
    // Check enabled flag
    if (typeof capabilities.enabled !== 'boolean' && capabilities.enabled !== undefined) {
      this.warnings.push('capabilities.enabled should be boolean, defaulting to true');
    }
    
    // Check executive gating
    if (typeof capabilities.executiveGating !== 'boolean' && capabilities.executiveGating !== undefined) {
      this.warnings.push('capabilities.executiveGating should be boolean, defaulting to true');
    }
    
    // Check frontier mode
    const validModes = ['observe', 'soft', 'hard'];
    if (capabilities.defaultMode && !validModes.includes(capabilities.defaultMode)) {
      this.errors.push(`capabilities.defaultMode must be one of: ${validModes.join(', ')}`);
    }
    
    // Info messages
    if (capabilities.enabled !== false) {
      this.info.push('✓ Capabilities enabled - COSMO has direct tool access');
      this.info.push(`✓ FrontierGate mode: ${capabilities.defaultMode || 'observe'}`);
      this.info.push(`✓ Executive gating: ${capabilities.executiveGating !== false ? 'enabled' : 'disabled'}`);
    } else {
      this.info.push('⊘ Capabilities disabled - using legacy execution patterns');
    }
    
    // Check executive ring is enabled if executive gating is on
    if (capabilities.executiveGating !== false && this.config.executiveRing?.enabled === false) {
      this.warnings.push('capabilities.executiveGating requires executiveRing.enabled - Executive will not evaluate actions');
    }
  }
  
  /**
   * Log validation results
   */
  logResults() {
    if (!this.logger) return;

    this.logger.info('');
    this.logger.info('═══════════════════════════════════════════════════════');
    this.logger.info('         CONFIGURATION VALIDATION RESULTS');
    this.logger.info('═══════════════════════════════════════════════════════');
    this.logger.info('');

    // Log errors (if any)
    if (this.errors.length > 0) {
      this.logger.error('❌ ERRORS:');
      this.errors.forEach(err => this.logger.error(`  ${err}`));
      this.logger.info('');
    }

    // Log warnings
    if (this.warnings.length > 0) {
      this.logger.warn('⚠️  WARNINGS:');
      this.warnings.forEach(warn => this.logger.warn(`  ${warn}`));
      this.logger.info('');
    }

    // Log info
    if (this.info.length > 0) {
      this.logger.info('✓ CONFIGURATION:');
      this.info.forEach(info => this.logger.info(`  ${info}`));
      this.logger.info('');
    }

    // Summary
    if (this.errors.length === 0 && this.warnings.length === 0) {
      this.logger.info('✅ All configuration checks passed!');
    } else if (this.errors.length === 0) {
      this.logger.info(`⚠️  Configuration loaded with ${this.warnings.length} warning(s)`);
    } else {
      this.logger.error(`❌ Configuration has ${this.errors.length} error(s)`);
    }

    this.logger.info('═══════════════════════════════════════════════════════');
    this.logger.info('');
  }

  /**
   * Get validation summary
   */
  getSummary() {
    return {
      totalChecks: this.info.length + this.warnings.length + this.errors.length,
      errors: this.errors.length,
      warnings: this.warnings.length,
      passed: this.info.length,
      valid: this.errors.length === 0
    };
  }
}

module.exports = { ConfigValidator };
