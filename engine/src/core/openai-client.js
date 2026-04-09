const OpenAI = require('openai');
const path = require('path');
const dotenv = require('dotenv');

// Load environment variables from local .env file
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

let cachedClient;

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
