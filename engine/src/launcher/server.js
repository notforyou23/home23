#!/usr/bin/env node
/**
 * COSMO Launcher Dashboard Server
 * Web-based launcher UI for COSMO
 * Runs on port 3340 (before main COSMO dashboard)
 */

const express = require('express');
const path = require('path');
const { RunManager } = require('./run-manager');
const { ConfigGenerator } = require('./config-generator');
const { ProcessManager } = require('./process-manager');

const app = express();

// Enable CORS for local development (cosmo-lab.html served from different port)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

const PORT = process.env.LAUNCHER_PORT || 3340;
const PORT_OFFSET = parseInt(process.env.COSMO_PORT_OFFSET || 0);

// Calculate service ports with offset
const MCP_HTTP_PORT = 3347 + PORT_OFFSET;
const MCP_DASHBOARD_PORT = 3346 + PORT_OFFSET;
const MAIN_DASHBOARD_PORT = 3344 + PORT_OFFSET;

// Debug logging - CRITICAL for troubleshooting
console.log('');
console.log('╔════════════════════════════════════════════════╗');
console.log('║  COSMO LAUNCHER - PORT CONFIGURATION           ║');
console.log('╚════════════════════════════════════════════════╝');
console.log('  COSMO_PORT_OFFSET env:', process.env.COSMO_PORT_OFFSET);
console.log('  Parsed PORT_OFFSET:   ', PORT_OFFSET);
console.log('  Launcher Port:        ', PORT);
console.log('  Dashboard Port:       ', MAIN_DASHBOARD_PORT);
console.log('  MCP HTTP Port:        ', MCP_HTTP_PORT);
console.log('  MCP Dashboard Port:   ', MCP_DASHBOARD_PORT);
console.log('');

// CRITICAL: Set these as environment variables so child processes inherit them
process.env.MCP_HTTP_PORT = MCP_HTTP_PORT.toString();
process.env.MCP_PORT = MCP_HTTP_PORT.toString();  // Alias for COSMO core
process.env.DASHBOARD_PORT = MAIN_DASHBOARD_PORT.toString();
process.env.COSMO_DASHBOARD_PORT = MAIN_DASHBOARD_PORT.toString();  // Alias for dashboard server

console.log('Environment variables set:');
console.log('  MCP_HTTP_PORT:        ', process.env.MCP_HTTP_PORT);
console.log('  MCP_PORT:             ', process.env.MCP_PORT);
console.log('  DASHBOARD_PORT:       ', process.env.DASHBOARD_PORT);
console.log('  COSMO_DASHBOARD_PORT: ', process.env.COSMO_DASHBOARD_PORT);
console.log('');


const COSMO_ROOT = path.resolve(__dirname, '..', '..');
const RUNS_DIR = path.join(COSMO_ROOT, 'runs');
const RUNTIME_PATH = path.join(COSMO_ROOT, 'runtime');

// Initialize managers
const runManager = new RunManager(RUNS_DIR, console);
const configGenerator = new ConfigGenerator(COSMO_ROOT, console);
const processManager = new ProcessManager(COSMO_ROOT, console);

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));

// =============================================================================
// API ROUTES
// =============================================================================

/**
 * GET /api/runs - List all runs
 */
