#!/usr/bin/env node
/**
 * Evobrew Updater
 * 
 * Provides self-update functionality for both npm global installs and git source installs.
 * Handles version checking, update execution, config migration, and daemon restart.
 * 
 * @module lib/updater
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync, spawn } = require('child_process');
const os = require('os');

// ============================================================================
// CONSTANTS
// ============================================================================

const NPM_REGISTRY_URL = 'https://registry.npmjs.org/evobrew';
const PACKAGE_NAME = 'evobrew';
const UPDATE_CHECK_TIMEOUT_MS = 10000;

// Config migration versions (add new migrations here)
const CONFIG_MIGRATIONS = {
  // '1.0.0' -> '1.1.0': example migration
  // '1.1.0': (config) => { config.newField = 'default'; return config; }
};

// ============================================================================
// PATH UTILITIES
// ============================================================================

/**
 * Get the package root directory (where package.json lives)
 * @returns {string}
 */
function getPackageRoot() {
  return path.join(__dirname, '..');
}

/**
 * Get the current installed version from package.json
 * @returns {string}
 */
function getCurrentVersion() {
  try {
    const pkgPath = path.join(getPackageRoot(), 'package.json');
    const pkg = require(pkgPath);
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// ============================================================================
// INSTALL TYPE DETECTION
// ============================================================================

/**
 * Detect how evobrew was installed
 * @returns {{type: 'npm-global' | 'git-source' | 'npm-local' | 'unknown', path: string, details: object}}
 */
function detectInstallType() {
  const packageRoot = getPackageRoot();
  
  // Check for .git directory (git clone / source install)
  const gitDir = path.join(packageRoot, '.git');
  if (fs.existsSync(gitDir)) {
    return {
      type: 'git-source',
      path: packageRoot,
      details: {
        gitDir,
        hasRemote: hasGitRemote(packageRoot)
      }
    };
  }
  
  // Check if we're in npm global directory
  try {
    const npmGlobalRoot = execSync('npm root -g', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const globalEvobrewPath = path.join(npmGlobalRoot, PACKAGE_NAME);
    
    // Normalize paths for comparison
    const normalizedPackageRoot = path.resolve(packageRoot);
    const normalizedGlobalPath = path.resolve(globalEvobrewPath);
    
    // Check if package root is within global npm directory
    if (normalizedPackageRoot.startsWith(normalizedGlobalPath) || 
        normalizedPackageRoot === normalizedGlobalPath) {
      return {
        type: 'npm-global',
        path: packageRoot,
        details: {
          npmRoot: npmGlobalRoot
        }
      };
    }
  } catch {
    // npm root -g failed, continue checking
  }
  
  // Check for node_modules in path (npm local install)
  if (packageRoot.includes('node_modules')) {
    return {
      type: 'npm-local',
      path: packageRoot,
      details: {}
    };
  }
  
  // Unknown install type
  return {
    type: 'unknown',
    path: packageRoot,
    details: {}
  };
}

/**
 * Check if a git repository has a remote configured
 * @param {string} repoPath 
 * @returns {boolean}
 */
function hasGitRemote(repoPath) {
  try {
    const result = execSync('git remote -v', { cwd: repoPath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

// ============================================================================
// VERSION CHECKING
// ============================================================================

/**
 * Fetch the latest version from npm registry
 * @returns {Promise<{version: string, published: string, changelog: string|null}>}
 */
function fetchLatestVersion() {
  return new Promise((resolve, reject) => {
    const req = https.get(NPM_REGISTRY_URL, { timeout: UPDATE_CHECK_TIMEOUT_MS }, (res) => {
      if (res.statusCode === 404) {
        reject(new Error('Package not found on npm registry'));
        return;
      }
      
      if (res.statusCode !== 200) {
        reject(new Error(`Registry returned status ${res.statusCode}`));
        return;
      }
      
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const pkg = JSON.parse(data);
          const latestVersion = pkg['dist-tags']?.latest || pkg.version;
          const versionInfo = pkg.versions?.[latestVersion] || {};
          
          resolve({
            version: latestVersion,
            published: versionInfo.time || pkg.time?.[latestVersion] || null,
            changelog: versionInfo.changelog || null,
            description: versionInfo.description || pkg.description || null
          });
        } catch (err) {
          reject(new Error(`Failed to parse registry response: ${err.message}`));
        }
      });
    });
    
    req.on('error', (err) => {
      reject(new Error(`Network error: ${err.message}`));
    });
    
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Registry request timed out'));
    });
  });
}

/**
 * Compare two semver version strings
 * @param {string} v1 
 * @param {string} v2 
 * @returns {number} -1 if v1 < v2, 0 if equal, 1 if v1 > v2
 */
function compareVersions(v1, v2) {
  const parts1 = v1.replace(/^v/, '').split('.').map(Number);
  const parts2 = v2.replace(/^v/, '').split('.').map(Number);
  
  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 < p2) return -1;
    if (p1 > p2) return 1;
  }
  return 0;
}

