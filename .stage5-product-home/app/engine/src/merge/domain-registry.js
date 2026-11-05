/**
 * COSMO Merge V2 - Dynamic Domain Registry
 * 
 * Maps arbitrary domain strings to stable indices.
 * No hardcoded domain lists or limits.
 */

/**
 * @typedef {Object} DomainRegistryState
 * @property {string[]} domains - Ordered list of domain strings
 */

class DomainRegistry {
  /**
   * @param {string[]} existingDomains - Optional domains to pre-load (for incremental merge)
   */
  constructor(existingDomains = []) {
    /** @type {Map<string, number>} */
    this.domainToIndex = new Map();
    
    /** @type {string[]} */
    this.indexToDomain = [];
    
    // Load existing domains maintaining their indices
    for (const domain of existingDomains) {
      const normalized = this._normalize(domain);
      if (!this.domainToIndex.has(normalized)) {
        const index = this.indexToDomain.length;
        this.domainToIndex.set(normalized, index);
        this.indexToDomain.push(normalized);
      }
    }
  }
  
  /**
   * Normalize domain string (lowercase, trim)
   * @param {string} domain 
   * @returns {string}
   */
  _normalize(domain) {
    return (domain || 'unknown').toLowerCase().trim();
  }
  
  /**
   * Get or create domain index
   * Always returns a stable index - never null
   * 
   * @param {string} domain - Domain string (arbitrary)
   * @returns {number} - Stable index for this domain
   */
  getDomainIndex(domain) {
    const normalized = this._normalize(domain);
    
    if (this.domainToIndex.has(normalized)) {
      return this.domainToIndex.get(normalized);
    }
    
    // Register new domain
    const index = this.indexToDomain.length;
    this.domainToIndex.set(normalized, index);
    this.indexToDomain.push(normalized);
    
    return index;
  }
  
  /**
   * Get domain string by index
   * 
   * @param {number} index 
   * @returns {string|null}
   */
  getDomainByIndex(index) {
    return this.indexToDomain[index] || null;
  }
  
  /**
   * Get current number of registered domains
   * @returns {number}
   */
  get dimensions() {
    return this.indexToDomain.length;
  }
  
  /**
   * Get all registered domains in index order
   * @returns {string[]}
   */
  getDomains() {
    return [...this.indexToDomain];
  }
  
  /**
   * Check if a domain is registered
   * @param {string} domain 
   * @returns {boolean}
   */
  hasDomain(domain) {
    return this.domainToIndex.has(this._normalize(domain));
  }
  
  /**
   * Get serializable state for persistence
   * @returns {DomainRegistryState}
   */
  toJSON() {
    return {
      domains: this.indexToDomain
    };
  }
  
  /**
   * Create registry from persisted state
   * @param {DomainRegistryState} state 
   * @returns {DomainRegistry}
   */
  static fromJSON(state) {
    return new DomainRegistry(state?.domains || []);
  }
}

/**
 * Detect domain from run metadata
 * 
 * @param {object} loaded - Loaded run state with metadata
 * @returns {string} - Domain string (defaults to "unknown")
 */
function detectDomain(loaded) {
  // Primary: Read metadata.domain directly
  const metaDomain = loaded.metadata?.domain || loaded.state?.metadata?.domain;
  if (metaDomain) {
    return metaDomain;
  }
  
  // Fallback: keyword-based inference from run name (restored for compatibility)
  const name = (loaded.name || loaded.runName || '').toLowerCase();
  const domainKeywords = {
    'math': 'mathematics',
    'physics': 'physics',
    'chem': 'chemistry',
    'bio': 'biology',
    'cs': 'computer_science',
    'eng': 'engineering',
    'psych': 'psychology',
    'phil': 'philosophy',
    'soc': 'sociology',
    'art': 'art_music',
    'music': 'art_music',
    'econ': 'economics',
    'bus': 'business',
    'med': 'medicine',
    'hist': 'history',
    'leg': 'legal'
  };
  
  for (const [keyword, domain] of Object.entries(domainKeywords)) {
    if (name.includes(keyword)) {
      return domain;
    }
  }
  
  return 'unknown';
}

module.exports = {
  DomainRegistry,
  detectDomain
};

