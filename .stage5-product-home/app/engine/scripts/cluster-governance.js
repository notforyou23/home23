#!/usr/bin/env node

/**
 * Cluster Governance CLI
 *
 * Operator tooling for Stage 4 governance overrides:
 *   - Inspect current override and health snapshot
 *   - Force skip / force proceed review cycles
 *   - Clear overrides and review recent governance events
 *
 * Usage examples:
 *   node scripts/cluster-governance.js status
 *   node scripts/cluster-governance.js events --limit 20
 *   node scripts/cluster-governance.js set force_skip --reason "maintenance window" --ttl 30
 *   node scripts/cluster-governance.js clear
 *
 * Options:
 *   --config <path>        Override path to config.yaml (default: src/config.yaml)
 *   --backend <type>       Force backend (filesystem|redis)
 *   --fs-root <path>       Filesystem backend root (default /tmp/cosmo_cluster)
 *   --redis-url <url>      Redis connection URL (default redis://localhost:6379)
 *   --instance <id>        Instance ID for CLI (default operator-cli)
 *   --limit <n>            Event limit for status/events (default 20)
 *   --verbose              Enable verbose logging
 */

const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');
const ClusterStateStore = require('../src/cluster/cluster-state-store');
const FilesystemStateStore = require('../src/cluster/backends/filesystem-state-store');
const RedisStateStore = require('../src/cluster/backends/redis-state-store');

function printUsage() {
  const usage = `
Cluster Governance CLI

Commands:
  status                     Show current override, snapshot, and recent events
  events [--limit N]         List recent governance events
  set <mode> [options]       Apply override (mode = force_skip | force_proceed)
      --reason <text>        Optional reason for override
      --ttl <minutes>        Override expires after N minutes
      --sticky               Keep override until cleared (do not auto-clear on use)
      --apply-once <bool>    Explicitly control clearing behaviour (default true)
      --requested-by <id>    Tag override with operator identity
  clear                      Remove any active override

Global options:
  --config <path>            Path to config.yaml (default src/config.yaml)
  --backend <type>           Backend type (filesystem | redis)
  --fs-root <path>           Filesystem root for cluster state
  --redis-url <url>          Redis connection URL
  --instance <id>            Instance ID used by CLI (default operator-cli)
  --limit <n>                Event limit (status/events, default 20)
  --verbose                  Enable verbose logging
`;
  console.log(usage.trim());
}

function parseArgs(argv) {
  const args = [...argv];
  const options = {};
  const positionals = [];

  while (args.length > 0) {
    const token = args.shift();
    if (token.startsWith('--')) {
      const [key, inlineValue] = token.slice(2).split('=');
      if (inlineValue !== undefined) {
        options[toCamelCase(key)] = inlineValue;
        continue;
      }

      const next = args[0];
      if (next && !next.startsWith('--')) {
        options[toCamelCase(key)] = args.shift();
      } else {
        options[toCamelCase(key)] = true;
      }
    } else {
      positionals.push(token);
    }
  }

  return { options, positionals };
}

function toCamelCase(flag) {
  return flag.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function loadYamlConfig(configPath, verboseLogger) {
  try {
    const content = fs.readFileSync(configPath, 'utf8');
    return yaml.load(content) || {};
  } catch (error) {
    if (error.code === 'ENOENT') {
      verboseLogger.warn(`Config file not found at ${configPath}, falling back to defaults.`);
      return {};
    }
    throw new Error(`Failed to load config from ${configPath}: ${error.message}`);
  }
}

function createLogger(verbose) {
  if (verbose) {
    return console;
  }

  return {
    info: () => {},
    debug: () => {},
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args)
  };
}

