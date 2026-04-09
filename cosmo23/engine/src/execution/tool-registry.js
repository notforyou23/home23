/**
 * Tool Registry — Discovery, tracking, and querying of atomic executables
 *
 * Tools are the lowest level of the Plugin → Skill → Tool hierarchy.
 * A tool is a specific executable: a binary, script, API endpoint, or library.
 * Tools have no domain knowledge — they just run.
 *
 * The registry:
 *   - Discovers tools at startup by scanning the system
 *   - Tracks tool availability and versions
 *   - Persists cached results to ~/.cosmo2.3/tool-registry.json
 *   - Allows runtime registration (COSMO can discover new tools)
 *   - Provides a queryable snapshot for agent context injection
 */

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { normalizeTool } = require('./schemas');

// Known tools to scan for at startup
const KNOWN_TOOLS = [
  {
    id: 'tool:python',
    commands: ['python3', 'python'],
    versionFlag: '--version',
    capabilities: ['execute_script', 'pip_install', 'repl'],
    type: 'binary'
  },
  {
    id: 'tool:node',
    commands: ['node'],
    versionFlag: '--version',
    capabilities: ['execute_script', 'npm_install', 'repl'],
    type: 'binary'
  },
  {
    id: 'tool:docker',
    commands: ['docker'],
    versionFlag: '--version',
    capabilities: ['container_run', 'container_build', 'image_pull'],
    type: 'binary'
  },
  {
    id: 'tool:git',
    commands: ['git'],
    versionFlag: '--version',
    capabilities: ['version_control', 'clone', 'diff'],
    type: 'binary'
  },
  {
    id: 'tool:curl',
    commands: ['curl'],
    versionFlag: '--version',
    capabilities: ['http_request', 'download'],
    type: 'binary'
  },
  {
    id: 'tool:npm',
    commands: ['npm'],
    versionFlag: '--version',
    capabilities: ['package_install', 'script_run'],
    type: 'binary'
  },
  {
    id: 'tool:pip',
    commands: ['pip3', 'pip'],
    versionFlag: '--version',
    capabilities: ['package_install', 'package_list'],
    type: 'binary'
  },
  {
    id: 'tool:jq',
    commands: ['jq'],
    versionFlag: '--version',
    capabilities: ['json_query', 'json_transform'],
    type: 'binary'
  },
  {
    id: 'tool:sqlite3',
    commands: ['sqlite3'],
    versionFlag: '--version',
    capabilities: ['sql_query', 'database'],
    type: 'binary'
  },
  {
    id: 'tool:wget',
    commands: ['wget'],
    versionFlag: '--version',
    capabilities: ['http_request', 'download'],
    type: 'binary'
  },
  {
    id: 'tool:ffmpeg',
    commands: ['ffmpeg'],
    versionFlag: '-version',
    capabilities: ['media_convert', 'audio_process', 'video_process'],
    type: 'binary'
  },
  {
    id: 'tool:pandoc',
    commands: ['pandoc'],
    versionFlag: '--version',
    capabilities: ['document_convert', 'markdown_render'],
    type: 'binary'
  },
  {
    id: 'tool:duckdb',
    commands: ['duckdb'],
    versionFlag: '--version',
    capabilities: ['sql_query', 'analytics', 'parquet_read'],
    type: 'binary'
  },
  {
    id: 'tool:httpie',
    commands: ['http', 'https'],
    versionFlag: '--version',
    capabilities: ['http_request', 'api_test'],
    type: 'binary'
  },
  {
    id: 'tool:rsync',
    commands: ['rsync'],
    versionFlag: '--version',
    capabilities: ['file_sync', 'backup'],
    type: 'binary'
  },
  {
    id: 'tool:gh',
    commands: ['gh'],
    versionFlag: '--version',
    capabilities: ['github_api', 'issue_manage', 'pr_manage'],
    type: 'binary'
  },
  {
    id: 'tool:aria2c',
    commands: ['aria2c'],
    versionFlag: '--version',
    capabilities: ['download', 'parallel_download', 'torrent'],
    type: 'binary'
  },
  {
    id: 'tool:csvkit',
    commands: ['csvlook'],
    versionFlag: '--version',
    capabilities: ['csv_query', 'csv_transform'],
    type: 'binary'
  },
  {
    id: 'tool:miller',
    commands: ['mlr'],
    versionFlag: '--version',
    capabilities: ['csv_query', 'json_transform', 'data_transform'],
    type: 'binary'
  },
  {
    id: 'tool:exiftool',
    commands: ['exiftool'],
    versionFlag: '-ver',
    capabilities: ['metadata_read', 'metadata_write'],
    type: 'binary'
  },
  {
    id: 'tool:imagemagick',
    commands: ['convert', 'magick'],
    versionFlag: '--version',
    capabilities: ['image_convert', 'image_resize', 'image_process'],
    type: 'binary'
  },
  {
    id: 'tool:osascript',
    commands: ['osascript'],
    versionFlag: null,
    capabilities: ['macos_automation', 'applescript'],
    type: 'binary'
  },
  {
    id: 'tool:playwright',
    commands: ['npx playwright'],
    versionFlag: '--version',
    capabilities: ['browser_automation', 'web_scrape', 'screenshot'],
    type: 'binary'
  },
  {
    id: 'tool:yt-dlp',
    commands: ['yt-dlp'],
    versionFlag: '--version',
    capabilities: ['video_download', 'audio_download', 'metadata_extract'],
    type: 'binary'
  },
  {
    id: 'tool:aws',
    commands: ['aws'],
    versionFlag: '--version',
    capabilities: ['cloud_aws', 's3', 'lambda'],
    type: 'binary'
  },
  {
    id: 'tool:gcloud',
    commands: ['gcloud'],
    versionFlag: '--version',
    capabilities: ['cloud_gcp', 'gcs', 'compute'],
    type: 'binary'
  },
  {
    id: 'tool:az',
    commands: ['az'],
    versionFlag: '--version',
    capabilities: ['cloud_azure', 'blob_storage', 'functions'],
    type: 'binary'
  }
];

