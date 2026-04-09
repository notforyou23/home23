/**
 * Explore Tab
 * Knowledge graph visualization
 */

let simulation, svg, g, zoom;
let showLabels = true;

function initExploreTab() {
  const panel = document.getElementById('explore-panel');
  
  panel.innerHTML = `
    <div class="explore-layout">
      <!-- Left: Node List -->
      <aside class="explore-sidebar">
        <div class="sidebar-header">Knowledge Nodes</div>
        <input type="text" id="nodeSearch" placeholder="Search nodes..." class="search-input">
        <select id="tagFilter" class="tag-filter">
          <option value="">All tags</option>
        </select>
        <div id="nodeList" class="node-list"></div>
      </aside>

      <!-- Center: Graph -->
      <div class="graph-view">
        <svg id="graph"></svg>
        <div class="graph-controls">
          <button onclick="resetZoom()">⟲ Reset</button>
          <button onclick="toggleLabels()">🏷️ Labels</button>
        </div>
      </div>

      <!-- Right: Node Detail -->
      <aside class="explore-detail" id="nodeDetail">
        <div class="empty-state">
          <div class="empty-icon">👆</div>
          <div>Select a node</div>
        </div>
      </aside>
    </div>
  `;

  loadTags();
  loadNodes();
  
  // Setup search
  document.getElementById('nodeSearch').addEventListener('input', debounce(loadNodes, 300));
  document.getElementById('tagFilter').addEventListener('change', loadNodes);
}

async function loadTags() {
  const tags = await fetch('/api/tags').then(r => r.json());
  const select = document.getElementById('tagFilter');
  tags.forEach(t => {
    const opt = document.createElement('option');
    opt.value = t.tag;
    opt.textContent = `${t.tag} (${t.count})`;
    select.appendChild(opt);
  });
}

let nodes = [];

async function loadNodes() {
  const search = document.getElementById('nodeSearch').value;
  const tag = document.getElementById('tagFilter').value;
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (tag) params.set('tag', tag);
  params.set('limit', 100);

  const data = await fetch('/api/nodes?' + params.toString()).then(r => r.json());
  nodes = data.nodes;
  renderNodeList();
}

function renderNodeList() {
  const list = document.getElementById('nodeList');
  if (nodes.length === 0) {
    list.innerHTML = '<div class="empty-state"><div>No nodes found</div></div>';
    return;
  }
  list.innerHTML = nodes.map(n => `
    <div class="node-item" onclick="viewNode(${n.id})">
      <div class="node-concept">${escapeHtml(n.concept || 'No concept').substring(0, 100)}</div>
      <div class="node-meta">
        <span class="node-tag">${n.tag || 'unknown'}</span>
        <span>w: ${(n.weight || 0).toFixed(2)}</span>
      </div>
    </div>
  `).join('');
}

async function viewNode(nodeId) {
  const node = await fetch(`/api/nodes/${nodeId}`).then(r => r.json());
  if (!node) return;
  
  const detailDiv = document.getElementById('nodeDetail');
  detailDiv.innerHTML = `
    <div class="node-detail-header">Node #${node.id}</div>
    <div class="node-detail-section">
      <h4>Concept</h4>
      <p>${escapeHtml(node.concept || 'No concept')}</p>
    </div>
    <div class="node-detail-section">
      <h4>Metadata</h4>
      <div>Tag: ${node.tag || 'unknown'}</div>
      <div>Weight: ${(node.weight || 0).toFixed(3)}</div>
      <div>Activation: ${(node.activation || 0).toFixed(3)}</div>
      <div>Cluster: ${node.cluster ?? '-'}</div>
    </div>
    <div class="node-detail-section">
      <h4>Connections (${node.connections?.length || 0})</h4>
      ${(node.connections || []).slice(0, 10).map(c => `
        <div class="connection-item" onclick="viewNode(${c.nodeId})">
          → Node #${c.nodeId} (w: ${(c.weight || 0).toFixed(2)})
        </div>
      `).join('')}
    </div>
  `;

  initGraph();
}

async function initGraph() {
  if (simulation) return; // Already initialized

  const container = document.querySelector('.graph-view');
  const width = container.clientWidth;
  const height = container.clientHeight;

  svg = d3.select('#graph').attr('width', width).attr('height', height);
  zoom = d3.zoom().scaleExtent([0.1, 4]).on('zoom', (e) => g.attr('transform', e.transform));
  svg.call(zoom);
  g = svg.append('g');

  const data = await fetch('/api/graph?maxNodes=150').then(r => r.json());
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

  const label = g.append('g').attr('class', 'labels').selectAll('text').data(data.nodes).join('text')
    .text(d => d.label?.slice(0, 20) || '')
    .attr('font-size', 9).attr('fill', '#969696').attr('dx', 10).attr('dy', 3);

  simulation.on('tick', () => {
    link.attr('x1', d => d.source.x).attr('y1', d => d.source.y).attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    node.attr('cx', d => d.x).attr('cy', d => d.y);
    label.attr('x', d => d.x).attr('y', d => d.y);
  });
}

function resetZoom() { 
  if (svg) svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity); 
}

function toggleLabels() { 
  showLabels = !showLabels; 
  if (g) g.select('.labels').style('display', showLabels ? 'block' : 'none'); 
}

function sendFileMessage() {
  // Placeholder - can enhance with file context
  const input = document.getElementById('filesAIInput');
  const message = input.value.trim();
  if (!message) return;

  const container = document.getElementById('filesAIMessages');
  const userMsg = document.createElement('div');
  userMsg.className = 'ai-message user';
  userMsg.innerHTML = `<p>${escapeHtml(message)}</p>`;
  container.appendChild(userMsg);

  input.value = '';
  
  const assistantMsg = document.createElement('div');
  assistantMsg.className = 'ai-message assistant';
  assistantMsg.innerHTML = '<p>File AI coming soon. For now, use Query tab.</p>';
  container.appendChild(assistantMsg);
  
  container.scrollTop = container.scrollHeight;
}

function debounce(fn, delay) {
  let timer;
  return function(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}

