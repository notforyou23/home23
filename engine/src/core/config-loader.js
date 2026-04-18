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

    const applied = [];

    // Enablement lives in base-engine.yaml providers (provider.enabled).
    // home.yaml providers is just a model→provider catalog — no enabled
    // field — so we must check enablement against base-engine only.
    // Otherwise a model listed in home.yaml under a provider that's not
    // enabled in base-engine silently slips through and the unified
    // client fails at call-time with "X provider not initialized".
    const baseProviders = this.config.providers || {};
    const isProviderEnabled = (name) => {
      const prov = baseProviders[name];
      return prov && prov.enabled === true;
    };
    const resolveProvider = (model) => {
      // Check base-engine config first
      for (const [name, prov] of Object.entries(baseProviders)) {
        if (!isProviderEnabled(name)) continue;
        if ((prov.defaultModels || []).includes(model)) return name;
      }
      // Fall back to home.yaml providers (model catalog) — but only
      // return a name that's actually enabled in base-engine.
      try {
        const homePath = path.join(path.dirname(path.dirname(this.configPath)), 'config', 'home.yaml');
        if (fs.existsSync(homePath)) {
          const home = yaml.load(fs.readFileSync(homePath, 'utf8')) || {};
          for (const [name, prov] of Object.entries(home.providers || {})) {
            if (!isProviderEnabled(name)) continue;
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
        if (prev === newModel) return;
        const resolvedProvider = resolveProvider(newModel);
        if (!resolvedProvider) {
          // Refuse to rewrite into a disabled/unknown provider — leaves
          // the slot on its original working assignment.
          applied.push(`${assignmentKey}: SKIPPED (model "${newModel}" not mapped to any enabled provider)`);
          return;
        }
        entry.model = newModel;
        entry.provider = resolvedProvider;
        applied.push(`${assignmentKey}: ${prev} -> ${newModel} (${entry.provider})`);
      }
    };

    // `thought` is a blunt multi-slot override. Limit which slots it can
    // sweep so a single setting can't silently hijack UI voice layers
    // (pulseVoice), chat routing, or anything non-cognitive.
    const isCognitiveSlot = (key) => !key.startsWith('pulseVoice') && !key.startsWith('chat');

    if (typeof engineOverrides.thought === 'string' && engineOverrides.thought.trim()) {
      for (const key of Object.keys(this.config.modelAssignments)) {
        if (!isCognitiveSlot(key)) continue;
        setModel(key, engineOverrides.thought.trim());
      }
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
   * Apply per-slot modelAssignments overrides from the instance config. These
   * take precedence over the blunt `engine.thought` shortcut and let the user
   * pick a provider+model+fallback chain for each individual assignment key
   * (e.g. quantumReasoner.branches, agents.research, coordinator).
   *
   * Instance config shape:
   *   modelAssignments:
   *     quantumReasoner.branches:
   *       provider: minimax
   *       model: MiniMax-M2.7-highspeed
   *       fallback:
   *         - provider: ollama-cloud
   *           model: nemotron-3-nano:30b
   */
  applyInstanceModelAssignments(instanceConfig) {
    const overrides = instanceConfig && instanceConfig.modelAssignments;
    if (!overrides || typeof overrides !== 'object') return;
    if (!this.config.modelAssignments || typeof this.config.modelAssignments !== 'object') {
      this.config.modelAssignments = {};
    }

    const applied = [];
    for (const [key, entry] of Object.entries(overrides)) {
      if (!entry || typeof entry !== 'object') continue;
      const current = this.config.modelAssignments[key] || {};
      const merged = {
        ...current,
        provider: entry.provider || current.provider,
        model: entry.model || current.model,
      };
      if (Array.isArray(entry.fallback)) {
        merged.fallback = entry.fallback
          .filter(f => f && typeof f === 'object' && f.provider && f.model)
          .map(f => ({ provider: f.provider, model: f.model }));
      }
      this.config.modelAssignments[key] = merged;
      applied.push(`${key} -> ${merged.provider}/${merged.model}${merged.fallback?.length ? ` (+${merged.fallback.length} fallback)` : ''}`);
    }

    if (applied.length) {
      const prior = this.config._instanceAssignmentsApplied || [];
      this.config._instanceAssignmentsApplied = prior.concat(applied);
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
          // Per-slot overrides run AFTER the blunt `engine.thought` shortcut so
          // specific assignments win over the sweep.
          this.applyInstanceModelAssignments(instanceConfig);
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