class ToolRegistry {
  constructor(config = {}, logger = console) {
    this.logger = logger;
    this.tools = new Map();
    this.cachePath = config.cachePath || null;
    this.extraBinaries = config.extraBinaries || [];   // Additional binaries to check for
    this._pipPackagesCache = null;
    this._pipCacheTimestamp = 0;
    this._pipCacheTtlMs = 5 * 60 * 1000;              // 5 minutes
    this._scannedIds = [];                             // All tool IDs that were scan targets
  }

  get size() {
    return this.tools.size;
  }

  // ── Discovery ──────────────────────────────────────────────────────────

  /**
   * Scan the system for known tools. Run at startup.
   * Loads cached results first, then re-verifies.
   */
  async discover() {
    // Load cache for warm start
    this._loadCache();

    const allBinaries = [
      ...KNOWN_TOOLS,
      ...this.extraBinaries.map(cmd => ({
        id: `tool:${cmd}`,
        commands: [cmd],
        versionFlag: '--version',
        capabilities: [],
        type: 'binary'
      }))
    ];

    // Record all scan target IDs for introspection
    this._scannedIds = allBinaries.map(spec => spec.id);

    let discovered = 0;
    for (const spec of allBinaries) {
      const result = this._probeCommand(spec);
      if (result) {
        this.tools.set(result.id, result);
        discovered++;
      }
    }

    // Discover pip packages
    await this._discoverPipPackages();

    this._saveCache();

    this.logger.info(`[ToolRegistry] Discovered ${discovered} tools, ${this.tools.size} total registered`);
    return discovered;
  }

  /**
   * Probe a single command: check if it exists and get its version.
   */
  _probeCommand(spec) {
    for (const cmd of spec.commands) {
      try {
        const whichResult = execSync(`which ${cmd} 2>/dev/null`, { timeout: 5000, encoding: 'utf-8' }).trim();
        if (!whichResult) continue;

        let version = null;
        if (spec.versionFlag) {
          try {
            const versionOutput = execSync(`${cmd} ${spec.versionFlag} 2>&1`, { timeout: 5000, encoding: 'utf-8' }).trim();
            // Extract version number (first match of X.Y.Z pattern)
            const match = versionOutput.match(/(\d+\.\d+(?:\.\d+)?)/);
            version = match ? match[1] : versionOutput.slice(0, 60);
          } catch { /* version check optional */ }
        }

        return normalizeTool({
          id: spec.id,
          type: spec.type,
          name: spec.id.replace('tool:', ''),
          command: cmd,
          version,
          available: true,
          discoveredAt: new Date().toISOString(),
          verifiedAt: new Date().toISOString(),
          verifiedBy: `which ${cmd}`,
          capabilities: spec.capabilities
        });
      } catch {
        // Command not found, try next
      }
    }
    return null;
  }

  /**
   * Discover installed pip packages and register them as tools.
   */
  async _discoverPipPackages() {
    const now = Date.now();
    if (this._pipPackagesCache && (now - this._pipCacheTimestamp) < this._pipCacheTtlMs) {
      return;
    }

    try {
      const pipCmd = this.tools.has('tool:pip') ? this.tools.get('tool:pip').command : 'pip3';
      const output = execSync(`${pipCmd} list --format=json 2>/dev/null`, { timeout: 15000, encoding: 'utf-8' });
      const packages = JSON.parse(output);

      this._pipPackagesCache = packages;
      this._pipCacheTimestamp = now;

      for (const pkg of packages) {
        const toolId = `tool:pip:${pkg.name.toLowerCase()}`;
        if (!this.tools.has(toolId)) {
          this.tools.set(toolId, normalizeTool({
            id: toolId,
            type: 'pip_package',
            name: pkg.name,
            version: pkg.version,
            available: true,
            capabilities: ['python_import'],
            metadata: { packageManager: 'pip' }
          }));
        }
      }
    } catch (err) {
      this.logger.warn('[ToolRegistry] Failed to discover pip packages:', err.message);
    }
  }

  // ── Registration ───────────────────────────────────────────────────────

