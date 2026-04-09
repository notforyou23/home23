/**
 * Explore Tab - Memory Network Visualization
 * D3.js force-directed graph for COSMO brain nodes/edges
 * Mobile/iPad friendly with touch support
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
let exploreInitialized = false;
let exploreBrainListenersBound = false;

const colors = {
  analyst: '#4ec9b0',
  curiosity: '#dcdcaa',
  critic: '#ce9178',
  agent_finding: '#569cd6',
  default: '#858585'
};

function injectExploreStyles() {
  if (document.getElementById('explore-tab-styles')) return;
  const style = document.createElement('style');
  style.id = 'explore-tab-styles';
  style.textContent = `
    /* Explore Tab Styles */
    .explore-filter-btn {
      padding: 6px 12px;
      min-height: 44px;
      background: var(--bg-primary);
      border: 1px solid var(--border-color);
      border-radius: 4px;
      color: var(--text-secondary);
      cursor: pointer;
      font-size: 12px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.15s;
      -webkit-tap-highlight-color: transparent;
    }
    .explore-filter-btn:hover { border-color: var(--accent-primary); color: var(--text-primary); }
    .explore-filter-btn.active { background: var(--accent-primary); color: #fff; border-color: var(--accent-primary); }
    .explore-filter-count {
      font-size: 10px;
      background: rgba(255,255,255,0.15);
      padding: 1px 5px;
      border-radius: 3px;
    }
    .explore-filter-btn.active .explore-filter-count { background: rgba(255,255,255,0.25); }

    .explore-ctrl-btn {
      min-height: 44px;
      min-width: 44px;
      padding: 8px 16px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
      border: 1px solid var(--border-color);
      -webkit-tap-highlight-color: transparent;
    }
    .explore-ctrl-btn-primary { background: var(--accent-primary); color: #fff; border-color: var(--accent-primary); }
    .explore-ctrl-btn-secondary { background: var(--bg-primary); color: var(--text-primary); }

    .explore-zoom-btn {
      width: 44px; height: 44px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      color: var(--text-primary);
      cursor: pointer;
      font-size: 20px;
      display: flex; align-items: center; justify-content: center;
      -webkit-tap-highlight-color: transparent;
    }

    #explore-detail-overlay {
      display: none;
      position: absolute;
      bottom: 0; left: 0; right: 0;
      background: var(--bg-secondary);
      border-top: 2px solid var(--accent-primary);
      max-height: 50%;
      overflow-y: auto;
      z-index: 100;
      padding: 16px 20px;
    }
    @media (min-width: 769px) {
      #explore-detail-overlay {
        position: absolute;
        top: 0; right: 0; bottom: 0; left: auto;
        width: 380px;
        max-height: 100%;
        border-top: none;
        border-left: 2px solid var(--accent-primary);
      }
    }

    /* Stats grid responsive */
    .explore-stats-grid {
      display: grid;
      grid-template-columns: repeat(6, 1fr);
      gap: 12px;
    }
    @media (max-width: 768px) {
      .explore-stats-grid { grid-template-columns: repeat(3, 1fr); gap: 8px; }
    }
  `;
  document.head.appendChild(style);
}

function initExploreTab() {
  injectExploreStyles();
  bindExploreBrainListeners();

  const panel = document.getElementById('explore-tab-panel');
  if (!panel) return;

  // Brain check
  if (!window.currentBrainInfo?.brainPath) {
    panel.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:16px;color:var(--text-secondary);padding:40px;">
        <div style="font-size:48px;">🧠</div>
        <div style="font-size:18px;font-weight:600;color:var(--text-primary);">Connect a Brain</div>
        <div style="text-align:center;max-width:400px;line-height:1.6;">Connect a brain first to explore its memory network, active concepts, and linked evidence.</div>
        <button class="explore-ctrl-btn explore-ctrl-btn-primary" data-action="toggleBrainPicker()">Connect Brain</button>
      </div>`;
    return;
  }

  // Avoid re-init if already loaded and just switching tabs
  if (exploreInitialized && allNodes.length > 0) {
    setTimeout(() => resizeGraph(), 50);
    return;
  }

  panel.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;background:var(--bg-primary);">

      <!-- Collapsible Controls -->
      <div id="explore-controls" style="background:var(--bg-secondary);border-bottom:1px solid var(--border-color);">
        <div onclick="toggleExploreControls()" style="padding:12px 20px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;user-select:none;min-height:44px;-webkit-tap-highlight-color:transparent;">
          <div style="font-weight:600;font-size:14px;color:var(--text-primary);">🎛️ Controls & Filters</div>
          <span id="explore-controls-icon" style="color:var(--text-secondary);">▼</span>
        </div>
        <div id="explore-controls-content" style="padding:16px 20px;border-top:1px solid var(--border-color);">

          <!-- Search & Actions -->
          <div style="display:flex;gap:12px;margin-bottom:16px;align-items:end;flex-wrap:wrap;">
            <div style="flex:1;min-width:180px;">
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px;">🔍 Search Concepts</label>
              <input type="text" id="explore-search" placeholder="Search nodes..."
                onkeypress="if(event.key==='Enter') exploreSearchNodes()"
                style="width:100%;padding:10px 12px;background:var(--bg-primary);border:1px solid var(--border-color);border-radius:4px;color:var(--text-primary);font-size:13px;min-height:44px;box-sizing:border-box;">
            </div>
            <div style="display:flex;gap:8px;">
              <button onclick="renderNetwork()" class="explore-ctrl-btn explore-ctrl-btn-primary">Render</button>
              <button onclick="fitNetwork()" class="explore-ctrl-btn explore-ctrl-btn-secondary">Fit</button>
              <button onclick="resetView()" class="explore-ctrl-btn explore-ctrl-btn-secondary">Reset</button>
            </div>
          </div>

          <!-- Sliders -->
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px;">
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px;">
                Node Size: <span id="node-size-value" style="color:var(--accent-primary);">5</span>
              </label>
              <input type="range" id="node-size-slider" min="1" max="10" value="5" step="0.5"
                oninput="updateNodeSize(this.value)" style="width:100%;">
            </div>
            <div>
              <label style="font-size:11px;color:var(--text-secondary);display:block;margin-bottom:4px;">
                Edge Opacity: <span id="edge-opacity-value" style="color:var(--accent-primary);">20%</span>
              </label>
              <input type="range" id="edge-opacity-slider" min="5" max="80" value="20" step="5"
                oninput="updateEdgeOpacity(this.value)" style="width:100%;">
            </div>
          </div>

          <!-- Toggles -->
          <div style="display:flex;gap:16px;margin-bottom:16px;font-size:12px;">
            <label style="cursor:pointer;display:flex;align-items:center;gap:6px;min-height:44px;">
              <input type="checkbox" id="show-labels-check" onchange="toggleLabels(this.checked)">
              <span>Show Labels</span>
            </label>
            <label style="cursor:pointer;display:flex;align-items:center;gap:6px;min-height:44px;">
              <input type="checkbox" id="color-clusters-check" onchange="toggleClusters(this.checked)">
              <span>Color by Cluster</span>
            </label>
          </div>

          <!-- Type Filters -->
          <div>
            <div style="font-size:11px;color:var(--text-secondary);margin-bottom:8px;">Filter by Type:</div>
            <div style="display:flex;flex-wrap:wrap;gap:8px;" id="explore-filter-buttons">
              <button onclick="setExploreFilter('all')" data-filter="all" class="explore-filter-btn active">
                All <span class="explore-filter-count" id="count-all">0</span>
              </button>
              <button onclick="setExploreFilter('analyst')" data-filter="analyst" class="explore-filter-btn">
                Analyst <span class="explore-filter-count" id="count-analyst">0</span>
              </button>
              <button onclick="setExploreFilter('curiosity')" data-filter="curiosity" class="explore-filter-btn">
                Curiosity <span class="explore-filter-count" id="count-curiosity">0</span>
              </button>
              <button onclick="setExploreFilter('critic')" data-filter="critic" class="explore-filter-btn">
                Critic <span class="explore-filter-count" id="count-critic">0</span>
              </button>
              <button onclick="setExploreFilter('agent_finding')" data-filter="agent_finding" class="explore-filter-btn">
                Agent Findings <span class="explore-filter-count" id="count-agent">0</span>
              </button>
              <button onclick="setExploreFilter('high-activation')" data-filter="high-activation" class="explore-filter-btn">
                High Activation <span class="explore-filter-count" id="count-high">0</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Graph Container -->
      <div style="flex:1;position:relative;overflow:hidden;background:var(--bg-primary);">
        <svg id="memory-svg" style="width:100%;height:100%;"></svg>

        <!-- Tooltip -->
        <div id="node-tooltip" style="display:none;position:absolute;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:6px;padding:12px;pointer-events:none;z-index:1000;max-width:280px;box-shadow:0 4px 12px rgba(0,0,0,0.4);">
          <div id="tooltip-concept" style="font-size:12px;color:var(--text-primary);margin-bottom:8px;line-height:1.4;"></div>
          <div id="tooltip-metrics" style="font-size:11px;color:var(--text-secondary);"></div>
          <div id="tooltip-connections" style="font-size:10px;color:var(--text-muted);margin-top:6px;"></div>
        </div>

        <!-- Zoom Controls -->
        <div style="position:absolute;top:16px;right:16px;display:flex;flex-direction:column;gap:4px;">
          <button onclick="zoomIn()" class="explore-zoom-btn">+</button>
          <button onclick="fitNetwork()" class="explore-zoom-btn">⊙</button>
          <button onclick="zoomOut()" class="explore-zoom-btn">−</button>
        </div>

        <!-- Detail Overlay (positioned inside graph area) -->
        <div id="explore-detail-overlay">
          <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:16px;">
            <div style="font-weight:600;font-size:14px;color:var(--text-primary);">Node Details</div>
            <button onclick="closeExploreDetail()" style="background:transparent;border:none;color:var(--text-secondary);font-size:24px;cursor:pointer;padding:4px;min-width:44px;min-height:44px;display:flex;align-items:center;justify-content:center;">&times;</button>
          </div>
          <div id="explore-detail-content"></div>
        </div>
      </div>

      <!-- Stats Panel -->
      <div style="background:var(--bg-secondary);border-top:1px solid var(--border-color);padding:12px 20px;">
        <div class="explore-stats-grid">
          <div style="text-align:center;">
            <div style="font-size:10px;color:var(--text-muted);margin-bottom:2px;">Nodes</div>
            <div id="stat-nodes" style="font-size:18px;font-weight:700;color:var(--text-primary);">0</div>
          </div>
          <div style="text-align:center;">
            <div style="font-size:10px;color:var(--text-muted);margin-bottom:2px;">Edges</div>
            <div id="stat-edges" style="font-size:18px;font-weight:700;color:var(--text-primary);">0</div>
          </div>
          <div style="text-align:center;">
            <div style="font-size:10px;color:var(--text-muted);margin-bottom:2px;">Clusters</div>
            <div id="stat-clusters" style="font-size:18px;font-weight:700;color:var(--text-primary);">0</div>
          </div>
          <div style="text-align:center;">
            <div style="font-size:10px;color:var(--text-muted);margin-bottom:2px;">Visible</div>
            <div id="stat-visible" style="font-size:18px;font-weight:700;color:var(--success);">0</div>
          </div>
          <div style="text-align:center;">
            <div style="font-size:10px;color:var(--text-muted);margin-bottom:2px;">Avg Activation</div>
            <div id="stat-activation" style="font-size:18px;font-weight:700;color:var(--warning);">0.00</div>
          </div>
          <div style="text-align:center;">
            <div style="font-size:10px;color:var(--text-muted);margin-bottom:2px;">Selected</div>
            <div id="stat-selected" style="font-size:14px;font-weight:700;color:var(--accent-primary);">None</div>
          </div>
        </div>
      </div>
    </div>
  `;

  // Collapse controls on mobile by default
  if (window.innerWidth < 768) {
    const content = document.getElementById('explore-controls-content');
    const icon = document.getElementById('explore-controls-icon');
    if (content) { content.style.display = 'none'; }
    if (icon) { icon.textContent = '▶'; }
  }

  exploreInitialized = true;
  initializeGraph();
  loadExploreData();

  window.addEventListener('resize', () => {
    if (typeof resizeGraph === 'function') resizeGraph();
  });
}

function bindExploreBrainListeners() {
  if (exploreBrainListenersBound) return;
  exploreBrainListenersBound = true;

  const syncExploreState = () => {
    const panel = document.getElementById('explore-tab-panel');
    if (!panel || panel.style.display === 'none') return;

    exploreInitialized = false;
    nodes = [];
    edges = [];
    allNodes = [];
    allEdges = [];
    selectedNode = null;
    initExploreTab();
  };

  window.addEventListener('cosmo:brainLoaded', syncExploreState);
  window.addEventListener('cosmo:brainUnloaded', syncExploreState);
}

// ============================================================================
// DATA LOADING
// ============================================================================

async function loadExploreData() {
  try {
    const stats = await fetch('/api/brain/stats').then(r => r.json());
    const totalNodes = stats.nodes || 0;
    const totalEdges = stats.edges || 0;

    document.getElementById('stat-nodes').textContent = totalNodes.toLocaleString();
    document.getElementById('stat-edges').textContent = totalEdges.toLocaleString();

    console.log(`[Explore] Loading data: ${totalNodes} nodes, ${totalEdges} edges`);

    const nodeRes = await fetch('/api/nodes?limit=all');
    if (!nodeRes.ok) throw new Error(`Nodes API failed: ${nodeRes.status}`);
    const nodeData = await nodeRes.json();
    allNodes = nodeData.nodes || [];
    console.log(`[Explore] Loaded ${allNodes.length} nodes`);

    if (totalNodes > 0 && allNodes.length === 0) {
      console.warn('[Explore] Brain initializing...');
      return;
    }

    const edgeRes = await fetch('/api/edges?limit=all');
    if (edgeRes.ok) {
      const edgeData = await edgeRes.json();
      allEdges = edgeData.edges || [];
      console.log(`[Explore] Loaded ${allEdges.length} edges`);
    } else {
      allEdges = [];
    }

    // Stats
    const clusters = new Set(allNodes.map(n => n.cluster).filter(c => c !== undefined));
    document.getElementById('stat-clusters').textContent = clusters.size;

    const typeCounts = {};
    allNodes.forEach(n => { const tag = n.tag || 'unknown'; typeCounts[tag] = (typeCounts[tag] || 0) + 1; });

    document.getElementById('count-all').textContent = allNodes.length.toLocaleString();
    document.getElementById('count-analyst').textContent = (typeCounts['analyst'] || 0).toLocaleString();
    document.getElementById('count-curiosity').textContent = (typeCounts['curiosity'] || 0).toLocaleString();
    document.getElementById('count-critic').textContent = (typeCounts['critic'] || 0).toLocaleString();
    document.getElementById('count-agent').textContent = (typeCounts['agent_finding'] || 0).toLocaleString();
    document.getElementById('count-high').textContent = allNodes.filter(n => (n.activation || 0) > 0.5).length.toLocaleString();

    // Auto-render if not too many nodes
    if (allNodes.length > 0 && allNodes.length <= 2000) {
      renderNetwork();
    }

  } catch (error) {
    console.error('[Explore] Failed to load data:', error);
  }
}

// ============================================================================
// GRAPH
// ============================================================================

function initializeGraph() {
  const container = document.getElementById('memory-svg');
  if (!container) return;

  svg = d3.select('#memory-svg');
  svg.selectAll('*').remove();
  g = svg.append('g');

  zoom = d3.zoom()
    .scaleExtent([0.05, 10])
    .on('zoom', (event) => { g.attr('transform', event.transform); });

  svg.call(zoom)
    .on('dblclick.zoom', null); // disable double-click zoom

  resizeGraph();
}

function resizeGraph() {
  const container = document.getElementById('memory-svg');
  if (!container || !svg) return;
  const width = container.clientWidth;
  const height = container.clientHeight;
  if (width > 0 && height > 0) {
    svg.attr('width', width).attr('height', height);
    if (simulation) {
      simulation.force('center', d3.forceCenter(width / 2, height / 2));
      simulation.alpha(0.3).restart();
    }
  }
}

function renderNetwork() {
  if (!allNodes || allNodes.length === 0) return;

  nodes = filterNodes(allNodes);
  const nodeIds = new Set(nodes.map(n => n.id));
  edges = allEdges.filter(e => nodeIds.has(e.source) && nodeIds.has(e.target))
    .map(e => ({ ...e, source: e.source, target: e.target }));

  console.log(`[Explore] Rendering: ${nodes.length} nodes, ${edges.length} edges`);
  drawGraph();
  updateExploreStats();
}

function filterNodes(nodeList) {
  if (currentFilter === 'all') return [...nodeList];
  if (currentFilter === 'high-activation') return nodeList.filter(n => (n.activation || 0) > 0.5);
  return nodeList.filter(n => n.tag === currentFilter);
}

function drawGraph() {
  g.selectAll('*').remove();

  const width = svg.node().clientWidth;
  const height = svg.node().clientHeight;
  const large = nodes.length > 500;
  const chargeStrength = large ? -50 : -300;
  const linkDistance = large ? 50 : 100;

  simulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(edges).id(d => d.id).distance(linkDistance))
    .force('charge', d3.forceManyBody().strength(chargeStrength))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collision', d3.forceCollide().radius(large ? 10 : 30));

  linkElements = g.append('g')
    .selectAll('line')
    .data(edges)
    .join('line')
    .attr('stroke', '#30363d')
    .attr('stroke-width', d => Math.sqrt(d.weight || 0.1) * 2)
    .attr('opacity', edgeOpacity);

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
    .on('click', (event, d) => { event.stopPropagation(); selectExploreNode(d); })
    .on('mouseover', (event, d) => showExploreTooltip(event, d))
    .on('mouseout', hideExploreTooltip);

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
      .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    nodeElements.attr('cx', d => d.x).attr('cy', d => d.y);
    labelElements.attr('x', d => d.x).attr('y', d => d.y);
  });
}

function getNodeColor(node) {
  if (colorByClusters && node.cluster !== undefined) {
    return `hsl(${(node.cluster * 137.5) % 360}, 50%, 50%)`;
  }
  return colors[node.tag] || colors.default;
}

function dragStarted(event, d) {
  if (!event.active) simulation.alphaTarget(0.3).restart();
  d.fx = d.x; d.fy = d.y;
}
function dragged(event, d) { d.fx = event.x; d.fy = event.y; }
function dragEnded(event, d) {
  if (!event.active) simulation.alphaTarget(0);
  d.fx = null; d.fy = null;
}

// ============================================================================
// INTERACTIONS
// ============================================================================

function showExploreTooltip(event, node) {
  const tooltip = document.getElementById('node-tooltip');
  if (!tooltip) return;
  const concept = (node.concept || 'No concept').substring(0, 100);
  document.getElementById('tooltip-concept').textContent = concept + (node.concept?.length > 100 ? '...' : '');
  document.getElementById('tooltip-metrics').innerHTML =
    `Activation: ${((node.activation || 0) * 100).toFixed(1)}% | Weight: ${((node.weight || 0) * 100).toFixed(1)}% | Access: ${node.accessCount || 0}`;
  document.getElementById('tooltip-connections').textContent = `Cluster: ${node.cluster ?? 'N/A'} | Tag: ${node.tag || 'unknown'}`;

  // Position relative to the graph container
  const container = tooltip.parentElement;
  const rect = container.getBoundingClientRect();
  const x = event.clientX - rect.left + 10;
  const y = event.clientY - rect.top - 10;
  tooltip.style.display = 'block';
  tooltip.style.left = Math.min(x, rect.width - 290) + 'px';
  tooltip.style.top = Math.max(0, y) + 'px';
}

function hideExploreTooltip() {
  const tooltip = document.getElementById('node-tooltip');
  if (tooltip) tooltip.style.display = 'none';
}

async function selectExploreNode(node) {
  selectedNode = node;
  const el = document.getElementById('stat-selected');
  if (el) el.textContent = `#${node.id}`;

  try {
    const nodeData = await fetch(`/api/nodes/${node.id}`).then(r => r.json());
    showExploreDetail(nodeData);
  } catch (e) {
    showExploreDetail(node);
  }

  if (nodeElements) {
    nodeElements
      .attr('stroke', d => d.id === node.id ? '#ffd700' : '#fff')
      .attr('stroke-width', d => d.id === node.id ? 3 : 1.5);
  }
}

