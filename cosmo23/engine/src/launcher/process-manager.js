const { spawn, exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

/**
 * ProcessManager - Manages COSMO and service processes
 * - Start/stop COSMO instances
 * - Start/stop support services (MCP, dashboards)
 * - Monitor process health
 * - Handle cluster launches
 */
class ProcessManager {
  constructor(cosmoRoot, logger = console) {
    this.cosmoRoot = cosmoRoot;
    this.logger = logger;
    this.processes = new Map(); // name -> process
    this.pidFiles = {
      cluster: '.cosmo_cluster_pids',
      clusterDashboards: '.cosmo_cluster_dashboard_pids',
      observatory: '.cluster_dashboard_pid'
    };
    
    // Track ports that were actually used (for cleanup)
    this.usedPorts = new Set();
  }

  /**
   * Check if a port is in use
   */
  async isPortInUse(port) {
    try {
      const { stdout } = await execAsync(`lsof -ti TCP:${port}`);
      return stdout.trim().length > 0;
    } catch (error) {
      return false;
    }
  }

  /**
   * Kill process on port
   */
  async killPort(port, label = '') {
    try {
      const { stdout } = await execAsync(`lsof -ti TCP:${port}`);
      const pids = stdout.trim().split('\n').filter(p => p);
      
      if (pids.length > 0) {
        this.logger.info(`Clearing port ${port} ${label ? `(${label})` : ''}...`);
        for (const pid of pids) {
          try {
            process.kill(parseInt(pid), 'SIGTERM');
          } catch (e) {
            // Process may already be gone
          }
        }
        // Wait a moment
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (error) {
      // No process on port, that's fine
    }
  }

  /**
   * Start MCP HTTP server
   */
  async startMCPServer(port = 3347) {
    await this.killPort(port, 'MCP HTTP');
    this.usedPorts.add(port); // Track for cleanup

    const proc = spawn(process.execPath, ['mcp/http-server.js', port.toString()], {
      cwd: this.cosmoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      env: {
        ...process.env  // This includes COSMO_RUNTIME_PATH from unified server
      }
    });

    this.processes.set('mcp-http', proc);

    proc.stdout.on('data', data => {
      this.logger.debug(`[MCP HTTP] ${data.toString().trim()}`);
    });

    proc.stderr.on('data', data => {
      this.logger.error(`[MCP HTTP] ${data.toString().trim()}`);
    });

    proc.on('exit', (code) => {
      this.logger.info(`MCP HTTP server exited (code: ${code})`);
      this.processes.delete('mcp-http');
    });

    // Wait for it to start
    await new Promise(resolve => setTimeout(resolve, 1500));

    return { success: true, port, pid: proc.pid };
  }

  /**
   * Start MCP dashboard server
   */
  async startMCPDashboard(port = 3346) {
    await this.killPort(port, 'MCP Dashboard');
    this.usedPorts.add(port); // Track for cleanup

    const proc = spawn(process.execPath, ['mcp/dashboard-server.js'], {
      cwd: this.cosmoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false
    });

    this.processes.set('mcp-dashboard', proc);

    proc.on('exit', (code) => {
      this.logger.info(`MCP Dashboard exited (code: ${code})`);
      this.processes.delete('mcp-dashboard');
    });

    await new Promise(resolve => setTimeout(resolve, 1500));

    return { success: true, port, pid: proc.pid };
  }

  /**
   * Start main COSMO dashboard
   */
  async startMainDashboard(port = 3344) {
    await this.killPort(port, 'Main Dashboard');
    this.usedPorts.add(port); // Track for cleanup

    const proc = spawn(process.execPath, ['src/dashboard/server.js'], {
      cwd: this.cosmoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      env: {
        ...process.env,  // This includes MCP_HTTP_PORT from launcher
        COSMO_DASHBOARD_PORT: port.toString(),
        COSMO_NO_AUTO_OPEN: 'true'  // Prevent auto-opening browser tab (for Unified mode)
        // DO NOT calculate MCP port here - use what launcher already set
      }
    });

    this.processes.set('main-dashboard', proc);

    proc.on('exit', (code) => {
      this.logger.info(`Main Dashboard exited (code: ${code})`);
      this.processes.delete('main-dashboard');
    });

    await new Promise(resolve => setTimeout(resolve, 1500));

    return { success: true, port, pid: proc.pid };
  }

  /**
   * Start COSMO core (single instance)
   */
  async startCOSMO() {
    // CRITICAL: Pass through all port environment variables from launcher
    // The launcher has already calculated correct ports based on COSMO_PORT_OFFSET
    const proc = spawn(process.execPath, ['src/index.js'], {
      cwd: this.cosmoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      env: {
        ...process.env,  // This includes DASHBOARD_PORT, MCP_PORT, MCP_HTTP_PORT from launcher
        COSMO_TUI: 'false',
        COSMO_TUI_SPLIT: 'false'
        // DO NOT override port env vars - use what launcher calculated
      }
    });

    this.processes.set('cosmo-main', proc);

    // Forward output
    proc.stdout.on('data', data => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (line.trim()) {
          this.logger.info(`[COSMO] ${line}`);
        }
      }
    });

    proc.stderr.on('data', data => {
      this.logger.error(`[COSMO] ${data.toString()}`);
    });

    proc.on('exit', (code, signal) => {
      this.logger.info(`COSMO exited (code: ${code}, signal: ${signal})`);
      this.processes.delete('cosmo-main');
    });

    return { success: true, pid: proc.pid };
  }

  /**
   * Start cluster mode (multiple instances)
   */
  async startCluster(clusterSize, clusterBackend) {
    this.logger.info(`Starting cluster: ${clusterSize} instances (${clusterBackend})`);

    // Start Redis if needed
    if (clusterBackend === 'redis') {
      const redisRunning = await this.isRedisRunning();
      if (!redisRunning) {
        this.logger.info('Starting Redis...');
        try {
          await execAsync('redis-server --daemonize yes --port 6379');
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          const stillNotRunning = !(await this.isRedisRunning());
          if (stillNotRunning) {
            throw new Error('Redis failed to start');
          }
          this.logger.info('✓ Redis started');
        } catch (error) {
          throw new Error(`Redis start failed: ${error.message}. Install: brew install redis`);
        }
      } else {
        this.logger.info('✓ Redis already running');
      }
    }

    const BASE_DASHBOARD_PORT = 3343;
    const BASE_MCP_PORT = 3344;

    // Clear ports
    for (let i = 0; i < clusterSize; i++) {
      const dashPort = BASE_DASHBOARD_PORT + i;
      await this.killPort(dashPort, `cluster dashboard ${i+1}`);
    }
    await this.killPort(3360, 'Hive Observatory');

    // Start instances
    const instances = [];
    for (let i = 0; i < clusterSize; i++) {
      const instanceId = `cosmo-${i + 1}`;
      const dashboardPort = BASE_DASHBOARD_PORT + i;
      const mcpPort = BASE_MCP_PORT + i;

      this.logger.info(`Starting ${instanceId}...`);

      // Start dashboard for this instance
      const dashProc = spawn('node', ['src/dashboard/server.js'], {
        cwd: this.cosmoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        env: {
          ...process.env,
          COSMO_DASHBOARD_PORT: dashboardPort.toString()
        }
      });

      // Forward output for visibility
      dashProc.stdout.on('data', data => {
        const lines = data.toString().split('\n');
        for (const line of lines) {
          if (line.trim()) {
            this.logger.info(`[Dashboard ${instanceId}] ${line}`);
          }
        }
      });

      dashProc.stderr.on('data', data => {
        this.logger.error(`[Dashboard ${instanceId}] ${data.toString()}`);
      });

      dashProc.on('exit', (code) => {
        this.logger.info(`Dashboard ${instanceId} exited (code: ${code})`);
        this.processes.delete(`cluster-dashboard-${i+1}`);
      });

      this.processes.set(`cluster-dashboard-${i+1}`, dashProc);

      await new Promise(resolve => setTimeout(resolve, 1000));

      // Start COSMO instance
      const cosmoProc = spawn('node', ['src/index.js'], {
        cwd: this.cosmoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        env: {
          ...process.env,
          INSTANCE_ID: instanceId,
          DASHBOARD_PORT: dashboardPort.toString(),
          MCP_PORT: mcpPort.toString()
        }
      });

      // Forward COSMO output
      cosmoProc.stdout.on('data', data => {
        const lines = data.toString().split('\n');
        for (const line of lines) {
          if (line.trim()) {
            this.logger.info(`[${instanceId}] ${line}`);
          }
        }
      });

      cosmoProc.stderr.on('data', data => {
        this.logger.error(`[${instanceId}] ${data.toString()}`);
      });

      cosmoProc.on('exit', (code, signal) => {
        this.logger.info(`${instanceId} exited (code: ${code}, signal: ${signal})`);
        this.processes.delete(`cluster-instance-${i+1}`);
      });

      this.processes.set(`cluster-instance-${i+1}`, cosmoProc);

      instances.push({
        instanceId,
        dashboardPort,
        mcpPort,
        dashboardPid: dashProc.pid,
        cosmoPid: cosmoProc.pid
      });

      // Stagger startup
      if (i < clusterSize - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    // Wait for cluster to initialize
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Start unified observatory
    const observatoryProc = spawn(process.execPath, ['src/dashboard/cluster-server.js'], {
      cwd: this.cosmoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      env: {
        ...process.env,
        CLUSTER_DASHBOARD_PORT: '3360',
        INSTANCE_COUNT: clusterSize.toString(),
        BASE_DASHBOARD_PORT: BASE_DASHBOARD_PORT.toString()
      }
    });

    // Forward observatory output
    observatoryProc.stdout.on('data', data => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (line.trim()) {
          this.logger.info(`[Hive Observatory] ${line}`);
        }
      }
    });

    observatoryProc.stderr.on('data', data => {
      this.logger.error(`[Hive Observatory] ${data.toString()}`);
    });

    observatoryProc.on('exit', (code) => {
      this.logger.info(`Hive Observatory exited (code: ${code})`);
      this.processes.delete('hive-observatory');
    });

    this.processes.set('hive-observatory', observatoryProc);

    await new Promise(resolve => setTimeout(resolve, 2000));

    this.logger.info('✓ Cluster launched');
    this.logger.info('');
    this.logger.info('🌐 Dashboards:');
    instances.forEach((inst, idx) => {
      this.logger.info(`   • ${inst.instanceId}: http://localhost:${inst.dashboardPort}`);
    });
    this.logger.info(`   • Hive Observatory: http://localhost:3360`);
    this.logger.info('');

    return { 
      success: true, 
      mode: 'cluster',
      instances,
      observatoryPort: 3360,
      observatoryPid: observatoryProc.pid,
      dashboardUrl: 'http://localhost:3360' // Hive observatory for cluster mode
    };
  }

  /**
   * Stop all managed processes gracefully
   */
  async stopAll() {
    this.logger.info('Initiating graceful shutdown...');

    // Identify COSMO instance processes (both single and cluster)
    const cosmoProcesses = [];
    
    // Single instance mode
    const singleInstance = this.processes.get('cosmo-main');
    if (singleInstance) {
      cosmoProcesses.push({ name: 'cosmo-main', proc: singleInstance });
    }
    
    // Cluster mode - collect all instances
    for (const [name, proc] of this.processes.entries()) {
      if (name.startsWith('cluster-instance-')) {
        cosmoProcesses.push({ name, proc });
      }
    }

    if (cosmoProcesses.length > 0) {
      this.logger.info(`Requesting ${cosmoProcesses.length} COSMO instance(s) to shut down gracefully...`);
      
      // Step 1: Send SIGINT to all COSMO instances
      for (const { name, proc } of cosmoProcesses) {
        try {
          proc.kill('SIGINT');
          this.logger.info(`Sent shutdown signal to ${name}`);
        } catch (error) {
          this.logger.error(`Failed to signal ${name}:`, error.message);
        }
      }
      
      // Step 2: Wait for all to exit gracefully (up to 3 minutes)
      const maxWait = 180000; // 3 minutes (allows 2 min for agents + 1 min for cleanup)
      const startWait = Date.now();
      const stillRunning = new Set(cosmoProcesses.map(p => p.name));
      
      while (stillRunning.size > 0 && (Date.now() - startWait < maxWait)) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Check which processes are still running
        for (const { name, proc } of cosmoProcesses) {
          if (stillRunning.has(name)) {
            try {
              process.kill(proc.pid, 0); // Signal 0 checks if process exists
            } catch (e) {
              stillRunning.delete(name);
              this.logger.info(`✅ ${name} shut down gracefully`);
              this.processes.delete(name);
            }
          }
        }
        
        // Log progress every 15 seconds
        const elapsed = Date.now() - startWait;
        if (elapsed % 15000 < 1000 && stillRunning.size > 0) {
          this.logger.info(`Waiting for ${stillRunning.size} instance(s) to finish... (${Math.round(elapsed/1000)}s elapsed)`);
        }
      }
      
      // Step 3: Force kill any stragglers
      if (stillRunning.size > 0) {
        this.logger.warn(`⚠️  ${stillRunning.size} instance(s) did not exit gracefully, forcing shutdown`);
        for (const { name, proc } of cosmoProcesses) {
          if (stillRunning.has(name)) {
            try {
              proc.kill('SIGKILL');
              this.logger.warn(`Force killed ${name}`);
            } catch (e) {
              // Already dead
            }
            this.processes.delete(name);
          }
        }
      }
    }

    // Step 4: Stop other processes (dashboards, MCP servers, hive)
    this.logger.info('Stopping support services...');
    for (const [name, proc] of this.processes.entries()) {
      if (name.startsWith('cosmo-main') || name.startsWith('cluster-instance-')) {
        continue; // Already handled
      }
      
      try {
        proc.kill('SIGTERM');
        this.logger.info(`Stopped: ${name}`);
      } catch (error) {
        this.logger.error(`Failed to stop ${name}:`, error);
      }
    }

    this.processes.clear();

    // Step 5: Clean up any orphaned processes on ports we actually used
    this.logger.info('Cleaning up used ports:', Array.from(this.usedPorts));
    for (const port of this.usedPorts) {
      await this.killPort(port, `Port ${port}`);
    }
    
    // Also clean up hive observatory (always on 3360)
    await this.killPort(3360, 'Hive Observatory');
    
    this.usedPorts.clear();

    return { success: true };
  }

  /**
   * Check if Redis is running
   */
  async isRedisRunning() {
    try {
      await execAsync('redis-cli ping');
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get status of all processes
   */
  getStatus() {
    const status = {
      running: [],
      count: this.processes.size
    };

    for (const [name, proc] of this.processes.entries()) {
      status.running.push({
        name,
        pid: proc.pid,
        killed: proc.killed
      });
    }

    return status;
  }
}

module.exports = { ProcessManager };

