/**
 * Evobrew - Configuration Manager
 * 
 * Manages global configuration stored in ~/.evobrew/
 * Handles config loading, saving, migration from .env, and directory setup.
 * 
 * @module lib/config-manager
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { 
  encrypt, 
  decrypt, 
  isEncrypted, 
  encryptConfigSecrets, 
  decryptConfigSecrets 
} = require('./encryption');

// ============================================================================
// Constants
// ============================================================================

const CONFIG_DIR_NAME = '.evobrew';
const CONFIG_FILE_NAME = 'config.json';
const DATABASE_FILE_NAME = 'database.db';
const CONFIG_VERSION = '1.0.0';

/**
 * Default configuration schema
 */
const DEFAULT_CONFIG = {
  version: CONFIG_VERSION,
  server: {
    http_port: 3405,
    https_port: 3406,
    bind: 'localhost'
  },
  providers: {
    openai: {
      enabled: false,
      api_key: ''
    },
    anthropic: {
      enabled: false,
      oauth: false,
      api_key: ''
    },
    xai: {
      enabled: false,
      api_key: ''
    },
    'ollama-cloud': {
      enabled: false,
      api_key: ''
    },
    ollama: {
      enabled: true,  // auto-detect by default
      base_url: 'http://localhost:11434',
      auto_detect: true  // if true, check if Ollama running on startup
    },
    lmstudio: {
      enabled: false,
      base_url: 'http://localhost:1234/v1'
    }
  },
  openclaw: {
    enabled: false,
    gateway_url: 'ws://localhost:18789',
    token: '',
    password: '',
    tab_name: 'OpenClaw'
  },
  features: {
    https: false,
    brain_browser: true,
    function_calling: true,
    brains: {
      enabled: false,
      directories: []
    }
  },
  terminal: {
    enabled: true,
    max_sessions_per_client: 6,
    idle_timeout_ms: 1800000,
    max_buffer_bytes: 2097152
  },
  security: {
    profile: 'local',
    proxy_shared_secret: '',
    workspace_root: '',
    internet_enable_mutations: false,
    internet_enable_gateway_proxy: false,
    internet_enable_terminal: false,
    onlyoffice_callback_allowlist: '',
    collabora_secret: '',
    encryption_key: ''
  }
};

// ============================================================================
// Path Utilities
// ============================================================================

/**
 * Get the path to the config directory (~/.evobrew/)
 * @returns {string}
 */
function getConfigDir() {
  return path.join(os.homedir(), CONFIG_DIR_NAME);
}

/**
 * Get the path to the main config file (~/.evobrew/config.json)
 * @returns {string}
 */
function getConfigPath() {
  return path.join(getConfigDir(), CONFIG_FILE_NAME);
}

/**
 * Get the path to the database file (~/.evobrew/database.db)
 * @returns {string}
 */
function getDatabasePath() {
  return path.join(getConfigDir(), DATABASE_FILE_NAME);
}

/**
 * Get the path to the logs directory (~/.evobrew/logs/)
 * @returns {string}
 */
function getLogsDir() {
  return path.join(getConfigDir(), 'logs');
}

/**
 * Get the path to the SSL directory (~/.evobrew/ssl/)
 * @returns {string}
 */
function getSslDir() {
  return path.join(getConfigDir(), 'ssl');
}

// ============================================================================
// Directory Initialization
// ============================================================================

/**
 * Initialize the config directory structure.
 * Creates ~/.evobrew/ and subdirectories if they don't exist.
 * @returns {Promise<{created: boolean, path: string}>}
 */
async function initConfigDir() {
  const configDir = getConfigDir();
  const logsDir = getLogsDir();
  const sslDir = getSslDir();
  
  let created = false;
  
  // Create main config directory
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { mode: 0o700 }); // Owner read/write/execute only
    created = true;
  }
  
  // Create subdirectories
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { mode: 0o700 });
  }
  
  if (!fs.existsSync(sslDir)) {
    fs.mkdirSync(sslDir, { mode: 0o700 });
  }
  
  return { created, path: configDir };
}

/**
 * Check if config directory exists and is properly set up.
 * @returns {boolean}
 */
function configDirExists() {
  return fs.existsSync(getConfigDir()) && fs.existsSync(getConfigPath());
}

// ============================================================================
// Config Loading/Saving
// ============================================================================

/**
 * Load configuration from ~/.evobrew/config.json
 * Decrypts encrypted secrets automatically.
 * @returns {Promise<object>} - Decrypted config object
 * @throws {Error} - If config file doesn't exist or is invalid
 */
