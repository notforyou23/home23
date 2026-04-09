#!/usr/bin/env node

/**
 * COSMO Brain Studio v2
 * 
 * IDE-style interface for exploring and interacting with .brain packages.
 * Inspired by the COSMO IDE - 3-column layout with directory browser,
 * content viewer, and AI chat with real GPT synthesis.
 * 
 * Usage:
 *   node scripts/brain-studio-v2.js <brain-path>
 */

const http = require('http');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const OpenAI = require('openai');

// USE EXISTING COSMO CODE - DON'T REMAKE
const { QueryEngine } = require('../src/dashboard/query-engine');
const { GPT5Client } = require('../src/core/gpt5-client');

const BrainSemanticSearch = require('./brain-semantic-search');
const BrainCoordinatorIndexer = require('./brain-coordinator-indexer');
const BrainConversationManager = require('./brain-conversation-manager');
const BrainExporter = require('./brain-exporter');

const gunzip = promisify(zlib.gunzip);

const PORT = process.env.PORT || 3399;

// API Keys from environment (fallbacks)
const ENV_OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const ENV_ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const ENV_XAI_KEY = process.env.XAI_API_KEY || '';

// Model configurations
const MODEL_CONFIGS = {
  // GPT-5 (Intelligence Dashboard models)
  'gpt-5.1': { provider: 'openai', name: 'GPT-5.1', description: 'Default - Fast with 24h Caching' },
  'gpt-5': { provider: 'openai', name: 'GPT-5', description: 'Maximum Reasoning Depth' },
  'gpt-5-mini': { provider: 'openai', name: 'GPT-5 Mini', description: 'Ultra Fast & Economical' },
  'gpt-5.2': { provider: 'openai', name: 'GPT-5.2', description: 'Latest Responses API' },
};

// ============================================================================
// Brain Loader
// ============================================================================

class BrainLoader {
  constructor(brainPath) {
    this.brainPath = path.resolve(brainPath);
    this.manifest = null;
    this.state = null;
    this.outputTree = null;
  }

  async load() {
    const manifestPath = path.join(this.brainPath, 'manifest.json');
    const statePath = path.join(this.brainPath, 'state.json.gz');

    if (fsSync.existsSync(manifestPath)) {
      this.manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    }

    if (!fsSync.existsSync(statePath)) {
      throw new Error('No state.json.gz found');
    }

    const compressed = await fs.readFile(statePath);
    const decompressed = await gunzip(compressed);
    this.state = JSON.parse(decompressed.toString());

    if (!this.manifest) {
      const metaPath = path.join(this.brainPath, 'run-metadata.json');
      let meta = {};
      if (fsSync.existsSync(metaPath)) {
        meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
      }

      this.manifest = {
        brain: {
          name: path.basename(this.brainPath),
          displayName: meta.domain || path.basename(this.brainPath),
          description: meta.context || '',
        },
        cosmo: {
          cycles: this.state.cycleCount || 0,
          mode: meta.explorationMode || 'unknown',
        },
      };
    }

    // Build output directory tree
    await this.buildOutputTree();

    return this;
  }

  async buildOutputTree() {
    const outputsPath = path.join(this.brainPath, 'outputs');
    if (!fsSync.existsSync(outputsPath)) {
      this.outputTree = { name: 'outputs', isDirectory: true, children: [] };
      return;
    }

    const buildTree = async (dirPath, name) => {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      const children = [];

      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;

        const fullPath = path.join(dirPath, entry.name);
        const relativePath = path.relative(this.brainPath, fullPath);

        if (entry.isDirectory()) {
          const subtree = await buildTree(fullPath, entry.name);
          children.push(subtree);
        } else {
          const stat = await fs.stat(fullPath);
          children.push({
            name: entry.name,
            path: relativePath,
            isDirectory: false,
            size: stat.size,
            type: this.getFileType(entry.name),
          });
        }
      }

      // Sort: directories first, then alphabetically
      children.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
      });

      return { name, isDirectory: true, children, path: path.relative(this.brainPath, dirPath) };
    };

    this.outputTree = await buildTree(outputsPath, 'outputs');
  }

  getFileType(filename) {
    const ext = path.extname(filename).toLowerCase();
    const types = {
      '.md': 'markdown', '.txt': 'text', '.json': 'json',
      '.py': 'python', '.js': 'javascript', '.html': 'html',
      '.css': 'css', '.csv': 'data', '.bib': 'bibliography',
      '.pdf': 'pdf', '.png': 'image', '.jpg': 'image',
    };
    return types[ext] || 'other';
  }

  getManifest() { return this.manifest; }
  getOutputTree() { return this.outputTree; }

  getStats() {
    const nodes = this.state.memory?.nodes || [];
    const edges = this.state.memory?.edges || [];
    const goals = this.state.goals || {};
    return {
      nodes: nodes.length,
      edges: edges.length,
      activeGoals: goals.active?.length || 0,
      completedGoals: goals.completed?.length || 0,
      cycles: this.state.cycleCount || 0,
      journal: this.state.journal?.length || 0,
    };
  }

  getNodes(options = {}) {
    const nodes = this.state.memory?.nodes || [];
    const { search, tag, limit = 100, offset = 0 } = options;
    let filtered = nodes;

    if (search) {
      const s = search.toLowerCase();
      filtered = filtered.filter(n => 
        n.concept?.toLowerCase().includes(s) || n.tag?.toLowerCase().includes(s)
      );
    }
    if (tag) filtered = filtered.filter(n => n.tag === tag);

    return {
      total: filtered.length,
      nodes: filtered.slice(offset, offset + limit).map(n => ({
        id: n.id, concept: n.concept, tag: n.tag,
        weight: n.weight, activation: n.activation, cluster: n.cluster,
      })),
    };
  }

  getNode(nodeId) {
    const node = this.state.memory?.nodes?.find(n => String(n.id) === String(nodeId));
    if (!node) return null;
    const edges = this.state.memory?.edges || [];
    const connected = edges.filter(e => 
      String(e.source) === String(nodeId) || String(e.target) === String(nodeId)
    );
    return {
      ...node,
      connections: connected.map(e => ({
        nodeId: String(e.source) === String(nodeId) ? e.target : e.source,
        weight: e.weight, type: e.type,
      })),
    };
  }

  getTags() {
    const nodes = this.state.memory?.nodes || [];
    const tags = new Map();
    for (const node of nodes) {
      const tag = node.tag || 'unknown';
      tags.set(tag, (tags.get(tag) || 0) + 1);
    }
    return Array.from(tags.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count);
  }

  getGraphData(maxNodes = 150) {
    const nodes = this.state.memory?.nodes || [];
    const edges = this.state.memory?.edges || [];
    const sorted = [...nodes].sort((a, b) => (b.activation || 0) - (a.activation || 0)).slice(0, maxNodes);
    const ids = new Set(sorted.map(n => String(n.id)));
    const visibleEdges = edges.filter(e => ids.has(String(e.source)) && ids.has(String(e.target)));
    return {
      nodes: sorted.map(n => ({
        id: String(n.id), label: n.concept?.slice(0, 50) || `Node ${n.id}`,
        tag: n.tag, weight: n.weight || 1, activation: n.activation || 0,
      })),
      edges: visibleEdges.map(e => ({ source: String(e.source), target: String(e.target), weight: e.weight || 1 })),
    };
  }

  searchRelevant(query, limit = 10) {
    const nodes = this.state.memory?.nodes || [];
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);

    const scored = nodes.map(node => {
      const concept = (node.concept || '').toLowerCase();
      let score = 0;
      if (concept.includes(queryLower)) score += 10;
      for (const word of queryWords) if (concept.includes(word)) score += 2;
      score *= (1 + (node.activation || 0));
      return { node, score };
    });

    return scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map(s => s.node);
  }

  /**
   * Initialize semantic search
   * Called lazily when first semantic search is requested
   */
  initializeSemanticSearch(openaiClient) {
    if (!this.semanticSearch) {
      this.semanticSearch = new BrainSemanticSearch(this, openaiClient);
    }
    return this.semanticSearch;
  }

  /**
   * Initialize coordinator indexer
   * Called lazily when first coordinator search is requested
   */
  initializeCoordinatorIndexer(openaiClient) {
    if (!this.coordinatorIndexer) {
      this.coordinatorIndexer = new BrainCoordinatorIndexer(this.brainPath, openaiClient);
    }
    return this.coordinatorIndexer;
  }

  async getFileContent(relativePath) {
    const fullPath = path.join(this.brainPath, relativePath);
    if (!fsSync.existsSync(fullPath)) return null;
    return await fs.readFile(fullPath, 'utf8');
  }

  getJournal(limit = 50) {
    return (this.state.journal || this.state.thoughtHistory || []).slice(-limit).reverse();
  }

  /**
   * Load and search thought stream (thoughts.jsonl)
   * Provides temporal query capability
   */
  async loadThoughts() {
    const thoughtsPath = path.join(this.brainPath, 'thoughts.jsonl');
    if (!fsSync.existsSync(thoughtsPath)) {
      return [];
    }

    const content = await fs.readFile(thoughtsPath, 'utf8');
    const lines = content.trim().split('\n').filter(l => l.trim());
    return lines.map(line => {
      try {
        return JSON.parse(line);
      } catch (e) {
        return null;
      }
    }).filter(t => t !== null);
  }

  /**
   * Search thoughts by keyword or role
   */
  async searchThoughts(query, options = {}) {
    const { role, limit = 20 } = options;
    const thoughts = await this.loadThoughts();
    
    const queryLower = query.toLowerCase();
    let filtered = thoughts;

    // Filter by role if specified
    if (role) {
      filtered = filtered.filter(t => t.role === role);
    }

    // Search in thought content and reasoning
    if (query) {
      filtered = filtered.filter(t => {
        const thought = (t.thought || '').toLowerCase();
        const reasoning = (t.reasoning || '').toLowerCase();
        return thought.includes(queryLower) || reasoning.includes(queryLower);
      });
    }

    return {
      results: filtered.slice(0, limit),
      total: filtered.length,
      stats: {
        totalThoughts: thoughts.length,
        filtered: filtered.length
      }
    };
  }
}

// ============================================================================
// GPT Chat (Real Synthesis)
// ============================================================================

