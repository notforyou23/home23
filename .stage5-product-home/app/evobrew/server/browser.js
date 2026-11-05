#!/usr/bin/env node

/**
 * COSMO Brain Browser (Portable)
 * 
 * Landing page for discovering and managing local brains.
 * Refactored for standalone use with full features (Scan, Export, Launch).
 */

const http = require('http');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const { spawn, execSync } = require('child_process');

const gunzip = promisify(zlib.gunzip);

// Configurable constants
const PORT = process.env.BROWSER_PORT || 3398;
const STUDIO_PORT = process.env.STUDIO_PORT || 3407;

// Paths relative to this file (in server/ folder)
const SERVER_DIR = __dirname;
const PLATFORM_ROOT = path.join(SERVER_DIR, '..');

class BrainScanner {
  constructor(platformRoot) {
    this.platformRoot = platformRoot;
    // Local brains are always scanned
    this.brainsDir = path.join(platformRoot, 'brains');
    
    // External runs path (optional, from .env)
    // This connects the standalone player to the COSMO research engine
    this.externalRunsDir = process.env.COSMO_RUNS_PATH ? 
      path.resolve(platformRoot, process.env.COSMO_RUNS_PATH) : 
      null;
      
    // Local runs folder within this repo (fallback staging area)
    this.localRunsDir = path.join(platformRoot, 'runs');

    // Additional brain/run directories (comma-separated paths)
    // Supports both packaged .brain dirs and raw run dirs
    this.extraDirs = (process.env.COSMO_BRAIN_DIRS || '')
      .split(',')
      .map(p => p.trim())
      .filter(Boolean)
      .map(p => path.resolve(platformRoot, p));
  }

  async scanAll() {
    try {
      const brainPackages = await this.scanBrainsFromDir(this.brainsDir);
      
      // Scan runs from both local and external sources
      const externalRuns = this.externalRunsDir ? await this.scanRunsFromDir(this.externalRunsDir) : [];
      const localRuns = await this.scanRunsFromDir(this.localRunsDir);
      
      // Scan extra dirs (COSMO_BRAIN_DIRS) — auto-detect brains vs runs
      const extraBrains = [];
      const extraRuns = [];
      for (const dir of this.extraDirs) {
        if (!fsSync.existsSync(dir)) {
          console.log(`[SCANNER] Extra dir not found (skipping): ${dir}`);
          continue;
        }
        // Scan for .brain packages
        const brains = await this.scanBrainsFromDir(dir);
        extraBrains.push(...brains);
        // Scan for runs (with one-level auto-recurse for container dirs)
        const runs = await this.scanRunsFromDir(dir, { recurse: true });
        extraRuns.push(...runs);
      }
      brainPackages.push(...extraBrains);

      // Combine and deduplicate runs by name
      const allRuns = [...localRuns, ...externalRuns, ...extraRuns];
      const uniqueRuns = [];
      const seenRunNames = new Set();
      
      for (const run of allRuns) {
        if (!seenRunNames.has(run.name)) {
          seenRunNames.add(run.name);
          uniqueRuns.push(run);
        }
      }

      // Cross-link brains and runs to show lineage
      brainPackages.forEach(brain => {
        const sourceRunName = brain.lineage?.publishedFrom || brain.name;
        const matchingRun = uniqueRuns.find(r => r.name === sourceRunName);
        if (matchingRun) {
          brain.sourceRun = matchingRun.name;
          matchingRun.exportedTo = brain.name;
        }
      });
      
      console.log(`[SCANNER] Found ${brainPackages.length} brain packages, ${uniqueRuns.length} runs (${this.extraDirs.length} extra dirs)`);

      return {
        brainPackages,
        runs: uniqueRuns,
        total: brainPackages.length + uniqueRuns.length
      };
    } catch (error) {
      console.error('[SCANNER] Fatal error during scan:', error);
      return { brainPackages: [], runs: [], total: 0, error: error.message };
    }
  }

