/**
 * Explore Tab - Memory Network Visualization
 * Based on intelligence.html memory tab design
 */

let simulation, svg, g, zoom;
let nodeElements, linkElements, labelElements;
let nodes = [];
let edges = [];
let allNodes = [];
let allEdges = [];
let selectedNode = null;
let currentFilter = 'all';
let nodeSize = 5;
let edgeOpacity = 0.2;
let showLabels = false;
let colorByClusters = false;

const colors = {
  analyst: '#4ec9b0',
  curiosity: '#dcdcaa',
  critic: '#ce9178',
  agent_finding: '#569cd6',
  default: '#858585'
};

function initExploreTab() {
  const panel = document.getElementById('explore-tab-panel');
  
  panel.innerHTML = `
    <div style="display: flex; flex-direction: column; height: 100%; background: var(--bg-primary);">
      
      <!-- Collapsible Controls Panel -->
      <div id="memory-controls" style="background: var(--bg-secondary); border-bottom: 1px solid var(--border-color);">
        <div onclick="toggleControls()" style="padding: 12px 20px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; user-select: none;">
          <div style="font-weight: 600; font-size: 14px; color: var(--text-primary);">🎛️ Controls & Filters</div>
          <span id="controls-icon" style="color: var(--text-secondary);">▼</span>
        </div>
        <div id="controls-content" style="padding: 16px 20px; border-top: 1px solid var(--border-color);">
          
          <!-- Search & Actions Row -->
          <div style="display: flex; gap: 12px; margin-bottom: 16px; align-items: end;">
            <div style="flex: 1;">
              <label style="font-size: 11px; color: var(--text-secondary); display: block; margin-bottom: 4px;">🔍 Search Concepts</label>
              <input type="text" id="memory-search" placeholder="Search nodes..." 
                onkeypress="if(event.key==='Enter') searchNodes()" 
                style="width: 100%; padding: 8px 12px; background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 4px; color: var(--text-primary); font-size: 13px;">
            </div>
            <div style="display: flex; gap: 8px;">
              <button onclick="renderNetwork()" class="btn-primary" style="padding: 8px 16px; white-space: nowrap;">Render</button>
              <button onclick="fitNetwork()" class="btn-secondary" style="padding: 8px 16px;">Fit</button>
              <button onclick="resetView()" class="btn-secondary" style="padding: 8px 16px;">Reset</button>
            </div>
          </div>
          
          <!-- Sliders Row -->
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px;">
            <div>
              <label style="font-size: 11px; color: var(--text-secondary); display: block; margin-bottom: 4px;">
                Node Size: <span id="node-size-value" style="color: var(--accent-primary);">5</span>
              </label>
              <input type="range" id="node-size-slider" min="1" max="10" value="5" step="0.5" 
                oninput="updateNodeSize(this.value)" style="width: 100%;">
            </div>
            <div>
              <label style="font-size: 11px; color: var(--text-secondary); display: block; margin-bottom: 4px;">
                Edge Opacity: <span id="edge-opacity-value" style="color: var(--accent-primary);">20%</span>
              </label>
              <input type="range" id="edge-opacity-slider" min="5" max="80" value="20" step="5" 
                oninput="updateEdgeOpacity(this.value)" style="width: 100%;">
            </div>
          </div>
          
          <!-- Toggles Row -->
          <div style="display: flex; gap: 16px; margin-bottom: 16px; font-size: 12px;">
            <label style="cursor: pointer; display: flex; align-items: center; gap: 6px;">
              <input type="checkbox" id="show-labels-check" onchange="toggleLabels(this.checked)">
              <span>Show Labels</span>
            </label>
            <label style="cursor: pointer; display: flex; align-items: center; gap: 6px;">
              <input type="checkbox" id="color-clusters-check" onchange="toggleClusters(this.checked)">
              <span>Color by Cluster</span>
            </label>
          </div>
          
          <!-- Type Filters -->
          <div>
            <div style="font-size: 11px; color: var(--text-secondary); margin-bottom: 8px;">Filter by Type:</div>
            <div style="display: flex; flex-wrap: wrap; gap: 8px;" id="filter-buttons">
              <button onclick="setFilter('all')" data-filter="all" class="filter-btn active">
                All <span class="filter-count" id="count-all">0</span>
              </button>
              <button onclick="setFilter('analyst')" data-filter="analyst" class="filter-btn">
                Analyst <span class="filter-count" id="count-analyst">0</span>
              </button>
              <button onclick="setFilter('curiosity')" data-filter="curiosity" class="filter-btn">
                Curiosity <span class="filter-count" id="count-curiosity">0</span>
              </button>
              <button onclick="setFilter('critic')" data-filter="critic" class="filter-btn">
                Critic <span class="filter-count" id="count-critic">0</span>
              </button>
              <button onclick="setFilter('agent_finding')" data-filter="agent_finding" class="filter-btn">
                Agent Findings <span class="filter-count" id="count-agent">0</span>
              </button>
              <button onclick="setFilter('high-activation')" data-filter="high-activation" class="filter-btn">
                High Activation <span class="filter-count" id="count-high">0</span>
              </button>
            </div>
          </div>
          
        </div>
      </div>
      
      <!-- Graph Container -->
      <div style="flex: 1; position: relative; overflow: hidden; background: var(--bg-primary);">
        <svg id="memory-svg" style="width: 100%; height: 100%;"></svg>
        
        <!-- Tooltip -->
        <div id="node-tooltip" style="display: none; position: absolute; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 6px; padding: 12px; pointer-events: none; z-index: 1000; max-width: 300px; box-shadow: 0 4px 12px rgba(0,0,0,0.4);">
          <div id="tooltip-concept" style="font-size: 12px; color: var(--text-primary); margin-bottom: 8px; line-height: 1.4;"></div>
          <div id="tooltip-metrics" style="font-size: 11px; color: var(--text-secondary);"></div>
          <div id="tooltip-connections" style="font-size: 10px; color: var(--text-muted); margin-top: 6px;"></div>
        </div>
        
        <!-- Zoom Controls -->
        <div style="position: absolute; top: 16px; right: 16px; display: flex; flex-direction: column; gap: 4px;">
          <button onclick="zoomIn()" style="width: 32px; height: 32px; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 4px; color: var(--text-primary); cursor: pointer; font-size: 18px;">+</button>
          <button onclick="fitNetwork()" style="width: 32px; height: 32px; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 4px; color: var(--text-primary); cursor: pointer; font-size: 16px;">⊙</button>
          <button onclick="zoomOut()" style="width: 32px; height: 32px; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 4px; color: var(--text-primary); cursor: pointer; font-size: 18px;">−</button>
        </div>
      </div>
      
      <!-- Stats Panel -->
      <div style="background: var(--bg-secondary); border-top: 1px solid var(--border-color); padding: 16px 20px;">
        <div style="font-weight: 600; font-size: 12px; color: var(--text-secondary); margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.5px;">Network Statistics</div>
        <div style="display: grid; grid-template-columns: repeat(6, 1fr); gap: 16px;">
          <div style="text-align: center;">
            <div style="font-size: 10px; color: var(--text-muted); margin-bottom: 4px;">Total Nodes</div>
            <div id="stat-nodes" style="font-size: 20px; font-weight: 700; color: var(--text-primary);">0</div>
          </div>
          <div style="text-align: center;">
            <div style="font-size: 10px; color: var(--text-muted); margin-bottom: 4px;">Total Edges</div>
            <div id="stat-edges" style="font-size: 20px; font-weight: 700; color: var(--text-primary);">0</div>
          </div>
          <div style="text-align: center;">
            <div style="font-size: 10px; color: var(--text-muted); margin-bottom: 4px;">Clusters</div>
            <div id="stat-clusters" style="font-size: 20px; font-weight: 700; color: var(--text-primary);">0</div>
          </div>
          <div style="text-align: center;">
            <div style="font-size: 10px; color: var(--text-muted); margin-bottom: 4px;">Visible</div>
            <div id="stat-visible" style="font-size: 20px; font-weight: 700; color: var(--success);">0</div>
          </div>
          <div style="text-align: center;">
            <div style="font-size: 10px; color: var(--text-muted); margin-bottom: 4px;">Avg Activation</div>
            <div id="stat-activation" style="font-size: 20px; font-weight: 700; color: var(--warning);">0.00</div>
          </div>
          <div style="text-align: center;">
            <div style="font-size: 10px; color: var(--text-muted); margin-bottom: 4px;">Selected</div>
            <div id="stat-selected" style="font-size: 16px; font-weight: 700; color: var(--accent-primary);">None</div>
          </div>
        </div>
      </div>
      
      <!-- Detail Panel (Initially Hidden) -->
      <div id="detail-panel" style="display: none; background: var(--bg-secondary); border-top: 1px solid var(--accent-primary); padding: 20px; max-height: 400px; overflow-y: auto;">
        <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 16px;">
          <div style="font-weight: 600; font-size: 14px; color: var(--text-primary);">Node Details</div>
          <button onclick="closeDetail()" style="background: transparent; border: none; color: var(--text-secondary); font-size: 20px; cursor: pointer; padding: 0;">&times;</button>
        </div>
        <div id="detail-content"></div>
      </div>
      
    </div>
  `;
  
  initializeGraph();
  loadData();
}

