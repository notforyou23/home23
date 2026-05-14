const fs = require('fs').promises;
const path = require('path');
const { ArtifactRegistry } = require('./artifact-registry');
const { ArtifactIngestor } = require('./artifact-ingestor');

async function migrateExistingOutputs(runDir, options = {}) {
  const artifactRoots = options.artifactRoots || [
    path.join(runDir, 'outputs'),
    path.join(runDir, 'exports')
  ];
  const logger = options.logger || console;
  const registry = options.registry || new ArtifactRegistry({ runDir, logger });
  const ingestor = options.ingestor || new ArtifactIngestor({ registry, logger });
  const files = [];
  for (const root of artifactRoots) {
    files.push(...await walkFiles(root).catch(() => []));
  }

  const migrated = [];
  const failed = [];

  for (const filePath of files) {
    try {
      const record = await registry.registerArtifact({
        path: path.relative(runDir, filePath).split(path.sep).join('/'),
        producer: { type: 'system', id: 'migration' },
        lifecycleState: 'orphan_registered',
        registrationWarnings: [{
          type: 'migrated_without_lineage',
          message: 'Existing output was registered after the run; task and producer lineage were not invented.',
          detectedAt: new Date().toISOString()
        }]
      });
      const ingested = await ingestor.ingest(record);
      migrated.push({
        artifactId: record.artifactId,
        path: record.path,
        parseStatus: ingested?.parseStatus || record.parseStatus || 'unparsed',
        lifecycleState: ingested?.lifecycleState || record.lifecycleState
      });
    } catch (error) {
      failed.push({
        path: path.relative(runDir, filePath).split(path.sep).join('/'),
        error: error.message
      });
    }
  }

  const taskBindings = options.bindTaskOutputs === false
    ? { bound: 0, skipped: 0, bindings: [] }
    : await bindDeclaredTaskOutputs(runDir, registry, { logger });

  return {
    schema: 'cosmo23.artifact_migration.v1',
    runDir,
    artifactRoots,
    scanned: files.length,
    migrated: migrated.length,
    failed: failed.length,
    taskBindings: taskBindings.bound,
    artifacts: migrated,
    bindings: taskBindings.bindings,
    failures: failed
  };
}

async function bindDeclaredTaskOutputs(runDir, registry, options = {}) {
  await registry.initialize?.();
  const logger = options.logger || console;
  const tasksRoot = path.join(runDir, 'tasks');
  const taskFiles = await walkFiles(tasksRoot).catch(() => []);
  const bindings = [];
  let skipped = 0;

  for (const taskPath of taskFiles) {
    if (!taskPath.endsWith('.json')) continue;
    let task;
    try {
      task = JSON.parse(await fs.readFile(taskPath, 'utf8'));
    } catch (_) {
      skipped++;
      continue;
    }
    if (!task?.id || !isCompletedTask(task)) continue;
    const produced = Array.isArray(task.producedArtifacts) ? task.producedArtifacts : [];
    const artifacts = Array.isArray(task.artifacts) ? task.artifacts : [];
    if (produced.length > 0 || artifacts.some(item => item?.artifactId)) continue;

    const declaredOutputs = getDeclaredTaskOutputs(task);
    if (declaredOutputs.length === 0) continue;

    const matched = [];
    for (const outputPath of declaredOutputs) {
      const record = registry.getArtifactByPath(outputPath);
      if (!record?.artifactId) continue;
      const updated = await registry.updateArtifact(record.artifactId, {
        taskId: task.id,
        goalId: task.goalId || task.metadata?.goalId || record.goalId || null,
        missingBindings: (record.missingBindings || []).filter(binding => binding !== 'taskId'),
        registrationWarnings: [
          ...(Array.isArray(record.registrationWarnings) ? record.registrationWarnings : []),
          {
            type: 'bound_from_task_declared_output',
            message: 'Historical artifact was bound to a completed task because the task declared this exact output path.',
            taskId: task.id,
            detectedAt: new Date().toISOString()
          }
        ]
      });
      matched.push({
        artifactId: updated.artifactId,
        role: 'declared_output',
        path: updated.workspacePath || updated.path,
        kind: updated.kind || 'file',
        producer: updated.producer || { type: 'system', id: 'migration' },
        hash: updated.hash || null
      });
    }

    if (matched.length === 0) continue;

    task.artifacts = mergeTaskArtifacts(task.artifacts, matched);
    task.producedArtifacts = mergeTaskArtifacts(task.producedArtifacts, matched);
    task.artifactClosure = {
      status: 'completed_bound_from_declared_outputs',
      artifactCount: task.producedArtifacts.length,
      consumedCount: Array.isArray(task.consumedArtifacts) ? task.consumedArtifacts.length : 0,
      updatedAt: Date.now(),
      source: 'artifact_migration_task_binding'
    };
    task.updatedAt = Date.now();

    await fs.writeFile(taskPath, JSON.stringify(task, null, 2), 'utf8');
    bindings.push({
      taskId: task.id,
      taskPath: path.relative(runDir, taskPath).split(path.sep).join('/'),
      declaredOutputs,
      artifactIds: matched.map(item => item.artifactId)
    });
  }

  if (bindings.length > 0) {
    logger.info?.('[ArtifactMigration] Bound declared task outputs', {
      runDir,
      bound: bindings.length
    });
  }

  return { bound: bindings.length, skipped, bindings };
}

function isCompletedTask(task) {
  const state = String(task.state || '').toUpperCase();
  return ['DONE', 'COMPLETE', 'COMPLETED'].includes(state) || Boolean(task.completedAt);
}

function getDeclaredTaskOutputs(task) {
  const outputs = [];
  const expected = task.metadata?.expectedOutput;
  if (expected) outputs.push(normalizeDeclaredOutput(expected));

  const spec = task.metadata?.deliverableSpec;
  if (spec?.filename) {
    outputs.push(normalizeDeclaredOutput(`${spec.location || '@outputs/'}${spec.filename}`));
  }

  return [...new Set(outputs.filter(Boolean))];
}

function normalizeDeclaredOutput(value) {
  const normalized = String(value || '').trim().replace(/\\/g, '/');
  if (!normalized) return null;
  if (normalized.startsWith('@outputs/')) return `outputs/${normalized.slice('@outputs/'.length)}`;
  if (normalized.startsWith('@exports/')) return `exports/${normalized.slice('@exports/'.length)}`;
  if (normalized.startsWith('/')) return normalized;
  return normalized;
}

function mergeTaskArtifacts(existing = [], incoming = []) {
  const merged = Array.isArray(existing) ? [...existing] : [];
  const seen = new Set(merged.map(item => item?.artifactId || item?.path).filter(Boolean));
  for (const item of incoming) {
    const key = item?.artifactId || item?.path;
    if (!key || seen.has(key)) continue;
    merged.push(item);
    seen.add(key);
  }
  return merged;
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

module.exports = { migrateExistingOutputs, bindDeclaredTaskOutputs };
