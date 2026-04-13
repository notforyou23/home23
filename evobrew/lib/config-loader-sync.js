/**
 * Evobrew - Synchronous Configuration Loader
 * 
 * Synchronous version of config-loader for use at server startup.
 * Node.js requires sync loading at module initialization time.
 * 
 * @module lib/config-loader-sync
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

// ============================================================================
// Inline encryption (avoid circular dependency with async lib)
// ============================================================================

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const ENCRYPTED_PREFIX = 'encrypted:';

function deriveMachineKey() {
  const crypto = require('crypto');
  const hostname = os.hostname();
  const username = os.userInfo().username;
  const salt = 'evobrew-v1-config-salt';
  const identity = `${hostname}:${username}:${salt}`;
  return crypto.pbkdf2Sync(identity, salt, 100000, KEY_LENGTH, 'sha256');
}

function getEncryptionKey() {
  // 1) Runtime env override
  if (process.env.ENCRYPTION_KEY && process.env.ENCRYPTION_KEY.length === 64) {
    return Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
  }

  // 2) Config file security key
  try {
    const configPath = path.join(os.homedir(), '.evobrew', 'config.json');
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const keyHex = raw?.security?.encryption_key;
      if (typeof keyHex === 'string' && keyHex.length === 64) {
        return Buffer.from(keyHex, 'hex');
      }
    }
  } catch {
    // fall through
  }

  // 3) Backward-compatible machine-derived key
  return deriveMachineKey();
}

let _machineKey = null;
function getMachineKey() {
  if (!_machineKey) {
    _machineKey = getEncryptionKey();
  }
  return _machineKey;
}

function decrypt(encryptedValue) {
  const crypto = require('crypto');
  
  if (!encryptedValue || typeof encryptedValue !== 'string') {
    return encryptedValue;
  }
  
  if (!encryptedValue.startsWith(ENCRYPTED_PREFIX)) {
    return encryptedValue;
  }
  
  const payload = encryptedValue.slice(ENCRYPTED_PREFIX.length);
  const parts = payload.split(':');
  
  if (parts.length !== 3) {
    return encryptedValue; // Return as-is if format invalid
  }
  
  const [ivHex, authTagHex, encryptedHex] = parts;
  
  try {
    const key = getMachineKey();
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (err) {
    console.warn('[CONFIG] Decryption failed:', err.message);
    return encryptedValue;
  }
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(ENCRYPTED_PREFIX);
}

function decryptConfigSecrets(config) {
  function processValue(value) {
    if (typeof value === 'string' && isEncrypted(value)) {
      return decrypt(value);
    }
    
    if (Array.isArray(value)) {
      return value.map(processValue);
    }
    
    if (typeof value === 'object' && value !== null) {
      const result = {};
      for (const [k, v] of Object.entries(value)) {
        result[k] = processValue(v);
      }
      return result;
    }
    
    return value;
  }
  
  return processValue(config);
}

// ============================================================================
// Config paths
// ============================================================================

const CONFIG_DIR_NAME = '.evobrew';
const CONFIG_FILE_NAME = 'config.json';

function getConfigDir() {
  return path.join(os.homedir(), CONFIG_DIR_NAME);
}

function getConfigPath() {
  return path.join(getConfigDir(), CONFIG_FILE_NAME);
}

function getDatabasePath() {
  return path.join(getConfigDir(), 'database.db');
}

function configDirExists() {
  return fs.existsSync(getConfigDir()) && fs.existsSync(getConfigPath());
}

// ============================================================================
// Default config
// ============================================================================

const DEFAULT_CONFIG = {
  version: '1.0.0',
  server: {
    http_port: 3405,
    https_port: 3406,
    bind: 'localhost'
  },
  providers: {
    openai: { enabled: false, api_key: '' },
    anthropic: { enabled: false, oauth: false, api_key: '' },
    xai: { enabled: false, api_key: '' }
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
    collabora_secret: ''
  }
};

// ============================================================================
// Config loading (synchronous)
// ============================================================================

/**
 * Configuration source types
 */
