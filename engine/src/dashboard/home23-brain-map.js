/**
 * Home23 Brain Map — 3D force-directed knowledge graph visualization
 *
 * Adapted from COSMO 2.3's brain-map.js for the Home23 dashboard.
 * Uses 3d-force-graph (three.js) for immersive node exploration.
 */

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────

  let graph = null;
  let graphData = null;
  let selectedNode = null;
  let isLoading = false;
  let initialized = false;
  let activeResizeObserver = null;
  let clusterCentroids = {};

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
    associative:  'rgba(120, 181, 163, 0.45)',
    bridge:       'rgba(155, 89, 182, 0.12)',
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

  function clusterColor(clusterId) {
    if (clusterId == null) return '#78b5a3';
    const hue = (clusterId * 137.508) % 360;
    return `hsl(${hue}, 55%, 60%)`;
  }

  // Fibonacci-sphere centroids — one fixed anchor per cluster so communities
  // settle into distinct spatial regions instead of collapsing at origin.
  function computeClusterCentroids(nodes) {
    const unique = Array.from(new Set(nodes.map(n => n.cluster).filter(c => c != null)));
    const N = unique.length;
    if (N === 0) return {};
    const R = Math.max(260, 70 * Math.cbrt(nodes.length) + N * 14);
    const phi = Math.PI * (Math.sqrt(5) - 1);
    const centroids = {};
    unique.forEach((id, i) => {
      const y = N === 1 ? 0 : 1 - (i / (N - 1)) * 2;
      const ring = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = phi * i;
      centroids[id] = {
        x: Math.cos(theta) * ring * R,
        y: y * R,
        z: Math.sin(theta) * ring * R
      };
    });
    return centroids;
  }

  function seedPositions(nodes, centroids) {
    nodes.forEach(n => {
      const c = centroids[n.cluster];
      if (!c) return;
      const jitter = 45;
      n.x = c.x + (Math.random() - 0.5) * jitter;
      n.y = c.y + (Math.random() - 0.5) * jitter;
      n.z = c.z + (Math.random() - 0.5) * jitter;
    });
  }

  function nodeColor(node) {
    if (node.tag === 'breakthrough') return '#ffd700';
    if (node.tag === 'agent_failure') return '#e74c3c';
    if (node.tag === 'goal' || node.tag === 'milestone') return '#ff8c42';
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
    if (edge.type === 'bridge') return 0.15 + edge.weight * 0.4;
    return 0.3 + edge.weight * 1.5;
  }

  function truncate(text, maxLen) {
    if (!text) return '';
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen - 1) + '\u2026';
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function escapeAttr(str) {
    return (str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;');
  }

  // ── Graph rendering ───────────────────────────────────────────────────────

  function createGraph(containerId) {
    const container = document.getElementById(containerId);
    if (!container || !window.ForceGraph3D) return null;

    if (activeResizeObserver) { activeResizeObserver.disconnect(); activeResizeObserver = null; }
    container.innerHTML = '';

    const g = window.ForceGraph3D()(container)
      .backgroundColor('rgba(0,0,0,0)')
      .showNavInfo(true)
      .enableNavigationControls(true)
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
      .nodeResolution(8)
      .linkColor(edgeColor)
      .linkWidth(edgeWidth)
      .linkOpacity(0.6)
      .linkDirectionalParticles(e => e.weight > 0.8 ? 1 : 0)
      .linkDirectionalParticleWidth(1)
      .linkDirectionalParticleSpeed(0.004)
      .linkDirectionalParticleColor(edgeColor)
      .d3AlphaDecay(0.02)
      .d3VelocityDecay(0.3)
      .warmupTicks(50)
      .cooldownTicks(120)
      .onNodeClick(handleNodeClick)
      .onBackgroundClick(handleBackgroundClick);

    // Pull each node toward its cluster's FIXED centroid on the Fibonacci
    // sphere — prevents the drift-to-origin collapse that hides communities.
    g.d3Force('cluster', alpha => {
      if (!graphData) return;
      const strength = alpha * 0.55;
      graphData.nodes.forEach(n => {
        const c = clusterCentroids[n.cluster];
        if (!c) return;
        n.vx = (n.vx || 0) + (c.x - (n.x || 0)) * strength;
        n.vy = (n.vy || 0) + (c.y - (n.y || 0)) * strength;
        n.vz = (n.vz || 0) + (c.z - (n.z || 0)) * strength;
      });
    });

    // Stronger, shorter-range repulsion separates clusters spatially while
    // letting intra-cluster links keep each region tight.
    const charge = g.d3Force('charge');
    if (charge && charge.strength) charge.strength(-75).distanceMax(280);

    // Default center force fights the sphere layout — drop it.
    g.d3Force('center', null);

    // Bridge edges are Watts-Strogatz random shortcuts (dream rewiring) — they
    // cross clusters by design. Letting them pull at full force drags hub
    // nodes out of their home cluster with 200+ vectors. Keep them visible
    // but weaken their layout pull so clusters stay coherent.
    const linkForce = g.d3Force('link');
    if (linkForce) {
      if (linkForce.distance) {
        linkForce.distance(e => {
          const base = e.type === 'bridge' ? 180 : 28;
          return base + (1 - (e.weight || 0)) * 40;
        });
      }
      if (linkForce.strength) {
        linkForce.strength(e => e.type === 'bridge' ? 0.04 : 0.6);
      }
    }

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
    if (panel) { panel.classList.remove('active'); }
  }

  function renderNodeDetail(node) {
    const panel = document.getElementById('brain-map-detail');
    if (!panel) return;

    const tag = node.tag || 'general';
    const color = TAG_COLORS[tag] || '#78b5a3';
    const created = node.created ? new Date(node.created).toLocaleDateString() : 'Unknown';

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
    `;

    panel.classList.add('active');

    // Close button
    document.getElementById('map-detail-close').addEventListener('click', handleBackgroundClick);

    // Connection click — navigate to that node
    panel.querySelectorAll('.map-connection-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const targetId = btn.dataset.nodeId;
        const targetNode = graphData?.nodes.find(n => String(n.id) === targetId);
        if (targetNode) handleNodeClick(targetNode);
      });
    });
  }

  // ── Loading & data ────────────────────────────────────────────────────────

  async function loadGraph() {
    if (isLoading) return;

    isLoading = true;
    graphData = null;
    const container = document.getElementById('brain-map-container');

    if (container) {
      container.innerHTML = '<div class="h23-brain-map-loading"><div>Loading graph\u2026</div></div>';
    }

    try {
      const res = await fetch('/home23/api/brain/graph');
      if (!res.ok) throw new Error('Failed to load graph: ' + res.status);
      const data = await res.json();

      if (!data.success || !data.nodes?.length) {
        if (container) container.innerHTML = '<div class="h23-brain-map-empty">No graph data available.</div>';
        isLoading = false;
        return;
      }

      // Filter edges to only those with both endpoints present
      const nodeIds = new Set(data.nodes.map(n => String(n.id)));
      const validEdges = data.edges.filter(e =>
        nodeIds.has(String(e.source)) && nodeIds.has(String(e.target))
      );

      graphData = { nodes: data.nodes, edges: validEdges, clusters: data.clusters, meta: data.meta };

      clusterCentroids = computeClusterCentroids(data.nodes);
      seedPositions(data.nodes, clusterCentroids);

      if (!graph) {
        graph = createGraph('brain-map-container');
      }

      if (graph) {
        graph.graphData({ nodes: data.nodes, links: validEdges });

        // Update stats
        const statsEl = document.getElementById('brain-map-stats');
        if (statsEl) {
          statsEl.textContent = data.meta.nodeCount + ' nodes \u00b7 ' + data.meta.edgeCount + ' edges \u00b7 ' + data.meta.clusterCount + ' clusters';
        }

        // Start zoomed out, then fit to view — delay fit so the sphere layout
        // has time to settle before the camera locks on.
        graph.cameraPosition({ x: 0, y: 0, z: 1400 });
        setTimeout(() => {
          if (graph) graph.zoomToFit(1000, 120);
        }, 2200);
      }
    } catch (err) {
      console.error('[BrainMap] Load failed:', err);
      if (container) {
        container.innerHTML = '<div class="h23-brain-map-empty">Failed to load graph: ' + escapeHtml(err.message) + '</div>';
      }
    } finally {
      isLoading = false;
    }
  }

  // ── Search ────────────────────────────────────────────────────────────────

  function setupSearch() {
    const searchInput = document.getElementById('brain-map-search');
    if (!searchInput) return;

    let debounce = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        const query = searchInput.value.trim().toLowerCase();
        if (!graph || !graphData) return;

        if (!query) {
          // Reset all node visibility
          graph.nodeColor(nodeColor);
          graph.nodeVal(nodeSize);
          return;
        }

        // Highlight matching nodes, dim others
        graph.nodeColor(node => {
          const match = (node.concept || '').toLowerCase().includes(query) ||
                        (node.tag || '').toLowerCase().includes(query);
          return match ? nodeColor(node) : 'rgba(60,60,60,0.3)';
        });
        graph.nodeVal(node => {
          const match = (node.concept || '').toLowerCase().includes(query) ||
                        (node.tag || '').toLowerCase().includes(query);
          return match ? nodeSize(node) * 1.5 : nodeSize(node) * 0.5;
        });
      }, 300);
    });
  }

  function setupReset() {
    const resetBtn = document.getElementById('brain-map-reset');
    if (!resetBtn) return;

    resetBtn.addEventListener('click', () => {
      if (graph) {
        graph.cameraPosition({ x: 0, y: 0, z: 400 }, { x: 0, y: 0, z: 0 }, 1000);
        graph.nodeColor(nodeColor);
        graph.nodeVal(nodeSize);
      }
      const searchInput = document.getElementById('brain-map-search');
      if (searchInput) searchInput.value = '';
      handleBackgroundClick();
    });
  }

  // ── Public init ───────────────────────────────────────────────────────────

  window.initBrainMap = function () {
    if (initialized) return; // Only load once
    initialized = true;
    setupSearch();
    setupReset();
    loadGraph();
  };

})();
