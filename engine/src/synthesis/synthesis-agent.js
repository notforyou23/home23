'use strict';

const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

const SYNTHESIS_PROMPT = `You are a brain synthesis agent. You analyze a brain's contents and produce a structured overview of what it knows.

Brain identity:
---
{IDENTITY}
---

Brain knowledge index (compiled documents):
---
{INDEX}
---

Representative brain nodes from semantic search:
---
{NODES}
---

Brain stats: {STATS}

Produce a JSON object (and ONLY the JSON, no markdown fences):
{
  "selfUnderstanding": {
    "summary": "(2-3 sentences: what this brain is, what it knows, what it does)",
    "currentObsessions": ["(top 3-5 themes the brain is focused on)"],
    "relationship": "(one sentence: how this brain relates to its user)"
  },
  "consolidatedInsights": [
    {
      "title": "(short title)",
      "excerpt": "(2-3 sentence insight grounded in actual brain content)",
      "source": "(which topic/category this came from)",
      "themes": ["(relevant tags)"]
    }
  ],
  "recentActivity": ["(what has happened recently based on index timestamps and node content)"]
}

Produce exactly 5 consolidated insights (or fewer if the brain is sparse).
Be grounded in actual content. Do not invent. If the brain is sparse, say so honestly.`;

class SynthesisAgent {
  /**
   * @param {object} opts
   * @param {string} opts.brainDir - Path to agent's brain directory (where brain-state.json is written)
   * @param {string} opts.workspacePath - Path to agent's workspace (where BRAIN_INDEX.md and identity files live)
   * @param {number} opts.dashboardPort - Dashboard API port for brain queries
   * @param {object} opts.config - { model, baseURL, apiKey, intervalHours }
   * @param {object} opts.logger
   */
  constructor({ brainDir, workspacePath, dashboardPort, config = {}, logger = null }) {
    this.brainDir = brainDir;
    this.workspacePath = workspacePath;
    this.dashboardPort = dashboardPort;
    this.config = config;
    this.logger = logger;
    this.statePath = path.join(brainDir, 'brain-state.json');
    this.running = false;

    const baseURL = config.baseURL || process.env.COMPILER_LLM_BASE_URL || 'https://ollama.com/v1';
    const apiKey = config.apiKey || process.env.COMPILER_LLM_API_KEY || process.env.OLLAMA_CLOUD_API_KEY || 'ollama';

    this.client = new OpenAI({ apiKey, baseURL });
    this.model = config.model || 'minimax-m2.7';
    this.intervalHours = config.intervalHours || 4;
    this._timer = null;
  }

  /**
   * Start scheduled synthesis runs.
   */
  startSchedule() {
    const intervalMs = this.intervalHours * 60 * 60 * 1000;
    this.logger?.info?.(`[synthesis] Scheduled every ${this.intervalHours}h`);

    // Run once on start (after a short delay to let brain load)
    setTimeout(() => this.run('startup'), 30_000);

    // Then on interval
    this._timer = setInterval(() => this.run('scheduled'), intervalMs);
  }

  /**
   * Stop the schedule.
   */
  stopSchedule() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Run a synthesis pass.
   * @param {string} trigger - 'startup' | 'scheduled' | 'manual'
   * @returns {Promise<object|null>} The brain state or null on failure
   */
  async run(trigger = 'manual') {
    if (this.running) {
      this.logger?.warn?.('[synthesis] Already running, skipping');
      return null;
    }

    this.running = true;
    const startTime = Date.now();
    this.logger?.info?.(`[synthesis] Starting (trigger: ${trigger})`);

    try {
      // 1. Read identity files
      const identity = this._readIdentity();

      // 2. Read BRAIN_INDEX.md
      const index = this._readFile(path.join(this.workspacePath, 'BRAIN_INDEX.md'));

      // 3. Get brain stats from API
      const stats = await this._fetchBrainStats();

      // 4. Search brain for representative nodes across key themes
      const nodes = await this._searchBrainThemes(index);

      // 5. Build prompt and call LLM
      const prompt = SYNTHESIS_PROMPT
        .replace('{IDENTITY}', identity || '(no identity files found)')
        .replace('{INDEX}', index || '(no compiled documents yet)')
        .replace('{NODES}', nodes || '(no search results)')
        .replace('{STATS}', stats ? `${stats.nodes || 0} nodes, ${stats.edges || 0} edges, ${stats.cycles || 0} cycles` : 'unknown');

      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 4096,
        temperature: 0.1,
      });

