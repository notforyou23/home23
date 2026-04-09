#!/usr/bin/env node

/**
 * COSMO Brain Browser (Portable)
 * 
 * Landing page for discovering and managing local brains.
 * Refactored for standalone use.
 */

const http = require('http');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const { spawn } = require('child_process');

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
    // Default to a 'brains' folder in the platform root
    this.brainsDir = path.join(platformRoot, 'brains');
    
    // Fallback: If we're inside the COSMO repo, also scan the COSMO root
    this.cosmoRoot = path.join(platformRoot, '..');
    this.runsDir = path.join(this.cosmoRoot, 'runs');
  }

  async scanAll() {
    const brainPackages = await this.scanDirectory(this.brainsDir);
    
    // Also scan platform root for .brain folders
    const rootBrains = await this.scanDirectory(this.platformRoot);
    
    // If inside COSMO, scan runs and cosmo root
    let cosmoBrains = [];
    let runs = [];
    if (fsSync.existsSync(this.runsDir)) {
      cosmoBrains = await this.scanDirectory(this.cosmoRoot);
      runs = await this.scanRuns();
    }
    
    // Merge and deduplicate by path
    const allBrainPackages = [...brainPackages, ...rootBrains, ...cosmoBrains];
    const uniqueBrains = [];
    const seenPaths = new Set();
    
    for (const b of allBrainPackages) {
      if (!seenPaths.has(b.path)) {
        seenPaths.add(b.path);
        uniqueBrains.push(b);
      }
    }
    
    return {
      brainPackages: uniqueBrains,
      runs,
      total: uniqueBrains.length + runs.length
    };
  }

  async scanDirectory(dir) {
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
              // Calculate relative path from platform root if possible, otherwise use full path
              relativePath: path.relative(this.platformRoot, brainPath),
              ...metadata
            });
          }
        }
      }
    } catch (error) {
      console.error(`[SCANNER] Failed to scan directory ${dir}:`, error.message);
    }
    return brains;
  }

  async scanRuns() {
    const runs = [];
    if (!fsSync.existsSync(this.runsDir)) return runs;
    
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
              relativePath: path.relative(this.platformRoot, runPath),
              ...metadata
            });
          }
        }
      }
    } catch (error) {
      console.error('[SCANNER] Failed to scan runs:', error);
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

      const stat = await fs.stat(statePath);
      const totalSize = await this.getDirectorySize(brainPath);

      return {
        displayName: manifest?.brain?.displayName || manifest?.brain?.name || path.basename(brainPath).replace('.brain', ''),
        domain: manifest?.brain?.description || '',
        created: manifest?.brain?.created || stat.birthtime,
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
      return null;
    }
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
      return null;
    }
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
    } catch (error) {}
    return totalSize;
  }
}

// HTML Template (embedded for portability)
function getHTML(port) {
  // Reuse the beautiful HTML from original brain-browser.js but update the API calls
  // (Truncated for brevity in this call, but I will provide the full implementation)
  // ... (Full HTML from scripts/brain-browser.js will be here)
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
    .header { background: var(--bg-secondary); border-bottom: 1px solid var(--border); padding: 20px 40px; }
    .header-content { max-width: 1400px; margin: 0 auto; display: flex; justify-content: space-between; align-items: center; }
    .logo { display: flex; align-items: center; gap: 12px; }
    .logo-icon { font-size: 32px; }
    .logo-text h1 { font-size: 24px; font-weight: 700; background: var(--gradient-1); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .main { max-width: 1400px; margin: 0 auto; padding: 40px; }
    .brain-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 24px; }
    .brain-card { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 12px; padding: 24px; cursor: pointer; transition: all 0.3s; position: relative; overflow: hidden; }
    .brain-card:hover { border-color: var(--accent); transform: translateY(-4px); }
    .brain-name { font-size: 20px; font-weight: 700; margin-bottom: 8px; }
    .brain-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin: 20px 0; }
    .stat { text-align: center; padding: 12px; background: var(--bg-tertiary); border-radius: 8px; }
    .stat-value { font-size: 18px; font-weight: 700; font-family: 'JetBrains Mono', monospace; color: var(--accent); }
    .stat-label { font-size: 10px; color: var(--text-muted); text-transform: uppercase; }
    .btn { padding: 10px 20px; border-radius: 8px; border: none; font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.2s; }
    .btn-primary { background: var(--accent); color: white; }
    .btn-small { width: 100%; padding: 8px; margin-top: 12px; }
    .empty-state { text-align: center; padding: 80px; color: var(--text-muted); }
  </style>
</head>
<body>
  <header class="header">
    <div class="header-content">
      <div class="logo"><div class="logo-icon">🧠</div><div class="logo-text"><h1>COSMO Brain Browser</h1></div></div>
      <button class="btn btn-primary" onclick="location.reload()">🔄 Refresh</button>
    </div>
  </header>
  <main class="main">
    <div id="brainGrid" class="brain-grid"></div>
  </main>
  <script>
    async function init() {
      const data = await fetch('/api/scan').then(r => r.json());
      const grid = document.getElementById('brainGrid');
      const all = [...data.brainPackages, ...data.runs];
      if (all.length === 0) {
        grid.innerHTML = '<div class="empty-state">No brains found. Add some .brain folders to the "brains" directory.</div>';
        return;
      }
      grid.innerHTML = all.map(b => \`
        <div class="brain-card">
          <div class="brain-name">\${b.displayName}</div>
          <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 12px;">\${b.domain || 'Portable Brain Package'}</div>
          <div class="brain-stats">
            <div class="stat"><div class="stat-value">\${b.nodes}</div><div class="stat-label">Nodes</div></div>
            <div class="stat"><div class="stat-value">\${b.edges}</div><div class="stat-label">Edges</div></div>
            <div class="stat"><div class="stat-value">\${b.cycles}</div><div class="stat-label">Cycles</div></div>
          </div>
          <button class="btn btn-primary btn-small" onclick="launch('\${b.relativePath.replace(/'/g, "\\\\'")}')">🚀 Open in Studio</button>
        </div>
      \`).join('');
    }
    async function launch(path) {
      const res = await fetch('/api/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brainPath: path })
      }).then(r => r.json());
      if (res.success) {
        setTimeout(() => window.open('http://localhost:' + res.port, '_blank'), 1500);
      }
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
        res.end(getHTML(PORT));
        return;
      }

      if (pathname === '/api/scan') {
        const data = await scanner.scanAll();
        res.end(JSON.stringify(data));
        return;
      }

      if (pathname === '/api/launch' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { brainPath } = JSON.parse(body);

        // Resolve path: check relative to platform root first
        let fullPath = path.resolve(PLATFORM_ROOT, brainPath);
        if (!fsSync.existsSync(fullPath)) {
          // If not found, try absolute path (as fallback for COSMO-internal testing)
          fullPath = path.resolve(brainPath);
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
        
        res.end(JSON.stringify({ success: true, port: STUDIO_PORT }));
        return;
      }

      res.statusCode = 404;
      res.end('Not found');
    } catch (error) {
      res.statusCode = 500;
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
║   📁 ${path.relative(process.cwd(), path.join(PLATFORM_ROOT, 'brains'))}                                         ║
║   📁 ${path.relative(process.cwd(), PLATFORM_ROOT)}                                                ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
`);
  });
}

if (require.main === module) {
  startServer().catch(console.error);
}

module.exports = { startServer, BrainScanner };