async function synthesizeAnswer(query, relevantNodes, keys, model = 'gpt-4o-mini', priorContext = null) {
  const modelConfig = MODEL_CONFIGS[model];
  if (!modelConfig) {
    return { answer: `❌ Unknown model: ${model}`, model: 'error' };
  }

  const provider = modelConfig.provider;
  const apiKey = keys[provider];

  if (!apiKey) {
    const providerName = provider === 'openai' ? 'OpenAI' : provider === 'anthropic' ? 'Anthropic' : 'xAI';
    return {
      answer: `⚙️ **No ${providerName} API key configured**\n\nClick the ⚙️ button to add your API key for ${modelConfig.name}.\n\n---\n\n**RAG Results** (keyword search only):\n\n` + 
        relevantNodes.slice(0, 5).map((n, i) => `${i+1}. **[Node ${n.id}]** (${n.tag || 'unknown'}): ${(n.concept || '').slice(0, 150)}...`).join('\n\n'),
      model: 'RAG only'
    };
  }

  // ENHANCED CONTEXT (matching query engine)
  // - Take more primary nodes (up to 30 instead of 8)
  // - Add connected concepts for richer context
  const primaryNodes = relevantNodes.slice(0, 30);
  
  let contextSections = [];
  
  // Add primary nodes
  contextSections.push('## Primary Knowledge Nodes\n');
  for (const node of primaryNodes) {
    contextSections.push(`[Node ${node.id}] (${node.tag || 'unknown'}${node.similarity ? `, relevance: ${(node.similarity * 100).toFixed(1)}%` : ''})\n${node.concept || 'No content'}`);
  }
  
  // Add connected concepts for top nodes (matching query engine's 100-node connected limit)
  const topNodeIds = primaryNodes.slice(0, 10).map(n => n.id);
  const connectedNodes = [];
  
  // This will be populated if we have access to the loader
  if (relevantNodes[0]?.connectionWeight !== undefined) {
    // Already have connected nodes from semantic search
    contextSections.push('\n\n## Connected Concepts\n');
    const connected = relevantNodes.filter(n => n.connectionWeight !== undefined).slice(0, 30);
    for (const node of connected) {
      contextSections.push(`[Node ${node.id}] (${node.tag || 'unknown'}, connection: ${(node.connectionWeight * 100).toFixed(0)}%)\n${(node.concept || '').slice(0, 200)}${node.concept?.length > 200 ? '...' : ''}`);
    }
  }
  
  const context = contextSections.join('\n\n---\n\n');

  let systemPrompt = `You are a helpful assistant that answers questions based on a knowledge base (brain).

You have access to relevant knowledge nodes from the brain's memory graph. The nodes are organized into:
- **Primary Knowledge Nodes**: Most relevant to the query (sorted by semantic similarity)
- **Connected Concepts**: Related knowledge connected via the brain's associative network

Use these nodes to provide accurate, well-structured answers.
- Always cite which nodes you're drawing from using [Node X] format
- Synthesize information across multiple nodes when relevant
- If the knowledge nodes don't contain relevant information, say so honestly
- Be concise but thorough. Use markdown formatting.

The brain has ${relevantNodes.length} relevant nodes available for this query.`;

  // Add prior context for follow-up queries (query engine pattern)
  if (priorContext && priorContext.query && priorContext.answer) {
    const followUpPrefix = `IMPORTANT: This is a FOLLOW-UP QUERY.\n\n` +
      `The user previously asked: "${priorContext.query}"\n` +
      `And received an answer (excerpt shown below).\n\n` +
      `Your response should:\n` +
      `- Build upon the prior conversation naturally\n` +
      `- Reference the previous answer when relevant\n` +
      `- Maintain continuity with the discussion\n\n` +
      `Previous answer excerpt: ${priorContext.answer.substring(0, 500)}${priorContext.answer.length > 500 ? '...' : ''}\n\n` +
      `---\n\n`;
    
    systemPrompt = followUpPrefix + systemPrompt;
  }

  const userPrompt = `Question: ${query}\n\n---\n\nKnowledge Base Context:\n\n${context}`;

  try {
    let result;
    if (provider === 'openai') {
      result = await callOpenAI(apiKey, model, systemPrompt, userPrompt);
    } else if (provider === 'anthropic') {
      result = await callAnthropic(apiKey, model, systemPrompt, userPrompt);
    } else if (provider === 'xai') {
      result = await callXAI(apiKey, model, systemPrompt, userPrompt);
    }

    // Add evidence analysis metadata (simplified from query engine)
    result.evidence = analyzeEvidence(relevantNodes);
    result.synthesis = {
      sourceCount: relevantNodes.length,
      uniqueTags: [...new Set(relevantNodes.map(n => n.tag))].length,
      avgRelevance: relevantNodes.length > 0 
        ? relevantNodes.reduce((sum, n) => sum + (n.similarity || 0.5), 0) / relevantNodes.length 
        : 0
    };

    return result;
  } catch (error) {
    return { answer: `❌ **Error**: ${error.message}`, model: 'error' };
  }
}

/**
 * Analyze evidence quality from source nodes
 * Simplified version of query engine's EvidenceAnalyzer
 */
function analyzeEvidence(nodes) {
  if (!nodes || nodes.length === 0) {
    return { quality: 'none', confidence: 0, coverage: 0 };
  }

  // Calculate evidence metrics
  const avgActivation = nodes.reduce((sum, n) => sum + (n.activation || 0), 0) / nodes.length;
  const avgWeight = nodes.reduce((sum, n) => sum + (n.weight || 1), 0) / nodes.length;
  const tagDiversity = new Set(nodes.map(n => n.tag)).size / Math.max(nodes.length, 1);

  // Determine quality
  let quality = 'low';
  let confidence = 0;

  if (avgActivation > 0.5 && avgWeight > 0.7) {
    quality = 'high';
    confidence = 0.8 + (tagDiversity * 0.2);
  } else if (avgActivation > 0.3 || avgWeight > 0.5) {
    quality = 'medium';
    confidence = 0.5 + (tagDiversity * 0.3);
  } else {
    quality = 'low';
    confidence = 0.2 + (tagDiversity * 0.3);
  }

  return {
    quality,
    confidence: Math.min(confidence, 1.0),
    coverage: Math.min(nodes.length / 20, 1.0), // 20+ nodes = full coverage
    metrics: {
      avgActivation: avgActivation.toFixed(3),
      avgWeight: avgWeight.toFixed(3),
      tagDiversity: tagDiversity.toFixed(3)
    }
  };
}

async function callOpenAI(apiKey, model, systemPrompt, userPrompt) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.7,
      max_tokens: 2000,
    })
  });

  const data = await response.json();
  
  if (data.error) {
    return { answer: `❌ **OpenAI Error**: ${data.error.message}`, model: 'error' };
  }

  return {
    answer: data.choices[0].message.content,
    model: model,
    usage: data.usage
  };
}

async function callAnthropic(apiKey, model, systemPrompt, userPrompt) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: model,
      max_tokens: 2000,
      system: systemPrompt,
      messages: [
        { role: 'user', content: userPrompt }
      ]
    })
  });

  const data = await response.json();
  
  if (data.error) {
    return { answer: `❌ **Anthropic Error**: ${data.error.message}`, model: 'error' };
  }

  const textContent = data.content?.find(c => c.type === 'text')?.text || '';
  return {
    answer: textContent,
    model: model,
    usage: { input_tokens: data.usage?.input_tokens, output_tokens: data.usage?.output_tokens }
  };
}

async function callXAI(apiKey, model, systemPrompt, userPrompt) {
  const response = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.7,
      max_tokens: 2000,
    })
  });

  const data = await response.json();
  
  if (data.error) {
    return { answer: `❌ **xAI Error**: ${data.error.message}`, model: 'error' };
  }

  return {
    answer: data.choices[0].message.content,
    model: model,
    usage: data.usage
  };
}

// ============================================================================
// HTML Template
// ============================================================================

