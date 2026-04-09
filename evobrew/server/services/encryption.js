/**
 * COSMO Unified - API Key Encryption Service
 * 
 * AES-256-GCM encryption for user API keys (BYOK)
 * Keys are encrypted at rest in the database
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits

// Get encryption key from environment (must be 64 hex chars = 32 bytes)
function getEncryptionKey() {
  const key = process.env.ENCRYPTION_KEY;
  
  if (!key) {
    throw new Error('ENCRYPTION_KEY environment variable not set. Generate with: openssl rand -hex 32');
  }
  
  if (key.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be 64 hex characters (32 bytes). Current length: ' + key.length);
  }
  
  return Buffer.from(key, 'hex');
}

/**
 * Encrypt an API key
 * @param {string} plaintext - The API key to encrypt
 * @returns {string} - Format: "IV:AuthTag:Encrypted" (all hex)
 */
function encryptApiKey(plaintext) {
  if (!plaintext || typeof plaintext !== 'string') {
    throw new Error('API key must be a non-empty string');
  }
  
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(16); // 128-bit IV
  
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag();
  
  // Return as: IV:AuthTag:Encrypted (all hex)
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt an API key
 * @param {string} encryptedData - Format: "IV:AuthTag:Encrypted"
 * @returns {string} - The decrypted API key
 */
function decryptApiKey(encryptedData) {
  if (!encryptedData || typeof encryptedData !== 'string') {
    throw new Error('Encrypted data must be a non-empty string');
  }
  
  const parts = encryptedData.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted data format. Expected: IV:AuthTag:Encrypted');
  }
  
  const [ivHex, authTagHex, encryptedHex] = parts;
  
  const key = getEncryptionKey();
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  
  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

/**
 * Get key prefix for display (first 7 chars)
 * @param {string} apiKey - The API key
 * @returns {string} - e.g. "sk-proj"
 */
function getKeyPrefix(apiKey) {
  if (!apiKey || apiKey.length < 7) {
    return 'sk-***';
  }
  return apiKey.substring(0, 7);
}

/**
 * Validate API key format (basic check)
 * @param {string} apiKey - The API key to validate
 * @param {string} provider - 'OPENAI' | 'ANTHROPIC' | etc.
 * @returns {boolean}
 */
function validateKeyFormat(apiKey, provider = 'OPENAI') {
  if (!apiKey || typeof apiKey !== 'string') {
    return false;
  }

  // Trim whitespace
  apiKey = apiKey.trim();

  switch (provider) {
    case 'OPENAI':
      // OpenAI keys start with sk- and are typically 40+ chars
      return apiKey.startsWith('sk-') && apiKey.length >= 40;

    case 'ANTHROPIC':
      // Anthropic keys start with sk-ant- (older) or sk- (newer format)
      // Length varies, just check minimum
      return (apiKey.startsWith('sk-ant-') || apiKey.startsWith('sk-')) && apiKey.length >= 40;

    case 'XAI':
      // xAI keys - be lenient, just check it's a reasonable length
      // They might start with xai- or other prefixes
      return apiKey.length >= 30;

    default:
      // Generic: at least 20 chars
      return apiKey.length >= 20;
  }
}

/**
 * Test if an API key actually works (optional)
 * @param {string} apiKey - The API key to test
 * @param {string} provider - 'OPENAI' | 'ANTHROPIC'
 * @returns {Promise<{valid: boolean, error?: string}>}
 */
async function testApiKey(apiKey, provider = 'OPENAI') {
  try {
    if (provider === 'OPENAI') {
      const OpenAI = require('openai');
      const client = new OpenAI({ apiKey });

      // Simple test: list models
      await client.models.list();
      return { valid: true };
    }

    if (provider === 'ANTHROPIC') {
      try {
        const Anthropic = require('@anthropic-ai/sdk');
        const client = new Anthropic({ apiKey });

        // Simple test: small completion
        await client.messages.create({
          model: 'claude-3-5-haiku-20241022',
          max_tokens: 10,
          messages: [{ role: 'user', content: 'Hi' }]
        });
        return { valid: true };
      } catch (e) {
        // If Anthropic SDK not installed, skip validation
        if (e.code === 'MODULE_NOT_FOUND') {
          return { valid: true, skipped: true };
        }
        throw e;
      }
    }

    if (provider === 'XAI') {
      // xAI uses OpenAI-compatible API
      try {
        const OpenAI = require('openai');
        const client = new OpenAI({
          apiKey,
          baseURL: 'https://api.x.ai/v1'
        });
        await client.models.list();
        return { valid: true };
      } catch (e) {
        // If validation fails, still allow saving (user can test manually)
        console.warn('XAI key validation failed, allowing anyway:', e.message);
        return { valid: true, skipped: true };
      }
    }

    // For unknown providers, skip validation but allow saving
    return { valid: true, skipped: true };

  } catch (error) {
    return {
      valid: false,
      error: error.message || 'API key validation failed'
    };
  }
}

module.exports = {
  encryptApiKey,
  decryptApiKey,
  getKeyPrefix,
  validateKeyFormat,
  testApiKey
};
