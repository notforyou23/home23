const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { normalizeExecutionMode } = require('../../lib/execution-mode');

const SNAPSHOT_DIRNAME = 'continuation-snapshots';
const INITIAL_SNAPSHOT_FILENAME = 'initial-launch.json';

const DEFAULT_UI_SETTINGS = Object.freeze({
  topic: '',
  context: '',
  runName: '',
  explorationMode: 'guided',
  executionMode: 'guided-exclusive',
  analysisDepth: 'normal',
  cycles: 80,
  maxRuntimeMinutes: 0,
  reviewPeriod: 20,
  maxConcurrent: 4,
  enableWebSearch: true,
  enableSleep: true,
  enableCodingAgents: true,
  enableIntrospection: true,
  enableAgentRouting: true,
  enableRecursiveMode: true,
  enableMemoryGovernance: true,
  enableFrontier: true,
  enableIDEFirst: true,
  enableDirectAction: false,
  enableStabilization: false,
  enableConsolidationMode: false,
  enableExperimental: false,
  primaryProvider: '',
  primaryModel: '',
  fastProvider: '',
  fastModel: '',
  strategicProvider: '',
  strategicModel: '',
  localLlmBaseUrl: 'http://localhost:11434/v1'
});

const UI_SETTING_FIELDS = Object.freeze(Object.keys(DEFAULT_UI_SETTINGS));

