const path = require('path');

// Load environment variables from local .env file
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
} catch {
  // dotenv is optional for tests and deployments that inject env directly.
}

let cachedClient;

function loadOpenAI() {
  try {
    return require('openai');
  } catch (error) {
    error.message = `OpenAI SDK is unavailable: ${error.message}`;
    throw error;
  }
}

/**
 * Self-contained OpenAI client for Phase 2B
 * Replaces dependency on external cosmo backend
 */
function getOpenAIClient() {
  if (!cachedClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    const baseURL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';

    if (!apiKey) {
      throw new Error('OPENAI_API_KEY environment variable is required');
    }

    const OpenAI = loadOpenAI();
    cachedClient = new OpenAI({
      apiKey,
      baseURL,
    });
  }

  return cachedClient;
}

let cachedEmbeddingClient;

/**
 * Embedding client — points at Ollama (or any OpenAI-compatible endpoint).
 * Kept separate from chat client to avoid cross-contamination of baseURL/apiKey.
 * Default: http://127.0.0.1:11434/v1 (local Ollama)
 */
function getEmbeddingClient() {
  if (!cachedEmbeddingClient) {
    const baseURL = process.env.EMBEDDING_BASE_URL || 'http://127.0.0.1:11434/v1';
    const apiKey = process.env.EMBEDDING_API_KEY || 'ollama';

    const OpenAI = loadOpenAI();
    cachedEmbeddingClient = new OpenAI({
      apiKey,
      baseURL,
      defaultQuery: { dimensions: 512 }, // Ollama honors this; keeps stored vectors compatible
    });
  }

  return cachedEmbeddingClient;
}

/**
 * Get OpenAI configuration for debugging
 */
function getOpenAIConfig() {
  return {
    apiKey: process.env.OPENAI_API_KEY ? '[REDACTED]' : 'NOT SET',
    baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    hasApiKey: Boolean(process.env.OPENAI_API_KEY),
    envFile: path.join(__dirname, '..', '..', '.env')
  };
}

module.exports = {
  getOpenAIClient,
  getEmbeddingClient,
  getOpenAIConfig
};
