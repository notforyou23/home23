'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

function pathError(code, message, details = {}) {
  const error = new Error(message || code);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function loadYaml(filePath, options = {}) {
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed = yaml.load(fs.readFileSync(filePath, 'utf8'));
    if (parsed === undefined || parsed === null) return {};
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      if (options.strict === true) {
        throw pathError('agent_config_invalid', 'agent config must be a YAML mapping', {
          configPath: filePath,
        });
      }
      return {};
    }
    return parsed;
  } catch (error) {
    if (options.strict === true) {
      if (error?.code === 'agent_config_invalid') throw error;
      throw pathError('agent_config_invalid', error?.message || 'agent config is invalid', {
        configPath: filePath,
        cause: error,
      });
    }
    return {};
  }
}

function normalizeHome23Root(home23Root) {
  if (typeof home23Root !== 'string' || !path.isAbsolute(home23Root)) {
    throw pathError('home23_root_invalid', 'absolute home23 root required');
  }
  return path.resolve(home23Root);
}

function assertAgentName(agentName) {
  if (typeof agentName !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(agentName)) {
    throw pathError('agent_name_invalid', 'safe agent name required');
  }
  return agentName;
}

function localInstanceRoot(home23Root, agentName) {
  return path.join(normalizeHome23Root(home23Root), 'instances', assertAgentName(agentName));
}

function localConfigPath(home23Root, agentName) {
  return path.join(localInstanceRoot(home23Root, agentName), 'config.yaml');
}

function configuredInstanceRoot(home23Root, agentName, config = null) {
  const fallback = localInstanceRoot(home23Root, agentName);
  const instanceConfig = config || loadYaml(localConfigPath(home23Root, agentName));
  const configured = instanceConfig?.system?.instanceRoot;
  if (configured === undefined || configured === null || String(configured).trim() === '') {
    return fallback;
  }
  if (typeof configured !== 'string' || !path.isAbsolute(configured)) {
    throw pathError(
      'instance_storage_config_invalid',
      'system.instanceRoot must be an absolute path',
      { agentName },
    );
  }
  return path.resolve(configured.trim());
}

function resolveAgentInstancePaths(home23Root, agentName, options = {}) {
  const root = normalizeHome23Root(home23Root);
  const name = assertAgentName(agentName);
  const configPath = localConfigPath(root, name);
  const hasConfig = fs.existsSync(configPath);
  if (options.requireConfig === true && !hasConfig) {
    throw pathError('agent_config_missing', `agent config is missing for ${name}`, { agentName: name, configPath });
  }
  const config = hasConfig ? loadYaml(configPath, { strict: options.requireConfig === true }) : {};
  const configuredRoot = configuredInstanceRoot(root, name, config);
  const localRoot = localInstanceRoot(root, name);
  const storageMode = configuredRoot === localRoot ? 'local' : 'external';
  return Object.freeze({
    agentName: name,
    config,
    configPath,
    configRoot: path.dirname(configPath),
    hasConfig,
    localInstanceRoot: localRoot,
    instanceRoot: configuredRoot,
    storageMode,
    brainDir: path.join(configuredRoot, 'brain'),
    workspaceDir: path.join(configuredRoot, 'workspace'),
    conversationsDir: path.join(configuredRoot, 'conversations'),
    logsDir: path.join(configuredRoot, 'logs'),
    runtimeDir: path.join(configuredRoot, 'runtime'),
    uploadsDir: path.join(configuredRoot, 'uploads'),
    cronJobsPath: path.join(configuredRoot, 'conversations', 'cron-jobs.json'),
    cronRunsDir: path.join(configuredRoot, 'cron-runs'),
  });
}

function discoverAgentInstancePaths(home23Root, options = {}) {
  const root = normalizeHome23Root(home23Root);
  const instancesDir = path.join(root, 'instances');
  if (!fs.existsSync(instancesDir)) return [];
  return fs.readdirSync(instancesDir)
    .filter((name) => {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return false;
      const instanceDir = path.join(instancesDir, name);
      if (!fs.existsSync(instanceDir)) return false;
      const stat = fs.lstatSync(instanceDir);
      return stat.isDirectory() && !stat.isSymbolicLink() && fs.existsSync(path.join(instanceDir, 'config.yaml'));
    })
    .map((name) => resolveAgentInstancePaths(root, name, options))
    .sort((left, right) => left.agentName.localeCompare(right.agentName));
}

function assertAgentInstanceStorageReady(paths, options = {}) {
  const resolved = paths && typeof paths === 'object' && !Array.isArray(paths)
    ? paths
    : resolveAgentInstancePaths(options.home23Root || process.cwd(), options.agentName || '');
  if (options.requireConfig !== false && !resolved.hasConfig) {
    throw pathError('agent_config_missing', `agent config is missing for ${resolved.agentName}`, {
      agentName: resolved.agentName,
      configPath: resolved.configPath,
    });
  }
  let stat;
  try {
    stat = fs.lstatSync(resolved.instanceRoot);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw pathError('instance_storage_unavailable', 'configured instance root is unavailable', {
        agentName: resolved.agentName,
        instanceRoot: resolved.instanceRoot,
      });
    }
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw pathError('instance_storage_not_canonical', 'configured instance root must be a nonsymlink directory', {
      agentName: resolved.agentName,
      instanceRoot: resolved.instanceRoot,
    });
  }
  const canonical = fs.realpathSync.native(resolved.instanceRoot);
  return Object.freeze({ ...resolved, canonicalRoot: canonical });
}

function loadAgentsManifest(home23Root) {
  const manifestPath = path.join(normalizeHome23Root(home23Root), 'config', 'agents.json');
  if (!fs.existsSync(manifestPath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function manifestEntryByAgent(home23Root, agentName) {
  const normalized = assertAgentName(agentName);
  return loadAgentsManifest(home23Root).find((entry) => entry?.name === normalized) || null;
}

module.exports = {
  assertAgentInstanceStorageReady,
  configuredInstanceRoot,
  discoverAgentInstancePaths,
  loadAgentsManifest,
  localConfigPath,
  localInstanceRoot,
  manifestEntryByAgent,
  normalizeHome23Root,
  resolveAgentInstancePaths,
};
