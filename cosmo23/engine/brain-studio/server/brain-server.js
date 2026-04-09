#!/usr/bin/env node

/**
 * Brain Studio Server
 * 
 * Modular, standalone server for exploring .brain packages.
 * Combines:
 * - Query Engine (Intelligence Dashboard) for knowledge interrogation
 * - File Browser (COSMO IDE v2) for file exploration
 * - Graph Visualization for network view
 * 
 * Architecture:
 * - server/ - Backend logic
 * - public/ - Frontend (HTML/CSS/JS)
 * - lib/ - Shared libraries (query-engine, GPT5, etc.)
 */

const http = require('http');
const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const zlib = require('zlib');
const { promisify } = require('util');
const OpenAI = require('openai');

// Import COSMO libraries (copied, not linked)
const { BrainQueryEngine } = require('../lib/brain-query-engine');
const BrainSemanticSearch = require('../lib/brain-semantic-search');
const BrainCoordinatorIndexer = require('../lib/brain-coordinator-indexer');
const BrainExporter = require('../lib/brain-exporter');

// Import AI handler (COSMO IDE v2)
const { handleFunctionCalling } = require('./ai-handler');

const gunzip = promisify(zlib.gunzip);

const PORT = process.env.PORT || 3399;
const ENV_OPENAI_KEY = process.env.OPENAI_API_KEY || '';

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

  async getFileContent(relativePath) {
    const fullPath = path.join(this.brainPath, relativePath);
    if (!fsSync.existsSync(fullPath)) return null;
    return await fs.readFile(fullPath, 'utf8');
  }
}

// ============================================================================
// Express Server
// ============================================================================

async function startServer(brainPath) {
  const app = express();
  const loader = new BrainLoader(brainPath);
  await loader.load();

  const brainName = loader.manifest?.brain?.displayName || loader.manifest?.brain?.name || path.basename(brainPath);

  // Initialize query engine
  const queryEngine = new BrainQueryEngine(path.resolve(brainPath), ENV_OPENAI_KEY);
  const exporter = new BrainExporter(loader);

  // Middleware
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '../public')));

  // ========== API Routes ==========

  app.get('/api/manifest', (req, res) => {
    res.json(loader.getManifest());
  });

  app.get('/api/stats', (req, res) => {
    res.json(loader.getStats());
  });

  app.get('/api/tree', (req, res) => {
    res.json(loader.getOutputTree());
  });

  app.get('/api/file', async (req, res) => {
    const filePath = req.query.path;
    const content = await loader.getFileContent(filePath);
    if (content === null) {
      return res.status(404).send('File not found');
    }
    res.send(content);
  });

  app.get('/api/tags', (req, res) => {
    res.json(loader.getTags());
  });

  app.get('/api/nodes', (req, res) => {
    const options = {
      search: req.query.search,
      tag: req.query.tag,
      limit: parseInt(req.query.limit) || 100,
      offset: parseInt(req.query.offset) || 0,
    };
    res.json(loader.getNodes(options));
  });

  app.get('/api/nodes/:id', (req, res) => {
    res.json(loader.getNode(req.params.id));
  });

  app.get('/api/graph', (req, res) => {
    const maxNodes = parseInt(req.query.maxNodes) || 150;
    res.json(loader.getGraphData(maxNodes));
  });

  // QUERY ENGINE ENDPOINT (uses COSMO's actual query-engine)
  app.post('/api/query', async (req, res) => {
    try {
      const result = await queryEngine.executeQuery(req.body.query, req.body);
      res.json(result);
    } catch (error) {
      console.error('[QUERY] Error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // AI CHAT ENDPOINT (COSMO IDE v2 Function Calling)
  app.post('/api/chat', async (req, res) => {
    try {
      const { messages, model } = req.body;
      
      // Set root path to brain directory for file operations
      req.body.rootPath = brainPath;
      
      // Use COSMO IDE v2 ai-handler (function calling with streaming)
      await handleFunctionCalling(req, res, messages || [], model || 'gpt-4o', brainPath);
    } catch (error) {
      console.error('[CHAT] Error:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: error.message });
      }
    }
  });

  // EXPORT ENDPOINT
  app.post('/api/export', async (req, res) => {
    try {
      const { format, options } = req.body;
      let result;
      
      if (format === 'markdown') {
        result = await exporter.exportMarkdown(options || {});
      } else if (format === 'bibtex') {
        result = await exporter.exportBibTeX();
      } else if (format === 'json') {
        result = await exporter.exportJSON(options || {});
      } else {
        return res.status(400).json({ error: `Unknown format: ${format}` });
      }

      res.json(result);
    } catch (error) {
      console.error('[EXPORT] Error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // AI CHAT ENDPOINT (COSMO IDE v2 Function Calling)
  app.post('/api/chat', async (req, res) => {
    try {
      const { messages, model } = req.body;
      
      // Set root path to brain directory for file operations
      req.body.rootPath = brainPath;
      
      // Use COSMO IDE v2 ai-handler (function calling with streaming)
      await handleFunctionCalling(req, res, messages || [], model || 'gpt-4o', brainPath);
    } catch (error) {
      console.error('[CHAT] Error:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: error.message });
      }
    }
  });

  // Start server
  const server = app.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║                🧠 BRAIN STUDIO                               ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log('║                                                              ║');
    console.log(`║  Brain:  ${brainName.padEnd(50)}║`);
    console.log(`║  Nodes:  ${loader.getStats().nodes.toLocaleString().padEnd(50)}║`);
    console.log(`║  Edges:  ${loader.getStats().edges.toLocaleString().padEnd(50)}║`);
    console.log('║                                                              ║');
    console.log(`║  🌐 http://localhost:${PORT}`.padEnd(63) + '║');
    console.log('║                                                              ║');
    console.log('║  📁 Files Tab    - Browse outputs with AI assistant          ║');
    console.log('║  💬 Query Tab    - Intelligence Dashboard query engine       ║');
    console.log('║  🔭 Explore Tab  - Knowledge graph visualization             ║');
    console.log('║                                                              ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log('');
  });
}

module.exports = { startServer };

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help') {
    console.log(`
🧠 BRAIN STUDIO

Standalone IDE for exploring .brain packages.

USAGE:
  node brain-studio/server/brain-server.js <brain-path>

EXAMPLES:
  node brain-studio/server/brain-server.js ./Physics2.brain
  node brain-studio/server/brain-server.js ./runs/Math2matics2
`);
    process.exit(0);
  }

  const brainPath = args[0];
  if (!fsSync.existsSync(brainPath)) {
    console.error(`❌ Path not found: ${brainPath}`);
    process.exit(1);
  }

  startServer(brainPath).catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
  });
}

