const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');
const yaml = require('js-yaml');

const gunzip = promisify(zlib.gunzip);
const EMPTY_STATE_SUMMARY = Object.freeze({
  hasState: false,
  cycleCount: null,
  nodes: null,
  edges: null,
  hasStateSummary: false
});

function sanitizeRunName(input) {
  const normalized = String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || `brain-${Date.now()}`;
}

function buildBrainId(brainPath) {
  return crypto.createHash('sha1').update(path.resolve(brainPath)).digest('hex').slice(0, 16);
}

function buildDisplayName(runPath, sourceLabel) {
  const name = path.basename(runPath);
  const genericNames = new Set(['brain', 'runtime', 'default']);
  if (!genericNames.has(String(name || '').toLowerCase())) {
    return name;
  }

  const parentName = path.basename(path.dirname(runPath));
  const preferredPrefix = sourceLabel || parentName || name;
  if (String(preferredPrefix || '').toLowerCase() === String(name || '').toLowerCase()) {
    return name;
  }

  return `${preferredPrefix} Brain`;
}

async function pathExists(targetPath) {
  try {
    await fsp.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function loadJsonIfPresent(filePath) {
  if (!(await pathExists(filePath))) {
    return null;
  }

  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function loadYamlIfPresent(filePath) {
  if (!(await pathExists(filePath))) {
    return null;
  }

  try {
    return yaml.load(await fsp.readFile(filePath, 'utf8')) || null;
  } catch {
    return null;
  }
}

async function findStateFile(runPath) {
  const candidates = [
    path.join(runPath, 'state.json.gz'),
    path.join(runPath, 'coordinator', 'state.json.gz'),
    path.join(runPath, 'state.json'),
    path.join(runPath, 'coordinator', 'state.json')
  ];

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function loadStateSummary(runPath, stateFile = null) {
  const candidate = stateFile || await findStateFile(runPath);
  if (!candidate) {
    return { ...EMPTY_STATE_SUMMARY };
  }

  try {
    let state;
    if (candidate.endsWith('.gz')) {
      const compressed = await fsp.readFile(candidate);
      const decompressed = await gunzip(compressed);
      state = JSON.parse(decompressed.toString());
    } else {
      state = JSON.parse(await fsp.readFile(candidate, 'utf8'));
    }

    return {
      hasState: true,
      cycleCount: state.cycleCount || 0,
      nodes: state.memory?.nodes?.length || 0,
      edges: state.memory?.edges?.length || 0,
      hasStateSummary: true
    };
  } catch {
    return {
      hasState: true,
      cycleCount: 0,
      nodes: 0,
      edges: 0,
      hasStateSummary: true
    };
  }
}

async function loadMetadata(runPath) {
  const metadataCandidates = [
    path.join(runPath, 'run-metadata.json'),
    path.join(runPath, 'metadata.json'),
    path.join(runPath, 'coordinator', 'run-metadata.json'),
    path.join(runPath, 'metadata', 'run-metadata.json')
  ];

  for (const candidate of metadataCandidates) {
    const metadata = await loadJsonIfPresent(candidate);
    if (metadata) {
      return metadata;
    }
  }

  const configCandidates = [
    path.join(runPath, 'config.yaml'),
    path.join(runPath, 'coordinator', 'config.yaml')
  ];

  for (const candidate of configCandidates) {
    const config = await loadYamlIfPresent(candidate);
    if (!config || typeof config !== 'object') {
      continue;
    }

    return {
      topic: config.topic || config.domain || config.architecture?.roleSystem?.guidedFocus?.domain || '',
      domain: config.domain || config.architecture?.roleSystem?.guidedFocus?.domain || '',
      context: config.context || config.architecture?.roleSystem?.guidedFocus?.context || '',
      explorationMode: config.exploration_mode || config.explorationMode || config.architecture?.roleSystem?.explorationMode || 'guided',
      depth: config.depth || config.architecture?.roleSystem?.guidedFocus?.depth || '',
      maxCycles: config.max_cycles || config.maxCycles || config.execution?.maxCycles || 0
    };
  }

  return {};
}

async function inspectBrain(runPath, options = {}) {
  const stateFile = await findStateFile(runPath);
  const includeStateSummary = options.includeStateSummary !== false;
  const [stat, metadata, summary] = await Promise.all([
    fsp.stat(runPath),
    loadMetadata(runPath),
    includeStateSummary
      ? loadStateSummary(runPath, stateFile)
      : Promise.resolve({
          hasState: !!stateFile,
          cycleCount: null,
          nodes: null,
          edges: null,
          hasStateSummary: false
        })
  ]);
  const name = path.basename(runPath);
  const sourceType = options.sourceType || 'local';
  const sourceLabel = options.sourceLabel || (sourceType === 'local' ? 'Local' : 'Reference');

  return {
    id: buildBrainId(runPath),
    routeKey: buildBrainId(runPath),
    name,
    displayName: buildDisplayName(runPath, sourceLabel),
    path: runPath,
    sourceType,
    sourceLabel,
    isReference: sourceType !== 'local',
    modified: stat.mtime.getTime(),
    modifiedDate: stat.mtime.toISOString(),
    cycleCount: summary.cycleCount,
    cycles: summary.cycleCount,
    nodes: summary.nodes,
    edges: summary.edges,
    hasState: summary.hasState,
    hasStateSummary: summary.hasStateSummary,
    hasMetadata: Object.keys(metadata || {}).length > 0,
    mode: metadata.explorationMode || metadata.mode || 'guided',
    topic: metadata.topic || metadata.domain || '',
    domain: metadata.domain || metadata.topic || '',
    context: metadata.context || '',
    metadata
  };
}

function parseReferenceRunsPaths(rawPaths, rootDir, localRunsPath) {
  const configured = (rawPaths || '')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);

  const defaults = [
    path.resolve(rootDir, '../Cosmo_Unified_dev/runs'),
    path.resolve(rootDir, '../COSMO/runs')
  ];

  return [...new Set([...(configured.length ? configured : defaults)])]
    .filter(candidate => candidate && path.resolve(candidate) !== path.resolve(localRunsPath))
    .filter(candidate => fs.existsSync(candidate));
}

function deriveSourceLabel(dirPath) {
  const resolved = path.resolve(dirPath);
  const parts = resolved.split(path.sep).filter(Boolean);

  // Try to find a meaningful segment: skip 'runs', 'data', 'users', UUIDs
  const boring = new Set(['runs', 'data', 'users', 'volumes', 'home', '_jtr23_']);
  const isUuid = s => /^[a-z0-9]{20,}$/i.test(s);

  for (let i = parts.length - 1; i >= 0; i--) {
    const seg = parts[i];
    if (boring.has(seg.toLowerCase()) || isUuid(seg)) continue;
    // Found a meaningful segment
    const label = seg
      .replace(/^_+|_+$/g, '')
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
    if (label.length >= 2) return label;
  }

  return path.basename(path.dirname(resolved)) || 'Reference';
}

async function listBrains(options) {
  const {
    localRunsPath,
    referenceRunsPaths = [],
    activeRunPath = null,
    includeStateSummary = true
  } = options;
  const brains = [];
  const seenPaths = new Set();

  const scanDir = async (dirPath, sourceType, sourceLabel) => {
    if (!(await pathExists(dirPath))) {
      return;
    }

    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const runPath = path.join(dirPath, entry.name);
      const key = path.resolve(runPath);
      if (seenPaths.has(key)) {
        continue;
      }
      seenPaths.add(key);

      try {
        const brain = await inspectBrain(runPath, { sourceType, sourceLabel, includeStateSummary });
        // HOME23 PATCH — skip directories that don't hold a state file.
        // When home23 agent roots (instances/<agent>) are passed as reference
        // paths, their siblings (workspace/, conversations/, logs/, etc.) would
        // otherwise surface as empty "brains" next to the real brain/ dir.
        if (!brain.hasState) {
          continue;
        }
        brain.isActive = activeRunPath ? path.resolve(activeRunPath) === key : false;
        brains.push(brain);
      } catch {
        // Ignore malformed run directories and keep scanning.
      }
    }
  };

  await scanDir(localRunsPath, 'local', 'Local');
  for (const referenceRunsPath of referenceRunsPaths) {
    await scanDir(referenceRunsPath, 'reference', deriveSourceLabel(referenceRunsPath));
  }

  brains.sort((left, right) => right.modified - left.modified);
  return brains;
}

async function resolveBrainBySelector(selector, options) {
  const normalized = String(selector || '').trim();
  const brains = await listBrains({
    ...options,
    includeStateSummary: false
  });
  const match = brains.find(brain =>
    brain.id === normalized ||
    brain.routeKey === normalized ||
    brain.name === normalized
  );

  if (!match) {
    return null;
  }

  return inspectBrain(match.path, {
    sourceType: match.sourceType,
    sourceLabel: match.sourceLabel,
    includeStateSummary: true
  });
}

async function copyDirectory(sourcePath, targetPath) {
  if (typeof fsp.cp === 'function') {
    await fsp.cp(sourcePath, targetPath, { recursive: true });
    return;
  }

  await fsp.mkdir(targetPath, { recursive: true });
  const entries = await fsp.readdir(sourcePath, { withFileTypes: true });
  for (const entry of entries) {
    const sourceEntry = path.join(sourcePath, entry.name);
    const targetEntry = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(sourceEntry, targetEntry);
    } else {
      await fsp.copyFile(sourceEntry, targetEntry);
    }
  }
}

async function ensureUniqueRunName(baseName, localRunsPath) {
  const seed = sanitizeRunName(baseName);
  let candidate = seed;
  let index = 1;

  while (await pathExists(path.join(localRunsPath, candidate))) {
    index += 1;
    candidate = `${seed}-${index}`;
  }

  return candidate;
}

async function importReferenceBrain(brain, localRunsPath) {
  if (!brain || brain.sourceType === 'local') {
    return brain;
  }

  const importedName = await ensureUniqueRunName(`${brain.name}-import`, localRunsPath);
  const importedPath = path.join(localRunsPath, importedName);

  await copyDirectory(brain.path, importedPath);
  await fsp.writeFile(
    path.join(importedPath, 'reference-origin.json'),
    JSON.stringify({
      sourcePath: brain.path,
      sourceLabel: brain.sourceLabel,
      importedAt: new Date().toISOString()
    }, null, 2),
    'utf8'
  );

  return inspectBrain(importedPath, { sourceType: 'local', sourceLabel: 'Local' });
}

module.exports = {
  sanitizeRunName,
  parseReferenceRunsPaths,
  listBrains,
  resolveBrainBySelector,
  importReferenceBrain,
  ensureUniqueRunName
};