// ============================================================================
// DATA LOADING
// ============================================================================

async function loadData() {
  try {
    // Load stats
    const stats = await fetch('/api/brain/stats').then(r => r.json());
    document.getElementById('stat-nodes').textContent = stats.nodes || 0;
    document.getElementById('stat-edges').textContent = stats.edges || 0;
    
    // Load nodes
    const nodeData = await fetch('/api/nodes?limit=1000').then(r => r.json());
    allNodes = nodeData.nodes || [];
    
    // Count clusters
    const clusters = new Set(allNodes.map(n => n.cluster).filter(c => c !== undefined));
    document.getElementById('stat-clusters').textContent = clusters.size;
    
    // Count by type
    const typeCounts = {};
    allNodes.forEach(n => {
      const tag = n.tag || 'unknown';
      typeCounts[tag] = (typeCounts[tag] || 0) + 1;
    });
    
    document.getElementById('count-all').textContent = allNodes.length;
    document.getElementById('count-analyst').textContent = typeCounts['analyst'] || 0;
    document.getElementById('count-curiosity').textContent = typeCounts['curiosity'] || 0;
    document.getElementById('count-critic').textContent = typeCounts['critic'] || 0;
    document.getElementById('count-agent').textContent = typeCounts['agent_finding'] || 0;
    
    const highActivation = allNodes.filter(n => (n.activation || 0) > 0.5).length;
    document.getElementById('count-high').textContent = highActivation;
    
    console.log(`Loaded ${allNodes.length} nodes`);
  } catch (error) {
    console.error('Failed to load data:', error);
  }
}

