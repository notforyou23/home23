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

Important:
- Infer current obsessions from salience-weighted representative nodes first, not from raw index volume.
- Treat the knowledge index as a map of compiled material, not proof that a topic is currently salient.
- Do not list finance, trading, portfolio, cron output, or telemetry as a current obsession unless recent high-salience conversation, identity, or state nodes support it.
- If a topic is supported only by old index volume or low-salience machine chatter, call it historical context instead of a current obsession.

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

function extractJsonObject(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('empty synthesis response');

  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(text);
  const candidates = [];
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  candidates.push(text);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch { /* try extracting balanced object below */ }

    const start = candidate.indexOf('{');
    if (start === -1) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < candidate.length; i += 1) {
      const ch = candidate[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          return JSON.parse(candidate.slice(start, i + 1));
        }
      }
    }
  }

  throw new Error('no complete JSON object found in synthesis response');
}

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
  startSchedule({ runOnStart = true } = {}) {
    const intervalMs = this.intervalHours * 60 * 60 * 1000;
    this.logger?.info?.(`[synthesis] Scheduled every ${this.intervalHours}h`);

    if (runOnStart) {
      // Run once on start (after a short delay to let brain load)
      setTimeout(() => this.run('startup'), 30_000);
    }

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
      const indexDigest = this._buildIndexDigest(index);

      // 3. Get brain stats from API
      const stats = await this._fetchBrainStats();

      // 4. Search brain for representative nodes across key themes
      const nodes = await this._searchBrainThemes(index);

      // 5. Build prompt and call LLM
      const prompt = SYNTHESIS_PROMPT
        .replace('{IDENTITY}', identity || '(no identity files found)')
        .replace('{INDEX}', indexDigest || '(no compiled documents yet)')
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
        synthesis = extractJsonObject(raw);
      } catch (parseErr) {
        this.logger?.error?.('[synthesis] Failed to parse LLM response as JSON', {
          error: parseErr.message,
          raw: raw.slice(0, 200),
        });
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
      const nodeCount = Number.isFinite(data.memory?.nodes)
        ? data.memory.nodes
        : data.memory?.nodes
          ? (Array.isArray(data.memory.nodes) ? data.memory.nodes.length : Object.keys(data.memory.nodes).length)
          : 0;
      const edgeCount = Number.isFinite(data.memory?.edges)
        ? data.memory.edges
        : data.memory?.edges
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
    const themes = this._collectSearchThemes(index);

    // Fallback themes if index is empty
    if (themes.length === 0) {
      themes.push('main topics', 'recent decisions', 'key findings');
    }

    // Search for top 3 nodes per theme (limit total to keep prompt manageable)
    const results = [];
    const maxThemes = 8;
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
            results.push(`### ${theme}\n${data.results.map(r => {
              const sourceClass = r.sourceClass || 'unknown';
              const retrievalScore = r.retrievalScore ?? r.similarity;
              return `- [${r.id}] (${sourceClass}, score ${retrievalScore}, sim ${r.similarity}) ${(r.concept || '').slice(0, 300)}`;
            }).join('\n')}`);
          }
        }
      } catch { /* skip failed searches */ }
    }

    return results.join('\n\n') || '';
  }

  _collectSearchThemes(index) {
    const themes = [
      'direct user conversation jtr current request',
      'Home23 Good Life agency current direction',
      'brain cleanup memory retrieval consolidation salience',
      'recent state snapshot current correction',
    ];
    const seen = new Set(themes.map(t => t.toLowerCase()));

    if (index) {
      const headings = index.match(/^## .+/gm) || [];
      for (const h of headings) {
        const theme = h
          .replace(/^##\s+/, '')
          .replace(/[`*_]/g, '')
          .replace(/Compiled from:.*/, '')
          .trim();
        const key = theme.toLowerCase();
        if (theme && theme.length > 2 && !theme.startsWith('Compiled') && !seen.has(key)) {
          themes.push(theme);
          seen.add(key);
        }
      }
    }

    return themes;
  }

  _buildIndexDigest(index) {
    if (!index) return '';
    const lines = index.split(/\r?\n/);
    const header = lines.filter(line =>
      /documents compiled:/i.test(line) ||
      /last updated:/i.test(line) ||
      /^#\s+/.test(line)
    ).slice(0, 12);
    const headingCounts = new Map();
    for (const line of lines) {
      if (!line.startsWith('## ')) continue;
      const heading = line
        .replace(/^##\s+/, '')
        .replace(/[`*_]/g, '')
        .replace(/Compiled from:.*/, '')
        .trim();
      if (!heading || heading.startsWith('Compiled')) continue;
      headingCounts.set(heading, (headingCounts.get(heading) || 0) + 1);
    }
    const headings = Array.from(headingCounts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 40)
      .map(([heading, count]) => `- ${heading} (${count} index sections)`);
    return [
      ...header,
      '',
      'Index section counts only. Counts are not salience and are not current obsession evidence:',
      ...headings,
    ].join('\n').trim();
  }

  _countCompiledDocs(index) {
    if (!index) return 0;
    const match = index.match(/Documents compiled: (\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  }
}

module.exports = { SynthesisAgent, extractJsonObject };