async function loadConfig() {
  const configPath = getConfigPath();
  
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}. Run 'evobrew setup' first.`);
  }
  
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw);
    
    // Decrypt secrets
    return decryptConfigSecrets(config);
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`Invalid JSON in config file: ${configPath}`);
    }
    throw err;
  }
}

/**
 * Load configuration, returning null if it doesn't exist (no throw).
 * @returns {Promise<object|null>}
 */
async function loadConfigSafe() {
  try {
    return await loadConfig();
  } catch (err) {
    return null;
  }
}

/**
 * Save configuration to ~/.evobrew/config.json
 * Encrypts secrets automatically before saving.
 * @param {object} config - Config object to save
 * @returns {Promise<void>}
 */
async function saveConfig(config) {
  const configPath = getConfigPath();
  
  // Ensure directory exists
  await initConfigDir();
  
  // Deep clone to avoid mutating original
  const toSave = JSON.parse(JSON.stringify(config));
  
  // Ensure version is set
  toSave.version = toSave.version || CONFIG_VERSION;
  
  // Encrypt secrets
  encryptConfigSecrets(toSave);
  
  // Write atomically (write to temp, then rename)
  const tempPath = configPath + '.tmp';
  fs.writeFileSync(tempPath, JSON.stringify(toSave, null, 2), { mode: 0o600 });
  fs.renameSync(tempPath, configPath);
}

/**
 * Get a default config object (not encrypted).
 * @returns {object}
 */
function getDefaultConfig() {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

// ============================================================================
// Migration from .env
// ============================================================================

/**
 * Parse a .env file into an object.
 * @param {string} envPath - Path to .env file
 * @returns {object} - Key-value pairs
 */
function parseEnvFile(envPath) {
  if (!fs.existsSync(envPath)) {
    throw new Error(`Env file not found: ${envPath}`);
  }
  
  const content = fs.readFileSync(envPath, 'utf-8');
  const result = {};
  
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    
    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith('#')) continue;
    
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    
    // Remove surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    
    result[key] = value;
  }
  
  return result;
}

/**
 * Migrate configuration from a .env file to config.json format.
 * @param {string} envPath - Path to .env file
 * @returns {Promise<object>} - Migrated config object
 */
async function migrateFromEnv(envPath) {
  const env = parseEnvFile(envPath);
  const config = getDefaultConfig();
  const envBool = (value, fallback = false) => {
    if (value === undefined || value === null || value === '') return fallback;
    return String(value).toLowerCase() === 'true';
  };
  
  // Server settings
  if (env.PORT) {
    config.server.http_port = parseInt(env.PORT, 10);
  }
  if (env.HTTPS_PORT) {
    config.server.https_port = parseInt(env.HTTPS_PORT, 10);
  }
  
  // OpenAI
  if (env.OPENAI_API_KEY) {
    config.providers.openai.enabled = true;
    config.providers.openai.api_key = env.OPENAI_API_KEY;
  }
  
  // Anthropic
  if (env.ANTHROPIC_API_KEY) {
    config.providers.anthropic.enabled = true;
    config.providers.anthropic.api_key = env.ANTHROPIC_API_KEY;
  }
  
  // xAI
  if (env.XAI_API_KEY) {
    config.providers.xai.enabled = true;
    config.providers.xai.api_key = env.XAI_API_KEY;
  }
  
  // OpenClaw
  if (env.OPENCLAW_GATEWAY_HOST || env.OPENCLAW_GATEWAY_PORT) {
    config.openclaw.enabled = true;
    const host = env.OPENCLAW_GATEWAY_HOST || 'localhost';
    const port = env.OPENCLAW_GATEWAY_PORT || '18789';
    config.openclaw.gateway_url = `ws://${host}:${port}`;
  }
  if (env.OPENCLAW_GATEWAY_TOKEN) {
    config.openclaw.token = env.OPENCLAW_GATEWAY_TOKEN;
  }
  if (env.OPENCLAW_GATEWAY_PASSWORD) {
    config.openclaw.password = env.OPENCLAW_GATEWAY_PASSWORD;
  }

  // Security profile and internet gates
  if (env.SECURITY_PROFILE) {
    config.security.profile = env.SECURITY_PROFILE;
  }
  if (env.EVOBREW_PROXY_SHARED_SECRET) {
    config.security.proxy_shared_secret = env.EVOBREW_PROXY_SHARED_SECRET;
  }
  if (env.WORKSPACE_ROOT) {
    config.security.workspace_root = env.WORKSPACE_ROOT;
  }
  if (env.ONLYOFFICE_CALLBACK_ALLOWLIST) {
    config.security.onlyoffice_callback_allowlist = env.ONLYOFFICE_CALLBACK_ALLOWLIST;
  }
  if (env.COLLABORA_SECRET) {
    config.security.collabora_secret = env.COLLABORA_SECRET;
  }
  if (env.ENCRYPTION_KEY) {
    config.security.encryption_key = env.ENCRYPTION_KEY;
  }
  if (env.INTERNET_ENABLE_MUTATIONS !== undefined) {
    config.security.internet_enable_mutations = envBool(env.INTERNET_ENABLE_MUTATIONS);
  }
  if (env.INTERNET_ENABLE_GATEWAY_PROXY !== undefined) {
    config.security.internet_enable_gateway_proxy = envBool(env.INTERNET_ENABLE_GATEWAY_PROXY);
  }
  if (env.INTERNET_ENABLE_TERMINAL !== undefined) {
    config.security.internet_enable_terminal = envBool(env.INTERNET_ENABLE_TERMINAL);
  }

  // Terminal gates
  if (env.TERMINAL_ENABLED !== undefined) {
    config.terminal.enabled = envBool(env.TERMINAL_ENABLED, true);
  }
  if (env.TERMINAL_MAX_SESSIONS_PER_CLIENT) {
    config.terminal.max_sessions_per_client = parseInt(env.TERMINAL_MAX_SESSIONS_PER_CLIENT, 10);
  }
  if (env.TERMINAL_IDLE_TIMEOUT_MS) {
    config.terminal.idle_timeout_ms = parseInt(env.TERMINAL_IDLE_TIMEOUT_MS, 10);
  }
  if (env.TERMINAL_MAX_BUFFER_BYTES) {
    config.terminal.max_buffer_bytes = parseInt(env.TERMINAL_MAX_BUFFER_BYTES, 10);
  }
  
  return config;
}

