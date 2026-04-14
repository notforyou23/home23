'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const OpenAI = require('openai');
let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

// Providers that use the Anthropic messages API (not OpenAI chat/completions)
const ANTHROPIC_COMPAT_PROVIDERS = new Set(['minimax', 'anthropic']);

const DEFAULT_INDEX_SECTIONS = [
  'Decisions',
  'Technical',
  'Infrastructure',
  'Research',
  'Architecture',
  'Open Questions',
  'General',
  'Design'
];

const COMPILE_PROMPT = `You are a knowledge compiler. You read documents and extract what matters.

Here is what the brain already knows (the index):
---
{INDEX}
---

Here is a new document ({FILENAME}, {FORMAT}):
---
{CONTENT}
---

Produce a structured synthesis:
1. What is this document? (one line)
2. Key findings, decisions, claims, or entities (bulleted)
3. What's new — not already in the index
4. What contradicts or updates existing knowledge
5. What connections exist to topics already in the index
6. Index update — new entries to add, formatted EXACTLY as: "- [DATE] Category: one-line summary"
   Use existing categories from the index when applicable (Decisions, Technical, Research, etc.).
   Only add entries for genuinely new knowledge. If the document adds nothing new, say "No new entries."
   Do not wrap the entries in code fences, inline backticks, or extra commentary.

Be concise. Extract meaning, not text. What would a sharp person remember after reading this?`;

class DocumentCompiler {
  constructor({ workspacePath, config = {}, logger = null }) {
    this.workspacePath = workspacePath;
    this.config = config;
    this.logger = logger;
    this.indexPath = path.join(workspacePath, 'BRAIN_INDEX.md');

    this.model = config.model || 'minimax-m2.7';
    this.clientType = null; // 'anthropic' or 'openai'
    this.client = null;
    this._buildClient(this.model);
  }

  /**
   * Build the appropriate SDK client for a given model.
   * Anthropic-compatible providers (minimax, anthropic) use the Anthropic SDK.
   * Everything else uses the OpenAI SDK.
   */
  _buildClient(model) {
    let baseURL = this.config.baseURL || process.env.COMPILER_LLM_BASE_URL;
    let apiKey = this.config.apiKey || process.env.COMPILER_LLM_API_KEY;
    let providerName = null;

    if (!baseURL) {
      const resolved = this._resolveProviderForModel(model);
      if (resolved) {
        baseURL = resolved.baseUrl;
        apiKey = apiKey || resolved.apiKey;
        providerName = resolved.providerName;
      }
    }

    const isAnthropicCompat = providerName && ANTHROPIC_COMPAT_PROVIDERS.has(providerName);

    if (isAnthropicCompat && Anthropic) {
      apiKey = apiKey || process.env.MINIMAX_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
      this.client = new Anthropic({ apiKey, baseURL });
      this.clientType = 'anthropic';
    } else {
      baseURL = baseURL || 'https://ollama.com/v1';
      apiKey = apiKey || process.env.OLLAMA_CLOUD_API_KEY || 'ollama';
      this.client = new OpenAI({ apiKey, baseURL });
      this.clientType = 'openai';
    }

    this.logger?.info?.('Compiler client initialized', {
      model, clientType: this.clientType, baseURL, providerName: providerName || 'fallback'
    });
  }

  /**
   * Hot-update the compiler model at runtime (called by feeder admin endpoint).
   * Re-resolves provider and rebuilds the correct SDK client.
   */
  updateModel(newModel) {
    if (!newModel || newModel === this.model) return;
    const oldModel = this.model;
    this.model = newModel;
    this._buildClient(newModel);
    this.logger?.info?.('Compiler model updated', { oldModel, newModel, clientType: this.clientType });
  }