// ============================================================================
// NETWORK RENDERING
// ============================================================================

function initializeGraph() {
  const container = document.getElementById('memory-svg');
  if (!container) return;
  
  svg = d3.select('#memory-svg');
  const width = container.clientWidth;
  const height = container.clientHeight;
  
  svg.attr('width', width).attr('height', height);
  
  g = svg.append('g');
  
  zoom = d3.zoom()
    .scaleExtent([0.1, 8])
    .on('zoom', (event) => {
      g.attr('transform', event.transform);
    });
  
  svg.call(zoom);
}

async function renderNetwork() {
  if (!allNodes || allNodes.length === 0) {
    alert('No nodes loaded. Please wait for data to load.');
    return;
  }
  
  // Filter nodes by current filter
  nodes = filterNodes(allNodes);
  
  // Load edges for visible nodes
  const nodeIds = new Set(nodes.map(n => n.id));
  const edgeSet = new Set();
  edges = [];
  
  // Load edges from node connections (sample of nodes to avoid overload)
  const sampleSize = Math.min(200, nodes.length);
  for (let i = 0; i < sampleSize; i++) {
    const node = nodes[i];
    try {
      const nodeData = await fetch(`/api/nodes/${node.id}`).then(r => r.json());
      
      (nodeData.outgoingConnections || []).forEach(conn => {
        if (nodeIds.has(conn.nodeId)) {
          const key = `${node.id}-${conn.nodeId}`;
          if (!edgeSet.has(key)) {
            edgeSet.add(key);
            edges.push({
              source: node.id,
              target: conn.nodeId,
              weight: conn.weight || 0
            });
          }
        }
      });
    } catch (e) {
      console.error(`Failed to load connections for node ${node.id}:`, e);
    }
  }
  
  drawGraph();
  updateStats();
}

