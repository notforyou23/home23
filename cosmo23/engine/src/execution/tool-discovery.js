/**
 * Tool Discovery — Active runtime discovery of tools and packages
 *
 * When an execution agent needs a capability it doesn't have (e.g., needs playwright
 * but it's not installed), ToolDiscovery finds and installs it. Searches npm, pip,
 * and GitHub registries, then installs packages to scoped directories (never globally).
 *
 * Part of the Execution Architecture (Plugin -> Skill -> Tool -> Discovery).
 *
 * Key design:
 *   - All search methods are graceful on failure (network issues -> empty arrays, never throw)
 *   - All install methods are scoped (never global, always to a specific directory)
 *   - Timeouts on all execSync calls (10s for searches, 60s for installs)
 *   - In-memory cache with optional disk persistence
 */

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Timeouts
const SEARCH_TIMEOUT_MS = 10000;
const INSTALL_TIMEOUT_MS = 60000;

class ToolDiscovery {
  /**
   * @param {Object} config - Engine config
   * @param {string} [config.cachePath] - Override default cache path
   * @param {string} [config.npmBin] - Override npm binary (default: 'npm')
   * @param {string} [config.pipBin] - Override pip binary (default: 'pip3')
   * @param {string} [config.ghBin] - Override gh binary (default: 'gh')
   * @param {Object} logger - Logger with info/warn/error/debug methods
   */
  constructor(config = {}, logger = console) {
    this.config = config;
    this.logger = logger;

    /** @type {Map<string, {result: any, timestamp: string}>} */
    this.cache = new Map();

    this.cachePath = config.cachePath || path.join(os.homedir(), '.cosmo2.3', 'tool-discovery-cache.json');
    this.npmBin = config.npmBin || 'npm';
    this.pipBin = config.pipBin || 'pip3';
    this.ghBin = config.ghBin || 'gh';

    // Track installation history for audit
    /** @type {Array<{source: string, package: string, targetDir: string, timestamp: string, success: boolean}>} */
    this.installHistory = [];
  }

  // ── Search Methods ──────────────────────────────────────────────────────

  /**
   * Search npm registry for packages matching a query.
   *
   * Runs `npm search --json <query>` via child_process.execSync.
   * Parses JSON output and returns normalized results.
   *
   * @param {string} query - Search terms (e.g., 'playwright', 'csv parser')
   * @param {Object} [options]
   * @param {number} [options.limit=10] - Max results to return
   * @returns {Array<{name: string, version: string, description: string}>}
   */
  searchNpm(query, options = {}) {
    if (!query || typeof query !== 'string') return [];
    const limit = options.limit || 10;

    // Check cache first
    const cached = this.getCachedResult('npm', query);
    if (cached) {
      this.logger.debug?.(`[ToolDiscovery] npm cache hit for "${query}"`);
      return cached;
    }

    try {
      const sanitized = this._sanitizeShellArg(query);
      const cmd = `${this.npmBin} search --json ${sanitized} 2>/dev/null`;
      const stdout = execSync(cmd, {
        timeout: SEARCH_TIMEOUT_MS,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      });

      const raw = JSON.parse(stdout);
      if (!Array.isArray(raw)) return [];

      const results = raw.slice(0, limit).map(pkg => ({
        name: pkg.name || '',
        version: pkg.version || '',
        description: pkg.description || ''
      }));

      this.cacheResult('npm', query, results);
      this.logger.debug?.(`[ToolDiscovery] npm search "${query}": ${results.length} results`);
      return results;
    } catch (err) {
      this.logger.debug?.(`[ToolDiscovery] npm search failed for "${query}": ${err.message}`);
      return [];
    }
  }

  /**
   * Search pip for a package.
   *
   * Uses `pip index versions <query>` to check if a package exists and get version info.
   * Falls back to `pip show <query>` if index command is not available.
   *
   * @param {string} query - Package name to search for
   * @param {Object} [options]
   * @param {number} [options.limit=10] - Max results to return
   * @returns {Array<{name: string, version: string, description: string}>}
   */
  searchPip(query, options = {}) {
    if (!query || typeof query !== 'string') return [];

    // Check cache first
    const cached = this.getCachedResult('pip', query);
    if (cached) {
      this.logger.debug?.(`[ToolDiscovery] pip cache hit for "${query}"`);
      return cached;
    }

    const results = [];
    const sanitized = this._sanitizeShellArg(query);

    // Strategy 1: pip index versions (newer pip versions)
    try {
      const cmd = `${this.pipBin} index versions ${sanitized} 2>/dev/null`;
      const stdout = execSync(cmd, {
        timeout: SEARCH_TIMEOUT_MS,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      });

      // Parse output like: "package-name (1.2.3)"
      // Available versions: 1.2.3, 1.2.2, 1.2.1
      const nameMatch = stdout.match(/^(\S+)\s+\(([^)]+)\)/m);
      if (nameMatch) {
        results.push({
          name: nameMatch[1],
          version: nameMatch[2],
          description: `pip package: ${nameMatch[1]}`
        });
      }
    } catch (_err) {
      // pip index may not be available, try fallback
    }

