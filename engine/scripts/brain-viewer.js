#!/usr/bin/env node

/**
 * COSMO Brain Viewer
 * 
 * A clean, local web interface for exploring .brain packages.
 * 
 * Usage:
 *   node scripts/brain-viewer.js <brain-path>
 *   node scripts/brain-viewer.js ./Physics2.brain
 *   node scripts/brain-viewer.js ./runs/Physics2
 * 
 * Opens a local web server with an interactive brain explorer.
 */

const http = require('http');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');

const gunzip = promisify(zlib.gunzip);

// ============================================================================
// Configuration
// ============================================================================

const PORT = process.env.PORT || 3399;

// ============================================================================
// Brain Loader
// ============================================================================

class BrainLoader {
  constructor(brainPath) {
    this.brainPath = path.resolve(brainPath);
    this.manifest = null;
    this.state = null;
    this.isBrainFormat = false;
  }

  async load() {
    // Check if it's a .brain format or a run folder
    const manifestPath = path.join(this.brainPath, 'manifest.json');
    const statePath = path.join(this.brainPath, 'state.json.gz');

    if (fsSync.existsSync(manifestPath)) {
      this.isBrainFormat = true;
      this.manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    }

    if (!fsSync.existsSync(statePath)) {
      throw new Error('No state.json.gz found');
    }

    // Load state
    const compressed = await fs.readFile(statePath);
    const decompressed = await gunzip(compressed);
    this.state = JSON.parse(decompressed.toString());

    // If no manifest, create one from state
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

    return this;
  }

  getManifest() {
    return this.manifest;
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

    // Find connected edges
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

  getEdges(options = {}) {
    const edges = this.state.memory?.edges || [];
    const { limit = 500 } = options;
    return edges.slice(0, limit);
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

    // Get top nodes by activation/weight
    const sortedNodes = [...nodes]
      .sort((a, b) => (b.activation || 0) - (a.activation || 0))
      .slice(0, maxNodes);

    const nodeIds = new Set(sortedNodes.map(n => String(n.id)));

    // Filter edges to only include visible nodes
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
  <title>🧠 ${brainName} - Brain Viewer</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.8.5/d3.min.js"></script>
  <style>
    :root {
      --bg-primary: #0a0a0f;
      --bg-secondary: #12121a;
      --bg-tertiary: #1a1a25;
      --text-primary: #e8e8f0;
      --text-secondary: #8888a0;
      --accent: #6366f1;
      --accent-dim: #4f46e5;
      --success: #10b981;
      --border: #2a2a3a;
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      min-height: 100vh;
      overflow: hidden;
    }

    .app {
      display: grid;
      grid-template-columns: 320px 1fr 380px;
      grid-template-rows: 60px 1fr;
      height: 100vh;
    }

    /* Header */
    .header {
      grid-column: 1 / -1;
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      padding: 0 24px;
      gap: 24px;
    }

    .logo {
      font-size: 24px;
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .brain-name {
      font-size: 18px;
      font-weight: 600;
      color: var(--accent);
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
      font-size: 20px;
      font-weight: 700;
      color: var(--accent);
    }

    .stat-label {
      font-size: 11px;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    /* Sidebar */
    .sidebar {
      background: var(--bg-secondary);
      border-right: 1px solid var(--border);
      overflow-y: auto;
      padding: 16px;
    }

    .search-box {
      position: relative;
      margin-bottom: 16px;
    }

    .search-box input {
      width: 100%;
      padding: 12px 16px;
      padding-left: 40px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text-primary);
      font-size: 14px;
      outline: none;
      transition: border-color 0.2s;
    }

    .search-box input:focus {
      border-color: var(--accent);
    }

    .search-box::before {
      content: '🔍';
      position: absolute;
      left: 12px;
      top: 50%;
      transform: translateY(-50%);
      font-size: 14px;
    }

    .tag-filter {
      margin-bottom: 16px;
    }

    .tag-filter select {
      width: 100%;
      padding: 10px 12px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text-primary);
      font-size: 14px;
      cursor: pointer;
    }

    .node-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .node-item {
      padding: 12px;
      background: var(--bg-tertiary);
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s;
      border: 1px solid transparent;
    }

    .node-item:hover {
      border-color: var(--accent-dim);
      transform: translateX(4px);
    }

    .node-item.selected {
      border-color: var(--accent);
      background: rgba(99, 102, 241, 0.1);
    }

    .node-concept {
      font-size: 13px;
      line-height: 1.4;
      margin-bottom: 6px;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .node-meta {
      display: flex;
      gap: 8px;
      font-size: 11px;
      color: var(--text-secondary);
    }

    .node-tag {
      background: var(--bg-primary);
      padding: 2px 8px;
      border-radius: 4px;
    }

    .load-more {
      padding: 12px;
      text-align: center;
      color: var(--accent);
      cursor: pointer;
      font-size: 13px;
    }

    .load-more:hover {
      text-decoration: underline;
    }

    /* Graph */
    .graph-container {
      position: relative;
      background: var(--bg-primary);
      overflow: hidden;
    }

    #graph {
      width: 100%;
      height: 100%;
    }

    .graph-controls {
      position: absolute;
      bottom: 20px;
      left: 20px;
      display: flex;
      gap: 8px;
    }

    .graph-btn {
      padding: 8px 16px;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text-primary);
      cursor: pointer;
      font-size: 13px;
      transition: all 0.2s;
    }

    .graph-btn:hover {
      background: var(--bg-tertiary);
      border-color: var(--accent);
    }

    /* Detail Panel */
    .detail-panel {
      background: var(--bg-secondary);
      border-left: 1px solid var(--border);
      overflow-y: auto;
      padding: 20px;
    }

    .detail-header {
      margin-bottom: 20px;
    }

    .detail-title {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 8px;
      color: var(--accent);
    }

    .detail-section {
      margin-bottom: 24px;
    }

    .detail-section h3 {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--text-secondary);
      margin-bottom: 12px;
    }