function showExploreDetail(node) {
  const panel = document.getElementById('explore-detail-overlay');
  const content = document.getElementById('explore-detail-content');
  if (!panel || !content) return;

  const outgoing = node.outgoingConnections || [];
  const incoming = node.incomingConnections || [];
  const total = outgoing.length + incoming.length;

  content.innerHTML = `
    <div style="background:var(--bg-tertiary);padding:14px;border-radius:6px;border-left:4px solid var(--accent-primary);margin-bottom:16px;">
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">CONCEPT</div>
      <div style="font-size:13px;color:var(--text-primary);line-height:1.6;">${node.concept || 'No concept'}</div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:16px;">
      ${[
        ['Activation', ((node.activation||0)*100).toFixed(1)+'%', 'var(--warning)'],
        ['Weight', ((node.weight||0)*100).toFixed(1)+'%', 'var(--success)'],
        ['Access', node.accessCount||0, 'var(--accent-primary)'],
        ['Connections', total, 'var(--text-primary)'],
        ['Cluster', node.cluster??'N/A', 'var(--text-primary)'],
        ['Tag', node.tag||'unknown', 'var(--text-primary)']
      ].map(([label, val, color]) => `
        <div style="background:var(--bg-tertiary);padding:8px;border-radius:4px;text-align:center;">
          <div style="font-size:10px;color:var(--text-muted);">${label}</div>
          <div style="font-size:14px;font-weight:700;color:${color};">${val}</div>
        </div>`).join('')}
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px;">
      <div style="background:var(--bg-tertiary);padding:8px;border-radius:4px;">
        <div style="font-size:10px;color:var(--text-muted);margin-bottom:2px;">Domain</div>
        <div style="font-size:12px;font-weight:600;color:var(--accent-primary);">${node.domain||'unknown'}</div>
      </div>
      <div style="background:var(--bg-tertiary);padding:8px;border-radius:4px;">
        <div style="font-size:10px;color:var(--text-muted);margin-bottom:2px;">Provenance</div>
        <div style="font-size:11px;font-weight:600;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${(node.sourceRuns||[]).join(', ')}">
          ${node.sourceRuns ? node.sourceRuns.join(', ') : (node.sourceRun||'unknown')}
        </div>
      </div>
    </div>
    ${total > 0 ? `
      <div style="font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:8px;">Connected (${total})</div>
      <div style="max-height:200px;overflow-y:auto;">
        ${[...outgoing.slice(0,5),...incoming.slice(0,5)].map(conn => {
          const concept = conn.targetConcept || conn.sourceConcept || 'Unknown';
          return `
            <div onclick="exploreSelectById(${conn.nodeId})" style="cursor:pointer;padding:10px;margin:4px 0;background:var(--bg-primary);border-radius:4px;border:1px solid var(--border-color);min-height:44px;">
              <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
                <span style="font-weight:600;color:var(--accent-primary);font-size:12px;">#${conn.nodeId}</span>
                <span style="font-size:10px;background:var(--bg-secondary);padding:2px 6px;border-radius:3px;">${(conn.weight*100).toFixed(0)}%</span>
              </div>
              <div style="font-size:11px;color:var(--text-secondary);">${concept.substring(0,80)}${concept.length>80?'...':''}</div>
            </div>`;
        }).join('')}
        ${total > 10 ? `<div style="text-align:center;padding:8px;color:var(--text-muted);font-size:11px;">… and ${total-10} more</div>` : ''}
      </div>` : '<div style="text-align:center;padding:20px;color:var(--text-muted);">No connections</div>'}
  `;
  panel.style.display = 'block';
}

