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
  getOpenAIConfig
};
