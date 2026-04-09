/**
 * Brain Map — 3D force-directed knowledge graph visualization
 *
 * Uses 3d-force-graph (three.js) for immersive node exploration.
 * Loaded before app.js. Exposes window.BrainMap for integration.
 */

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────

  let graph = null;
  let currentBrainKey = null;
  let graphData = null;
  let selectedNode = null;
  let hoveredNode = null;
  let isLoading = false;
  let activeResizeObserver = null;

  // ── Color palette ─────────────────────────────────────────────────────────

  const TAG_COLORS = {
    research:       '#4ecdc4',
    synthesis:      '#45b7d1',
    consolidated:   '#96ceb4',
    agent_finding:  '#87ceeb',
    agent_insight:  '#dda0dd',
    breakthrough:   '#ffd700',
    goal:           '#ff8c42',
    milestone:      '#ff6b6b',
    dream:          '#9b59b6',
    reasoning:      '#7f8fa6',
    introspection:  '#a29bfe',
    agent_success:  '#2ecc71',
    agent_failure:  '#e74c3c',
    general:        '#78b5a3',
    meta:           '#95a5a6'
  };

  const EDGE_COLORS = {
    associative:  'rgba(120, 181, 163, 0.25)',
    bridge:       'rgba(155, 89, 182, 0.35)',
    validates:    'rgba(46, 204, 113, 0.35)',
    contradicts:  'rgba(231, 76, 60, 0.40)',
    synthesizes:  'rgba(69, 183, 209, 0.35)',
    supersedes:   'rgba(255, 140, 66, 0.30)',
    refines:      'rgba(150, 206, 180, 0.30)',
    caused_by:    'rgba(255, 107, 107, 0.30)',
    resolved_by:  'rgba(46, 204, 113, 0.30)',
    triggered_by: 'rgba(127, 143, 166, 0.25)',
    depends_on:   'rgba(162, 155, 254, 0.25)',
    executed_by:  'rgba(135, 206, 235, 0.25)',
    produced:     'rgba(221, 160, 221, 0.30)'
  };

  // Cluster hues — generate distinct colors per cluster
  function clusterColor(clusterId) {
    if (clusterId == null) return '#78b5a3';
    const hue = (clusterId * 137.508) % 360; // golden angle
    return `hsl(${hue}, 55%, 60%)`;
  }

  function nodeColor(node) {
    // Tag takes priority for special types
    if (node.tag === 'breakthrough') return '#ffd700';
    if (node.tag === 'agent_failure') return '#e74c3c';
    if (node.tag === 'goal' || node.tag === 'milestone') return '#ff8c42';
    // Otherwise color by cluster
    return clusterColor(node.cluster);
  }

  function nodeSize(node) {
    const base = 2.5;
    const weightBoost = node.weight * 2;
    const activationBoost = node.activation * 3;
    const tagBoost = (node.tag === 'breakthrough' || node.tag === 'synthesis') ? 2 : 0;
    return base + weightBoost + activationBoost + tagBoost;
  }

  function edgeColor(edge) {
    return EDGE_COLORS[edge.type] || EDGE_COLORS.associative;
  }

  function edgeWidth(edge) {
    return 0.3 + edge.weight * 1.5;
  }

  function truncate(text, maxLen) {
    if (!text) return '';
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen - 1) + '\u2026';
  }

  // ── Graph rendering ───────────────────────────────────────────────────────

  function createGraph(containerId) {
    const container = document.getElementById(containerId);
    if (!container || !window.ForceGraph3D) return null;

    // Clean up previous observer
    if (activeResizeObserver) { activeResizeObserver.disconnect(); activeResizeObserver = null; }
    container.innerHTML = '';

    const g = window.ForceGraph3D()(container)
      .backgroundColor('#141a17')
      .showNavInfo(false)
      .nodeLabel(n => {
        const label = escapeHtml(truncate(n.concept, 120));
        const tag = n.tag || 'general';
        const safeTag = escapeHtml(tag);
        return `<div style="background:rgba(20,26,23,0.95);color:#e8e5df;padding:8px 12px;border-radius:6px;font-family:'DM Sans',sans-serif;font-size:12px;max-width:300px;line-height:1.45;border:1px solid rgba(255,255,255,0.06)">
          <div style="color:${TAG_COLORS[tag] || '#78b5a3'};font-family:'JetBrains Mono',monospace;font-size:9.5px;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:3px">${safeTag}</div>
          <div>${label}</div>
          <div style="color:#706c64;font-family:'JetBrains Mono',monospace;font-size:10px;margin-top:4px">w ${n.weight?.toFixed(2)} / a ${n.activation?.toFixed(2)}</div>
        </div>`;
      })
      .nodeColor(nodeColor)
      .nodeVal(nodeSize)
      .nodeOpacity(0.92)
      .nodeResolution(12)
      .linkColor(edgeColor)
      .linkWidth(edgeWidth)
      .linkOpacity(0.6)
      .linkDirectionalParticles(e => e.weight > 0.5 ? 2 : 0)
      .linkDirectionalParticleWidth(1)
      .linkDirectionalParticleSpeed(0.004)
      .linkDirectionalParticleColor(edgeColor)
      .d3AlphaDecay(0.02)
      .d3VelocityDecay(0.3)
      .warmupTicks(80)
      .cooldownTicks(200)
      .onNodeClick(handleNodeClick)
      .onBackgroundClick(handleBackgroundClick);

    // Cluster force — nodes in same cluster attract
    g.d3Force('cluster', alpha => {
      if (!graphData) return;
      const centroids = {};
      // Calculate cluster centroids
      graphData.nodes.forEach(n => {
        if (n.cluster == null) return;
        if (!centroids[n.cluster]) centroids[n.cluster] = { x: 0, y: 0, z: 0, count: 0 };
        centroids[n.cluster].x += n.x || 0;
        centroids[n.cluster].y += n.y || 0;
        centroids[n.cluster].z += n.z || 0;
        centroids[n.cluster].count++;
      });
      Object.values(centroids).forEach(c => {
        c.x /= c.count;
        c.y /= c.count;
        c.z /= c.count;
      });
      // Pull toward centroids
      const strength = alpha * 0.3;
      graphData.nodes.forEach(n => {
        if (n.cluster == null || !centroids[n.cluster]) return;
        const c = centroids[n.cluster];
        n.vx = (n.vx || 0) + (c.x - (n.x || 0)) * strength;
        n.vy = (n.vy || 0) + (c.y - (n.y || 0)) * strength;
        n.vz = (n.vz || 0) + (c.z - (n.z || 0)) * strength;
      });
    });

    // Responsive resize
    activeResizeObserver = new ResizeObserver(() => {
      const { width, height } = container.getBoundingClientRect();
      if (width > 0 && height > 0) {
        g.width(width).height(height);
      }
    });
    activeResizeObserver.observe(container);

    return g;
  }

  // ── Node detail panel ─────────────────────────────────────────────────────

  function handleNodeClick(node) {
    if (!node) return;
    selectedNode = node;

    // Focus camera on node
    const distance = 80;
    const mag = Math.hypot(node.x || 0, node.y || 0, node.z || 0);
    const distRatio = mag > 0 ? 1 + distance / mag : 1;
    graph.cameraPosition(
      { x: (node.x || 0) * distRatio, y: (node.y || 0) * distRatio, z: mag > 0 ? (node.z || 0) * distRatio : distance },
      node,
      1000
    );

    renderNodeDetail(node);
  }

  function handleBackgroundClick() {
    selectedNode = null;
    const panel = document.getElementById('brain-map-detail');
    if (panel) panel.classList.remove('open');
  }

  function renderNodeDetail(node) {
    const panel = document.getElementById('brain-map-detail');
    if (!panel) return;

    const tag = node.tag || 'general';
    const color = TAG_COLORS[tag] || '#78b5a3';
    const created = node.created ? new Date(node.created).toLocaleDateString() : 'Unknown';
    const accessed = node.accessed ? new Date(node.accessed).toLocaleDateString() : 'Unknown';

    // Find connected nodes
    const connections = [];
    if (graphData) {
      const nodeId = String(node.id);
      graphData.edges.forEach(e => {
        const sourceId = String(typeof e.source === 'object' ? e.source.id : e.source);
        const targetId = String(typeof e.target === 'object' ? e.target.id : e.target);
        if (sourceId === nodeId) {
          const target = graphData.nodes.find(n => String(n.id) === targetId);
          if (target) connections.push({ node: target, edge: e, direction: 'outgoing' });
        } else if (targetId === nodeId) {
          const source = graphData.nodes.find(n => String(n.id) === sourceId);
          if (source) connections.push({ node: source, edge: e, direction: 'incoming' });
        }
      });
    }

    const connectionsHtml = connections.slice(0, 12).map(c => {
      const cTag = c.node.tag || 'general';
      const cColor = TAG_COLORS[cTag] || '#78b5a3';
      const arrow = c.direction === 'outgoing' ? '\u2192' : '\u2190';
      return `<button class="map-connection-item" data-node-id="${c.node.id}" title="${escapeAttr(c.node.concept)}">
        <span class="map-connection-dot" style="background:${cColor}"></span>
        <span class="map-connection-type">${arrow} ${c.edge.type || 'associative'}</span>
        <span class="map-connection-label">${escapeHtml(truncate(c.node.concept, 50))}</span>
      </button>`;
    }).join('');

    panel.innerHTML = `
      <div class="map-detail-header">
        <div class="map-detail-tag" style="color:${color}">${tag.toUpperCase()}</div>
        <button class="map-detail-close" id="map-detail-close" title="Close">&times;</button>
      </div>
      <div class="map-detail-concept">${escapeHtml(node.concept)}</div>
      <div class="map-detail-meta">
        <div class="map-meta-row">
          <span class="map-meta-label">Weight</span>
          <span class="map-meta-value">${(node.weight || 0).toFixed(3)}</span>
        </div>
        <div class="map-meta-row">
          <span class="map-meta-label">Activation</span>
          <span class="map-meta-value">${(node.activation || 0).toFixed(3)}</span>
        </div>
        <div class="map-meta-row">
          <span class="map-meta-label">Cluster</span>
          <span class="map-meta-value">${node.cluster != null ? node.cluster : 'None'}</span>
        </div>
        <div class="map-meta-row">
          <span class="map-meta-label">Accessed</span>
          <span class="map-meta-value">${node.accessCount || 0}x</span>
        </div>
        <div class="map-meta-row">
          <span class="map-meta-label">Created</span>
          <span class="map-meta-value">${created}</span>
        </div>
      </div>
      ${connections.length > 0 ? `
        <div class="map-detail-connections">
          <div class="map-connections-title">${connections.length} Connection${connections.length !== 1 ? 's' : ''}</div>
          ${connectionsHtml}
        </div>
      ` : ''}
      <div class="map-detail-actions">
        <button class="map-action-btn" id="map-query-node">Query This Concept</button>
      </div>
    `;

    panel.classList.add('open');

    // Event listeners
    document.getElementById('map-detail-close').addEventListener('click', handleBackgroundClick);

    document.getElementById('map-query-node').addEventListener('click', () => {
      const app = window.cosmoStandaloneApp;
      if (app) {
        const queryInput = document.getElementById('qt-input');
        if (queryInput) {
          queryInput.value = `Explain and contextualize this concept from the brain's knowledge: "${truncate(node.concept, 200)}"`;
        }
        app.switchView('query');
      }
    });

    // Connection click → navigate to that node
    panel.querySelectorAll('.map-connection-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const targetId = btn.dataset.nodeId;
        const targetNode = graphData?.nodes.find(n => String(n.id) === targetId);
        if (targetNode) handleNodeClick(targetNode);
      });
    });
  }

  // ── Loading & data ────────────────────────────────────────────────────────

  async function loadGraph(brainRouteKey) {
    if (isLoading) return;
    if (!brainRouteKey) return;

    isLoading = true;
    graphData = null; // Clear stale data before loading new brain
    const container = document.getElementById('brain-map-container');
    const toolbar = document.getElementById('brain-map-toolbar');

    // Show loading state
    if (container) {
      container.innerHTML = '<div class="map-loading"><div class="map-loading-spinner"></div><div class="map-loading-text">Loading graph\u2026</div></div>';
    }

    try {
      const res = await fetch(`/api/brain/${encodeURIComponent(brainRouteKey)}/graph`);
      if (!res.ok) throw new Error(`Failed to load graph: ${res.status}`);
      const data = await res.json();

      if (!data.success || !data.nodes?.length) {
        if (container) container.innerHTML = '<div class="map-empty">No graph data available for this brain.</div>';
        isLoading = false;
        return;
      }

      // Build lookup for edge resolution
      const nodeIds = new Set(data.nodes.map(n => String(n.id)));
      // Filter edges to only include those with both endpoints present
      const validEdges = data.edges.filter(e =>
        nodeIds.has(String(e.source)) && nodeIds.has(String(e.target))
      );

      graphData = { nodes: data.nodes, edges: validEdges, clusters: data.clusters, meta: data.meta };
      currentBrainKey = brainRouteKey;

      // Initialize or update graph
      if (!graph) {
        graph = createGraph('brain-map-container');
      }

      if (graph) {
        graph.graphData({ nodes: data.nodes, links: validEdges });

        // Update stats
        const statsEl = document.getElementById('brain-map-stats');
        if (statsEl) {
          statsEl.textContent = `${data.meta.nodeCount} nodes \u00b7 ${data.meta.edgeCount} edges \u00b7 ${data.meta.clusterCount} clusters`;
        }

        // Show toolbar
        if (toolbar) toolbar.classList.add('visible');

        // Zoom to fit after layout settles
        setTimeout(() => {
          if (graph) graph.zoomToFit(400, 60);
        }, 2000);
      }
    } catch (err) {
      console.error('[BrainMap] Load failed:', err);
      if (container) {
        container.innerHTML = `<div class="map-empty">Failed to load graph: ${escapeHtml(err.message)}</div>`;
      }
    } finally {
      isLoading = false;
    }
  }

  // ── Toolbar actions ───────────────────────────────────────────────────────

  function zoomToFit() {
    if (graph) graph.zoomToFit(400, 60);
  }

  function resetCamera() {
    if (graph) {
      graph.cameraPosition({ x: 0, y: 0, z: 400 }, { x: 0, y: 0, z: 0 }, 1000);
    }
  }

  function refresh() {
    if (currentBrainKey) {
      graph = null; // Force recreate
      loadGraph(currentBrainKey);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function escapeAttr(str) {
    return (str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;');
  }

  // ── Public API ────────────────────────────────────────────────────────────

  window.BrainMap = {
    load: loadGraph,
    zoomToFit,
    resetCamera,
    refresh,
    isLoaded: () => !!graphData,
    getSelectedNode: () => selectedNode,
    destroy: () => {
      if (graph) {
        graph._destructor?.();
        graph = null;
      }
      graphData = null;
      currentBrainKey = null;
      selectedNode = null;
    }
  };
})();