    // Strategy 2: pip show (for already-installed packages)
    if (results.length === 0) {
      try {
        const cmd = `${this.pipBin} show ${sanitized} 2>/dev/null`;
        const stdout = execSync(cmd, {
          timeout: SEARCH_TIMEOUT_MS,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe']
        });

        const name = this._parsePipShowField(stdout, 'Name');
        const version = this._parsePipShowField(stdout, 'Version');
        const summary = this._parsePipShowField(stdout, 'Summary');

        if (name) {
          results.push({
            name,
            version: version || '',
            description: summary || `pip package: ${name}`
          });
        }
      } catch (_err) {
        // Package not found or pip not available
      }
    }

    // Strategy 3: pip search via PyPI JSON API with curl (pip search is deprecated)
    if (results.length === 0) {
      try {
        const cmd = `curl -s --max-time 8 "https://pypi.org/pypi/${sanitized}/json" 2>/dev/null`;
        const stdout = execSync(cmd, {
          timeout: SEARCH_TIMEOUT_MS,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe']
        });

        const data = JSON.parse(stdout);
        if (data && data.info) {
          results.push({
            name: data.info.name || query,
            version: data.info.version || '',
            description: data.info.summary || `pip package: ${query}`
          });
        }
      } catch (_err) {
        // No network or package doesn't exist
      }
    }

    if (results.length > 0) {
      this.cacheResult('pip', query, results);
      this.logger.debug?.(`[ToolDiscovery] pip search "${query}": ${results.length} results`);
    } else {
      this.logger.debug?.(`[ToolDiscovery] pip search "${query}": no results`);
    }

