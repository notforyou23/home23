#!/usr/bin/env node
/**
 * Evobrew Daemon Manager
 * 
 * Provides cross-platform service management for macOS (launchd) and Linux (systemd).
 * Modeled after OpenClaw's approach for a "set and forget" experience.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn, exec } = require('child_process');
const { promisify } = require('util');
const zlib = require('zlib');

const execAsync = promisify(exec);
const gzip = promisify(zlib.gzip);

// ============================================================================
// CONSTANTS
// ============================================================================

const SERVICE_NAME = 'com.evobrew.server';
const SYSTEMD_SERVICE_NAME = 'evobrew';
const PM2_PROCESS_NAME = 'evobrew';
const DEFAULT_PORT = 3405;

// Resolve paths
const HOME = os.homedir();
const EVOBREW_HOME = process.env.EVOBREW_HOME || path.join(HOME, '.evobrew');
const CONFIG_PATH = process.env.EVOBREW_CONFIG_PATH || path.join(EVOBREW_HOME, 'config.json');
const LOGS_DIR = path.join(EVOBREW_HOME, 'logs');
const LOG_FILE = path.join(LOGS_DIR, 'server.log');
const ERROR_LOG_FILE = path.join(LOGS_DIR, 'error.log');

// Service file locations
const LAUNCHD_PLIST_PATH = path.join(HOME, 'Library', 'LaunchAgents', `${SERVICE_NAME}.plist`);
const SYSTEMD_USER_DIR = path.join(HOME, '.config', 'systemd', 'user');
const SYSTEMD_SERVICE_PATH = path.join(SYSTEMD_USER_DIR, `${SYSTEMD_SERVICE_NAME}.service`);

// Log rotation settings
const LOG_MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
const LOG_RETENTION_DAYS = 7;

// ============================================================================
// PLATFORM DETECTION
// ============================================================================

function hasPm2() {
  try {
    execSync('pm2 -v', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function pm2Exec(cmd) {
  // Keep output quiet unless errors; return stdout
  return execSync(`pm2 ${cmd}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}


/**
 * Detect the current platform and service manager
 * @returns {{platform: string, serviceManager: string, supported: boolean, message?: string}}
 */
function detectPlatform() {
  const platform = process.platform;
  
  if (platform === 'darwin') {
    return { platform: 'macos', serviceManager: 'launchd', supported: true };
  }
  
  if (platform === 'linux') {
    // Check if systemd is available
    try {
      execSync('systemctl --user --version', { stdio: 'pipe' });
      return { platform: 'linux', serviceManager: 'systemd', supported: true };
    } catch {
      return { 
        platform: 'linux', 
        serviceManager: 'none', 
        supported: false,
        message: 'systemd user services not available. Ensure systemd is running and user linger is enabled.'
      };
    }
  }
  
  if (platform === 'win32') {
    return {
      platform: 'windows',
      serviceManager: 'none',
      supported: false,
      message: 'Windows is not directly supported. Please use WSL2 with systemd enabled.'
    };
  }
  
  return {
    platform: 'unknown',
    serviceManager: 'none',
    supported: false,
    message: `Unsupported platform: ${platform}`
  };
}

// ============================================================================
// PATH RESOLUTION
// ============================================================================

/**
 * Find the Node.js executable path
 */
function getNodePath() {
  try {
    const nodePath = execSync('which node', { encoding: 'utf8' }).trim();
    return nodePath;
  } catch {
    // Fallback paths
    const fallbacks = [
      '/opt/homebrew/bin/node',
      '/usr/local/bin/node',
      '/usr/bin/node'
    ];
    for (const p of fallbacks) {
      if (fs.existsSync(p)) return p;
    }
    throw new Error('Could not find Node.js executable');
  }
}

/**
 * Find the Evobrew server script path
 */
function getServerPath() {
  // Check if we're running from a global install or local
  const possiblePaths = [
    // Global install (npm -g)
    path.join(__dirname, '..', 'server', 'server.js'),
    // Local development
    path.join(process.cwd(), 'server', 'server.js'),
  ];
  
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return path.resolve(p);
  }
  
  throw new Error('Could not find server.js. Is Evobrew installed correctly?');
}

