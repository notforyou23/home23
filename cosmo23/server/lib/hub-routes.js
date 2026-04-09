/**
 * Hub Routes — Brain Package Management
 *
 * Endpoints for merge, fork, export, import, and brain stats.
 * MergeEngine is lazy-loaded (created by another agent).
 */

const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const zlib = require('zlib');
const { promisify } = require('util');

const gunzip = promisify(zlib.gunzip);
const gzip = promisify(zlib.gzip);

const {
  resolveBrainBySelector,
  listBrains,
  sanitizeRunName,
  ensureUniqueRunName
} = require('./brain-registry');

// Lazy-load MergeEngine (being created by another agent)
let MergeEngine = null;
let mergeEngineAvailable = false;

function ensureMergeEngine(engineDir) {
  if (MergeEngine !== null) return mergeEngineAvailable;
  try {
    MergeEngine = require(path.join(engineDir, 'src/merge/merge-engine'));
    if (MergeEngine.MergeEngine) MergeEngine = MergeEngine.MergeEngine;
    mergeEngineAvailable = true;
  } catch (e) {
    mergeEngineAvailable = false;
  }
  return mergeEngineAvailable;
}

async function loadFullState(runPath) {
  const candidates = [
    path.join(runPath, 'state.json.gz'),
    path.join(runPath, 'coordinator', 'state.json.gz'),
    path.join(runPath, 'state.json'),
    path.join(runPath, 'coordinator', 'state.json')
  ];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      if (candidate.endsWith('.gz')) {
        const compressed = await fs.readFile(candidate);
        const decompressed = await gunzip(compressed);
        return JSON.parse(decompressed.toString());
      } else {
        return JSON.parse(await fs.readFile(candidate, 'utf8'));
      }
    } catch {
      continue;
    }
  }
  return null;
}

async function loadMetadata(runPath) {
  const candidates = [
    path.join(runPath, 'run-metadata.json'),
    path.join(runPath, 'metadata.json')
  ];
  for (const candidate of candidates) {
    try {
      return JSON.parse(await fs.readFile(candidate, 'utf8'));
    } catch {
      continue;
    }
  }
  return {};
}

