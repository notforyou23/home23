/**
 * Plugin Registry — Domain-specific bundles of skills and tool declarations
 *
 * Plugins are the top level of the Plugin → Skill → Tool hierarchy.
 * A plugin groups related skills, declares required tools, and tracks
 * domain-specific assumptions. Examples: "Conformal Bootstrap" (physics),
 * "Legal Research", "Data Analysis".
 *
 * Plugins are loaded from three directories (in priority order):
 *   1. engine/src/execution/plugins/   — shipped with COSMO
 *   2. ~/.cosmo2.3/plugins/            — user-installed
 *   3. ~/.cosmo2.3/plugins/generated/  — COSMO-created at runtime
 *
 * The registry:
 *   - Loads and validates plugin JSON files at startup
 *   - Checks tool readiness via the ToolRegistry
 *   - Resolves skill references via the SkillRegistry
 *   - Scores plugin relevance against research contexts
 *   - Provides compact snapshots for agent context injection
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { normalizePlugin } = require('./schemas');

// Directory paths
const BUILTIN_PLUGINS_DIR = path.join(__dirname, 'plugins');
const USER_PLUGINS_DIR = path.join(os.homedir(), '.cosmo2.3', 'plugins');
const GENERATED_PLUGINS_DIR = path.join(os.homedir(), '.cosmo2.3', 'plugins', 'generated');

// Relevance scoring weights
const SCORING_WEIGHTS = {
  domainMatch: 0.40,
  assumptionOverlap: 0.25,
  toolReadiness: 0.20,
  recentUsage: 0.15
};

class PluginRegistry {
  /**
   * @param {Object} config - Configuration options
   * @param {Object} logger - Logger with info/warn/error methods
   * @param {Object} toolRegistry - ToolRegistry instance for readiness checks
   * @param {Object} skillRegistry - SkillRegistry instance for skill resolution
   */
  constructor(config = {}, logger = console, toolRegistry = null, skillRegistry = null) {
    this.config = config;
    this.logger = logger;
    this.toolRegistry = toolRegistry;
    this.skillRegistry = skillRegistry;
    this.plugins = new Map();

    // Allow overriding directories for testing
    this.builtinDir = config.builtinPluginsDir || BUILTIN_PLUGINS_DIR;
    this.userDir = config.userPluginsDir || USER_PLUGINS_DIR;
    this.generatedDir = config.generatedPluginsDir || GENERATED_PLUGINS_DIR;
  }

  get size() {
    return this.plugins.size;
  }

  // ── Loading ───────────────────────────────────────────────────────────

  /**
   * Load plugin JSON files from all three directories.
   * Safe: creates missing directories, skips invalid files.
   * @returns {number} Total plugins loaded
   */
  async loadAll() {
    const dirs = [
      { path: this.builtinDir, label: 'builtin' },
      { path: this.userDir, label: 'user' },
      { path: this.generatedDir, label: 'generated' }
    ];

    let totalLoaded = 0;

    for (const dir of dirs) {
      const count = this._loadFromDirectory(dir.path, dir.label);
      totalLoaded += count;
    }

    this.logger.info(
      `[PluginRegistry] Loaded ${totalLoaded} plugins (${this.plugins.size} unique) from ${dirs.length} directories`
    );

    return totalLoaded;
  }

  /**
   * Load all .json files from a single directory.
   * Creates the directory if it doesn't exist.
   * @returns {number} Number of plugins loaded from this directory
   */
  _loadFromDirectory(dirPath, label) {
    // Ensure directory exists
    try {
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
        this.logger.info(`[PluginRegistry] Created ${label} plugins directory: ${dirPath}`);
      }
    } catch (err) {
      this.logger.warn(`[PluginRegistry] Cannot create ${label} directory ${dirPath}: ${err.message}`);
      return 0;
    }

    // Read directory contents
    let files;
    try {
      files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));
    } catch (err) {
      this.logger.warn(`[PluginRegistry] Cannot read ${label} directory ${dirPath}: ${err.message}`);
      return 0;
    }

    let loaded = 0;
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const plugin = this.register(raw, /* silent */ true);
        if (plugin) {
          plugin.metadata._source = label;
          plugin.metadata._filePath = filePath;
          loaded++;
        }
      } catch (err) {
        this.logger.warn(`[PluginRegistry] Skipping invalid plugin file ${filePath}: ${err.message}`);
      }
    }

    if (loaded > 0) {
      this.logger.info(`[PluginRegistry] Loaded ${loaded} plugin(s) from ${label} directory`);
    }

    return loaded;
  }

  // ── Registration ──────────────────────────────────────────────────────

  /**
   * Register a plugin definition. Normalizes via schemas.js.
   * Overwrites if the same ID already exists.
   * @param {Object} pluginDef - Raw plugin definition
   * @param {boolean} silent - If true, suppress registration log
   * @returns {Object|null} Normalized plugin, or null on failure
   */
  register(pluginDef, silent = false) {
    try {
      const plugin = normalizePlugin(pluginDef);
      this.plugins.set(plugin.id, plugin);
      if (!silent) {
        this.logger.info(
          `[PluginRegistry] Registered plugin: ${plugin.id} (${plugin.name}, domain=${plugin.domain})`
        );
      }
      return plugin;
    } catch (err) {
      this.logger.warn(`[PluginRegistry] Failed to register plugin: ${err.message}`);
      return null;
    }
  }

  // ── Querying ──────────────────────────────────────────────────────────

  /**
   * Get a plugin by ID.
   * @param {string} pluginId
   * @returns {Object|null}
   */
  get(pluginId) {
    return this.plugins.get(pluginId) || null;
  }

  /**
   * Find plugins matching a domain string.
   * Uses case-insensitive substring matching against plugin.domain and plugin.tags.
   * @param {string} domain - Domain to search for (e.g. "physics", "legal")
   * @returns {Array} Matching plugins
   */
  getForDomain(domain) {
    if (!domain) return [];
    const needle = domain.toLowerCase();
    return Array.from(this.plugins.values()).filter(plugin => {
      if (plugin.domain.toLowerCase().includes(needle)) return true;
      if (plugin.tags.some(tag => tag.toLowerCase().includes(needle))) return true;
      // Also check name and description for broad matching
      if (plugin.name.toLowerCase().includes(needle)) return true;
      return false;
    });
  }

  // ── Readiness ─────────────────────────────────────────────────────────

  /**
   * Check if ALL required tools for a plugin are available.
   * @param {string} pluginId
   * @returns {boolean}
   */
  isReady(pluginId) {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return false;
    if (!plugin.toolsRequired.length) return true;
    if (!this.toolRegistry) return false;

    return plugin.toolsRequired.every(req =>
      this.toolRegistry.isAvailable(req.id)
    );
  }

  /**
   * List tools that a plugin requires but are not currently available.
   * Each entry includes the tool ID and its provision hint (if declared).
   * @param {string} pluginId
   * @returns {Array<{id: string, provision: string|null}>}
   */
  getMissingTools(pluginId) {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return [];
    if (!this.toolRegistry) {
      // Without a tool registry, assume everything is missing
      return plugin.toolsRequired.map(req => ({
        id: req.id,
        provision: req.provision || null
      }));
    }

    return plugin.toolsRequired
      .filter(req => !this.toolRegistry.isAvailable(req.id))
      .map(req => ({
        id: req.id,
        provision: req.provision || null
      }));
  }

  // ── Skill Resolution ──────────────────────────────────────────────────

  /**
   * Resolve a plugin's skill IDs to actual skill objects from the SkillRegistry.
   * Returns only skills that exist in the registry.
   * @param {string} pluginId
   * @returns {Array} Resolved skill objects
   */
  getSkills(pluginId) {
    const plugin = this.plugins.get(pluginId);
    if (!plugin || !this.skillRegistry) return [];

    return plugin.skills
      .map(skillId => this.skillRegistry.get(skillId))
      .filter(Boolean);
  }

  // ── Relevance Scoring ─────────────────────────────────────────────────

  /**
   * Rank all plugins by relevance to a research context.
   *
   * @param {Object} researchContext
   * @param {string} researchContext.domain - Research domain
   * @param {string[]} researchContext.goals - Current research goals
   * @param {string[]} researchContext.recentThoughts - Recent agent thoughts/findings
   * @param {Object} researchContext.memoryState - Current memory/knowledge state
   * @param {Object} researchContext.gapAnalysis - Identified knowledge gaps
   * @returns {Array<{pluginId, score, plugin, ready, missingTools}>} Sorted descending by score
   */
  scoreRelevance(researchContext = {}) {
    const results = [];

    for (const [pluginId, plugin] of this.plugins) {
      const domainScore = this._scoreDomainMatch(plugin, researchContext);
      const assumptionScore = this._scoreAssumptionOverlap(plugin, researchContext);
      const readinessScore = this.isReady(pluginId) ? 1.0 : 0.0;
      const usageScore = this._scoreRecentUsage(plugin, researchContext);

      const score =
        SCORING_WEIGHTS.domainMatch * domainScore +
        SCORING_WEIGHTS.assumptionOverlap * assumptionScore +
        SCORING_WEIGHTS.toolReadiness * readinessScore +
        SCORING_WEIGHTS.recentUsage * usageScore;

      results.push({
        pluginId,
        score: Math.round(score * 1000) / 1000,
        plugin,
        ready: this.isReady(pluginId),
        missingTools: this.getMissingTools(pluginId)
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  /**
   * Score domain keyword match between plugin and context.
   * Checks plugin.domain and plugin.tags against context.domain.
   */
  _scoreDomainMatch(plugin, context) {
    if (!context.domain) return 0;

    const contextDomain = context.domain.toLowerCase();
    const contextTokens = this._tokenize(contextDomain);

    // Exact domain match
    if (plugin.domain.toLowerCase() === contextDomain) return 1.0;

    // Token overlap between plugin domain/tags and context domain
    const pluginTokens = new Set([
      ...this._tokenize(plugin.domain),
      ...plugin.tags.flatMap(t => this._tokenize(t))
    ]);

    let matches = 0;
    for (const token of contextTokens) {
      if (pluginTokens.has(token)) matches++;
    }

    if (contextTokens.length === 0) return 0;
    return Math.min(1.0, matches / contextTokens.length);
  }

  /**
   * Score assumption overlap between plugin.assumptionsTracked and context goals/findings.
   */
  _scoreAssumptionOverlap(plugin, context) {
    if (!plugin.assumptionsTracked.length) return 0;

    // Gather text from goals, recent thoughts, and gap analysis
    const contextText = [
      ...(context.goals || []),
      ...(context.recentThoughts || []),
      ...(context.gapAnalysis?.gaps || []),
      ...(context.gapAnalysis?.questions || [])
    ]
      .join(' ')
      .toLowerCase();

    if (!contextText) return 0;

    const contextTokens = new Set(this._tokenize(contextText));
    let matches = 0;

    for (const assumption of plugin.assumptionsTracked) {
      const assumptionTokens = this._tokenize(assumption);
      const hit = assumptionTokens.some(t => contextTokens.has(t));
      if (hit) matches++;
    }

    return matches / plugin.assumptionsTracked.length;
  }

  /**
   * Score recent skill usage from this plugin.
   * Checks if any of the plugin's skills have been used recently.
   */
  _scoreRecentUsage(plugin, context) {
    if (!plugin.skills.length || !this.skillRegistry) return 0;

    // Check how many of this plugin's skills have recent usage
    let usedRecently = 0;
    const recentThreshold = Date.now() - 30 * 60 * 1000; // Last 30 minutes

    for (const skillId of plugin.skills) {
      const skill = this.skillRegistry.get(skillId);
      if (skill && skill.lastUsed) {
        const lastUsedTime = new Date(skill.lastUsed).getTime();
        if (lastUsedTime > recentThreshold) {
          usedRecently++;
        }
      }
    }

    if (plugin.skills.length === 0) return 0;
    return usedRecently / plugin.skills.length;
  }

  /**
   * Tokenize a string into lowercase, deduplicated keywords.
   * Strips common stop words and short tokens.
   */
  _tokenize(text) {
    if (!text) return [];
    const STOP_WORDS = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to',
      'for', 'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were',
      'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
      'will', 'would', 'could', 'should', 'may', 'might', 'can', 'this',
      'that', 'these', 'those', 'it', 'its'
    ]);
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s_-]/g, ' ')
      .split(/[\s_-]+/)
      .filter(t => t.length > 2 && !STOP_WORDS.has(t));
  }

  // ── Snapshots ─────────────────────────────────────────────────────────

  /**
   * Compact snapshot for agent context injection.
   * Returns essential info without full plugin objects.
   */
  getSnapshot() {
    return Array.from(this.plugins.values()).map(plugin => ({
      id: plugin.id,
      name: plugin.name,
      domain: plugin.domain,
      skills: plugin.skills.length,
      ready: this.isReady(plugin.id),
      tags: plugin.tags
    }));
  }

  /**
   * Human-readable summary for system prompts.
   */
  getSummaryText() {
    if (this.plugins.size === 0) return 'No plugins loaded';

    const lines = [];
    const byDomain = new Map();

    for (const plugin of this.plugins.values()) {
      const domain = plugin.domain || 'general';
      if (!byDomain.has(domain)) byDomain.set(domain, []);
      byDomain.get(domain).push(plugin);
    }

    for (const [domain, plugins] of byDomain) {
      const entries = plugins.map(p => {
        const ready = this.isReady(p.id);
        const status = ready ? 'ready' : 'missing tools';
        return `${p.name} (${p.skills.length} skills, ${status})`;
      });
      lines.push(`${domain}: ${entries.join(', ')}`);
    }

    return lines.join('\n');
  }
}

module.exports = { PluginRegistry };
