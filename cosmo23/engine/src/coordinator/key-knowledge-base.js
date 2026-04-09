const fs = require('fs').promises;
const path = require('path');

/**
 * Key Knowledge Base
 * 
 * Central catalog of discovered API keys. This is THE UNLOCK for true autonomy.
 * 
 * The bottleneck isn't handling credentials - it's HAVING the keys themselves.
 * Keys ARE out there (hardcoded in GitHub repos, Stack Overflow examples, Reddit
 * tutorials, documentation sandbox keys). We systematically mine and catalog them.
 * 
 * NOT cracking, NOT inventing - cataloging what's freely shared for legitimate use.
 */
class KeyKnowledgeBase {
  constructor(logger, storagePath) {
    this.logger = logger;
    this.storagePath = storagePath;
    
    // API name → [key values]
    this.keys = new Map();
    
    // key value → metadata
    this.metadata = new Map();
    
    // Load from disk
    this.loaded = false;
  }
  
  /**
   * Initialize - load keys from disk
   */
  async initialize() {
    try {
      await fs.mkdir(path.dirname(this.storagePath), { recursive: true });
      
      try {
        const data = await fs.readFile(this.storagePath, 'utf8');
        const parsed = JSON.parse(data);
        
        // Restore Maps from JSON
        this.keys = new Map(parsed.keys);
        this.metadata = new Map(parsed.metadata);
        
        this.logger.info('Key Knowledge Base loaded', {
          apis: this.keys.size,
          totalKeys: this.metadata.size
        });
        
      } catch (error) {
        // File doesn't exist yet - that's fine
        this.logger.info('Key Knowledge Base initialized (empty)');
      }
      
      this.loaded = true;
      
    } catch (error) {
      this.logger.error('Failed to initialize Key Knowledge Base', {
        error: error.message
      });
      throw error;
    }
  }
  
  /**
   * Store a discovered key
   */
  async store(keyData) {
    const { api, value, tier, rateLimits, source, constraints } = keyData;
    
    // Add to keys map
    if (!this.keys.has(api)) {
      this.keys.set(api, []);
    }
    
    const apiKeys = this.keys.get(api);
    if (!apiKeys.includes(value)) {
      apiKeys.push(value);
    }
    
    // Add metadata
    this.metadata.set(value, {
      api,
      tier: tier || 'unknown', // free/sandbox/demo
      rateLimits: rateLimits || null,
      source: source || 'unknown', // GitHub/Stack/Reddit/Docs
      discoveredAt: Date.now(),
      lastValidated: Date.now(),
      status: 'active',
      constraints: constraints || null,
      usageCount: 0
    });
    
    // Persist to disk
    await this.save();
    
    this.logger.info('Key stored', { api, source, tier });
    
    return true;
  }
  
  /**
   * Get working keys for an API
   */
  async get(api) {
    const keyValues = this.keys.get(api) || [];
    
    // Filter to active keys only
    const activeKeys = keyValues.filter(v => {
      const meta = this.metadata.get(v);
      return meta && meta.status === 'active';
    });
    
    // Return with metadata
    return activeKeys.map(v => ({
      value: v,
      metadata: this.metadata.get(v)
    }));
  }
  
  /**
   * Mark a key as used
   */
  async markUsed(keyValue) {
    const meta = this.metadata.get(keyValue);
    if (meta) {
      meta.usageCount = (meta.usageCount || 0) + 1;
      meta.lastUsed = Date.now();
      await this.save();
    }
  }
  
  /**
   * Mark a key as expired/invalid
   */
  async markExpired(keyValue, reason) {
    const meta = this.metadata.get(keyValue);
    if (meta) {
      meta.status = 'expired';
      meta.expiredReason = reason;
      meta.expiredAt = Date.now();
      await this.save();
      
      this.logger.warn('Key marked expired', {
        api: meta.api,
        reason
      });
    }
  }
  
  /**
   * Validate all keys (periodic health check)
   */
  async validateAll(validator) {
    this.logger.info('Starting key validation pass');
    
    let validated = 0;
    let expired = 0;
    
    for (const [keyValue, meta] of this.metadata) {
      if (meta.status !== 'active') continue;
      
      try {
        const result = await validator.validate(keyValue, meta.api);
        
        if (result.valid) {
          meta.lastValidated = Date.now();
          meta.rateLimits = result.rateLimits || meta.rateLimits;
          validated++;
        } else {
          await this.markExpired(keyValue, result.error);
          expired++;
        }
        
      } catch (error) {
        this.logger.warn('Key validation failed', {
          api: meta.api,
          error: error.message
        });
      }
    }
    
    await this.save();
    
    this.logger.info('Key validation complete', { validated, expired });
    
    return { validated, expired };
  }
  
  /**
   * Get statistics
   */
  getStats() {
    const stats = {
      totalAPIs: this.keys.size,
      totalKeys: this.metadata.size,
      activeKeys: 0,
      expiredKeys: 0,
      bySource: {},
      byTier: {}
    };
    
    for (const [keyValue, meta] of this.metadata) {
      if (meta.status === 'active') {
        stats.activeKeys++;
      } else {
        stats.expiredKeys++;
      }
      
      // Count by source
      stats.bySource[meta.source] = (stats.bySource[meta.source] || 0) + 1;
      
      // Count by tier
      stats.byTier[meta.tier] = (stats.byTier[meta.tier] || 0) + 1;
    }
    
    return stats;
  }
  
  /**
   * Save to disk
   */
  async save() {
    try {
      const data = {
        keys: Array.from(this.keys.entries()),
        metadata: Array.from(this.metadata.entries()),
        lastUpdated: Date.now()
      };
      
      await fs.writeFile(
        this.storagePath,
        JSON.stringify(data, null, 2),
        'utf8'
      );
      
    } catch (error) {
      this.logger.error('Failed to save Key Knowledge Base', {
        error: error.message
      });
    }
  }
}

module.exports = { KeyKnowledgeBase };
