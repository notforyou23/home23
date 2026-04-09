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