    return results;
  }

  /**
   * Search GitHub for repositories matching a query.
   *
   * Uses the `gh` CLI if available: `gh search repos <query> --json name,description,url --limit 5`.
   * Returns empty array if gh is not installed or not authenticated.
   *
   * @param {string} query - Search terms
   * @param {Object} [options]
   * @param {number} [options.limit=5] - Max results to return
   * @returns {Array<{name: string, description: string, url: string}>}
   */
  searchGitHub(query, options = {}) {
    if (!query || typeof query !== 'string') return [];
    const limit = options.limit || 5;

    // Check cache first
    const cached = this.getCachedResult('github', query);
    if (cached) {
      this.logger.debug?.(`[ToolDiscovery] github cache hit for "${query}"`);
      return cached;
    }

    // Check if gh is available
    if (!this._isCommandAvailable(this.ghBin)) {
      this.logger.debug?.('[ToolDiscovery] gh CLI not available, skipping GitHub search');
      return [];
    }

    try {
      const sanitized = this._sanitizeShellArg(query);
      const cmd = `${this.ghBin} search repos ${sanitized} --json name,description,url --limit ${limit} 2>/dev/null`;
      const stdout = execSync(cmd, {
        timeout: SEARCH_TIMEOUT_MS,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      });

      const raw = JSON.parse(stdout);
      if (!Array.isArray(raw)) return [];

      const results = raw.map(repo => ({
        name: repo.name || '',
        description: repo.description || '',
        url: repo.url || ''
      }));

      this.cacheResult('github', query, results);
      this.logger.debug?.(`[ToolDiscovery] github search "${query}": ${results.length} results`);
      return results;
    } catch (err) {
      this.logger.debug?.(`[ToolDiscovery] github search failed for "${query}": ${err.message}`);
      return [];
    }
  }

  /**
   * Combined search across all sources.
   *
   * @param {string} query - Search terms
   * @param {Object} [options]
   * @param {string[]} [options.sources] - Which sources to search (default: all)
   * @param {number} [options.limit=5] - Max results per source
   * @returns {{npm: Array, pip: Array, github: Array}}
   */
  searchAll(query, options = {}) {
    const sources = options.sources || ['npm', 'pip', 'github'];
    const limit = options.limit || 5;

    const results = { npm: [], pip: [], github: [] };

    if (sources.includes('npm')) {
      results.npm = this.searchNpm(query, { limit });
    }
    if (sources.includes('pip')) {
      results.pip = this.searchPip(query, { limit });
    }
    if (sources.includes('github')) {
      results.github = this.searchGitHub(query, { limit });
    }

    return results;
  }

  // ── Install Methods ─────────────────────────────────────────────────────

  /**
   * Install an npm package to a scoped directory.
   *
   * Runs `npm install --prefix <targetDir> <packageName>`.
   * Creates targetDir if it doesn't exist.
   * Never installs globally.
   *
   * @param {string} packageName - Package to install (e.g., 'playwright', 'is-odd@3.0.1')
   * @param {string} targetDir - Directory to install into
   * @param {Object} [options]
   * @param {number} [options.timeout] - Override install timeout (ms)
   * @returns {{success: boolean, path: string, error: string|null}}
   */
  installNpm(packageName, targetDir, options = {}) {
    if (!packageName || !targetDir) {
      return { success: false, path: '', error: 'packageName and targetDir are required' };
    }

    const timeout = options.timeout || INSTALL_TIMEOUT_MS;

    try {
      // Ensure target directory exists
      this._ensureDir(targetDir);

      const sanitizedPkg = this._sanitizeShellArg(packageName);
      const cmd = `${this.npmBin} install --prefix ${this._sanitizeShellArg(targetDir)} ${sanitizedPkg} 2>&1`;

      this.logger.info?.(`[ToolDiscovery] Installing npm package: ${packageName} -> ${targetDir}`);
      execSync(cmd, {
        timeout,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: targetDir
      });

      const installedPath = path.join(targetDir, 'node_modules', packageName.split('@')[0]);
      const success = fs.existsSync(installedPath);

      this._recordInstall('npm', packageName, targetDir, success);

      if (success) {
        this.logger.info?.(`[ToolDiscovery] npm install success: ${packageName} at ${installedPath}`);
      } else {
        this.logger.warn?.(`[ToolDiscovery] npm install completed but package not found at ${installedPath}`);
      }

      return { success, path: installedPath, error: null };
    } catch (err) {
      const errorMsg = err.message || 'npm install failed';
      this.logger.warn?.(`[ToolDiscovery] npm install failed for ${packageName}: ${errorMsg}`);
      this._recordInstall('npm', packageName, targetDir, false);
      return { success: false, path: '', error: errorMsg };
    }
  }

  /**
   * Install a pip package to a scoped directory.
   *
   * Runs `pip install --target <targetDir> <packageName>`.
   * Creates targetDir if it doesn't exist.
   * Never installs globally.
   *
   * @param {string} packageName - Package to install (e.g., 'requests', 'numpy==1.24.0')
   * @param {string} targetDir - Directory to install into
   * @param {Object} [options]
   * @param {number} [options.timeout] - Override install timeout (ms)
   * @returns {{success: boolean, path: string, error: string|null}}
   */
  installPip(packageName, targetDir, options = {}) {
    if (!packageName || !targetDir) {
      return { success: false, path: '', error: 'packageName and targetDir are required' };
    }

    const timeout = options.timeout || INSTALL_TIMEOUT_MS;

    try {
      // Ensure target directory exists
      this._ensureDir(targetDir);

      const sanitizedPkg = this._sanitizeShellArg(packageName);
      const sanitizedDir = this._sanitizeShellArg(targetDir);
      const cmd = `${this.pipBin} install --target ${sanitizedDir} ${sanitizedPkg} 2>&1`;

      this.logger.info?.(`[ToolDiscovery] Installing pip package: ${packageName} -> ${targetDir}`);
      execSync(cmd, {
        timeout,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      });

      // pip packages may install under various names — check directory has contents
      const contents = fs.readdirSync(targetDir);
      const success = contents.length > 0;

      this._recordInstall('pip', packageName, targetDir, success);

      if (success) {
        this.logger.info?.(`[ToolDiscovery] pip install success: ${packageName} at ${targetDir}`);
      } else {
        this.logger.warn?.(`[ToolDiscovery] pip install completed but target dir is empty: ${targetDir}`);
      }

      return { success, path: targetDir, error: null };
    } catch (err) {
      const errorMsg = err.message || 'pip install failed';
      this.logger.warn?.(`[ToolDiscovery] pip install failed for ${packageName}: ${errorMsg}`);
      this._recordInstall('pip', packageName, targetDir, false);
      return { success: false, path: '', error: errorMsg };
    }
  }

  // ── Cache Methods ───────────────────────────────────────────────────────

  /**
   * Store a discovery result in the in-memory cache.
   *
   * @param {string} source - Source identifier ('npm', 'pip', 'github')
   * @param {string} query - Search query
   * @param {any} result - Result to cache
   */
  cacheResult(source, query, result) {
    const key = `${source}:${query}`;
    this.cache.set(key, {
      result,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Retrieve a cached discovery result.
   *
   * @param {string} source - Source identifier ('npm', 'pip', 'github')
   * @param {string} query - Search query
   * @param {Object} [options]
   * @param {number} [options.maxAgeMs] - Max cache age in ms (default: 1 hour)
   * @returns {any|null} Cached result or null if not found / expired
   */
  getCachedResult(source, query, options = {}) {
    const key = `${source}:${query}`;
    const entry = this.cache.get(key);

    if (!entry) return null;

    // Check expiration
    const maxAge = options.maxAgeMs || 3600000; // 1 hour default
    const age = Date.now() - new Date(entry.timestamp).getTime();
    if (age > maxAge) {
      this.cache.delete(key);
      return null;
    }

    return entry.result;
  }

  /**
   * Save the in-memory cache to disk.
   *
   * Writes to ~/.cosmo2.3/tool-discovery-cache.json.
   * Creates parent directory if needed.
   */
  saveCacheToDisk() {
    try {
      const dir = path.dirname(this.cachePath);
      this._ensureDir(dir);

      const data = {};
      for (const [key, value] of this.cache.entries()) {
        data[key] = value;
      }

      fs.writeFileSync(this.cachePath, JSON.stringify(data, null, 2), 'utf8');
      this.logger.debug?.(`[ToolDiscovery] Cache saved to disk: ${this.cache.size} entries`);
    } catch (err) {
      this.logger.warn?.(`[ToolDiscovery] Failed to save cache to disk: ${err.message}`);
    }
  }

  /**
   * Load cached data from disk into the in-memory cache.
   *
   * Reads from ~/.cosmo2.3/tool-discovery-cache.json if it exists.
   * Merges with any existing in-memory entries (disk entries don't overwrite newer memory entries).
   */
  loadCacheFromDisk() {
    try {
      if (!fs.existsSync(this.cachePath)) {
        this.logger.debug?.('[ToolDiscovery] No cache file on disk');
        return;
      }

      const raw = fs.readFileSync(this.cachePath, 'utf8');
      const data = JSON.parse(raw);

      let loaded = 0;
      for (const [key, value] of Object.entries(data)) {
        // Only load if not already in memory (memory is fresher)
        if (!this.cache.has(key) && value && value.result !== undefined) {
          this.cache.set(key, {
            result: value.result,
            timestamp: value.timestamp || new Date().toISOString()
          });
          loaded++;
        }
      }

      this.logger.debug?.(`[ToolDiscovery] Loaded ${loaded} entries from disk cache`);
    } catch (err) {
      this.logger.warn?.(`[ToolDiscovery] Failed to load cache from disk: ${err.message}`);
    }
  }

  /**
   * Clear the in-memory cache. Optionally delete the disk cache too.
   *
   * @param {Object} [options]
   * @param {boolean} [options.disk=false] - Also delete the disk cache file
   */
  clearCache(options = {}) {
    this.cache.clear();
    if (options.disk) {
      try {
        if (fs.existsSync(this.cachePath)) {
          fs.unlinkSync(this.cachePath);
        }
      } catch (_err) {
        // Ignore cleanup errors
      }
    }
    this.logger.debug?.('[ToolDiscovery] Cache cleared');
  }

  // ── Query Methods ───────────────────────────────────────────────────────

  /**
   * Get installation history.
   *
   * @returns {Array<{source: string, package: string, targetDir: string, timestamp: string, success: boolean}>}
   */
  getInstallHistory() {
    return [...this.installHistory];
  }

  /**
   * Get cache statistics.
   *
   * @returns {{size: number, sources: Object<string, number>}}
   */
  getCacheStats() {
    const sources = {};
    for (const key of this.cache.keys()) {
      const source = key.split(':')[0];
      sources[source] = (sources[source] || 0) + 1;
    }
    return { size: this.cache.size, sources };
  }

  /**
   * Check if a specific tool/package is available via any source.
   * Convenience method that searches all sources and returns the first match.
   *
   * @param {string} name - Package/tool name
   * @returns {{found: boolean, source: string|null, result: Object|null}}
   */
  probe(name) {
    // Try npm
    const npmResults = this.searchNpm(name, { limit: 1 });
    if (npmResults.length > 0) {
      const exact = npmResults.find(r => r.name === name);
      if (exact) return { found: true, source: 'npm', result: exact };
    }

    // Try pip
    const pipResults = this.searchPip(name, { limit: 1 });
    if (pipResults.length > 0) {
      return { found: true, source: 'pip', result: pipResults[0] };
    }

    // Try github
    const ghResults = this.searchGitHub(name, { limit: 1 });
    if (ghResults.length > 0) {
      return { found: true, source: 'github', result: ghResults[0] };
    }

    return { found: false, source: null, result: null };
  }

  /**
   * Discover and install a package in one step.
   * Searches for the package, then installs it to the specified directory.
   *
   * @param {string} name - Package name
   * @param {string} targetDir - Where to install
   * @param {Object} [options]
   * @param {string} [options.preferSource] - Preferred source ('npm' or 'pip')
   * @returns {{found: boolean, installed: boolean, source: string|null, path: string, error: string|null}}
   */
  discoverAndInstall(name, targetDir, options = {}) {
    const prefer = options.preferSource || null;

    // If preferred source specified, try it first
    if (prefer === 'npm') {
      const npmResults = this.searchNpm(name, { limit: 1 });
      if (npmResults.length > 0) {
        const result = this.installNpm(name, targetDir);
        return { found: true, installed: result.success, source: 'npm', path: result.path, error: result.error };
      }
    }

    if (prefer === 'pip') {
      const pipResults = this.searchPip(name, { limit: 1 });
      if (pipResults.length > 0) {
        const result = this.installPip(name, targetDir);
        return { found: true, installed: result.success, source: 'pip', path: result.path, error: result.error };
      }
    }

    // Try npm
    const npmResults = this.searchNpm(name, { limit: 1 });
    if (npmResults.length > 0 && npmResults.find(r => r.name === name)) {
      const result = this.installNpm(name, targetDir);
      return { found: true, installed: result.success, source: 'npm', path: result.path, error: result.error };
    }

    // Try pip
    const pipResults = this.searchPip(name, { limit: 1 });
    if (pipResults.length > 0) {
      const result = this.installPip(name, targetDir);
      return { found: true, installed: result.success, source: 'pip', path: result.path, error: result.error };
    }

    return { found: false, installed: false, source: null, path: '', error: `Package "${name}" not found in any source` };
  }

  // ── Private Helpers ─────────────────────────────────────────────────────

  /**
   * Sanitize a string for safe use as a shell argument.
   * Wraps in single quotes, escaping any existing single quotes.
   *
   * @param {string} arg
   * @returns {string}
   */
  _sanitizeShellArg(arg) {
    // Replace single quotes with escaped version, then wrap in single quotes
    return `'${String(arg).replace(/'/g, "'\\''")}'`;
  }

  /**
   * Check if a command is available on the system.
   *
   * @param {string} cmd - Command name
   * @returns {boolean}
   */
  _isCommandAvailable(cmd) {
    try {
      execSync(`which ${cmd} 2>/dev/null`, {
        timeout: 3000,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Parse a field from pip show output.
   *
   * @param {string} output - pip show output
   * @param {string} field - Field name (e.g., 'Name', 'Version')
   * @returns {string|null}
   */
  _parsePipShowField(output, field) {
    const match = output.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
    return match ? match[1].trim() : null;
  }

  /**
   * Ensure a directory exists, creating it recursively if needed.
   *
   * @param {string} dirPath
   */
  _ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  /**
   * Record an installation attempt in the history.
   *
   * @param {string} source
   * @param {string} pkg
   * @param {string} targetDir
   * @param {boolean} success
   */
  _recordInstall(source, pkg, targetDir, success) {
    this.installHistory.push({
      source,
      package: pkg,
      targetDir,
      timestamp: new Date().toISOString(),
      success
    });

    // Keep history bounded (last 100 entries)
    if (this.installHistory.length > 100) {
      this.installHistory = this.installHistory.slice(-100);
    }
  }
}

module.exports = { ToolDiscovery };