/**
 * Check for available updates
 * @returns {Promise<{current: string, latest: string, updateAvailable: boolean, installType: object, latestInfo: object}>}
 */
async function checkForUpdates() {
  const current = getCurrentVersion();
  const installType = detectInstallType();
  
  try {
    const latestInfo = await fetchLatestVersion();
    const updateAvailable = compareVersions(current, latestInfo.version) < 0;
    
    return {
      current,
      latest: latestInfo.version,
      updateAvailable,
      installType,
      latestInfo
    };
  } catch (err) {
    return {
      current,
      latest: null,
      updateAvailable: false,
      installType,
      error: err.message
    };
  }
}

// ============================================================================
// UPDATE EXECUTION
// ============================================================================

/**
 * Perform npm global update
 * @returns {Promise<{success: boolean, message: string, output?: string}>}
 */
async function performNpmGlobalUpdate() {
  return new Promise((resolve) => {
    console.log('📦 Updating via npm...\n');
    
    const update = spawn('npm', ['update', '-g', PACKAGE_NAME], {
      stdio: 'inherit',
      shell: true
    });
    
    update.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, message: 'npm update completed' });
      } else {
        resolve({ success: false, message: `npm update failed with code ${code}` });
      }
    });
    
    update.on('error', (err) => {
      resolve({ success: false, message: `npm update error: ${err.message}` });
    });
  });
}

/**
 * Perform git source update
 * @param {string} repoPath 
 * @returns {Promise<{success: boolean, message: string, output?: string}>}
 */
async function performGitSourceUpdate(repoPath) {
  return new Promise((resolve) => {
    console.log('🔄 Pulling latest changes from git...\n');
    
    try {
      // Check for uncommitted changes
      const status = execSync('git status --porcelain', { 
        cwd: repoPath, 
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      });
      
      if (status.trim()) {
        resolve({
          success: false,
          message: 'Uncommitted changes detected. Please commit or stash changes before updating.'
        });
        return;
      }
      
      // Get current branch
      const branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: repoPath,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      }).trim();
      
      console.log(`Current branch: ${branch}`);
      
      // Pull latest
      console.log('Running: git pull...');
      execSync('git pull', { cwd: repoPath, stdio: 'inherit' });
      
      // Run npm install
      console.log('\nRunning: npm install...');
      execSync('npm install', { cwd: repoPath, stdio: 'inherit' });
      
      resolve({ success: true, message: 'Git update completed' });
    } catch (err) {
      resolve({ success: false, message: `Git update error: ${err.message}` });
    }
  });
}

/**
 * Perform the update based on install type
 * @returns {Promise<{success: boolean, message: string, newVersion?: string}>}
 */
async function performUpdate() {
  const installType = detectInstallType();
  const oldVersion = getCurrentVersion();
  
  let result;
  
  switch (installType.type) {
    case 'npm-global':
      result = await performNpmGlobalUpdate();
      break;
      
    case 'git-source':
      if (!installType.details.hasRemote) {
        return {
          success: false,
          message: 'Git repository has no remote configured. Cannot pull updates.'
        };
      }
      result = await performGitSourceUpdate(installType.path);
      break;
      
    case 'npm-local':
      return {
        success: false,
        message: 'Local npm install detected. Update the parent project instead.'
      };
      
    default:
      return {
        success: false,
        message: `Unknown install type: ${installType.type}. Cannot determine update method.`
      };
  }
  
  if (result.success) {
    // Clear require cache to get new version
    const pkgPath = path.join(getPackageRoot(), 'package.json');
    delete require.cache[require.resolve(pkgPath)];
    
    const newVersion = getCurrentVersion();
    result.oldVersion = oldVersion;
    result.newVersion = newVersion;
  }
  
  return result;
}

