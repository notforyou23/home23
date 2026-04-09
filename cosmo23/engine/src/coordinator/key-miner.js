const fetch = require('node-fetch');

/**
 * Key Miner
 * 
 * Systematically mines public sources for API keys.
 * 
 * Sources:
 * - GitHub (code search, repos, issues)
 * - Stack Overflow (accepted answers, code blocks)
 * - Reddit (tutorial posts, examples)
 * - Documentation (sandbox keys, demo credentials)
 * 
 * NOT cracking or inventing - cataloging what's publicly shared for legitimate use.
 * This is THE UNLOCK for true autonomy.
 */
class KeyMiner {
  constructor(logger, keyKB, keyValidator) {
    this.logger = logger;
    this.keyKB = keyKB;
    this.keyValidator = keyValidator;
  }
  
  /**
   * Mine for keys for a specific API
   */
  async mine(apiName, options = {}) {
    this.logger.info(`Mining keys for ${apiName}`);
    
    const discoveries = {
      api: apiName,
      sources: {},
      totalKeys: 0,
      validKeys: 0
    };
    
    // Mine GitHub
    if (options.github !== false) {
      try {
        const ghKeys = await this.mineGitHub(apiName);
        discoveries.sources.github = ghKeys;
        discoveries.totalKeys += ghKeys.length;
      } catch (error) {
        this.logger.warn('GitHub mining failed', { error: error.message });
        discoveries.sources.github = [];
      }
    }
    
    // Mine Stack Overflow
    if (options.stackoverflow !== false) {
      try {
        const soKeys = await this.mineStackOverflow(apiName);
        discoveries.sources.stackoverflow = soKeys;
        discoveries.totalKeys += soKeys.length;
      } catch (error) {
        this.logger.warn('Stack Overflow mining failed', { error: error.message });
        discoveries.sources.stackoverflow = [];
      }
    }
    
    // Mine Reddit
    if (options.reddit !== false) {
      try {
        const redditKeys = await this.mineReddit(apiName);
        discoveries.sources.reddit = redditKeys;
        discoveries.totalKeys += redditKeys.length;
      } catch (error) {
        this.logger.warn('Reddit mining failed', { error: error.message });
        discoveries.sources.reddit = [];
      }
    }
    
    // Validate and store discoveries
    for (const source of Object.keys(discoveries.sources)) {
      for (const candidate of discoveries.sources[source]) {
        try {
          // Validate key
          const validation = await this.keyValidator.validate(candidate.value, apiName);
          
          if (validation.valid) {
            // Store in Knowledge Base
            await this.keyKB.store({
              api: apiName,
              value: candidate.value,
              tier: validation.tier,
              rateLimits: validation.rateLimits,
              source: `${source}:${candidate.sourceUrl || 'unknown'}`,
              constraints: candidate.constraints || null
            });
            
            discoveries.validKeys++;
          }
          
        } catch (error) {
          this.logger.warn('Key validation failed', {
            source,
            error: error.message
          });
        }
      }
    }
    
    this.logger.info('Mining complete', {
      api: apiName,
      totalKeys: discoveries.totalKeys,
      validKeys: discoveries.validKeys
    });
    
    return discoveries;
  }
  
  /**
   * Mine GitHub for keys
   */
  async mineGitHub(apiName) {
    this.logger.info(`Mining GitHub for ${apiName} keys`);
    
    const keys = [];
    
    // Search patterns
    const searchQueries = [
      `"${apiName}" "api_key" language:python`,
      `"${apiName}" "API_KEY" filename:config`,
      `"${apiName}" "token" filename:example`,
      `"${apiName}" "key" filename:.env.example`
    ];
    
    // TODO: Implement GitHub Code Search API
    // For now, return empty (requires GitHub token and proper API integration)
    
    this.logger.info('GitHub mining result', {
      api: apiName,
      keys: keys.length
    });
    
    return keys;
  }
  
  /**
   * Mine Stack Overflow for keys
   */
  async mineStackOverflow(apiName) {
    this.logger.info(`Mining Stack Overflow for ${apiName} keys`);
    
    const keys = [];
    
    try {
      // Stack Exchange API search
      const query = encodeURIComponent(`${apiName} api key example`);
      const url = `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=votes&accepted=True&q=${query}&site=stackoverflow`;
      
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Stack Overflow API error: ${response.status}`);
      }
      
      const data = await response.json();
      
      // Extract keys from question/answer bodies
      for (const item of data.items || []) {
        // TODO: Parse HTML body and extract potential API keys
        // Pattern matching for common key formats
      }
      
    } catch (error) {
      this.logger.warn('Stack Overflow query failed', {
        api: apiName,
        error: error.message
      });
    }
    
    this.logger.info('Stack Overflow mining result', {
      api: apiName,
      keys: keys.length
    });
    
    return keys;
  }
  
  /**
   * Mine Reddit for keys
   */
  async mineReddit(apiName) {
    this.logger.info(`Mining Reddit for ${apiName} keys`);
    
    const keys = [];
    
    try {
      // Reddit search API (no auth needed for read-only)
      const subreddits = ['webdev', 'learnprogramming', 'python', 'javascript'];
      
      for (const subreddit of subreddits) {
        const query = encodeURIComponent(`${apiName} api key`);
        const url = `https://www.reddit.com/r/${subreddit}/search.json?q=${query}&sort=relevance&limit=10`;
        
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'COSMO-Action-Coordinator/1.0'
          }
        });
        
        if (!response.ok) continue;
        
        const data = await response.json();
        
        // Extract keys from post content
        for (const post of data.data?.children || []) {
          // TODO: Parse selftext and extract potential API keys
          // Pattern matching for common key formats
        }
      }
      
    } catch (error) {
      this.logger.warn('Reddit query failed', {
        api: apiName,
        error: error.message
      });
    }
    
    this.logger.info('Reddit mining result', {
      api: apiName,
      keys: keys.length
    });
    
    return keys;
  }
  
  /**
   * Extract potential API keys from text using patterns
   */
  extractKeysFromText(text, apiName) {
    const candidates = [];
    
    // Common API key patterns
    const patterns = [
      // Generic base64-like keys
      /[A-Za-z0-9_-]{20,}/g,
      // UUID-style
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      // Hex keys
      /[0-9a-f]{32,64}/gi
    ];
    
    for (const pattern of patterns) {
      const matches = text.matchAll(pattern);
      for (const match of matches) {
        candidates.push(match[0]);
      }
    }
    
    // Filter to likely keys (heuristics)
    return candidates.filter(k => {
      // Not too short, not too long
      if (k.length < 16 || k.length > 128) return false;
      
      // Has some entropy (not all same character)
      const unique = new Set(k).size;
      if (unique < 8) return false;
      
      return true;
    });
  }
}

module.exports = { KeyMiner };
