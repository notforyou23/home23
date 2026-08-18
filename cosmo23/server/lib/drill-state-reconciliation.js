'use strict';

const fs = require('fs');
const path = require('path');

const fsp = fs.promises;

function normalizeExitDetails(details = {}) {
  const numericAt = Number(details.at);
  const at = Number.isFinite(numericAt) ? numericAt : Date.now();
  return {
    at,
    code: details.code ?? null,
    signal: details.signal || null,
    reason: details.signal ? 'signal' : 'process_exit',
    source: details.source || 'server_exit_reconciliation',
    derived: details.derived === true
  };
}

function normalizeInactiveDrillState(drill, details = {}) {
  if (!drill || typeof drill !== 'object' || Array.isArray(drill)) {
    return { changed: false, drill, workersNormalized: 0, phasesNormalized: 0 };
  }
  if (drill.mode === 'done') {
    return { changed: false, drill, workersNormalized: 0, phasesNormalized: 0 };
  }

  const workers = Array.isArray(drill.activeWorkers) ? drill.activeWorkers : [];
  const phases = Array.isArray(drill.goal?.phases) ? drill.goal.phases : [];
  const activePhases = phases.filter((phase) => phase?.status === 'active');
  const wasDrilling = drill.mode === 'drilling';
  if (!wasDrilling && workers.length === 0 && activePhases.length === 0) {
    return { changed: false, drill, workersNormalized: 0, phasesNormalized: 0 };
  }

  const exit = normalizeExitDetails(details);
  const interruptedWorkers = workers.map((worker) => ({
    workerId: worker?.workerId || null,
    cycle: worker?.cycle ?? null,
    goalNumber: worker?.goalNumber ?? null,
    phaseNumber: worker?.phaseNumber ?? null,
    phaseTitle: worker?.phaseTitle || null
  }));
  const interruptedPhases = activePhases.map((phase) => ({
    number: phase.number ?? null,
    title: phase.title || null
  }));
  const nextPhases = phases.map((phase) => (
    phase?.status === 'active'
      ? { ...phase, status: 'pending', workerId: null }
      : phase
  ));
  const interruption = {
    ...exit,
    priorMode: drill.mode || null,
    workers: interruptedWorkers,
    phases: interruptedPhases
  };

  return {
    changed: true,
    drill: {
      ...drill,
      mode: wasDrilling ? 'interrupted' : drill.mode,
      activeWorkers: [],
      goal: drill.goal && typeof drill.goal === 'object'
        ? { ...drill.goal, phases: nextPhases }
        : drill.goal,
      interruption,
      updatedAt: exit.at
    },
    workersNormalized: interruptedWorkers.length,
    phasesNormalized: interruptedPhases.length,
    interruption
  };
}

async function reconcileDrillStateOnExit(runPath, details = {}, options = {}) {
  const io = options.fs || fsp;
  const drillDir = path.join(runPath, 'drill');
  const statePath = path.join(drillDir, 'state.json');
  const raw = await io.readFile(statePath, 'utf8');
  const diskDrill = JSON.parse(raw);
  const normalized = normalizeInactiveDrillState(diskDrill, details);
  if (!normalized.changed) {
    return {
      status: 'preserved',
      mode: diskDrill?.mode || null,
      workersNormalized: 0,
      phasesNormalized: 0
    };
  }

  await io.mkdir(drillDir, { recursive: true });
  const evidence = {
    at: normalized.interruption.at,
    type: 'drill_interrupted',
    source: normalized.interruption.source,
    code: normalized.interruption.code,
    signal: normalized.interruption.signal,
    priorMode: normalized.interruption.priorMode,
    workers: normalized.interruption.workers,
    phases: normalized.interruption.phases
  };
  let evidenceError = null;
  try {
    await io.appendFile(path.join(drillDir, 'progress.jsonl'), `${JSON.stringify(evidence)}\n`);
  } catch (error) {
    evidenceError = error;
  }

  const tmp = `${statePath}.tmp-exit-${process.pid}-${normalized.interruption.at}`;
  await io.writeFile(tmp, JSON.stringify(normalized.drill, null, 2));
  await io.rename(tmp, statePath);
  return {
    status: 'reconciled',
    mode: normalized.drill.mode,
    workersNormalized: normalized.workersNormalized,
    phasesNormalized: normalized.phasesNormalized,
    evidenceAppended: evidenceError === null,
    evidenceError: evidenceError?.message || null
  };
}

function deriveDrillStatusTruth({
  drill,
  processOnline,
  recordedRunnerAlive = false,
  parked = false,
  at
} = {}) {
  const normalized = processOnline || parked
    ? { changed: false, drill }
    : normalizeInactiveDrillState(drill, {
      at,
      source: 'api_status_derived',
      derived: true
    });
  const effectiveDrill = normalized.drill;
  const orphanedRunner = recordedRunnerAlive && !processOnline;
  const running = processOnline && effectiveDrill?.mode === 'drilling';
  const lifecycle = running
    ? 'drilling'
    : orphanedRunner
      ? 'orphaned'
      : parked
        ? 'parked'
      : effectiveDrill?.mode === 'done'
        ? 'completed'
        : effectiveDrill?.mode === 'error'
          ? 'error'
          : effectiveDrill?.mode === 'stopped'
            ? 'stopped'
            : effectiveDrill?.mode === 'interrupted'
              ? 'interrupted'
              : processOnline
                ? (effectiveDrill ? 'launching' : 'running')
                : 'idle';

  return {
    drill: effectiveDrill,
    running,
    lifecycle,
    orphanedRunner,
    derivedInterrupted: normalized.changed && effectiveDrill?.mode === 'interrupted'
  };
}

module.exports = {
  deriveDrillStatusTruth,
  normalizeInactiveDrillState,
  reconcileDrillStateOnExit
};
