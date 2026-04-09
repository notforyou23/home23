const express = require('express');
const {
  getBrainContinuationState,
  getBrainSnapshotSummary,
  mergeContinuationPayload,
  getChangedFields,
  ensureInitialLaunchSnapshot,
  writeContinuationSnapshot
} = require('./continuation-state');

function stripInternalLaunchFields(payload) {
  const {
    brainPath,
    brainSourceType,
    ...publicPayload
  } = payload || {};

  return publicPayload;
}

function createBrainsRouter(options) {
  const {
    getRunsOptions,
    getActiveContext,
    listBrains,
    resolveBrainBySelector,
    launchResearch
  } = options;

  const router = express.Router();

  router.get('/api/brains', async (_req, res) => {
    try {
      const runsOptions = await getRunsOptions();
      const brains = await listBrains(runsOptions);
      const brainsWithSnapshots = await Promise.all(
        brains.map(async brain => ({
          ...brain,
          ...(await getBrainSnapshotSummary(brain))
        }))
      );

      res.json({
        brains: brainsWithSnapshots,
        count: brainsWithSnapshots.length,
        activeContext: getActiveContext()
      });
    } catch (error) {
      res.status(500).json({
        error: error.message
      });
    }
  });

  router.get('/api/brains/:brainId', async (req, res) => {
    try {
      const runsOptions = await getRunsOptions();
      const brain = await resolveBrainBySelector(req.params.brainId, runsOptions);
      if (!brain) {
        return res.status(404).json({
          success: false,
          error: 'Brain not found'
        });
      }

      const state = await getBrainContinuationState(brain);
      res.json({
        brain: {
          ...brain,
          snapshotCount: state.snapshotCount,
          lastSnapshotAt: state.lastSnapshotAt
        },
        initialSettings: state.initialSettings,
        effectiveContinueSettings: state.effectiveContinueSettings,
        latestSnapshot: state.latestSnapshot,
        snapshots: state.snapshots
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  router.post('/api/continue/:brainId', async (req, res) => {
    try {
      const runsOptions = await getRunsOptions();
      const selectedBrain = await resolveBrainBySelector(req.params.brainId, runsOptions);
      if (!selectedBrain) {
        return res.status(404).json({
          success: false,
          error: 'Brain not found'
        });
      }

      const continuationState = await getBrainContinuationState(selectedBrain);
      const mergedPayload = mergeContinuationPayload(
        continuationState.effectiveContinueSettings,
        req.body || {},
        req.params.brainId
      );

      const launchResult = await launchResearch(mergedPayload, req);
      const targetRunPath = launchResult?.brainPath;
      if (targetRunPath) {
        const baseSettings = continuationState.effectiveContinueSettings;
        const normalizedTargetSettings = mergeContinuationPayload(baseSettings, mergedPayload);

        await ensureInitialLaunchSnapshot(targetRunPath, {
          brainId: launchResult.brainId,
          runName: launchResult.runName,
          sourceType: selectedBrain.sourceType,
          settings: continuationState.initialSettings
        });

        await writeContinuationSnapshot(targetRunPath, {
          brainId: launchResult.brainId,
          runName: launchResult.runName,
          sourceType: selectedBrain.sourceType,
          settings: normalizedTargetSettings,
          changedFields: getChangedFields(baseSettings, normalizedTargetSettings),
          baseSnapshotId: selectedBrain.sourceType === 'local'
            ? continuationState.latestSnapshot?.id || null
            : null
        });
      }

      res.json(stripInternalLaunchFields(launchResult));
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        error: error.message
      });
    }
  });

  return router;
}

module.exports = {
  createBrainsRouter
};