app.get('/api/runs', async (req, res) => {
  try {
    const runs = await runManager.listRuns();
    res.json({ success: true, runs });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/runs/:name - Get run info
 */
app.get('/api/runs/:name', async (req, res) => {
  try {
    const runInfo = await runManager.getRunInfo(req.params.name);
    if (runInfo) {
      res.json({ success: true, run: runInfo });
    } else {
      res.status(404).json({ success: false, error: 'Run not found' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/runs/create - Create new run
 */
app.post('/api/runs/create', async (req, res) => {
  try {
    const { runName } = req.body;
    if (!runName) {
      return res.status(400).json({ success: false, error: 'runName required' });
    }

    const result = await runManager.createRun(runName);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/runs/fork - Fork existing run
 */
app.post('/api/runs/fork', async (req, res) => {
  try {
    const { sourceRunName, newRunName } = req.body;
    if (!sourceRunName || !newRunName) {
      return res.status(400).json({ success: false, error: 'sourceRunName and newRunName required' });
    }

    const result = await runManager.forkRun(sourceRunName, newRunName);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/runs/dream-fork - Create dream fork (continuous sleep/dreaming mode)
 */
app.post('/api/runs/dream-fork', async (req, res) => {
  try {
    const { sourceRunName, newRunName, dreamCycles, dreamsPerCycle } = req.body;
    if (!sourceRunName || !newRunName) {
      return res.status(400).json({ success: false, error: 'sourceRunName and newRunName required' });
    }

    const result = await runManager.createDreamFork(sourceRunName, newRunName, {
      dreamCycles: dreamCycles || 100,
      dreamsPerCycle: dreamsPerCycle || 10
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/runs/:name - Delete run
 */
app.delete('/api/runs/:name', async (req, res) => {
  try {
    const result = await runManager.deleteRun(req.params.name);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/runs/:name/metadata - Get run metadata
 */
app.get('/api/runs/:name/metadata', async (req, res) => {
  try {
    const metadata = await runManager.getMetadata(req.params.name);
    if (metadata) {
      res.json({ success: true, metadata });
    } else {
      res.status(404).json({ success: false, error: 'Metadata not found' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/runs/:name/dream-metadata - Get dream fork metadata
 */
app.get('/api/runs/:name/dream-metadata', async (req, res) => {
  try {
    const metadata = await runManager.getDreamMetadata(req.params.name);
    if (metadata) {
      res.json({ success: true, metadata });
    } else {
      res.status(404).json({ success: false, error: 'Dream metadata not found' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/config/generate - Generate config from settings
 */
app.post('/api/config/generate', async (req, res) => {
  try {
    const { settings } = req.body;
    if (!settings) {
      return res.status(400).json({ success: false, error: 'settings required' });
    }

    const configYaml = await configGenerator.generateConfig(settings);
    res.json({ success: true, config: configYaml });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/config/save - Save config and metadata for a run
 */
app.post('/api/config/save', async (req, res) => {
  try {
    const { runName, settings, cleanStart } = req.body;
    if (!runName || !settings) {
      return res.status(400).json({ success: false, error: 'runName and settings required' });
    }

    const runPath = path.join(RUNS_DIR, runName);

    // Write config.yaml
    const configResult = await configGenerator.writeConfig(settings);
    if (!configResult.success) {
      return res.status(500).json(configResult);
    }

    // Write metadata
    const metadataResult = await configGenerator.writeMetadata(runPath, settings, cleanStart);
    if (!metadataResult.success) {
      return res.status(500).json(metadataResult);
    }

    // Link runtime
    const linkResult = await runManager.linkRuntime(runName, RUNTIME_PATH);
    if (!linkResult.success) {
      return res.status(500).json(linkResult);
    }

    res.json({ 
      success: true, 
      config: configResult.path,
      metadata: metadataResult.path
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/config/defaults - Get default settings
 */
app.get('/api/config/defaults', (req, res) => {
  const defaults = configGenerator.getDefaults();
  res.json({ success: true, defaults });
});

/**
 * POST /api/process/start - Start COSMO (single or cluster)
 */
app.post('/api/process/start', async (req, res) => {
  try {
    const { cluster_enabled, cluster_size, cluster_backend } = req.body;

    console.log('');
    console.log('[START] Starting COSMO with ports:');
    console.log('  Main Dashboard:', MAIN_DASHBOARD_PORT);
    console.log('  MCP HTTP:      ', MCP_HTTP_PORT);
    console.log('  MCP Dashboard: ', MCP_DASHBOARD_PORT);
    console.log('');

    // Start MCP services (always needed)
    await processManager.startMCPServer(MCP_HTTP_PORT);
    await processManager.startMCPDashboard(MCP_DASHBOARD_PORT);

    if (cluster_enabled && cluster_size > 1) {
      // Cluster mode
      const clusterResult = await processManager.startCluster(cluster_size, cluster_backend);
      res.json(clusterResult);
    } else {
      // Single instance
      await processManager.startMainDashboard(MAIN_DASHBOARD_PORT);
      const cosmoResult = await processManager.startCOSMO();
      
      const response = { 
        success: true, 
        mode: 'single',
        cosmoPid: cosmoResult.pid,
        dashboardUrl: `http://localhost:${MAIN_DASHBOARD_PORT}`
      };
      
      console.log('[START] Returning response:', response);
      console.log('');
      
      res.json(response);
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/process/stop - Stop all COSMO processes
 */
app.post('/api/process/stop', async (req, res) => {
  try {
    const result = await processManager.stopAll();
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/process/status - Get process status
 */
app.get('/api/process/status', (req, res) => {
  const status = processManager.getStatus();
  res.json({ success: true, status });
});

/**
 * POST /api/tools/merge - Launch merge tool
 */
app.post('/api/tools/merge', async (req, res) => {
  try {
    const { spawn } = require('child_process');
    const os = require('os');
    
    const scriptPath = path.join(COSMO_ROOT, 'scripts', 'merge_runs.js');
    const platform = os.platform();
    
    let proc;
    
    // macOS: Use 'open' to launch Terminal.app with the script
    if (platform === 'darwin') {
      // Create a temporary shell script that changes directory and runs the merge tool
      const tempScript = path.join(COSMO_ROOT, '.merge_launcher.sh');
      const shellScript = `#!/bin/bash
cd "${COSMO_ROOT}"
node scripts/merge_runs.js
read -p "Press Enter to close..."
`;
      
      // Write the temporary launcher script
      require('fs').writeFileSync(tempScript, shellScript, { mode: 0o755 });
      
      // Open in new Terminal window
      proc = spawn('open', ['-a', 'Terminal.app', tempScript], {
        detached: true,
        stdio: 'ignore'
      });
      
      proc.unref();
      
      // Clean up temp script after a delay
      setTimeout(() => {
        try {
          require('fs').unlinkSync(tempScript);
        } catch (e) {
          // Ignore cleanup errors
        }
      }, 5000);
    } 
    // Linux: Use x-terminal-emulator or fallback options
    else if (platform === 'linux') {
      proc = spawn('x-terminal-emulator', ['-e', `bash -c "cd ${COSMO_ROOT} && node scripts/merge_runs.js; read -p 'Press Enter to close...'"}`], {
        detached: true,
        stdio: 'ignore'
      });
      
      proc.unref();
    }
    // Windows: Use cmd.exe
    else if (platform === 'win32') {
      proc = spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', `cd /d ${COSMO_ROOT} && node scripts\\merge_runs.js`], {
        detached: true,
        stdio: 'ignore'
      });
      
      proc.unref();
    }
    // Unsupported platform: Return error
    else {
      return res.status(500).json({ 
        success: false, 
        error: `Unsupported platform: ${platform}. Please run 'node scripts/merge_runs.js' manually.` 
      });
    }

    res.json({ success: true, message: 'Merge tool opened in new terminal window' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/tools/dashboard-only - Start dashboard without COSMO running
 */
app.post('/api/tools/dashboard-only', async (req, res) => {
  try {
    // Start just the dashboard services
    await processManager.startMCPServer(MCP_HTTP_PORT);
    await processManager.startMCPDashboard(MCP_DASHBOARD_PORT);
    await processManager.startMainDashboard(MAIN_DASHBOARD_PORT);

    res.json({ 
      success: true, 
      dashboardUrl: `http://localhost:${MAIN_DASHBOARD_PORT}`,
      message: 'Dashboard started without running COSMO cycles' 
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET / - Serve launcher UI
 */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// =============================================================================
// START SERVER
// =============================================================================

app.listen(PORT, () => {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║           🚀 COSMO LAUNCHER DASHBOARD                        ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  🌐 Open: http://localhost:${PORT}`);
  console.log('');
  console.log('  Configure and launch COSMO from your browser');
  console.log('  No terminal required!');
  console.log('');
  console.log('  Press Ctrl+C to stop launcher');
  console.log('');
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n\nShutting down launcher...');
  await processManager.stopAll();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n\nShutting down launcher...');
  await processManager.stopAll();
  process.exit(0);
});

