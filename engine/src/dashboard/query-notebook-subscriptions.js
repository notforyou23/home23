'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const {
  assertIdentifier,
  assertOperationId,
} = require('./brain-operations/operation-contract.js');

const FILE_VERSION = 2;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 10_000;
const TERMINAL_STATES = new Set(['complete', 'partial', 'failed', 'cancelled', 'interrupted']);
const DELIVERY_STATES = new Set(['active', 'pending', 'failed', 'delivered']);
const fileQueues = new Map();

function subscriptionError(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function exactKeys(value, allowed, code = 'subscription_invalid') {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw subscriptionError(code);
  }
  const accepted = new Set(allowed);
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !accepted.has(key))) {
    throw subscriptionError(code);
  }
  return value;
}

function canonicalIso(value, code = 'subscription_invalid') {
  const milliseconds = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw subscriptionError(code);
  }
  return milliseconds;
}

function currentMilliseconds(now) {
  const raw = now();
  const value = raw instanceof Date ? raw.getTime()
    : typeof raw === 'string' ? Date.parse(raw) : raw;
  if (!Number.isFinite(value)) throw subscriptionError('subscription_store_unavailable');
  return Number(value);
}

function stableRouteId(requesterAgent, operationId, credentialId) {
  return `qroute_${crypto.createHash('sha256')
    .update('home23.query-notebook.subscription.v1\0', 'utf8')
    .update(requesterAgent, 'utf8').update('\0', 'utf8')
    .update(operationId, 'utf8').update('\0', 'utf8')
    .update(credentialId, 'utf8').digest('base64url').slice(0, 32)}`;
}

function validateEntry(raw, requesterAgent) {
  const entry = exactKeys(raw, [
    'requesterAgent', 'operationId', 'credentialId', 'deviceId', 'generation',
    'expiresAt', 'routeId', 'deliveryState', 'terminalState', 'createdAt',
    'updatedAt', 'deliveredAt', 'deliveryAttempts', 'lastAttemptAt',
    'deliveryRetryable',
  ], 'subscription_store_corrupt');
  if (entry.requesterAgent !== requesterAgent) throw subscriptionError('subscription_store_corrupt');
  try {
    assertOperationId(entry.operationId);
    assertIdentifier(entry.credentialId, 'credentialId');
    assertIdentifier(entry.deviceId, 'deviceId');
    assertIdentifier(entry.routeId, 'routeId');
  } catch (error) {
    throw subscriptionError('subscription_store_corrupt', error);
  }
  if (!Number.isSafeInteger(entry.generation) || entry.generation < 1
      || !DELIVERY_STATES.has(entry.deliveryState)
      || (entry.terminalState !== null && !TERMINAL_STATES.has(entry.terminalState))
      || (entry.deliveryState === 'active' && entry.terminalState !== null)
      || (entry.deliveryState !== 'active' && entry.terminalState === null)
      || !Number.isSafeInteger(entry.deliveryAttempts) || entry.deliveryAttempts < 0
      || (entry.lastAttemptAt !== null && typeof entry.lastAttemptAt !== 'string')
      || (entry.deliveryRetryable !== null && typeof entry.deliveryRetryable !== 'boolean')
      || stableRouteId(requesterAgent, entry.operationId, entry.credentialId) !== entry.routeId) {
    throw subscriptionError('subscription_store_corrupt');
  }
  canonicalIso(entry.expiresAt, 'subscription_store_corrupt');
  canonicalIso(entry.createdAt, 'subscription_store_corrupt');
  canonicalIso(entry.updatedAt, 'subscription_store_corrupt');
  if (entry.deliveredAt !== null) canonicalIso(entry.deliveredAt, 'subscription_store_corrupt');
  if (entry.lastAttemptAt !== null) canonicalIso(entry.lastAttemptAt, 'subscription_store_corrupt');
  if ((entry.deliveryState === 'delivered') !== (entry.deliveredAt !== null)) {
    throw subscriptionError('subscription_store_corrupt');
  }
  if ((entry.deliveryAttempts === 0) !== (entry.lastAttemptAt === null)
      || (entry.deliveryState === 'active' && entry.deliveryRetryable !== null)
      || (entry.deliveryState === 'pending' && entry.deliveryRetryable !== null)
      || (entry.deliveryState === 'failed' && typeof entry.deliveryRetryable !== 'boolean')
      || (entry.deliveryState === 'delivered' && entry.deliveryRetryable !== false)) {
    throw subscriptionError('subscription_store_corrupt');
  }
  return { ...entry };
}