    .detail-content {
      font-size: 14px;
      line-height: 1.6;
      padding: 12px;
      background: var(--bg-tertiary);
      border-radius: 8px;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .detail-meta {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }

    .meta-item {
      padding: 12px;
      background: var(--bg-tertiary);
      border-radius: 8px;
    }

    .meta-label {
      font-size: 11px;
      color: var(--text-secondary);
      margin-bottom: 4px;
    }

    .meta-value {
      font-size: 14px;
      font-weight: 600;
    }

    .connections-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .connection-item {
      padding: 10px;
      background: var(--bg-tertiary);
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.2s;
      font-size: 13px;
    }

    .connection-item:hover {
      background: var(--bg-primary);
    }

    .empty-state {
      text-align: center;
      padding: 40px;
      color: var(--text-secondary);
    }

    .empty-state .icon {
      font-size: 48px;
      margin-bottom: 16px;
    }

    /* Scrollbar */
    ::-webkit-scrollbar {
      width: 8px;
    }

    ::-webkit-scrollbar-track {
      background: var(--bg-primary);
    }

    ::-webkit-scrollbar-thumb {
      background: var(--border);
      border-radius: 4px;
    }

    ::-webkit-scrollbar-thumb:hover {
      background: var(--accent-dim);
    }
  </style>
</head>
<body>
  <div class="app">
    <header class="header">
      <div class="logo">
        <span>🧠</span>
        <span class="brain-name" id="brainName">Loading...</span>
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

    <aside class="sidebar">
      <div class="search-box">
        <input type="text" id="searchInput" placeholder="Search nodes...">
      </div>
      <div class="tag-filter">
        <select id="tagFilter">
          <option value="">All tags</option>
        </select>
      </div>
      <div class="node-list" id="nodeList">
        <div class="empty-state">
          <div class="icon">📚</div>
          <p>Loading nodes...</p>
        </div>
      </div>
      <div class="load-more" id="loadMore" style="display:none;">Load more...</div>
    </aside>

    <main class="graph-container">
      <svg id="graph"></svg>
      <div class="graph-controls">
        <button class="graph-btn" onclick="resetZoom()">Reset View</button>
        <button class="graph-btn" onclick="toggleLabels()">Toggle Labels</button>
      </div>
    </main>

    <aside class="detail-panel">
      <div id="detailContent">
        <div class="empty-state">
          <div class="icon">👆</div>
          <p>Select a node to view details</p>
        </div>
      </div>
    </aside>
  </div>

  <script>
    // State
    let nodes = [];
    let currentOffset = 0;
    let selectedNode = null;
    let showLabels = true;
    let simulation = null;
    let svg, g, zoom;

    // API
    async function api(endpoint) {
      const res = await fetch('/api' + endpoint);
      return res.json();
    }

    // Initialize
    async function init() {
      // Load manifest
      const manifest = await api('/manifest');
      document.getElementById('brainName').textContent = manifest.brain?.displayName || manifest.brain?.name || 'Brain';
      document.title = '🧠 ' + (manifest.brain?.name || 'Brain') + ' - Brain Viewer';

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

      // Load initial nodes
      await loadNodes();

      // Initialize graph
      await initGraph();

      // Event listeners
      document.getElementById('searchInput').addEventListener('input', debounce(loadNodes, 300));
      document.getElementById('tagFilter').addEventListener('change', loadNodes);
      document.getElementById('loadMore').addEventListener('click', loadMoreNodes);
    }

    async function loadNodes(reset = true) {
      if (reset) currentOffset = 0;

      const search = document.getElementById('searchInput').value;
      const tag = document.getElementById('tagFilter').value;

      const params = new URLSearchParams();
      if (search) params.set('search', search);
      if (tag) params.set('tag', tag);
      params.set('offset', currentOffset);
      params.set('limit', 50);

      const data = await api('/nodes?' + params.toString());

      if (reset) {
        nodes = data.nodes;
      } else {
        nodes = [...nodes, ...data.nodes];
      }

      renderNodeList();

      // Show/hide load more
      const loadMore = document.getElementById('loadMore');
      loadMore.style.display = nodes.length < data.total ? 'block' : 'none';
    }

    async function loadMoreNodes() {
      currentOffset += 50;
      await loadNodes(false);
    }

    function renderNodeList() {
      const list = document.getElementById('nodeList');

      if (nodes.length === 0) {
        list.innerHTML = '<div class="empty-state"><div class="icon">🔍</div><p>No nodes found</p></div>';
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
      const detail = document.getElementById('detailContent');

      detail.innerHTML = \`
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
                → Node #\${c.nodeId} (w: \${(c.weight || 0).toFixed(2)})
              </div>
            \`).join('') || '<div class="empty-state">No connections</div>'}
          </div>
        </div>
      \`;
    }

    // Graph
    async function initGraph() {
      const container = document.querySelector('.graph-container');
      const width = container.clientWidth;
      const height = container.clientHeight;

      svg = d3.select('#graph')
        .attr('width', width)
        .attr('height', height);

      // Zoom behavior
      zoom = d3.zoom()
        .scaleExtent([0.1, 4])
        .on('zoom', (event) => {
          g.attr('transform', event.transform);
        });

      svg.call(zoom);

      g = svg.append('g');

      // Load graph data
      const data = await api('/graph?maxNodes=150');

      // Color scale by tag
      const tags = [...new Set(data.nodes.map(n => n.tag))];
      const color = d3.scaleOrdinal(d3.schemeTableau10).domain(tags);

      // Create simulation
      simulation = d3.forceSimulation(data.nodes)
        .force('link', d3.forceLink(data.edges).id(d => d.id).distance(80))
        .force('charge', d3.forceManyBody().strength(-200))
        .force('center', d3.forceCenter(width / 2, height / 2))
        .force('collision', d3.forceCollide().radius(30));

      // Draw edges
      const link = g.append('g')
        .attr('class', 'links')
        .selectAll('line')
        .data(data.edges)
        .join('line')
        .attr('stroke', '#2a2a3a')
        .attr('stroke-width', d => Math.sqrt(d.weight || 1));

      // Draw nodes
      const node = g.append('g')
        .attr('class', 'nodes')
        .selectAll('circle')
        .data(data.nodes)
        .join('circle')
        .attr('r', d => 5 + Math.sqrt(d.activation || 1) * 3)
        .attr('fill', d => color(d.tag))
        .attr('stroke', '#fff')
        .attr('stroke-width', 1.5)
        .style('cursor', 'pointer')
        .on('click', (event, d) => selectNode(d.id))
        .call(drag(simulation));

      node.append('title').text(d => d.label);

      // Labels
      const label = g.append('g')
        .attr('class', 'labels')
        .selectAll('text')
        .data(data.nodes)
        .join('text')
        .text(d => d.label?.slice(0, 20) || '')
        .attr('font-size', 9)
        .attr('fill', '#888')
        .attr('dx', 10)
        .attr('dy', 3);

      // Tick
      simulation.on('tick', () => {
        link
          .attr('x1', d => d.source.x)
          .attr('y1', d => d.source.y)
          .attr('x2', d => d.target.x)
          .attr('y2', d => d.target.y);

        node
          .attr('cx', d => d.x)
          .attr('cy', d => d.y);

        label
          .attr('x', d => d.x)
          .attr('y', d => d.y);
      });
    }

    function drag(simulation) {
      function dragstarted(event) {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        event.subject.fx = event.subject.x;
        event.subject.fy = event.subject.y;
      }

      function dragged(event) {
        event.subject.fx = event.x;
        event.subject.fy = event.y;
      }

      function dragended(event) {
        if (!event.active) simulation.alphaTarget(0);
        event.subject.fx = null;
        event.subject.fy = null;
      }

      return d3.drag()
        .on('start', dragstarted)
        .on('drag', dragged)
        .on('end', dragended);
    }

    function highlightNode(nodeId) {
      g.selectAll('circle')
        .attr('stroke-width', d => d.id === nodeId ? 3 : 1.5)
        .attr('stroke', d => d.id === nodeId ? '#6366f1' : '#fff');
    }

    function resetZoom() {
      svg.transition().duration(500).call(
        zoom.transform,
        d3.zoomIdentity
      );
    }

    function toggleLabels() {
      showLabels = !showLabels;
      g.select('.labels').style('display', showLabels ? 'block' : 'none');
    }

    // Utilities
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

    // Start
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

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = url.pathname;

    // CORS headers
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
          limit: parseInt(url.searchParams.get('limit')) || 50,
          offset: parseInt(url.searchParams.get('offset')) || 0,
        };
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(loader.getNodes(options)));
        return;
      }

      const nodeMatch = pathname.match(/^\/api\/nodes\/(.+)$/);
      if (nodeMatch) {
        const nodeId = nodeMatch[1];
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(loader.getNode(nodeId)));
        return;
      }

      if (pathname === '/api/graph') {
        const maxNodes = parseInt(url.searchParams.get('maxNodes')) || 150;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(loader.getGraphData(maxNodes)));
        return;
      }

      if (pathname === '/api/edges') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(loader.getEdges()));
        return;
      }

      res.statusCode = 404;
      res.end('Not found');
    } catch (error) {
      console.error('Error:', error);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: error.message }));
    }
  });

  server.listen(PORT, () => {
    console.log('');
    console.log('═'.repeat(60));
    console.log('  🧠 BRAIN VIEWER');
    console.log('═'.repeat(60));
    console.log('');
    console.log(`  Brain:    ${brainName}`);
    console.log(`  Nodes:    ${loader.getStats().nodes.toLocaleString()}`);
    console.log(`  Edges:    ${loader.getStats().edges.toLocaleString()}`);
    console.log('');
    console.log(`  🌐 Open: http://localhost:${PORT}`);
    console.log('');
    console.log('  Press Ctrl+C to stop');
    console.log('═'.repeat(60));
    console.log('');
  });
}

// ============================================================================
// CLI
// ============================================================================

function showHelp() {
  console.log(`
🧠 COSMO Brain Viewer

View and explore .brain packages in a clean web interface.

USAGE:
  node scripts/brain-viewer.js <brain-path>

EXAMPLES:
  node scripts/brain-viewer.js ./Physics2.brain
  node scripts/brain-viewer.js ./runs/Physics2

OPTIONS:
  --port, -p <port>    Server port (default: 3399)
  --help, -h           Show this help

The viewer will open at http://localhost:3399
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    showHelp();
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

