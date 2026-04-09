#!/usr/bin/env node

/**
 * COSMO Brain Studio
 * 
 * An adaptive workspace for interacting with .brain packages.
 * - EXPLORE: Visual knowledge graph
 * - CHAT: Ask the brain questions (RAG)
 * - OUTPUTS: Browse artifacts and documents
 * 
 * Usage:
 *   node scripts/brain-studio.js <brain-path>
 */

const http = require('http');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');

const gunzip = promisify(zlib.gunzip);

const PORT = process.env.PORT || 3399;

// ============================================================================
// Brain Loader (Enhanced)
// ============================================================================

class BrainLoader {
  constructor(brainPath) {
    this.brainPath = path.resolve(brainPath);
    this.manifest = null;
    this.state = null;
    this.outputs = [];
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

    // Build manifest if missing
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
        content: {
          nodeCount: this.state.memory?.nodes?.length || 0,
          edgeCount: this.state.memory?.edges?.length || 0,
        },
      };
    }

    // Scan outputs
    await this.scanOutputs();

    return this;
  }

  async scanOutputs() {
    const outputsPath = path.join(this.brainPath, 'outputs');
    if (!fsSync.existsSync(outputsPath)) return;

    const walk = async (dir, basePath = '') => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.join(basePath, entry.name);
        
        if (entry.isDirectory()) {
          await walk(fullPath, relativePath);
        } else if (!entry.name.startsWith('.')) {
          const stat = await fs.stat(fullPath);
          this.outputs.push({
            name: entry.name,
            path: relativePath,
            fullPath,
            size: stat.size,
            modified: stat.mtime,
            type: this.getFileType(entry.name),
          });
        }
      }
    };

    await walk(outputsPath);
  }

  getFileType(filename) {
    const ext = path.extname(filename).toLowerCase();
    const types = {
      '.md': 'markdown',
      '.txt': 'text',
      '.json': 'json',
      '.py': 'python',
      '.js': 'javascript',
      '.html': 'html',
      '.css': 'css',
      '.pdf': 'pdf',
      '.png': 'image',
      '.jpg': 'image',
      '.jpeg': 'image',
      '.csv': 'data',
      '.bib': 'bibliography',
    };
    return types[ext] || 'other';
  }

  getManifest() {
    return this.manifest;
  }

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
      outputs: this.outputs.length,
    };
  }

  getNodes(options = {}) {
    const nodes = this.state.memory?.nodes || [];
    const { search, tag, limit = 100, offset = 0 } = options;

    let filtered = nodes;

    if (search) {
      const searchLower = search.toLowerCase();
      filtered = filtered.filter(n => 
        n.concept?.toLowerCase().includes(searchLower) ||
        n.tag?.toLowerCase().includes(searchLower)
      );
    }

    if (tag) {
      filtered = filtered.filter(n => n.tag === tag);
    }

    return {
      total: filtered.length,
      nodes: filtered.slice(offset, offset + limit).map(n => ({
        id: n.id,
        concept: n.concept,
        tag: n.tag,
        weight: n.weight,
        activation: n.activation,
        cluster: n.cluster,
        created: n.created,
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
        weight: e.weight,
        type: e.type,
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

  getGraphData(maxNodes = 200) {
    const nodes = this.state.memory?.nodes || [];
    const edges = this.state.memory?.edges || [];

    const sortedNodes = [...nodes]
      .sort((a, b) => (b.activation || 0) - (a.activation || 0))
      .slice(0, maxNodes);

    const nodeIds = new Set(sortedNodes.map(n => String(n.id)));

    const visibleEdges = edges.filter(e => 
      nodeIds.has(String(e.source)) && nodeIds.has(String(e.target))
    );

    return {
      nodes: sortedNodes.map(n => ({
        id: String(n.id),
        label: n.concept?.slice(0, 50) || `Node ${n.id}`,
        tag: n.tag,
        weight: n.weight || 1,
        activation: n.activation || 0,
        cluster: n.cluster,
      })),
      edges: visibleEdges.map(e => ({
        source: String(e.source),
        target: String(e.target),
        weight: e.weight || 1,
      })),
    };
  }

  // RAG: Find relevant nodes for a query
  searchRelevant(query, limit = 10) {
    const nodes = this.state.memory?.nodes || [];
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);

    // Score nodes by relevance
    const scored = nodes.map(node => {
      const concept = (node.concept || '').toLowerCase();
      let score = 0;

      // Exact phrase match
      if (concept.includes(queryLower)) {
        score += 10;
      }

      // Word matches
      for (const word of queryWords) {
        if (concept.includes(word)) {
          score += 2;
        }
      }

      // Boost by activation and weight
      score *= (1 + (node.activation || 0));
      score *= (1 + (node.weight || 0) * 0.5);

      return { node, score };
    });

    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(s => s.node);
  }

  getOutputs() {
    return this.outputs;
  }

  async getOutputContent(relativePath) {
    const fullPath = path.join(this.brainPath, 'outputs', relativePath);
    if (!fsSync.existsSync(fullPath)) return null;
    
    const content = await fs.readFile(fullPath, 'utf8');
    return content;
  }

  getJournal(limit = 50) {
    const journal = this.state.journal || this.state.thoughtHistory || [];
    return journal.slice(-limit).reverse();
  }
}

// ============================================================================
// HTML Template (Enhanced)
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
    @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

    :root {
      --bg-void: #05050a;
      --bg-primary: #0a0a12;
      --bg-secondary: #0f0f1a;
      --bg-tertiary: #161625;
      --bg-elevated: #1c1c30;
      --text-primary: #e8e8f8;
      --text-secondary: #7878a0;
      --text-muted: #4a4a6a;
      --accent: #8b5cf6;
      --accent-bright: #a78bfa;
      --accent-dim: #6d28d9;
      --success: #10b981;
      --warning: #f59e0b;
      --error: #ef4444;
      --border: #252540;
      --border-bright: #3a3a60;
      --glow: rgba(139, 92, 246, 0.15);
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: 'Space Grotesk', -apple-system, sans-serif;
      background: var(--bg-void);
      color: var(--text-primary);
      min-height: 100vh;
      overflow: hidden;
    }

    .app {
      display: grid;
      grid-template-rows: 64px 1fr;
      height: 100vh;
    }

    /* Header */
    .header {
      background: linear-gradient(180deg, var(--bg-secondary) 0%, var(--bg-primary) 100%);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      padding: 0 24px;
      gap: 32px;
    }

    .logo {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .logo-icon {
      font-size: 28px;
      filter: drop-shadow(0 0 8px var(--accent));
    }

    .logo-text {
      font-size: 18px;
      font-weight: 600;
      background: linear-gradient(135deg, var(--accent-bright), var(--text-primary));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .tabs {
      display: flex;
      gap: 4px;
      background: var(--bg-tertiary);
      padding: 4px;
      border-radius: 10px;
    }

    .tab {
      padding: 10px 20px;
      background: transparent;
      border: none;
      color: var(--text-secondary);
      font-family: inherit;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      border-radius: 8px;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .tab:hover {
      color: var(--text-primary);
      background: var(--bg-elevated);
    }

    .tab.active {
      color: var(--accent-bright);
      background: var(--bg-elevated);
      box-shadow: 0 0 20px var(--glow);
    }

    .stats {
      display: flex;
      gap: 24px;
      margin-left: auto;
    }

    .stat {
      text-align: center;
    }

    .stat-value {
      font-size: 18px;
      font-weight: 700;
      color: var(--accent-bright);
      font-family: 'JetBrains Mono', monospace;
    }

    .stat-label {
      font-size: 10px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 1.5px;
    }

    /* Main Content */
    .main {
      display: grid;
      grid-template-columns: 1fr;
      overflow: hidden;
    }

    .panel {
      display: none;
      height: 100%;
      overflow: hidden;
    }

    .panel.active {
      display: grid;
    }

    /* ====== EXPLORE PANEL ====== */
    .explore-panel {
      grid-template-columns: 340px 1fr 380px;
    }

    .sidebar {
      background: var(--bg-secondary);
      border-right: 1px solid var(--border);
      overflow-y: auto;
      padding: 20px;
    }

    .search-box {
      position: relative;
      margin-bottom: 16px;
    }

    .search-box input {
      width: 100%;
      padding: 14px 18px;
      padding-left: 44px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      border-radius: 12px;
      color: var(--text-primary);
      font-family: inherit;
      font-size: 14px;
      outline: none;
      transition: all 0.2s;
    }

    .search-box input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 20px var(--glow);
    }

    .search-box::before {
      content: '🔍';
      position: absolute;
      left: 16px;
      top: 50%;
      transform: translateY(-50%);
      font-size: 14px;
    }

    .filter-row {
      display: flex;
      gap: 8px;
      margin-bottom: 16px;
    }

    .filter-row select {
      flex: 1;
      padding: 10px 12px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text-primary);
      font-family: inherit;
      font-size: 13px;
      cursor: pointer;
    }

    .node-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .node-item {
      padding: 14px;
      background: var(--bg-tertiary);
      border-radius: 10px;
      cursor: pointer;
      transition: all 0.2s;
      border: 1px solid transparent;
    }

    .node-item:hover {
      border-color: var(--border-bright);
      transform: translateX(4px);
    }

    .node-item.selected {
      border-color: var(--accent);
      background: rgba(139, 92, 246, 0.1);
      box-shadow: 0 0 20px var(--glow);
    }

    .node-concept {
      font-size: 13px;
      line-height: 1.5;
      margin-bottom: 8px;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .node-meta {
      display: flex;
      gap: 8px;
      font-size: 11px;
      color: var(--text-muted);
    }

    .node-tag {
      background: var(--bg-primary);
      padding: 3px 10px;
      border-radius: 6px;
      color: var(--accent-bright);
      font-weight: 500;
    }

    .graph-container {
      position: relative;
      background: radial-gradient(ellipse at center, var(--bg-tertiary) 0%, var(--bg-void) 100%);
      overflow: hidden;
    }

    #graph {
      width: 100%;
      height: 100%;
    }

    .graph-controls {
      position: absolute;
      bottom: 24px;
      left: 24px;
      display: flex;
      gap: 8px;
    }

    .graph-btn {
      padding: 10px 18px;
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text-primary);
      cursor: pointer;
      font-family: inherit;
      font-size: 13px;
      transition: all 0.2s;
    }

    .graph-btn:hover {
      background: var(--bg-tertiary);
      border-color: var(--accent);
    }

    .detail-panel {
      background: var(--bg-secondary);
      border-left: 1px solid var(--border);
      overflow-y: auto;
      padding: 24px;
    }

    .detail-header {
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
    }

    .detail-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--accent-bright);
      font-family: 'JetBrains Mono', monospace;
    }

    .detail-section {
      margin-bottom: 24px;
    }

    .detail-section h3 {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      color: var(--text-muted);
      margin-bottom: 12px;
    }

    .detail-content {
      font-size: 14px;
      line-height: 1.7;
      padding: 16px;
      background: var(--bg-tertiary);
      border-radius: 10px;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .detail-meta {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }

    .meta-item {
      padding: 14px;
      background: var(--bg-tertiary);
      border-radius: 10px;
    }

    .meta-label {
      font-size: 10px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 4px;
    }

    .meta-value {
      font-size: 16px;
      font-weight: 600;
      font-family: 'JetBrains Mono', monospace;
    }

    .connections-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      max-height: 300px;
      overflow-y: auto;
    }

    .connection-item {
      padding: 12px;
      background: var(--bg-tertiary);
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s;
      font-size: 13px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .connection-item:hover {
      background: var(--bg-elevated);
    }

    .connection-item::before {
      content: '→';
      color: var(--accent);
    }

    /* ====== CHAT PANEL ====== */
    .chat-panel {
      grid-template-columns: 1fr 400px;
    }

    .chat-main {
      display: flex;
      flex-direction: column;
      background: var(--bg-primary);
    }

    .chat-messages {
      flex: 1;
      overflow-y: auto;
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 24px;
    }

    .message {
      max-width: 85%;
      animation: fadeIn 0.3s ease;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .message.user {
      align-self: flex-end;
    }

    .message.assistant {
      align-self: flex-start;
    }

    .message-content {
      padding: 16px 20px;
      border-radius: 16px;
      font-size: 14px;
      line-height: 1.7;
    }

    .message.user .message-content {
      background: var(--accent-dim);
      color: white;
      border-bottom-right-radius: 4px;
    }

    .message.assistant .message-content {
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      border-bottom-left-radius: 4px;
    }

    .message-sources {
      margin-top: 12px;
      padding: 12px;
      background: var(--bg-elevated);
      border-radius: 10px;
      font-size: 12px;
    }

    .message-sources-title {
      color: var(--text-muted);
      margin-bottom: 8px;
      font-weight: 500;
    }

    .source-node {
      padding: 8px;
      background: var(--bg-tertiary);
      border-radius: 6px;
      margin-bottom: 6px;
      cursor: pointer;
      transition: all 0.2s;
    }

    .source-node:hover {
      background: var(--bg-primary);
    }

    .chat-input-area {
      padding: 20px 24px;
      background: var(--bg-secondary);
      border-top: 1px solid var(--border);
    }

    .chat-input-wrapper {
      display: flex;
      gap: 12px;
      align-items: flex-end;
    }

    .chat-input {
      flex: 1;
      padding: 16px 20px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      border-radius: 14px;
      color: var(--text-primary);
      font-family: inherit;
      font-size: 14px;
      outline: none;
      resize: none;
      min-height: 52px;
      max-height: 150px;
      transition: all 0.2s;
    }

    .chat-input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 20px var(--glow);
    }

    .chat-send {
      padding: 16px 24px;
      background: var(--accent);
      border: none;
      border-radius: 12px;
      color: white;
      font-family: inherit;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }

    .chat-send:hover {
      background: var(--accent-bright);
      transform: translateY(-2px);
    }

    .chat-send:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .chat-context {
      background: var(--bg-secondary);
      border-left: 1px solid var(--border);
      overflow-y: auto;
      padding: 20px;
    }

    .context-section {
      margin-bottom: 24px;
    }

    .context-title {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      color: var(--text-muted);
      margin-bottom: 12px;
    }

    .context-node {
      padding: 12px;
      background: var(--bg-tertiary);
      border-radius: 8px;
      margin-bottom: 8px;
      font-size: 13px;
      line-height: 1.5;
    }

    /* ====== OUTPUTS PANEL ====== */
    .outputs-panel {
      grid-template-columns: 340px 1fr;
    }

    .file-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .file-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      background: var(--bg-tertiary);
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s;
    }

    .file-item:hover {
      background: var(--bg-elevated);
    }

    .file-item.selected {
      background: var(--bg-elevated);
      border-left: 3px solid var(--accent);
    }

    .file-icon {
      font-size: 18px;
    }

    .file-info {
      flex: 1;
      min-width: 0;
    }

    .file-name {
      font-size: 13px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .file-meta {
      font-size: 11px;
      color: var(--text-muted);
    }

    .file-preview {
      background: var(--bg-secondary);
      overflow: auto;
      padding: 24px;
    }

    .preview-content {
      font-family: 'JetBrains Mono', monospace;
      font-size: 13px;
      line-height: 1.6;
      white-space: pre-wrap;
    }

    .preview-markdown {
      font-family: 'Space Grotesk', sans-serif;
      line-height: 1.8;
    }

    .preview-markdown h1, .preview-markdown h2, .preview-markdown h3 {
      color: var(--accent-bright);
      margin-top: 24px;
      margin-bottom: 12px;
    }

    .preview-markdown p {
      margin-bottom: 16px;
    }

    .preview-markdown code {
      background: var(--bg-tertiary);
      padding: 2px 6px;
      border-radius: 4px;
      font-family: 'JetBrains Mono', monospace;
    }

    .preview-markdown pre {
      background: var(--bg-tertiary);
      padding: 16px;
      border-radius: 8px;
      overflow-x: auto;
    }

    .preview-markdown ul, .preview-markdown ol {
      margin-left: 20px;
      margin-bottom: 16px;
    }

    /* Empty state */
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

    .empty-icon {
      font-size: 64px;
      margin-bottom: 20px;
      opacity: 0.5;
    }

    .empty-title {
      font-size: 18px;
      font-weight: 600;
      color: var(--text-secondary);
      margin-bottom: 8px;
    }

    .empty-subtitle {
      font-size: 14px;
      max-width: 300px;
    }

    /* Scrollbar */
    ::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }

    ::-webkit-scrollbar-track {
      background: transparent;
    }

    ::-webkit-scrollbar-thumb {
      background: var(--border);
      border-radius: 4px;
    }

    ::-webkit-scrollbar-thumb:hover {
      background: var(--border-bright);
    }

    /* Loading */
    .loading {
      display: inline-block;
      width: 20px;
      height: 20px;
      border: 2px solid var(--border);
      border-radius: 50%;
      border-top-color: var(--accent);
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <div class="app">
    <header class="header">
      <div class="logo">
        <span class="logo-icon">🧠</span>
        <span class="logo-text" id="brainName">Brain Studio</span>
      </div>

      <div class="tabs">
        <button class="tab active" data-tab="explore">
          <span>🔭</span> Explore
        </button>
        <button class="tab" data-tab="chat">
          <span>💬</span> Chat
        </button>
        <button class="tab" data-tab="outputs">
          <span>📁</span> Outputs
        </button>
      </div>

      <div class="stats">
        <div class="stat">
          <div class="stat-value" id="statNodes">-</div>
          <div class="stat-label">Nodes</div>
        </div>
        <div class="stat">
          <div class="stat-value" id="statEdges">-</div>
          <div class="stat-label">Edges</div>
        </div>
        <div class="stat">
          <div class="stat-value" id="statCycles">-</div>
          <div class="stat-label">Cycles</div>
        </div>
      </div>
    </header>

    <div class="main">
      <!-- EXPLORE PANEL -->
      <div class="panel explore-panel active" id="explorePanel">
        <aside class="sidebar">
          <div class="search-box">
            <input type="text" id="searchInput" placeholder="Search knowledge...">
          </div>
          <div class="filter-row">
            <select id="tagFilter">
              <option value="">All tags</option>
            </select>
          </div>
          <div class="node-list" id="nodeList"></div>
        </aside>

        <div class="graph-container">
          <svg id="graph"></svg>
          <div class="graph-controls">
            <button class="graph-btn" onclick="resetZoom()">⟲ Reset</button>
            <button class="graph-btn" onclick="toggleLabels()">🏷️ Labels</button>
          </div>
        </div>

        <aside class="detail-panel">
          <div id="detailContent">
            <div class="empty-state">
              <div class="empty-icon">👆</div>
              <div class="empty-title">Select a node</div>
              <div class="empty-subtitle">Click on a node in the graph or list to view its details and connections</div>
            </div>
          </div>
        </aside>
      </div>

      <!-- CHAT PANEL -->
      <div class="panel chat-panel" id="chatPanel">
        <div class="chat-main">
          <div class="chat-messages" id="chatMessages">
            <div class="message assistant">
              <div class="message-content">
                <strong>Hello! I'm your brain assistant.</strong><br><br>
                I can help you explore and understand this knowledge base. Ask me anything about what's in here, and I'll search through the nodes to find relevant information.<br><br>
                Try asking:
                <ul style="margin-top: 12px; margin-left: 20px;">
                  <li>What do you know about [topic]?</li>
                  <li>Summarize the key insights</li>
                  <li>What are the main themes?</li>
                </ul>
              </div>
            </div>
          </div>
          <div class="chat-input-area">
            <div class="chat-input-wrapper">
              <textarea class="chat-input" id="chatInput" placeholder="Ask the brain..." rows="1"></textarea>
              <button class="chat-send" id="chatSend" onclick="sendMessage()">Ask →</button>
            </div>
          </div>
        </div>
        <aside class="chat-context">
          <div class="context-section">
            <div class="context-title">🧠 Brain Context</div>
            <div id="contextNodes">
              <div class="empty-state" style="padding: 20px;">
                <div class="empty-subtitle">Ask a question to see relevant knowledge nodes</div>
              </div>
            </div>
          </div>
        </aside>
      </div>

      <!-- OUTPUTS PANEL -->
      <div class="panel outputs-panel" id="outputsPanel">
        <aside class="sidebar">
          <div class="search-box">
            <input type="text" id="outputSearch" placeholder="Search files...">
          </div>
          <div class="file-list" id="fileList"></div>
        </aside>
        <div class="file-preview" id="filePreview">
          <div class="empty-state">
            <div class="empty-icon">📄</div>
            <div class="empty-title">Select a file</div>
            <div class="empty-subtitle">Choose a file from the list to preview its contents</div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    // ========== STATE ==========
    let nodes = [];
    let selectedNode = null;
    let showLabels = true;
    let simulation = null;
    let svg, g, zoom;
    let outputs = [];
    let chatHistory = [];

    // ========== API ==========
    async function api(endpoint) {
      const res = await fetch('/api' + endpoint);
      return res.json();
    }

    // ========== INIT ==========
    async function init() {
      // Load manifest
      const manifest = await api('/manifest');
      document.getElementById('brainName').textContent = manifest.brain?.displayName || manifest.brain?.name || 'Brain';
      document.title = '🧠 ' + (manifest.brain?.name || 'Brain') + ' - Brain Studio';

      // Load stats
      const stats = await api('/stats');
      document.getElementById('statNodes').textContent = stats.nodes.toLocaleString();
      document.getElementById('statEdges').textContent = stats.edges.toLocaleString();
      document.getElementById('statCycles').textContent = stats.cycles.toLocaleString();

      // Load tags
      const tags = await api('/tags');
      const tagSelect = document.getElementById('tagFilter');
      tags.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.tag;
        opt.textContent = t.tag + ' (' + t.count + ')';
        tagSelect.appendChild(opt);
      });

      // Load outputs
      outputs = await api('/outputs');
      renderFileList();

      // Load nodes
      await loadNodes();

      // Init graph
      await initGraph();

      // Event listeners
      document.getElementById('searchInput').addEventListener('input', debounce(loadNodes, 300));
      document.getElementById('tagFilter').addEventListener('change', loadNodes);
      document.getElementById('outputSearch').addEventListener('input', debounce(renderFileList, 300));
      document.getElementById('chatInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      });

      // Tab switching
      document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => switchTab(tab.dataset.tab));
      });
    }

    function switchTab(tabName) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      
      document.querySelector(\`.tab[data-tab="\${tabName}"]\`).classList.add('active');
      document.getElementById(tabName + 'Panel').classList.add('active');

      if (tabName === 'explore' && simulation) {
        simulation.alpha(0.3).restart();
      }
    }

    // ========== EXPLORE ==========
    async function loadNodes(reset = true) {
      const search = document.getElementById('searchInput').value;
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

      list.innerHTML = nodes.map(n => \`
        <div class="node-item \${selectedNode?.id === n.id ? 'selected' : ''}" onclick="selectNode('\${n.id}')">
          <div class="node-concept">\${escapeHtml(n.concept || 'No concept')}</div>
          <div class="node-meta">
            <span class="node-tag">\${n.tag || 'unknown'}</span>
            <span>w: \${(n.weight || 0).toFixed(2)}</span>
          </div>
        </div>
      \`).join('');
    }

    async function selectNode(nodeId) {
      const data = await api('/nodes/' + nodeId);
      if (!data) return;

      selectedNode = data;
      renderNodeList();
      renderDetail(data);
      highlightNode(nodeId);
    }

    function renderDetail(node) {
      document.getElementById('detailContent').innerHTML = \`
        <div class="detail-header">
          <div class="detail-title">Node #\${node.id}</div>
        </div>

        <div class="detail-section">
          <h3>Concept</h3>
          <div class="detail-content">\${escapeHtml(node.concept || 'No concept')}</div>
        </div>

        <div class="detail-section">
          <h3>Metadata</h3>
          <div class="detail-meta">
            <div class="meta-item">
              <div class="meta-label">Tag</div>
              <div class="meta-value">\${node.tag || 'unknown'}</div>
            </div>
            <div class="meta-item">
              <div class="meta-label">Weight</div>
              <div class="meta-value">\${(node.weight || 0).toFixed(3)}</div>
            </div>
            <div class="meta-item">
              <div class="meta-label">Activation</div>
              <div class="meta-value">\${(node.activation || 0).toFixed(3)}</div>
            </div>
            <div class="meta-item">
              <div class="meta-label">Cluster</div>
              <div class="meta-value">\${node.cluster ?? '-'}</div>
            </div>
          </div>
        </div>

        <div class="detail-section">
          <h3>Connections (\${node.connections?.length || 0})</h3>
          <div class="connections-list">
            \${(node.connections || []).slice(0, 20).map(c => \`
              <div class="connection-item" onclick="selectNode('\${c.nodeId}')">
                Node #\${c.nodeId} <span style="color: var(--text-muted)">(w: \${(c.weight || 0).toFixed(2)})</span>
              </div>
            \`).join('') || '<div style="color: var(--text-muted); padding: 12px;">No connections</div>'}
          </div>
        </div>
      \`;
    }

    // ========== GRAPH ==========
    async function initGraph() {
      const container = document.querySelector('.graph-container');
      const width = container.clientWidth;
      const height = container.clientHeight;

      svg = d3.select('#graph').attr('width', width).attr('height', height);

      zoom = d3.zoom()
        .scaleExtent([0.1, 4])
        .on('zoom', (event) => g.attr('transform', event.transform));

      svg.call(zoom);
      g = svg.append('g');

      const data = await api('/graph?maxNodes=150');

      const tags = [...new Set(data.nodes.map(n => n.tag))];
      const color = d3.scaleOrdinal()
        .domain(tags)
        .range(['#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#6366f1', '#84cc16']);

      simulation = d3.forceSimulation(data.nodes)
        .force('link', d3.forceLink(data.edges).id(d => d.id).distance(100))
        .force('charge', d3.forceManyBody().strength(-300))
        .force('center', d3.forceCenter(width / 2, height / 2))
        .force('collision', d3.forceCollide().radius(35));

      const link = g.append('g')
        .selectAll('line')
        .data(data.edges)
        .join('line')
        .attr('stroke', 'rgba(139, 92, 246, 0.2)')
        .attr('stroke-width', d => Math.sqrt(d.weight || 1));

      const node = g.append('g')
        .selectAll('circle')
        .data(data.nodes)
        .join('circle')
        .attr('r', d => 6 + Math.sqrt(d.activation || 1) * 4)
        .attr('fill', d => color(d.tag))
        .attr('stroke', 'rgba(255,255,255,0.3)')
        .attr('stroke-width', 2)
        .style('cursor', 'pointer')
        .style('filter', 'drop-shadow(0 0 4px rgba(139, 92, 246, 0.5))')
        .on('click', (event, d) => selectNode(d.id))
        .call(drag(simulation));

      node.append('title').text(d => d.label);

      const label = g.append('g')
        .attr('class', 'labels')
        .selectAll('text')
        .data(data.nodes)
        .join('text')
        .text(d => d.label?.slice(0, 25) || '')
        .attr('font-size', 10)
        .attr('fill', 'rgba(255,255,255,0.6)')
        .attr('dx', 12)
        .attr('dy', 4);

      simulation.on('tick', () => {
        link.attr('x1', d => d.source.x).attr('y1', d => d.source.y)
            .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
        node.attr('cx', d => d.x).attr('cy', d => d.y);
        label.attr('x', d => d.x).attr('y', d => d.y);
      });
    }

    function drag(simulation) {
      return d3.drag()
        .on('start', (event) => {
          if (!event.active) simulation.alphaTarget(0.3).restart();
          event.subject.fx = event.subject.x;
          event.subject.fy = event.subject.y;
        })
        .on('drag', (event) => {
          event.subject.fx = event.x;
          event.subject.fy = event.y;
        })
        .on('end', (event) => {
          if (!event.active) simulation.alphaTarget(0);
          event.subject.fx = null;
          event.subject.fy = null;
        });
    }

    function highlightNode(nodeId) {
      g.selectAll('circle')
        .attr('stroke-width', d => d.id === nodeId ? 4 : 2)
        .attr('stroke', d => d.id === nodeId ? '#fff' : 'rgba(255,255,255,0.3)');
    }

    function resetZoom() {
      svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity);
    }

    function toggleLabels() {
      showLabels = !showLabels;
      g.select('.labels').style('display', showLabels ? 'block' : 'none');
    }

    // ========== CHAT ==========
    async function sendMessage() {
      const input = document.getElementById('chatInput');
      const message = input.value.trim();
      if (!message) return;

      input.value = '';
      input.style.height = 'auto';

      // Add user message
      addChatMessage('user', message);

      // Disable send button
      document.getElementById('chatSend').disabled = true;

      // Search for relevant nodes
      const searchRes = await api('/search?q=' + encodeURIComponent(message) + '&limit=8');
      const relevantNodes = searchRes || [];

      // Show context
      renderContext(relevantNodes);

      // Generate response (simplified RAG)
      const response = generateResponse(message, relevantNodes);
      
      addChatMessage('assistant', response, relevantNodes);

      document.getElementById('chatSend').disabled = false;
    }

    function generateResponse(query, nodes) {
      if (nodes.length === 0) {
        return "I couldn't find any relevant information about that in this brain. Try asking about something else, or explore the nodes in the Explore tab to see what knowledge is available.";
      }

      let response = "Based on what I found in this brain:\\n\\n";
      
      // Summarize key points from nodes
      const keyPoints = nodes.slice(0, 5).map(n => {
        const concept = n.concept || '';
        // Extract first sentence or meaningful chunk
        const firstSentence = concept.split(/[.!?]\\n/)[0];
        return '• ' + (firstSentence.length > 200 ? firstSentence.slice(0, 200) + '...' : firstSentence);
      });

      response += keyPoints.join('\\n\\n');

      if (nodes.length > 5) {
        response += '\\n\\n*(' + (nodes.length - 5) + ' more related nodes found)*';
      }

      return response;
    }

    function addChatMessage(role, content, sources = null) {
      const messages = document.getElementById('chatMessages');
      
      let html = \`
        <div class="message \${role}">
          <div class="message-content">\${escapeHtml(content).replace(/\\n/g, '<br>')}</div>
      \`;

      if (sources && sources.length > 0) {
        html += \`
          <div class="message-sources">
            <div class="message-sources-title">📚 Sources (\${sources.length} nodes)</div>
            \${sources.slice(0, 3).map(n => \`
              <div class="source-node" onclick="switchTab('explore'); selectNode('\${n.id}')">
                <strong>#\${n.id}</strong> - \${escapeHtml((n.concept || '').slice(0, 80))}...
              </div>
            \`).join('')}
          </div>
        \`;
      }

      html += '</div>';
      messages.insertAdjacentHTML('beforeend', html);
      messages.scrollTop = messages.scrollHeight;
    }

    function renderContext(nodes) {
      const container = document.getElementById('contextNodes');
      
      if (nodes.length === 0) {
        container.innerHTML = '<div style="color: var(--text-muted); padding: 12px;">No relevant nodes found</div>';
        return;
      }

      container.innerHTML = nodes.map(n => \`
        <div class="context-node" onclick="switchTab('explore'); selectNode('\${n.id}')" style="cursor: pointer;">
          <div style="font-weight: 500; margin-bottom: 4px; color: var(--accent-bright);">#\${n.id} · \${n.tag || 'unknown'}</div>
          <div style="font-size: 12px; color: var(--text-secondary);">\${escapeHtml((n.concept || '').slice(0, 150))}...</div>
        </div>
      \`).join('');
    }

    // ========== OUTPUTS ==========
    function renderFileList() {
      const search = document.getElementById('outputSearch')?.value?.toLowerCase() || '';
      const filtered = outputs.filter(f => f.name.toLowerCase().includes(search));
      
      const list = document.getElementById('fileList');
      
      if (filtered.length === 0) {
        list.innerHTML = '<div class="empty-state"><div class="empty-icon">📁</div><div class="empty-title">No files found</div></div>';
        return;
      }

      const icons = {
        markdown: '📝',
        text: '📄',
        json: '📊',
        python: '🐍',
        javascript: '📜',
        html: '🌐',
        data: '📈',
        image: '🖼️',
        bibliography: '📚',
        other: '📎',
      };

      list.innerHTML = filtered.map(f => \`
        <div class="file-item" onclick="previewFile('\${escapeHtml(f.path)}')">
          <div class="file-icon">\${icons[f.type] || icons.other}</div>
          <div class="file-info">
            <div class="file-name">\${escapeHtml(f.name)}</div>
            <div class="file-meta">\${formatBytes(f.size)}</div>
          </div>
        </div>
      \`).join('');
    }

    async function previewFile(filePath) {
      const preview = document.getElementById('filePreview');
      preview.innerHTML = '<div class="empty-state"><div class="loading"></div></div>';

      try {
        const content = await (await fetch('/api/output?path=' + encodeURIComponent(filePath))).text();
        const file = outputs.find(f => f.path === filePath);
        
        if (file?.type === 'markdown') {
          preview.innerHTML = '<div class="preview-markdown">' + marked.parse(content) + '</div>';
        } else {
          preview.innerHTML = '<pre class="preview-content">' + escapeHtml(content) + '</pre>';
        }
      } catch (e) {
        preview.innerHTML = '<div class="empty-state"><div class="empty-icon">❌</div><div class="empty-title">Could not load file</div></div>';
      }
    }

    // ========== UTILS ==========
    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function debounce(fn, delay) {
      let timeout;
      return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => fn.apply(this, args), delay);
      };
    }

    function formatBytes(bytes) {
      if (bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    // ========== START ==========
    init();
  </script>
</body>
</html>`;
}