function filterNodes(nodeList) {
  if (currentFilter === 'all') return nodeList;
  if (currentFilter === 'high-activation') {
    return nodeList.filter(n => (n.activation || 0) > 0.5);
  }
  return nodeList.filter(n => n.tag === currentFilter);
}

function drawGraph() {
  g.selectAll('*').remove();
  
  const width = svg.node().clientWidth;
  const height = svg.node().clientHeight;
  
  // Create simulation
  simulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(edges).id(d => d.id).distance(100))
    .force('charge', d3.forceManyBody().strength(-300))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collision', d3.forceCollide().radius(30));
  
  // Draw edges
  linkElements = g.append('g')
    .selectAll('line')
    .data(edges)
    .join('line')
    .attr('stroke', '#30363d')
    .attr('stroke-width', d => Math.sqrt(d.weight || 0.1) * 2)
    .attr('opacity', edgeOpacity);
  
  // Draw nodes
  nodeElements = g.append('g')
    .selectAll('circle')
    .data(nodes)
    .join('circle')
    .attr('r', d => nodeSize + Math.sqrt(d.weight || 1) * 2)
    .attr('fill', d => getNodeColor(d))
    .attr('stroke', '#fff')
    .attr('stroke-width', 1.5)
    .style('cursor', 'pointer')
    .call(d3.drag()
      .on('start', dragStarted)
      .on('drag', dragged)
      .on('end', dragEnded))
    .on('click', (event, d) => {
      event.stopPropagation();
      selectNode(d);
    })
    .on('mouseover', (event, d) => showTooltip(event, d))
    .on('mouseout', hideTooltip);
  
  // Draw labels
  labelElements = g.append('g')
    .selectAll('text')
    .data(nodes)
    .join('text')
    .text(d => `#${d.id}`)
    .attr('font-size', '10px')
    .attr('fill', '#8b949e')
    .attr('dx', 12)
    .attr('dy', 4)
    .style('pointer-events', 'none')
    .style('display', showLabels ? 'block' : 'none');
  
  simulation.on('tick', () => {
    linkElements
      .attr('x1', d => d.source.x)
      .attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x)
      .attr('y2', d => d.target.y);
    
    nodeElements
      .attr('cx', d => d.x)
      .attr('cy', d => d.y);
    
    labelElements
      .attr('x', d => d.x)
      .attr('y', d => d.y);
  });
}

function getNodeColor(node) {
  if (colorByClusters && node.cluster !== undefined) {
    const hue = (node.cluster * 137.5) % 360;
    return `hsl(${hue}, 50%, 50%)`;
  }
  return colors[node.tag] || colors.default;
}

// Drag handlers
function dragStarted(event, d) {
  if (!event.active) simulation.alphaTarget(0.3).restart();
  d.fx = d.x;
  d.fy = d.y;
}

function dragged(event, d) {
  d.fx = event.x;
  d.fy = event.y;
}

function dragEnded(event, d) {
  if (!event.active) simulation.alphaTarget(0);
  d.fx = null;
  d.fy = null;
}

// ============================================================================
// INTERACTIONS
// ============================================================================

function showTooltip(event, node) {
  const tooltip = document.getElementById('node-tooltip');
  const conceptText = (node.concept || 'No concept').substring(0, 100);
  
  document.getElementById('tooltip-concept').textContent = conceptText + (node.concept?.length > 100 ? '...' : '');
  document.getElementById('tooltip-metrics').innerHTML = `
    Activation: ${((node.activation || 0) * 100).toFixed(1)}% | 
    Weight: ${((node.weight || 0) * 100).toFixed(1)}% |
    Access: ${node.accessCount || 0}
  `;
  document.getElementById('tooltip-connections').textContent = `Cluster: ${node.cluster || 'N/A'} | Tag: ${node.tag || 'unknown'}`;
  
  tooltip.style.display = 'block';
  tooltip.style.left = (event.pageX + 10) + 'px';
  tooltip.style.top = (event.pageY - 10) + 'px';
}

