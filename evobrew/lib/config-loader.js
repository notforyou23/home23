/**
 * Evobrew - Configuration Loader
 * 
 * Unified config loading with fallback chain:
 * 1. ~/.evobrew/config.json (preferred)
 * 2. .env file in project root (legacy)
 * 
 * @module lib/config-loader
 */

const path = require('path');
const fs = require('fs');
const configManager = require('./config-manager');

/**
 * Configuration source types
 */
const ConfigSource = {
  GLOBAL_CONFIG: 'global',  // ~/.evobrew/config.json
  ENV_FILE: 'env',          // .env in project directory
  DEFAULTS: 'defaults'      // Default values only
};

/**
 * Load configuration with fallback chain.
 * Applies to process.env for backward compatibility.
 * 
 * @param {object} options
 * @param {string} options.projectRoot - Project root directory (for .env fallback)
 * @param {boolean} options.applyToEnv - Apply config to process.env (default: true)
 * @param {boolean} options.silent - Suppress console output (default: false)
 * @returns {Promise<{config: object, source: string}>}
 */
async function loadConfiguration(options = {}) {
  const {
    projectRoot = process.cwd(),
    applyToEnv = true,
    silent = false
  } = options;
  
  const log = silent ? () => {} : console.log.bind(console);
  
  // Try global config first
  if (configManager.configDirExists()) {
    try {
      const config = await configManager.loadConfig();
      log('[CONFIG] ✓ Loaded from ~/.evobrew/config.json');
      
      if (applyToEnv) {
        configManager.applyConfigToEnv(config);
      }
      
      return { config, source: ConfigSource.GLOBAL_CONFIG };
    } catch (err) {
      log(`[CONFIG] ⚠ Failed to load global config: ${err.message}`);
    }
  }
  
  // Fall back to .env file
  const envPath = path.join(projectRoot, '.env');
  if (fs.existsSync(envPath)) {
    // Use dotenv for .env loading
    require('dotenv').config({ path: envPath });
    
    log('[CONFIG] ✓ Loaded from .env file (legacy mode)');
    
    // Convert env vars to config object for consistency
    const config = envToConfig();
    
    return { config, source: ConfigSource.ENV_FILE };
  }
  
  // No config found - use defaults
  log('[CONFIG] ⚠ No configuration found. Using defaults.');
  log('[CONFIG] Run "evobrew setup" to create ~/.evobrew/config.json');
  
  const config = configManager.getDefaultConfig();
  
  return { config, source: ConfigSource.DEFAULTS };
}

/**
 * Convert current process.env to a config object.
 * Used when loading from .env for consistency.
 * @returns {object}
 */
