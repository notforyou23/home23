const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

/**
 * ValidationManager
 * 
 * Tracks code validation results across runs to avoid redundant testing.
 * Maintains a persistent registry of validated files with content hashes.
 * 
 * Design principles:
 * - Fail gracefully if registry missing/corrupted
 * - Cache results in memory for performance
 * - Verify files haven't changed using content hash
 * - Support staleness checking (validation expires after configurable time)
 */
class ValidationManager {
  constructor(runtimeDir, logger) {
    this.runtimeDir = runtimeDir;
    this.logger = logger;
    this.registryPath = path.join(runtimeDir, 'validation-registry.json');
    this.registry = null; // Lazy loaded
    this.maxAgeMs = 7 * 24 * 60 * 60 * 1000; // 7 days default
  }

  /**
   * Load validation registry (lazy, cached in memory)
   * @returns {Object} Registry object
   */
  async loadRegistry() {
    if (this.registry) {
      return this.registry;
    }
    
    try {
      const content = await fs.readFile(this.registryPath, 'utf-8');
      this.registry = JSON.parse(content);
      
      this.logger?.info?.('Validation registry loaded', {
        files: Object.keys(this.registry.files || {}).length,
        created: this.registry.created
      });
    } catch (error) {
      // File doesn't exist or parse error - start fresh
      this.logger?.info?.('Validation registry not found, creating new', {
        path: this.registryPath
      });
      
      this.registry = {
        version: '1.0',
        created: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        files: {} // path -> validation metadata
      };
    }
    
    return this.registry;
  }

  /**
   * Save registry to disk
   * @returns {Promise<void>}
   */
  async saveRegistry() {
    if (!this.registry) {
      return; // Nothing to save
    }
    
    try {
      this.registry.lastUpdated = new Date().toISOString();
      
      await fs.writeFile(
        this.registryPath,
        JSON.stringify(this.registry, null, 2),
        'utf-8'
      );
      
      this.logger?.debug?.('Validation registry saved', {
        files: Object.keys(this.registry.files).length
      });
    } catch (error) {
      this.logger?.error?.('Failed to save validation registry', {
        error: error.message,
        path: this.registryPath
      });
    }
  }

  /**
   * Check if file has been validated and is still valid
   * @param {string} filePath - Relative path (e.g., "outputs/code-creation/agent_xxx/file.py")
   * @param {number} maxAgeMs - Consider validation stale after this time (optional)
   * @returns {Promise<Object|null>} - Validation record or null if not validated/stale
   */
  async checkValidation(filePath, maxAgeMs = null) {
    const ageLimit = maxAgeMs || this.maxAgeMs;
    
    try {
      const registry = await this.loadRegistry();
      const record = registry.files[filePath];
      
      if (!record) {
        return null; // Not validated
      }
      
      // Check if validation is stale
      const age = Date.now() - new Date(record.lastValidation).getTime();
      if (age > ageLimit) {
        this.logger?.debug?.('Validation record stale', {
          filePath,
          ageMs: age,
          limitMs: ageLimit
        });
        return null;
      }
      
      // Verify file still exists and hasn't changed
      const fullPath = path.join(this.runtimeDir, '..', filePath);
      
      try {
        const content = await fs.readFile(fullPath, 'utf-8');
        const currentHash = crypto.createHash('sha256').update(content).digest('hex');
        
        if (currentHash !== record.hash) {
          this.logger?.debug?.('File changed since validation', {
            filePath,
            oldHash: record.hash.substring(0, 8),
            newHash: currentHash.substring(0, 8)
          });
          return null; // File changed - needs revalidation
        }
        
        // Valid and current
        return record;
      } catch (fileError) {
        // File doesn't exist anymore or can't be read
        this.logger?.debug?.('File no longer accessible', {
          filePath,
          error: fileError.message
        });
        return null;
      }
    } catch (error) {
      // Registry load failed or other error - fail gracefully
      this.logger?.warn?.('Validation check failed, treating as not validated', {
        filePath,
        error: error.message
      });
      return null;
    }
  }