  _resolveProviderForModel(model) {
    const envKeyMap = {
      'ollama-cloud': 'OLLAMA_CLOUD_API_KEY',
      'anthropic': 'ANTHROPIC_AUTH_TOKEN',
      'openai': 'OPENAI_API_KEY',
      'openai-codex': 'OPENAI_API_KEY',
      'xai': 'XAI_API_KEY',
      'minimax': 'MINIMAX_API_KEY',
    };
    try {
      const engineDir = path.resolve(__dirname, '..', '..');
      const homePath = path.join(engineDir, '..', 'config', 'home.yaml');
      if (!fs.existsSync(homePath)) return null;
      const home = yaml.load(fs.readFileSync(homePath, 'utf8')) || {};
      for (const [name, prov] of Object.entries(home.providers || {})) {
        if ((prov.defaultModels || []).includes(model)) {
          return {
            providerName: name,
            baseUrl: prov.baseUrl || prov.baseURL,
            apiKey: process.env[envKeyMap[name] || ''] || undefined,
          };
        }
      }
    } catch { /* best-effort */ }
    return null;
  }

  async compile(text, metadata = {}) {
    const filename = metadata.filePath ? path.basename(metadata.filePath) : 'unknown';
    const format = metadata.format || 'text';

    if (filename === 'BRAIN_INDEX.md') {
      this.logger?.debug?.('Skipping compiler for BRAIN_INDEX.md');
      return null;
    }

    try {
      const index = this._readIndex();

      const prompt = COMPILE_PROMPT
        .replace('{INDEX}', index || '(empty — this is the first document)')
        .replace('{FILENAME}', filename)
        .replace('{FORMAT}', format)
        .replace('{CONTENT}', text);

      let synthesis;
      if (this.clientType === 'anthropic') {
        const response = await this.client.messages.create({
          model: this.model,
          max_tokens: 4096,
          messages: [{ role: 'user', content: prompt }],
        });
        // MiniMax/Claude can return multiple content blocks — find the text block.
        // Reasoning models return a "thinking" block first, then a "text" block.
        const textBlock = (response.content || []).find(b => b.type === 'text');
        synthesis = textBlock?.text || '';
      } else {
        const response = await this.client.chat.completions.create({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 4096,
          temperature: 0.1,
        });
        synthesis = response.choices?.[0]?.message?.content || '';
      }
      if (!synthesis || synthesis.trim().length === 0) {
        this.logger?.warn?.('Compiler returned empty synthesis', { filename });
        return null;
      }

      const indexUpdate = this._extractIndexUpdates(synthesis);

      if (indexUpdate.length > 0) {
        this._updateIndex(indexUpdate, filename);
      }

      this.logger?.info?.('Document compiled', {
        filename,
        synthesisLength: synthesis.length,
        indexUpdated: !!indexUpdate
      });

      return { synthesis, indexUpdate };
    } catch (error) {
      this.logger?.error?.('Compilation failed', {
        filename,
        error: error.message
      });
      return null;
    }
  }

  _readIndex() {
    try {
      if (fs.existsSync(this.indexPath)) {
        return fs.readFileSync(this.indexPath, 'utf8');
      }
    } catch {
      // Missing or unreadable
    }
    return '';
  }

