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
   * Execute enhanced query - with memory-guided file loading and action support
   * This is the more powerful query method that:
   * - Uses semantic search to find relevant output files
   * - Loads full file contents for context
   * - Can detect and execute actions (file creation, etc.)
   */
  async executeEnhancedQuery(query, options = {}) {
    return await this.queryEngine.executeEnhancedQuery(query, options);
  }

  /**
   * Get query suggestions
   */
  async getQuerySuggestions() {
    return await this.queryEngine.getQuerySuggestions();
  }

  async exportResult(query, answer, format, metadata = {}) {
    return await this.queryEngine.exportResult(query, answer, format, metadata);
  }
}

module.exports = { BrainQueryEngine };