const ConfigSource = {
  GLOBAL_CONFIG: 'global',
  ENV_FILE: 'env',
  DEFAULTS: 'defaults'
};

/**
 * Load configuration synchronously.
 * @param {object} options
 * @param {string} options.projectRoot - Project root for .env fallback
 * @param {boolean} options.applyToEnv - Apply config to process.env
 * @param {boolean} options.silent - Suppress console output
 * @returns {{config: object, source: string}}
 */
function loadConfigurationSync(options = {}) {
  const {
    projectRoot = process.cwd(),
    applyToEnv = true,
    silent = false
  } = options;
  
  const log = silent ? () => {} : console.log.bind(console);
  
  // Try global config first
  const configPath = getConfigPath();
  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(raw);
      const decrypted = decryptConfigSecrets(config);
      
      log('[CONFIG] ✓ Loaded from ~/.evobrew/config.json');
      
      if (applyToEnv) {
        applyConfigToEnv(decrypted);
      }
      
      return { config: decrypted, source: ConfigSource.GLOBAL_CONFIG };
    } catch (err) {
      log(`[CONFIG] ⚠ Failed to load global config: ${err.message}`);
    }
  }
  
  // Fall back to .env file
  const envPath = path.join(projectRoot, '.env');
  if (fs.existsSync(envPath)) {
    require('dotenv').config({ path: envPath });
    
    log('[CONFIG] ✓ Loaded from .env file (legacy mode)');
    
    const config = envToConfig();
    return { config, source: ConfigSource.ENV_FILE };
  }
  
  // No config found - use defaults
  log('[CONFIG] ⚠ No configuration found. Using defaults.');
  log('[CONFIG] Run "evobrew setup" to create ~/.evobrew/config.json');
  
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  return { config, source: ConfigSource.DEFAULTS };
}

/**
 * Convert current process.env to a config object.
 */