  /**
   * Register a tool definition. Overwrites if ID already exists.
   */
  register(toolDef) {
    const tool = normalizeTool(toolDef);
    this.tools.set(tool.id, tool);
    this._saveCache();
    this.logger.info(`[ToolRegistry] Registered tool: ${tool.id} (${tool.name} ${tool.version || ''})`);
    return tool;
  }

  /**
   * Remove a tool from the registry.
   */
  unregister(toolId) {
    const existed = this.tools.delete(toolId);
    if (existed) this._saveCache();
    return existed;
  }

  /**
   * Mark a tool as broken (available = false).
   */
  markBroken(toolId, reason) {
    const tool = this.tools.get(toolId);
    if (tool) {
      tool.available = false;
      tool.metadata.brokenReason = reason;
      tool.metadata.brokenAt = new Date().toISOString();
      this._saveCache();
    }
  }

  // ── Querying ───────────────────────────────────────────────────────────

  /**
   * Get all tool IDs that were in the scan targets (not just available ones).
   * Useful for agents to know the full set of tools that were looked for.
   */
  getScannedToolIds() {
    return [...this._scannedIds];
  }

  /**
   * Get a tool by ID.
   */
  get(toolId) {
    return this.tools.get(toolId) || null;
  }

  /**
   * Check if a tool is available (exists and not marked broken).
   */
  isAvailable(toolId) {
    const tool = this.tools.get(toolId);
    return tool?.available === true;
  }

  /**
   * Query tools by filter criteria.
   * @param {Object} filter - { type, capability, available, name }
   * @returns {Array} Matching tools
   */
  query(filter = {}) {
    return Array.from(this.tools.values()).filter(tool => {
      if (filter.type && tool.type !== filter.type) return false;
      if (filter.capability && !tool.capabilities.includes(filter.capability)) return false;
      if (filter.available !== undefined && tool.available !== filter.available) return false;
      if (filter.name && !tool.name.toLowerCase().includes(filter.name.toLowerCase())) return false;
      return true;
    });
  }

  /**
   * Re-verify a specific tool exists and works.
   */
  async verify(toolId) {
    const tool = this.tools.get(toolId);
    if (!tool) return false;

    if (tool.type === 'binary' && tool.command) {
      try {
        execSync(`which ${tool.command} 2>/dev/null`, { timeout: 5000 });
        tool.available = true;
        tool.verifiedAt = new Date().toISOString();
        this._saveCache();
        return true;
      } catch {
        tool.available = false;
        this._saveCache();
        return false;
      }
    }

    // Pip packages — check importability
    if (tool.type === 'pip_package') {
      try {
        const modName = tool.name.toLowerCase().replace(/-/g, '_');
        execSync(`python3 -c "import ${modName}" 2>/dev/null`, { timeout: 10000 });
        tool.available = true;
        tool.verifiedAt = new Date().toISOString();
        this._saveCache();
        return true;
      } catch {
        tool.available = false;
        this._saveCache();
        return false;
      }
    }

    return tool.available;
  }

  // ── Snapshot ───────────────────────────────────────────────────────────

  /**
   * Get a serializable snapshot of all tools for agent context injection.
   * Returns a compact summary — not the full tool objects.
   */
  getSnapshot() {
    return Array.from(this.tools.values())
      .filter(t => t.available)
      .map(t => ({
        id: t.id,
        name: t.name,
        type: t.type,
        version: t.version,
        available: t.available,
        capabilities: t.capabilities
      }));
  }

  /**
   * Get a human-readable summary for agent system prompts.
   */
  getSummaryText() {
    const binaries = this.query({ type: 'binary', available: true });
    const pipPkgs = this.query({ type: 'pip_package', available: true });

    const parts = [];
    if (binaries.length) {
      parts.push(`Binaries: ${binaries.map(t => `${t.name} ${t.version || ''}`).join(', ')}`);
    }
    if (pipPkgs.length) {
      parts.push(`Python packages: ${pipPkgs.slice(0, 30).map(t => t.name).join(', ')}${pipPkgs.length > 30 ? ` (+${pipPkgs.length - 30} more)` : ''}`);
    }
    return parts.join('\n') || 'No tools discovered';
  }

  // ── Persistence ────────────────────────────────────────────────────────

  _loadCache() {
    if (!this.cachePath) return;
    try {
      if (fs.existsSync(this.cachePath)) {
        const raw = JSON.parse(fs.readFileSync(this.cachePath, 'utf-8'));
        for (const toolDef of raw.tools || []) {
          try {
            const tool = normalizeTool(toolDef);
            this.tools.set(tool.id, tool);
          } catch { /* skip invalid entries */ }
        }
      }
    } catch (err) {
      this.logger.warn('[ToolRegistry] Failed to load cache:', err.message);
    }
  }

  _saveCache() {
    if (!this.cachePath) return;
    try {
      const dir = path.dirname(this.cachePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const data = {
        version: 1,
        savedAt: new Date().toISOString(),
        tools: Array.from(this.tools.values())
      };
      fs.writeFileSync(this.cachePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      this.logger.warn('[ToolRegistry] Failed to save cache:', err.message);
    }
  }
}

module.exports = { ToolRegistry };