// ============================================================================
// DIRECTORY SETUP
// ============================================================================

/**
 * Ensure all required directories exist
 */
function ensureDirectories() {
  const dirs = [
    EVOBREW_HOME,
    LOGS_DIR,
    path.dirname(LAUNCHD_PLIST_PATH),
    SYSTEMD_USER_DIR
  ];
  
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

// ============================================================================
// LAUNCHD (macOS) SERVICE MANAGEMENT
// ============================================================================

/**
 * Generate launchd plist content
 */
function generatePlist() {
  const nodePath = getNodePath();
  const serverPath = getServerPath();
  
  // WorkingDirectory must be the repo root (where package.json lives), not server/
  const repoRoot = path.dirname(path.dirname(serverPath));
  
  // Load encryption key from config if available
  let encryptionKey = '';
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      encryptionKey = config.security?.encryption_key || '';
    }
  } catch {
    // Ignore errors reading config
  }
  
  // Database path
  const databasePath = path.join(EVOBREW_HOME, 'database.db');
  
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${SERVICE_NAME}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${serverPath}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${LOG_FILE}</string>
    <key>StandardErrorPath</key>
    <string>${ERROR_LOG_FILE}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>EVOBREW_CONFIG_PATH</key>
        <string>${CONFIG_PATH}</string>
        <key>EVOBREW_HOME</key>
        <string>${EVOBREW_HOME}</string>
        <key>NODE_ENV</key>
        <string>production</string>
        <key>DATABASE_URL</key>
        <string>file:${databasePath}</string>${encryptionKey ? `
        <key>ENCRYPTION_KEY</key>
        <string>${encryptionKey}</string>` : ''}
    </dict>
    <key>WorkingDirectory</key>
    <string>${repoRoot}</string>
    <key>ProcessType</key>
    <string>Background</string>
    <key>LowPriorityIO</key>
    <false/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>`;
}

/**
 * Check if launchd service is loaded
 */
function isLaunchdLoaded() {
  try {
    const result = execSync(`launchctl list | grep "${SERVICE_NAME}"`, { 
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return result.includes(SERVICE_NAME);
  } catch {
    return false;
  }
}

/**
 * Get launchd service PID
 */
function getLaunchdPid() {
  try {
    const result = execSync(`launchctl list | grep "${SERVICE_NAME}"`, { 
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    // Format: PID\tStatus\tLabel
    const parts = result.trim().split(/\s+/);
    const pid = parseInt(parts[0], 10);
    return isNaN(pid) || pid === 0 ? null : pid;
  } catch {
    return null;
  }
}

/**
 * Install launchd service
 */
async function installLaunchd() {
  ensureDirectories();
  
  // Write plist file
  const plistContent = generatePlist();
  fs.writeFileSync(LAUNCHD_PLIST_PATH, plistContent);
  
  // Unload if already loaded
  if (isLaunchdLoaded()) {
    try {
      execSync(`launchctl unload "${LAUNCHD_PLIST_PATH}"`, { stdio: 'pipe' });
    } catch {
      // Ignore errors
    }
  }
  
  // Load the service
  try {
    execSync(`launchctl load "${LAUNCHD_PLIST_PATH}"`, { stdio: 'pipe' });
  } catch (err) {
    throw new Error(`Failed to load launchd service: ${err.message}`);
  }
  
  return { success: true, plistPath: LAUNCHD_PLIST_PATH };
}

/**
 * Uninstall launchd service
 */
async function uninstallLaunchd() {
  if (isLaunchdLoaded()) {
    try {
      execSync(`launchctl unload "${LAUNCHD_PLIST_PATH}"`, { stdio: 'pipe' });
    } catch {
      // May fail if already unloaded
    }
  }
  
  if (fs.existsSync(LAUNCHD_PLIST_PATH)) {
    fs.unlinkSync(LAUNCHD_PLIST_PATH);
  }
  
  return { success: true };
}

/**
 * Start launchd service
 */
async function startLaunchd() {
  if (!fs.existsSync(LAUNCHD_PLIST_PATH)) {
    throw new Error('Service not installed. Run: evobrew daemon install');
  }
  
  if (!isLaunchdLoaded()) {
    execSync(`launchctl load "${LAUNCHD_PLIST_PATH}"`, { stdio: 'pipe' });
  }
  
  execSync(`launchctl start "${SERVICE_NAME}"`, { stdio: 'pipe' });
  
  // Wait a moment for the process to start
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  return { success: true, pid: getLaunchdPid() };
}

/**
 * Stop launchd service
 */
async function stopLaunchd() {
  if (isLaunchdLoaded()) {
    try {
      execSync(`launchctl stop "${SERVICE_NAME}"`, { stdio: 'pipe' });
    } catch {
      // May fail if not running
    }
  }
  
  return { success: true };
}

/**
 * Restart launchd service
 */
async function restartLaunchd() {
  await stopLaunchd();
  await new Promise(resolve => setTimeout(resolve, 500));
  return startLaunchd();
}

/**
 * Get launchd service status
 */
function getLaunchdStatus() {
  const loaded = isLaunchdLoaded();
  const pid = getLaunchdPid();
  const running = pid !== null;
  
  let uptime = null;
  if (running && pid) {
    try {
      // Get process start time
      const result = execSync(`ps -p ${pid} -o lstart=`, { 
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      });
      const startTime = new Date(result.trim());
      uptime = Math.floor((Date.now() - startTime.getTime()) / 1000);
    } catch {
      // Ignore
    }
  }
  
  return {
    installed: fs.existsSync(LAUNCHD_PLIST_PATH),
    loaded,
    running,
    pid,
    uptime,
    plistPath: LAUNCHD_PLIST_PATH
  };
}

// ============================================================================
// SYSTEMD (Linux) SERVICE MANAGEMENT
// ============================================================================

/**
 * Generate systemd unit file content
 */
function generateSystemdUnit() {
  const nodePath = getNodePath();
  const serverPath = getServerPath();
  
  // WorkingDirectory must be the repo root (where package.json lives), not server/
  const repoRoot = path.dirname(path.dirname(serverPath));
  
  // Load encryption key from config if available
  let encryptionKey = '';
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      encryptionKey = config.security?.encryption_key || '';
    }
  } catch {
    // Ignore errors reading config
  }
  
  // Database path
  const databasePath = path.join(EVOBREW_HOME, 'database.db');
  
  return `[Unit]
