#!/usr/bin/env node

/**
 * COSMO Brain Query Tool
 * 
 * Clean, query-focused interface for interrogating brain knowledge.
 * Modeled after Intelligence Dashboard Query tab - NO file editing,
 * just pure knowledge extraction and synthesis.
 * 
 * Features:
 * - Query input with mode selection (fast/normal/deep)
 * - AI synthesis over semantic search
 * - Query history
 * - Export answers (markdown/json)
 * - Source citations
 * - Proper scrolling and UX
 * 
 * Usage:
 *   node scripts/brain-query.js <brain-path>
 */

const http = require('http');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const OpenAI = require('openai');

const BrainSemanticSearch = require('./brain-semantic-search');
const BrainCoordinatorIndexer = require('./brain-coordinator-indexer');

const gunzip = promisify(zlib.gunzip);

const PORT = process.env.PORT || 3399;
const ENV_OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const ENV_ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';

// ============================================================================
// Brain Loader (lightweight)
// ============================================================================

class BrainLoader {
  constructor(brainPath) {
    this.brainPath = path.resolve(brainPath);
    this.manifest = null;
    this.state = null;
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

    // Generate manifest if missing
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
        },
      };
    }

    return this;
  }

  getManifest() { return this.manifest; }
  
  getStats() {
    const nodes = this.state.memory?.nodes || [];
    const edges = this.state.memory?.edges || [];
    return {
      nodes: nodes.length,
      edges: edges.length,
      cycles: this.state.cycleCount || 0,
    };
  }

  initializeSemanticSearch(openaiClient) {
    if (!this.semanticSearch) {
      this.semanticSearch = new BrainSemanticSearch(this, openaiClient);
    }
    return this.semanticSearch;
  }

  initializeCoordinatorIndexer(openaiClient) {
    if (!this.coordinatorIndexer) {
      this.coordinatorIndexer = new BrainCoordinatorIndexer(this.brainPath, openaiClient);
    }
    return this.coordinatorIndexer;
  }

  searchRelevant(query, limit = 30) {
    const nodes = this.state.memory?.nodes || [];
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);

    const scored = nodes.map(node => {
      const concept = (node.concept || '').toLowerCase();
      let score = 0;
      if (concept.includes(queryLower)) score += 10;
      for (const word of queryWords) if (concept.includes(word)) score += 2;
      score *= (1 + (node.activation || 0));
      return { ...node, score };
    });

    return scored.filter(n => n.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

// ============================================================================
// Query Processor (simplified from query-engine.js)
// ============================================================================

async function processQuery(query, loader, options = {}) {
  const {
    model = 'gpt-4o',
    mode = 'normal',
    useSemanticSearch = true
  } = options;

  const startTime = Date.now();

  // Get relevant nodes (semantic or keyword)
  let sources = [];
  if (useSemanticSearch && ENV_OPENAI_KEY) {
    try {
      const openai = new OpenAI({ apiKey: ENV_OPENAI_KEY });
      const semanticSearch = loader.initializeSemanticSearch(openai);
      const result = await semanticSearch.search(query, { limit: 30 });
      sources = result.results;

      // Add connected nodes
      const connectedMap = new Map();
      for (const node of sources.slice(0, 10)) {
        const connected = semanticSearch.getConnectedNodes(node.id, 10);
        for (const conn of connected) {
          if (!connectedMap.has(conn.id) && !sources.find(s => s.id === conn.id)) {
            connectedMap.set(conn.id, conn);
          }
        }
      }
      
      sources = [...sources, ...Array.from(connectedMap.values()).slice(0, 30)];
    } catch (error) {
      console.error('[QUERY] Semantic search failed:', error.message);
      sources = loader.searchRelevant(query, 30);
    }
  } else {
    sources = loader.searchRelevant(query, 30);
  }

  // Build context
  const context = buildContext(sources);

  // Get AI answer
  const answer = await callAI(query, context, model, mode);

  const took = Date.now() - startTime;

  return {
    query,
    answer: answer.content,
    sources: sources.slice(0, 20),
    metadata: {
      model,
      mode,
      sourceCount: sources.length,
      took,
      timestamp: new Date().toISOString()
    }
  };
}

function buildContext(sources) {
  let sections = ['## Primary Knowledge Nodes\n'];
  
  for (const node of sources.slice(0, 30)) {
    sections.push(`[Node ${node.id}] (${node.tag || 'unknown'}${node.similarity ? `, ${(node.similarity * 100).toFixed(0)}% match` : ''})\n${node.concept || 'No content'}`);
  }
  
  if (sources.some(n => n.connectionWeight)) {
    sections.push('\n## Connected Concepts\n');
    for (const node of sources.filter(n => n.connectionWeight).slice(0, 30)) {
      sections.push(`[Node ${node.id}] (${node.tag || 'unknown'}, connection: ${(node.connectionWeight * 100).toFixed(0)}%)\n${(node.concept || '').slice(0, 200)}`);
    }
  }
  
  return sections.join('\n\n---\n\n');
}

async function callAI(query, context, model, mode) {
  const systemPrompt = getModePrompt(mode);
  const userPrompt = `${context}\n\nQuestion: ${query}`;

  if (model.includes('gpt')) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ENV_OPENAI_KEY}`
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: mode === 'fast' ? 0.5 : mode === 'deep' ? 0.8 : 0.7,
        max_tokens: mode === 'fast' ? 1500 : mode === 'deep' ? 3000 : 2000
      })
    });

    const data = await response.json();
    return { content: data.choices[0].message.content, usage: data.usage };
  }

  throw new Error('Only OpenAI models supported in query tool');
}

function getModePrompt(mode) {
  const base = `You are a knowledge synthesis assistant. Answer based on the provided knowledge nodes from a research brain. Always cite sources using [Node X] format.`;
  
  if (mode === 'fast') {
    return base + ` Be concise and direct.`;
  } else if (mode === 'deep') {
    return base + ` Provide comprehensive analysis with deep insights. Explore connections and implications.`;
  } else {
    return base + ` Be thorough but focused.`;
  }
}

// ============================================================================
// HTML Interface (Clean Intelligence Dashboard style)
// ============================================================================

function getHTML(brainName) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>🧠 ${brainName} - Brain Query</title>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0d1117;
      color: #c9d1d9;
      height: 100vh;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    /* Header */
    .header {
      background: #161b22;
      border-bottom: 1px solid #30363d;
      padding: 16px 24px;
      flex-shrink: 0;
    }

    .header h1 {
      font-size: 20px;
      font-weight: 600;
      color: #58a6ff;
    }

    .header p {
      font-size: 13px;
      color: #8b949e;
      margin-top: 4px;
    }

    /* Main Layout */
    .main {
      flex: 1;
      display: flex;
      overflow: hidden;
    }

    /* Query Panel (Left) */
    .query-panel {
      width: 400px;
      background: #161b22;
      border-right: 1px solid #30363d;
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
    }

    .query-input-section {
      padding: 20px;
      border-bottom: 1px solid #30363d;
      flex-shrink: 0;
    }

    .query-input {
      width: 100%;
      min-height: 100px;
      padding: 12px;
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 6px;
      color: #c9d1d9;
      font-family: inherit;
      font-size: 14px;
      resize: vertical;
      margin-bottom: 12px;
    }

    .query-input:focus {
      outline: none;
      border-color: #58a6ff;
    }

    .query-controls {
      display: flex;
      gap: 8px;
      margin-bottom: 12px;
    }

    select, .btn {
      padding: 8px 12px;
      background: #21262d;
      border: 1px solid #30363d;
      border-radius: 6px;
      color: #c9d1d9;
      font-size: 13px;
      cursor: pointer;
    }

    .btn-primary {
      background: #238636;
      border-color: #238636;
      color: white;
      font-weight: 600;
      flex: 1;
    }

    .btn-primary:hover {
      background: #2ea043;
    }

    .btn-primary:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    /* Query History */
    .query-history {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
    }

    .query-history-title {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      color: #8b949e;
      margin-bottom: 12px;
      letter-spacing: 0.5px;
    }

    .history-item {
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 6px;
      padding: 12px;
      margin-bottom: 8px;
      cursor: pointer;
      transition: all 0.2s;
    }

    .history-item:hover {
      border-color: #58a6ff;
      background: #161b22;
    }

    .history-query {
      font-size: 13px;
      color: #c9d1d9;
      margin-bottom: 6px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .history-meta {
      font-size: 11px;
      color: #6e7681;
    }

    /* Results Panel (Right) */
    .results-panel {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .results-header {
      padding: 16px 24px;
      background: #161b22;
      border-bottom: 1px solid #30363d;
      flex-shrink: 0;
    }

    .results-title {
      font-size: 16px;
      font-weight: 600;
    }

    /* THIS IS THE KEY - Results area MUST scroll */
    .results-area {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 24px;
      background: #0d1117;
    }

    .answer-card {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 24px;
      margin-bottom: 24px;
    }

    .answer-query {
      font-size: 18px;
      font-weight: 600;
      color: #58a6ff;
      margin-bottom: 16px;
    }

    .answer-content {
      font-size: 14px;
      line-height: 1.7;
      color: #c9d1d9;
    }

    .answer-content h1, .answer-content h2, .answer-content h3 {
      margin: 20px 0 12px;
      color: #58a6ff;
    }

    .answer-content p {
      margin: 12px 0;
    }

    .answer-content ul, .answer-content ol {
      margin: 12px 0 12px 24px;
    }

    .answer-content li {
      margin: 6px 0;
    }

    .answer-content code {
      background: #21262d;
      padding: 2px 6px;
      border-radius: 3px;
      font-family: monospace;
      color: #79c0ff;
    }

    .answer-content pre {
      background: #21262d;
      border: 1px solid #30363d;
      border-radius: 6px;
      padding: 16px;
      overflow-x: auto;
      margin: 16px 0;
    }

    .answer-content pre code {
      background: none;
      padding: 0;
    }

    .answer-metadata {
      margin-top: 20px;
      padding-top: 16px;
      border-top: 1px solid #30363d;
      font-size: 12px;
      color: #6e7681;
      display: flex;
      gap: 16px;
    }

    .answer-sources {
      margin-top: 20px;
      padding-top: 16px;
      border-top: 1px solid #30363d;
    }

    .sources-title {
      font-size: 13px;
      font-weight: 600;
      color: #8b949e;
      margin-bottom: 12px;
    }

    .source-node {
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 6px;
      padding: 12px;
      margin-bottom: 8px;
      font-size: 13px;
    }

    .source-node-header {
      font-weight: 600;
      color: #58a6ff;
      margin-bottom: 6px;
      font-size: 12px;
    }

    .source-node-content {
      color: #8b949e;
      line-height: 1.5;
    }

    .empty-state {
      text-align: center;
      padding: 80px 40px;
      color: #6e7681;
    }

    .empty-icon {
      font-size: 48px;
      margin-bottom: 16px;
      opacity: 0.5;
    }

    /* Loading */
    .loading {
      display: inline-block;
      width: 20px;
      height: 20px;
      border: 3px solid #30363d;
      border-radius: 50%;
      border-top-color: #58a6ff;
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    /* Scrollbar */
    ::-webkit-scrollbar { width: 8px; }
    ::-webkit-scrollbar-track { background: #0d1117; }
    ::-webkit-scrollbar-thumb { background: #30363d; border-radius: 4px; }
    ::-webkit-scrollbar-thumb:hover { background: #484f58; }
  </style>
</head>
<body>
  <header class="header">
    <h1>🧠 <span id="brainName">Brain Query</span></h1>
    <p><span id="brainStats">Loading...</span></p>
  </header>

  <div class="main">
    <!-- Left: Query Input & History -->
    <div class="query-panel">
      <div class="query-input-section">
        <textarea 
          id="queryInput" 
          class="query-input" 
          placeholder="Ask a question about this brain's knowledge...

Examples:
- What are the key concepts?
- Summarize the research findings
- What patterns emerged?"
        ></textarea>
        
        <div class="query-controls">
          <select id="queryMode">
            <option value="fast">⚡ Fast</option>
            <option value="normal" selected>🎯 Normal</option>
            <option value="deep">🔬 Deep</option>
          </select>
          <select id="queryModel">
            <option value="gpt-4o-mini">GPT-4o Mini</option>
            <option value="gpt-4o" selected>GPT-4o</option>
          </select>
        </div>
        
        <button id="askBtn" class="btn btn-primary" onclick="submitQuery()">
          🔍 Ask Brain
        </button>
      </div>

      <div class="query-history">
        <div class="query-history-title">Query History</div>
        <div id="historyList"></div>
      </div>
    </div>

    <!-- Right: Results -->
    <div class="results-panel">
      <div class="results-header">
        <div class="results-title" id="resultsTitle">Ready for your question</div>
      </div>
      
      <div class="results-area" id="resultsArea">
        <div class="empty-state">
          <div class="empty-icon">💬</div>
          <div style="font-size: 18px; margin-bottom: 8px;">Ask me anything</div>
          <div>I'll search the brain's knowledge and synthesize an answer</div>
        </div>
      </div>
    </div>
  </div>

  <script>
    let queryHistory = [];
    let currentBrainStats = {};

    async function init() {
      const manifest = await fetch('/api/manifest').then(r => r.json());
      const stats = await fetch('/api/stats').then(r => r.json());
      
      document.getElementById('brainName').textContent = manifest.brain?.displayName || 'Brain Query';
      document.getElementById('brainStats').textContent = \`\${stats.nodes.toLocaleString()} nodes · \${stats.edges.toLocaleString()} edges · \${stats.cycles.toLocaleString()} cycles\`;
      
      currentBrainStats = stats;
      
      // Keyboard shortcut
      document.getElementById('queryInput').addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          submitQuery();
        }
      });
    }

    async function submitQuery() {
      const input = document.getElementById('queryInput');
      const query = input.value.trim();
      if (!query) return;

      const mode = document.getElementById('queryMode').value;
      const model = document.getElementById('queryModel').value;
      const btn = document.getElementById('askBtn');

      // Disable during processing
      btn.disabled = true;
      btn.innerHTML = '<span class="loading"></span> Processing...';

      // Clear results and show loading
      const resultsArea = document.getElementById('resultsArea');
      resultsArea.innerHTML = '<div class="empty-state"><div class="loading"></div><div style="margin-top: 16px;">Searching knowledge graph and synthesizing answer...</div></div>';

      try {
        const res = await fetch('/api/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, mode, model, useSemanticSearch: true })
        });

        const result = await res.json();
        
        // Add to history
        queryHistory.unshift({ query, ...result });
        renderHistory();
        
        // Show result
        showResult(result);
        
        // Clear input
        input.value = '';

      } catch (error) {
        resultsArea.innerHTML = \`<div class="answer-card"><div class="answer-content" style="color: #f85149;">❌ Error: \${error.message}</div></div>\`;
      }

      btn.disabled = false;
      btn.textContent = '🔍 Ask Brain';
    }

    function showResult(result) {
      const resultsArea = document.getElementById('resultsArea');
      
      const html = \`
        <div class="answer-card">
          <div class="answer-query">\${escapeHtml(result.query)}</div>
          <div class="answer-content">\${marked.parse(result.answer)}</div>
          
          <div class="answer-metadata">
            <span>📊 \${result.sources.length} sources</span>
            <span>⚡ \${result.metadata.model}</span>
            <span>🕐 \${result.metadata.took}ms</span>
            <span>📅 \${new Date(result.metadata.timestamp).toLocaleTimeString()}</span>
          </div>
          
          \${result.sources.length > 0 ? \`
            <div class="answer-sources">
              <div class="sources-title">📚 Knowledge Sources (\${result.sources.length})</div>
              \${result.sources.slice(0, 10).map(s => \`
                <div class="source-node">
                  <div class="source-node-header">Node #\${s.id} · \${s.tag || 'unknown'}\${s.similarity ? \` · \${(s.similarity * 100).toFixed(0)}% match\` : ''}</div>
                  <div class="source-node-content">\${escapeHtml((s.concept || '').substring(0, 150))}\${s.concept?.length > 150 ? '...' : ''}</div>
                </div>
              \`).join('')}
            </div>
          \` : ''}
        </div>
      \`;
      
      resultsArea.innerHTML = html;
      resultsArea.scrollTop = 0; // Scroll to top of new result
    }

    function renderHistory() {
      const list = document.getElementById('historyList');
      if (queryHistory.length === 0) {
        list.innerHTML = '<div style="color: #6e7681; font-size: 13px; text-align: center; padding: 20px;">No queries yet</div>';
        return;
      }
      
      list.innerHTML = queryHistory.map((item, i) => \`
        <div class="history-item" onclick="showResult(queryHistory[\${i}])">
          <div class="history-query">\${escapeHtml(item.query)}</div>
          <div class="history-meta">\${item.metadata.mode} · \${item.sources.length} sources · \${new Date(item.metadata.timestamp).toLocaleTimeString()}</div>
        </div>
      \`).join('');
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text || '';
      return div.innerHTML;
    }

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

  const brainName = loader.manifest?.brain?.displayName || loader.manifest?.brain?.name || path.basename(brainPath);

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

      if (pathname === '/api/query' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { query, mode, model, useSemanticSearch } = JSON.parse(body);

        const result = await processQuery(query, loader, { mode, model, useSemanticSearch });

        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result));
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
    console.log('║                🧠 BRAIN QUERY TOOL                           ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log('║                                                              ║');
    console.log(`║  Brain:  ${brainName.padEnd(50)}║`);
    console.log(`║  Nodes:  ${loader.getStats().nodes.toLocaleString().padEnd(50)}║`);
    console.log('║                                                              ║');
    console.log(`║  🌐 Open: http://localhost:${PORT}`.padEnd(63) + '║');
    console.log('║                                                              ║');
    console.log('║  Focus: QUERY the brain\'s knowledge                          ║');
    console.log('║  • Semantic search over memory nodes                         ║');
    console.log('║  • AI synthesis with source citations                        ║');
    console.log('║  • Query history                                             ║');
    console.log('║  • Clean, scrolling interface                                ║');
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
🧠 BRAIN QUERY TOOL

Clean, query-focused interface for interrogating brain knowledge.
Modeled after Intelligence Dashboard - NO file editing, just knowledge extraction.

USAGE:
  node scripts/brain-query.js <brain-path>

EXAMPLES:
  node scripts/brain-query.js ./Physics2.brain
  node scripts/brain-query.js ./runs/Math2matics2
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
