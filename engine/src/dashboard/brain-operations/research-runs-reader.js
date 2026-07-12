'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {
  loadCanonicalRunMetadata,
} = require('../../../../cosmo23/server/lib/research-run-metadata.js');

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ACTIVE_STATES = new Set(['starting', 'active', 'stopping']);
const CONTINUABLE_STATES = new Set(['paused', 'failed', 'completed']);
const STOPPABLE_STATES = new Set(['starting', 'active', 'stopping']);
const MAX_SCAN_ENTRIES = 1_000;

function typed(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function validateOptions(options) {
  if (!options || Array.isArray(options) || typeof options !== 'object'
      || Reflect.ownKeys(options).some((key) => !['home23Root', 'requesterAgent'].includes(key))
      || typeof options.home23Root !== 'string' || !path.isAbsolute(options.home23Root)
      || path.normalize(options.home23Root) !== options.home23Root
      || typeof options.requesterAgent !== 'string'
      || !IDENTIFIER.test(options.requesterAgent)) {
    throw typed('reader_configuration_invalid');
  }
}

function project(record) {
  return Object.freeze({
    runId: record.runId,
    ownerAgent: record.ownerAgent,
    operationId: record.operationId,
    state: record.state,
    topic: typeof record.topic === 'string' ? record.topic : '',
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : null,
    startedAt: typeof record.startedAt === 'string' ? record.startedAt : null,
    updatedAt: record.updatedAt,
    completedAt: typeof record.completedAt === 'string' ? record.completedAt : null,
    stoppedAt: typeof record.stoppedAt === 'string' ? record.stoppedAt : null,
    continuable: CONTINUABLE_STATES.has(record.state),
    stoppable: STOPPABLE_STATES.has(record.state),
    error: record.error && typeof record.error === 'object' ? record.error : null,
  });
}

function createResearchRunsReader(options) {
  validateOptions(options);
  const runsRoot = path.join(
    options.home23Root,
    'instances',
    options.requesterAgent,
    'workspace',
    'research-runs',
  );

  async function list({ state = 'recent', limit = 20 } = {}) {
    if (!['recent', 'active'].includes(state)
        || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw typed('invalid_request');
    }
    let rootStat;
    try {
      rootStat = await fs.lstat(runsRoot);
    } catch (error) {
      if (error?.code === 'ENOENT') return { state, runs: [], count: 0 };
      throw error;
    }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw typed('run_path_invalid');
    }
    const entries = await fs.readdir(runsRoot, { withFileTypes: true });
    if (entries.length > MAX_SCAN_ENTRIES) throw typed('result_too_large');
    const rows = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !IDENTIFIER.test(entry.name)) continue;
      const runRoot = path.join(runsRoot, entry.name);
      let record;
      try {
        record = await loadCanonicalRunMetadata(runRoot);
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      if (!record || record.runId !== entry.name
          || record.ownerAgent !== options.requesterAgent
          || record.canonicalRoot !== runRoot
          || typeof record.updatedAt !== 'string') {
        throw typed('run_metadata_invalid');
      }
      if (state === 'active' && !ACTIVE_STATES.has(record.state)) continue;
      rows.push(project(record));
    }
    rows.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)
      || right.runId.localeCompare(left.runId));
    const selected = rows.slice(0, limit);
    return { state, runs: selected, count: selected.length };
  }

  async function getActive() {
    const current = await list({ state: 'active', limit: 1 });
    const active = current.runs[0];
    if (!active) return { active: false };
    return {
      active: true,
      runName: active.runId,
      topic: active.topic,
      startedAt: active.startedAt || active.createdAt || '',
      processCount: null,
      state: active.state,
      operationId: active.operationId,
    };
  }

  return Object.freeze({ list, getActive });
}

module.exports = { createResearchRunsReader };
