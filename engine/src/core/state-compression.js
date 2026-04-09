const zlib = require('zlib');
const fs = require('fs').promises;
const { promisify } = require('util');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

/**
 * State Compression Utilities
 * 
 * Handles compression/decompression of large state files
 * to reduce disk usage without changing data structure.
 * 
 * Backward compatible: can read both compressed and uncompressed files.
 */
class StateCompression {
  
  /**
   * Compress and save state to file
   * 
   * @param {string} filepath - Target file path
   * @param {Object} state - State object to save
   * @param {Object} options - Compression options
   * @returns {Promise<{size: number, compressed: boolean}>}
   */
  static async saveCompressed(filepath, state, options = {}) {
    const {
      compress = true,
      pretty = false,
      level = zlib.constants.Z_BEST_COMPRESSION
    } = options;
    
    // Serialize state to JSON
    const jsonString = pretty 
      ? JSON.stringify(state, null, 2)
      : JSON.stringify(state);
    
    if (!compress) {
      // Save uncompressed (backward compatibility)
      await fs.writeFile(filepath, jsonString, 'utf8');
      return {
        size: Buffer.byteLength(jsonString, 'utf8'),
        compressed: false
      };
    }
    
    // Compress with gzip
    const compressed = await gzip(jsonString, { level });
    
    // Atomic write: write to temp file, then rename (prevents corruption on crash/timeout)
    const targetPath = filepath + '.gz';
    const tempPath = targetPath + '.tmp';
    await fs.writeFile(tempPath, compressed);
    await fs.rename(tempPath, targetPath);
    
    return {
      size: compressed.length,
      compressed: true,
      originalSize: Buffer.byteLength(jsonString, 'utf8'),
      ratio: (compressed.length / Buffer.byteLength(jsonString, 'utf8')).toFixed(2)
    };
  }
  
  /**
   * Load state from file (handles both compressed and uncompressed)
   * 
   * @param {string} filepath - File path (without .gz extension)
   * @returns {Promise<Object>} - Parsed state object
   */
  static async loadCompressed(filepath) {
    // Try compressed file first
    const compressedPath = filepath + '.gz';

    try {
      const compressed = await fs.readFile(compressedPath);
      try {
        // Standard gunzip (works for clean files)
        const decompressed = await gunzip(compressed);
        return JSON.parse(decompressed.toString('utf8'));
      } catch (gzipError) {
        // Handle trailing garbage: extract first valid gzip stream
        // This occurs when the engine appends data or crashes mid-write
        const decompressed = zlib.inflateSync(compressed.slice(10), { finishFlush: zlib.constants.Z_SYNC_FLUSH });
        return JSON.parse(decompressed.toString('utf8'));
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        // Compressed file doesn't exist — try uncompressed
      } else {
        // Compressed file exists but is corrupt — still try uncompressed
      }

      // Fall back to uncompressed file
      try {
        const data = await fs.readFile(filepath, 'utf8');
        return JSON.parse(data);
      } catch (fallbackError) {
        if (fallbackError.code === 'ENOENT') {
          // Neither file exists — fresh brain, return empty state
          return {
            cycleCount: 0,
            journal: [],
            lastSummarization: 0,
            memory: { nodes: [], edges: [], clusters: [] },
          };
        }
        throw new Error(`Failed to load state from ${filepath} or ${compressedPath}: ${fallbackError.message}`);
      }
    }
  }
  
  /**
   * Rotate old backup files, keeping only the most recent N
   * 
   * @param {string} logsDir - Logs directory path
   * @param {string} pattern - Filename pattern (e.g., 'state.backup')
   * @param {number} keepCount - Number of recent backups to keep
   * @returns {Promise<{removed: number, kept: number}>}
   */
  static async rotateBackups(logsDir, pattern = 'state.backup', keepCount = 5) {
    try {
      const files = await fs.readdir(logsDir);
      
      // Find all backup files matching pattern
      const backups = files
        .filter(f => f.startsWith(pattern))
        .map(f => ({
          name: f,
          path: require('path').join(logsDir, f),
          timestamp: parseInt(f.split('.').find(part => /^\d{13}$/.test(part)) || '0')
        }))
        .filter(f => f.timestamp > 0)
        .sort((a, b) => b.timestamp - a.timestamp); // Newest first
      
      if (backups.length <= keepCount) {
        return { removed: 0, kept: backups.length };
      }
      
      // Remove old backups
      const toRemove = backups.slice(keepCount);
      let removed = 0;
      
      for (const backup of toRemove) {
        try {
          await fs.unlink(backup.path);
          // Also remove .gz version if exists
          try {
            await fs.unlink(backup.path + '.gz');
          } catch (e) {
            // Ignore if .gz doesn't exist
          }
          removed++;
        } catch (error) {
          // Continue even if one file fails to delete
        }
      }
      
      return {
        removed,
        kept: backups.length - removed
      };
    } catch (error) {
      // If rotation fails, don't crash - just log
      return { removed: 0, kept: 0, error: error.message };
    }
  }
  
  /**
   * Create a timestamped backup of current state
   * 
   * @param {string} filepath - Source file path
   * @param {string} logsDir - Logs directory
   * @returns {Promise<string>} - Backup file path
   */
  static async createBackup(filepath, logsDir) {
    const timestamp = Date.now();
    const backupPath = require('path').join(logsDir, `state.backup.${timestamp}.json`);
    
    try {
      // Try to copy compressed version first
      const compressedSource = filepath + '.gz';
      try {
        await fs.copyFile(compressedSource, backupPath + '.gz');
        return backupPath + '.gz';
      } catch (e) {
        // Fall back to uncompressed
        await fs.copyFile(filepath, backupPath);
        return backupPath;
      }
    } catch (error) {
      throw new Error(`Backup creation failed: ${error.message}`);
    }
  }
}

module.exports = { StateCompression };