  _extractIndexUpdates(synthesis) {
    const markers = [
      /(?:^|\n)\s*(?:\*\*)?6[.)]?\s*(?:\*\*)?\s*Index update[^\n]*\n([\s\S]*?)(?=\n\s*(?:\*\*)?\d+[.)]|\s*$)/i,
      /(?:^|\n)\s*(?:\*\*)?Index update[^\n]*\n([\s\S]*?)$/i,
      /(?:^|\n)\s*(?:\*\*)?New entries[^\n]*\n([\s\S]*?)$/i,
    ];

    for (const regex of markers) {
      const match = synthesis.match(regex);
      if (match && match[1] && match[1].trim()) {
        return this._normalizeIndexEntries(match[1]);
      }
    }
    return [];
  }

  _normalizeIndexEntries(rawEntries) {
    const lines = rawEntries.split('\n');
    const normalized = [];

    for (const rawLine of lines) {
      let line = rawLine.trim();
      if (!line) continue;

      line = line
        .replace(/^[-*+]\s+/, '')
        .replace(/^\d+[.)]\s+/, '')
        .replace(/^`+/, '')
        .replace(/`+$/, '')
        .replace(/^\*\*+/, '')
        .replace(/\*\*+$/, '')
        .trim();

      if (!line) continue;
      if (/^no new entries?\.?$/i.test(line) || /^none\.?$/i.test(line)) continue;

      const match = line.match(/^\[([^\]]+)\]\s*([^:]+):\s*(.+)$/);
      if (!match) continue;

      const date = match[1].trim();
      const category = match[2].trim().replace(/\s+/g, ' ');
      const summary = match[3].trim().replace(/\s+/g, ' ');
      if (!date || !category || !summary) continue;

      normalized.push(`- [${date}] ${category}: ${summary}`);
    }

    return normalized;
  }

  _parseIndex(index) {
    const sections = [];
    const entries = new Map();
    let currentSection = null;

    for (const section of DEFAULT_INDEX_SECTIONS) {
      sections.push(section);
      entries.set(section, []);
    }

    const countMatch = index.match(/Documents compiled: (\d+)/);
    const parsed = {
      count: countMatch ? parseInt(countMatch[1], 10) : 0,
      sections,
      entries
    };

    for (const line of index.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('## ')) {
        currentSection = trimmed.slice(3).trim();
        if (!parsed.entries.has(currentSection)) {
          parsed.sections.push(currentSection);
          parsed.entries.set(currentSection, []);
        }
        continue;
      }

      if (trimmed.startsWith('- ') && currentSection) {
        parsed.entries.get(currentSection).push(trimmed);
      }
    }

    return parsed;
  }

  _renderIndex(parsed, now) {
    const lines = [
      '# Brain Index',
      '',
      `Last updated: ${now}`,
      `Documents compiled: ${parsed.count}`,
      ''
    ];

    for (const section of parsed.sections) {
      lines.push(`## ${section}`);
      const sectionEntries = parsed.entries.get(section) || [];
      lines.push(...sectionEntries);
      lines.push('');
    }

    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  }

  _trimIndexIfNeeded(parsed, now) {
    let rendered = this._renderIndex(parsed, now);
    if (rendered.split('\n').length <= 200) return rendered;

    for (const section of parsed.sections) {
      const sectionEntries = parsed.entries.get(section) || [];
      if (sectionEntries.length > 20) {
        parsed.entries.set(section, sectionEntries.slice(-20));
      }
    }

    return this._renderIndex(parsed, now);
  }

  _updateIndex(newEntries, source) {
    try {
      const now = new Date().toISOString().slice(0, 19) + 'Z';
      let index = this._readIndex();

      if (!index) {
        index = this._renderIndex({
          count: 0,
          sections: [...DEFAULT_INDEX_SECTIONS],
          entries: new Map(DEFAULT_INDEX_SECTIONS.map(section => [section, []]))
        }, now);
      }

      const parsed = this._parseIndex(index);
      parsed.count += 1;

      for (const line of newEntries) {
        const catMatch = line.match(/^- \[[^\]]+\]\s*([^:]+):/);
        const category = catMatch ? catMatch[1].trim() : 'General';

        if (!parsed.entries.has(category)) {
          parsed.sections.push(category);
          parsed.entries.set(category, []);
        }

        const sectionEntries = parsed.entries.get(category);
        if (!sectionEntries.includes(line)) {
          sectionEntries.push(line);
        }
      }

      index = this._trimIndexIfNeeded(parsed, now);

      fs.writeFileSync(this.indexPath, index);
      this.logger?.debug?.('Brain index updated', { source, linesAdded: newEntries.length });
    } catch (error) {
      this.logger?.error?.('Failed to update brain index', { error: error.message });
    }
  }
}

module.exports = { DocumentCompiler };