Description=Evobrew AI Development Workspace
After=network.target
Documentation=https://github.com/yourusername/evobrew

[Service]
Type=simple
ExecStart=${nodePath} ${serverPath}
Restart=always
RestartSec=10
Environment=EVOBREW_CONFIG_PATH=${CONFIG_PATH}
Environment=EVOBREW_HOME=${EVOBREW_HOME}
Environment=NODE_ENV=production
Environment=DATABASE_URL=file:${databasePath}${encryptionKey ? `
Environment=ENCRYPTION_KEY=${encryptionKey}` : ''}
WorkingDirectory=${repoRoot}
StandardOutput=append:${LOG_FILE}
StandardError=append:${ERROR_LOG_FILE}

# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=${EVOBREW_HOME}
PrivateTmp=true

[Install]
WantedBy=default.target
`;
}

/**
 * Check if systemd service is enabled
 */
function isSystemdEnabled() {
  try {
    execSync(`systemctl --user is-enabled ${SYSTEMD_SERVICE_NAME}`, { 
      stdio: 'pipe',
      encoding: 'utf8'
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if systemd service is active (running)
 */
function isSystemdActive() {
  try {
    execSync(`systemctl --user is-active ${SYSTEMD_SERVICE_NAME}`, { 
      stdio: 'pipe',
      encoding: 'utf8'
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get systemd service PID
 */
function getSystemdPid() {
  try {
    const result = execSync(`systemctl --user show ${SYSTEMD_SERVICE_NAME} --property=MainPID`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const match = result.match(/MainPID=(\d+)/);
    if (match) {
      const pid = parseInt(match[1], 10);
      return pid === 0 ? null : pid;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Install systemd service
 */
async function installSystemd() {
  ensureDirectories();
  
  // Write unit file
  const unitContent = generateSystemdUnit();
  fs.writeFileSync(SYSTEMD_SERVICE_PATH, unitContent);
  
  // Reload systemd
  execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
  
  // Enable service
  execSync(`systemctl --user enable ${SYSTEMD_SERVICE_NAME}`, { stdio: 'pipe' });
  
  // Enable lingering so service runs without login
  try {
    execSync(`loginctl enable-linger ${os.userInfo().username}`, { stdio: 'pipe' });
  } catch {
    // May require sudo or already enabled
  }
  
  // Start service
  execSync(`systemctl --user start ${SYSTEMD_SERVICE_NAME}`, { stdio: 'pipe' });
  
  return { success: true, unitPath: SYSTEMD_SERVICE_PATH };
}

/**
 * Uninstall systemd service
 */
async function uninstallSystemd() {
  try {
    execSync(`systemctl --user stop ${SYSTEMD_SERVICE_NAME}`, { stdio: 'pipe' });
  } catch {
    // May not be running
  }
  
  try {
    execSync(`systemctl --user disable ${SYSTEMD_SERVICE_NAME}`, { stdio: 'pipe' });
  } catch {
    // May not be enabled
  }
  
  if (fs.existsSync(SYSTEMD_SERVICE_PATH)) {
    fs.unlinkSync(SYSTEMD_SERVICE_PATH);
  }
  
  execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
  
  return { success: true };
}

/**
 * Start systemd service
 */
async function startSystemd() {
  if (!fs.existsSync(SYSTEMD_SERVICE_PATH)) {
    throw new Error('Service not installed. Run: evobrew daemon install');
  }
  
  execSync(`systemctl --user start ${SYSTEMD_SERVICE_NAME}`, { stdio: 'pipe' });
  
  // Wait a moment for the process to start
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  return { success: true, pid: getSystemdPid() };
}

/**
 * Stop systemd service
 */
async function stopSystemd() {
  try {
    execSync(`systemctl --user stop ${SYSTEMD_SERVICE_NAME}`, { stdio: 'pipe' });
  } catch {
    // May not be running
  }
  
  return { success: true };
}

/**
 * Restart systemd service
 */
async function restartSystemd() {
  execSync(`systemctl --user restart ${SYSTEMD_SERVICE_NAME}`, { stdio: 'pipe' });
  await new Promise(resolve => setTimeout(resolve, 1000));
  return { success: true, pid: getSystemdPid() };
}

/**
 * Get systemd service status
 */
function getSystemdStatus() {
  const installed = fs.existsSync(SYSTEMD_SERVICE_PATH);
  const enabled = isSystemdEnabled();
  const running = isSystemdActive();
  const pid = getSystemdPid();
  
  let uptime = null;
  if (running) {
    try {
      const result = execSync(
        `systemctl --user show ${SYSTEMD_SERVICE_NAME} --property=ActiveEnterTimestamp`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const match = result.match(/ActiveEnterTimestamp=(.+)/);
      if (match && match[1] !== 'n/a') {
        const startTime = new Date(match[1]);
        uptime = Math.floor((Date.now() - startTime.getTime()) / 1000);
      }
    } catch {
      // Ignore
    }
  }
  
  return {
    installed,
    enabled,
    running,
    pid,
    uptime,
    unitPath: SYSTEMD_SERVICE_PATH
  };
}

// ============================================================================
// PM2 RUNNER
// ============================================================================

function pm2EnvVars() {
  // Only pass non-secret env. Secrets should be read from ~/.evobrew/config.json.
  const databasePath = path.join(EVOBREW_HOME, 'database.db');
  const env = {
    EVOBREW_CONFIG_PATH: CONFIG_PATH,
    EVOBREW_HOME,
    NODE_ENV: 'production',
    DATABASE_URL: `file:${databasePath}`
  };

  // Optional: ports from config
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      const httpPort = cfg.server?.http_port;
      const httpsPort = cfg.server?.https_port;
      if (httpPort) env.HTTP_PORT = String(httpPort);
      if (httpsPort) env.HTTPS_PORT = String(httpsPort);
    }
  } catch {}

  return env;
}

async function installPm2() {
  if (!hasPm2()) {
    throw new Error('PM2 not installed. Install with: npm install -g pm2');
  }

  ensureDirectories();

  const nodePath = getNodePath();
  const serverPath = getServerPath();
  const repoRoot = path.dirname(path.dirname(serverPath));
  const env = pm2EnvVars();

  // Start or restart idempotently
  try { pm2Exec(`delete ${PM2_PROCESS_NAME}`); } catch {}

  // Use pm2 start <node> -- <server>
  // Set cwd to repo root (so relative paths resolve)
  const envPairs = Object.entries(env)
    .map(([k, v]) => `${k}=${JSON.stringify(String(v))}`)
    .join(' ');

  execSync(`${envPairs} pm2 start ${JSON.stringify(nodePath)} --name ${PM2_PROCESS_NAME} -- ${JSON.stringify(serverPath)}`, {
    stdio: 'pipe',
    cwd: repoRoot,
    env: { ...process.env, ...env }
  });

  // Persist across reboot (user must have pm2 startup configured)
  try { pm2Exec('save'); } catch {}

  return { success: true, runner: 'pm2' };
}

async function uninstallPm2() {
  if (!hasPm2()) {
    return { success: true, runner: 'pm2', message: 'pm2 not installed' };
  }
  try { pm2Exec(`delete ${PM2_PROCESS_NAME}`); } catch {}
  try { pm2Exec('save'); } catch {}
  return { success: true, runner: 'pm2' };
}

async function startPm2() {
  if (!hasPm2()) throw new Error('PM2 not installed');
  try { pm2Exec(`start ${PM2_PROCESS_NAME}`); } catch {
    // If not found, install
    return installPm2();
  }
  return { success: true, runner: 'pm2' };
}

async function stopPm2() {
  if (!hasPm2()) throw new Error('PM2 not installed');
  try { pm2Exec(`stop ${PM2_PROCESS_NAME}`); } catch {}
  return { success: true, runner: 'pm2' };
}

async function restartPm2() {
  if (!hasPm2()) throw new Error('PM2 not installed');
  try { pm2Exec(`restart ${PM2_PROCESS_NAME} --update-env`); } catch {
    return installPm2();
  }
  return { success: true, runner: 'pm2' };
}

function getPm2Logs(lines = 50) {
  if (!hasPm2()) return 'PM2 not installed';
  try {
    // Non-following logs (tail)
    return execSync(`pm2 logs ${PM2_PROCESS_NAME} --lines ${lines} --nostream`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (e) {
    return `Failed to read pm2 logs: ${e.message}`;
  }
}

// ============================================================================
// UNIFIED API
// ============================================================================

/**
 * Install daemon service
 */
async function installDaemon(options = {}) {
  const { runner } = options;

  if (runner === 'pm2') {
    return installPm2();
  }

  const platform = detectPlatform();

  if (!platform.supported) {
    throw new Error(platform.message || 'Platform not supported');
  }

  if (platform.serviceManager === 'launchd') {
    return installLaunchd();
  } else if (platform.serviceManager === 'systemd') {
    return installSystemd();
  }

  throw new Error('No supported service manager found');
}

/**
 * Uninstall daemon service
 */
async function uninstallDaemon(options = {}) {
  const { runner } = options;

  if (runner === 'pm2') {
    return uninstallPm2();
  }

  const platform = detectPlatform();

  if (!platform.supported) {
    throw new Error(platform.message || 'Platform not supported');
  }

  if (platform.serviceManager === 'launchd') {
    return uninstallLaunchd();
  } else if (platform.serviceManager === 'systemd') {
    return uninstallSystemd();
  }

  throw new Error('No supported service manager found');
}

/**
 * Start daemon service
 */
async function startDaemon(options = {}) {
  const { runner } = options;

  if (runner === 'pm2') {
    return startPm2();
  }

  const platform = detectPlatform();

  if (!platform.supported) {
    throw new Error(platform.message || 'Platform not supported');
  }

  if (platform.serviceManager === 'launchd') {
    return startLaunchd();
  } else if (platform.serviceManager === 'systemd') {
    return startSystemd();
  }

  throw new Error('No supported service manager found');
}

/**
 * Stop daemon service
 */
async function stopDaemon(options = {}) {
  const { runner } = options;

  if (runner === 'pm2') {
    return stopPm2();
  }

  const platform = detectPlatform();

  if (!platform.supported) {
    throw new Error(platform.message || 'Platform not supported');
  }

  if (platform.serviceManager === 'launchd') {
    return stopLaunchd();
  } else if (platform.serviceManager === 'systemd') {
    return stopSystemd();
  }

  throw new Error('No supported service manager found');
}

/**
 * Restart daemon service
 */
async function restartDaemon(options = {}) {
  const { runner } = options;

  if (runner === 'pm2') {
    return restartPm2();
  }

  const platform = detectPlatform();

  if (!platform.supported) {
    throw new Error(platform.message || 'Platform not supported');
  }

  if (platform.serviceManager === 'launchd') {
    return restartLaunchd();
  } else if (platform.serviceManager === 'systemd') {
    return restartSystemd();
  }

  throw new Error('No supported service manager found');
}

/**
 * Get daemon service status
 * @returns {{installed: boolean, running: boolean, pid: number|null, uptime: number|null, port: number, platform: object}}
 */
function getDaemonStatus() {
  const platform = detectPlatform();

  // Try to get port from config
  let port = DEFAULT_PORT;
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      port = config.server?.http_port || config.port || DEFAULT_PORT;
    }
  } catch {
    // Use default
  }

  // PM2 status (optional)
  if (hasPm2()) {
    try {
      const j = execSync('pm2 jlist', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      const list = JSON.parse(j);
      const p = (list || []).find(x => x?.name === PM2_PROCESS_NAME);
      const installed = !!p;
      const running = p?.pm2_env?.status === 'online';
      const pid = p?.pid || null;
      const pm_uptime = p?.pm2_env?.pm_uptime || null;
      const uptime = pm_uptime ? Math.floor((Date.now() - pm_uptime) / 1000) : null;
      return {
        installed,
        enabled: installed,
        running,
        pid,
        uptime,
        port,
        platform,
        runner: 'pm2'
      };
    } catch {
      // ignore pm2 parsing errors
    }
  }

  let status;
  if (platform.serviceManager === 'launchd') {
    status = getLaunchdStatus();
  } else if (platform.serviceManager === 'systemd') {
    status = getSystemdStatus();
  } else {
    status = {
      installed: false,
      running: false,
      pid: null,
      uptime: null
    };
  }

  return {
    ...status,
    port,
    platform,
    runner: platform.serviceManager
  };
}

/**
 * Get daemon logs
 * @param {number} lines - Number of lines to return (default 50)
 * @param {boolean} follow - Whether to follow (tail -f style) - not supported in sync mode
 * @returns {string}
 */
function getDaemonLogs(lines = 50, options = {}) {
  const { errorLog = false } = options;
  const logPath = errorLog ? ERROR_LOG_FILE : LOG_FILE;
  
  if (!fs.existsSync(logPath)) {
    return `No logs found at ${logPath}`;
  }
  
  try {
    // Use tail to get last N lines
    const result = execSync(`tail -n ${lines} "${logPath}"`, { 
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return result;
  } catch {
    // Fallback: read file directly
    const content = fs.readFileSync(logPath, 'utf8');
    const logLines = content.split('\n');
    return logLines.slice(-lines).join('\n');
  }
}

/**
 * Tail logs (returns a child process)
 * @param {object} options
 * @returns {ChildProcess}
 */
function tailDaemonLogs(options = {}) {
  const { errorLog = false, lines = 50 } = options;
  const logPath = errorLog ? ERROR_LOG_FILE : LOG_FILE;
  
  if (!fs.existsSync(logPath)) {
    // Create empty log file
    ensureDirectories();
    fs.writeFileSync(logPath, '');
  }
  
  const tail = spawn('tail', ['-f', '-n', String(lines), logPath], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  
  return tail;
}

// ============================================================================
// LOG ROTATION
// ============================================================================

/**
 * Rotate log files if they exceed the size limit
 */
async function rotateLogs() {
  const logFiles = [LOG_FILE, ERROR_LOG_FILE];
  
  for (const logPath of logFiles) {
    if (!fs.existsSync(logPath)) continue;
    
    const stats = fs.statSync(logPath);
    
    // Check if rotation needed
    if (stats.size < LOG_MAX_SIZE_BYTES) continue;
    
    // Generate timestamp for rotated file
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
    const ext = path.extname(logPath);
    const base = path.basename(logPath, ext);
    const rotatedPath = path.join(LOGS_DIR, `${base}-${timestamp}${ext}`);
    
    // Rename current log to rotated name
    fs.renameSync(logPath, rotatedPath);
    
    // Create empty new log file
    fs.writeFileSync(logPath, '');
    
    // Compress rotated log
    try {
      const content = fs.readFileSync(rotatedPath);
      const compressed = await gzip(content);
      fs.writeFileSync(`${rotatedPath}.gz`, compressed);
      fs.unlinkSync(rotatedPath);
    } catch (err) {
      console.error(`Failed to compress ${rotatedPath}:`, err.message);
    }
  }
}

/**
 * Clean up old log files (older than retention period)
 */
function cleanupOldLogs() {
  if (!fs.existsSync(LOGS_DIR)) return;
  
  const cutoffTime = Date.now() - (LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const files = fs.readdirSync(LOGS_DIR);
  
  for (const file of files) {
    // Only clean rotated logs (with date in name)
    if (!file.match(/\d{4}-\d{2}-\d{2}/)) continue;
    
    const filePath = path.join(LOGS_DIR, file);
    const stats = fs.statSync(filePath);
    
    if (stats.mtimeMs < cutoffTime) {
      fs.unlinkSync(filePath);
    }
  }
}

/**
 * Run full log maintenance (rotate + cleanup)
 */
async function maintainLogs() {
  await rotateLogs();
  cleanupOldLogs();
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Format uptime in human-readable format
 * @param {number} seconds
 * @returns {string}
 */
function formatUptime(seconds) {
  if (!seconds) return 'N/A';
  
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);
  
  return parts.join(' ');
}

/**
 * Print status in a formatted way
 */
function printStatus(status) {
  const { installed, running, pid, uptime, port, platform } = status;
  
  console.log('\n📊 Evobrew Daemon Status\n');
  console.log(`Platform:    ${platform.platform} (${platform.serviceManager})`);
  console.log(`Installed:   ${installed ? '✅ Yes' : '❌ No'}`);
  console.log(`Running:     ${running ? '✅ Yes' : '❌ No'}`);
  
  if (pid) {
    console.log(`PID:         ${pid}`);
  }
  
  if (uptime) {
    console.log(`Uptime:      ${formatUptime(uptime)}`);
  }
  
  console.log(`Port:        ${port}`);
  
  if (running) {
    console.log(`\n🌐 Access at: http://localhost:${port}`);
  }
  
  console.log('');
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Platform detection
  detectPlatform,
  
  // Core daemon operations
  installDaemon,
  uninstallDaemon,
  startDaemon,
  stopDaemon,
  restartDaemon,
  getDaemonStatus,
  
  // Logging
  getDaemonLogs,
  tailDaemonLogs,
  maintainLogs,
  rotateLogs,
  cleanupOldLogs,
  
  // Utilities
  formatUptime,
  printStatus,
  ensureDirectories,
  
  // Constants
  SERVICE_NAME,
  SYSTEMD_SERVICE_NAME,
  EVOBREW_HOME,
  CONFIG_PATH,
  LOGS_DIR,
  LOG_FILE,
  ERROR_LOG_FILE,
  LAUNCHD_PLIST_PATH,
  SYSTEMD_SERVICE_PATH,
  DEFAULT_PORT,

  // PM2 helpers (used by CLI/wizard/doctor)
  hasPm2,
  installPm2,
  uninstallPm2,
  startPm2,
  stopPm2,
  restartPm2,
  getPm2Logs,
  PM2_PROCESS_NAME
};
