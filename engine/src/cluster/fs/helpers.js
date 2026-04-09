/**
 * Filesystem Atomic Helpers
 *
 * Atomic file operations using temp+rename+fsync(parent) pattern.
 * Ensures durability and atomicity on POSIX filesystems (including NFS).
 *
 * Phase B-FS: Filesystem State Store
 */

const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

class FilesystemHelpers {
  constructor(logger) {
    this.logger = logger;
  }

  /**
   * Atomic write using temp+rename+fsync pattern
   * 
   * @param {string} targetPath - final file path
   * @param {string|Buffer} content - content to write
   * @param {object} options - { encoding: 'utf8', mode: 0o644 }
   */
  async atomicWrite(targetPath, content, options = {}) {
    const encoding = options.encoding || 'utf8';
    const mode = options.mode || 0o644;
    
    try {
      const dir = path.dirname(targetPath);
      const basename = path.basename(targetPath);
      const tempPath = path.join(dir, `.${basename}.tmp.${Date.now()}.${process.pid}`);

      // Ensure directory exists
      await fsPromises.mkdir(dir, { recursive: true });

      // Write to temp file
      await fsPromises.writeFile(tempPath, content, { encoding, mode });

      // Fsync temp file
      const fd = await fsPromises.open(tempPath, 'r+');
      await fd.sync();
      await fd.close();

      // Atomic rename
      await fsPromises.rename(tempPath, targetPath);

      // Fsync parent directory (critical for durability)
      await this.fsyncDirectory(dir);

      return true;
    } catch (error) {
      this.logger?.error('[FSHelpers] atomicWrite failed', {
        targetPath,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Fsync a directory (ensures rename is durable)
   * 
   * @param {string} dirPath - directory path
   */
  async fsyncDirectory(dirPath) {
    try {
      const fd = await fsPromises.open(dirPath, fs.constants.O_RDONLY);
      await fd.sync();
      await fd.close();
    } catch (error) {
      // Some filesystems don't support directory fsync
      // Log but don't fail
      this.logger?.debug('[FSHelpers] Directory fsync failed (may not be supported)', {
        dirPath,
        error: error.message
      });
    }
  }

  /**
   * Atomic read (with error handling)
   * 
   * @param {string} filePath - file to read
   * @param {object} options - { encoding: 'utf8', defaultValue: null }
   * @returns {string|Buffer|null} - file content or defaultValue
   */
  async atomicRead(filePath, options = {}) {
    const encoding = options.encoding || 'utf8';
    const defaultValue = options.defaultValue !== undefined ? options.defaultValue : null;

    try {
      return await fsPromises.readFile(filePath, encoding);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return defaultValue;
      }
      this.logger?.error('[FSHelpers] atomicRead failed', {
        filePath,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Atomic JSON write
   * 
   * @param {string} targetPath - file path
   * @param {object} data - object to serialize
   */
  async atomicWriteJSON(targetPath, data) {
    const json = JSON.stringify(data, null, 2);
    return this.atomicWrite(targetPath, json, { encoding: 'utf8' });
  }

  /**
   * Atomic JSON read
   * 
   * @param {string} filePath - file path
   * @param {object} defaultValue - default if file doesn't exist
   * @returns {object} - parsed JSON or defaultValue
   */
  async atomicReadJSON(filePath, defaultValue = null) {
    const content = await this.atomicRead(filePath, { encoding: 'utf8', defaultValue: null });
    
    if (content === null) {
      return defaultValue;
    }

    try {
      return JSON.parse(content);
    } catch (error) {
      this.logger?.error('[FSHelpers] JSON parse failed', {
        filePath,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Try to acquire exclusive lock (O_CREAT | O_EXCL)
   * Returns true if lock acquired, false if already locked
   * 
   * @param {string} lockPath - lock file path
   * @param {object} lockData - data to write to lock file
   * @returns {boolean} - true if acquired
   */
  async tryAcquireLock(lockPath, lockData) {
    try {
      const dir = path.dirname(lockPath);
      await fsPromises.mkdir(dir, { recursive: true });

      // Try O_CREAT | O_EXCL (atomic create-if-not-exists)
      const fd = await fsPromises.open(
        lockPath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        0o644
      );

      // Write lock data
      const content = JSON.stringify(lockData, null, 2);
      await fsPromises.writeFile(fd, content, 'utf8');
      await fd.sync();
      await fd.close();

      // Fsync parent directory
      await this.fsyncDirectory(dir);

      return true;
    } catch (error) {
      if (error.code === 'EEXIST') {
        return false; // Lock already exists
      }
      this.logger?.error('[FSHelpers] tryAcquireLock failed', {
        lockPath,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Release lock (delete lock file)
   * 
   * @param {string} lockPath - lock file path
   */
  async releaseLock(lockPath) {
    try {
      await fsPromises.unlink(lockPath);
      await this.fsyncDirectory(path.dirname(lockPath));
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return true; // Already released
      }
      this.logger?.error('[FSHelpers] releaseLock failed', {
        lockPath,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Read lock data
   * 
   * @param {string} lockPath - lock file path
   * @returns {object|null} - lock data or null if doesn't exist
   */
  async readLock(lockPath) {
    return this.atomicReadJSON(lockPath, null);
  }

  /**
   * Atomic append to log file (O_APPEND | O_SYNC)
   * 
   * @param {string} logPath - log file path
   * @param {string} line - line to append (will add newline)
   */
  async appendToLog(logPath, line) {
    try {
      const dir = path.dirname(logPath);
      await fsPromises.mkdir(dir, { recursive: true });

      // Append with O_APPEND flag for atomicity
      const content = line + '\n';
      await fsPromises.appendFile(logPath, content, { encoding: 'utf8', flag: 'a' });

      // Fsync the log file
      const fd = await fsPromises.open(logPath, 'r+');
      await fd.sync();
      await fd.close();

      return true;
    } catch (error) {
      this.logger?.error('[FSHelpers] appendToLog failed', {
        logPath,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Ensure a directory exists (replace conflicting files)
   *
   * @param {string} dirPath - directory path to ensure
   */
  async ensureDirectory(dirPath) {
    try {
      const stats = await fsPromises.stat(dirPath);
      if (stats.isDirectory()) {
        return true;
      }

      // Path exists but is not a directory; clean it up before recreating
      await fsPromises.rm(dirPath, { force: true, recursive: true });
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger?.error('[FSHelpers] ensureDirectory stat failed', {
          dirPath,
          error: error.message
        });
        throw error;
      }
    }

    await fsPromises.mkdir(dirPath, { recursive: true });
    return true;
  }

  /**
   * List directory contents (with filtering)
   * 
   * @param {string} dirPath - directory path
   * @param {function} filter - optional filter function
   * @returns {array} - file names
   */
  async listDirectory(dirPath, filter = null) {
    try {
      await this.ensureDirectory(dirPath);
      const files = await fsPromises.readdir(dirPath);
      
      if (filter) {
        return files.filter(filter);
      }
      return files;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return [];
      }
      this.logger?.error('[FSHelpers] listDirectory failed', {
        dirPath,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Check if file exists
   * 
   * @param {string} filePath - file path
   * @returns {boolean} - true if exists
   */
  async fileExists(filePath) {
    try {
      await fsPromises.access(filePath, fs.constants.F_OK);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Calculate file hash (for integrity checking)
   * 
   * @param {string} filePath - file path
   * @returns {string} - SHA256 hash
   */
  async calculateFileHash(filePath) {
    try {
      const content = await fsPromises.readFile(filePath);
      return crypto.createHash('sha256').update(content).digest('hex');
    } catch (error) {
      this.logger?.error('[FSHelpers] calculateFileHash failed', {
        filePath,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Atomic counter increment (read-modify-write with lock)
   * 
   * @param {string} counterPath - counter file path
   * @param {number} increment - amount to increment (default 1)
   * @returns {number} - new value after increment
   */
  async atomicIncrement(counterPath, increment = 1) {
    const lockPath = `${counterPath}.lock`;
    
    try {
      // Acquire lock
      const maxRetries = 10;
      let acquired = false;
      for (let i = 0; i < maxRetries; i++) {
        acquired = await this.tryAcquireLock(lockPath, { pid: process.pid });
        if (acquired) break;
        await new Promise(resolve => setTimeout(resolve, 10)); // Wait 10ms
      }
      
      if (!acquired) {
        throw new Error('Failed to acquire counter lock');
      }

      // Read current value
      const current = await this.atomicRead(counterPath, { encoding: 'utf8', defaultValue: '0' });
      const currentValue = parseInt(current) || 0;

      // Increment
      const newValue = currentValue + increment;

      // Write new value
      await this.atomicWrite(counterPath, newValue.toString(), { encoding: 'utf8' });

      // Release lock
      await this.releaseLock(lockPath);

      return newValue;
    } catch (error) {
      // Ensure lock is released
      await this.releaseLock(lockPath).catch(() => {});
      throw error;
    }
  }
}

module.exports = { FilesystemHelpers };