function envToConfig() {
  const config = configManager.getDefaultConfig();
  const envBool = (value, fallback = false) => {
    if (value === undefined || value === null || value === '') return fallback;
    return String(value).toLowerCase() === 'true';
  };
  
  // Server
  if (process.env.PORT) {
    config.server.http_port = parseInt(process.env.PORT, 10);
  }
  if (process.env.HTTPS_PORT) {
    config.server.https_port = parseInt(process.env.HTTPS_PORT, 10);
  }
  
  // Providers
  if (process.env.OPENAI_API_KEY) {
    config.providers.openai.enabled = true;
    config.providers.openai.api_key = process.env.OPENAI_API_KEY;
  }
  if (process.env.ANTHROPIC_API_KEY) {
    config.providers.anthropic.enabled = true;
    config.providers.anthropic.api_key = process.env.ANTHROPIC_API_KEY;
  }
  if (process.env.XAI_API_KEY) {
    config.providers.xai.enabled = true;
    config.providers.xai.api_key = process.env.XAI_API_KEY;
  }
  if (process.env.OLLAMA_CLOUD_API_KEY) {
    if (!config.providers['ollama-cloud']) config.providers['ollama-cloud'] = {};
    config.providers['ollama-cloud'].enabled = true;
    config.providers['ollama-cloud'].api_key = process.env.OLLAMA_CLOUD_API_KEY;
  }
  
  // OpenClaw
  if (process.env.OPENCLAW_GATEWAY_TOKEN || process.env.OPENCLAW_GATEWAY_HOST) {
    config.openclaw.enabled = true;
    const host = process.env.OPENCLAW_GATEWAY_HOST || 'localhost';
    const port = process.env.OPENCLAW_GATEWAY_PORT || '18789';
    config.openclaw.gateway_url = `ws://${host}:${port}`;
    config.openclaw.token = process.env.OPENCLAW_GATEWAY_TOKEN || '';
    config.openclaw.password = process.env.OPENCLAW_GATEWAY_PASSWORD || '';
  }

  // Security profile / internet gates
  if (process.env.SECURITY_PROFILE) {
    config.security.profile = process.env.SECURITY_PROFILE;
  }
  if (process.env.EVOBREW_PROXY_SHARED_SECRET) {
    config.security.proxy_shared_secret = process.env.EVOBREW_PROXY_SHARED_SECRET;
  }
  if (process.env.WORKSPACE_ROOT) {
    config.security.workspace_root = process.env.WORKSPACE_ROOT;
  }
  if (process.env.ONLYOFFICE_CALLBACK_ALLOWLIST) {
    config.security.onlyoffice_callback_allowlist = process.env.ONLYOFFICE_CALLBACK_ALLOWLIST;
  }
  if (process.env.COLLABORA_SECRET) {
    config.security.collabora_secret = process.env.COLLABORA_SECRET;
  }
  if (process.env.ENCRYPTION_KEY) {
    config.security.encryption_key = process.env.ENCRYPTION_KEY;
  }
  if (process.env.INTERNET_ENABLE_MUTATIONS !== undefined) {
    config.security.internet_enable_mutations = envBool(process.env.INTERNET_ENABLE_MUTATIONS);
  }
  if (process.env.INTERNET_ENABLE_GATEWAY_PROXY !== undefined) {
    config.security.internet_enable_gateway_proxy = envBool(process.env.INTERNET_ENABLE_GATEWAY_PROXY);
  }
  if (process.env.INTERNET_ENABLE_TERMINAL !== undefined) {
    config.security.internet_enable_terminal = envBool(process.env.INTERNET_ENABLE_TERMINAL);
  }

  // Terminal feature gates
  if (process.env.TERMINAL_ENABLED !== undefined) {
    config.terminal.enabled = envBool(process.env.TERMINAL_ENABLED, true);
  }
  if (process.env.TERMINAL_MAX_SESSIONS_PER_CLIENT) {
    config.terminal.max_sessions_per_client = parseInt(process.env.TERMINAL_MAX_SESSIONS_PER_CLIENT, 10);
  }
  if (process.env.TERMINAL_IDLE_TIMEOUT_MS) {
    config.terminal.idle_timeout_ms = parseInt(process.env.TERMINAL_IDLE_TIMEOUT_MS, 10);
  }
  if (process.env.TERMINAL_MAX_BUFFER_BYTES) {
    config.terminal.max_buffer_bytes = parseInt(process.env.TERMINAL_MAX_BUFFER_BYTES, 10);
  }
  
  return config;
}

/**
 * Get the DATABASE_URL for Prisma based on current config.
 * @returns {string}
 */
function getDatabaseUrl() {
  // If global config exists, use global database location
  if (configManager.configDirExists()) {
    const dbPath = configManager.getDatabasePath();
    return `file:${dbPath}`;
  }
  
  // Fall back to project-local database
  return process.env.DATABASE_URL || 'file:./prisma/studio.db';
}

/**
 * Ensure Prisma database exists at the configured location.
 * Creates the database file if it doesn't exist.
 * @returns {Promise<{path: string, created: boolean}>}
 */
async function ensureDatabase() {
  const dbUrl = getDatabaseUrl();
  const dbPath = dbUrl.replace('file:', '');
  
  // Ensure directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  
  // Check if database exists
  const created = !fs.existsSync(dbPath);
  
  return { path: dbPath, created };
}

module.exports = {
  loadConfiguration,
  envToConfig,
  getDatabaseUrl,
  ensureDatabase,
  ConfigSource
};