      const raw = response.choices?.[0]?.message?.content || '';

      // 6. Parse JSON from response
      let synthesis;
      try {
        // Strip markdown fences if the model wrapped the JSON
        const cleaned = raw.replace(/^```json?\s*/m, '').replace(/```\s*$/m, '').trim();
        synthesis = JSON.parse(cleaned);
      } catch (parseErr) {
        this.logger?.error?.('[synthesis] Failed to parse LLM response as JSON', { raw: raw.slice(0, 200) });
        return null;
      }

      // 7. Build brain-state.json
      const brainState = {
        generatedAt: new Date().toISOString(),
        trigger,
        model: this.model,
        durationMs: Date.now() - startTime,
        brainStats: {
          nodes: stats?.nodes || 0,
          edges: stats?.edges || 0,
          cycles: stats?.cycles || 0,
          documentsCompiled: this._countCompiledDocs(index),
        },
        selfUnderstanding: synthesis.selfUnderstanding || { summary: 'Synthesis produced no self-understanding.', currentObsessions: [], relationship: '' },
        consolidatedInsights: synthesis.consolidatedInsights || [],
        knowledgeIndex: index || '',
        recentActivity: synthesis.recentActivity || [],
      };

      // 8. Write brain-state.json
      fs.writeFileSync(this.statePath, JSON.stringify(brainState, null, 2));
      this.logger?.info?.(`[synthesis] Complete (${Date.now() - startTime}ms, ${brainState.consolidatedInsights.length} insights)`);

      return brainState;
    } catch (error) {
      this.logger?.error?.('[synthesis] Failed', { error: error.message });
      return null;
    } finally {
      this.running = false;
    }
  }

  /**
   * Read current brain-state.json if it exists.
   */
  getState() {
    try {
      if (fs.existsSync(this.statePath)) {
        return JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      }
    } catch { /* missing or corrupt */ }
    return null;
  }

  // ── Private helpers ──

  _readFile(filePath) {
    try {
      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, 'utf8');
      }
    } catch { /* missing */ }
    return '';
  }

  _readIdentity() {
    const files = ['SOUL.md', 'MISSION.md'];
    const parts = [];
    for (const f of files) {
      const content = this._readFile(path.join(this.workspacePath, f));
      if (content) parts.push(content);
    }
    return parts.join('\n\n---\n\n');
  }

  async _fetchBrainStats() {
    try {
      const res = await fetch(`http://localhost:${this.dashboardPort}/api/state`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const nodeCount = data.memory?.nodes
        ? (Array.isArray(data.memory.nodes) ? data.memory.nodes.length : Object.keys(data.memory.nodes).length)
        : 0;
      const edgeCount = data.memory?.edges
        ? (Array.isArray(data.memory.edges) ? data.memory.edges.length : Object.keys(data.memory.edges).length)
        : 0;
      return {
        nodes: nodeCount,
        edges: edgeCount,
        cycles: data.cycleCount || 0,
      };
    } catch {
      return null;
    }
  }

  async _searchBrainThemes(index) {
    // Extract category names from the index to use as search themes
    const themes = [];
    if (index) {
      const headings = index.match(/^## .+/gm) || [];
      for (const h of headings) {
        const theme = h.replace(/^## /, '').replace(/Compiled from:.*/, '').trim();
        if (theme && theme.length > 2 && !theme.startsWith('Compiled')) {
          themes.push(theme);
        }
      }
    }

    // Fallback themes if index is empty
    if (themes.length === 0) {
      themes.push('main topics', 'recent decisions', 'key findings');
    }

    // Search for top 3 nodes per theme (limit total to keep prompt manageable)
    const results = [];
    const maxThemes = 5;
    for (const theme of themes.slice(0, maxThemes)) {
      try {
        const res = await fetch(`http://localhost:${this.dashboardPort}/api/memory/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: theme, topK: 3, minSimilarity: 0.3 }),
          signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) {
          const data = await res.json();
          if (data.results && data.results.length > 0) {
            results.push(`### ${theme}\n${data.results.map(r => `- [${r.id}] (sim ${r.similarity}) ${(r.concept || '').slice(0, 300)}`).join('\n')}`);
          }
        }
      } catch { /* skip failed searches */ }
    }

    return results.join('\n\n') || '';
  }

  _countCompiledDocs(index) {
    if (!index) return 0;
    const match = index.match(/Documents compiled: (\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  }
}

module.exports = { SynthesisAgent };