function envToConfig() {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  const envBool = (value, fallback = false) => {
    if (value === undefined || value === null || value === '') return fallback;
    return String(value).toLowerCase() === 'true';
  };
  
  if (process.env.PORT) {
    config.server.http_port = parseInt(process.env.PORT, 10);
  }
  if (process.env.HTTPS_PORT) {
    config.server.https_port = parseInt(process.env.HTTPS_PORT, 10);
  }
  
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
 * Apply config to process.env for backward compatibility.
 */
function applyConfigToEnv(config) {
  // Server
  if (config.server) {
    if (!process.env.PORT) {
      process.env.PORT = String(config.server.http_port || 3405);
    }
    if (!process.env.HTTPS_PORT) {
      process.env.HTTPS_PORT = String(config.server.https_port || 3406);
    }
  }
  
  // Providers
  if (config.providers?.openai?.api_key && !process.env.OPENAI_API_KEY) {
    process.env.OPENAI_API_KEY = config.providers.openai.api_key;
  }
  if (config.providers?.anthropic?.api_key && !process.env.ANTHROPIC_API_KEY) {
    process.env.ANTHROPIC_API_KEY = config.providers.anthropic.api_key;
  }
  if (config.providers?.xai?.api_key && !process.env.XAI_API_KEY) {
    process.env.XAI_API_KEY = config.providers.xai.api_key;
  }
  if (config.providers?.['ollama-cloud']?.api_key && !process.env.OLLAMA_CLOUD_API_KEY) {
    process.env.OLLAMA_CLOUD_API_KEY = config.providers['ollama-cloud'].api_key;
  }
  
  // Security
  if (config.security?.encryption_key && !process.env.ENCRYPTION_KEY) {
    process.env.ENCRYPTION_KEY = config.security.encryption_key;
  }
  if (config.security?.profile && !process.env.SECURITY_PROFILE) {
    process.env.SECURITY_PROFILE = String(config.security.profile);
  }
  if (config.security?.proxy_shared_secret && !process.env.EVOBREW_PROXY_SHARED_SECRET) {
    process.env.EVOBREW_PROXY_SHARED_SECRET = config.security.proxy_shared_secret;
  }
  if (config.security?.workspace_root && !process.env.WORKSPACE_ROOT) {
    process.env.WORKSPACE_ROOT = config.security.workspace_root;
  }
  if (config.security?.onlyoffice_callback_allowlist && !process.env.ONLYOFFICE_CALLBACK_ALLOWLIST) {
    process.env.ONLYOFFICE_CALLBACK_ALLOWLIST = config.security.onlyoffice_callback_allowlist;
  }
  if (config.security?.collabora_secret && !process.env.COLLABORA_SECRET) {
    process.env.COLLABORA_SECRET = config.security.collabora_secret;
  }
  if (config.security?.internet_enable_mutations !== undefined && !process.env.INTERNET_ENABLE_MUTATIONS) {
    process.env.INTERNET_ENABLE_MUTATIONS = String(Boolean(config.security.internet_enable_mutations));
  }
  if (config.security?.internet_enable_gateway_proxy !== undefined && !process.env.INTERNET_ENABLE_GATEWAY_PROXY) {
    process.env.INTERNET_ENABLE_GATEWAY_PROXY = String(Boolean(config.security.internet_enable_gateway_proxy));
  }
  if (config.security?.internet_enable_terminal !== undefined && !process.env.INTERNET_ENABLE_TERMINAL) {
    process.env.INTERNET_ENABLE_TERMINAL = String(Boolean(config.security.internet_enable_terminal));
  }

  // Terminal
  if (config.terminal?.enabled !== undefined && !process.env.TERMINAL_ENABLED) {
    process.env.TERMINAL_ENABLED = String(Boolean(config.terminal.enabled));
  }
  if (config.terminal?.max_sessions_per_client !== undefined && !process.env.TERMINAL_MAX_SESSIONS_PER_CLIENT) {
    process.env.TERMINAL_MAX_SESSIONS_PER_CLIENT = String(config.terminal.max_sessions_per_client);
  }
  if (config.terminal?.idle_timeout_ms !== undefined && !process.env.TERMINAL_IDLE_TIMEOUT_MS) {
    process.env.TERMINAL_IDLE_TIMEOUT_MS = String(config.terminal.idle_timeout_ms);
  }
  if (config.terminal?.max_buffer_bytes !== undefined && !process.env.TERMINAL_MAX_BUFFER_BYTES) {
    process.env.TERMINAL_MAX_BUFFER_BYTES = String(config.terminal.max_buffer_bytes);
  }

  // OpenClaw
  if (config.openclaw?.gateway_url) {
    try {
      const url = new URL(config.openclaw.gateway_url);
      if (!process.env.OPENCLAW_GATEWAY_HOST) {
        process.env.OPENCLAW_GATEWAY_HOST = url.hostname;
      }
      if (!process.env.OPENCLAW_GATEWAY_PORT) {
        process.env.OPENCLAW_GATEWAY_PORT = url.port || '18789';
      }
    } catch (e) {
      // Invalid URL, skip
    }
  }
  if (config.openclaw?.token && !process.env.OPENCLAW_GATEWAY_TOKEN) {
    process.env.OPENCLAW_GATEWAY_TOKEN = config.openclaw.token;
  }
  if (config.openclaw?.password && !process.env.OPENCLAW_GATEWAY_PASSWORD) {
    process.env.OPENCLAW_GATEWAY_PASSWORD = config.openclaw.password;
  }
}

/**
 * Get database URL for Prisma.
 */
function getDatabaseUrl() {
  if (configDirExists()) {
    return `file:${getDatabasePath()}`;
  }
  return process.env.DATABASE_URL || 'file:./prisma/studio.db';
}

module.exports = {
  loadConfigurationSync,
  envToConfig,
  applyConfigToEnv,
  getDatabaseUrl,
  getDatabasePath,
  getConfigDir,
  getConfigPath,
  configDirExists,
  ConfigSource,
  DEFAULT_CONFIG
};