async function exploreSelectById(nodeId) {
  const node = allNodes.find(n => n.id === nodeId || String(n.id) === String(nodeId));
  if (node) await selectExploreNode(node);
}

function closeExploreDetail() {
  const panel = document.getElementById('explore-detail-overlay');
  if (panel) panel.style.display = 'none';
  selectedNode = null;
  const el = document.getElementById('stat-selected');
  if (el) el.textContent = 'None';
  if (nodeElements) {
    nodeElements.attr('stroke', '#fff').attr('stroke-width', 1.5);
  }
}

// ============================================================================
// CONTROLS
// ============================================================================

function toggleExploreControls() {
  const content = document.getElementById('explore-controls-content');
  const icon = document.getElementById('explore-controls-icon');
  if (!content) return;
  if (content.style.display === 'none') {
    content.style.display = 'block';
    if (icon) icon.textContent = '▼';
  } else {
    content.style.display = 'none';
    if (icon) icon.textContent = '▶';
  }
  // Re-fit graph after controls toggle changes available space
  setTimeout(() => resizeGraph(), 100);
}

function setExploreFilter(filter) {
  currentFilter = filter;
  document.querySelectorAll('.explore-filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });
}

function updateNodeSize(value) {
  nodeSize = parseFloat(value);
  const el = document.getElementById('node-size-value');
  if (el) el.textContent = value;
  if (nodeElements) nodeElements.attr('r', d => nodeSize + Math.sqrt(d.weight || 1) * 2);
}

function updateEdgeOpacity(value) {
  edgeOpacity = parseInt(value) / 100;
  const el = document.getElementById('edge-opacity-value');
  if (el) el.textContent = value + '%';
  if (linkElements) linkElements.attr('opacity', edgeOpacity);
}

function toggleLabels(checked) {
  showLabels = checked;
  if (labelElements) labelElements.style('display', checked ? 'block' : 'none');
}

function toggleClusters(checked) {
  colorByClusters = checked;
  if (nodeElements) nodeElements.attr('fill', d => getNodeColor(d));
}

function fitNetwork() {
  if (!svg || !g) return;
  const bounds = g.node().getBBox();
  if (bounds.width === 0 || bounds.height === 0) return;
  const width = svg.node().clientWidth;
  const height = svg.node().clientHeight;
  const scale = Math.min(width / bounds.width, height / bounds.height) * 0.9;
  const transform = d3.zoomIdentity
    .translate(width/2 - scale*(bounds.x + bounds.width/2), height/2 - scale*(bounds.y + bounds.height/2))
    .scale(scale);
  svg.transition().duration(750).call(zoom.transform, transform);
}

function zoomIn() { if (svg) svg.transition().call(zoom.scaleBy, 1.3); }
function zoomOut() { if (svg) svg.transition().call(zoom.scaleBy, 0.7); }
function resetView() { if (svg) svg.transition().duration(750).call(zoom.transform, d3.zoomIdentity); }

function exploreSearchNodes() {
  const query = (document.getElementById('explore-search')?.value || '').toLowerCase();
  if (!query) { renderNetwork(); return; }
  const matches = allNodes.filter(n => (n.concept || '').toLowerCase().includes(query));
  if (matches.length > 0) {
    nodes = matches;
    const nodeIds = new Set(nodes.map(n => n.id));
    edges = allEdges.filter(e => nodeIds.has(e.source) && nodeIds.has(e.target))
      .map(e => ({ ...e, source: e.source, target: e.target }));
    drawGraph();
    updateExploreStats();
  }
}

function updateExploreStats() {
  const el = document.getElementById('stat-visible');
  if (el) el.textContent = nodes.length;
  const avg = nodes.length > 0 ? nodes.reduce((s, n) => s + (n.activation || 0), 0) / nodes.length : 0;
  const el2 = document.getElementById('stat-activation');
  if (el2) el2.textContent = avg.toFixed(3);
}

console.debug('[UI] explore-tab.js loaded');
