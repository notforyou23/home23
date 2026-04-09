/**
 * Campaign Memory — Persistent cross-run learning
 *
 * Stores patterns, lessons, and effectiveness data across research campaigns.
 * Each run contributes to campaign memory at completion; future runs load it
 * during planning to benefit from prior experience.
 *
 * Storage: ~/.cosmo2.3/campaign-memory/
 *   - campaigns.json — index of all campaigns
 *   - patterns.json — recurring assumption-sensitivity patterns
 *   - skill-effectiveness.json — which skills/plugins worked for which domains
 *   - fork-strategies.json — which branching strategies led to convergence
 *   - domain-insights.json — cross-campaign domain-specific patterns
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const CAMPAIGN_MEMORY_DIR = path.join(os.homedir(), '.cosmo2.3', 'campaign-memory');

class CampaignMemory {
  constructor(config = {}, logger = console) {
    this.logger = logger;
    this.baseDir = config.campaignMemoryDir || CAMPAIGN_MEMORY_DIR;
    this.enabled = config.campaignMemory?.enabled !== false;

    // In-memory state
    this.campaigns = [];
    this.patterns = [];
    this.skillEffectiveness = {};
    this.forkStrategies = [];
    this.domainInsights = {};
  }

  // ── Initialization ─────────────────────────────────────────────────────

  /**
   * Load all campaign memory from disk. Called at run start.
   */
  async load() {
    if (!this.enabled) return;

    this._ensureDir();

    this.campaigns = this._readJson('campaigns.json', []);
    this.patterns = this._readJson('patterns.json', []);
    this.skillEffectiveness = this._readJson('skill-effectiveness.json', {});
    this.forkStrategies = this._readJson('fork-strategies.json', []);
    this.domainInsights = this._readJson('domain-insights.json', {});

    this.logger.info('[CampaignMemory] Loaded', {
      campaigns: this.campaigns.length,
      patterns: this.patterns.length,
      domains: Object.keys(this.domainInsights).length
    });
  }

  /**
   * Save all campaign memory to disk.
   */
  async save() {
    if (!this.enabled) return;

    this._ensureDir();

    this._writeJson('campaigns.json', this.campaigns);
    this._writeJson('patterns.json', this.patterns);
    this._writeJson('skill-effectiveness.json', this.skillEffectiveness);
    this._writeJson('fork-strategies.json', this.forkStrategies);
    this._writeJson('domain-insights.json', this.domainInsights);
  }

  // ── Campaign Registration ──────────────────────────────────────────────

  /**
   * Record that a run completed. Called at run end.
   */
  async recordCampaignCompletion(runData) {
    if (!this.enabled) return;

    const campaign = {
      runId: runData.runId || runData.runName,
      domain: runData.domain || null,
      topic: runData.topic || null,
      completedAt: new Date().toISOString(),
      cycleCount: runData.cycleCount || 0,
      nodeCount: runData.nodeCount || 0,
      edgeCount: runData.edgeCount || 0,
      agentsSpawned: runData.agentsSpawned || 0,
      agentsSucceeded: runData.agentsSucceeded || 0,
      executionMode: runData.executionMode || 'guided',
      models: runData.models || {},
      skillsUsed: runData.skillsUsed || [],
      pluginsUsed: runData.pluginsUsed || [],
      executionResults: runData.executionResults || 0,
      executionFailures: runData.executionFailures || 0,
      keyFindings: runData.keyFindings || []
    };

    this.campaigns.push(campaign);

    // Keep last 100 campaigns
    if (this.campaigns.length > 100) {
      this.campaigns = this.campaigns.slice(-100);
    }

    await this.save();
    this.logger.info('[CampaignMemory] Campaign recorded', { runId: campaign.runId, domain: campaign.domain });
  }

  // ── Pattern Recording ──────────────────────────────────────────────────

  /**
   * Record an assumption-sensitivity pattern discovered during a run.
   * These are the investigation documents' "Fisher information framework" —
   * which assumptions are load-bearing for which conclusions.
   */
  recordPattern(pattern) {
    if (!this.enabled) return;

    this.patterns.push({
      domain: pattern.domain || null,
      assumption: pattern.assumption,
      sensitivity: pattern.sensitivity,             // 0-1, how much the conclusion changes
      conclusion: pattern.conclusion,
      discoveredIn: pattern.runId,
      discoveredAt: new Date().toISOString(),
      occurrences: 1
    });

    // Merge duplicates (same assumption + conclusion domain)
    this._mergePatterns();

    // Keep last 500 patterns
    if (this.patterns.length > 500) {
      this.patterns = this.patterns.slice(-500);
    }
  }

  /**
   * Get patterns relevant to a given domain and research context.
   */
  getPatternsForDomain(domain) {
    if (!domain) return [];
    const lowered = domain.toLowerCase();
    return this.patterns.filter(p =>
      p.domain && p.domain.toLowerCase().includes(lowered)
    ).sort((a, b) => (b.sensitivity || 0) - (a.sensitivity || 0));
  }

  // ── Skill/Plugin Effectiveness ─────────────────────────────────────────

  /**
   * Record that a skill was used and whether it succeeded.
   */
  recordSkillUsage(skillId, domain, success, metadata = {}) {
    if (!this.enabled) return;

    const key = `${skillId}:${domain || 'general'}`;
    if (!this.skillEffectiveness[key]) {
      this.skillEffectiveness[key] = {
        skillId,
        domain: domain || 'general',
        uses: 0,
        successes: 0,
        failures: 0,
        lastUsed: null,
        avgRuntimeSec: null
      };
    }

    const entry = this.skillEffectiveness[key];
    entry.uses++;
    if (success) entry.successes++;
    else entry.failures++;
    entry.lastUsed = new Date().toISOString();

    if (metadata.runtimeSec) {
      entry.avgRuntimeSec = entry.avgRuntimeSec
        ? (entry.avgRuntimeSec * (entry.uses - 1) + metadata.runtimeSec) / entry.uses
        : metadata.runtimeSec;
    }
  }

  /**
   * Get effectiveness data for skills in a given domain.
   * Returns sorted by success rate.
   */
  getEffectiveSkills(domain) {
    const domainLower = (domain || '').toLowerCase();
    return Object.values(this.skillEffectiveness)
      .filter(e => !domainLower || e.domain.toLowerCase().includes(domainLower))
      .sort((a, b) => {
        const rateA = a.uses > 0 ? a.successes / a.uses : 0;
        const rateB = b.uses > 0 ? b.successes / b.uses : 0;
        return rateB - rateA;
      });
  }

  // ── Fork Strategy Recording ────────────────────────────────────────────

  /**
   * Record a fork strategy and whether it led to convergence.
   */
  recordForkStrategy(strategy) {
    if (!this.enabled) return;

    this.forkStrategies.push({
      type: strategy.type,                          // 'hypothesis_variation', 'plugin_triangulation', 'assumption_deformation'
      domain: strategy.domain || null,
      branches: strategy.branches || 0,
      converged: strategy.converged || false,
      convergenceStrength: strategy.convergenceStrength || 0,  // 0-1
      runId: strategy.runId,
      cycle: strategy.cycle,
      recordedAt: new Date().toISOString()
    });

    // Keep last 200 strategies
    if (this.forkStrategies.length > 200) {
      this.forkStrategies = this.forkStrategies.slice(-200);
    }
  }

  /**
   * Get fork strategies that worked for a given domain.
   */
  getEffectiveForkStrategies(domain) {
    const domainLower = (domain || '').toLowerCase();
    return this.forkStrategies
      .filter(s => s.converged && (!domainLower || (s.domain || '').toLowerCase().includes(domainLower)))
      .sort((a, b) => (b.convergenceStrength || 0) - (a.convergenceStrength || 0));
  }

  // ── Domain Insights ────────────────────────────────────────────────────

  /**
   * Record a cross-campaign insight for a domain.
   */
  recordDomainInsight(domain, insight) {
    if (!this.enabled || !domain) return;

    if (!this.domainInsights[domain]) {
      this.domainInsights[domain] = [];
    }

    this.domainInsights[domain].push({
      insight,
      recordedAt: new Date().toISOString()
    });

    // Keep last 50 per domain
    if (this.domainInsights[domain].length > 50) {
      this.domainInsights[domain] = this.domainInsights[domain].slice(-50);
    }
  }

  /**
   * Get all insights for a domain.
   */
  getInsightsForDomain(domain) {
    return this.domainInsights[domain] || [];
  }

  // ── Planning Context ───────────────────────────────────────────────────

  /**
   * Build a context object for the GuidedModePlanner.
   * Returns a compact summary of relevant prior campaign knowledge.
   */
  buildPlanningContext(domain, topic) {
    const context = {
      priorCampaigns: this._findRelatedCampaigns(domain, topic),
      sensitivityPatterns: this.getPatternsForDomain(domain).slice(0, 10),
      effectiveSkills: this.getEffectiveSkills(domain).slice(0, 10),
      effectiveForkStrategies: this.getEffectiveForkStrategies(domain).slice(0, 5),
      domainInsights: this.getInsightsForDomain(domain).slice(0, 10),
      summary: null
    };

    // Build human-readable summary
    const parts = [];
    if (context.priorCampaigns.length > 0) {
      parts.push(`${context.priorCampaigns.length} prior campaign(s) in this domain`);
    }
    if (context.sensitivityPatterns.length > 0) {
      parts.push(`${context.sensitivityPatterns.length} known sensitivity pattern(s)`);
      const top = context.sensitivityPatterns[0];
      parts.push(`Most sensitive: "${top.assumption}" (sensitivity: ${top.sensitivity})`);
    }
    if (context.effectiveSkills.length > 0) {
      const topSkill = context.effectiveSkills[0];
      parts.push(`Best skill: ${topSkill.skillId} (${topSkill.successes}/${topSkill.uses} success)`);
    }
    context.summary = parts.join('. ') || 'No prior campaign data available.';

    return context;
  }

  // ── Private helpers ────────────────────────────────────────────────────

  _findRelatedCampaigns(domain, topic) {
    const domainLower = (domain || '').toLowerCase();
    const topicLower = (topic || '').toLowerCase();

    return this.campaigns.filter(c => {
      if (domainLower && c.domain && c.domain.toLowerCase().includes(domainLower)) return true;
      if (topicLower && c.topic && c.topic.toLowerCase().includes(topicLower)) return true;
      return false;
    }).slice(-10); // Most recent 10
  }

  _mergePatterns() {
    const grouped = new Map();
    for (const p of this.patterns) {
      const key = `${p.domain || ''}:${p.assumption}`;
      if (grouped.has(key)) {
        const existing = grouped.get(key);
        existing.occurrences = (existing.occurrences || 1) + 1;
        existing.sensitivity = Math.max(existing.sensitivity || 0, p.sensitivity || 0);
      } else {
        grouped.set(key, { ...p });
      }
    }
    this.patterns = Array.from(grouped.values());
  }

  _ensureDir() {
    try {
      if (!fs.existsSync(this.baseDir)) {
        fs.mkdirSync(this.baseDir, { recursive: true });
      }
    } catch (err) {
      this.logger.warn('[CampaignMemory] Failed to create directory:', err.message);
    }
  }

  _readJson(filename, fallback) {
    try {
      const filePath = path.join(this.baseDir, filename);
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      }
    } catch (err) {
      this.logger.warn(`[CampaignMemory] Failed to read ${filename}:`, err.message);
    }
    return fallback;
  }

  _writeJson(filename, data) {
    try {
      const filePath = path.join(this.baseDir, filename);
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      this.logger.warn(`[CampaignMemory] Failed to write ${filename}:`, err.message);
    }
  }
}

module.exports = { CampaignMemory };