async function pathExists(targetPath) {
  try {
    await fsp.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfExists(filePath) {
  if (!(await pathExists(filePath))) {
    return null;
  }

  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function normalizeBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['false', '0', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function normalizeInteger(value, fallback, minimum = 0) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return Math.max(minimum, parsed);
}

function normalizeExecutionModeForUi(explorationMode, ...candidates) {
  const executionInfo = normalizeExecutionMode(explorationMode, firstNonEmpty(...candidates));
  return executionInfo.effectiveMode;
}

function normalizeUiSettings(input = {}) {
  const explorationMode = firstNonEmpty(input.explorationMode, DEFAULT_UI_SETTINGS.explorationMode) || 'guided';

  return {
    topic: String(input.topic ?? DEFAULT_UI_SETTINGS.topic),
    context: String(input.context ?? DEFAULT_UI_SETTINGS.context),
    runName: String(input.runName ?? DEFAULT_UI_SETTINGS.runName),
    explorationMode,
    executionMode: normalizeExecutionModeForUi(
      explorationMode,
      input.executionMode,
      DEFAULT_UI_SETTINGS.executionMode
    ),
    analysisDepth: firstNonEmpty(input.analysisDepth, DEFAULT_UI_SETTINGS.analysisDepth) || 'normal',
    cycles: normalizeInteger(input.cycles, DEFAULT_UI_SETTINGS.cycles, 1),
    maxRuntimeMinutes: normalizeInteger(input.maxRuntimeMinutes, DEFAULT_UI_SETTINGS.maxRuntimeMinutes, 0),
    reviewPeriod: normalizeInteger(input.reviewPeriod, DEFAULT_UI_SETTINGS.reviewPeriod, 1),
    maxConcurrent: normalizeInteger(input.maxConcurrent, DEFAULT_UI_SETTINGS.maxConcurrent, 1),
    enableWebSearch: normalizeBoolean(input.enableWebSearch, DEFAULT_UI_SETTINGS.enableWebSearch),
    enableSleep: normalizeBoolean(input.enableSleep, DEFAULT_UI_SETTINGS.enableSleep),
    enableCodingAgents: normalizeBoolean(input.enableCodingAgents, DEFAULT_UI_SETTINGS.enableCodingAgents),
    enableIntrospection: normalizeBoolean(input.enableIntrospection, DEFAULT_UI_SETTINGS.enableIntrospection),
    enableAgentRouting: normalizeBoolean(input.enableAgentRouting, DEFAULT_UI_SETTINGS.enableAgentRouting),
    enableRecursiveMode: normalizeBoolean(input.enableRecursiveMode, DEFAULT_UI_SETTINGS.enableRecursiveMode),
    enableMemoryGovernance: normalizeBoolean(input.enableMemoryGovernance, DEFAULT_UI_SETTINGS.enableMemoryGovernance),
    enableFrontier: normalizeBoolean(input.enableFrontier, DEFAULT_UI_SETTINGS.enableFrontier),
    enableIDEFirst: normalizeBoolean(input.enableIDEFirst, DEFAULT_UI_SETTINGS.enableIDEFirst),
    enableDirectAction: normalizeBoolean(input.enableDirectAction, DEFAULT_UI_SETTINGS.enableDirectAction),
    enableStabilization: normalizeBoolean(input.enableStabilization, DEFAULT_UI_SETTINGS.enableStabilization),
    enableConsolidationMode: normalizeBoolean(input.enableConsolidationMode, DEFAULT_UI_SETTINGS.enableConsolidationMode),
    enableExperimental: normalizeBoolean(input.enableExperimental, DEFAULT_UI_SETTINGS.enableExperimental),
    primaryProvider: String(input.primaryProvider ?? DEFAULT_UI_SETTINGS.primaryProvider),
    primaryModel: String(input.primaryModel ?? DEFAULT_UI_SETTINGS.primaryModel),
    fastProvider: String(input.fastProvider ?? DEFAULT_UI_SETTINGS.fastProvider),
    fastModel: String(input.fastModel ?? DEFAULT_UI_SETTINGS.fastModel),
    strategicProvider: String(input.strategicProvider ?? DEFAULT_UI_SETTINGS.strategicProvider),
    strategicModel: String(input.strategicModel ?? DEFAULT_UI_SETTINGS.strategicModel),
    localLlmBaseUrl: String(input.localLlmBaseUrl ?? DEFAULT_UI_SETTINGS.localLlmBaseUrl)
  };
}

function normalizeBrainMetadataToSettings({ brain = null, runtimeMetadata = null, webMetadata = null } = {}) {
  const explorationMode = firstNonEmpty(
    webMetadata?.explorationMode,
    runtimeMetadata?.explorationMode,
    brain?.mode,
    DEFAULT_UI_SETTINGS.explorationMode
  ) || 'guided';

  const topic = firstNonEmpty(
    webMetadata?.topic,
    webMetadata?.domain,
    webMetadata?.researchDomain,
    runtimeMetadata?.topic,
    runtimeMetadata?.domain,
    runtimeMetadata?.researchDomain,
    runtimeMetadata?.currentPlanDomain,
    brain?.topic,
    brain?.domain
  );

  const context = firstNonEmpty(
    webMetadata?.context,
    webMetadata?.researchContext,
    runtimeMetadata?.context,
    runtimeMetadata?.researchContext,
    runtimeMetadata?.currentPlanContext,
    brain?.context
  );

  return normalizeUiSettings({
    topic,
    context,
    runName: firstNonEmpty(webMetadata?.runName, brain?.name, brain?.displayName),
    explorationMode,
    executionMode: normalizeExecutionModeForUi(
      explorationMode,
      runtimeMetadata?.effectiveExecutionMode,
      webMetadata?.effectiveExecutionMode,
      runtimeMetadata?.requestedExecutionMode,
      webMetadata?.requestedExecutionMode,
      webMetadata?.executionMode,
      runtimeMetadata?.executionMode
    ),
    analysisDepth: firstNonEmpty(webMetadata?.analysisDepth, runtimeMetadata?.depth, webMetadata?.depth),
    cycles: firstDefined(webMetadata?.cycles, runtimeMetadata?.maxCycles),
    maxRuntimeMinutes: firstDefined(webMetadata?.maxRuntimeMinutes, runtimeMetadata?.maxRuntimeMinutes),
    reviewPeriod: firstDefined(webMetadata?.reviewPeriod, runtimeMetadata?.reviewPeriod),
    maxConcurrent: firstDefined(webMetadata?.maxConcurrent, runtimeMetadata?.maxConcurrent),
    enableWebSearch: firstDefined(webMetadata?.enableWebSearch, runtimeMetadata?.enableWebSearch),
    enableSleep: firstDefined(webMetadata?.enableSleep, runtimeMetadata?.enableSleep),
    enableCodingAgents: firstDefined(webMetadata?.enableCodingAgents, runtimeMetadata?.enableCodingAgents),
    enableIntrospection: firstDefined(webMetadata?.enableIntrospection, runtimeMetadata?.enableIntrospection),
    enableAgentRouting: firstDefined(webMetadata?.enableAgentRouting, runtimeMetadata?.enableAgentRouting),
    enableRecursiveMode: firstDefined(webMetadata?.enableRecursiveMode, runtimeMetadata?.enableRecursiveMode),
    enableMemoryGovernance: firstDefined(webMetadata?.enableMemoryGovernance, runtimeMetadata?.enableMemoryGovernance),
    enableFrontier: firstDefined(webMetadata?.enableFrontier, runtimeMetadata?.enableFrontier),
    enableIDEFirst: firstDefined(webMetadata?.enableIDEFirst, runtimeMetadata?.enableIDEFirst),
    enableDirectAction: firstDefined(webMetadata?.enableDirectAction, runtimeMetadata?.enableDirectAction),
    enableStabilization: firstDefined(webMetadata?.enableStabilization, runtimeMetadata?.enableStabilization),
    enableConsolidationMode: firstDefined(webMetadata?.enableConsolidationMode, runtimeMetadata?.enableConsolidationMode),
    enableExperimental: firstDefined(webMetadata?.enableExperimental, runtimeMetadata?.enableExperimental),
    primaryProvider: firstNonEmpty(webMetadata?.primaryProvider, runtimeMetadata?.primaryProvider),
    primaryModel: firstNonEmpty(webMetadata?.primaryModel, runtimeMetadata?.primaryModel),
    fastProvider: firstNonEmpty(webMetadata?.fastProvider, runtimeMetadata?.fastProvider),
    fastModel: firstNonEmpty(webMetadata?.fastModel, runtimeMetadata?.fastModel),
    strategicProvider: firstNonEmpty(webMetadata?.strategicProvider, runtimeMetadata?.strategicProvider),
    strategicModel: firstNonEmpty(webMetadata?.strategicModel, runtimeMetadata?.strategicModel),
    localLlmBaseUrl: firstNonEmpty(webMetadata?.localLlmBaseUrl, runtimeMetadata?.localLlmBaseUrl, DEFAULT_UI_SETTINGS.localLlmBaseUrl)
  });
}

function getSnapshotsDir(runPath) {
  return path.join(runPath, SNAPSHOT_DIRNAME);
}

function getInitialSnapshotPath(runPath) {
  return path.join(getSnapshotsDir(runPath), INITIAL_SNAPSHOT_FILENAME);
}

function isTimestampSnapshotFile(filename) {
  return /^\d{8}T\d{9}Z\.json$/.test(filename);
}

function buildSnapshotId(createdAt = new Date().toISOString()) {
  const timestamp = typeof createdAt === 'string' ? createdAt : createdAt.toISOString();
  return timestamp.replace(/[-:]/g, '').replace(/\.(\d{3})Z$/, '$1Z');
}

function getChangedFields(baseSettings = {}, nextSettings = {}) {
  return UI_SETTING_FIELDS.filter(field => {
    const before = baseSettings[field];
    const after = nextSettings[field];
    return JSON.stringify(before) !== JSON.stringify(after);
  });
}

function mergeContinuationPayload(baseSettings = {}, overrides = {}, routeBrainId = null) {
  const merged = { ...normalizeUiSettings(baseSettings) };
  for (const field of UI_SETTING_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(overrides, field)) {
      merged[field] = overrides[field];
    }
  }
  const normalized = normalizeUiSettings(merged);
  if (routeBrainId) {
    normalized.brainId = routeBrainId;
  }
  return normalized;
}

async function loadRunMetadataFiles(runPath) {
  const [runtimeMetadata, webMetadata] = await Promise.all([
    readJsonIfExists(path.join(runPath, 'run-metadata.json')),
    readJsonIfExists(path.join(runPath, 'metadata.json'))
  ]);

  return {
    runtimeMetadata: runtimeMetadata || {},
    webMetadata: webMetadata || {}
  };
}

async function readSnapshotFile(filePath) {
  const snapshot = await readJsonIfExists(filePath);
  if (!snapshot || typeof snapshot !== 'object') {
    return null;
  }

  return {
    ...snapshot,
    id: snapshot.id || path.basename(filePath, '.json'),
    createdAt: snapshot.createdAt || null,
    settings: normalizeUiSettings(snapshot.settings || {}),
    changedFields: Array.isArray(snapshot.changedFields) ? snapshot.changedFields : [],
    baseSnapshotId: snapshot.baseSnapshotId || null,
    filePath
  };
}

function summarizeSnapshot(snapshot) {
  if (!snapshot) {
    return null;
  }

  return {
    id: snapshot.id,
    createdAt: snapshot.createdAt,
    changedFields: [...snapshot.changedFields],
    changedCount: snapshot.changedFields.length,
    baseSnapshotId: snapshot.baseSnapshotId || null
  };
}

async function loadInitialLaunchSnapshot(runPath) {
  return readSnapshotFile(getInitialSnapshotPath(runPath));
}

async function loadContinuationSnapshots(runPath) {
  const snapshotsDir = getSnapshotsDir(runPath);
  if (!(await pathExists(snapshotsDir))) {
    return [];
  }

  const entries = await fsp.readdir(snapshotsDir);
  const files = entries.filter(isTimestampSnapshotFile).sort().reverse();
  const snapshots = await Promise.all(
    files.map(file => readSnapshotFile(path.join(snapshotsDir, file)))
  );

  return snapshots.filter(Boolean);
}

async function getBrainContinuationState(brain) {
  const { runtimeMetadata, webMetadata } = await loadRunMetadataFiles(brain.path);
  const metadataSettings = normalizeBrainMetadataToSettings({
    brain,
    runtimeMetadata,
    webMetadata
  });

  const allowLocalSnapshots = brain.sourceType === 'local';
  const [initialLaunchSnapshot, snapshots] = allowLocalSnapshots
    ? await Promise.all([
        loadInitialLaunchSnapshot(brain.path),
        loadContinuationSnapshots(brain.path)
      ])
    : [null, []];

  const initialSettings = normalizeUiSettings(initialLaunchSnapshot?.settings || metadataSettings);
  const latestSnapshot = snapshots[0] || null;
  const effectiveContinueSettings = normalizeUiSettings(latestSnapshot?.settings || initialSettings);

  return {
    brain,
    initialSettings,
    effectiveContinueSettings,
    latestSnapshot,
    snapshots: snapshots.map(summarizeSnapshot),
    snapshotCount: snapshots.length,
    lastSnapshotAt: latestSnapshot?.createdAt || null
  };
}

async function getBrainSnapshotSummary(brain) {
  if (!brain || brain.sourceType !== 'local') {
    return {
      snapshotCount: 0,
      lastSnapshotAt: null
    };
  }

  const snapshots = await loadContinuationSnapshots(brain.path);
  return {
    snapshotCount: snapshots.length,
    lastSnapshotAt: snapshots[0]?.createdAt || null
  };
}

async function ensureInitialLaunchSnapshot(runPath, options) {
  const filePath = getInitialSnapshotPath(runPath);
  const existing = await readSnapshotFile(filePath);
  if (existing) {
    return existing;
  }

  await fsp.mkdir(path.dirname(filePath), { recursive: true });

  const snapshot = {
    id: 'initial-launch',
    createdAt: new Date().toISOString(),
    brainId: options.brainId || null,
    runName: options.runName || path.basename(runPath),
    sourceType: options.sourceType || 'local',
    settings: normalizeUiSettings(options.settings || {}),
    changedFields: [],
    baseSnapshotId: null
  };

  await fsp.writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf8');
  return {
    ...snapshot,
    filePath
  };
}

async function writeContinuationSnapshot(runPath, options) {
  const createdAt = options.createdAt || new Date().toISOString();
  const snapshot = {
    id: options.id || buildSnapshotId(createdAt),
    createdAt,
    brainId: options.brainId || null,
    runName: options.runName || path.basename(runPath),
    sourceType: options.sourceType || 'local',
    settings: normalizeUiSettings(options.settings || {}),
    changedFields: Array.isArray(options.changedFields) ? options.changedFields : [],
    baseSnapshotId: options.baseSnapshotId || null
  };

  const filePath = path.join(getSnapshotsDir(runPath), `${snapshot.id}.json`);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf8');
  return {
    ...snapshot,
    filePath
  };
}

module.exports = {
  DEFAULT_UI_SETTINGS,
  UI_SETTING_FIELDS,
  SNAPSHOT_DIRNAME,
  INITIAL_SNAPSHOT_FILENAME,
  normalizeUiSettings,
  normalizeBrainMetadataToSettings,
  mergeContinuationPayload,
  getChangedFields,
  buildSnapshotId,
  getSnapshotsDir,
  loadRunMetadataFiles,
  loadInitialLaunchSnapshot,
  loadContinuationSnapshots,
  getBrainContinuationState,
  getBrainSnapshotSummary,
  ensureInitialLaunchSnapshot,
  writeContinuationSnapshot,
  summarizeSnapshot
};
