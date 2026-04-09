#!/usr/bin/env node

/**
 * COSMO Brain Browser
 * 
 * Landing page for discovering and managing local brains.
 * Scans for:
 * - .brain packages (exported, portable)
 * - runs/ directories (active COSMO runs)
 * 
 * Provides:
 * - Visual brain library
 * - Metadata preview (nodes, edges, domain, created)
 * - Launch Brain Studio v2
 * - Export runs as .brain
 * - Merge, fork operations (future)
 * 
 * Usage:
 *   node scripts/brain-browser.js [--port 3398]
 */

const http = require('http');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const { spawn } = require('child_process');

const gunzip = promisify(zlib.gunzip);

const PORT = process.env.PORT || 3398;
const WORKSPACE_ROOT = path.join(__dirname, '..');

// ============================================================================
// Brain Scanner
// ============================================================================

// Track running Brain Studio instances
const runningStudioInstances = new Map(); // brainName -> { port, pid, url }
const BASE_STUDIO_PORT = 3400; // Start at 3400, increment for each brain

class BrainScanner {
  constructor(workspaceRoot) {
    this.workspaceRoot = workspaceRoot;
    this.runsDir = path.join(workspaceRoot, 'runs');
  }

  /**
   * Scan for all available brains (both .brain packages and runs)
   */
  async scanAll() {
    const brainPackages = await this.scanBrainPackages();
    const runs = await this.scanRuns();
    
    return {
      brainPackages,
      runs,
      total: brainPackages.length + runs.length
    };
  }

  /**
   * Scan for .brain packages in workspace
   */
  async scanBrainPackages() {
    const brains = [];
    
    try {
      const entries = await fs.readdir(this.workspaceRoot, { withFileTypes: true });
      
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.endsWith('.brain')) {
          const brainPath = path.join(this.workspaceRoot, entry.name);
          const metadata = await this.loadBrainMetadata(brainPath);
          
          if (metadata) {
            brains.push({
              type: 'brain',
              name: entry.name.replace('.brain', ''),
              path: brainPath,
              relativePath: entry.name,
              ...metadata
            });
          }
        }
      }
    } catch (error) {
      console.error('[SCANNER] Failed to scan brain packages:', error);
    }
    
    return brains.sort((a, b) => 
      new Date(b.exported || b.created) - new Date(a.exported || a.created)
    );
  }

  /**
   * Scan runs directory for COSMO runs
   */
  async scanRuns() {
    const runs = [];
    
    if (!fsSync.existsSync(this.runsDir)) {
      return runs;
    }
    
    try {
      const entries = await fs.readdir(this.runsDir, { withFileTypes: true });
      
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('_') && !entry.name.startsWith('.')) {
          const runPath = path.join(this.runsDir, entry.name);
          const metadata = await this.loadRunMetadata(runPath);
          
          if (metadata) {
            runs.push({
              type: 'run',
              name: entry.name,
              path: runPath,
              relativePath: `runs/${entry.name}`,
              ...metadata
            });
          }
        }
      }
    } catch (error) {
      console.error('[SCANNER] Failed to scan runs:', error);
    }
    
    return runs.sort((a, b) => 
      new Date(b.created) - new Date(a.created)
    );
  }

  /**
   * Load metadata from .brain package
   */
  async loadBrainMetadata(brainPath) {
    try {
      const manifestPath = path.join(brainPath, 'manifest.json');
      const statePath = path.join(brainPath, 'state.json.gz');
      
      if (!fsSync.existsSync(statePath)) {
        return null;
      }

      let manifest = null;
      if (fsSync.existsSync(manifestPath)) {
        manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      }

      // Get file sizes
      const stat = await fs.stat(statePath);
      const totalSize = await this.getDirectorySize(brainPath);

      return {
        displayName: manifest?.brain?.displayName || manifest?.brain?.name,
        domain: manifest?.brain?.description,
        created: manifest?.brain?.created,
        exported: manifest?.brain?.exported,
        nodes: manifest?.content?.nodeCount || 0,
        edges: manifest?.content?.edgeCount || 0,
        cycles: manifest?.cosmo?.cycles || 0,
        size: totalSize,
        hasOutputs: fsSync.existsSync(path.join(brainPath, 'outputs')),
        hasCoordinator: fsSync.existsSync(path.join(brainPath, 'coordinator')),
        topics: manifest?.topics?.slice(0, 5) || []
      };
    } catch (error) {
      console.error(`[SCANNER] Failed to load brain metadata for ${brainPath}:`, error.message);
      return null;
    }
  }

  /**
   * Load metadata from COSMO run directory
   */
  async loadRunMetadata(runPath) {
    try {
      const statePath = path.join(runPath, 'state.json.gz');
      const metadataPath = path.join(runPath, 'run-metadata.json');
      
      if (!fsSync.existsSync(statePath)) {
        return null;
      }

      let runMetadata = {};
      if (fsSync.existsSync(metadataPath)) {
        runMetadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
      }

      // Load state for counts
      const compressed = await fs.readFile(statePath);
      const decompressed = await gunzip(compressed);
      const state = JSON.parse(decompressed.toString());

      const totalSize = await this.getDirectorySize(runPath);

      return {
        displayName: runMetadata.domain || path.basename(runPath),
        domain: runMetadata.context || '',
        created: runMetadata.created || state.timestamp,
        nodes: state.memory?.nodes?.length || 0,
        edges: state.memory?.edges?.length || 0,
        cycles: state.cycleCount || 0,
        mode: runMetadata.explorationMode || 'unknown',
        size: totalSize,
        hasOutputs: fsSync.existsSync(path.join(runPath, 'outputs')),
        hasCoordinator: fsSync.existsSync(path.join(runPath, 'coordinator')),
        isActive: fsSync.existsSync(path.join(runPath, 'runtime'))
      };
    } catch (error) {
      console.error(`[SCANNER] Failed to load run metadata for ${runPath}:`, error.message);
      return null;
    }
  }

  /**
   * Get total size of directory
   */
  async getDirectorySize(dirPath) {
    let totalSize = 0;
    
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        
        if (entry.isDirectory()) {
          totalSize += await this.getDirectorySize(fullPath);
        } else {
          const stat = await fs.stat(fullPath);
          totalSize += stat.size;
        }
      }
    } catch (error) {
      // Skip errors (permissions, etc.)
    }
    
    return totalSize;
  }
}