// ============================================================================
// Database Migration
// ============================================================================

/**
 * Migrate database from old location to ~/.evobrew/database.db
 * @param {string} oldDbPath - Path to old database file
 * @returns {Promise<{migrated: boolean, message: string}>}
 */
async function migrateDatabase(oldDbPath) {
  const newDbPath = getDatabasePath();
  
  // Check if old database exists
  if (!fs.existsSync(oldDbPath)) {
    return { migrated: false, message: 'No existing database to migrate' };
  }
  
  // Check if new database already exists
  if (fs.existsSync(newDbPath)) {
    return { migrated: false, message: 'Database already exists at new location' };
  }
  
  // Ensure config directory exists
  await initConfigDir();
  
  // Copy database file
  fs.copyFileSync(oldDbPath, newDbPath);
  fs.chmodSync(newDbPath, 0o600); // Owner read/write only
  
  return { migrated: true, message: `Database migrated to ${newDbPath}` };
}

// ============================================================================
// Config Accessors (Convenience Methods)
// ============================================================================

/**
 * Get a specific config value by dot-notation path.
 * @param {object} config - Config object
 * @param {string} path - Dot-notation path (e.g., 'server.http_port')
 * @param {*} defaultValue - Default if path not found
 * @returns {*}
 */
function getConfigValue(config, path, defaultValue = undefined) {
  const parts = path.split('.');
  let current = config;
  
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return defaultValue;
    }
    current = current[part];
  }
  
  return current !== undefined ? current : defaultValue;
}

/**
 * Set a specific config value by dot-notation path.
 * @param {object} config - Config object
 * @param {string} path - Dot-notation path
 * @param {*} value - Value to set
 */
function setConfigValue(config, path, value) {
  const parts = path.split('.');
  let current = config;
  
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!(part in current) || typeof current[part] !== 'object') {
      current[part] = {};
    }
    current = current[part];
  }
  
  current[parts[parts.length - 1]] = value;
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate a config object.
 * @param {object} config - Config to validate
 * @returns {{valid: boolean, errors: string[]}}
 */
function validateConfig(config) {
  const errors = [];
  
  if (!config) {
    return { valid: false, errors: ['Config is null or undefined'] };
  }
  
  // Check version
  if (!config.version) {
    errors.push('Missing version field');
  }
  
  // Check server config
  if (!config.server) {
    errors.push('Missing server configuration');
  } else {
    if (typeof config.server.http_port !== 'number' || config.server.http_port < 1) {
      errors.push('Invalid server.http_port');
    }
    if (typeof config.server.https_port !== 'number' || config.server.https_port < 1) {
      errors.push('Invalid server.https_port');
    }
  }
  
  // Check that at least one provider is configured
  const hasProvider = config.providers && (
    (config.providers.openai?.enabled && config.providers.openai?.api_key) ||
    (config.providers.anthropic?.enabled && (config.providers.anthropic?.api_key || config.providers.anthropic?.oauth)) ||
    (config.providers.xai?.enabled && config.providers.xai?.api_key) ||
    (config.providers['ollama-cloud']?.enabled && config.providers['ollama-cloud']?.api_key) ||
    (config.providers.ollama?.enabled) ||
    (config.providers.lmstudio?.enabled)
  );
  
  if (!hasProvider) {
    errors.push('At least one AI provider must be configured');
  }
  
  return { valid: errors.length === 0, errors };
}

