const fetch = require('node-fetch');

/**
 * Key Validator
 * 
 * Tests discovered API keys to verify they still work.
 * Many keys expire or have rate limits.
 */
class KeyValidator {
  constructor(logger) {
    this.logger = logger;
    
    // API-specific test endpoints
    this.testEndpoints = new Map([
      ['github', {
        url: 'https://api.github.com/user',
        method: 'GET',
        headers: (key) => ({ 'Authorization': `token ${key}` })
      }],
      ['openai', {
        url: 'https://api.openai.com/v1/models',
        method: 'GET',
        headers: (key) => ({ 'Authorization': `Bearer ${key}` })
      }],
      ['anthropic', {
        url: 'https://api.anthropic.com/v1/models',
        method: 'GET',
        headers: (key) => ({ 
          'x-api-key': key,
          'anthropic-version': '2023-06-01'
        })
      }]
      // Add more as we discover them
    ]);
  }
  
  /**
   * Validate a key by making a test API call
   */
  async validate(keyValue, apiName) {
    const endpoint = this.testEndpoints.get(apiName.toLowerCase());
    
    if (!endpoint) {
      // No test endpoint configured - assume valid for now
      return {
        valid: true,
        tier: 'unknown',
        rateLimits: null,
        message: 'No test endpoint configured'
      };
    }
    
    try {
      const response = await fetch(endpoint.url, {
        method: endpoint.method,
        headers: endpoint.headers(keyValue),
        timeout: 10000 // 10s timeout
      });
      
      if (response.ok) {
        // Key works!
        const rateLimits = this.parseRateLimits(response.headers);
        const tier = this.detectTier(response.headers, rateLimits);
        
        return {
          valid: true,
          tier,
          rateLimits,
          message: 'Key validated successfully'
        };
        
      } else if (response.status === 401 || response.status === 403) {
        // Invalid or expired key
        return {
          valid: false,
          error: `HTTP ${response.status}: Invalid or expired key`
        };
        
      } else if (response.status === 429) {
        // Rate limited - key might still be valid
        return {
          valid: true,
          tier: 'rate-limited',
          rateLimits: this.parseRateLimits(response.headers),
          message: 'Rate limited but key appears valid'
        };
        
      } else {
        // Other error
        return {
          valid: false,
          error: `HTTP ${response.status}: ${response.statusText}`
        };
      }
      
    } catch (error) {
      // Network error or timeout
      return {
        valid: false,
        error: error.message
      };
    }
  }
  
  /**
   * Parse rate limit headers
   */
  parseRateLimits(headers) {
    const limits = {};
    
    // GitHub-style headers
    if (headers.get('x-ratelimit-limit')) {
      limits.limit = parseInt(headers.get('x-ratelimit-limit'));
      limits.remaining = parseInt(headers.get('x-ratelimit-remaining'));
      limits.reset = parseInt(headers.get('x-ratelimit-reset'));
    }
    
    // OpenAI-style headers
    if (headers.get('x-ratelimit-limit-requests')) {
      limits.requestsLimit = parseInt(headers.get('x-ratelimit-limit-requests'));
      limits.requestsRemaining = parseInt(headers.get('x-ratelimit-remaining-requests'));
    }
    
    if (headers.get('x-ratelimit-limit-tokens')) {
      limits.tokensLimit = parseInt(headers.get('x-ratelimit-limit-tokens'));
      limits.tokensRemaining = parseInt(headers.get('x-ratelimit-remaining-tokens'));
    }
    
    return Object.keys(limits).length > 0 ? limits : null;
  }
  
  /**
   * Detect key tier from rate limits
   */
  detectTier(headers, rateLimits) {
    if (!rateLimits || !rateLimits.limit) {
      return 'unknown';
    }
    
    const limit = rateLimits.limit;
    
    // Heuristic tiers (adjust as we learn more)
    if (limit < 100) return 'sandbox';
    if (limit < 1000) return 'free';
    if (limit < 10000) return 'basic';
    return 'paid'; // unlikely for discovered keys
  }
  
  /**
   * Register a test endpoint for a new API
   */
  registerTestEndpoint(apiName, config) {
    this.testEndpoints.set(apiName.toLowerCase(), config);
    this.logger.info('Registered test endpoint', { api: apiName });
  }
}

module.exports = { KeyValidator };