// ============================================================================
// HTML Template
// ============================================================================

function getHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>🧠 COSMO Brain Browser</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap');

    :root {
      --bg-primary: #0d1117;
      --bg-secondary: #161b22;
      --bg-tertiary: #21262d;
      --bg-hover: #30363d;
      --text-primary: #c9d1d9;
      --text-secondary: #8b949e;
      --text-muted: #6e7681;
      --accent: #58a6ff;
      --accent-hover: #79c0ff;
      --success: #3fb950;
      --warning: #d29922;
      --error: #f85149;
      --border: #30363d;
      --gradient-1: linear-gradient(135deg, #1f6feb 0%, #58a6ff 100%);
      --gradient-2: linear-gradient(135deg, #3fb950 0%, #56d364 100%);
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      overflow-x: hidden;
    }

    /* Header */
    .header {
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border);
      padding: 20px 40px;
    }

    .header-content {
      max-width: 1400px;
      margin: 0 auto;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .logo {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .logo-icon {
      font-size: 32px;
    }

    .logo-text h1 {
      font-size: 24px;
      font-weight: 700;
      background: var(--gradient-1);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .logo-text p {
      font-size: 13px;
      color: var(--text-secondary);
      margin-top: 4px;
    }

    .header-actions {
      display: flex;
      gap: 12px;
    }

    .btn {
      padding: 10px 20px;
      border-radius: 8px;
      border: none;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
      font-family: inherit;
    }

    .btn-primary {
      background: var(--accent);
      color: white;
    }

    .btn-primary:hover {
      background: var(--accent-hover);
      transform: translateY(-2px);
      box-shadow: 0 8px 24px rgba(88, 166, 255, 0.3);
    }

    .btn-secondary {
      background: var(--bg-tertiary);
      color: var(--text-primary);
      border: 1px solid var(--border);
    }

    .btn-secondary:hover {
      background: var(--bg-hover);
    }

    /* Main Content */
    .main {
      max-width: 1400px;
      margin: 0 auto;
      padding: 40px;
    }

    .section {
      margin-bottom: 48px;
    }

    .section-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
    }

    .section-title {
      font-size: 20px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .section-count {
      background: var(--bg-tertiary);
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 13px;
      color: var(--text-secondary);
      font-weight: 600;
    }

    .section-filter {
      display: flex;
      gap: 12px;
      align-items: center;
    }

    .search-input {
      padding: 8px 16px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text-primary);
      font-size: 14px;
      width: 300px;
    }

    .search-input:focus {
      outline: none;
      border-color: var(--accent);
    }

    /* Brain Grid */
    .brain-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
      gap: 24px;
    }

    .brain-card {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 24px;
      cursor: pointer;
      transition: all 0.3s;
      position: relative;
      overflow: hidden;
    }

    .brain-card:hover {
      border-color: var(--accent);
      transform: translateY(-4px);
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.3);
    }

    .brain-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 4px;
      background: var(--gradient-1);
      opacity: 0;
      transition: opacity 0.3s;
    }

    .brain-card:hover::before {
      opacity: 1;
    }

    .brain-card.type-run::before {
      background: var(--gradient-2);
    }

    .brain-type {
      position: absolute;
      top: 16px;
      right: 16px;
      padding: 4px 10px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .brain-type.brain {
      background: rgba(88, 166, 255, 0.15);
      color: var(--accent);
    }

    .brain-type.run {
      background: rgba(63, 185, 80, 0.15);
      color: var(--success);
    }

    .brain-name {
      font-size: 20px;
      font-weight: 700;
      margin-bottom: 8px;
      color: var(--text-primary);
    }

    .brain-domain {
      font-size: 13px;
      color: var(--text-secondary);
      margin-bottom: 16px;
      line-height: 1.5;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .brain-stats {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
      margin: 20px 0;
    }

    .stat {
      text-align: center;
      padding: 12px;
      background: var(--bg-tertiary);
      border-radius: 8px;
    }

    .stat-value {
      font-size: 20px;
      font-weight: 700;
      font-family: 'JetBrains Mono', monospace;
      color: var(--accent);
      display: block;
    }

    .stat-label {
      font-size: 11px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-top: 4px;
    }

    .brain-meta {
      display: flex;
      gap: 16px;
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid var(--border);
    }

    .brain-meta-item {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .brain-actions {
      display: flex;
      gap: 8px;
      margin-top: 16px;
    }

    .btn-small {
      flex: 1;
      padding: 8px 16px;
      border-radius: 6px;
      border: none;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
      font-family: inherit;
    }

    .btn-view {
      background: var(--accent);
      color: white;
    }

    .btn-view:hover {
      background: var(--accent-hover);
      transform: translateY(-1px);
    }

    .btn-export {
      background: var(--bg-tertiary);
      color: var(--text-primary);
      border: 1px solid var(--border);
    }

    .btn-export:hover {
      background: var(--bg-hover);
    }

    .brain-topics {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 12px;
    }

    .topic-tag {
      padding: 4px 10px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      border-radius: 4px;
      font-size: 11px;
      color: var(--text-secondary);
    }

    /* Empty State */
    .empty-state {
      text-align: center;
      padding: 80px 40px;
      color: var(--text-muted);
    }

    .empty-icon {
      font-size: 64px;
      margin-bottom: 16px;
      opacity: 0.5;
    }

    .empty-title {
      font-size: 20px;
      color: var(--text-secondary);
      margin-bottom: 12px;
    }

    .empty-description {
      font-size: 14px;
      line-height: 1.6;
      max-width: 500px;
      margin: 0 auto;
    }

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

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    /* Stats Bar */
    .stats-bar {
      background: var(--bg-tertiary);
      border-radius: 12px;
      padding: 20px 24px;
      margin-bottom: 32px;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 24px;
    }

    .stats-item {
      text-align: center;
    }

    .stats-value {
      font-size: 32px;
      font-weight: 700;
      font-family: 'JetBrains Mono', monospace;
      background: var(--gradient-1);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .stats-label {
      font-size: 12px;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-top: 8px;
    }

    /* Scrollbar */
    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-track { background: var(--bg-primary); }
    ::-webkit-scrollbar-thumb { background: var(--bg-hover); border-radius: 4px; }
    ::-webkit-scrollbar-thumb:hover { background: var(--border); }

    /* Responsive */
    @media (max-width: 768px) {
      .brain-grid {
        grid-template-columns: 1fr;
      }
      .main {
        padding: 20px;
      }
    }
  </style>
</head>
<body>
  <header class="header">
    <div class="header-content">
      <div class="logo">
        <div class="logo-icon">🧠</div>
        <div class="logo-text">
          <h1>COSMO Brain Browser</h1>
          <p>Discover, explore, and manage your AI knowledge</p>
        </div>
      </div>
      <div class="header-actions">
        <button class="btn btn-secondary" onclick="location.reload()">🔄 Refresh</button>
        <button class="btn btn-primary" onclick="window.open('/docs', '_blank')">📖 Docs</button>
      </div>
    </div>
  </header>

  <main class="main">
    <!-- Stats Bar -->
    <div class="stats-bar" id="statsBar" style="display: none;">
      <div class="stats-item">
        <div class="stats-value" id="totalBrains">-</div>
        <div class="stats-label">Total Brains</div>
      </div>
      <div class="stats-item">
        <div class="stats-value" id="totalNodes">-</div>
        <div class="stats-label">Total Knowledge Nodes</div>
      </div>
      <div class="stats-item">
        <div class="stats-value" id="totalSize">-</div>
        <div class="stats-label">Total Size</div>
      </div>
    </div>

    <!-- Brain Packages -->
    <section class="section">
      <div class="section-header">
        <div class="section-title">
          📦 Exported Brain Packages
          <span class="section-count" id="brainPackagesCount">0</span>
        </div>
        <div class="section-filter">
          <input type="text" class="search-input" id="brainSearch" placeholder="🔍 Search brains...">
        </div>
      </div>
      <div class="brain-grid" id="brainPackagesGrid">
        <div style="text-align: center; padding: 40px; color: var(--text-muted);">
          <div class="loading"></div>
          <div style="margin-top: 12px;">Scanning brain packages...</div>
        </div>
      </div>
    </section>

    <!-- COSMO Runs -->
    <section class="section">
      <div class="section-header">
        <div class="section-title">
          🚀 COSMO Runs
          <span class="section-count" id="runsCount">0</span>
        </div>
        <div class="section-filter">
          <input type="text" class="search-input" id="runSearch" placeholder="🔍 Search runs...">
        </div>
      </div>
      <div class="brain-grid" id="runsGrid">
        <div style="text-align: center; padding: 40px; color: var(--text-muted);">
          <div class="loading"></div>
          <div style="margin-top: 12px;">Scanning runs...</div>
        </div>
      </div>
    </section>
  </main>

  <script>
    let allBrains = { brainPackages: [], runs: [] };

    async function init() {
      try {
        const data = await fetch('/api/scan').then(r => r.json());
        allBrains = data;
        
        // Update stats
        const totalNodes = [...data.brainPackages, ...data.runs].reduce((sum, b) => sum + (b.nodes || 0), 0);
        const totalSize = [...data.brainPackages, ...data.runs].reduce((sum, b) => sum + (b.size || 0), 0);
        
        document.getElementById('totalBrains').textContent = data.total;
        document.getElementById('totalNodes').textContent = totalNodes.toLocaleString();
        document.getElementById('totalSize').textContent = formatBytes(totalSize);
        document.getElementById('statsBar').style.display = 'grid';
        
        // Render grids
        renderBrainPackages(data.brainPackages);
        renderRuns(data.runs);
        
        // Setup search
        document.getElementById('brainSearch').addEventListener('input', (e) => {
          const filtered = filterBrains(data.brainPackages, e.target.value);
          renderBrainPackages(filtered);
        });
        
        document.getElementById('runSearch').addEventListener('input', (e) => {
          const filtered = filterBrains(data.runs, e.target.value);
          renderRuns(filtered);
        });
        
      } catch (error) {
        console.error('Failed to load brains:', error);
      }
    }

    function filterBrains(brains, query) {
      if (!query) return brains;
      const q = query.toLowerCase();
      return brains.filter(b => 
        b.name.toLowerCase().includes(q) ||
        (b.displayName || '').toLowerCase().includes(q) ||
        (b.domain || '').toLowerCase().includes(q)
      );
    }

    function renderBrainPackages(brains) {
      const grid = document.getElementById('brainPackagesGrid');
      document.getElementById('brainPackagesCount').textContent = brains.length;
      
      if (brains.length === 0) {
        grid.innerHTML = '<div class="empty-state"><div class="empty-icon">📦</div><div class="empty-title">No brain packages found</div><div class="empty-description">Export a run using: <code>brain export &lt;run&gt; --output &lt;name&gt;.brain</code></div></div>';
        return;
      }
      
      grid.innerHTML = brains.map(brain => createBrainCard(brain)).join('');
    }

    function renderRuns(runs) {
      const grid = document.getElementById('runsGrid');
      document.getElementById('runsCount').textContent = runs.length;
      
      if (runs.length === 0) {
        grid.innerHTML = '<div class="empty-state"><div class="empty-icon">🚀</div><div class="empty-title">No COSMO runs found</div><div class="empty-description">Start a new run using the COSMO launcher</div></div>';
        return;
      }
      
      grid.innerHTML = runs.map(run => createBrainCard(run)).join('');
    }

    function createBrainCard(brain) {
      const isBrain = brain.type === 'brain';
      const date = new Date(brain.exported || brain.created).toLocaleDateString();
      const time = new Date(brain.exported || brain.created).toLocaleTimeString();
      
      return \`
        <div class="brain-card type-\${brain.type}">
          <div class="brain-type \${brain.type}">\${isBrain ? '📦 Brain' : '🚀 Run'}</div>
          
          <div class="brain-name">\${escapeHtml(brain.displayName || brain.name)}</div>
          <div class="brain-domain">\${escapeHtml(brain.domain || 'No description')}</div>
          
          <div class="brain-stats">
            <div class="stat">
              <span class="stat-value">\${(brain.nodes || 0).toLocaleString()}</span>
              <span class="stat-label">Nodes</span>
            </div>
            <div class="stat">
              <span class="stat-value">\${(brain.edges || 0).toLocaleString()}</span>
              <span class="stat-label">Edges</span>
            </div>
            <div class="stat">
              <span class="stat-value">\${(brain.cycles || 0).toLocaleString()}</span>
              <span class="stat-label">Cycles</span>
            </div>
          </div>
          
          \${brain.topics && brain.topics.length > 0 ? \`
            <div class="brain-topics">
              \${brain.topics.map(t => \`<span class="topic-tag">\${t.topic || t} (\${t.count || ''})</span>\`).join('')}
            </div>
          \` : ''}
          
          <div class="brain-meta">
            <div class="brain-meta-item">📅 \${date} \${time}</div>
            <div class="brain-meta-item">💾 \${formatBytes(brain.size || 0)}</div>
            \${brain.hasOutputs ? '<div class="brain-meta-item">📁 Outputs</div>' : ''}
            \${brain.hasCoordinator ? '<div class="brain-meta-item">🎯 Insights</div>' : ''}
          </div>
          
          <div class="brain-actions">
            <button class="btn-small btn-view" onclick="viewBrain('\${escapeHtml(brain.relativePath)}')">
              👁️ Explore
            </button>
            \${!isBrain ? \`
              <button class="btn-small btn-export" onclick="exportRun('\${escapeHtml(brain.name)}')">
                📤 Export
              </button>
            \` : ''}
          </div>
        </div>
      \`;
    }

    async function viewBrain(relativePath) {
      // Simple: Just tell user to launch Brain Studio with this brain
      const brainName = relativePath.split('/').pop().replace('.brain', '');
      
      // Copy command to clipboard would be nice, but just show it
      if (confirm(\`Open \${brainName} in Brain Studio?\\n\\nFull IDE + Query Engine\\nThis will launch on http://localhost:3407\`)) {
        // Trigger backend to launch Brain Studio (full IDE)
        fetch('/api/launch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ brainPath: relativePath })
        }).then(() => {
          // Give it 3 seconds to start, then open
          setTimeout(() => {
            window.open('http://localhost:3407', '_blank');
          }, 3000);
          
          showToast('🧠 Launching Brain Studio (Full IDE)...\\nOpening on port 3407 in 3 seconds');
        });
      }
    }
    
    function showToast(message) {
      const toast = document.createElement('div');
      toast.style.cssText = 'position: fixed; bottom: 32px; right: 32px; background: #161b22; color: #c9d1d9; padding: 16px 24px; border-radius: 8px; border: 1px solid #30363d; box-shadow: 0 8px 24px rgba(0,0,0,0.4); z-index: 9999; white-space: pre-line; font-size: 14px; animation: slideIn 0.3s ease-out;';
      toast.textContent = message;
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 5000);
    }

    async function exportRun(runName) {
      if (!confirm(\`Export "\${runName}" as .brain package?\\n\\nThis will create \${runName}.brain with full outputs.\`)) {
        return;
      }
      
      try {
        const res = await fetch('/api/export-run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runName, withOutputs: true })
        });
        
        const result = await res.json();
        
        if (result.success) {
          alert(\`✅ Export complete!\\n\\nLocation: \${result.output}\\nSize: \${formatBytes(result.size || 0)}\`);
          location.reload();
        } else {
          alert(\`❌ Export failed: \${result.error}\`);
        }
      } catch (error) {
        alert(\`❌ Export failed: \${error.message}\`);
      }
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function formatBytes(bytes) {
      if (bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    init();
  </script>
</body>
</html>`;
}

// ============================================================================
// Server
// ============================================================================

async function startServer() {
  const scanner = new BrainScanner(WORKSPACE_ROOT);
  
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = url.pathname;

    res.setHeader('Access-Control-Allow-Origin', '*');

    try {
      if (pathname === '/') {
        res.setHeader('Content-Type', 'text/html');
        res.end(getHTML());
        return;
      }

      if (pathname === '/api/scan') {
        const data = await scanner.scanAll();
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(data));
        return;
      }

      if (pathname === '/api/running') {
        const instances = Array.from(runningStudioInstances.entries()).map(([name, info]) => ({
          brainName: name,
          port: info.port,
          url: info.url,
          started: info.started,
          uptime: Date.now() - info.started
        }));
        
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ instances, count: instances.length }));
        return;
      }

      if (pathname === '/api/export-run' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { runName, withOutputs } = JSON.parse(body);

        try {
          // Execute brain-cli export
          const { spawn } = require('child_process');
          const cliPath = path.join(__dirname, 'brain-cli.js');
          const args = ['export', runName, '--output', `${runName}.brain`];
          if (withOutputs) args.push('--with-outputs');

          const proc = spawn('node', [cliPath, ...args], {
            cwd: WORKSPACE_ROOT,
            stdio: 'pipe'
          });

          let output = '';
          proc.stdout.on('data', data => output += data.toString());
          proc.stderr.on('data', data => output += data.toString());

          await new Promise((resolve, reject) => {
            proc.on('close', code => {
              if (code === 0) resolve();
              else reject(new Error(`Export failed with code ${code}`));
            });
          });

          // Get size of exported brain
          const brainPath = path.join(WORKSPACE_ROOT, `${runName}.brain`);
          const size = await scanner.getDirectorySize(brainPath);

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            success: true,
            output: `${runName}.brain`,
            size
          }));
          return;
        } catch (error) {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            success: false,
            error: error.message
          }));
          return;
        }
      }

      if (pathname === '/api/launch' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { brainPath } = JSON.parse(body);

        // Kill any existing Brain Studio
        const { exec } = require('child_process');
        exec('lsof -ti:3407 | xargs kill -9 2>/dev/null; lsof -ti:3408 | xargs kill -9 2>/dev/null', () => {
          // Launch Brain Studio (full IDE) on port 3407
          setTimeout(() => {
            const studioPath = path.join(WORKSPACE_ROOT, 'brain-studio-new/server/server.js');
            const fullBrainPath = path.join(WORKSPACE_ROOT, brainPath);

            const proc = spawn('node', [studioPath, fullBrainPath], {
              cwd: path.join(WORKSPACE_ROOT, 'brain-studio-new'),
              detached: true,
              stdio: 'ignore'
            });
            
            proc.unref();
            console.log(`[BROWSER] Launched Brain Studio (full IDE) for "${brainPath}" on port 3407`);
          }, 1000);
        });

        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true, port: 3399 }));
        return;
      }

      if (pathname === '/docs') {
        const docsPath = path.join(WORKSPACE_ROOT, 'docs', 'BRAIN_PLATFORM_VISION.md');
        if (fsSync.existsSync(docsPath)) {
          const content = await fs.readFile(docsPath, 'utf8');
          res.setHeader('Content-Type', 'text/plain');
          res.end(content);
          return;
        }
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
    console.log('║              🧠 COSMO BRAIN BROWSER                          ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log('║                                                              ║');
    console.log(`║  🌐 Open: http://localhost:${PORT}`.padEnd(63) + '║');
    console.log('║                                                              ║');
    console.log('║  Features:                                                   ║');
    console.log('║   📦 Browse exported .brain packages                         ║');
    console.log('║   🚀 Browse COSMO runs                                       ║');
    console.log('║   👁️  Launch Brain Studio v2                                 ║');
    console.log('║   📤 Export runs as .brain packages                          ║');
    console.log('║   🔍 Search and filter brains                                ║');
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

  if (args.includes('--help')) {
    console.log(`
🧠 COSMO BRAIN BROWSER

Landing page for discovering and managing local brains.

USAGE:
  node scripts/brain-browser.js [--port 3398]

OPTIONS:
  --port PORT    Server port (default: 3398)
  --help         Show this help

EXAMPLES:
  node scripts/brain-browser.js
  node scripts/brain-browser.js --port 8080
`);
    return;
  }

  await startServer();
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});