// ============================================================================
// Environment Bridge
// ============================================================================

/**
 * Convert config to environment variables for backward compatibility.
 * Returns an object that can be merged with process.env.
 * @param {object} config - Decrypted config
 * @returns {object} - Environment variable key-value pairs
 */
function configToEnv(config) {
  const env = {};
  
  // Server
  if (config.server) {
    env.PORT = String(config.server.http_port || 3405);
    env.HTTPS_PORT = String(config.server.https_port || 3406);
  }
  
  // Providers
  if (config.providers?.openai?.api_key) {
    env.OPENAI_API_KEY = config.providers.openai.api_key;
  }
  if (config.providers?.anthropic?.api_key) {
    env.ANTHROPIC_API_KEY = config.providers.anthropic.api_key;
  }
  if (config.providers?.xai?.api_key) {
    env.XAI_API_KEY = config.providers.xai.api_key;
  }
  if (config.providers?.['ollama-cloud']?.api_key) {
    env.OLLAMA_CLOUD_API_KEY = config.providers['ollama-cloud'].api_key;
  }

  // Security / profile gates
  if (config.security?.encryption_key) {
    env.ENCRYPTION_KEY = config.security.encryption_key;
  }
  if (config.security?.profile) {
    env.SECURITY_PROFILE = String(config.security.profile);
  }
  if (config.security?.proxy_shared_secret) {
    env.EVOBREW_PROXY_SHARED_SECRET = config.security.proxy_shared_secret;
  }
  if (config.security?.workspace_root) {
    env.WORKSPACE_ROOT = config.security.workspace_root;
  }
  if (config.security?.onlyoffice_callback_allowlist) {
    env.ONLYOFFICE_CALLBACK_ALLOWLIST = config.security.onlyoffice_callback_allowlist;
  }
  if (config.security?.collabora_secret) {
    env.COLLABORA_SECRET = config.security.collabora_secret;
  }
  if (config.security?.internet_enable_mutations !== undefined) {
    env.INTERNET_ENABLE_MUTATIONS = String(Boolean(config.security.internet_enable_mutations));
  }
  if (config.security?.internet_enable_gateway_proxy !== undefined) {
    env.INTERNET_ENABLE_GATEWAY_PROXY = String(Boolean(config.security.internet_enable_gateway_proxy));
  }
  if (config.security?.internet_enable_terminal !== undefined) {
    env.INTERNET_ENABLE_TERMINAL = String(Boolean(config.security.internet_enable_terminal));
  }

  // Terminal
  if (config.terminal?.enabled !== undefined) {
    env.TERMINAL_ENABLED = String(Boolean(config.terminal.enabled));
  }
  if (config.terminal?.max_sessions_per_client !== undefined) {
    env.TERMINAL_MAX_SESSIONS_PER_CLIENT = String(config.terminal.max_sessions_per_client);
  }
  if (config.terminal?.idle_timeout_ms !== undefined) {
    env.TERMINAL_IDLE_TIMEOUT_MS = String(config.terminal.idle_timeout_ms);
  }
  if (config.terminal?.max_buffer_bytes !== undefined) {
    env.TERMINAL_MAX_BUFFER_BYTES = String(config.terminal.max_buffer_bytes);
  }
  
  // OpenClaw
  if (config.openclaw?.gateway_url) {
    try {
      const url = new URL(config.openclaw.gateway_url);
      env.OPENCLAW_GATEWAY_HOST = url.hostname;
      env.OPENCLAW_GATEWAY_PORT = url.port || '18789';
    } catch (e) {
      // Invalid URL, skip
    }
  }
  if (config.openclaw?.token) {
    env.OPENCLAW_GATEWAY_TOKEN = config.openclaw.token;
  }
  if (config.openclaw?.password) {
    env.OPENCLAW_GATEWAY_PASSWORD = config.openclaw.password;
  }
  
  return env;
}

/**
 * Apply config to process.env for backward compatibility.
 * @param {object} config - Decrypted config
 */
function applyConfigToEnv(config) {
  const env = configToEnv(config);
  for (const [key, value] of Object.entries(env)) {
    // Don't override existing env vars
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  // Paths
  getConfigDir,
  getConfigPath,
  getDatabasePath,
  getLogsDir,
  getSslDir,
  
  // Directory management
  initConfigDir,
  configDirExists,
  
  // Config operations
  loadConfig,
  loadConfigSafe,
  saveConfig,
  getDefaultConfig,
  
  // Migration
  migrateFromEnv,
  migrateDatabase,
  parseEnvFile,
  
  // Utilities
  getConfigValue,
  setConfigValue,
  validateConfig,
  
  // Environment bridge
  configToEnv,
  applyConfigToEnv,
  
  // Constants
  CONFIG_VERSION,
  DEFAULT_CONFIG
};