function createHubRouter(options) {
  const { localRunsPath, getReferenceRunsPaths, getActiveContext, engineDir } = options;
  const router = express.Router();

  function getRunsOptions() {
    return {
      localRunsPath,
      referenceRunsPaths: getReferenceRunsPaths(),
      activeRunPath: getActiveContext()?.runPath || null
    };
  }

  async function resolveBrain(brainId) {
    return resolveBrainBySelector(brainId, getRunsOptions());
  }

  // ════════════════════════════════════════════════════════════════════════
  // POST /api/hub/merge/preview
  // ════════════════════════════════════════════════════════════════════════

  router.post('/api/hub/merge/preview', async (req, res) => {
    try {
      const { brainIds, threshold = 0.85 } = req.body;
      if (!Array.isArray(brainIds) || brainIds.length < 2) {
        return res.status(400).json({ success: false, error: 'At least 2 brainIds required' });
      }

      if (!ensureMergeEngine(engineDir)) {
        return res.status(501).json({ success: false, error: 'MergeEngine not available yet' });
      }

      const states = [];
      const brainNames = [];
      for (const id of brainIds) {
        const brain = await resolveBrain(id);
        if (!brain) {
          return res.status(404).json({ success: false, error: `Brain not found: ${id}` });
        }
        const rawState = await loadFullState(brain.path);
        if (!rawState) {
          return res.status(400).json({ success: false, error: `No state for brain: ${brain.name}` });
        }
        const metadata = await loadMetadata(brain.path);
        states.push({ name: brain.name, path: brain.path, state: rawState, metadata, valid: true });
        brainNames.push(brain.name);
      }

      const engine = new MergeEngine({ dryRun: true, threshold });
      const result = await engine.merge(states);

      res.json({
        success: true,
        preview: {
          brainNames,
          totalNodes: result.totalNodes || 0,
          mergedNodes: result.mergedNodes || 0,
          duplicatesRemoved: result.duplicatesRemoved || 0,
          deduplicationRate: result.deduplicationRate || 0,
          totalEdges: result.totalEdges || 0,
          mergedEdges: result.mergedEdges || 0,
          conflicts: result.conflicts || 0,
          estimatedSize: result.estimatedSize || null
        }
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ════════════════════════════════════════════════════════════════════════
  // POST /api/hub/merge — SSE streaming merge
  // ════════════════════════════════════════════════════════════════════════

  router.post('/api/hub/merge', async (req, res) => {
    const { brainIds, name, threshold = 0.85, conflictPolicy = 'best-representative' } = req.body;

    if (!Array.isArray(brainIds) || brainIds.length < 2) {
      return res.status(400).json({ success: false, error: 'At least 2 brainIds required' });
    }
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Name is required' });
    }

    if (!ensureMergeEngine(engineDir)) {
      return res.status(501).json({ success: false, error: 'MergeEngine not available yet' });
    }

    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    function send(event, data) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    try {
      const states = [];
      const brainNames = [];
      for (const id of brainIds) {
        const brain = await resolveBrain(id);
        if (!brain) {
          send('error', { error: `Brain not found: ${id}` });
          return res.end();
        }
        const rawState = await loadFullState(brain.path);
        if (!rawState) {
          send('error', { error: `No state for brain: ${brain.name}` });
          return res.end();
        }
        const metadata = await loadMetadata(brain.path);
        states.push({ name: brain.name, path: brain.path, state: rawState, metadata, valid: true });
        brainNames.push(brain.name);
      }

      send('phase', { phase: 'Initializing merge', progress: 0 });

      const progressReporter = (event) => {
        if (event.phase) send('phase', { phase: event.phase, progress: event.progress || 0 });
        if (event.progress != null) send('progress', { progress: event.progress, message: event.message || '' });
        if (event.phaseComplete) send('phaseComplete', { phase: event.phaseComplete, stats: event.stats || {} });
      };

      // Create the output run directory first
      const sanitized = sanitizeRunName(name);
      const uniqueName = await ensureUniqueRunName(sanitized, localRunsPath);
      const runPath = path.join(localRunsPath, uniqueName);

      await fs.mkdir(runPath, { recursive: true });
      await fs.mkdir(path.join(runPath, 'coordinator'), { recursive: true });
      await fs.mkdir(path.join(runPath, 'agents'), { recursive: true });
      await fs.mkdir(path.join(runPath, 'outputs'), { recursive: true });

      const engine = new MergeEngine({
        dryRun: false,
        threshold,
        conflictPolicy,
        runsPath: localRunsPath
      });

      const result = await engine.merge(states, uniqueName);
      // Engine's saveMergedRun() already saved state.json.gz correctly — don't overwrite

      // Write merge metadata
      const mergeMetadata = {
        mergeType: 'hub-merge',
        sources: brainNames,
        sourceIds: brainIds,
        threshold,
        conflictPolicy,
        mergedAt: new Date().toISOString(),
        stats: result.stats || {
          totalNodes: result.totalNodes,
          mergedNodes: result.mergedNodes,
          duplicatesRemoved: result.duplicatesRemoved
        }
      };
      await fs.writeFile(
        path.join(runPath, 'run-metadata.json'),
        JSON.stringify(mergeMetadata, null, 2)
      );

      const crypto = require('crypto');
      const brainId = crypto.createHash('sha1').update(path.resolve(runPath)).digest('hex').slice(0, 16);

      send('complete', {
        brainId,
        path: runPath,
        name: uniqueName,
        stats: mergeMetadata.stats,
        report: result.report || null
      });
    } catch (error) {
      send('error', { error: error.message });
    }

    res.end();
  });

  // ════════════════════════════════════════════════════════════════════════
  // POST /api/hub/fork
  // ════════════════════════════════════════════════════════════════════════

  router.post('/api/hub/fork', async (req, res) => {
    try {
      const { brainId, name, type = 'fork' } = req.body;
      if (!brainId) return res.status(400).json({ success: false, error: 'brainId required' });
      if (!name || !name.trim()) return res.status(400).json({ success: false, error: 'name required' });

      const brain = await resolveBrain(brainId);
      if (!brain) return res.status(404).json({ success: false, error: 'Brain not found' });

      const { RunManager } = require('../../launcher/run-manager');
      const runManager = new RunManager(localRunsPath);

      const sanitized = sanitizeRunName(name);
      const uniqueName = await ensureUniqueRunName(sanitized, localRunsPath);

      let result;
      if (type === 'dream') {
        result = await runManager.createDreamFork(brain.name, uniqueName, {}, {
          sourcePath: brain.path,
          destPath: path.join(localRunsPath, uniqueName)
        });
      } else {
        result = await runManager.forkRun(brain.name, uniqueName, {
          sourcePath: brain.path,
          destPath: path.join(localRunsPath, uniqueName)
        });
      }

      if (!result.success) {
        return res.status(500).json({ success: false, error: result.error });
      }

      const crypto = require('crypto');
      const newBrainId = crypto.createHash('sha1').update(path.resolve(result.path)).digest('hex').slice(0, 16);

      res.json({
        success: true,
        brainId: newBrainId,
        path: result.path,
        name: uniqueName,
        type
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ════════════════════════════════════════════════════════════════════════
  // POST /api/hub/export
  // ════════════════════════════════════════════════════════════════════════

  router.post('/api/hub/export', async (req, res) => {
    try {
      const { brainId, outputName, includeOutputs = false } = req.body;
      if (!brainId) return res.status(400).json({ success: false, error: 'brainId required' });

      const brain = await resolveBrain(brainId);
      if (!brain) return res.status(404).json({ success: false, error: 'Brain not found' });

      const exportName = sanitizeRunName(outputName || brain.name);
      const exportDir = path.join(localRunsPath, '..', 'exports');
      await fs.mkdir(exportDir, { recursive: true });
      const outputPath = path.join(exportDir, `${exportName}.brain`);

      await fs.mkdir(outputPath, { recursive: true });

      // Copy state
      const stateCandidates = [
        path.join(brain.path, 'state.json.gz'),
        path.join(brain.path, 'coordinator', 'state.json.gz')
      ];
      for (const src of stateCandidates) {
        try {
          await fs.access(src);
          await fs.copyFile(src, path.join(outputPath, 'state.json.gz'));
          break;
        } catch { continue; }
      }

      // Copy outputs if requested
      if (includeOutputs) {
        const outputsSrc = path.join(brain.path, 'outputs');
        try {
          await fs.access(outputsSrc);
          await copyDirectory(outputsSrc, path.join(outputPath, 'outputs'));
        } catch { /* no outputs dir */ }
      }

      // Write manifest
      const metadata = await loadMetadata(brain.path);
      const manifest = {
        format: 'cosmo-brain-v1',
        name: brain.name,
        exportedAt: new Date().toISOString(),
        sourcePath: brain.path,
        topic: metadata.topic || brain.topic || '',
        domain: metadata.domain || brain.domain || '',
        nodes: brain.nodes,
        edges: brain.edges,
        cycles: brain.cycleCount,
        includesOutputs: includeOutputs
      };
      await fs.writeFile(path.join(outputPath, 'manifest.json'), JSON.stringify(manifest, null, 2));

      res.json({ success: true, outputPath, manifest });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ════════════════════════════════════════════════════════════════════════
  // POST /api/hub/import
  // ════════════════════════════════════════════════════════════════════════

  router.post('/api/hub/import', async (req, res) => {
    try {
      const { path: importPath } = req.body;
      if (!importPath) return res.status(400).json({ success: false, error: 'path required' });

      const resolved = path.resolve(importPath);

      // Validate .brain directory
      try {
        await fs.access(resolved);
      } catch {
        return res.status(404).json({ success: false, error: 'Import path does not exist' });
      }

      // Check for state file
      const hasState = await fs.access(path.join(resolved, 'state.json.gz')).then(() => true).catch(() => false);
      if (!hasState) {
        return res.status(400).json({ success: false, error: 'No state.json.gz found in import path' });
      }

      // Read manifest if present
      let manifest = {};
      try {
        manifest = JSON.parse(await fs.readFile(path.join(resolved, 'manifest.json'), 'utf8'));
      } catch { /* no manifest */ }

      const baseName = manifest.name || path.basename(resolved).replace(/\.brain$/, '') || 'imported-brain';
      const runName = await ensureUniqueRunName(sanitizeRunName(baseName), localRunsPath);
      const runPath = path.join(localRunsPath, runName);

      await copyDirectory(resolved, runPath);

      // Write import metadata
      await fs.writeFile(
        path.join(runPath, 'import-origin.json'),
        JSON.stringify({
          sourcePath: resolved,
          importedAt: new Date().toISOString(),
          manifest
        }, null, 2)
      );

      res.json({ success: true, runPath, runName });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ════════════════════════════════════════════════════════════════════════
  // GET /api/hub/brain/:brainId/stats
  // ════════════════════════════════════════════════════════════════════════

  router.get('/api/hub/brain/:brainId/stats', async (req, res) => {
    try {
      const brain = await resolveBrain(req.params.brainId);
      if (!brain) return res.status(404).json({ success: false, error: 'Brain not found' });

      const state = await loadFullState(brain.path);
      const metadata = await loadMetadata(brain.path);

      const nodes = state?.memory?.nodes || [];
      const edges = state?.memory?.edges || [];
      const goals = state?.goals || {};

      // Compute clusters from node tags
      const tagSet = new Set();
      nodes.forEach(n => {
        if (n.tags) n.tags.forEach(t => tagSet.add(t));
        if (n.tag) tagSet.add(n.tag);
      });

      // Unique edge types
      const edgeTypes = new Set();
      edges.forEach(e => { if (e.type) edgeTypes.add(e.type); });

      res.json({
        success: true,
        stats: {
          nodes: nodes.length,
          edges: edges.length,
          clusters: tagSet.size,
          cycles: state?.cycleCount || brain.cycleCount || 0,
          activeGoals: (goals.active || []).length,
          completedGoals: (goals.completed || []).length,
          edgeTypes: [...edgeTypes],
          domain: metadata.domain || brain.domain || '',
          topic: metadata.topic || brain.topic || '',
          mode: metadata.explorationMode || brain.mode || 'guided',
          created: brain.modifiedDate,
          path: brain.path,
          sourceType: brain.sourceType,
          sourceLabel: brain.sourceLabel
        }
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  return router;
}

// Helper: recursive directory copy
async function copyDirectory(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

module.exports = { createHubRouter };