function getHTML(brainName) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>🧠 ${brainName} - Brain Studio</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.8.5/d3.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

    :root {
      --bg-primary: #1e1e1e;
      --bg-secondary: #252526;
      --bg-tertiary: #2d2d2d;
      --bg-hover: #37373d;
      --text-primary: #cccccc;
      --text-secondary: #969696;
      --text-muted: #6a6a6a;
      --accent: #007acc;
      --accent-hover: #0098ff;
      --success: #4ec9b0;
      --error: #f48771;
      --warning: #dcdcaa;
      --border: #3e3e42;
      --font-main: 'Inter', -apple-system, sans-serif;
      --font-mono: 'JetBrains Mono', monospace;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: var(--font-main);
      background: var(--bg-primary);
      color: var(--text-primary);
      overflow: hidden;
    }

    /* Layout */
    .app {
      display: grid;
      grid-template-rows: 40px 1fr 24px;
      height: 100vh;
    }

    .header {
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      padding: 0 16px;
      gap: 24px;
    }

    .logo {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 600;
      font-size: 13px;
    }

    .logo-icon { font-size: 18px; }

    .tabs {
      display: flex;
      gap: 2px;
    }

    .tab {
      padding: 8px 16px;
      background: transparent;
      border: none;
      color: var(--text-secondary);
      font-family: inherit;
      font-size: 12px;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      transition: all 0.15s;
    }

    .tab:hover { color: var(--text-primary); }
    .tab.active { color: var(--accent); border-bottom-color: var(--accent); }

    .stats {
      display: flex;
      gap: 16px;
      margin-left: auto;
      font-size: 11px;
      color: var(--text-muted);
    }

    .stat { display: flex; gap: 4px; }
    .stat-value { color: var(--text-secondary); font-family: var(--font-mono); }

    /* Main Content */
    .main {
      overflow: hidden;
      height: 100%;
      position: relative;
    }

    .panel { 
      display: none; 
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
    }
    
    /* Query panel - full width, single column */
    #queryPanel.active {
      display: flex;
      flex-direction: column;
    }
    
    /* Files and Explore panels - 3-column grid */
    #filesPanel.active,
    #explorePanel.active {
      display: grid; 
      grid-template-columns: 250px 1fr 380px;
    }

    /* Sidebar */
    .sidebar {
      background: var(--bg-secondary);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .sidebar-header {
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--text-secondary);
      letter-spacing: 1px;
    }

    .search-box {
      padding: 8px;
      border-bottom: 1px solid var(--border);
    }

    .search-box input {
      width: 100%;
      padding: 6px 10px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      border-radius: 4px;
      color: var(--text-primary);
      font-size: 12px;
      font-family: inherit;
    }

    .search-box input:focus {
      outline: none;
      border-color: var(--accent);
    }

    /* File Tree */
    .file-tree {
      flex: 1;
      overflow-y: auto;
      padding: 8px 0;
    }

    .tree-item {
      padding: 4px 16px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      transition: background 0.1s;
    }

    .tree-item:hover { background: var(--bg-hover); }
    .tree-item.selected { background: var(--bg-hover); }

    .tree-icon { font-size: 14px; flex-shrink: 0; }
    .tree-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tree-size { font-size: 10px; color: var(--text-muted); }

    .tree-children { overflow: hidden; }
    .tree-children.collapsed { display: none; }

    /* Content Area */
    .content-area {
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: var(--bg-primary);
    }

    .content-tabs {
      display: flex;
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border);
      min-height: 35px;
    }

    .content-tab {
      padding: 8px 16px;
      background: var(--bg-tertiary);
      border-right: 1px solid var(--border);
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
    }

    .content-tab:hover { background: var(--bg-hover); }
    .content-tab.active { background: var(--bg-primary); border-bottom: 2px solid var(--accent); margin-bottom: -1px; }

    .content-tab-close {
      opacity: 0.5;
      font-size: 14px;
      cursor: pointer;
    }

    .content-tab-close:hover { opacity: 1; }

    .content-view {
      flex: 1;
      overflow: auto;
      padding: 24px;
    }

    .file-content {
      font-family: var(--font-mono);
      font-size: 13px;
      line-height: 1.6;
      white-space: pre-wrap;
    }

    .markdown-content {
      font-family: var(--font-main);
      line-height: 1.7;
    }

    .markdown-content h1, .markdown-content h2, .markdown-content h3 {
      margin: 24px 0 12px;
      font-weight: 600;
    }

    .markdown-content h1 { font-size: 1.8em; color: var(--accent); }
    .markdown-content h2 { font-size: 1.4em; }
    .markdown-content h3 { font-size: 1.2em; }
    .markdown-content p { margin: 12px 0; }
    .markdown-content code { background: var(--bg-tertiary); padding: 2px 6px; border-radius: 3px; font-family: var(--font-mono); }
    .markdown-content pre { background: var(--bg-tertiary); padding: 16px; border-radius: 6px; overflow-x: auto; margin: 16px 0; }
    .markdown-content pre code { background: none; padding: 0; }
    .markdown-content ul, .markdown-content ol { margin: 12px 0 12px 24px; }
    .markdown-content li { margin: 6px 0; }
    .markdown-content blockquote { border-left: 3px solid var(--accent); padding-left: 16px; color: var(--text-secondary); font-style: italic; }

    /* Right Panel */
    .right-panel {
      background: var(--bg-secondary);
      border-left: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
    }

    .panel-header {
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .panel-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--text-secondary);
      letter-spacing: 1px;
    }

    /* Chat - Enhanced UX matching COSMO IDE v2 */
    .chat-messages {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 20px;
      scroll-behavior: smooth;
    }

    .message {
      border-radius: 12px;
      font-size: 14px;
      line-height: 1.7;
      animation: fadeIn 0.3s ease-in;
      max-width: 100%;
      overflow: hidden;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .message.user {
      background: linear-gradient(135deg, #0e4d6d 0%, #0a3d57 100%);
      padding: 14px 18px;
      align-self: flex-start;
      max-width: 80%;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
      border: 1px solid rgba(255, 255, 255, 0.1);
    }

    .message.user .message-content {
      white-space: pre-wrap;
      word-wrap: break-word;
      overflow-wrap: break-word;
      color: #e8f4f8;
    }

    .message.assistant {
      background: var(--bg-tertiary);
      padding: 20px 24px;
      border: 1px solid var(--border);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
      max-width: 100%;
    }

    .message.assistant .message-content {
      font-family: var(--font-main);
      overflow-wrap: break-word;
      word-break: break-word;
      max-width: 100%;
    }

    /* Enhanced markdown rendering */
    .message.assistant .message-content h1,
    .message.assistant .message-content h2,
    .message.assistant .message-content h3,
    .message.assistant .message-content h4 {
      margin: 20px 0 12px;
      font-weight: 600;
      line-height: 1.3;
    }

    .message.assistant .message-content h1 { font-size: 1.8em; color: var(--accent); border-bottom: 2px solid var(--border); padding-bottom: 8px; }
    .message.assistant .message-content h2 { font-size: 1.5em; color: var(--text-primary); }
    .message.assistant .message-content h3 { font-size: 1.3em; color: var(--text-primary); }
    .message.assistant .message-content h4 { font-size: 1.1em; color: var(--text-secondary); }

    .message.assistant .message-content p { 
      margin: 12px 0; 
      line-height: 1.7;
    }
    
    .message.assistant .message-content p:first-child { margin-top: 0; }
    .message.assistant .message-content p:last-child { margin-bottom: 0; }

    .message.assistant .message-content code { 
      background: rgba(0,0,0,0.4); 
      padding: 3px 8px; 
      border-radius: 4px; 
      font-family: var(--font-mono); 
      font-size: 0.9em;
      color: var(--success);
      border: 1px solid rgba(78, 201, 176, 0.2);
    }
    
    .message.assistant .message-content pre { 
      background: rgba(0,0,0,0.4); 
      padding: 16px; 
      border-radius: 8px; 
      margin: 16px 0; 
      overflow-x: auto;
      border: 1px solid var(--border);
      max-width: 100%;
      box-sizing: border-box;
    }
    
    .message.assistant .message-content pre code {
      background: none;
      padding: 0;
      border: none;
      color: var(--text-primary);
    }
    
    .message.assistant .message-content ul, 
    .message.assistant .message-content ol { 
      margin: 12px 0 12px 24px; 
      line-height: 1.6;
    }
    
    .message.assistant .message-content li { 
      margin: 6px 0; 
    }

    .message.assistant .message-content blockquote {
      border-left: 4px solid var(--accent);
      padding-left: 16px;
      margin: 16px 0;
      color: var(--text-secondary);
      font-style: italic;
    }

    .message.assistant .message-content a {
      color: var(--accent);
      text-decoration: none;
      border-bottom: 1px solid transparent;
      transition: border-color 0.2s;
    }

    .message.assistant .message-content a:hover {
      border-bottom-color: var(--accent);
    }

    .message.assistant .message-content strong {
      color: var(--text-primary);
      font-weight: 600;
    }

    .message.assistant .message-content em {
      color: var(--text-secondary);
      font-style: italic;
    }

    .message-header {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 8px;
      opacity: 0.7;
    }

    .message.user .message-header {
      color: #4fc3f7;
    }

    .message.assistant .message-header {
      color: var(--success);
    }

    /* Query Container */
    .query-container {
      height: 100%;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 40px;
      background: var(--bg-primary);
    }
    
    .query-container > * {
      max-width: 1200px;
      margin-left: auto;
      margin-right: auto;
    }

    /* Query Results */
    .answer-card {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 28px;
      margin-bottom: 24px;
    }

    .answer-content {
      font-size: 14px;
      line-height: 1.8;
      color: var(--text-primary);
    }

    .message.assistant .message-content hr {
      border: none;
      border-top: 1px solid var(--border);
      margin: 20px 0;
    }

    .message.assistant .message-content table {
      width: 100%;
      border-collapse: collapse;
      margin: 16px 0;
      font-size: 0.95em;
    }

    .message.assistant .message-content th,
    .message.assistant .message-content td {
      padding: 10px 12px;
      border: 1px solid var(--border);
      text-align: left;
    }

    .message.assistant .message-content th {
      background: var(--bg-secondary);
      font-weight: 600;
    }

    .message-sources {
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid var(--border);
      font-size: 12px;
    }

    .message-sources-title {
      color: var(--text-secondary);
      margin-bottom: 10px;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      font-size: 11px;
      font-weight: 600;
    }

    .source-node {
      padding: 10px 12px;
      background: var(--bg-primary);
      border-radius: 6px;
      margin-bottom: 6px;
      cursor: pointer;
      transition: all 0.2s;
      border: 1px solid transparent;
      line-height: 1.5;
    }

    .source-node:hover { 
      background: var(--bg-hover); 
      border-color: var(--accent);
      transform: translateX(4px);
    }

    .source-node strong {
      color: var(--accent);
      font-size: 11px;
      font-weight: 600;
    }

    .chat-input-area {
      padding: 16px;
      border-top: 1px solid var(--border);
      background: var(--bg-secondary);
    }

    .chat-input-wrapper {
      display: flex;
      gap: 10px;
      align-items: flex-end;
    }

    .chat-input {
      flex: 1;
      padding: 12px 14px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text-primary);
      font-family: inherit;
      font-size: 14px;
      line-height: 1.5;
      resize: vertical;
      min-height: 44px;
      max-height: 200px;
      transition: border-color 0.2s, box-shadow 0.2s;
    }

    .chat-input:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(0, 122, 204, 0.1);
    }

    .chat-input::placeholder {
      color: var(--text-muted);
    }

    .chat-send {
      padding: 12px 20px;
      background: var(--accent);
      border: none;
      border-radius: 8px;
      color: white;
      font-family: inherit;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
      white-space: nowrap;
      min-width: 80px;
    }

    .chat-send:hover:not(:disabled) { 
      background: var(--accent-hover); 
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(0, 122, 204, 0.3);
    }
    
    .chat-send:active:not(:disabled) {
      transform: translateY(0);
    }
    
    .chat-send:disabled { 
      opacity: 0.5; 
      cursor: not-allowed;
      transform: none;
    }

    /* Node List for Explore */
    .node-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .node-item {
      padding: 10px 12px;
      background: var(--bg-tertiary);
      border-radius: 6px;
      cursor: pointer;
      transition: background 0.1s;
    }

    .node-item:hover { background: var(--bg-hover); }
    .node-item.selected { background: var(--bg-hover); border-left: 2px solid var(--accent); }

    .node-concept {
      font-size: 12px;
      line-height: 1.4;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .node-meta {
      margin-top: 6px;
      font-size: 10px;
      color: var(--text-muted);
      display: flex;
      gap: 8px;
    }

    .node-tag {
      background: var(--bg-primary);
      padding: 2px 6px;
      border-radius: 3px;
      color: var(--accent);
    }

    /* Status Bar */
    .status-bar {
      background: var(--accent);
      color: white;
      padding: 0 16px;
      display: flex;
      align-items: center;
      gap: 16px;
      font-size: 11px;
    }

    .status-item {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    /* Graph */
    .graph-view {
      position: relative;
      flex: 1;
      background: var(--bg-primary);
    }

    #graph { width: 100%; height: 100%; }

    .graph-controls {
      position: absolute;
      bottom: 16px;
      left: 16px;
      display: flex;
      gap: 6px;
    }

    .graph-btn {
      padding: 6px 12px;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 4px;
      color: var(--text-primary);
      cursor: pointer;
      font-size: 12px;
    }

    .graph-btn:hover { background: var(--bg-hover); }

    /* Detail Panel */
    .detail-view {
      padding: 16px;
      overflow-y: auto;
    }

    .detail-section { margin-bottom: 20px; }
    .detail-section h3 {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--text-muted);
      margin-bottom: 8px;
    }

    .detail-content {
      background: var(--bg-tertiary);
      padding: 12px;
      border-radius: 6px;
      font-size: 13px;
      line-height: 1.6;
      white-space: pre-wrap;
    }

    .detail-meta {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }

    .meta-item {
      background: var(--bg-tertiary);
      padding: 10px;
      border-radius: 6px;
    }

    .meta-label { font-size: 10px; color: var(--text-muted); }
    .meta-value { font-size: 14px; font-family: var(--font-mono); margin-top: 4px; }

    /* Loading */
    .loading {
      display: inline-block;
      width: 16px;
      height: 16px;
      border: 2px solid var(--border);
      border-radius: 50%;
      border-top-color: var(--accent);
      animation: spin 1s linear infinite;
    }

    @keyframes spin { to { transform: rotate(360deg); } }

    /* Scrollbar */
    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-track { background: var(--bg-secondary); }
    ::-webkit-scrollbar-thumb { background: var(--bg-hover); border-radius: 4px; }
    ::-webkit-scrollbar-thumb:hover { background: var(--border); }

    /* Empty State */
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--text-muted);
      text-align: center;
      padding: 40px;
    }

    .empty-icon { font-size: 48px; margin-bottom: 16px; opacity: 0.5; }
    .empty-title { font-size: 16px; color: var(--text-secondary); margin-bottom: 8px; }

    /* Settings Button */
    .settings-btn {
      background: transparent;
      border: none;
      color: var(--text-secondary);
      cursor: pointer;
      font-size: 14px;
      padding: 4px 8px;
      border-radius: 4px;
      transition: all 0.15s;
    }
    .settings-btn:hover { background: var(--bg-hover); color: var(--text-primary); }

    /* Modal */
    .modal {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0, 0, 0, 0.7);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }
    .modal.hidden { display: none; }

    .modal-content {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 12px;
      width: 480px;
      max-width: 90vw;
    }

    .modal-header {
      padding: 16px 20px;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .modal-header h2 { font-size: 16px; font-weight: 600; }

    .btn-close {
      background: transparent;
      border: none;
      color: var(--text-secondary);
      font-size: 24px;
      cursor: pointer;
      padding: 0;
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
    }
    .btn-close:hover { background: var(--bg-hover); }

    .modal-body { padding: 20px; }

    .settings-section { margin-bottom: 24px; }
    .settings-section:last-child { margin-bottom: 0; }
    .settings-section h3 { font-size: 13px; font-weight: 600; margin-bottom: 8px; }
    .settings-desc { font-size: 12px; color: var(--text-secondary); margin-bottom: 12px; line-height: 1.5; }

    .settings-input-row {
      display: flex;
      gap: 8px;
    }

    .settings-input {
      flex: 1;
      padding: 10px 12px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text-primary);
      font-family: var(--font-mono);
      font-size: 13px;
    }
    .settings-input:focus { outline: none; border-color: var(--accent); }

    .btn-show {
      padding: 10px 12px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
    }
    .btn-show:hover { background: var(--bg-hover); }

    .settings-help {
      margin-top: 8px;
      font-size: 12px;
    }
    .settings-help a { color: var(--accent); text-decoration: none; }
    .settings-help a:hover { text-decoration: underline; }

    .settings-select {
      width: 100%;
      padding: 10px 12px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text-primary);
      font-size: 13px;
      cursor: pointer;
    }

    .modal-footer {
      padding: 16px 20px;
      border-top: 1px solid var(--border);
      display: flex;
      gap: 12px;
      justify-content: flex-end;
    }

    .btn-primary {
      background: var(--accent);
      color: white;
      border: none;
      padding: 10px 20px;
      font-size: 13px;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 500;
    }
    .btn-primary:hover { background: var(--accent-hover); }

    .btn-secondary {
      background: var(--bg-tertiary);
      color: var(--text-primary);
      border: 1px solid var(--border);
      padding: 10px 20px;
      font-size: 13px;
      border-radius: 6px;
      cursor: pointer;
    }
    .btn-secondary:hover { background: var(--bg-hover); }

    .status-ai-active { color: var(--success); }

    /* API Key Groups */
    .api-key-group {
      margin-bottom: 16px;
    }
    .api-key-group:last-child { margin-bottom: 0; }

    .api-key-label {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 6px;
      font-size: 12px;
    }

    .provider-badge {
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .provider-badge.openai { background: #10a37f; color: white; }
    .provider-badge.anthropic { background: #d4a574; color: #1a1a1a; }
    .provider-badge.xai { background: #1da1f2; color: white; }

    .key-link {
      color: var(--text-muted);
      text-decoration: none;
      font-size: 11px;
      margin-left: auto;
    }
    .key-link:hover { color: var(--accent); }

    /* Key status indicators */
    .key-status {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-left: 8px;
    }
    .key-status.configured { background: var(--success); }
    .key-status.missing { background: var(--text-muted); }
  </style>
</head>
<body>
  <div class="app">
    <header class="header">
      <div class="logo">
        <span class="logo-icon">🧠</span>
        <span id="brainName">Brain Studio</span>
      </div>

      <div class="tabs">
        <button class="tab active" data-tab="query">💬 Query</button>
        <button class="tab" data-tab="files">📁 Files</button>
        <button class="tab" data-tab="explore">🔭 Explore</button>
      </div>

      <div class="stats">
        <div class="stat"><span class="stat-value" id="statNodes">-</span> nodes</div>
        <div class="stat"><span class="stat-value" id="statEdges">-</span> edges</div>
        <div class="stat"><span class="stat-value" id="statCycles">-</span> cycles</div>
      </div>
    </header>

    <div class="main">
      <!-- QUERY PANEL (Intelligence Dashboard style) -->
      <div class="panel active" id="queryPanel">
        <div class="query-container">
          
          <!-- Query Input Section (EXACT Intelligence Dashboard structure) -->
          <div style="background: var(--bg-secondary); border-radius: 12px; padding: 24px; margin-bottom: 24px;">
            <textarea 
              id="queryInput" 
              placeholder="Ask a question about this brain's knowledge..."
              style="width: 100%; min-height: 120px; padding: 14px; background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: 8px; color: var(--text-primary); font-family: inherit; font-size: 14px; line-height: 1.6; resize: vertical;"
            ></textarea>

            <!-- Options Grid (Intelligence Dashboard pattern) -->
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 16px;">
              <div>
                <label style="font-size: 12px; color: var(--text-secondary); display: block; margin-bottom: 6px; font-weight: 500;">Model:</label>
                <select id="queryModel" style="width: 100%; padding: 10px; background: var(--bg-tertiary); border: 1px solid var(--border); color: var(--text-primary); border-radius: 6px; font-size: 13px; cursor: pointer;">
                  <option value="gpt-5.1" selected>GPT-5.1 (Default - Fast with 24h Caching)</option>
                  <option value="gpt-5">GPT-5 (Maximum Reasoning Depth)</option>
                  <option value="gpt-5-mini">GPT-5 Mini (Ultra Fast & Economical)</option>
                </select>
              </div>

              <div>
                <label style="font-size: 12px; color: var(--text-secondary); display: block; margin-bottom: 6px; font-weight: 500;">Reasoning Mode:</label>
                <select id="queryMode" style="width: 100%; padding: 10px; background: var(--bg-tertiary); border: 1px solid var(--border); color: var(--text-primary); border-radius: 6px; font-size: 13px; cursor: pointer;">
                  <option value="fast">Fast (Quick Extraction)</option>
                  <option value="normal" selected>Normal (Balanced Depth)</option>
                  <option value="deep">Deep (Maximum Analysis)</option>
                  <option value="grounded">Grounded (Evidence-Focused)</option>
                  <option value="raw">🔓 Raw (No Formatting)</option>
                  <option value="report">Report (Academic Style)</option>
                  <option value="innovation">💡 Innovation (Creative Synthesis)</option>
                  <option value="consulting">📊 Consulting (Strategic)</option>
                  <option value="executive">📊 Executive Summary</option>
                </select>
                <div id="modeHint" style="font-size: 11px; color: var(--text-muted); margin-top: 6px; line-height: 1.4;">
                  Balanced depth mode - comprehensive answers with source citations
                </div>
              </div>
            </div>

            <!-- Enhancement Options (Intelligence Dashboard pattern) -->
            <div style="display: flex; gap: 20px; margin-top: 16px;">
              <label style="display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-secondary); cursor: pointer;">
                <input type="checkbox" id="evidenceMetrics">
                <span>Evidence Metrics</span>
              </label>
              <label style="display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-secondary); cursor: pointer;">
                <input type="checkbox" id="enableSynthesis" checked>
                <span>Synthesis</span>
              </label>
              <label style="display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-secondary); cursor: pointer;">
                <input type="checkbox" id="coordinatorInsights" checked>
                <span>Coordinator Insights</span>
              </label>
            </div>

            <!-- File/Context Access Options -->
            <div style="display: flex; gap: 20px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border);">
              <label style="display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-secondary); cursor: pointer;">
                <input type="checkbox" id="includeOutputs" checked>
                <span>📁 Include Output Files</span>
              </label>
              <label style="display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-secondary); cursor: pointer;">
                <input type="checkbox" id="includeThoughts" checked>
                <span>💭 Include Thought Stream</span>
              </label>
            </div>

            <!-- Action Buttons -->
            <div style="margin-top: 16px; display: flex; align-items: center; gap: 12px;">
              <button id="executeQueryBtn" onclick="submitQuery()" style="padding: 12px 24px; background: var(--accent); border: none; border-radius: 8px; color: white; font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.2s;">
                🔍 Execute Query
              </button>
              <button onclick="clearQuery()" style="padding: 12px 20px; background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: 8px; color: var(--text-primary); font-size: 14px; cursor: pointer;">
                Clear
              </button>
              
              <div style="margin-left: auto; display: flex; align-items: center; gap: 10px;">
                <label style="font-size: 13px; color: var(--text-secondary);">Export:</label>
                <select id="exportFormat" style="padding: 8px; background: var(--bg-tertiary); border: 1px solid var(--border); color: var(--text-primary); border-radius: 6px; font-size: 13px;">
                  <option value="none">None</option>
                  <option value="markdown">Markdown</option>
                  <option value="json">JSON</option>
                </select>
                <button class="settings-btn" onclick="openSettings()" style="padding: 8px 16px; background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: 6px; color: var(--text-secondary);" title="API Settings">
                  ⚙️ Settings
                </button>
              </div>
            </div>
          </div>

          <!-- Results Area -->
          <div id="queryResults" style="display: none;"></div>
          
          <!-- Loading State -->
          <div id="queryLoading" style="display: none; text-align: center; padding: 40px; color: var(--text-secondary);">
            <div class="loading" style="margin: 0 auto 16px;"></div>
            <div>Searching knowledge graph and synthesizing answer...</div>
            <div style="font-size: 12px; color: var(--text-muted); margin-top: 8px;">This may take 10-30 seconds</div>
          </div>

          <!-- Query History -->
          <div id="queryHistory" style="margin-top: 32px; display: none;">
            <div style="font-size: 16px; font-weight: 600; color: var(--text-primary); margin-bottom: 16px;">Query History</div>
            <div id="historyList"></div>
          </div>
        </div>
      </div>

      <!-- FILES PANEL -->
      <div class="panel" id="filesPanel">
        <aside class="sidebar">
          <div class="sidebar-header">Explorer</div>
          <div class="search-box">
            <input type="text" id="fileSearch" placeholder="Search files...">
          </div>
          <div class="file-tree" id="fileTree"></div>
        </aside>

        <div class="content-area">
          <div class="content-tabs" id="contentTabs"></div>
          <div class="content-view" id="contentView">
            <div class="empty-state">
              <div class="empty-icon">📄</div>
              <div class="empty-title">Select a file to view</div>
            </div>
          </div>
        </div>

        <div class="right-panel">
          <div class="panel-header">
            <span class="panel-title">🤖 AI Assistant</span>
            <span style="font-size: 11px; color: var(--text-muted);">File Helper</span>
          </div>
          <div class="chat-messages" id="filesChat" style="flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 16px;">
            <div class="message assistant">
              <div class="message-content">
                <p><strong>File Assistant</strong></p>
                <p>I can help you understand and work with files in this brain.</p>
                <p><strong>Try:</strong></p>
                <ul>
                  <li>"Summarize this document"</li>
                  <li>"What's in the research folder?"</li>
                  <li>"Explain this code"</li>
                </ul>
              </div>
            </div>
          </div>
          <div class="chat-input-area" style="padding: 12px; border-top: 1px solid var(--border);">
            <div style="display: flex; gap: 8px;">
              <textarea id="filesInput" placeholder="Ask about files..." rows="2" style="flex: 1; padding: 10px; background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: 6px; color: var(--text-primary); font-size: 13px; resize: vertical;"></textarea>
              <button id="filesSend" onclick="sendFileChat()" style="padding: 10px 16px; background: var(--accent); border: none; border-radius: 6px; color: white; font-size: 13px; font-weight: 600; cursor: pointer;">Send</button>
            </div>
          </div>
        </div>
      </div>

      <!-- EXPLORE PANEL -->
      <div class="panel" id="explorePanel">
        <aside class="sidebar">
          <div class="sidebar-header">Knowledge Nodes</div>
          <div class="search-box">
            <input type="text" id="nodeSearch" placeholder="Search nodes...">
          </div>
          <div style="padding: 8px;">
            <select id="tagFilter" style="width: 100%; padding: 6px; background: var(--bg-tertiary); border: 1px solid var(--border); color: var(--text-primary); border-radius: 4px; font-size: 12px;">
              <option value="">All tags</option>
            </select>
          </div>
          <div class="file-tree node-list" id="nodeList"></div>
        </aside>

        <div class="content-area graph-view">
          <svg id="graph"></svg>
          <div class="graph-controls">
            <button class="graph-btn" onclick="resetZoom()">⟲ Reset</button>
            <button class="graph-btn" onclick="toggleLabels()">🏷️ Labels</button>
          </div>
        </div>

        <div class="right-panel detail-view" id="nodeDetail">
          <div class="empty-state">
            <div class="empty-icon">👆</div>
            <div class="empty-title">Select a node</div>
          </div>
        </div>
      </div>
    </div>

    <div class="status-bar">
      <div class="status-item">🧠 Brain Studio v2</div>
      <div class="status-item" id="statusFile"></div>
      <div class="status-item" style="margin-left: auto;" id="statusAI">AI: Not configured</div>
    </div>

    <!-- Settings Modal -->
    <div class="modal hidden" id="settingsModal">
      <div class="modal-content" style="width: 560px;">
        <div class="modal-header">
          <h2>⚙️ AI Settings</h2>
          <button class="btn-close" onclick="closeSettings()">×</button>
        </div>
        <div class="modal-body">
          <div class="settings-section">
            <h3>Model</h3>
            <select id="modelSelect" class="settings-select">
              <optgroup label="OpenAI">
                <option value="gpt-4o-mini">GPT-4o Mini (Fast, cheap)</option>
                <option value="gpt-4o">GPT-4o (Best quality)</option>
                <option value="gpt-4-turbo">GPT-4 Turbo</option>
              </optgroup>
              <optgroup label="Anthropic">
                <option value="claude-sonnet-4-5">Claude Sonnet 4.5 (Fast)</option>
                <option value="claude-opus-4-5">Claude Opus 4.5 (Deep reasoning)</option>
              </optgroup>
              <optgroup label="xAI">
                <option value="grok-3">Grok 3</option>
                <option value="grok-3-mini">Grok 3 Mini (Fast)</option>
              </optgroup>
            </select>
          </div>

          <div class="settings-section">
            <h3>🔑 API Keys</h3>
            <p class="settings-desc">Keys are stored locally in your browser and sent directly to providers. We never see them.</p>
            
            <div class="api-key-group">
              <label class="api-key-label">
                <span class="provider-badge openai">OpenAI</span>
                <a href="https://platform.openai.com/api-keys" target="_blank" class="key-link">Get key →</a>
              </label>
              <div class="settings-input-row">
                <input type="password" id="openaiKeyInput" placeholder="sk-..." class="settings-input">
                <button class="btn-show" onclick="toggleKeyVisibility('openaiKeyInput')">👁️</button>
              </div>
            </div>

            <div class="api-key-group">
              <label class="api-key-label">
                <span class="provider-badge anthropic">Anthropic</span>
                <a href="https://console.anthropic.com/settings/keys" target="_blank" class="key-link">Get key →</a>
              </label>
              <div class="settings-input-row">
                <input type="password" id="anthropicKeyInput" placeholder="sk-ant-..." class="settings-input">
                <button class="btn-show" onclick="toggleKeyVisibility('anthropicKeyInput')">👁️</button>
              </div>
            </div>

            <div class="api-key-group">
              <label class="api-key-label">
                <span class="provider-badge xai">xAI</span>
                <a href="https://console.x.ai" target="_blank" class="key-link">Get key →</a>
              </label>
              <div class="settings-input-row">
                <input type="password" id="xaiKeyInput" placeholder="xai-..." class="settings-input">
                <button class="btn-show" onclick="toggleKeyVisibility('xaiKeyInput')">👁️</button>
              </div>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" onclick="clearAllKeys()">Clear All</button>
          <button class="btn-primary" onclick="saveSettings()">Save</button>
        </div>
      </div>
    </div>
  </div>

  <script>
    // ========== STATE ==========
    let outputTree = null;
    let openTabs = [];
    let activeTab = null;
    let nodes = [];
    let selectedNode = null;
    let showLabels = true;
    let simulation, svg, g, zoom;

    // Settings - Multiple API keys
    let apiKeys = {
      openai: localStorage.getItem('brainStudio_openaiKey') || '',
      anthropic: localStorage.getItem('brainStudio_anthropicKey') || '',
      xai: localStorage.getItem('brainStudio_xaiKey') || '',
    };
    let userModel = localStorage.getItem('brainStudio_model') || 'gpt-4o-mini';

    // Model provider mapping
    const modelProviders = {
      'gpt-5.1': 'openai',
      'gpt-5': 'openai',
      'gpt-5-mini': 'openai',
      'gpt-5.2': 'openai',
    };

    // ========== SETTINGS ==========
    function openSettings() {
      document.getElementById('settingsModal').classList.remove('hidden');
      document.getElementById('openaiKeyInput').value = apiKeys.openai;
      document.getElementById('anthropicKeyInput').value = apiKeys.anthropic;
      document.getElementById('xaiKeyInput').value = apiKeys.xai;
      document.getElementById('modelSelect').value = userModel;
    }

    function closeSettings() {
      document.getElementById('settingsModal').classList.add('hidden');
    }

    function toggleKeyVisibility(inputId) {
      const input = document.getElementById(inputId);
      input.type = input.type === 'password' ? 'text' : 'password';
    }

    function saveSettings() {
      apiKeys.openai = document.getElementById('openaiKeyInput').value.trim();
      apiKeys.anthropic = document.getElementById('anthropicKeyInput').value.trim();
      apiKeys.xai = document.getElementById('xaiKeyInput').value.trim();
      userModel = document.getElementById('modelSelect').value;
      
      localStorage.setItem('brainStudio_openaiKey', apiKeys.openai);
      localStorage.setItem('brainStudio_anthropicKey', apiKeys.anthropic);
      localStorage.setItem('brainStudio_xaiKey', apiKeys.xai);
      localStorage.setItem('brainStudio_model', userModel);
      
      updateAIStatus();
      closeSettings();
    }

    function clearAllKeys() {
      apiKeys = { openai: '', anthropic: '', xai: '' };
      localStorage.removeItem('brainStudio_openaiKey');
      localStorage.removeItem('brainStudio_anthropicKey');
      localStorage.removeItem('brainStudio_xaiKey');
      document.getElementById('openaiKeyInput').value = '';
      document.getElementById('anthropicKeyInput').value = '';
      document.getElementById('xaiKeyInput').value = '';
      updateAIStatus();
    }

    function updateAIStatus() {
      const statusEl = document.getElementById('statusAI');
      const provider = modelProviders[userModel];
      const hasKey = apiKeys[provider];
      
      if (hasKey) {
        const modelName = userModel.includes('gpt') ? 'GPT' : 
                         userModel.includes('claude') ? 'Claude' : 'Grok';
        statusEl.textContent = '✅ AI: ' + modelName;
        statusEl.className = 'status-item status-ai-active';
      } else {
        statusEl.textContent = '⚠️ AI: Need ' + (provider === 'openai' ? 'OpenAI' : provider === 'anthropic' ? 'Anthropic' : 'xAI') + ' key';
        statusEl.className = 'status-item';
      }
    }

    // ========== API ==========
    async function api(endpoint) {
      const res = await fetch('/api' + endpoint);
      return res.json();
    }

    // ========== INIT ==========
    async function init() {
      const manifest = await api('/manifest');
      document.getElementById('brainName').textContent = manifest.brain?.displayName || manifest.brain?.name || 'Brain';
      document.title = '🧠 ' + (manifest.brain?.name || 'Brain') + ' - Brain Studio';

      const stats = await api('/stats');
      document.getElementById('statNodes').textContent = stats.nodes.toLocaleString();
      document.getElementById('statEdges').textContent = stats.edges.toLocaleString();
      document.getElementById('statCycles').textContent = stats.cycles.toLocaleString();

      // Load file tree
      outputTree = await api('/tree');
      renderFileTree(outputTree, document.getElementById('fileTree'), 0);

      // Load tags
      const tags = await api('/tags');
      const tagSelect = document.getElementById('tagFilter');
      tags.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.tag;
        opt.textContent = t.tag + ' (' + t.count + ')';
        tagSelect.appendChild(opt);
      });

      // Load nodes
      await loadNodes();

      // Tab switching
      document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => switchTab(tab.dataset.tab));
      });

      // Query keyboard shortcut (Cmd/Ctrl+Enter)
      const queryInput = document.getElementById('queryInput');
      if (queryInput) {
        queryInput.addEventListener('keydown', (e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { 
            e.preventDefault(); 
            submitQuery(); 
          }
        });
      }

      // Search
      document.getElementById('nodeSearch').addEventListener('input', debounce(loadNodes, 300));
      document.getElementById('tagFilter').addEventListener('change', loadNodes);

      // Settings
      updateAIStatus();

      // Close modal on escape
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeSettings();
      });

      // Close modal on backdrop click
      document.getElementById('settingsModal').addEventListener('click', (e) => {
        if (e.target.classList.contains('modal')) closeSettings();
      });

      console.log('✅ Brain Studio v2 initialized');
    }

    function switchTab(tabName) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      document.querySelector('.tab[data-tab="' + tabName + '"]').classList.add('active');
      document.getElementById(tabName + 'Panel').classList.add('active');
      
      if (tabName === 'explore' && !simulation) {
        setTimeout(initGraph, 100);
      }
    }

    // ========== FILE TREE ==========
    function renderFileTree(node, container, depth) {
      if (!node.isDirectory) {
        const item = document.createElement('div');
        item.className = 'tree-item';
        item.style.paddingLeft = (depth * 16 + 16) + 'px';
        item.innerHTML = '<span class="tree-icon">' + getFileIcon(node.name) + '</span>' +
          '<span class="tree-name">' + escapeHtml(node.name) + '</span>' +
          '<span class="tree-size">' + formatBytes(node.size) + '</span>';
        item.onclick = () => openFile(node.path, node.name);
        container.appendChild(item);
        return;
      }

      const wrapper = document.createElement('div');
      
      const item = document.createElement('div');
      item.className = 'tree-item';
      item.style.paddingLeft = (depth * 16 + 16) + 'px';
      item.innerHTML = '<span class="tree-icon">📁</span><span class="tree-name">' + escapeHtml(node.name) + '</span>';
      
      const children = document.createElement('div');
      children.className = 'tree-children';
      
      item.onclick = () => {
        children.classList.toggle('collapsed');
        item.querySelector('.tree-icon').textContent = children.classList.contains('collapsed') ? '📁' : '📂';
      };
      
      (node.children || []).forEach(child => renderFileTree(child, children, depth + 1));
      
      wrapper.appendChild(item);
      wrapper.appendChild(children);
      container.appendChild(wrapper);
    }

    function getFileIcon(name) {
      const ext = name.split('.').pop().toLowerCase();
      const icons = { md: '📝', txt: '📄', json: '📋', py: '🐍', js: '📜', html: '🌐', css: '🎨', csv: '📊', bib: '📚', pdf: '📕', png: '🖼️', jpg: '🖼️' };
      return icons[ext] || '📄';
    }

    // ========== CONTENT TABS ==========
    async function openFile(filePath, fileName) {
      // Check if already open
      let tab = openTabs.find(t => t.path === filePath);
      
      if (!tab) {
        const content = await (await fetch('/api/file?path=' + encodeURIComponent(filePath))).text();
        tab = { path: filePath, name: fileName, content };
        openTabs.push(tab);
      }
      
      activeTab = tab;
      renderTabs();
      renderContent(tab);
      document.getElementById('statusFile').textContent = filePath;
    }

    function renderTabs() {
      const container = document.getElementById('contentTabs');
      container.innerHTML = openTabs.map((tab, i) => 
        '<div class="content-tab ' + (tab === activeTab ? 'active' : '') + '" onclick="activateTab(' + i + ')">' +
          '<span>' + getFileIcon(tab.name) + '</span>' +
          '<span>' + escapeHtml(tab.name) + '</span>' +
          '<span class="content-tab-close" onclick="event.stopPropagation(); closeTab(' + i + ')">×</span>' +
        '</div>'
      ).join('');
    }

    function activateTab(index) {
      activeTab = openTabs[index];
      renderTabs();
      renderContent(activeTab);
      document.getElementById('statusFile').textContent = activeTab.path;
    }

    function closeTab(index) {
      openTabs.splice(index, 1);
      if (activeTab === openTabs[index]) {
        activeTab = openTabs[Math.max(0, index - 1)] || null;
      }
      renderTabs();
      if (activeTab) renderContent(activeTab);
      else document.getElementById('contentView').innerHTML = '<div class="empty-state"><div class="empty-icon">📄</div><div class="empty-title">Select a file to view</div></div>';
    }

    function renderContent(tab) {
      const view = document.getElementById('contentView');
      const isMarkdown = tab.name.endsWith('.md');
      
      if (isMarkdown) {
        view.innerHTML = '<div class="markdown-content">' + marked.parse(tab.content) + '</div>';
      } else {
        view.innerHTML = '<pre class="file-content">' + escapeHtml(tab.content) + '</pre>';
      }
    }

    // ========== CHAT ==========
    let lastQueryResult = null; // For follow-up context
    let querySessionHistory = []; // Track conversation

    async function submitQuery() {
      const input = document.getElementById('queryInput');
      const query = input.value.trim();
      if (!query) return;

      // Collect ALL options (Intelligence Dashboard pattern)
      const model = document.getElementById('queryModel').value;
      const mode = document.getElementById('queryMode').value;
      const useSemanticSearch = document.getElementById('useSemanticSearch')?.checked ?? true;
      const evidenceMetrics = document.getElementById('evidenceMetrics')?.checked ?? false;
      const synthesis = document.getElementById('enableSynthesis')?.checked ?? true;
      const coordinatorInsights = document.getElementById('coordinatorInsights')?.checked ?? true;
      const includeOutputs = document.getElementById('includeOutputs')?.checked ?? true;
      const includeThoughts = document.getElementById('includeThoughts')?.checked ?? true;
      const exportFormat = document.getElementById('exportFormat')?.value || 'none';
      
      const sendBtn = document.getElementById('executeQueryBtn');

      // Show loading, hide results
      document.getElementById('queryResults').style.display = 'none';
      document.getElementById('queryLoading').style.display = 'block';
      sendBtn.disabled = true;
      sendBtn.innerHTML = '<span class="loading"></span> Processing...';

      try {
        // Build request with ALL options (query-engine pattern)
        const requestBody = { 
          query,
          model,
          mode,
          keys: apiKeys,
          // Enhancement options
          useSemanticSearch,
          includeEvidenceMetrics: evidenceMetrics,
          enableSynthesis: synthesis,
          includeCoordinatorInsights: coordinatorInsights,
          includeOutputs,
          includeThoughts,
          exportFormat: exportFormat !== 'none' ? exportFormat : null,
          // Prior context for follow-up queries (Intelligence Dashboard pattern)
          priorContext: lastQueryResult ? {
            query: lastQueryResult.query,
            answer: lastQueryResult.answer
          } : null
        };

        const res = await fetch('/api/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody)
        });
        
        const data = await res.json();
        
        // Save as last result for follow-ups
        lastQueryResult = { query, answer: data.answer, metadata: data.metadata };
        querySessionHistory.push(lastQueryResult);
        
        // Show result
        showQueryResult({ query, ...data });
        
        // Add to history
        addToHistory({ 
          query, 
          answer: data.answer, 
          model: data.metadata?.model || model,
          mode: data.metadata?.mode || mode,
          timestamp: data.metadata?.timestamp || new Date().toISOString(),
          metadata: data.metadata
        });
        
      } catch (error) {
        document.getElementById('queryResults').innerHTML = '<div class="answer-card"><div style="color: var(--error);">❌ Error: ' + error.message + '</div></div>';
        document.getElementById('queryResults').style.display = 'block';
      }

      // Hide loading, re-enable
      document.getElementById('queryLoading').style.display = 'none';
      sendBtn.disabled = false;
      sendBtn.textContent = '🔍 Execute Query';
    }
    
    function clearQuery() {
      document.getElementById('queryInput').value = '';
      document.getElementById('queryResults').style.display = 'none';
      lastQueryResult = null; // Clear context
    }

    // ========== FILES CHAT (separate from Query) ==========
    async function sendFileChat() {
      const input = document.getElementById('filesInput');
      const message = input.value.trim();
      if (!message) return;

      const chatContainer = document.getElementById('filesChat');
      
      // Add user message
      const userMsg = document.createElement('div');
      userMsg.className = 'message user';
      userMsg.innerHTML = '<div class="message-content">' + escapeHtml(message) + '</div>';
      chatContainer.appendChild(userMsg);
      
      input.value = '';
      
      // Simple response for now (can enhance with file context later)
      const assistantMsg = document.createElement('div');
      assistantMsg.className = 'message assistant';
      assistantMsg.innerHTML = '<div class="message-content"><p>File assistant functionality coming soon. For now, use the Query tab to ask about the brain\\'s knowledge.</p></div>';
      chatContainer.appendChild(assistantMsg);
      
      chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    function showQueryResult(result) {
      const resultsDiv = document.getElementById('queryResults');
      
      // QueryEngine result format: { answer, metadata: { model, mode, sources: { memoryNodes, thoughts }, ... } }
      const sourceCount = result.metadata?.sources?.memoryNodes || 0;
      const thoughtCount = result.metadata?.sources?.thoughts || 0;
      const model = result.metadata?.model || 'unknown';
      const mode = result.metadata?.mode || 'normal';
      
      const html = \`
        <div class="answer-card">
          <div style="font-size: 16px; font-weight: 600; color: var(--accent); margin-bottom: 16px;">
            📝 \${escapeHtml(result.query || 'Query')}
          </div>
          <div class="answer-content">\${marked.parse(result.answer)}</div>
          
          <div style="margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border); font-size: 12px; color: var(--text-muted); display: flex; gap: 20px; flex-wrap: wrap;">
            <div><strong>Sources:</strong> \${sourceCount} memory nodes, \${thoughtCount} thoughts</div>
            <div><strong>Model:</strong> \${model}</div>
            <div><strong>Mode:</strong> \${mode}</div>
            <div><strong>Time:</strong> \${new Date(result.metadata.timestamp).toLocaleTimeString()}</div>
          </div>
          
          \${result.metadata?.evidenceQuality ? \`
            <div style="margin-top: 16px; padding: 12px; background: var(--bg-tertiary); border-radius: 6px; border-left: 3px solid var(--success);">
              <div style="font-size: 12px; font-weight: 600; color: var(--text-secondary); margin-bottom: 6px;">📊 Evidence Quality</div>
              <div style="font-size: 11px; color: var(--text-muted);">
                Quality: \${result.metadata.evidenceQuality.quality || 'N/A'} · 
                Confidence: \${((result.metadata.evidenceQuality.confidence || 0) * 100).toFixed(0)}%
              </div>
            </div>
          \` : ''}
          
          \${result.metadata?.synthesis ? \`
            <div style="margin-top: 12px; padding: 12px; background: var(--bg-tertiary); border-radius: 6px; border-left: 3px solid var(--accent);">
              <div style="font-size: 12px; font-weight: 600; color: var(--text-secondary); margin-bottom: 6px;">🔬 Synthesis Insights</div>
              <div style="font-size: 11px; color: var(--text-muted);">
                \${result.metadata.synthesis.summary || 'Synthesis analysis included in response'}
              </div>
            </div>
          \` : ''}
        </div>
      \`;
      
      resultsDiv.innerHTML = html;
      resultsDiv.style.display = 'block';
      
      // Scroll results into view
      resultsDiv.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    let queryHistoryItems = [];
    
    function addToHistory(item) {
      queryHistoryItems.unshift(item);
      renderHistory();
    }

    function renderHistory() {
      if (queryHistoryItems.length === 0) return;
      
      const historyDiv = document.getElementById('queryHistory');
      const listDiv = document.getElementById('historyList');
      
      listDiv.innerHTML = queryHistoryItems.map((item, i) => \`
        <div onclick="showHistoryItem(\${i})" style="background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 6px; padding: 12px; margin-bottom: 8px; cursor: pointer; transition: all 0.2s;" onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border)'">
          <div style="font-size: 13px; color: var(--text-primary); margin-bottom: 4px;">\${escapeHtml(item.query)}</div>
          <div style="font-size: 11px; color: var(--text-muted);">\${new Date(item.timestamp).toLocaleString()} · \${item.model}</div>
        </div>
      \`).join('');
      
      historyDiv.style.display = 'block';
    }

    function showHistoryItem(index) {
      const item = queryHistoryItems[index];
      document.getElementById('chatInput').value = item.query;
      document.getElementById('queryResults').innerHTML = \`
        <div class="answer-card">
          <div style="font-size: 16px; font-weight: 600; color: var(--accent); margin-bottom: 16px;">📝 \${escapeHtml(item.query)}</div>
          <div class="answer-content">\${marked.parse(item.answer)}</div>
          <div style="margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--border); font-size: 12px; color: var(--text-muted);">
            <strong>Model:</strong> \${item.model} · <strong>Time:</strong> \${new Date(item.timestamp).toLocaleString()}
          </div>
        </div>
      \`;
      document.getElementById('queryResults').style.display = 'block';
      document.getElementById('queryResults').scrollIntoView({ behavior: 'smooth' });
    }

    function addChatMessage(role, content, sources = null, model = null) {
      const container = document.getElementById('chatMessages');
      
      // Create message element
      const messageDiv = document.createElement('div');
      messageDiv.className = 'message ' + role;
      
      // Add header (role label)
      const headerDiv = document.createElement('div');
      headerDiv.className = 'message-header';
      headerDiv.style.cssText = 'font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; color: var(--text-secondary);';
      headerDiv.textContent = role === 'user' ? '👤 You' : '🤖 AI Assistant';
      messageDiv.appendChild(headerDiv);
      
      // Add content
      const contentDiv = document.createElement('div');
      contentDiv.className = 'message-content';
      
      if (role === 'assistant') {
        // Render markdown with marked.js
        contentDiv.innerHTML = marked.parse(content);
      } else {
        contentDiv.textContent = content;
      }
      
      messageDiv.appendChild(contentDiv);
      
      // Add sources if present
      if (sources && sources.length > 0) {
        const sourcesDiv = document.createElement('div');
        sourcesDiv.className = 'message-sources';
        sourcesDiv.innerHTML = '<div class="message-sources-title">📚 Knowledge Sources (' + sources.length + ')</div>' +
          sources.slice(0, 5).map(n => 
            '<div class="source-node" onclick="viewNode(' + n.id + ')" title="' + escapeHtml(n.concept || '').substring(0, 200) + '">' +
            '<strong>Node #' + n.id + '</strong> · ' + (n.tag || 'unknown') + 
            (n.similarity ? ' · ' + (n.similarity * 100).toFixed(0) + '% match' : '') +
            '<div style="font-size: 11px; color: var(--text-muted); margin-top: 4px; line-height: 1.4;">' + 
            escapeHtml((n.concept || '').slice(0, 80)) + (n.concept?.length > 80 ? '...' : '') + 
            '</div></div>'
          ).join('');
        messageDiv.appendChild(sourcesDiv);
      }
      
      // Add model badge
      if (model) {
        const modelDiv = document.createElement('div');
        modelDiv.style.cssText = 'font-size: 10px; color: var(--text-muted); margin-top: 12px; padding-top: 8px; border-top: 1px solid var(--border); opacity: 0.7;';
        modelDiv.innerHTML = '<span style="opacity: 0.6;">⚡</span> ' + model;
        messageDiv.appendChild(modelDiv);
      }
      
      // Add to container
      container.appendChild(messageDiv);
      
      // Smooth scroll to bottom
      requestAnimationFrame(() => {
        container.scrollTop = container.scrollHeight;
      });
    }

    // ========== NODES / GRAPH ==========
    async function loadNodes() {
      const search = document.getElementById('nodeSearch').value;
      const tag = document.getElementById('tagFilter').value;
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      if (tag) params.set('tag', tag);
      params.set('limit', 100);

      const data = await api('/nodes?' + params.toString());
      nodes = data.nodes;
      renderNodeList();
    }

    function renderNodeList() {
      const list = document.getElementById('nodeList');
      if (nodes.length === 0) {
        list.innerHTML = '<div class="empty-state"><div class="empty-icon">🔍</div><div class="empty-title">No nodes found</div></div>';
        return;
      }
      list.innerHTML = nodes.map(n => 
        '<div class="node-item ' + (selectedNode?.id === n.id ? 'selected' : '') + '" onclick="viewNode(' + n.id + ')">' +
          '<div class="node-concept">' + escapeHtml(n.concept || 'No concept') + '</div>' +
          '<div class="node-meta"><span class="node-tag">' + (n.tag || 'unknown') + '</span><span>w: ' + (n.weight || 0).toFixed(2) + '</span></div>' +
        '</div>'
      ).join('');
    }

    async function viewNode(nodeId) {
      const data = await api('/nodes/' + nodeId);
      if (!data) return;
      selectedNode = data;
      renderNodeList();
      renderNodeDetail(data);
      highlightNode(nodeId);
    }

    function renderNodeDetail(node) {
      document.getElementById('nodeDetail').innerHTML = 
        '<div class="detail-section"><h3>Node #' + node.id + '</h3></div>' +
        '<div class="detail-section"><h3>Concept</h3><div class="detail-content">' + escapeHtml(node.concept || 'No concept') + '</div></div>' +
        '<div class="detail-section"><h3>Metadata</h3><div class="detail-meta">' +
          '<div class="meta-item"><div class="meta-label">Tag</div><div class="meta-value">' + (node.tag || 'unknown') + '</div></div>' +
          '<div class="meta-item"><div class="meta-label">Weight</div><div class="meta-value">' + (node.weight || 0).toFixed(3) + '</div></div>' +
          '<div class="meta-item"><div class="meta-label">Activation</div><div class="meta-value">' + (node.activation || 0).toFixed(3) + '</div></div>' +
          '<div class="meta-item"><div class="meta-label">Cluster</div><div class="meta-value">' + (node.cluster ?? '-') + '</div></div>' +
        '</div></div>' +
        '<div class="detail-section"><h3>Connections (' + (node.connections?.length || 0) + ')</h3>' +
          (node.connections?.slice(0, 15).map(c => 
            '<div class="source-node" onclick="viewNode(' + c.nodeId + ')">→ Node #' + c.nodeId + ' (w: ' + (c.weight || 0).toFixed(2) + ')</div>'
          ).join('') || '<div style="color: var(--text-muted);">No connections</div>') +
        '</div>';
    }

    // Graph
    async function initGraph() {
      const container = document.querySelector('.graph-view');
      const width = container.clientWidth;
      const height = container.clientHeight;

      svg = d3.select('#graph').attr('width', width).attr('height', height);
      zoom = d3.zoom().scaleExtent([0.1, 4]).on('zoom', (e) => g.attr('transform', e.transform));
      svg.call(zoom);
      g = svg.append('g');

      const data = await api('/graph?maxNodes=150');
      const tags = [...new Set(data.nodes.map(n => n.tag))];
      const color = d3.scaleOrdinal().domain(tags).range(d3.schemeTableau10);

      simulation = d3.forceSimulation(data.nodes)
        .force('link', d3.forceLink(data.edges).id(d => d.id).distance(80))
        .force('charge', d3.forceManyBody().strength(-200))
        .force('center', d3.forceCenter(width / 2, height / 2))
        .force('collision', d3.forceCollide().radius(30));

      const link = g.append('g').selectAll('line').data(data.edges).join('line')
        .attr('stroke', '#3e3e42').attr('stroke-width', d => Math.sqrt(d.weight || 1));

      const node = g.append('g').selectAll('circle').data(data.nodes).join('circle')
        .attr('r', d => 5 + Math.sqrt(d.activation || 1) * 3)
        .attr('fill', d => color(d.tag))
        .attr('stroke', '#fff').attr('stroke-width', 1.5)
        .style('cursor', 'pointer')
        .on('click', (e, d) => viewNode(d.id))
        .call(d3.drag()
          .on('start', (e) => { if (!e.active) simulation.alphaTarget(0.3).restart(); e.subject.fx = e.subject.x; e.subject.fy = e.subject.y; })
          .on('drag', (e) => { e.subject.fx = e.x; e.subject.fy = e.y; })
          .on('end', (e) => { if (!e.active) simulation.alphaTarget(0); e.subject.fx = null; e.subject.fy = null; })
        );

      node.append('title').text(d => d.label);

      const label = g.append('g').attr('class', 'labels').selectAll('text').data(data.nodes).join('text')
        .text(d => d.label?.slice(0, 20) || '')
        .attr('font-size', 9).attr('fill', '#969696').attr('dx', 10).attr('dy', 3);

      simulation.on('tick', () => {
        link.attr('x1', d => d.source.x).attr('y1', d => d.source.y).attr('x2', d => d.target.x).attr('y2', d => d.target.y);
        node.attr('cx', d => d.x).attr('cy', d => d.y);
        label.attr('x', d => d.x).attr('y', d => d.y);
      });
    }

    function highlightNode(nodeId) {
      if (!g) return;
      g.selectAll('circle').attr('stroke-width', d => d.id == nodeId ? 3 : 1.5).attr('stroke', d => d.id == nodeId ? '#007acc' : '#fff');
    }

    function resetZoom() { svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity); }
    function toggleLabels() { showLabels = !showLabels; g.select('.labels').style('display', showLabels ? 'block' : 'none'); }

    // ========== UTILS ==========
    function escapeHtml(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }
    function formatBytes(b) { if (b === 0) return '0 B'; const k = 1024, s = ['B', 'KB', 'MB']; const i = Math.floor(Math.log(b) / Math.log(k)); return parseFloat((b / Math.pow(k, i)).toFixed(1)) + ' ' + s[i]; }
    function debounce(fn, delay) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), delay); }; }

    init();
  </script>
</body>
</html>`;
}

// ============================================================================
// Server
// ============================================================================

async function startServer(brainPath) {
  const loader = new BrainLoader(brainPath);
  await loader.load();

  const brainName = loader.manifest?.brain?.name || path.basename(brainPath);
  
  // Initialize managers
  const conversationManager = new BrainConversationManager();
  const exporter = new BrainExporter(loader);
  
  // USE EXISTING QueryEngine (don't remake!)
  const queryEngine = new QueryEngine(path.resolve(brainPath), ENV_OPENAI_KEY);
  console.log('[BRAIN STUDIO] Using COSMO QueryEngine for queries');
  
  // Cleanup expired conversations every 5 minutes
  setInterval(() => conversationManager.cleanup(), 300000);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = url.pathname;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.statusCode = 200;
      res.end();
      return;
    }

    try {
      if (pathname === '/') {
        res.setHeader('Content-Type', 'text/html');
        res.end(getHTML(brainName));
        return;
      }

      if (pathname === '/api/manifest') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(loader.getManifest()));
        return;
      }

      if (pathname === '/api/stats') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(loader.getStats()));
        return;
      }

      if (pathname === '/api/tree') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(loader.getOutputTree()));
        return;
      }

      if (pathname === '/api/file') {
        const filePath = url.searchParams.get('path');
        const content = await loader.getFileContent(filePath);
        if (content === null) {
          res.statusCode = 404;
          res.end('File not found');
          return;
        }
        res.setHeader('Content-Type', 'text/plain');
        res.end(content);
        return;
      }

      if (pathname === '/api/tags') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(loader.getTags()));
        return;
      }

      if (pathname === '/api/nodes') {
        const options = {
          search: url.searchParams.get('search'),
          tag: url.searchParams.get('tag'),
          limit: parseInt(url.searchParams.get('limit')) || 100,
          offset: parseInt(url.searchParams.get('offset')) || 0,
        };
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(loader.getNodes(options)));
        return;
      }

      const nodeMatch = pathname.match(/^\/api\/nodes\/(.+)$/);
      if (nodeMatch) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(loader.getNode(nodeMatch[1])));
        return;
      }

      if (pathname === '/api/graph') {
        const maxNodes = parseInt(url.searchParams.get('maxNodes')) || 150;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(loader.getGraphData(maxNodes)));
        return;
      }

      if (pathname === '/api/semantic-search' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { query, limit, tag, useSemanticSearch } = JSON.parse(body);

        // Use semantic search if enabled and API key available
        if (useSemanticSearch && ENV_OPENAI_KEY) {
          try {
            const openai = new OpenAI({ apiKey: ENV_OPENAI_KEY });
            const semanticSearch = loader.initializeSemanticSearch(openai);
            const result = await semanticSearch.search(query, { limit: limit || 20, tag });
            
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(result));
            return;
          } catch (error) {
            console.error('[SEMANTIC SEARCH] Error:', error);
            // Fallback to keyword search below
          }
        }

        // Fallback: keyword search
        const nodes = loader.searchRelevant(query, limit || 20);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          results: nodes.map(n => ({ ...n, similarity: 0.5, score: 0.5 })),
          stats: { method: 'keyword', took: 0, total: nodes.length }
        }));
        return;
      }

      if (pathname === '/api/coordinator-search' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { query, limit } = JSON.parse(body);

        try {
          const openai = ENV_OPENAI_KEY ? new OpenAI({ apiKey: ENV_OPENAI_KEY }) : null;
          const coordinatorIndexer = loader.initializeCoordinatorIndexer(openai);
          const result = await coordinatorIndexer.searchInsights(query, limit || 10);
          
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        } catch (error) {
          console.error('[COORDINATOR] Search error:', error);
          res.statusCode = 500;
          res.end(JSON.stringify({ error: error.message, results: [], stats: { method: 'error', total: 0 } }));
          return;
        }
      }

      if (pathname === '/api/coordinator-stats' && req.method === 'GET') {
        try {
          const openai = ENV_OPENAI_KEY ? new OpenAI({ apiKey: ENV_OPENAI_KEY }) : null;
          const coordinatorIndexer = loader.initializeCoordinatorIndexer(openai);
          const stats = await coordinatorIndexer.getStats();
          
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(stats));
          return;
        } catch (error) {
          console.error('[COORDINATOR] Stats error:', error);
          res.end(JSON.stringify({ total: 0, byType: {}, hasData: false }));
          return;
        }
      }

      if (pathname === '/api/thoughts' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { query, role, limit } = JSON.parse(body);

        try {
          const result = await loader.searchThoughts(query, { role, limit: limit || 20 });
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        } catch (error) {
          console.error('[THOUGHTS] Search error:', error);
          res.statusCode = 500;
          res.end(JSON.stringify({ error: error.message, results: [], total: 0 }));
          return;
        }
      }

      if (pathname === '/api/conversation/new' && req.method === 'POST') {
        const sessionId = conversationManager.createSession();
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ sessionId }));
        return;
      }

      if (pathname === '/api/conversation/suggestions' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { sessionId } = JSON.parse(body);

        const nodes = loader.getNodes({ limit: 100 }).nodes;
        const suggestions = conversationManager.generateFollowUpSuggestions(
          sessionId, 
          loader.state,
          nodes
        );
        
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ suggestions }));
        return;
      }

      if (pathname === '/api/export' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { format, options } = JSON.parse(body);

        try {
          let result;
          if (format === 'markdown') {
            result = await exporter.exportMarkdown(options || {});
          } else if (format === 'bibtex') {
            result = await exporter.exportBibTeX();
          } else if (format === 'json') {
            result = await exporter.exportJSON(options || {});
          } else {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: `Unknown format: ${format}` }));
            return;
          }

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        } catch (error) {
          console.error('[EXPORT] Error:', error);
          res.statusCode = 500;
          res.end(JSON.stringify({ error: error.message }));
          return;
        }
      }

      if (pathname === '/api/query' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const options = JSON.parse(body);
        
        const {
          query,
          model = 'gpt-5.1',
          mode = 'normal',
          // Enhancement options
          includeEvidenceMetrics = false,
          enableSynthesis = true,
          includeCoordinatorInsights = true,
          exportFormat = null,
          priorContext = null
        } = options;

        console.log(`[QUERY] Using COSMO QueryEngine: "${query.substring(0, 60)}..." | ${model} | ${mode}`);

        try {
          // USE THE EXISTING QUERY ENGINE - Don't remake!
          const result = await queryEngine.executeQuery(query, {
            model,
            mode,
            exportFormat,
            includeEvidenceMetrics,
            enableSynthesis,
            includeCoordinatorInsights,
            priorContext
          });

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        } catch (error) {
          console.error('[QUERY] Error:', error);
          res.statusCode = 500;
          res.end(JSON.stringify({ error: error.message }));
          return;
        }
      }

      if (pathname === '/api/chat' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { query, keys, model, useSemanticSearch, sessionId } = JSON.parse(body);

        // Merge client keys with env keys (client takes priority)
        const effectiveKeys = {
          openai: keys?.openai || ENV_OPENAI_KEY,
          anthropic: keys?.anthropic || ENV_ANTHROPIC_KEY,
          xai: keys?.xai || ENV_XAI_KEY,
        };
        const effectiveModel = model || 'gpt-4o-mini';

        // Get prior context if this is a follow-up in a conversation
        let priorContext = null;
        if (sessionId) {
          priorContext = conversationManager.getPriorContext(sessionId);
        }

        // RAG: Find relevant nodes (semantic or keyword)
        // ENHANCED: Fetch 30 primary + 30 connected = 60 total context nodes (matching query engine)
        let sources = [];
        if (useSemanticSearch && effectiveKeys.openai) {
          try {
            const openai = new OpenAI({ apiKey: effectiveKeys.openai });
            const semanticSearch = loader.initializeSemanticSearch(openai);
            const searchResult = await semanticSearch.search(query, { limit: 30 });
            sources = searchResult.results;
            
            // Add connected nodes for top results (query engine pattern)
            const connectedNodesMap = new Map();
            for (const node of sources.slice(0, 10)) {
              const connected = semanticSearch.getConnectedNodes(node.id, 10);
              for (const conn of connected) {
                if (!connectedNodesMap.has(conn.id) && !sources.find(s => s.id === conn.id)) {
                  connectedNodesMap.set(conn.id, conn);
                }
              }
            }
            
            // Add connected nodes (up to 30 more)
            const connectedArray = Array.from(connectedNodesMap.values()).slice(0, 30);
            sources = [...sources, ...connectedArray];
            
            console.log(`[CHAT] Using semantic search: ${sources.length} sources (${searchResult.results.length} primary + ${connectedArray.length} connected)`);
          } catch (error) {
            console.error('[CHAT] Semantic search failed, falling back to keyword:', error.message);
            sources = loader.searchRelevant(query, 30);
          }
        } else {
          sources = loader.searchRelevant(query, 30);
          console.log(`[CHAT] Using keyword search: ${sources.length} sources`);
        }

        // Multi-model synthesis (with prior context for follow-ups)
        const result = await synthesizeAnswer(query, sources, effectiveKeys, effectiveModel, priorContext);

        // Save exchange to conversation history
        if (sessionId) {
          try {
            conversationManager.addExchange(sessionId, query, result.answer, {
              model: result.model,
              sourceCount: sources.length
            });
          } catch (error) {
            console.warn('[CHAT] Failed to save conversation:', error.message);
            // Continue anyway
          }
        }

        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          answer: result.answer,
          sources,
          model: result.model,
        }));
        return;
      }

      res.statusCode = 404;
      res.end('Not found');
    } catch (error) {
      console.error('Error:', error);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: error.message }));
    }
  });

  server.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║                 🧠 BRAIN STUDIO v2                           ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log('║                                                              ║');
    console.log(`║  Brain:     ${brainName.padEnd(47)}║`);
    console.log(`║  Nodes:     ${loader.getStats().nodes.toLocaleString().padEnd(47)}║`);
    console.log(`║  Edges:     ${loader.getStats().edges.toLocaleString().padEnd(47)}║`);
    console.log(`║  Cycles:    ${loader.getStats().cycles.toLocaleString().padEnd(47)}║`);
    console.log('║                                                              ║');
    console.log(`║  🌐 Open: http://localhost:${PORT}`.padEnd(63) + '║');
    console.log('║                                                              ║');
    console.log(`║  AI:  ${ENV_OPENAI_KEY || ENV_ANTHROPIC_KEY || ENV_XAI_KEY ? '✅ Env keys detected' : '⚠️  Configure in UI'}`.padEnd(63) + '║');
    console.log('║                                                              ║');
    console.log('║  Features:                                                   ║');
    console.log('║    📁 Directory Browser - Full folder tree                   ║');
    console.log('║    📄 File Viewer - Tabs, markdown rendering                 ║');
    console.log('║    💬 AI Chat - GPT synthesis over RAG                       ║');
    console.log('║    🔭 Graph Explorer - Visual knowledge graph                ║');
    console.log('║                                                              ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log('');
  });
}

// ============================================================================
// CLI
// ============================================================================

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help') {
    console.log(`
🧠 BRAIN STUDIO v2

IDE-style interface for exploring .brain packages.

USAGE:
  node scripts/brain-studio-v2.js <brain-path>

ENVIRONMENT (optional - can configure in UI instead):
  OPENAI_API_KEY      Enable OpenAI models
  ANTHROPIC_API_KEY   Enable Claude models  
  XAI_API_KEY         Enable Grok models

EXAMPLES:
  node scripts/brain-studio-v2.js ./runs/Physics2
  OPENAI_API_KEY=sk-... node scripts/brain-studio-v2.js ./my.brain
`);
    return;
  }

  const brainPath = args[0];
  if (!fsSync.existsSync(brainPath)) {
    console.error(`❌ Path not found: ${brainPath}`);
    process.exit(1);
  }

  await startServer(brainPath);
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});