async function createStateStore(options, verboseLogger) {
  const configPath =
    options.config || path.join(__dirname, '..', 'src', 'config.yaml');

  const config = loadYamlConfig(configPath, verboseLogger);
  const clusterConfig = config.cluster || {};

  const backend =
    (options.backend || clusterConfig.backend || 'filesystem').toLowerCase();

  const instanceId = options.instance || 'operator-cli';
  const fsRoot =
    options.fsRoot ||
    options.fsroot ||
    clusterConfig.filesystem?.root ||
    '/tmp/cosmo_cluster';
  const redisUrl =
    options.redisUrl ||
    options.redisURL ||
    clusterConfig.redis?.url ||
    'redis://localhost:6379';
  const compressionThreshold =
    clusterConfig.stateStore?.compressionThreshold || 102400;
  const coordinator = clusterConfig.coordinator || {};

  const storeConfig = {
    instanceId,
    instanceCount: clusterConfig.instanceCount || 1,
    fsRoot,
    stateStore: {
      url: redisUrl,
      compressionThreshold
    },
    coordinator: {
      timeoutMs: coordinator.timeoutMs || 60000,
      barrierTtlMs: coordinator.barrierTtlMs || 600000
    }
  };

  let backendInstance;
  if (backend === 'redis') {
    backendInstance = new RedisStateStore(storeConfig, verboseLogger);
  } else if (backend === 'filesystem') {
    backendInstance = new FilesystemStateStore(storeConfig, verboseLogger);
  } else {
    throw new Error(`Unsupported backend "${backend}". Expected filesystem or redis.`);
  }

  const stateStore = new ClusterStateStore(storeConfig, backendInstance);
  await stateStore.connect();

  return { stateStore, backend };
}

function renderJson(data) {
  console.log(JSON.stringify(data, null, 2));
}

async function handleStatus(stateStore, options) {
  const limit = Number.isFinite(Number(options.limit))
    ? parseInt(options.limit, 10)
    : 20;

  const [override, snapshot, events] = await Promise.all([
    stateStore.getGovernanceOverride(),
    typeof stateStore.getGovernanceSnapshot === 'function'
      ? stateStore.getGovernanceSnapshot()
      : null,
    stateStore.getGovernanceEvents(limit)
  ]);

  renderJson({
    override,
    snapshot,
    events
  });
}

async function handleSet(stateStore, options, extras) {
  let mode = options.mode;
  if (!mode && extras.length > 0) {
    mode = extras.shift();
  }

  mode = typeof mode === 'string' ? mode.toLowerCase() : null;
  if (!mode || !['force_skip', 'force_proceed'].includes(mode)) {
    throw new Error('Override mode must be force_skip or force_proceed.');
  }

  const ttlMinutes = options.ttl || options.ttlMinutes;
  const ttlValue = ttlMinutes !== undefined ? Number(ttlMinutes) : null;
  if (ttlValue !== null && (!Number.isFinite(ttlValue) || ttlValue <= 0)) {
    throw new Error('TTL must be a positive number of minutes when provided.');
  }

  const override = {
    mode,
    reason: options.reason || null,
    requestedBy: options.requestedBy || 'operator-cli',
    requestedAt: new Date().toISOString(),
    applyOnce:
      options.sticky === true
        ? false
        : options.applyOnce !== undefined
        ? options.applyOnce === true || options.applyOnce === 'true'
        : true
  };

  if (ttlValue !== null) {
    override.expiresAt = new Date(Date.now() + ttlValue * 60000).toISOString();
  }

  await stateStore.setGovernanceOverride(override);
  await stateStore.appendGovernanceEvent({
    event: 'override_set',
    mode: override.mode,
    reason: override.reason || null,
    requestedBy: override.requestedBy,
    expiresAt: override.expiresAt || null
  });

  renderJson({ override });
}

async function handleClear(stateStore) {
  await stateStore.clearGovernanceOverride();
  await stateStore.appendGovernanceEvent({
    event: 'override_cleared',
    requestedBy: 'operator-cli'
  });
  renderJson({ cleared: true });
}

async function handleEvents(stateStore, options) {
  const limit = Number.isFinite(Number(options.limit))
    ? parseInt(options.limit, 10)
    : 50;
  const events = await stateStore.getGovernanceEvents(limit);
  renderJson({ events });
}

async function main() {
  const { options, positionals } = parseArgs(process.argv.slice(2));

  if (options.help || positionals.length === 0) {
    printUsage();
    return;
  }

  const command = positionals.shift().toLowerCase();
  const verboseLogger = createLogger(Boolean(options.verbose));

  const { stateStore } = await createStateStore(options, verboseLogger);

  try {
    if (command === 'status') {
      await handleStatus(stateStore, options);
    } else if (command === 'set') {
      await handleSet(stateStore, options, positionals);
    } else if (command === 'clear') {
      await handleClear(stateStore);
    } else if (command === 'events') {
      await handleEvents(stateStore, options);
    } else {
      throw new Error(`Unknown command "${command}".`);
    }
  } finally {
    if (typeof stateStore.disconnect === 'function') {
      await stateStore.disconnect();
    }
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
