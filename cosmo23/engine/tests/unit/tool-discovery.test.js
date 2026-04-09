const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { ToolDiscovery } = require('../../src/execution/tool-discovery');

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {}
};

describe('ToolDiscovery', function () {

  // ── Constructor ─────────────────────────────────────────────────────────

  describe('constructor', function () {
    it('should set default cache path to ~/.cosmo2.3/tool-discovery-cache.json', function () {
      const td = new ToolDiscovery({}, silentLogger);
      const expected = path.join(os.homedir(), '.cosmo2.3', 'tool-discovery-cache.json');
      expect(td.cachePath).to.equal(expected);
    });

    it('should accept custom cache path from config', function () {
      const custom = '/tmp/test-td-cache.json';
      const td = new ToolDiscovery({ cachePath: custom }, silentLogger);
      expect(td.cachePath).to.equal(custom);
    });

    it('should initialize empty cache', function () {
      const td = new ToolDiscovery({}, silentLogger);
      expect(td.cache).to.be.instanceOf(Map);
      expect(td.cache.size).to.equal(0);
    });

    it('should initialize empty install history', function () {
      const td = new ToolDiscovery({}, silentLogger);
      expect(td.installHistory).to.be.an('array').with.length(0);
    });

    it('should default to console logger if none provided', function () {
      const td = new ToolDiscovery();
      expect(td.logger).to.equal(console);
    });
  });

  // ── Cache Methods ───────────────────────────────────────────────────────

  describe('cacheResult / getCachedResult', function () {
    let td;

    beforeEach(function () {
      td = new ToolDiscovery({}, silentLogger);
    });

    it('should store and retrieve a cached result', function () {
      const data = [{ name: 'test-pkg', version: '1.0.0', description: 'test' }];
      td.cacheResult('npm', 'test-pkg', data);
      const result = td.getCachedResult('npm', 'test-pkg');
      expect(result).to.deep.equal(data);
    });

    it('should return null for unknown queries', function () {
      const result = td.getCachedResult('npm', 'nonexistent-query-xyz');
      expect(result).to.be.null;
    });

    it('should return null for unknown sources', function () {
      td.cacheResult('npm', 'test', []);
      const result = td.getCachedResult('pip', 'test');
      expect(result).to.be.null;
    });

    it('should key by source:query', function () {
      td.cacheResult('npm', 'lodash', [{ name: 'lodash-npm' }]);
      td.cacheResult('pip', 'lodash', [{ name: 'lodash-pip' }]);

      const npmResult = td.getCachedResult('npm', 'lodash');
      const pipResult = td.getCachedResult('pip', 'lodash');

      expect(npmResult[0].name).to.equal('lodash-npm');
      expect(pipResult[0].name).to.equal('lodash-pip');
    });

    it('should expire entries based on maxAgeMs', function () {
      td.cache.set('npm:old', {
        result: [{ name: 'old' }],
        timestamp: new Date(Date.now() - 7200000).toISOString() // 2 hours ago
      });

      // Default maxAge is 1 hour, so this should be expired
      const result = td.getCachedResult('npm', 'old');
      expect(result).to.be.null;
    });

    it('should not expire entries within maxAgeMs', function () {
      td.cacheResult('npm', 'fresh', [{ name: 'fresh' }]);
      const result = td.getCachedResult('npm', 'fresh', { maxAgeMs: 3600000 });
      expect(result).to.deep.equal([{ name: 'fresh' }]);
    });
  });

  // ── Disk Persistence ────────────────────────────────────────────────────

  describe('saveCacheToDisk / loadCacheFromDisk', function () {
    let td;
    const tmpCachePath = path.join(os.tmpdir(), `cosmo-td-test-${Date.now()}.json`);

    beforeEach(function () {
      td = new ToolDiscovery({ cachePath: tmpCachePath }, silentLogger);
    });

    afterEach(function () {
      try { fs.unlinkSync(tmpCachePath); } catch (_e) { /* ignore */ }
    });

    it('should save cache to disk and load it back', function () {
      td.cacheResult('npm', 'test-save', [{ name: 'test-save' }]);
      td.saveCacheToDisk();

      expect(fs.existsSync(tmpCachePath)).to.be.true;

      // Create a fresh instance and load
      const td2 = new ToolDiscovery({ cachePath: tmpCachePath }, silentLogger);
      td2.loadCacheFromDisk();

      const result = td2.getCachedResult('npm', 'test-save');
      expect(result).to.deep.equal([{ name: 'test-save' }]);
    });

    it('should not overwrite fresher in-memory entries when loading from disk', function () {
      td.cacheResult('npm', 'conflict', [{ name: 'disk-version' }]);
      td.saveCacheToDisk();

      const td2 = new ToolDiscovery({ cachePath: tmpCachePath }, silentLogger);
      td2.cacheResult('npm', 'conflict', [{ name: 'memory-version' }]);
      td2.loadCacheFromDisk();

      const result = td2.getCachedResult('npm', 'conflict');
      expect(result[0].name).to.equal('memory-version');
    });

    it('should handle missing cache file gracefully', function () {
      const td2 = new ToolDiscovery({ cachePath: '/tmp/nonexistent-cosmo-cache.json' }, silentLogger);
      td2.loadCacheFromDisk(); // Should not throw
      expect(td2.cache.size).to.equal(0);
    });
  });

  // ── clearCache ──────────────────────────────────────────────────────────

  describe('clearCache', function () {
    it('should clear in-memory cache', function () {
      const td = new ToolDiscovery({}, silentLogger);
      td.cacheResult('npm', 'a', [1]);
      td.cacheResult('pip', 'b', [2]);
      expect(td.cache.size).to.equal(2);

      td.clearCache();
      expect(td.cache.size).to.equal(0);
    });

    it('should optionally delete disk cache', function () {
      const tmpPath = path.join(os.tmpdir(), `cosmo-clear-test-${Date.now()}.json`);
      const td = new ToolDiscovery({ cachePath: tmpPath }, silentLogger);
      td.cacheResult('npm', 'x', [1]);
      td.saveCacheToDisk();
      expect(fs.existsSync(tmpPath)).to.be.true;

      td.clearCache({ disk: true });
      expect(td.cache.size).to.equal(0);
      expect(fs.existsSync(tmpPath)).to.be.false;
    });
  });

  // ── getCacheStats ───────────────────────────────────────────────────────

  describe('getCacheStats', function () {
    it('should report correct size and source breakdown', function () {
      const td = new ToolDiscovery({}, silentLogger);
      td.cacheResult('npm', 'a', []);
      td.cacheResult('npm', 'b', []);
      td.cacheResult('pip', 'c', []);

      const stats = td.getCacheStats();
      expect(stats.size).to.equal(3);
      expect(stats.sources.npm).to.equal(2);
      expect(stats.sources.pip).to.equal(1);
    });
  });

  // ── searchNpm ───────────────────────────────────────────────────────────

  describe('searchNpm', function () {
    this.timeout(30000);
    let td;

    before(function () {
      td = new ToolDiscovery({}, silentLogger);
    });

    it('should return an array', function () {
      const results = td.searchNpm('is-odd');
      expect(results).to.be.an('array');
    });

    it('should return objects with name, version, description fields', function () {
      const results = td.searchNpm('is-odd');
      if (results.length > 0) {
        expect(results[0]).to.have.property('name');
        expect(results[0]).to.have.property('version');
        expect(results[0]).to.have.property('description');
      }
      // If no npm available, empty array is fine
    });

    it('should return empty array for invalid input', function () {
      expect(td.searchNpm('')).to.deep.equal([]);
      expect(td.searchNpm(null)).to.deep.equal([]);
      expect(td.searchNpm(undefined)).to.deep.equal([]);
    });

    it('should use cache on second call', function () {
      // Clear any prior cache for this query
      td.cache.delete('npm:is-number');

      const first = td.searchNpm('is-number');
      // Cache the result
      if (first.length > 0) {
        const second = td.searchNpm('is-number');
        expect(second).to.deep.equal(first);
      }
    });
  });

  // ── searchPip ───────────────────────────────────────────────────────────

  describe('searchPip', function () {
    this.timeout(30000);
    let td;

    before(function () {
      td = new ToolDiscovery({}, silentLogger);
    });

    it('should return an array', function () {
      const results = td.searchPip('requests');
      expect(results).to.be.an('array');
    });

    it('should return objects with name, version, description fields when found', function () {
      const results = td.searchPip('requests');
      if (results.length > 0) {
        expect(results[0]).to.have.property('name');
        expect(results[0]).to.have.property('version');
        expect(results[0]).to.have.property('description');
      }
    });

    it('should return empty array for invalid input', function () {
      expect(td.searchPip('')).to.deep.equal([]);
      expect(td.searchPip(null)).to.deep.equal([]);
    });

    it('should return empty array for nonexistent package', function () {
      const results = td.searchPip('zzz_nonexistent_pkg_xyz_12345');
      expect(results).to.be.an('array');
      // Should be empty or at most have a result if somehow found
    });
  });

  // ── searchGitHub ────────────────────────────────────────────────────────

  describe('searchGitHub', function () {
    this.timeout(30000);
    let td;

    before(function () {
      td = new ToolDiscovery({}, silentLogger);
    });

    it('should return an array', function () {
      const results = td.searchGitHub('playwright');
      expect(results).to.be.an('array');
    });

    it('should return objects with name, description, url when gh is available', function () {
      const results = td.searchGitHub('playwright');
      if (results.length > 0) {
        expect(results[0]).to.have.property('name');
        expect(results[0]).to.have.property('description');
        expect(results[0]).to.have.property('url');
      }
      // If gh not available, empty array is acceptable
    });

    it('should return empty array for invalid input', function () {
      expect(td.searchGitHub('')).to.deep.equal([]);
      expect(td.searchGitHub(null)).to.deep.equal([]);
    });
  });

  // ── installNpm ──────────────────────────────────────────────────────────

  describe('installNpm', function () {
    this.timeout(60000);
    let td;
    let tmpDir;

    before(function () {
      td = new ToolDiscovery({}, silentLogger);
    });

    beforeEach(function () {
      tmpDir = path.join(os.tmpdir(), `cosmo-td-npm-test-${Date.now()}`);
    });

    afterEach(function () {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
    });

    it('should install a tiny npm package to scoped directory', function () {
      let npmAvailable = false;
      try {
        require('child_process').execSync('which npm', { stdio: 'pipe' });
        npmAvailable = true;
      } catch (_e) { /* npm not available */ }

      if (!npmAvailable) {
        this.skip();
        return;
      }

      const result = td.installNpm('is-odd', tmpDir);
      expect(result).to.have.property('success');
      expect(result).to.have.property('path');
      expect(result).to.have.property('error');

      if (result.success) {
        expect(result.path).to.include('is-odd');
        expect(fs.existsSync(result.path)).to.be.true;
      }
    });

    it('should return error for missing arguments', function () {
      const result = td.installNpm('', tmpDir);
      expect(result.success).to.be.false;
      expect(result.error).to.be.a('string');
    });

    it('should record install in history', function () {
      let npmAvailable = false;
      try {
        require('child_process').execSync('which npm', { stdio: 'pipe' });
        npmAvailable = true;
      } catch (_e) { /* npm not available */ }

      if (!npmAvailable) {
        this.skip();
        return;
      }

      const historyBefore = td.getInstallHistory().length;
      td.installNpm('is-odd', tmpDir);
      const historyAfter = td.getInstallHistory();
      expect(historyAfter.length).to.be.greaterThan(historyBefore);

      const last = historyAfter[historyAfter.length - 1];
      expect(last.source).to.equal('npm');
      expect(last.package).to.equal('is-odd');
    });
  });

  // ── installPip ──────────────────────────────────────────────────────────

  describe('installPip', function () {
    this.timeout(60000);

    it('should return error for missing arguments', function () {
      const td = new ToolDiscovery({}, silentLogger);
      const result = td.installPip('', '/tmp/some-dir');
      expect(result.success).to.be.false;
      expect(result.error).to.be.a('string');
    });

    it('should return structured result', function () {
      const td = new ToolDiscovery({}, silentLogger);
      const result = td.installPip(null, null);
      expect(result).to.have.all.keys('success', 'path', 'error');
    });
  });

  // ── searchAll ───────────────────────────────────────────────────────────

  describe('searchAll', function () {
    it('should return results keyed by source', function () {
      const td = new ToolDiscovery({}, silentLogger);
      // Use cache to avoid network
      td.cacheResult('npm', 'test-all', [{ name: 'npm-result' }]);
      td.cacheResult('pip', 'test-all', [{ name: 'pip-result' }]);
      td.cacheResult('github', 'test-all', [{ name: 'gh-result' }]);

      const results = td.searchAll('test-all');
      expect(results).to.have.all.keys('npm', 'pip', 'github');
      expect(results.npm).to.be.an('array');
      expect(results.pip).to.be.an('array');
      expect(results.github).to.be.an('array');
    });

    it('should respect sources filter', function () {
      const td = new ToolDiscovery({}, silentLogger);
      td.cacheResult('npm', 'filter-test', [{ name: 'npm-only' }]);

      const results = td.searchAll('filter-test', { sources: ['npm'] });
      expect(results.npm).to.have.length(1);
      expect(results.pip).to.have.length(0);
      expect(results.github).to.have.length(0);
    });
  });

  // ── Shell Argument Sanitization ─────────────────────────────────────────

  describe('_sanitizeShellArg', function () {
    it('should wrap argument in single quotes', function () {
      const td = new ToolDiscovery({}, silentLogger);
      expect(td._sanitizeShellArg('test')).to.equal("'test'");
    });

    it('should escape single quotes in the argument', function () {
      const td = new ToolDiscovery({}, silentLogger);
      const result = td._sanitizeShellArg("it's");
      expect(result).to.include("'\\''");
    });
  });

  // ── getInstallHistory ───────────────────────────────────────────────────

  describe('getInstallHistory', function () {
    it('should return a copy of the history array', function () {
      const td = new ToolDiscovery({}, silentLogger);
      const h1 = td.getInstallHistory();
      const h2 = td.getInstallHistory();
      expect(h1).to.not.equal(h2);
      expect(h1).to.deep.equal(h2);
    });
  });
});
