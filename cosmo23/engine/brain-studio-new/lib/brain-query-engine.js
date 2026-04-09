/**
 * Brain Query Engine
 * Standalone wrapper around COSMO's QueryEngine for .brain packages
 * 
 * This adapts QueryEngine to work with exported brains instead of runtime directories.
 */

const { QueryEngine } = require('./query-engine');

class BrainQueryEngine {
  constructor(brainPath, openaiKey) {
    // QueryEngine expects a runtime directory
    // For .brain packages, brainPath IS the directory
    this.queryEngine = new QueryEngine(brainPath, openaiKey);
    this.brainPath = brainPath;
  }

  /**
   * Execute query - delegates to COSMO QueryEngine
   * All options pass through unchanged
   */
  async executeQuery(query, options = {}) {
    return await this.queryEngine.executeQuery(query, options);
  }

  /**
   * Get query suggestions
   */
  async getQuerySuggestions() {
    return await this.queryEngine.getQuerySuggestions();
  }
}

module.exports = { BrainQueryEngine };

