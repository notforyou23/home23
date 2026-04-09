/**
 * Evobrew - Encryption Module
 * 
 * Machine-specific encryption for config secrets.
 * Uses AES-256-GCM with key derived from machine identity.
 * 
 * @module lib/encryption
 */

const crypto = require('crypto');
const os = require('os');

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const ENCRYPTED_PREFIX = 'encrypted:';

/**
 * Get encryption key from environment, config, or derive from machine.
 * Priority:
 * 1. ENCRYPTION_KEY environment variable (hex string, 64 chars = 32 bytes)
 * 2. ~/.evobrew/config.json security.encryption_key
 * 3. Machine-derived key (fallback for backward compatibility)
 */
function getEncryptionKey() {
  // 1. Check environment variable
  if (process.env.ENCRYPTION_KEY) {
    const keyHex = process.env.ENCRYPTION_KEY;
    if (keyHex.length === 64) {
      return Buffer.from(keyHex, 'hex');
    }
    console.warn('[ENCRYPTION] ENCRYPTION_KEY env var invalid length, falling back');
  }
  
  // 2. Check config file
  try {
    const path = require('path');
    const configPath = process.env.EVOBREW_CONFIG_PATH || 
      path.join(os.homedir(), '.evobrew', 'config.json');
    
    const fs = require('fs');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const keyHex = config.security?.encryption_key;
      if (keyHex && keyHex.length === 64) {
        return Buffer.from(keyHex, 'hex');
      }
    }
  } catch {
    // Ignore config read errors, fall through to machine key
  }
  
  // 3. Fall back to machine-derived key
  return deriveMachineKey();
}

/**
 * Derive a machine-specific encryption key.
 * Uses hostname + username + a salt to create a deterministic key.
 * This means secrets encrypted on one machine won't decrypt on another.
 */
function deriveMachineKey() {
  const hostname = os.hostname();
  const username = os.userInfo().username;
  const salt = 'evobrew-v1-config-salt'; // Fixed salt for determinism
  
  // Combine identity factors
  const identity = `${hostname}:${username}:${salt}`;
  
  // Use PBKDF2 to derive a 256-bit key
  return crypto.pbkdf2Sync(identity, salt, 100000, KEY_LENGTH, 'sha256');
}

// Cache the encryption key
let _encryptionKey = null;

function getMachineKey() {
  if (!_encryptionKey) {
    _encryptionKey = getEncryptionKey();
  }
  return _encryptionKey;
}

/**
 * Encrypt a secret value.
 * @param {string} plaintext - The secret to encrypt
 * @returns {string} - Encrypted value prefixed with "encrypted:"
 */
function encrypt(plaintext) {
  if (!plaintext || typeof plaintext !== 'string') {
    throw new Error('Plaintext must be a non-empty string');
  }
  
  // Don't double-encrypt
  if (plaintext.startsWith(ENCRYPTED_PREFIX)) {
    return plaintext;
  }
  
  const key = getMachineKey();
  const iv = crypto.randomBytes(16); // 128-bit IV
  
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag();
  
  // Format: encrypted:IV:AuthTag:Encrypted (all hex)
  return `${ENCRYPTED_PREFIX}${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt an encrypted value.
 * @param {string} encryptedValue - Value prefixed with "encrypted:"
 * @returns {string} - The decrypted secret
 */
function decrypt(encryptedValue) {
  if (!encryptedValue || typeof encryptedValue !== 'string') {
    throw new Error('Encrypted value must be a non-empty string');
  }
  
  // Handle non-encrypted values (pass through)
  if (!encryptedValue.startsWith(ENCRYPTED_PREFIX)) {
    return encryptedValue;
  }
  
  const payload = encryptedValue.slice(ENCRYPTED_PREFIX.length);
  const parts = payload.split(':');
  
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted data format. Expected: encrypted:IV:AuthTag:Data');
  }
  
  const [ivHex, authTagHex, encryptedHex] = parts;
  
  const key = getMachineKey();
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  
  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

/**
 * Check if a value is encrypted.
 * @param {string} value - The value to check
 * @returns {boolean}
 */
function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(ENCRYPTED_PREFIX);
}

/**
 * Get a safe display version of a secret (masked).
 * @param {string} secret - The secret to mask
 * @param {number} showChars - Characters to show at start/end
 * @returns {string}
 */
function mask(secret, showChars = 4) {
  if (!secret || typeof secret !== 'string') {
    return '***';
  }
  
  // If encrypted, indicate that
  if (isEncrypted(secret)) {
    return '[encrypted]';
  }
  
  if (secret.length <= showChars * 2) {
    return '***';
  }
  
  const start = secret.slice(0, showChars);
  const end = secret.slice(-showChars);
  return `${start}...${end}`;
}

/**
 * Encrypt secrets in a config object (mutates the object).
 * Only encrypts string values for keys ending in: _key, _token, _password, _secret
 * @param {object} config - Config object to encrypt secrets in
 * @returns {object} - Same object with encrypted secrets
 */
function encryptConfigSecrets(config) {
  const secretPatterns = ['api_key', 'token', 'password', 'secret'];
  
  function processObject(obj, path = '') {
    if (!obj || typeof obj !== 'object') return;
    
    for (const [key, value] of Object.entries(obj)) {
      const fullPath = path ? `${path}.${key}` : key;
      
      if (typeof value === 'string' && value.length > 0) {
        // Check if this key should be encrypted
        const shouldEncrypt = secretPatterns.some(pattern => 
          key.toLowerCase().includes(pattern)
        );
        
        if (shouldEncrypt && !isEncrypted(value)) {
          obj[key] = encrypt(value);
        }
      } else if (typeof value === 'object' && value !== null) {
        processObject(value, fullPath);
      }
    }
  }
  
  processObject(config);
  return config;
}

/**
 * Decrypt secrets in a config object (returns new object).
 * @param {object} config - Config object with encrypted secrets
 * @returns {object} - New object with decrypted secrets
 */
function decryptConfigSecrets(config) {
  function processValue(value) {
    if (typeof value === 'string' && isEncrypted(value)) {
      try {
        return decrypt(value);
      } catch (err) {
        console.warn('Failed to decrypt value:', err.message);
        return value; // Return as-is if decryption fails
      }
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

module.exports = {
  encrypt,
  decrypt,
  isEncrypted,
  mask,
  encryptConfigSecrets,
  decryptConfigSecrets,
  ENCRYPTED_PREFIX
};
