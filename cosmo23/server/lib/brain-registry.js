const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');
const yaml = require('js-yaml');

const gunzip = promisify(zlib.gunzip);
const MAX_STATE_SUMMARY_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_STATE_SUMMARY_OUTPUT_BYTES = 64 * 1024 * 1024;
const EMPTY_STATE_SUMMARY = Object.freeze({
  hasState: false,
  cycleCount: null,
  nodes: null,
  edges: null,
  hasStateSummary: false
});
const LOCAL_SOURCE_LABEL = 'Cosmo Home23';

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

async function resolveScannableRunPath(dirPath, entry) {
  const runPath = path.join(dirPath, entry.name);
  if (entry.isDirectory()) {
    return {
      runPath,
      identityPath: await fsp.realpath(runPath).catch(() => path.resolve(runPath))
    };
  }

  // HOME23 PATCH — Patch 7 stores agent-owned research runs in the agent
  // workspace and leaves cosmo23/runs/<name> as a symlink alias. Treat those
  // aliases as local run directories so the COSMO23 library can see them.
  if (entry.isSymbolicLink()) {
    try {
      const [stat, realPath] = await Promise.all([
        fsp.stat(runPath),
        fsp.realpath(runPath)
      ]);
      if (stat.isDirectory()) {
        return { runPath, identityPath: realPath };
      }
    } catch {
      return null;
    }
  }

  return null;
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
    const stat = await fsp.stat(candidate);
    if (stat.size > MAX_STATE_SUMMARY_INPUT_BYTES) {
      return {
        hasState: true,
        cycleCount: null,
        nodes: null,
        edges: null,
        hasStateSummary: false
      };
    }
    if (candidate.endsWith('.gz')) {
      const compressed = await fsp.readFile(candidate);
      const decompressed = await gunzip(compressed, { maxOutputLength: MAX_STATE_SUMMARY_OUTPUT_BYTES });
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
      cycleCount: null,
      nodes: null,
      edges: null,
      hasStateSummary: false
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
  const sourceLabel = options.sourceLabel || (sourceType === 'local' ? LOCAL_SOURCE_LABEL : 'Reference');

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
    instancesRoot = null,
    localRunsPath,
    referenceRunsPaths = [],
    activeRunPath = null,
    includeStateSummary = true,
    configuredAgentNames = [],
    includeUnavailableConfiguredResidents = false
  } = options;
  const brains = [];
  const seenPaths = new Set();
  const activeIdentityPath = activeRunPath
    ? await fsp.realpath(activeRunPath).catch(() => path.resolve(activeRunPath))
    : null;

  const inspectCandidate = async ({
    runPath,
    identityPath,
    sourceType,
    sourceLabel,
    retainUnavailable = false
  }) => {
    const key = path.resolve(identityPath);
    if (seenPaths.has(key)) {
      return;
    }
    seenPaths.add(key);

    try {
      const brain = await inspectBrain(runPath, { sourceType, sourceLabel, includeStateSummary });
      // HOME23 PATCH — ordinary picker calls still suppress empty directories.
      // The canonical catalog alone may retain an exact configured resident
      // brain root so a known-but-unavailable target remains distinguishable.
      if (!brain.hasState && !retainUnavailable) {
        return;
      }
      brain.isActive = activeIdentityPath === key;
      brains.push(brain);
    } catch {
      // Ignore malformed run directories and keep scanning.
    }
  };

  if (includeUnavailableConfiguredResidents && instancesRoot) {
    for (const agentName of configuredAgentNames) {
      const residentRoot = path.join(instancesRoot, agentName, 'brain');
      if (!(await pathExists(residentRoot))) {
        continue;
      }
      const identityPath = await fsp.realpath(residentRoot).catch(() => path.resolve(residentRoot));
      await inspectCandidate({
        runPath: residentRoot,
        identityPath,
        sourceType: 'home23-agent',
        sourceLabel: agentName,
        retainUnavailable: true
      });
    }
  }

  const scanDir = async (dirPath, sourceType, sourceLabel) => {
    if (!(await pathExists(dirPath))) {
      return;
    }

    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const scannable = await resolveScannableRunPath(dirPath, entry);
      if (!scannable) {
        continue;
      }

      const { runPath, identityPath } = scannable;
      await inspectCandidate({ runPath, identityPath, sourceType, sourceLabel });
    }
  };

  await scanDir(localRunsPath, 'local', LOCAL_SOURCE_LABEL);
  for (const referenceRunsPath of referenceRunsPaths) {
    await scanDir(referenceRunsPath, 'reference', deriveSourceLabel(referenceRunsPath));
  }

  brains.sort((left, right) => right.modified - left.modified);
  return brains;
}