function hideTooltip() {
  document.getElementById('node-tooltip').style.display = 'none';
}

async function selectNode(node) {
  selectedNode = node;
  document.getElementById('stat-selected').textContent = `#${node.id}`;
  
  // Load full node data
  const nodeData = await fetch(`/api/nodes/${node.id}`).then(r => r.json());
  showDetail(nodeData);
  
  // Highlight in graph
  if (nodeElements) {
    nodeElements
      .attr('stroke', d => d.id === node.id ? '#ffd700' : '#fff')
      .attr('stroke-width', d => d.id === node.id ? 3 : 1.5);
  }
}

function showDetail(node) {
  const panel = document.getElementById('detail-panel');
  const content = document.getElementById('detail-content');
  
  const outgoing = node.outgoingConnections || [];
  const incoming = node.incomingConnections || [];
  const total = outgoing.length + incoming.length;
  
  content.innerHTML = `
    <div style="background: var(--bg-tertiary); padding: 14px; border-radius: 6px; border-left: 4px solid var(--accent-primary); margin-bottom: 16px;">
      <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 6px;">CONCEPT</div>
      <div style="font-size: 13px; color: var(--text-primary); line-height: 1.6;">${node.concept || 'No concept'}</div>
    </div>
    
    <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 16px;">
      <div style="background: var(--bg-tertiary); padding: 10px; border-radius: 4px; text-align: center;">
        <div style="font-size: 10px; color: var(--text-muted);">Activation</div>
        <div style="font-size: 18px; font-weight: 700; color: var(--warning);">${((node.activation || 0) * 100).toFixed(1)}%</div>
      </div>
      <div style="background: var(--bg-tertiary); padding: 10px; border-radius: 4px; text-align: center;">
        <div style="font-size: 10px; color: var(--text-muted);">Weight</div>
        <div style="font-size: 18px; font-weight: 700; color: var(--success);">${((node.weight || 0) * 100).toFixed(1)}%</div>
      </div>
      <div style="background: var(--bg-tertiary); padding: 10px; border-radius: 4px; text-align: center;">
        <div style="font-size: 10px; color: var(--text-muted);">Access</div>
        <div style="font-size: 18px; font-weight: 700; color: var(--accent-primary);">${node.accessCount || 0}</div>
      </div>
      <div style="background: var(--bg-tertiary); padding: 10px; border-radius: 4px; text-align: center;">
        <div style="font-size: 10px; color: var(--text-muted);">Connections</div>
        <div style="font-size: 18px; font-weight: 700; color: var(--text-primary);">${total}</div>
      </div>
      <div style="background: var(--bg-tertiary); padding: 10px; border-radius: 4px; text-align: center;">
        <div style="font-size: 10px; color: var(--text-muted);">Cluster</div>
        <div style="font-size: 18px; font-weight: 700; color: var(--text-primary);">${node.cluster || 'N/A'}</div>
      </div>
      <div style="background: var(--bg-tertiary); padding: 10px; border-radius: 4px; text-align: center;">
        <div style="font-size: 10px; color: var(--text-muted);">Tag</div>
        <div style="font-size: 14px; font-weight: 600; color: var(--text-primary);">${node.tag || 'unknown'}</div>
      </div>
    </div>
    
    ${total > 0 ? `
      <div>
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
          <div style="font-size: 12px; font-weight: 600; color: var(--text-secondary);">Connected Concepts (${total})</div>
        </div>
        <div style="max-height: 200px; overflow-y: auto;">
          ${[...outgoing.slice(0, 5), ...incoming.slice(0, 5)].map(conn => {
            const concept = conn.targetConcept || conn.sourceConcept || 'Unknown';
            return `
              <div onclick="selectNodeById(${conn.nodeId})" style="cursor: pointer; padding: 10px; margin: 6px 0; background: var(--bg-primary); border-radius: 4px; border: 1px solid var(--border-color); transition: all 0.2s;" onmouseover="this.style.borderColor='var(--accent-primary)'" onmouseout="this.style.borderColor='var(--border-color)'">
                <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                  <span style="font-weight: 600; color: var(--accent-primary); font-size: 12px;">#${conn.nodeId}</span>
                  <span style="font-size: 10px; background: var(--bg-secondary); padding: 2px 6px; border-radius: 3px;">${(conn.weight * 100).toFixed(0)}%</span>
                </div>
                <div style="font-size: 11px; color: var(--text-secondary);">${concept.substring(0, 80)}...</div>
              </div>
            `;
          }).join('')}
          ${total > 10 ? `<div style="text-align: center; padding: 8px; color: var(--text-muted); font-size: 11px;">... and ${total - 10} more</div>` : ''}
        </div>
      </div>
    ` : '<div style="text-align: center; padding: 20px; color: var(--text-muted);">No connections</div>'}
  `;
  
  panel.style.display = 'block';
}