function upgradeLegacyEntry(entry) {
  if (!entry || Array.isArray(entry) || typeof entry !== 'object') return entry;
  const delivered = entry.deliveryState === 'delivered';
  return {
    ...entry,
    deliveryAttempts: delivered ? 1 : 0,
    lastAttemptAt: delivered ? entry.deliveredAt : null,
    deliveryRetryable: delivered ? false : null,
  };
}

async function durableWrite(filePath, value) {
  const parent = path.dirname(filePath);
  await fsp.mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = path.join(parent, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  if (bytes.length > MAX_FILE_BYTES) throw subscriptionError('subscription_capacity_exceeded');
  let handle;
  try {
    handle = await fsp.open(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL
      | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(temporary, filePath);
    await fsp.chmod(filePath, 0o600);
    const directory = await fsp.open(parent, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await handle?.close().catch(() => {});
    await fsp.unlink(temporary).catch(() => {});
    if (error?.code === 'subscription_capacity_exceeded') throw error;
    throw subscriptionError('subscription_store_unavailable', error);
  }
}

function createQueryNotebookSubscriptions(options = {}) {
  exactKeys(options, ['filePath', 'requesterAgent', 'now', 'maxEntries'],
    'subscription_configuration_invalid');
  if (typeof options.filePath !== 'string' || !path.isAbsolute(options.filePath)
      || path.normalize(options.filePath) !== options.filePath || options.filePath.includes('\0')) {
    throw subscriptionError('subscription_configuration_invalid');
  }
  let requesterAgent;
  try { requesterAgent = assertIdentifier(options.requesterAgent, 'requesterAgent'); } catch (error) {
    throw subscriptionError('subscription_configuration_invalid', error);
  }
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  if (typeof now !== 'function' || !Number.isSafeInteger(maxEntries)
      || maxEntries < 1 || maxEntries > DEFAULT_MAX_ENTRIES) {
    throw subscriptionError('subscription_configuration_invalid');
  }

  async function read() {
    let bytes;
    try {
      const stat = await fsp.lstat(options.filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) {
        throw subscriptionError('subscription_store_corrupt');
      }
      bytes = await fsp.readFile(options.filePath);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      if (error?.code === 'subscription_store_corrupt') throw error;
      throw subscriptionError('subscription_store_unavailable', error);
    }
    try {
      const parsed = JSON.parse(bytes.toString('utf8'));
      exactKeys(parsed, ['version', 'entries'], 'subscription_store_corrupt');
      if (![1, FILE_VERSION].includes(parsed.version) || !Array.isArray(parsed.entries)
          || parsed.entries.length > maxEntries) throw subscriptionError('subscription_store_corrupt');
      const entries = parsed.entries.map((entry) => validateEntry(
        parsed.version === 1 ? upgradeLegacyEntry(entry) : entry,
        requesterAgent,
      ));
      const keys = entries.map((entry) => `${entry.operationId}\0${entry.credentialId}`);
      if (new Set(keys).size !== keys.length) throw subscriptionError('subscription_store_corrupt');
      return entries;
    } catch (error) {
      if (error?.code === 'subscription_store_corrupt') throw error;
      throw subscriptionError('subscription_store_corrupt', error);
    }
  }

  async function write(entries) {
    entries.sort((left, right) => left.operationId.localeCompare(right.operationId)
      || left.credentialId.localeCompare(right.credentialId));
    await durableWrite(options.filePath, { version: FILE_VERSION, entries });
  }

  function queue(task) {
    const prior = fileQueues.get(options.filePath) ?? Promise.resolve();
    const current = prior.catch(() => {}).then(task);
    fileQueues.set(options.filePath, current);
    return current.finally(() => {
      if (fileQueues.get(options.filePath) === current) fileQueues.delete(options.filePath);
    });
  }

  function liveEntries(entries, current) {
    return entries.filter((entry) => Date.parse(entry.expiresAt) > current);
  }

  async function mutate(task) {
    return queue(async () => {
      const source = await read();
      const current = currentMilliseconds(now);
      const entries = liveEntries(source, current);
      const result = await task(entries, current);
      await write(entries);
      return result;
    });
  }

  async function subscribe(rawInput) {
    const input = exactKeys(rawInput, [
      'requesterAgent', 'operationId', 'credentialId', 'deviceId', 'generation',
      'expiresAt', 'terminalState',
    ]);
    if (input.requesterAgent !== requesterAgent) throw subscriptionError('access_denied');
    try {
      assertOperationId(input.operationId);
      assertIdentifier(input.credentialId, 'credentialId');
      assertIdentifier(input.deviceId, 'deviceId');
    } catch (error) {
      throw subscriptionError('subscription_invalid', error);
    }
    if (!Number.isSafeInteger(input.generation) || input.generation < 1
        || (input.terminalState !== null && !TERMINAL_STATES.has(input.terminalState))) {
      throw subscriptionError('subscription_invalid');
    }
    const expiry = canonicalIso(input.expiresAt);
    return mutate(async (entries, current) => {
      if (expiry <= current) throw subscriptionError('subscription_expired');
      let entry = entries.find((candidate) => candidate.operationId === input.operationId
        && candidate.credentialId === input.credentialId);
      const timestamp = new Date(current).toISOString();
      if (!entry) {
        if (entries.length >= maxEntries) throw subscriptionError('subscription_capacity_exceeded');
        entry = {
          requesterAgent,
          operationId: input.operationId,
          credentialId: input.credentialId,
          deviceId: input.deviceId,
          generation: input.generation,
          expiresAt: input.expiresAt,
          routeId: stableRouteId(requesterAgent, input.operationId, input.credentialId),
          deliveryState: input.terminalState === null ? 'active' : 'pending',
          terminalState: input.terminalState,
          createdAt: timestamp,
          updatedAt: timestamp,
          deliveredAt: null,
          deliveryAttempts: 0,
          lastAttemptAt: null,
          deliveryRetryable: null,
        };
        entries.push(entry);
      } else {
        const generationChanged = entry.generation !== input.generation;
        entry.deviceId = input.deviceId;
        entry.generation = input.generation;
        entry.expiresAt = input.expiresAt;
        entry.updatedAt = timestamp;
        if (generationChanged) {
          entry.deliveryAttempts = 0;
          entry.lastAttemptAt = null;
          entry.deliveryRetryable = null;
          entry.deliveredAt = null;
          entry.deliveryState = input.terminalState === null ? 'active' : 'pending';
          entry.terminalState = input.terminalState;
        }
        if (input.terminalState !== null && entry.deliveryState === 'active') {
          entry.deliveryState = 'pending';
          entry.terminalState = input.terminalState;
        } else if (input.terminalState !== null
            && entry.deliveryState === 'failed'
            && entry.deliveryRetryable === true) {
          entry.deliveryState = 'pending';
          entry.deliveryRetryable = null;
        }
      }
      return { ...entry };
    });
  }

  async function unsubscribe(rawInput) {
    const input = exactKeys(rawInput, ['requesterAgent', 'operationId', 'credentialId']);
    if (input.requesterAgent !== requesterAgent) throw subscriptionError('access_denied');
    try {
      assertOperationId(input.operationId);
      assertIdentifier(input.credentialId, 'credentialId');
    } catch (error) {
      throw subscriptionError('subscription_invalid', error);
    }
    return mutate(async (entries) => {
      const index = entries.findIndex((entry) => entry.operationId === input.operationId
        && entry.credentialId === input.credentialId);
      if (index < 0) return false;
      entries.splice(index, 1);
      return true;
    });
  }

  async function markTerminalPending(rawInput) {
    const input = exactKeys(rawInput, ['requesterAgent', 'operationId', 'terminalState']);
    if (input.requesterAgent !== requesterAgent) throw subscriptionError('access_denied');
    try { assertOperationId(input.operationId); } catch (error) {
      throw subscriptionError('subscription_invalid', error);
    }
    if (!TERMINAL_STATES.has(input.terminalState)) throw subscriptionError('subscription_invalid');
    return markTerminalPendingBatch({
      terminals: [{ operationId: input.operationId, terminalState: input.terminalState }],
    });
  }

  async function markTerminalPendingBatch(rawInput) {
    const input = exactKeys(rawInput, ['terminals']);
    if (!Array.isArray(input.terminals) || input.terminals.length > maxEntries) {
      throw subscriptionError('subscription_invalid');
    }
    const terminalByOperation = new Map();
    for (const rawTerminal of input.terminals) {
      const terminal = exactKeys(rawTerminal, ['operationId', 'terminalState']);
      try { assertOperationId(terminal.operationId); } catch (error) {
        throw subscriptionError('subscription_invalid', error);
      }
      if (!TERMINAL_STATES.has(terminal.terminalState)
          || terminalByOperation.has(terminal.operationId)) {
        throw subscriptionError('subscription_invalid');
      }
      terminalByOperation.set(terminal.operationId, terminal.terminalState);
    }
    return mutate(async (entries, current) => {
      const timestamp = new Date(current).toISOString();
      const affected = [];
      for (const entry of entries) {
        const terminalState = terminalByOperation.get(entry.operationId);
        if (!terminalState) continue;
        if (entry.deliveryState === 'active') {
          entry.deliveryState = 'pending';
          entry.terminalState = terminalState;
          entry.updatedAt = timestamp;
        }
        affected.push({ ...entry });
      }
      return affected;
    });
  }

  async function markDelivered(rawInput) {
    const input = exactKeys(rawInput, ['routeId']);
    try { assertIdentifier(input.routeId, 'routeId'); } catch (error) {
      throw subscriptionError('subscription_invalid', error);
    }
    return mutate(async (entries, current) => {
      const entry = entries.find((candidate) => candidate.routeId === input.routeId);
      if (!entry) throw subscriptionError('subscription_not_found');
      // Preserve the original single-route API: callers that predate explicit
      // delivery claims may settle a terminal pending route directly. The
      // production batch path still requires claimDeliveries first.
      if (entry.deliveryState === 'pending') {
        entry.deliveryState = 'delivered';
        entry.deliveredAt = new Date(current).toISOString();
        entry.deliveryRetryable = false;
        entry.updatedAt = entry.deliveredAt;
      }
      return { ...entry };
    });
  }

  async function markDeliveryPending(rawInput) {
    const input = exactKeys(rawInput, ['routeId']);
    try { assertIdentifier(input.routeId, 'routeId'); } catch (error) {
      throw subscriptionError('subscription_invalid', error);
    }
    const [entry] = await claimDeliveries({ routeIds: [input.routeId] });
    if (!entry) throw subscriptionError('subscription_not_retryable');
    return entry;
  }

  async function markDeliveryFailed(rawInput) {
    const input = exactKeys(rawInput, ['routeId', 'retryable']);
    try { assertIdentifier(input.routeId, 'routeId'); } catch (error) {
      throw subscriptionError('subscription_invalid', error);
    }
    if (typeof input.retryable !== 'boolean') throw subscriptionError('subscription_invalid');
    const [entry] = await settleDeliveries({
      results: [{ routeId: input.routeId, state: 'failed', retryable: input.retryable }],
    });
    if (!entry) throw subscriptionError('subscription_not_found');
    return entry;
  }

  async function claimDeliveries(rawInput) {
    const input = exactKeys(rawInput, ['routeIds']);
    if (!Array.isArray(input.routeIds) || input.routeIds.length < 1
        || input.routeIds.length > maxEntries
        || new Set(input.routeIds).size !== input.routeIds.length) {
      throw subscriptionError('subscription_invalid');
    }
    for (const routeId of input.routeIds) {
      try { assertIdentifier(routeId, 'routeId'); } catch (error) {
        throw subscriptionError('subscription_invalid', error);
      }
    }
    return mutate(async (entries, current) => {
      const wanted = new Set(input.routeIds);
      const timestamp = new Date(current).toISOString();
      const claimed = [];
      for (const entry of entries) {
        if (!wanted.has(entry.routeId)
            || entry.deliveryState === 'delivered'
            || entry.deliveryState === 'active'
            || (entry.deliveryState === 'failed' && entry.deliveryRetryable === false)) continue;
        entry.deliveryState = 'pending';
        entry.deliveryAttempts += 1;
        entry.lastAttemptAt = timestamp;
        entry.deliveryRetryable = null;
        entry.updatedAt = timestamp;
        claimed.push({ ...entry });
      }
      return claimed;
    });
  }

  async function settleDeliveries(rawInput) {
    const input = exactKeys(rawInput, ['results']);
    if (!Array.isArray(input.results) || input.results.length < 1
        || input.results.length > maxEntries) throw subscriptionError('subscription_invalid');
    const normalized = new Map();
    for (const rawResult of input.results) {
      const result = exactKeys(rawResult, ['routeId', 'state', 'retryable']);
      try { assertIdentifier(result.routeId, 'routeId'); } catch (error) {
        throw subscriptionError('subscription_invalid', error);
      }
      if (!['delivered', 'failed'].includes(result.state)
          || (result.state === 'failed' && typeof result.retryable !== 'boolean')
          || (result.state === 'delivered' && result.retryable !== undefined)
          || normalized.has(result.routeId)) throw subscriptionError('subscription_invalid');
      normalized.set(result.routeId, result);
    }
    return mutate(async (entries, current) => {
      const timestamp = new Date(current).toISOString();
      const settled = [];
      for (const entry of entries) {
        const result = normalized.get(entry.routeId);
        if (!result) continue;
        if (entry.deliveryState === 'delivered') {
          settled.push({ ...entry });
          continue;
        }
        if (entry.deliveryState === 'active' || entry.deliveryAttempts < 1) {
          throw subscriptionError('subscription_invalid');
        }
        if (result.state === 'delivered') {
          entry.deliveryState = 'delivered';
          entry.deliveredAt = timestamp;
          entry.deliveryRetryable = false;
        } else {
          entry.deliveryState = 'failed';
          entry.deliveredAt = null;
          entry.deliveryRetryable = result.retryable;
        }
        entry.updatedAt = timestamp;
        settled.push({ ...entry });
      }
      return settled;
    });
  }

  async function listActive(rawInput = {}) {
    const input = exactKeys(rawInput, ['operationId']);
    if (input.operationId !== undefined) {
      try { assertOperationId(input.operationId); } catch (error) {
        throw subscriptionError('subscription_invalid', error);
      }
    }
    return queue(async () => {
      const source = await read();
      const entries = liveEntries(source, currentMilliseconds(now));
      if (entries.length !== source.length) await write(entries);
      return entries
        .filter((entry) => input.operationId === undefined || entry.operationId === input.operationId)
        .map((entry) => ({ ...entry }));
    });
  }

  return Object.freeze({
    listActive,
    claimDeliveries,
    markDeliveryFailed,
    markDeliveryPending,
    markDelivered,
    markTerminalPending,
    markTerminalPendingBatch,
    settleDeliveries,
    subscribe,
    unsubscribe,
  });
}

module.exports = {
  createQueryNotebookSubscriptions,
};