  async scanBrainsFromDir(dir) {
    const brains = [];
    if (!fsSync.existsSync(dir)) return brains;
    
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.endsWith('.brain')) {
          const brainPath = path.join(dir, entry.name);
          const metadata = await this.loadBrainMetadata(brainPath);
          
          if (metadata) {
            brains.push({
              type: 'brain',
              name: entry.name.replace('.brain', ''),
              path: brainPath,
              relativePath: path.relative(this.platformRoot, brainPath),
              ...metadata
            });
          }
        }
      }
    } catch (error) {
      console.error(`[SCANNER] Failed to scan brains in ${dir}:`, error.message);
    }
    return brains.sort((a, b) => new Date(b.created) - new Date(a.created));
  }

  async scanRunsFromDir(dir, opts = {}) {
    const runs = [];
    if (!fsSync.existsSync(dir)) return runs;
    
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          const runPath = path.join(dir, entry.name);
          const metadata = await this.loadRunMetadata(runPath);
          
          if (metadata) {
            runs.push({
              type: 'run',
              name: entry.name,
              path: runPath,
              relativePath: path.relative(this.platformRoot, runPath),
              ...metadata
            });
          } else if (opts.recurse) {
            // No state file here — check one level deeper (container dir like _allTesting/)
            try {
              const subEntries = await fs.readdir(runPath, { withFileTypes: true });
              for (const sub of subEntries) {
                if (sub.isDirectory() && !sub.name.startsWith('.')) {
                  const subPath = path.join(runPath, sub.name);
                  const subMeta = await this.loadRunMetadata(subPath);
                  if (subMeta) {
                    runs.push({
                      type: 'run',
                      name: sub.name,
                      path: subPath,
                      relativePath: path.relative(this.platformRoot, subPath),
                      ...subMeta
                    });
                  }
                }
              }
            } catch (e) {
              // Skip unreadable subdirs
            }
          }
        }
      }
    } catch (error) {
      console.error(`[SCANNER] Failed to scan runs in ${dir}:`, error.message);
    }
    
    return runs.sort((a, b) => new Date(b.created) - new Date(a.created));
  }

  async loadBrainMetadata(brainPath) {
    try {
      const manifestPath = path.join(brainPath, 'manifest.json');
      const statePath = path.join(brainPath, 'state.json.gz');
      if (!fsSync.existsSync(statePath)) return null;
      let manifest = null;
      if (fsSync.existsSync(manifestPath)) {
        manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      }
      const size = await this.getDirectorySize(brainPath);
      return {
        displayName: manifest?.brain?.displayName || manifest?.brain?.name || path.basename(brainPath).replace('.brain', ''),
        domain: manifest?.brain?.description || '',
        created: manifest?.brain?.created || (await fs.stat(statePath)).birthtime,
        exported: manifest?.brain?.exported,
        nodes: manifest?.content?.nodeCount || 0,
        edges: manifest?.content?.edgeCount || 0,
        cycles: manifest?.cosmo?.cycles || 0,
        size,
        hasOutputs: fsSync.existsSync(path.join(brainPath, 'outputs')),
        hasCoordinator: fsSync.existsSync(path.join(brainPath, 'coordinator')),
        topics: manifest?.topics?.slice(0, 5) || [],
        lineage: manifest?.lineage || null
      };
    } catch (e) { return null; }
  }

  async loadRunMetadata(runPath) {
    try {
      const statePath = path.join(runPath, 'state.json.gz');
      const metadataPath = path.join(runPath, 'run-metadata.json');
      if (!fsSync.existsSync(statePath)) return null;
      let runMetadata = {};
      if (fsSync.existsSync(metadataPath)) {
        runMetadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
      }
      const compressed = await fs.readFile(statePath);
      const decompressed = await gunzip(compressed);
      const state = JSON.parse(decompressed.toString());
      const size = await this.getDirectorySize(runPath);
      return {
        displayName: runMetadata.domain || path.basename(runPath),
        domain: runMetadata.context || '',
        created: runMetadata.created || state.timestamp,
        nodes: state.memory?.nodes?.length || 0,
        edges: state.memory?.edges?.length || 0,
        cycles: state.cycleCount || 0,
        mode: runMetadata.explorationMode || 'unknown',
        size,
        hasOutputs: fsSync.existsSync(path.join(runPath, 'outputs')),
        hasCoordinator: fsSync.existsSync(path.join(runPath, 'coordinator')),
        isActive: fsSync.existsSync(path.join(runPath, 'runtime'))
      };
    } catch (e) { return null; }
  }

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
    } catch (e) {}
    return totalSize;
  }
}

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
      --bg-primary: #0d1117; --bg-secondary: #161b22; --bg-tertiary: #21262d; --bg-hover: #30363d;
      --text-primary: #c9d1d9; --text-secondary: #8b949e; --text-muted: #6e7681;
      --accent: #58a6ff; --accent-hover: #79c0ff; --success: #3fb950; --warning: #d29922; --error: #f85149; --border: #30363d;
      --gradient-1: linear-gradient(135deg, #1f6feb 0%, #58a6ff 100%);
      --gradient-2: linear-gradient(135deg, #3fb950 0%, #56d364 100%);
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Inter', sans-serif; background: var(--bg-primary); color: var(--text-primary); }
    .header { background: var(--bg-secondary); border-bottom: 1px solid var(--border); padding: 20px 40px; position: sticky; top: 0; z-index: 100; }
    .header-content { max-width: 1600px; margin: 0 auto; display: flex; justify-content: space-between; align-items: center; }
    .logo { display: flex; align-items: center; gap: 12px; }
    .logo-icon { font-size: 32px; }
    .logo-text h1 { font-size: 24px; font-weight: 700; background: var(--gradient-1); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    
    /* Layout Overhaul */
    .app-container { display: flex; height: calc(100vh - 73px); overflow: hidden; }
    .main { flex: 1; padding: 40px; overflow-y: auto; }
    .sidebar-docs { width: 380px; background: var(--bg-secondary); border-left: 1px solid var(--border); padding: 40px; overflow-y: auto; display: flex; flex-direction: column; gap: 32px; }
    
    .section { margin-bottom: 48px; }
    .section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
    .section-title { font-size: 20px; font-weight: 700; display: flex; align-items: center; gap: 12px; }
    .section-count { background: var(--bg-tertiary); padding: 4px 12px; border-radius: 20px; font-size: 13px; color: var(--text-secondary); }
    .brain-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 24px; }
    .brain-card { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 12px; padding: 24px; cursor: pointer; transition: all 0.3s; position: relative; overflow: hidden; }
    .brain-card:hover { border-color: var(--accent); transform: translateY(-4px); box-shadow: 0 12px 32px rgba(0, 0, 0, 0.3); }
    .brain-type { position: absolute; top: 16px; right: 16px; padding: 4px 10px; border-radius: 4px; font-size: 11px; font-weight: 600; text-transform: uppercase; }
    .brain-type.brain { background: rgba(88, 166, 255, 0.15); color: var(--accent); }
    .brain-type.run { background: rgba(63, 185, 80, 0.15); color: var(--success); }
    .brain-name { font-size: 20px; font-weight: 700; margin-bottom: 8px; }
    .brain-domain { font-size: 13px; color: var(--text-secondary); margin-bottom: 16px; line-height: 1.5; height: 40px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    .brain-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin: 20px 0; }
    .stat { text-align: center; padding: 12px; background: var(--bg-tertiary); border-radius: 8px; }
    .stat-value { font-size: 18px; font-weight: 700; font-family: 'JetBrains Mono', monospace; color: var(--accent); display: block; }
    .stat-label { font-size: 10px; color: var(--text-muted); text-transform: uppercase; margin-top: 4px; }
    .brain-meta { display: flex; gap: 16px; font-size: 12px; color: var(--text-muted); margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border); }
    .brain-actions { display: flex; gap: 8px; margin-top: 16px; }
    .btn { flex: 1; padding: 10px; border-radius: 8px; border: none; font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.2s; font-family: inherit; }
    .btn-view { background: var(--accent); color: white; }
    .btn-view:hover { background: var(--accent-hover); transform: translateY(-1px); }
    .btn-export { background: var(--bg-tertiary); color: var(--text-primary); border: 1px solid var(--border); }
    .btn-export:hover { background: var(--bg-hover); }
    .loading { display: inline-block; width: 16px; height: 16px; border: 2px solid var(--border); border-radius: 50%; border-top-color: var(--accent); animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .empty-state { text-align: center; padding: 80px; color: var(--text-muted); width: 100%; grid-column: 1 / -1; }
    .lineage-badge { font-size: 10px; font-weight: 600; padding: 2px 8px; border-radius: 10px; display: inline-flex; align-items: center; gap: 4px; margin-top: 8px; }
    .lineage-badge.linked { background: rgba(88, 166, 255, 0.1); color: var(--accent); border: 1px solid rgba(88, 166, 255, 0.2); }
    .lineage-badge.published { background: rgba(63, 185, 80, 0.1); color: var(--success); border: 1px solid rgba(63, 185, 80, 0.2); }
    
    .docs-section h3 { font-size: 16px; font-weight: 700; margin-bottom: 12px; color: var(--accent); display: flex; align-items: center; gap: 8px; }
    .docs-section p { font-size: 13px; line-height: 1.6; color: var(--text-secondary); margin-bottom: 12px; }
    .docs-tag { font-family: 'JetBrains Mono', monospace; font-size: 11px; background: var(--bg-tertiary); padding: 2px 6px; border-radius: 4px; color: var(--text-primary); }
  </style>
</head>
<body>
  <header class="header">
    <div class="header-content">
      <div class="logo"><div class="logo-icon">🧠</div><div class="logo-text"><h1>COSMO Brain Browser</h1></div></div>
      <div style="display:flex; gap:12px;">
        <button class="btn btn-export" style="flex:none;" onclick="location.reload()">🔄 Refresh</button>
        <button class="btn btn-view" style="flex:none;" onclick="window.open('https://cosmo.evobrew.com', '_blank')">🌐 Vision</button>
      </div>
    </div>
  </header>

  <div class="app-container">
    <main class="main">
      <section class="section">
        <div class="section-header">
          <div class="section-title">📚 Brain Library <span class="section-count" id="brainCount">0</span></div>
          <div style="font-size: 12px; color: var(--text-muted);">Published knowledge artifacts. Portable, versioned, and ready to be shared or built upon.</div>
        </div>
        <div id="brainPackagesGrid" class="brain-grid"><div class="loading"></div></div>
      </section>
      <section class="section">
        <div class="section-header">
          <div class="section-title">🛠️ Research Workspace <span class="section-count" id="runCount">0</span></div>
          <div style="font-size: 12px; color: var(--text-muted);">Active staging area. Work-in-progress research that is ready to be published as a stable version.</div>
        </div>
        <div id="runsGrid" class="brain-grid"><div class="loading"></div></div>
      </section>
    </main>

    <aside class="sidebar-docs">
      <div style="margin-bottom: 8px;">
        <h2 style="font-size: 24px; font-weight: 800; margin-bottom: 8px;">Studio Guide</h2>
        <p style="font-size: 14px; color: var(--text-muted);">Navigation & Methodology</p>
      </div>

      <div class="docs-section">
        <h3>📚 Brain Library</h3>
        <p>These are <strong>immutable releases</strong> of research. When a research run hits a milestone, it is "Published" into this library as a portable <span class="docs-tag">.brain</span> artifact.</p>
        <p>Ideal for: Long-term archival, peer review, and serving as a base for future synthetic research.</p>
      </div>

      <div class="docs-section">
        <h3>🛠️ Research Workspace</h3>
        <p>The <strong>Staging Area</strong> for active runs. This contains high-entropy data: the agent's raw thought stream, intermediate code artifacts, and execution logs.</p>
        <p>Use the <span class="docs-tag">Publish</span> button to crystallize a workspace into a stable Library entry.</p>
      </div>

      <div class="docs-section">
        <h3>⚡ Dual-Mode Operation</h3>
        <p>Launching a brain opens the <strong>Brain Studio</strong>, which toggles between two primary cognitive states:</p>
        <ul style="font-size: 13px; color: var(--text-secondary); margin-left: 20px; line-height: 1.8; margin-bottom: 12px;">
          <li><strong>Scholar (Research)</strong>: Deep memory interrogation and synthesis of existing knowledge.</li>
          <li><strong>Architect (Agent IDE)</strong>: Intelligent action, document creation, and terminal-driven execution.</li>
        </ul>
      </div>

      <div class="docs-section" style="padding: 24px; background: rgba(88, 166, 255, 0.05); border-radius: 12px; border: 1px solid rgba(88, 166, 255, 0.1); margin-top: auto;">
        <h3 style="font-size: 14px;">🚀 Future: Create Your Own</h3>
        <p style="font-size: 12px; line-height: 1.5; margin-bottom: 12px; color: var(--text-primary);">The ability to trigger custom automated research runs and build your own specialized brains is an upcoming feature of the COSMO ecosystem.</p>
        <p style="font-size: 11px; margin-bottom: 0;"><a href="https://cosmo.evobrew.com" target="_blank" style="color: var(--accent); text-decoration: none; font-weight: 600;">Request Early Access →</a></p>
      </div>
    </aside>
  </div>
  <script>
    async function init() {
      try {
        const response = await fetch('/api/scan');
        const data = await response.json();
        
        if (data.error) {
          showToast('❌ Scan Error: ' + data.error);
          return;
        }

        document.getElementById('brainCount').textContent = (data.brainPackages || []).length;
        document.getElementById('runCount').textContent = (data.runs || []).length;

        renderGrid('brainPackagesGrid', data.brainPackages || [], true);
        renderGrid('runsGrid', data.runs || [], false);
      } catch (e) {
        showToast('❌ Failed to connect to server');
        console.error(e);
      }
    }

    function renderGrid(id, brains, isPackage) {
      const grid = document.getElementById(id);
      if (brains.length === 0) {
        grid.innerHTML = '<div class="empty-state">No ' + (isPackage ? 'published brains' : 'research workspaces') + ' found.</div>';
        return;
      }
      grid.innerHTML = brains.map(b => \`
        <div class="brain-card">
          <div class="brain-type \${b.type}">\${b.type === 'brain' ? '📚 Published' : '🛠️ Workspace'}</div>
          <div class="brain-name">\${escapeHtml(b.displayName)}</div>
          <div style="font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--text-muted); margin-bottom: 12px; opacity: 0.7;">Run: \${escapeHtml(b.name)}</div>
          
          \${b.type === 'brain' && b.sourceRun ? \`
            <div class="lineage-badge linked">🔗 Linked to Research Workspace</div>
          \` : ''}
          \${b.type === 'run' && b.exportedTo ? \`
            <div class="lineage-badge published">✅ Published to Library</div>
          \` : ''}

          <div class="brain-domain">\${escapeHtml(b.domain) || 'No description available'}</div>
          <div class="brain-stats">
            <div class="stat"><span class="stat-value">\${(b.nodes || 0).toLocaleString()}</span><span class="stat-label">Nodes</span></div>
            <div class="stat"><span class="stat-value">\${(b.edges || 0).toLocaleString()}</span><span class="stat-label">Edges</span></div>
            <div class="stat"><span class="stat-value">\${b.cycles || 0}</span><span class="stat-label">Cycles</span></div>
          </div>
          <div class="brain-meta">
            <span>📅 \${new Date(b.created).toLocaleDateString()}</span>
            <span>💾 \${(b.size / (1024 * 1024)).toFixed(1)} MB</span>
          </div>
          <div class="brain-actions">
            <button class="btn btn-view" onclick="launch('\${b.relativePath.replace(/'/g, "\\\\'")}')">👁️ Explore</button>
            \${b.type === 'run' ? \`<button class="btn btn-export" onclick="exportRun('\${b.name}')" title="Publish this workspace as a stable, versioned .brain artifact.">🚀 Publish Version</button>\` : ''}
          </div>
        </div>
      \`).join('');
    }

    async function launch(path) {
      showToast('🚀 Launching Brain Studio...');
      const res = await fetch('/api/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brainPath: path })
      }).then(r => r.json());
      if (res.success) {
        setTimeout(() => window.open('http://localhost:' + res.port, '_blank'), 1500);
      } else {
        alert('❌ Launch failed: ' + res.error);
      }
    }

    async function exportRun(name) {
      if (!confirm('Publish a stable version of "' + name + '"? This will create a portable .brain artifact ready for sharing.')) return;
      showToast('🚀 Publishing new version...');
      const res = await fetch('/api/export-run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runName: name })
      }).then(r => r.json());
      if (res.success) {
        alert('✅ Version published! Created in Brain Library.');
        location.reload();
      } else {
        alert('❌ Publishing failed: ' + res.error);
      }
    }

    function showToast(msg) {
      const t = document.createElement('div');
      t.style.cssText = 'position:fixed; bottom:20px; right:20px; background:#21262d; color:white; padding:12px 24px; border-radius:8px; border:1px solid #30363d; z-index:1000; box-shadow: 0 4px 12px rgba(0,0,0,0.5);';
      t.textContent = msg;
      document.body.appendChild(t);
      setTimeout(() => t.remove(), 3000);
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

async function startServer() {
  const scanner = new BrainScanner(PLATFORM_ROOT);
  
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

      if (pathname === '/api/export-run' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { runName } = JSON.parse(body);

        try {
          const cliPath = path.join(SERVER_DIR, 'brain-cli.js');
          const outputPath = path.join(PLATFORM_ROOT, 'brains', `${runName}.brain`);
          
          // Check local runs first, then external runs
          let sourceRunPath = path.join(PLATFORM_ROOT, 'runs', runName);
          if (!fsSync.existsSync(sourceRunPath) && scanner.externalRunsDir) {
            sourceRunPath = path.join(scanner.externalRunsDir, runName);
          }
          
          if (!fsSync.existsSync(sourceRunPath)) {
            throw new Error('Run not found: ' + runName);
          }

          if (!fsSync.existsSync(path.join(PLATFORM_ROOT, 'brains'))) {
            await fs.mkdir(path.join(PLATFORM_ROOT, 'brains'));
          }

          const args = ['export', sourceRunPath, '--output', outputPath, '--with-outputs'];
          const proc = spawn('node', [cliPath, ...args], {
            cwd: PLATFORM_ROOT,
            stdio: 'pipe'
          });

          await new Promise((resolve, reject) => {
            proc.on('close', code => code === 0 ? resolve() : reject(new Error(`Exit code ${code}`)));
          });

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: true, output: `${runName}.brain` }));
        } catch (error) {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
      }

      if (pathname === '/api/launch' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { brainPath } = JSON.parse(body);

        // Reload .env to pick up any new API keys without restarting the browser
        try {
          const envPath = path.join(PLATFORM_ROOT, '.env');
          if (fsSync.existsSync(envPath)) {
            const envConfig = require('dotenv').parse(fsSync.readFileSync(envPath));
            for (const k in envConfig) {
              process.env[k] = envConfig[k];
            }
            console.log('[BROWSER] Refreshed .env configuration');
          }
        } catch (e) {
          console.error('[BROWSER] Failed to refresh .env:', e.message);
        }

        let fullPath = path.resolve(PLATFORM_ROOT, brainPath);
        if (!fsSync.existsSync(fullPath) && scanner.externalRunsDir) {
          // Fallback for external runs
          fullPath = path.resolve(scanner.externalRunsDir, path.basename(brainPath));
        }
        
        if (!fsSync.existsSync(fullPath)) {
          throw new Error('Brain path not found: ' + brainPath);
        }

        // Kill any existing studio process on the target port
        try {
          console.log(`[BROWSER] Ensuring port ${STUDIO_PORT} is free...`);
          if (process.platform === 'win32') {
            execSync(`for /f "tokens=5" %a in ('netstat -aon ^| findstr :${STUDIO_PORT}') do taskkill /f /pid %a`, { stdio: 'ignore' });
          } else {
            // More robust cleanup for macOS/Linux
            execSync(`lsof -ti:${STUDIO_PORT} | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore' });
          }
        } catch (e) {
          // Port was likely not in use, which is fine
        }

        console.log(`[BROWSER] Launching Studio for: ${fullPath}`);

        const studioScript = path.join(SERVER_DIR, 'server.js');
        const proc = spawn('node', [studioScript, fullPath], {
          cwd: PLATFORM_ROOT,
          detached: true,
          stdio: 'inherit',
          env: { ...process.env, PORT: STUDIO_PORT }
        });

        proc.unref();
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true, port: STUDIO_PORT }));
        return;
      }

      res.statusCode = 404;
      res.end('Not found');
    } catch (error) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: error.message }));
    }
  });

  server.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║              🧠 COSMO BRAIN PLATFORM                         ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  🌐 Browser: http://localhost:${PORT}                           ║
║  👁️  Studio:  http://localhost:${STUDIO_PORT}                           ║
║                                                              ║
║  Scanning:                                                   ║
║   📁 ./brains (Local packages)                               ║
║   📁 ${scanner.externalRunsDir ? scanner.externalRunsDir : './runs (Local runs only)'} ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
`);
  });
}

if (require.main === module) {
  startServer().catch(console.error);
}

module.exports = { startServer, BrainScanner };
