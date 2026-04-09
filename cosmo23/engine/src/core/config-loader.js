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
    // PRODUCTION: Load config from runtime directory (set by COSMO_RUNTIME_PATH)
    // Each run has its own config.yaml in its directory
    // FALLBACK: Load from engine/src/config.yaml for local dev
    if (!configPath) {
      const runtimeRoot = process.env.COSMO_RUNTIME_PATH || 
                          path.resolve(__dirname, '..', 'runtime');
      configPath = path.join(runtimeRoot, 'config.yaml');
    }
    this.configPath = configPath;
    this.config = null;
  }

  /**
   * Load configuration from YAML file
   */
  load() {
    try {
      const fileContents = fs.readFileSync(this.configPath, 'utf8');
      this.config = yaml.load(fileContents);
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