// ============================================================================
// Server (Enhanced)
// ============================================================================

async function startServer(brainPath) {
  const loader = new BrainLoader(brainPath);
  await loader.load();

  const brainName = loader.manifest?.brain?.name || path.basename(brainPath);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = url.pathname;

    res.setHeader('Access-Control-Allow-Origin', '*');

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

      if (pathname === '/api/search') {
        const query = url.searchParams.get('q') || '';
        const limit = parseInt(url.searchParams.get('limit')) || 10;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(loader.searchRelevant(query, limit)));
        return;
      }

      if (pathname === '/api/outputs') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(loader.getOutputs()));
        return;
      }

      if (pathname === '/api/output') {
        const filePath = url.searchParams.get('path');
        const content = await loader.getOutputContent(filePath);
        if (content === null) {
          res.statusCode = 404;
          res.end('File not found');
          return;
        }
        res.setHeader('Content-Type', 'text/plain');
        res.end(content);
        return;
      }

      if (pathname === '/api/journal') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(loader.getJournal()));
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
    console.log('║                    🧠 BRAIN STUDIO                           ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log('║                                                              ║');
    console.log(`║  Brain:     ${brainName.padEnd(47)}║`);
    console.log(`║  Nodes:     ${loader.getStats().nodes.toLocaleString().padEnd(47)}║`);
    console.log(`║  Edges:     ${loader.getStats().edges.toLocaleString().padEnd(47)}║`);
    console.log(`║  Outputs:   ${loader.getStats().outputs.toLocaleString().padEnd(47)}║`);
    console.log('║                                                              ║');
    console.log(`║  🌐 Open: http://localhost:${PORT}`.padEnd(63) + '║');
    console.log('║                                                              ║');
    console.log('║  Tabs:                                                       ║');
    console.log('║    🔭 Explore - Visual knowledge graph                       ║');
    console.log('║    💬 Chat    - Ask the brain questions                      ║');
    console.log('║    📁 Outputs - Browse generated artifacts                   ║');
    console.log('║                                                              ║');
    console.log('║  Press Ctrl+C to stop                                        ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log('');
  });
}

// ============================================================================
// CLI
// ============================================================================

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`
🧠 BRAIN STUDIO

An adaptive workspace for interacting with .brain packages.

USAGE:
  node scripts/brain-studio.js <brain-path>

FEATURES:
  🔭 EXPLORE  - Visual knowledge graph with search and filtering
  💬 CHAT     - Ask questions and get answers from the brain (RAG)
  📁 OUTPUTS  - Browse and preview generated artifacts

EXAMPLES:
  node scripts/brain-studio.js ./runs/Physics2
  node scripts/brain-studio.js ./my-brain.brain

Opens at http://localhost:3399
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

