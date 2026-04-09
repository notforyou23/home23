/**
 * Environment Provisioner — Isolated execution environments from plugin/skill requirements
 *
 * Creates and manages temporary execution environments for code execution.
 * Two provisioning strategies:
 *   1. Local pip (default): temp working directory + pip install for Python packages
 *   2. Docker container: isolated container with volume mount to working directory
 *
 * Part of the Execution Architecture (Plugin → Skill → Tool → Environment → Monitor).
 */

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class EnvironmentProvisioner {
  /**
   * @param {Object} config - Engine config (logsDir, etc.)
   * @param {Object} logger - Logger with info/warn/error/debug methods
   * @param {Object} toolRegistry - ToolRegistry instance for capability checks
   */
  constructor(config, logger, toolRegistry) {
    this.config = config || {};
    this.logger = logger || console;
    this.toolRegistry = toolRegistry;

    /** @type {Map<string, Object>} envId → environment state */
    this.environments = new Map();
  }

  // ── Provisioning ────────────────────────────────────────────────────────

  /**
   * Create an isolated execution environment from a requirements object.
   *
   * @param {Object} requirements
   * @param {string[]} requirements.tools - Tool/package specs (e.g. 'python>=3.11', 'numpy')
   * @param {string}  requirements.type  - 'local' | 'docker'
   * @param {number}  requirements.timeout_min - Max lifetime in minutes (default 30)
   * @param {string}  [requirements.baseImage] - Docker image (default 'python:3.11-slim')
   * @param {string}  [requirements.workingDir] - Override working directory
   * @returns {Promise<{envId: string, type: string, workingDir: string, ready: boolean, errors: string[]}>}
   */
  async provision(requirements) {
    const envId = crypto.randomBytes(4).toString('hex');
    const envType = requirements.type || 'local';
    const timeoutMin = requirements.timeout_min || 30;
    const errors = [];

    const env = {
      envId,
      type: envType,
      workingDir: null,
      containerId: null,
      containerName: null,
      createdAt: new Date().toISOString(),
      timeoutMin,
      packages: [],
      ready: false
    };

    try {
      if (envType === 'docker') {
        this._provisionDocker(env, requirements, errors);
      } else {
        this._provisionLocal(env, requirements, errors);
      }

      // Install requested packages
      const tools = Array.isArray(requirements.tools) ? requirements.tools : [];
      for (const spec of tools) {
        const result = await this._installTool(spec, env);
        if (result.installed) {
          env.packages.push(result.name);
        } else {
          errors.push(result.error);
        }
      }

      env.ready = errors.length === 0;
    } catch (err) {
      errors.push(`Provisioning failed: ${err.message}`);
      this.logger.error(`[EnvironmentProvisioner] Provision error for ${envId}:`, err.message);
    }

    this.environments.set(envId, env);
    this.logger.info(`[EnvironmentProvisioner] Provisioned env ${envId} (${envType}), ready=${env.ready}`);

    return {
      envId: env.envId,
      type: env.type,
      workingDir: env.workingDir,
      ready: env.ready,
      errors
    };
  }

  /**
   * Local provisioning: create a temp working directory.
   */
  _provisionLocal(env, requirements, errors) {
    let baseDir;
    if (requirements.workingDir) {
      baseDir = requirements.workingDir;
    } else if (this.config.logsDir) {
      baseDir = path.join(this.config.logsDir, 'environments');
    } else {
      baseDir = path.join(process.cwd(), 'runtime', 'environments');
    }

    const workDir = path.join(baseDir, `env-${env.envId}`);

    try {
      fs.mkdirSync(workDir, { recursive: true });
      env.workingDir = workDir;
    } catch (err) {
      errors.push(`Failed to create working directory: ${err.message}`);
    }
  }

  /**
   * Docker provisioning: start a detached container with a volume mount.
   */
  _provisionDocker(env, requirements, errors) {
    // Check Docker availability via registry
    const dockerAvailable = this.toolRegistry
      ? this.toolRegistry.isAvailable('tool:docker')
      : this._commandExists('docker');

    if (!dockerAvailable) {
      errors.push('Docker is not available on this system; falling back to local');
      env.type = 'local';
      this._provisionLocal(env, requirements, errors);
      return;
    }

    // Create host working directory for volume mount
    const baseDir = this.config.logsDir
      ? path.join(this.config.logsDir, 'environments')
      : path.join(process.cwd(), 'runtime', 'environments');
    const workDir = path.join(baseDir, `env-${env.envId}`);

    try {
      fs.mkdirSync(workDir, { recursive: true });
    } catch (err) {
      errors.push(`Failed to create host working directory: ${err.message}`);
      return;
    }

    env.workingDir = workDir;
    env.containerName = `cosmo-env-${env.envId}`;

    const image = requirements.baseImage || 'python:3.11-slim';
    const cmd = `docker run -d --name ${env.containerName} -v ${workDir}:/work -w /work ${image} sleep ${env.timeoutMin * 60}`;

    try {
      const containerId = execSync(cmd, { timeout: 60000, encoding: 'utf-8' }).trim();
      env.containerId = containerId;
      this.logger.info(`[EnvironmentProvisioner] Started container ${env.containerName} (${containerId.slice(0, 12)})`);
    } catch (err) {
      errors.push(`Docker container launch failed: ${err.message}`);
    }
  }

  // ── Deprovisioning ──────────────────────────────────────────────────────

  /**
   * Clean up an environment: remove temp directory and/or stop container.
   *
   * @param {string} envId
   * @returns {Promise<{removed: boolean, errors: string[]}>}
   */
  async deprovision(envId) {
    const env = this.environments.get(envId);
    if (!env) {
      return { removed: false, errors: [`Environment ${envId} not found`] };
    }

    const errors = [];

    // Stop and remove Docker container
    if (env.containerId || env.containerName) {
      try {
        execSync(`docker rm -f ${env.containerName}`, { timeout: 30000, encoding: 'utf-8' });
        this.logger.info(`[EnvironmentProvisioner] Removed container ${env.containerName}`);
      } catch (err) {
        errors.push(`Container removal failed: ${err.message}`);
      }
    }

    // Remove working directory
    if (env.workingDir && fs.existsSync(env.workingDir)) {
      try {
        fs.rmSync(env.workingDir, { recursive: true, force: true });
        this.logger.info(`[EnvironmentProvisioner] Removed working dir ${env.workingDir}`);
      } catch (err) {
        errors.push(`Directory removal failed: ${err.message}`);
      }
    }

    this.environments.delete(envId);
    return { removed: true, errors };
  }

  // ── Active Environments ────────────────────────────────────────────────

  /**
   * List all active (provisioned) environments.
   *
   * @returns {Array<{envId: string, type: string, workingDir: string, createdAt: string, packages: string[], ready: boolean}>}
   */
  getActive() {
    return Array.from(this.environments.values()).map(env => ({
      envId: env.envId,
      type: env.type,
      workingDir: env.workingDir,
      createdAt: env.createdAt,
      packages: env.packages,
      ready: env.ready,
      containerId: env.containerId || null
    }));
  }

  // ── Package Installation ───────────────────────────────────────────────

  /**
   * Install a pip or npm package into a provisioned environment.
   *
   * @param {string} pkg - Package spec (e.g. 'numpy', 'flask>=2.0')
   * @param {string} envId - Target environment ID
   * @returns {Promise<{installed: boolean, name: string, error: string|null}>}
   */
  async installPackage(pkg, envId) {
    const env = this.environments.get(envId);
    if (!env) {
      return { installed: false, name: pkg, error: `Environment ${envId} not found` };
    }

    const result = await this._installTool(pkg, env);
    if (result.installed) {
      env.packages.push(result.name);
    }
    return result;
  }

  /**
   * Internal: install a single tool/package spec.
   * Handles pip packages, npm packages, and binary checks.
   */
  async _installTool(spec, env) {
    const name = spec.replace(/[><=!].*/g, '').trim();

    // If it looks like a binary requirement (e.g. 'python>=3.11'), just verify it exists
    if (this._isBinarySpec(spec)) {
      return this._verifyBinary(name, env);
    }

    // Determine package manager from spec or default to pip
    const isNpm = spec.startsWith('npm:');
    const cleanSpec = isNpm ? spec.replace(/^npm:/, '') : spec;
    const cleanName = cleanSpec.replace(/[><=!].*/g, '').trim();

    if (isNpm) {
      return this._installNpmPackage(cleanSpec, cleanName, env);
    }
    return this._installPipPackage(cleanSpec, cleanName, env);
  }

  /**
   * Install a pip package into the environment.
   */
  _installPipPackage(spec, name, env) {
    const pipCmd = env.type === 'docker' && env.containerId
      ? `docker exec ${env.containerName} pip install ${spec}`
      : `pip3 install ${spec}`;

    try {
      execSync(pipCmd, { timeout: 120000, encoding: 'utf-8', cwd: env.workingDir || undefined });
      this.logger.info(`[EnvironmentProvisioner] Installed pip package: ${spec}`);
      return { installed: true, name, error: null };
    } catch (err) {
      const msg = `pip install ${spec} failed: ${err.message.split('\n')[0]}`;
      this.logger.warn(`[EnvironmentProvisioner] ${msg}`);
      return { installed: false, name, error: msg };
    }
  }

  /**
   * Install an npm package into the environment.
   */
  _installNpmPackage(spec, name, env) {
    const npmCmd = env.type === 'docker' && env.containerId
      ? `docker exec ${env.containerName} npm install ${spec}`
      : `npm install ${spec}`;

    try {
      execSync(npmCmd, { timeout: 120000, encoding: 'utf-8', cwd: env.workingDir || undefined });
      this.logger.info(`[EnvironmentProvisioner] Installed npm package: ${spec}`);
      return { installed: true, name, error: null };
    } catch (err) {
      const msg = `npm install ${spec} failed: ${err.message.split('\n')[0]}`;
      this.logger.warn(`[EnvironmentProvisioner] ${msg}`);
      return { installed: false, name, error: msg };
    }
  }

  /**
   * Check whether a binary requirement spec refers to a known binary.
   */
  _isBinarySpec(spec) {
    const knownBinaries = ['python', 'python3', 'node', 'docker', 'git', 'curl', 'bash', 'sh'];
    const name = spec.replace(/[><=!].*/g, '').trim().toLowerCase();
    return knownBinaries.includes(name);
  }

  /**
   * Verify a binary exists on the system (or in the container).
   */
  _verifyBinary(name, env) {
    const whichCmd = env.type === 'docker' && env.containerId
      ? `docker exec ${env.containerName} which ${name}`
      : `which ${name}`;

    try {
      execSync(whichCmd, { timeout: 10000, encoding: 'utf-8' });
      return { installed: true, name, error: null };
    } catch {
      return { installed: false, name, error: `Binary '${name}' not found` };
    }
  }

  // ── Verification ───────────────────────────────────────────────────────

  /**
   * Run smoke tests on an environment to verify it is functional.
   *
   * @param {string} envId
   * @returns {Promise<{passed: boolean, errors: string[]}>}
   */
  async verify(envId) {
    const env = this.environments.get(envId);
    if (!env) {
      return { passed: false, errors: [`Environment ${envId} not found`] };
    }

    const errors = [];

    // Check working directory exists
    if (!env.workingDir || !fs.existsSync(env.workingDir)) {
      errors.push('Working directory does not exist');
    }

    // For Docker environments, verify the container is running
    if (env.type === 'docker' && env.containerId) {
      try {
        const status = execSync(
          `docker inspect -f '{{.State.Running}}' ${env.containerName}`,
          { timeout: 10000, encoding: 'utf-8' }
        ).trim();
        if (status !== 'true') {
          errors.push(`Container is not running (state: ${status})`);
        }
      } catch (err) {
        errors.push(`Container inspection failed: ${err.message}`);
      }
    }

    // Verify installed packages are importable (Python)
    for (const pkg of env.packages) {
      if (this._isBinarySpec(pkg)) continue;
      const modName = pkg.toLowerCase().replace(/-/g, '_');
      const importCmd = env.type === 'docker' && env.containerId
        ? `docker exec ${env.containerName} python3 -c "import ${modName}"`
        : `python3 -c "import ${modName}"`;

      try {
        execSync(importCmd, { timeout: 15000, encoding: 'utf-8' });
      } catch {
        errors.push(`Package '${pkg}' failed import check`);
      }
    }

    const passed = errors.length === 0;
    this.logger.info(`[EnvironmentProvisioner] Verify env ${envId}: ${passed ? 'PASSED' : 'FAILED'} (${errors.length} errors)`);
    return { passed, errors };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  /**
   * Check if a command is available on the host system.
   */
  _commandExists(cmd) {
    try {
      execSync(`which ${cmd} 2>/dev/null`, { timeout: 5000, encoding: 'utf-8' });
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = { EnvironmentProvisioner };
