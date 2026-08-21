const { EventEmitter } = require('events');
const { spawn, exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const execAsync = promisify(exec);

const STARTUP_READINESS_TIMEOUT_MS = 10000;
const RUNNER_STATE_FILENAME = 'runner.json';
const RUNNER_HISTORY_FILENAME = 'runner.jsonl';
const RUNNER_CLAIM_FILENAME = 'runner.claim';

/**
 * ProcessManager - Manages COSMO and service processes
 * - Start/stop COSMO instances
 * - Start/stop support services (MCP, dashboards)
 * - Monitor process health
 * - Handle cluster launches
 */
class ProcessManager extends EventEmitter {
  constructor(cosmoRoot, logger = console) {
    super();
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
    this.logBuffer = [];
    this.maxLogEntries = 1500;
    this.nextLogId = 1;
  }

  stripAnsi(value) {
    return String(value || '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
  }

  normalizeLogLevel(level, message) {
    if (level !== 'error') {
      return level;
    }

    const lowered = this.stripAnsi(message).toLowerCase();
    if (
      lowered.includes('error') ||
      lowered.includes('failed') ||
      lowered.includes('exception') ||
      lowered.includes('warn') ||
      lowered.includes('warning') ||
      lowered.includes('deprecation')
    ) {
      return 'error';
    }

    return 'info';
  }

  recordLog(source, level, message) {
    const line = this.stripAnsi(message).trim();
    if (!line) {
      return null;
    }

    const entry = {
      id: this.nextLogId++,
      source,
      level: this.normalizeLogLevel(level, line),
      message: line,
      timestamp: new Date().toISOString()
    };

    this.logBuffer.push(entry);
    if (this.logBuffer.length > this.maxLogEntries) {
      this.logBuffer.splice(0, this.logBuffer.length - this.maxLogEntries);
    }

    this.emit('log', entry);
    return entry;
  }

  clearLogs() {
    this.logBuffer = [];
    this.nextLogId = 1;
  }

  getLogs(options = {}) {
    const after = Number.parseInt(options.after || '0', 10) || 0;
    const requestedLimit = Number.parseInt(options.limit || '250', 10) || 250;
    const limit = Math.min(Math.max(requestedLimit, 1), 1000);
    const entries = after > 0
      ? this.logBuffer.filter(entry => entry.id > after)
      : this.logBuffer.slice(-limit);
    const logs = after > 0 ? entries.slice(0, limit) : entries;
    return {
      logs,
      cursor: logs.length > 0 ? logs[logs.length - 1].id : after,
      total: this.logBuffer.length
    };
  }

  attachProcessLogging(proc, source) {
    const forwardLine = (level, line) => {
      const entry = this.recordLog(source, level, line);
      if (!entry) {
        return;
      }

      const rendered = `[${source}] ${entry.message}`;
      if (level === 'error' && typeof this.logger.error === 'function') {
        this.logger.error(rendered);
      } else if (typeof this.logger.info === 'function') {
        this.logger.info(rendered);
      }
    };

    const attachStream = (stream, level) => {
      if (!stream) {
        return;
      }

      let buffer = '';
      stream.on('data', data => {
        buffer += data.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
          forwardLine(level, line);
        }
      });

      stream.on('end', () => {
        if (buffer.trim()) {
          forwardLine(level, buffer);
          buffer = '';
        }
      });
    };

    attachStream(proc.stdout, 'info');
    attachStream(proc.stderr, 'error');
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

  async waitForRequiredProcess(name, proc, options = {}) {
    const label = options.label || name;
    const timeoutMs = options.timeoutMs ?? STARTUP_READINESS_TIMEOUT_MS;
    const pollIntervalMs = options.pollIntervalMs ?? 50;
    const stabilityMs = options.stabilityMs ?? 0;
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;

    while (Date.now() <= deadline) {
      const exited = proc.exitCode != null
        || proc.signalCode != null
        || proc.killed === true
        || this.processes.get(name) !== proc;
      if (exited) {
        throw new Error(`${label} exited during startup`);
      }

      if (options.port !== undefined) {
        if (await this.isPortInUse(options.port)) return;
      } else if (Date.now() - startedAt >= stabilityMs) {
        return;
      }

      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(`${label} failed startup readiness within ${timeoutMs}ms`);
  }

  isPidAlive(pid) {
    const numericPid = Number(pid);
    if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
    try {
      process.kill(numericPid, 0);
      return true;
    } catch {
      return false;
    }
  }

  runnerStatePath(runPath) {
    return path.join(runPath, 'drill', RUNNER_STATE_FILENAME);
  }

  runnerClaimPath(runPath) {
    return path.join(runPath, 'drill', RUNNER_CLAIM_FILENAME);
  }

  async readRunnerState(runPath) {
    try {
      const parsed = JSON.parse(await fsp.readFile(this.runnerStatePath(runPath), 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async writeRunnerState(runPath, state) {
    const drillDir = path.join(runPath, 'drill');
    await fsp.mkdir(drillDir, { recursive: true });
    const target = this.runnerStatePath(runPath);
    const tmp = `${target}.tmp-${process.pid}`;
    await fsp.writeFile(tmp, JSON.stringify(state, null, 2));
    await fsp.rename(tmp, target);
    await fsp.appendFile(
      path.join(drillDir, RUNNER_HISTORY_FILENAME),
      `${JSON.stringify(state)}\n`
    );
  }

  async acquireRunnerClaim(runPath) {
    const drillDir = path.join(runPath, 'drill');
    await fsp.mkdir(drillDir, { recursive: true });
    const claimPath = this.runnerClaimPath(runPath);
    const claim = {
      active: true,
      launcherPid: process.pid,
      claimedAt: new Date().toISOString(),
      runPath
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await fsp.open(claimPath, 'wx');
        try {
          await handle.writeFile(JSON.stringify(claim, null, 2));
        } finally {
          await handle.close();
        }
        return claim;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let existing = null;
        try {
          existing = JSON.parse(await fsp.readFile(claimPath, 'utf8'));
        } catch { /* unreadable claims still fail closed when the archive races */ }
        const ownerPid = existing?.pid || existing?.launcherPid;
        if (this.isPidAlive(ownerPid)) {
          const active = new Error(`COSMO runner claim already held by pid ${ownerPid}`);
          active.code = 'COSMO_RUNNER_ACTIVE';
          throw active;
        }
        const stalePath = `${claimPath}.stale-${Date.now()}-${process.pid}`;
        try {
          await fsp.rename(claimPath, stalePath);
        } catch (renameError) {
          if (renameError.code !== 'ENOENT') throw renameError;
        }
      }
    }
    const error = new Error('Could not acquire COSMO runner claim');
    error.code = 'COSMO_RUNNER_ACTIVE';
    throw error;
  }

  async updateRunnerClaim(runPath, patch) {
    const target = this.runnerClaimPath(runPath);
    let current = {};
    try {
      current = JSON.parse(await fsp.readFile(target, 'utf8'));
    } catch { /* claim was just acquired; preserve a recoverable patch */ }
    const next = { ...current, ...patch };
    const tmp = `${target}.tmp-${process.pid}`;
    await fsp.writeFile(tmp, JSON.stringify(next, null, 2));
    await fsp.rename(tmp, target);
    return next;
  }

  async releaseRunnerClaim(runPath, pid, reason = 'stopped') {
    const claimPath = this.runnerClaimPath(runPath);
    let current;
    try {
      current = JSON.parse(await fsp.readFile(claimPath, 'utf8'));
    } catch {
      return;
    }
    if (pid != null && current.pid != null && Number(current.pid) !== Number(pid)) return;
    const archive = `${claimPath}.${reason}-${Date.now()}-${current.pid || current.launcherPid || 'unknown'}`;
    try {
      await fsp.rename(claimPath, archive);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async assertSingleRunner(runPath, wsPort = null) {
    const tracked = this.processes.get('cosmo-main');
    if (tracked && tracked.exitCode == null && tracked.signalCode == null && tracked.killed !== true) {
      const error = new Error(`COSMO runner already active in this launcher (pid ${tracked.pid})`);
      error.code = 'COSMO_RUNNER_ACTIVE';
      throw error;
    }
    const existing = await this.readRunnerState(runPath);
    if (existing?.active === true && this.isPidAlive(existing.pid)) {
      const error = new Error(`COSMO runner already active for this run (pid ${existing.pid})`);
      error.code = 'COSMO_RUNNER_ACTIVE';
      throw error;
    }
    if (Number.isInteger(wsPort) && wsPort > 0 && await this.isPortInUse(wsPort)) {
      const error = new Error(`COSMO WebSocket port ${wsPort} is already owned; refusing a dual start`);
      error.code = 'COSMO_RUNNER_PORT_ACTIVE';
      throw error;
    }
  }

  async markRunnerStopped(runPath, pid, code, signal) {
    const current = await this.readRunnerState(runPath);
    if (current && Number(current.pid) !== Number(pid)) return;
    if (current) {
      await this.writeRunnerState(runPath, {
        ...current,
        active: false,
        stoppedAt: new Date().toISOString(),
        exitCode: code,
        signal: signal || null
      });
    }
    await this.releaseRunnerClaim(runPath, pid, 'stopped');
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
  async startMCPServer(port = 43147, envOverrides = {}) {
    if (await this.isPortInUse(port)) {
      throw Object.assign(new Error(`MCP HTTP port ${port} is already in use`), {
        code: 'COSMO_SERVICE_PORT_ACTIVE'
      });
    }
    this.usedPorts.add(port); // Track for cleanup
    this.recordLog('Launcher', 'info', `Starting MCP HTTP on port ${port}`);

    const proc = spawn('node', ['mcp/http-server.js', port.toString()], {
      cwd: this.cosmoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      env: {
        ...process.env,
        ...envOverrides
      }
    });

    this.processes.set('mcp-http', proc);
    this.attachProcessLogging(proc, 'MCP HTTP');

    proc.on('exit', (code) => {
      this.recordLog('MCP HTTP', code === 0 ? 'info' : 'error', `Process exited (code: ${code})`);
      this.logger.info(`MCP HTTP server exited (code: ${code})`);
      this.processes.delete('mcp-http');
    });

    await this.waitForRequiredProcess('mcp-http', proc, {
      label: 'MCP HTTP',
      port,
    });

    return { success: true, port, pid: proc.pid };
  }

  /**
   * Start MCP dashboard server
   */
  async startMCPDashboard(port = 43146) {
    await this.killPort(port, 'MCP Dashboard');
    this.usedPorts.add(port); // Track for cleanup
    this.recordLog('Launcher', 'info', `Starting MCP Dashboard on port ${port}`);

    const proc = spawn('node', ['mcp/dashboard-server.js'], {
      cwd: this.cosmoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false
    });

    this.processes.set('mcp-dashboard', proc);
    this.attachProcessLogging(proc, 'MCP Dashboard');

    proc.on('exit', (code) => {
      this.recordLog('MCP Dashboard', code === 0 ? 'info' : 'error', `Process exited (code: ${code})`);
      this.logger.info(`MCP Dashboard exited (code: ${code})`);
      this.processes.delete('mcp-dashboard');
    });

    await new Promise(resolve => setTimeout(resolve, 1500));

    return { success: true, port, pid: proc.pid };
  }

  /**
   * Start main COSMO dashboard
   */
  async startMainDashboard(port = 43144, envOverrides = {}) {
    if (await this.isPortInUse(port)) {
      throw Object.assign(new Error(`Dashboard port ${port} is already in use`), {
        code: 'COSMO_SERVICE_PORT_ACTIVE'
      });
    }
    this.usedPorts.add(port); // Track for cleanup
    this.recordLog('Launcher', 'info', `Starting Dashboard on port ${port}`);

    const proc = spawn('node', ['src/dashboard/server.js'], {
      cwd: this.cosmoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      env: {
        ...process.env,
        ...envOverrides,
        COSMO_DASHBOARD_PORT: port.toString(),
        COSMO_NO_AUTO_OPEN: 'true'  // Prevent auto-opening browser tab (for Unified mode)
        // DO NOT calculate MCP port here - use what launcher already set
      }
    });

    this.processes.set('main-dashboard', proc);
    this.attachProcessLogging(proc, 'Dashboard');

    proc.on('exit', (code) => {
      this.recordLog('Dashboard', code === 0 ? 'info' : 'error', `Process exited (code: ${code})`);
      this.logger.info(`Main Dashboard exited (code: ${code})`);
      this.processes.delete('main-dashboard');
    });

    await this.waitForRequiredProcess('main-dashboard', proc, {
      label: 'Main Dashboard',
      port,
    });

    return { success: true, port, pid: proc.pid };
  }

  /**
   * Start COSMO core (single instance)
   */
  async startCOSMO(envOverrides = {}) {
    const runPath = envOverrides.COSMO_RUNTIME_DIR || envOverrides.COSMO_RUNTIME_PATH;
    if (!runPath) {
      throw new Error('COSMO_RUNTIME_DIR is required to start the COSMO runner');
    }
    const wsPort = Number.parseInt(
      envOverrides.COSMO23_WS_PORT || envOverrides.REALTIME_PORT || '',
      10
    );
    await this.assertSingleRunner(runPath, Number.isFinite(wsPort) ? wsPort : null);
    await this.acquireRunnerClaim(runPath);

    // CRITICAL: Pass through all port environment variables from launcher
    // The launcher has already calculated correct ports based on COSMO_PORT_OFFSET
    this.recordLog('Launcher', 'info', 'Starting COSMO engine');
    const proc = spawn('node', ['src/index.js'], {
      cwd: this.cosmoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      env: {
        ...process.env,
        ...envOverrides,
        COSMO_TUI: 'false',
        COSMO_TUI_SPLIT: 'false'
        // DO NOT override port env vars - use what launcher calculated
      }
    });

    this.processes.set('cosmo-main', proc);
    this.attachProcessLogging(proc, 'COSMO');
    proc.once('error', error => {
      this.recordLog('COSMO', 'error', `Process spawn failed: ${error.message}`);
      this.processes.delete('cosmo-main');
      this.releaseRunnerClaim(runPath, proc.pid, 'spawn-failed').catch(() => {});
    });
    proc.on('exit', (code, signal) => {
      this.recordLog('COSMO', code === 0 ? 'info' : 'error', `Process exited (code: ${code}, signal: ${signal || 'none'})`);
      this.logger.info(`COSMO exited (code: ${code}, signal: ${signal})`);
      this.processes.delete('cosmo-main');
      this.emit('cosmo-exit', { code, signal });
      this.markRunnerStopped(runPath, proc.pid, code, signal).catch(error => {
        this.logger.warn?.(`Could not persist runner stop state: ${error.message}`);
      });
    });
    try {
      await this.updateRunnerClaim(runPath, {
        pid: proc.pid,
        startedAt: new Date().toISOString()
      });
      await this.writeRunnerState(runPath, {
        active: true,
        pid: proc.pid,
        runPath,
        startedAt: new Date().toISOString(),
        launcherPid: process.pid
      });
    } catch (error) {
      try { process.kill(proc.pid, 'SIGTERM'); } catch { /* already gone */ }
      this.processes.delete('cosmo-main');
      await this.releaseRunnerClaim(runPath, proc.pid, 'claim-failed').catch(() => {});
      throw new Error(`Could not claim COSMO runner ownership: ${error.message}`);
    }

    await this.waitForRequiredProcess('cosmo-main', proc, {
      label: 'COSMO',
      port: Number.isFinite(wsPort) ? wsPort : undefined,
      stabilityMs: 250,
      timeoutMs: STARTUP_READINESS_TIMEOUT_MS,
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
    const observatoryProc = spawn('node', ['src/dashboard/cluster-server.js'], {
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

module.exports = {
  ProcessManager,
  STARTUP_READINESS_TIMEOUT_MS,
  RUNNER_STATE_FILENAME,
  RUNNER_HISTORY_FILENAME,
  RUNNER_CLAIM_FILENAME
};