  /**
   * Record validation result
   * @param {string} filePath - Relative path
   * @param {Object} result - {testPassed, results, agentId, hadError}
   * @param {string} fileContent - Actual file content (for hashing)
   * @returns {Promise<void>}
   */
  async recordValidation(filePath, result, fileContent) {
    try {
      const registry = await this.loadRegistry();
      
      const hash = crypto.createHash('sha256').update(fileContent).digest('hex');
      
      registry.files[filePath] = {
        hash,
        validated: true,
        lastValidation: new Date().toISOString(),
        testPassed: result.testPassed || false,
        validatedBy: result.agentId || 'unknown',
        resultsSummary: result.results?.substring(0, 200) || 'No output',
        hadError: result.hadError || false,
        fileSize: fileContent.length
      };
      
      await this.saveRegistry();
      
      this.logger?.info?.('Validation recorded', {
        filePath,
        passed: result.testPassed,
        hash: hash.substring(0, 8),
        registrySize: Object.keys(registry.files).length
      });
    } catch (error) {
      // Non-fatal - log and continue
      this.logger?.warn?.('Failed to record validation', {
        filePath,
        error: error.message
      });
    }
  }

  /**
   * Filter files to only those needing validation
   * @param {Array} files - Array of {filename, relativePath, size, ...}
   * @param {number} maxAgeMs - Optional max age for validation records
   * @returns {Promise<Object>} - {needsValidation: [], alreadyValidated: []}
   */
  async filterNeedsValidation(files, maxAgeMs = null) {
    const needsValidation = [];
    const alreadyValidated = [];
    
    for (const file of files) {
      try {
        const record = await this.checkValidation(file.relativePath, maxAgeMs);
        
        if (record) {
          alreadyValidated.push({
            ...file,
            validationRecord: record
          });
        } else {
          needsValidation.push(file);
        }
      } catch (error) {
        // If check fails, err on side of caution and include for validation
        this.logger?.debug?.('Validation check error, including for validation', {
          filename: file.filename,
          error: error.message
        });
        needsValidation.push(file);
      }
    }
    
    this.logger?.info?.('Validation filter results', {
      total: files.length,
      needsValidation: needsValidation.length,
      alreadyValidated: alreadyValidated.length,
      cacheHitRate: files.length > 0 
        ? `${Math.round((alreadyValidated.length / files.length) * 100)}%`
        : '0%'
    });
    
    return { needsValidation, alreadyValidated };
  }

  /**
   * Get validation statistics
   * @returns {Promise<Object>} - Stats about validation registry
   */
  async getStats() {
    try {
      const registry = await this.loadRegistry();
      const files = Object.values(registry.files);
      
      const timestamps = files
        .map(f => new Date(f.lastValidation).getTime())
        .filter(t => !isNaN(t));
      
      return {
        totalValidated: files.length,
        passed: files.filter(f => f.testPassed).length,
        failed: files.filter(f => !f.testPassed).length,
        oldestValidation: timestamps.length > 0
          ? new Date(Math.min(...timestamps)).toISOString()
          : null,
        newestValidation: timestamps.length > 0
          ? new Date(Math.max(...timestamps)).toISOString()
          : null,
        registryCreated: registry.created,
        registryUpdated: registry.lastUpdated
      };
    } catch (error) {
      return {
        totalValidated: 0,
        passed: 0,
        failed: 0,
        error: error.message
      };
    }
  }

  /**
   * Clear stale validation records
   * @param {number} maxAgeMs - Remove records older than this
   * @returns {Promise<number>} - Number of records removed
   */
  async clearStale(maxAgeMs = null) {
    const ageLimit = maxAgeMs || this.maxAgeMs;
    
    try {
      const registry = await this.loadRegistry();
      const before = Object.keys(registry.files).length;
      
      const now = Date.now();
      
      for (const [filePath, record] of Object.entries(registry.files)) {
        const age = now - new Date(record.lastValidation).getTime();
        if (age > ageLimit) {
          delete registry.files[filePath];
        }
      }
      
      const after = Object.keys(registry.files).length;
      const removed = before - after;
      
      if (removed > 0) {
        await this.saveRegistry();
        
        this.logger?.info?.('Cleared stale validation records', {
          removed,
          remaining: after
        });
      }
      
      return removed;
    } catch (error) {
      this.logger?.error?.('Failed to clear stale records', {
        error: error.message
      });
      return 0;
    }
  }
}

module.exports = { ValidationManager };