// ============================================================================
// CONFIG MIGRATION
// ============================================================================

/**
 * Get the list of migrations to apply between two versions
 * @param {string} fromVersion 
 * @param {string} toVersion 
 * @returns {string[]} List of version keys that need migration
 */
function getMigrationsToApply(fromVersion, toVersion) {
  const migrationVersions = Object.keys(CONFIG_MIGRATIONS).sort((a, b) => compareVersions(a, b));
  
  return migrationVersions.filter(v => 
    compareVersions(v, fromVersion) > 0 && 
    compareVersions(v, toVersion) <= 0
  );
}

/**
 * Migrate config from one version to another
 * @param {object} config - Current config object
 * @param {string} fromVersion - Current config version
 * @param {string} toVersion - Target config version
 * @returns {{config: object, migrated: boolean, appliedMigrations: string[]}}
 */
function migrateConfig(config, fromVersion, toVersion) {
  const migrations = getMigrationsToApply(fromVersion, toVersion);
  
  // Deep clone config to avoid mutating original
  let migratedConfig = JSON.parse(JSON.stringify(config));
  const appliedMigrations = [];
  
  // Apply each migration in order
  for (const version of migrations) {
    const migrationFn = CONFIG_MIGRATIONS[version];
    if (migrationFn) {
      try {
        migratedConfig = migrationFn(migratedConfig);
        appliedMigrations.push(version);
      } catch (err) {
        console.error(`⚠️  Migration to ${version} failed: ${err.message}`);
        // Continue with other migrations
      }
    }
  }
  
  // Always update config version to target version
  migratedConfig.version = toVersion;
  
  return {
    config: migratedConfig,
    migrated: appliedMigrations.length > 0,
    appliedMigrations
  };
}

/**
 * Run config migration using the config manager
 * @returns {Promise<{success: boolean, message: string, appliedMigrations?: string[]}>}
 */
async function runConfigMigration() {
  try {
    const { loadConfig, saveConfig, CONFIG_VERSION } = require('./config-manager');
    
    let config;
    try {
      config = await loadConfig();
    } catch {
      // No config file, nothing to migrate
      return { success: true, message: 'No config file to migrate' };
    }
    
    const currentConfigVersion = config.version || '1.0.0';
    
    if (compareVersions(currentConfigVersion, CONFIG_VERSION) >= 0) {
      return { success: true, message: 'Config is already up to date' };
    }
    
    const { config: migratedConfig, migrated, appliedMigrations } = migrateConfig(
      config,
      currentConfigVersion,
      CONFIG_VERSION
    );
    
    if (migrated) {
      await saveConfig(migratedConfig);
      return {
        success: true,
        message: `Config migrated from ${currentConfigVersion} to ${CONFIG_VERSION}`,
        appliedMigrations
      };
    }
    
    // Update version even if no migrations were needed
    config.version = CONFIG_VERSION;
    await saveConfig(config);
    
    return { success: true, message: 'Config version updated' };
  } catch (err) {
    return { success: false, message: `Config migration failed: ${err.message}` };
  }
}

// ============================================================================
// DAEMON MANAGEMENT
// ============================================================================

/**
 * Restart the daemon if it's running
 * @returns {Promise<{success: boolean, message: string, wasRunning: boolean}>}
 */
async function restartDaemonIfRunning() {
  try {
    const daemonManager = require('./daemon-manager');
    const status = daemonManager.getDaemonStatus();
    
    if (!status.running) {
      return { success: true, message: 'Daemon was not running', wasRunning: false };
    }
    
    console.log('🔄 Restarting daemon...');
    await daemonManager.restartDaemon();
    
    // Wait for daemon to come back up
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const newStatus = daemonManager.getDaemonStatus();
    
    if (newStatus.running) {
      return {
        success: true,
        message: `Daemon restarted (PID: ${newStatus.pid})`,
        wasRunning: true
      };
    } else {
      return {
        success: false,
        message: 'Daemon restart failed - service not running after restart',
        wasRunning: true
      };
    }
  } catch (err) {
    return {
      success: false,
      message: `Daemon restart failed: ${err.message}`,
      wasRunning: true
    };
  }
}

// ============================================================================
// FULL UPDATE FLOW
// ============================================================================