// HOME23 PATCH 47 — canonical brain identity and fail-closed target catalog.
function catalogError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function hashCatalog(brains) {
  const identity = brains.map(({
    id, ownerAgent, kind, lifecycle, canonicalRoot, modifiedAt, mutationBoundaries
  }) => ({ id, ownerAgent, kind, lifecycle, canonicalRoot, modifiedAt, mutationBoundaries }));
  return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

const MUTATION_BOUNDARY_KINDS = Object.freeze([
  'brain', 'run', 'pgs', 'session', 'cache', 'export', 'agency'
]);

function assertAllowedCanonicalBoundary(boundary, allowedRoots) {
  if (!path.isAbsolute(boundary)) {
    throw catalogError('catalog_boundary_invalid');
  }
  const inside = allowedRoots.some(root => {
    const relative = path.relative(root, boundary);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  });
  if (!inside) {
    throw catalogError('catalog_boundary_invalid');
  }
}

async function resolvePotentialCanonicalPath(targetPath) {
  const absolutePath = path.resolve(targetPath);
  try {
    return await fsp.realpath(absolutePath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw catalogError('catalog_boundary_invalid');
    }
  }

  const missingSegments = [];
  let candidate = absolutePath;
  while (true) {
    try {
      await fsp.lstat(candidate);
      try {
        const canonicalAncestor = await fsp.realpath(candidate);
        return path.resolve(canonicalAncestor, ...missingSegments);
      } catch {
        // lstat succeeded but realpath did not: this is a dangling link or
        // another unresolvable existing inode, never a safe missing subtree.
        throw catalogError('catalog_boundary_invalid');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      const parent = path.dirname(candidate);
      if (parent === candidate) {
        throw catalogError('catalog_boundary_invalid');
      }
      missingSegments.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}

async function buildMutationBoundaries({ canonicalRoot, mutationRoot, allowedCanonicalRoots }) {
  assertAllowedCanonicalBoundary(canonicalRoot, allowedCanonicalRoots);
  assertAllowedCanonicalBoundary(mutationRoot, allowedCanonicalRoots);
  const entryRoots = [...new Set([canonicalRoot, mutationRoot])];
  const candidates = [
    { kind: 'brain', path: canonicalRoot },
    { kind: 'run', path: mutationRoot },
    { kind: 'pgs', path: path.join(canonicalRoot, 'pgs-sessions') },
    { kind: 'session', path: path.join(canonicalRoot, 'sessions') },
    { kind: 'cache', path: path.join(canonicalRoot, 'cache') },
    { kind: 'export', path: path.join(canonicalRoot, 'exports') },
    { kind: 'agency', path: path.join(canonicalRoot, 'agency') }
  ];
  const seenKinds = new Set();
  const boundaries = [];
  for (const boundary of candidates) {
    const canonicalPath = await resolvePotentialCanonicalPath(boundary.path);
    if (!MUTATION_BOUNDARY_KINDS.includes(boundary.kind) || seenKinds.has(boundary.kind)) {
      throw catalogError('catalog_boundary_invalid');
    }
    seenKinds.add(boundary.kind);
    assertAllowedCanonicalBoundary(canonicalPath, entryRoots);
    boundaries.push(Object.freeze({ kind: boundary.kind, path: canonicalPath }));
  }
  if (seenKinds.size !== MUTATION_BOUNDARY_KINDS.length) {
    throw catalogError('catalog_boundary_invalid');
  }
  return Object.freeze(boundaries);
}

async function readCanonicalRunLifecycle(canonicalRoot, activeRunPath) {
  if (activeRunPath) {
    const activeRoot = await fsp.realpath(activeRunPath).catch(() => path.resolve(activeRunPath));
    if (activeRoot === canonicalRoot) {
      return { lifecycle: 'active', ownerAgent: null };
    }
  }
  const [plan, run] = await Promise.all([
    loadJsonIfPresent(path.join(canonicalRoot, 'plans', 'plan:main.json')),
    loadJsonIfPresent(path.join(canonicalRoot, 'run.json'))
  ]);
  const completed = plan?.status === 'COMPLETED'
    && typeof plan.completedAt === 'number'
    && Number.isFinite(plan.completedAt);
  return {
    lifecycle: completed ? 'completed' : 'unavailable',
    ownerAgent: typeof run?.owner === 'string' && run.owner.trim() ? run.owner.trim() : null
  };
}

async function toCanonicalEntry(brain, canonicalRoot, options) {
  const relative = path.relative(options.instancesRoot, canonicalRoot).split(path.sep);
  const resident = relative.length === 2
    && relative[1] === 'brain'
    && !relative[0].startsWith('..')
    && options.configuredAgentNames.includes(relative[0]);
  const runLifecycle = resident
    ? { lifecycle: brain.hasState === false ? 'unavailable' : 'resident', ownerAgent: relative[0] }
    : await readCanonicalRunLifecycle(canonicalRoot, options.activeRunPath);
  const id = `brain-${crypto.createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 16)}`;
  const mutationBoundaries = await buildMutationBoundaries({
    canonicalRoot,
    mutationRoot: canonicalRoot,
    allowedCanonicalRoots: options.allowedCanonicalRoots
  });
  return Object.freeze({
    id,
    displayName: brain.displayName || brain.name || path.basename(canonicalRoot),
    ownerAgent: runLifecycle.ownerAgent,
    kind: resident ? 'resident' : 'research',
    lifecycle: runLifecycle.lifecycle,
    canonicalRoot,
    sourceType: brain.sourceType || (resident ? 'home23-agent' : 'research-run'),
    nodeCount: Number.isFinite(brain.nodes) ? brain.nodes : null,
    modifiedAt: new Date(brain.modifiedDate || brain.metadata?.modifiedAt || 0).toISOString(),
    route: `/api/brain/${encodeURIComponent(id)}`,
    mutationBoundaries,
    routeKey: brain.routeKey,
    name: brain.name,
    path: brain.path,
    sourceLabel: brain.sourceLabel,
    isReference: brain.isReference,
    modified: brain.modified,
    cycleCount: brain.cycleCount,
    cycles: brain.cycles,
    nodes: brain.nodes,
    edges: brain.edges,
    hasState: brain.hasState,
    hasStateSummary: brain.hasStateSummary,
    hasMetadata: brain.hasMetadata,
    isActive: brain.isActive === true,
    mode: brain.mode,
    topic: brain.topic,
    domain: brain.domain,
    context: brain.context,
    metadata: brain.metadata
  });
}

async function buildCanonicalCatalog(options = {}) {
  if (typeof options.instancesRoot !== 'string' || !options.instancesRoot
      || typeof options.localRunsPath !== 'string' || !options.localRunsPath
      || !Array.isArray(options.referenceRunsPaths)
      || !Array.isArray(options.configuredAgentNames)) {
    throw catalogError('catalog_configuration_invalid');
  }
  const configuredAgentNames = [...options.configuredAgentNames];
  if (new Set(configuredAgentNames).size !== configuredAgentNames.length
      || configuredAgentNames.some(name =>
        typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(name))) {
    throw catalogError('catalog_configuration_invalid');
  }
  if (options.referenceRunsPaths.some(root => typeof root !== 'string' || !root)) {
    throw catalogError('catalog_configuration_invalid');
  }

  const configuredRoots = [options.instancesRoot, options.localRunsPath, ...options.referenceRunsPaths];
  const allowedCanonicalRoots = await Promise.all(configuredRoots.map(root =>
    fsp.realpath(root).catch(() => path.resolve(root))));
  const instancesRoot = allowedCanonicalRoots[0];
  const inspected = await listBrains({
    ...options,
    instancesRoot,
    configuredAgentNames,
    includeStateSummary: true,
    includeUnavailableConfiguredResidents: true
  });
  const byRoot = new Map();
  for (const brain of inspected) {
    const canonicalRoot = await fsp.realpath(brain.path).catch(() => path.resolve(brain.path));
    const residentParts = path.relative(instancesRoot, canonicalRoot).split(path.sep);
    const exactResidentRoot = residentParts.length === 2
      && residentParts[1] === 'brain'
      && !residentParts[0].startsWith('..');
    if (exactResidentRoot && !configuredAgentNames.includes(residentParts[0])) {
      continue;
    }
    const entry = await toCanonicalEntry(brain, canonicalRoot, {
      ...options,
      instancesRoot,
      configuredAgentNames,
      allowedCanonicalRoots
    });
    const prior = byRoot.get(canonicalRoot);
    if (!prior || entry.lifecycle === 'resident') {
      byRoot.set(canonicalRoot, entry);
    }
  }
  const brains = [...byRoot.values()].sort((left, right) => left.id.localeCompare(right.id));
  return Object.freeze({ catalogRevision: hashCatalog(brains), brains: Object.freeze(brains) });
}

function resolveCanonicalTarget(catalog, callerAgent, selector = {}) {
  if (!catalog || !Array.isArray(catalog.brains)) {
    throw catalogError('catalog_unavailable');
  }
  if (typeof callerAgent !== 'string' || !callerAgent.trim()) {
    throw catalogError('invalid_request');
  }
  if (!selector || Array.isArray(selector) || typeof selector !== 'object') {
    throw catalogError('invalid_request');
  }
  const keys = Object.keys(selector);
  if (keys.some(key => key !== 'agent' && key !== 'brainId')) {
    throw catalogError('invalid_request');
  }
  if (selector.agent !== undefined
      && (typeof selector.agent !== 'string' || !selector.agent.trim())) {
    throw catalogError('invalid_request');
  }
  if (selector.brainId !== undefined
      && (typeof selector.brainId !== 'string' || !selector.brainId.trim())) {
    throw catalogError('invalid_request');
  }
  const eligibleLifecycle = brain => brain.lifecycle === 'resident' || brain.lifecycle === 'completed';
  const resolveUnique = matches => {
    if (matches.length > 1) throw catalogError('target_ambiguous');
    if (matches.length === 0) throw catalogError('target_not_found');
    if (!eligibleLifecycle(matches[0])) throw catalogError('target_not_available');
    return matches[0];
  };
  const byAgent = selector.agent
    ? resolveUnique(catalog.brains.filter(brain =>
      brain.ownerAgent === selector.agent && brain.kind === 'resident'))
    : null;
  const byId = selector.brainId
    ? resolveUnique(catalog.brains.filter(brain => brain.id === selector.brainId))
    : null;
  if (byAgent && byId && byAgent.id !== byId.id) {
    throw catalogError('target_mismatch');
  }
  if (byId || byAgent) {
    return byId || byAgent;
  }
  return resolveUnique(catalog.brains.filter(brain =>
    brain.ownerAgent === callerAgent && brain.kind === 'resident'));
}

function resolveCanonicalCatalogAlias(catalog, selector) {
  if (!catalog || !Array.isArray(catalog.brains)) {
    return null;
  }
  const normalized = String(selector || '').trim();
  for (const field of ['id', 'routeKey', 'name']) {
    const matches = catalog.brains.filter(brain => brain[field] === normalized);
    if (matches.length > 1) {
      throw catalogError('target_ambiguous');
    }
    if (matches.length === 1) {
      return matches[0];
    }
  }
  return null;
}

async function resolveBrainBySelector(selector, options) {
  const normalized = String(selector || '').trim();
  const canonicalMatch = resolveCanonicalCatalogAlias(options.canonicalCatalog, normalized);
  if (canonicalMatch) {
    return inspectBrain(canonicalMatch.canonicalRoot, {
      sourceType: canonicalMatch.sourceType,
      sourceLabel: canonicalMatch.displayName,
      includeStateSummary: true
    });
  }
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

  return inspectBrain(importedPath, { sourceType: 'local', sourceLabel: LOCAL_SOURCE_LABEL });
}

module.exports = {
  sanitizeRunName,
  parseReferenceRunsPaths,
  inspectBrain,
  listBrains,
  buildCanonicalCatalog,
  resolveCanonicalTarget,
  resolveCanonicalCatalogAlias,
  MUTATION_BOUNDARY_KINDS,
  resolveBrainBySelector,
  importReferenceBrain,
  ensureUniqueRunName
};
