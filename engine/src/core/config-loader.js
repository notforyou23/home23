const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

/**
 * Configuration Loader
 * Loads and validates Phase 2 configuration
 * Zero hardcoded defaults - everything from config file
 */
class ConfigLoader {
  constructor(configPath) {
    // COSMO_CONFIG_PATH env var allows per-instance config without copying the engine
    this.configPath = configPath
      || process.env.COSMO_CONFIG_PATH
      || path.join(__dirname, '..', 'config.yaml');
    this.config = null;
  }

  /**
   * Resolve the Home23 instance config.yaml path for the running agent, if any.
   * Home23 sets COSMO_WORKSPACE_PATH to `<home23>/instances/<agent>/workspace`,
   * so the per-agent config lives one directory up.
   */
  resolveInstanceConfigPath() {
    const wp = process.env.COSMO_WORKSPACE_PATH;
    if (!wp) return null;
    const candidate = path.join(path.dirname(wp), 'config.yaml');
    return fs.existsSync(candidate) ? candidate : null;
  }

  /**
   * Apply per-agent engine model overrides on top of the shared base-engine.yaml
   * modelAssignments. This honors `engine.thought` / `engine.consolidation` /
   * `engine.dreaming` / `engine.query` from the instance config so agents can
   * diverge from the shared cognitive-model routing without rewriting the base.
   *
   * `thought` maps to the general-purpose cognitive hot paths that currently
   * default to nemotron-3-nano:30b (quantum reasoner branches, default agent
   * routing, analytics, etc.) — these are what generate the bulk of requests
   * and the observed 429 concurrency pressure.
   */
  applyInstanceEngineOverrides(instanceConfig) {
    const engineOverrides = instanceConfig && instanceConfig.engine;
    if (!engineOverrides || typeof engineOverrides !== 'object') return;
    if (!this.config.modelAssignments || typeof this.config.modelAssignments !== 'object') return;

    const thoughtKeys = [
      'default',
      'quantumReasoner.branches',
      'quantumReasoner.singleReasoning',
      'agents',
      'agents.analytical',
      'agents.discovery',
      'agents.clustering',
      'agents.quality_assurance',
      'agents.research-fallback',
      'goalCurator',
      'intrinsicGoals',
    ];

    const applied = [];

    const resolveProvider = (model) => {
      // Check base-engine config first
      let providers = this.config.providers || {};
      for (const [name, prov] of Object.entries(providers)) {
        if ((prov.defaultModels || []).includes(model)) return name;
      }
      // Fall back to home.yaml providers
      try {
        const homePath = path.join(path.dirname(path.dirname(this.configPath)), 'config', 'home.yaml');
        if (fs.existsSync(homePath)) {
          const home = yaml.load(fs.readFileSync(homePath, 'utf8')) || {};
          for (const [name, prov] of Object.entries(home.providers || {})) {
            if ((prov.defaultModels || []).includes(model)) return name;
          }
        }
      } catch { /* best-effort */ }
      return null;
    };

    const setModel = (assignmentKey, newModel) => {
      const entry = this.config.modelAssignments[assignmentKey];
      if (entry && typeof entry === 'object' && typeof newModel === 'string' && newModel.trim()) {
        const prev = entry.model;
        if (prev !== newModel) {
          entry.model = newModel;
          const resolvedProvider = resolveProvider(newModel);
          if (resolvedProvider) entry.provider = resolvedProvider;
          applied.push(`${assignmentKey}: ${prev} -> ${newModel} (${entry.provider})`);
        }
      }
    };

    if (typeof engineOverrides.thought === 'string' && engineOverrides.thought.trim()) {
      for (const key of thoughtKeys) setModel(key, engineOverrides.thought.trim());
    }
    if (typeof engineOverrides.consolidation === 'string' && engineOverrides.consolidation.trim()) {
      setModel('agents.synthesis', engineOverrides.consolidation.trim());
    }
    // Note: `dreaming` and `query` are honored by the orchestrator and memory
    // paths respectively; we do not rewrite modelAssignments for them here.

    if (applied.length) {
      // Stash for observability without requiring a logger dependency at load time.
      this.config._instanceOverridesApplied = applied;
    }
  }

  /**
   * Load configuration from YAML file
   */
  load() {
    try {
      const fileContents = fs.readFileSync(this.configPath, 'utf8');
      this.config = yaml.load(fileContents);

      // Overlay per-agent engine model overrides from instances/<name>/config.yaml
      // (Home23 multi-agent layering) before validation so downstream consumers
      // see the effective routing. Shared base-engine.yaml stays untouched.
      const instancePath = this.resolveInstanceConfigPath();
      if (instancePath) {
        try {
          const instanceConfig = yaml.load(fs.readFileSync(instancePath, 'utf8')) || {};
          this.applyInstanceEngineOverrides(instanceConfig);
        } catch (_instanceErr) {
          // Instance config is best-effort — a malformed file should not break startup.
        }
      }

      this.validate();
      return this.config;
    } catch (error) {
      throw new Error(`Failed to load config: ${error.message}`);
    }
  }

  /**
   * Validate configuration structure
   */
  validate() {
    const required = [
      'architecture',
      'models',
      'execution',
      'logging',
      'dashboard'
    ];
    
    for (const field of required) {
      if (!this.config[field]) {
        throw new Error(`Missing required config section: ${field}`);
      }
    }
    
    // Validate architecture subsections
    const archRequired = [
      'roleSystem',
      'memory',
      'reasoning',
      'creativity',
      'goals',
      'thermodynamic',
      'environment',
      'temporal',
      'cognitiveState',
      'reflection'
    ];
    
    for (const field of archRequired) {
      if (!this.config.architecture[field]) {
        throw new Error(`Missing architecture config: ${field}`);
      }
    }
  }

  /**
   * Get configuration value by path
   */
  get(path) {
    const parts = path.split('.');
    let value = this.config;
    
    for (const part of parts) {
      if (value === undefined) return undefined;
      value = value[part];
    }
    
    return value;
  }

  /**
   * Get all config
   */
  getAll() {
    return this.config;
  }
}

module.exports = { ConfigLoader };