/**
 * Perform a complete update: check, update, migrate, restart
 * @param {object} options
 * @param {boolean} options.force - Force update even if no new version
 * @param {boolean} options.skipRestart - Don't restart daemon
 * @returns {Promise<{success: boolean, steps: object[]}>}
 */
async function fullUpdate(options = {}) {
  const steps = [];
  let overallSuccess = true;
  
  // Step 1: Check for updates
  console.log('🔍 Checking for updates...\n');
  const updateCheck = await checkForUpdates();
  steps.push({ step: 'check', ...updateCheck });
  
  if (updateCheck.error) {
    console.log(`⚠️  Could not check for updates: ${updateCheck.error}\n`);
    if (!options.force) {
      return { success: false, steps, error: updateCheck.error };
    }
  }
  
  console.log(`Current version: ${updateCheck.current}`);
  console.log(`Latest version:  ${updateCheck.latest || 'unknown'}`);
  console.log(`Install type:    ${updateCheck.installType.type}\n`);
  
  if (!updateCheck.updateAvailable && !options.force) {
    console.log('✅ Already up to date!\n');
    return { success: true, steps, upToDate: true };
  }
  
  if (updateCheck.updateAvailable) {
    console.log('📥 Update available!\n');
  }
  
  // Step 2: Perform update
  const updateResult = await performUpdate();
  steps.push({ step: 'update', ...updateResult });
  
  if (!updateResult.success) {
    console.log(`\n❌ Update failed: ${updateResult.message}\n`);
    return { success: false, steps };
  }
  
  console.log(`\n✅ ${updateResult.message}`);
  if (updateResult.newVersion !== updateResult.oldVersion) {
    console.log(`   Version: ${updateResult.oldVersion} → ${updateResult.newVersion}`);
  }
  console.log();
  
  // Step 3: Run config migration
  console.log('🔧 Checking config migrations...');
  const migrationResult = await runConfigMigration();
  steps.push({ step: 'migrate', ...migrationResult });
  
  if (!migrationResult.success) {
    console.log(`⚠️  ${migrationResult.message}`);
    overallSuccess = false;
  } else {
    console.log(`✅ ${migrationResult.message}\n`);
  }
  
  // Step 4: Restart daemon
  if (!options.skipRestart) {
    const restartResult = await restartDaemonIfRunning();
    steps.push({ step: 'restart', ...restartResult });
    
    if (!restartResult.success && restartResult.wasRunning) {
      console.log(`⚠️  ${restartResult.message}`);
      overallSuccess = false;
    } else if (restartResult.wasRunning) {
      console.log(`✅ ${restartResult.message}\n`);
    }
  }
  
  // Final summary
  console.log('─'.repeat(40));
  if (overallSuccess) {
    console.log('✅ Update complete!\n');
  } else {
    console.log('⚠️  Update completed with warnings\n');
  }
  
  return { success: overallSuccess, steps };
}

/**
 * Print update check results in a formatted way
 * @param {object} checkResult 
 */
function printUpdateCheckResult(checkResult) {
  console.log('\n🧪 Evobrew Update Check\n');
  console.log('─'.repeat(40));
  
  console.log(`Current version:  ${checkResult.current}`);
  console.log(`Latest version:   ${checkResult.latest || 'unknown'}`);
  console.log(`Install type:     ${checkResult.installType.type}`);
  console.log(`Install path:     ${checkResult.installType.path}`);
  
  if (checkResult.error) {
    console.log(`\n⚠️  ${checkResult.error}`);
  } else if (checkResult.updateAvailable) {
    console.log(`\n📥 Update available!`);
    console.log(`\nRun 'evobrew update' to update.`);
  } else {
    console.log(`\n✅ You're up to date!`);
  }
  
  console.log('');
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Version info
  getCurrentVersion,
  fetchLatestVersion,
  compareVersions,
  
  // Install type
  detectInstallType,
  getPackageRoot,
  
  // Update operations
  checkForUpdates,
  performUpdate,
  fullUpdate,
  
  // Config migration
  migrateConfig,
  runConfigMigration,
  getMigrationsToApply,
  
  // Daemon
  restartDaemonIfRunning,
  
  // Display
  printUpdateCheckResult,
  
  // Constants
  CONFIG_MIGRATIONS,
  PACKAGE_NAME
};
