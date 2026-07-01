const fs = require('fs').promises;
const path = require('path');

async function auditArtifactLoop(runDir, options = {}) {
  const registryPath = options.registryPath || path.join(runDir, 'coordinator', 'artifact_registry.json');
  const artifactRoots = options.artifactRoots || [
    path.join(runDir, 'outputs'),
    path.join(runDir, 'exports')
  ];
  const tasksRoot = options.tasksRoot || path.join(runDir, 'tasks');
  const registry = await readRegistry(registryPath);
  const records = Array.isArray(registry.artifacts) ? registry.artifacts : [];
  const byAbsolutePath = new Map(records.filter(r => r.absolutePath).map(r => [path.resolve(r.absolutePath), r]));
  const byRelativePath = new Map(records.filter(r => r.path).map(r => [normalize(r.path), r]));
  const outputFiles = [];
  for (const root of artifactRoots) {
    outputFiles.push(...await walkFiles(root).catch(() => []));
  }

  const unregisteredFiles = [];
  for (const filePath of outputFiles) {
    const absolute = path.resolve(filePath);
    const relative = normalize(path.relative(runDir, filePath));
    if (!byAbsolutePath.has(absolute) && !byRelativePath.has(relative)) {
      unregisteredFiles.push({
        path: relative,
        absolutePath: absolute
      });
    }
  }

  const orphanArtifacts = records.filter(r => Array.isArray(r.missingBindings) && r.missingBindings.length > 0);
  const unparsedArtifacts = records.filter(r => r.parseStatus && r.parseStatus !== 'parsed');
  const supersededArtifacts = records.filter(r => r.lifecycleState === 'superseded');
  const currentArtifacts = records.filter(r => !['superseded', 'deprecated', 'archived'].includes(r.lifecycleState));
  const committedArtifacts = records.filter(r => r.lifecycleState === 'committed');
  const reusedArtifacts = records.filter(r => r.lifecycleState === 'reused');
  const parsedArtifacts = records.filter(r => r.parseStatus === 'parsed');
  const neverReusedArtifacts = records.filter(r => !['reused', 'superseded', 'deprecated', 'archived'].includes(r.lifecycleState));
  const tasks = await readTasks(tasksRoot).catch(() => []);
  const completedTasksWithoutProducedArtifacts = tasks.filter(task => {
    const state = String(task.state || '').toUpperCase();
    const isComplete = ['DONE', 'COMPLETED', 'COMPLETE'].includes(state) || Boolean(task.completedAt);
    const produced = Array.isArray(task.producedArtifacts) ? task.producedArtifacts : [];
    const artifacts = Array.isArray(task.artifacts) ? task.artifacts : [];
    return isComplete && produced.length === 0 && artifacts.filter(item => item?.artifactId).length === 0;
  }).map(task => ({
    taskId: task.id || null,
    state: task.state || null,
    title: task.title || null,
    completedAt: task.completedAt || null,
    artifactClosure: task.artifactClosure || null
  }));
  const sourceBackboneStatuses = await readSourceBackboneStatuses(outputFiles, runDir);
  const sourceBackboneBlocks = sourceBackboneStatuses.filter(item => item.canContinue === false);

  return {
    schema: 'cosmo23.artifact_audit.v1',
    runDir,
    registryPath,
    totals: {
      outputFiles: outputFiles.length,
      registeredArtifacts: records.length,
      unregisteredFiles: unregisteredFiles.length,
      orphanArtifacts: orphanArtifacts.length,
      unparsedArtifacts: unparsedArtifacts.length,
      currentArtifacts: currentArtifacts.length,
      committedArtifacts: committedArtifacts.length,
      reusedArtifacts: reusedArtifacts.length,
      parsedArtifacts: parsedArtifacts.length,
      supersededArtifacts: supersededArtifacts.length,
      neverReusedArtifacts: neverReusedArtifacts.length,
      completedTasksWithoutProducedArtifacts: completedTasksWithoutProducedArtifacts.length,
      sourceBackboneStatusFiles: sourceBackboneStatuses.length,
      sourceBackboneBlockCount: sourceBackboneBlocks.length
    },
    unregisteredFiles,
    orphanArtifacts,
    unparsedArtifacts,
    committedArtifacts,
    reusedArtifacts,
    parsedArtifacts,
    supersededArtifacts,
    currentArtifacts,
    neverReusedArtifacts,
    completedTasksWithoutProducedArtifacts,
    sourceBackboneStatuses,
    sourceBackboneBlocks
  };
}

async function readSourceBackboneStatuses(outputFiles = [], runDir) {
  const statuses = [];
  for (const filePath of outputFiles) {
    if (path.basename(filePath) !== 'source_backbone_status.json') continue;
    try {
      const data = JSON.parse(await fs.readFile(filePath, 'utf8'));
      statuses.push({
        path: normalize(path.relative(runDir, filePath)),
        canContinue: data.can_continue !== false,
        nextAllowedAction: data.next_allowed_action || null,
        requiredRoutes: normalizeArray(data.required_routes),
        attemptedRoutes: normalizeArray(data.attempted_routes),
        missingRequiredRoutes: normalizeArray(data.missing_required_routes),
        failedRequiredRoutes: normalizeArray(data.failed_required_routes),
        failedRoutes: normalizeArray(data.failed_routes),
        productiveSources: Number(data.productive_sources || 0),
        sourceRequired: data.source_required === true
      });
    } catch (_) {}
  }
  return statuses;
}

async function readRegistry(registryPath) {
  try {
    return JSON.parse(await fs.readFile(registryPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { artifacts: [] };
    throw error;
  }
}

async function walkFiles(root) {
  const results = [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...await walkFiles(fullPath));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

async function readTasks(root) {
  const files = await walkFiles(root).catch(() => []);
  const tasks = [];
  for (const filePath of files) {
    if (!filePath.endsWith('.json')) continue;
    try {
      const task = JSON.parse(await fs.readFile(filePath, 'utf8'));
      if (task && typeof task === 'object' && task.id) {
        tasks.push(task);
      }
    } catch (_) {}
  }
  return tasks;
}

function normalize(value) {
  return String(value || '').replace(/\\/g, '/');
}

function normalizeArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

module.exports = { auditArtifactLoop };