async function selectNodeById(nodeId) {
  const node = allNodes.find(n => n.id === nodeId);
  if (node) {
    await selectNode(node);
  }
}

function closeDetail() {
  document.getElementById('detail-panel').style.display = 'none';
  selectedNode = null;
  document.getElementById('stat-selected').textContent = 'None';
  
  if (nodeElements) {
    nodeElements
      .attr('stroke', '#fff')
      .attr('stroke-width', 1.5);
  }
}

// ============================================================================
// CONTROLS
// ============================================================================

function toggleControls() {
  const content = document.getElementById('controls-content');
  const icon = document.getElementById('controls-icon');
  if (content.style.display === 'none') {
    content.style.display = 'block';
    icon.textContent = '▼';
  } else {
    content.style.display = 'none';
    icon.textContent = '▶';
  }
}

function setFilter(filter) {
  currentFilter = filter;
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });
}

function updateNodeSize(value) {
  nodeSize = parseFloat(value);
  document.getElementById('node-size-value').textContent = value;
  if (nodeElements) {
    nodeElements.attr('r', d => nodeSize + Math.sqrt(d.weight || 1) * 2);
  }
}

function updateEdgeOpacity(value) {
  edgeOpacity = parseInt(value) / 100;
  document.getElementById('edge-opacity-value').textContent = value + '%';
  if (linkElements) {
    linkElements.attr('opacity', edgeOpacity);
  }
}

function toggleLabels(checked) {
  showLabels = checked;
  if (labelElements) {
    labelElements.style('display', checked ? 'block' : 'none');
  }
}

function toggleClusters(checked) {
  colorByClusters = checked;
  if (nodeElements) {
    nodeElements.attr('fill', d => getNodeColor(d));
  }
}

function fitNetwork() {
  if (!svg || !g) return;
  const bounds = g.node().getBBox();
  const width = svg.node().clientWidth;
  const height = svg.node().clientHeight;
  const scale = Math.min(width / bounds.width, height / bounds.height) * 0.9;
  const transform = d3.zoomIdentity
    .translate(width / 2 - scale * (bounds.x + bounds.width / 2), 
               height / 2 - scale * (bounds.y + bounds.height / 2))
    .scale(scale);
  svg.transition().duration(750).call(zoom.transform, transform);
}

function zoomIn() {
  svg.transition().call(zoom.scaleBy, 1.3);
}

function zoomOut() {
  svg.transition().call(zoom.scaleBy, 0.7);
}

function resetView() {
  svg.transition().duration(750).call(zoom.transform, d3.zoomIdentity);
}

function searchNodes() {
  const query = document.getElementById('memory-search').value.toLowerCase();
  if (!query) return;
  
  const matches = allNodes.filter(n => 
    (n.concept || '').toLowerCase().includes(query)
  );
  
  if (matches.length > 0) {
    alert(`Found ${matches.length} matching nodes`);
    nodes = matches;
    drawGraph();
    updateStats();
  } else {
    alert('No matches found');
  }
}

function updateStats() {
  document.getElementById('stat-visible').textContent = nodes.length;
  
  const avgActivation = nodes.length > 0 
    ? nodes.reduce((sum, n) => sum + (n.activation || 0), 0) / nodes.length
    : 0;
  document.getElementById('stat-activation').textContent = avgActivation.toFixed(3);
}
