import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  ensureBrainOperationsCapabilityKey,
  inspectBrainOperationsCapabilityState,
  readStableFileSnapshot,
  snapshotsEqual,
} from './brain-operations-capability.js';
import { generateEcosystem } from './generate-ecosystem.js';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const { deriveMemoryAuthorityAttestationKey } = require('../../shared/memory-authority-attestation.cjs');
const CAPABILITY_ENV = 'HOME23_BRAIN_OPERATIONS_CAPABILITY_KEY';
const AUTHORITY_ENV = 'HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY';
const DRY_RUN_CAPABILITY = '0'.repeat(64);

function commandError(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function statIdentity(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs]
    .map((value) => value.toString())
    .join(':');
}

async function rendererInputFingerprint(home23Root) {
  const hash = createHash('sha256');
  for (const relativePath of ['config/home.yaml', 'config/secrets.yaml']) {
    const snapshot = await readStableFileSnapshot(path.join(home23Root, relativePath));
    hash.update(relativePath);
    hash.update(snapshot.exists ? statIdentity(snapshot.identity) : 'absent');
    if (snapshot.exists) hash.update(snapshot.bytes);
  }

  const instancesPath = path.join(home23Root, 'instances');
  let directoryBefore;
  try {
    directoryBefore = await fs.promises.lstat(instancesPath, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') return hash.update('instances:absent').digest('hex');
    throw error;
  }
  if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()) {
    throw commandError('preparation_state_changed');
  }
  const names = (await fs.promises.readdir(instancesPath)).sort();
  hash.update(`instances:${statIdentity(directoryBefore)}:${names.join('\0')}`);
  for (const name of names) {
    const entryPath = path.join(instancesPath, name);
    const entry = await fs.promises.lstat(entryPath, { bigint: true });
    hash.update(`entry:${name}:${statIdentity(entry)}:${entry.isDirectory()}:${entry.isSymbolicLink()}`);
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const configPath = path.join(entryPath, 'config.yaml');
    const config = await readStableFileSnapshot(configPath);
    hash.update(`config:${name}:${config.exists ? statIdentity(config.identity) : 'absent'}`);
    if (config.exists) hash.update(config.bytes);
  }
  const directoryAfter = await fs.promises.lstat(instancesPath, { bigint: true });
  if (statIdentity(directoryBefore) !== statIdentity(directoryAfter)) {
    throw commandError('preparation_state_changed');
  }
  return hash.digest('hex');
}

async function assertCapabilityStillPrepared(home23Root, capabilityKey) {
  const current = await inspectBrainOperationsCapabilityState(home23Root);
  if (current.capabilityKey !== capabilityKey || current.secretsModeBefore !== '0600') {
    throw commandError('preparation_state_changed');
  }
}

async function listProcessesDefault() {
  const { stdout } = await execFileAsync('pm2', ['jlist'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

function envEvidence(row, environmentName) {
  const raw = row?.pm2_env;
  const direct = raw && Object.hasOwn(raw, environmentName) ? raw[environmentName] : undefined;
  const nested = raw?.env && Object.hasOwn(raw.env, environmentName)
    ? raw.env[environmentName]
    : undefined;
  const normalized = row?.env && Object.hasOwn(row.env, environmentName)
    ? row.env[environmentName]
    : undefined;
  const values = [direct, nested, normalized].filter((value) => value !== undefined);
  if (new Set(values).size > 1) throw commandError('pm2_environment_disagreement');
  return values[0];
}

function rowStatus(row) {
  const rawStatus = row?.pm2_env?.status;
  const normalizedStatus = row?.status;
  if (rawStatus !== undefined && normalizedStatus !== undefined && rawStatus !== normalizedStatus) {
    throw commandError('pm2_status_disagreement');
  }
  return rawStatus ?? normalizedStatus ?? 'unknown';
}

function expectedEnvironment(name, capabilityKey, authorityKey) {
  const requiresCapability = name === 'home23-cosmo23' || name.endsWith('-dash');
  return {
    [CAPABILITY_ENV]: requiresCapability ? capabilityKey : undefined,
    [AUTHORITY_ENV]: authorityKey,
  };
}

function inspectLiveEnvironment(
  rows,
  configuredProcessNames,
  capabilityKey,
  authorityKey,
  forceOnlineStale = false,
) {
  if (!Array.isArray(rows)) throw commandError('pm2_inspection_invalid');
  const configured = new Set(configuredProcessNames);
  const seen = new Map();
  for (const row of rows) {
    if (!row || typeof row.name !== 'string' || !configured.has(row.name)) continue;
    if (seen.has(row.name)) throw commandError('pm2_duplicate_process');
    seen.set(row.name, row);
  }
  let allCurrent = true;
  for (const name of configuredProcessNames) {
    const row = seen.get(name);
    if (!row || rowStatus(row) !== 'online') {
      allCurrent = false;
      continue;
    }
    const expected = expectedEnvironment(name, capabilityKey, authorityKey);
    if (forceOnlineStale || Object.entries(expected).some(
      ([environmentName, value]) => envEvidence(row, environmentName) !== value,
    )) allCurrent = false;
  }
  return allCurrent ? [] : [...configuredProcessNames];
}

async function syncDirectory(directoryPath) {
  const directory = await fs.promises.open(directoryPath, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function writeEcosystemAtomic(filePath, source, baseline) {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    const existingMode = baseline.exists ? Number(baseline.identity.mode & 0o777n) : 0o644;
    handle = await fs.promises.open(temporary, 'wx', existingMode || 0o644);
    await handle.writeFile(source, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    const current = await readStableFileSnapshot(filePath);
    if (!snapshotsEqual(baseline, current)) throw commandError('preparation_state_changed');
    await fs.promises.rename(temporary, filePath);
    await syncDirectory(path.dirname(filePath));
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
  }
}

async function inspectPm2(
  dependencies,
  configuredProcessNames,
  capabilityKey,
  authorityKey,
  forceOnlineStale = false,
) {
  try {
    const rows = await dependencies.listProcesses();
    return {
      changedProcessNames: inspectLiveEnvironment(
        rows,
        configuredProcessNames,
        capabilityKey,
        authorityKey,
        forceOnlineStale,
      ),
      liveEnvVerified: true,
    };
  } catch {
    return {
      changedProcessNames: [...configuredProcessNames],
      liveEnvVerified: false,
    };
  }
}

export async function prepareBrainOperationsCapability(home23Root, options = {}) {
  const dryRun = options.dryRun === true;
  const dependencies = {
    listProcesses: listProcessesDefault,
    ...options,
  };
  const ecosystemPath = path.join(home23Root, 'ecosystem.config.cjs');
  let keyCreated = false;
  let keyWouldBeCreated = false;
  let permissionsRepaired = false;
  let permissionsWouldBeRepaired = false;
  let secretsModeBefore = null;
  let secretsModeAfter = null;
  let capabilityKey;
  let ecosystemBefore;
  let rendered;

  if (dryRun) {
    const rendererBefore = await rendererInputFingerprint(home23Root);
    const inspection = await inspectBrainOperationsCapabilityState(home23Root);
    ecosystemBefore = await readStableFileSnapshot(ecosystemPath);
    capabilityKey = inspection.capabilityKey || DRY_RUN_CAPABILITY;
    keyWouldBeCreated = inspection.keyWouldBeCreated;
    permissionsWouldBeRepaired = inspection.permissionsWouldBeRepaired;
    secretsModeBefore = inspection.secretsModeBefore;
    secretsModeAfter = inspection.secretsModeAfter;
    rendered = generateEcosystem(home23Root, {
      capabilityKey,
      writeEcosystem: false,
      writeManifest: false,
      quiet: true,
    });
    await dependencies.afterInspection?.();
    const rendererAfter = await rendererInputFingerprint(home23Root);
    const secretsAfter = await readStableFileSnapshot(path.join(home23Root, 'config', 'secrets.yaml'));
    const ecosystemAfter = await readStableFileSnapshot(ecosystemPath);
    if (rendererBefore !== rendererAfter
        || !snapshotsEqual(inspection.snapshot, secretsAfter)
        || !snapshotsEqual(ecosystemBefore, ecosystemAfter)) {
      throw commandError('preparation_state_changed');
    }
  } else {
    const ensured = await ensureBrainOperationsCapabilityKey(home23Root, options);
    capabilityKey = ensured.capabilityKey;
    keyCreated = ensured.keyCreated;
    permissionsRepaired = ensured.permissionsRepaired;
    secretsModeBefore = ensured.secretsModeBefore;
    secretsModeAfter = ensured.secretsModeAfter;
    ecosystemBefore = await readStableFileSnapshot(ecosystemPath);
    const rendererBefore = await rendererInputFingerprint(home23Root);
    rendered = generateEcosystem(home23Root, {
      capabilityKey,
      writeEcosystem: false,
      writeManifest: false,
      quiet: true,
    });
    const rendererAfter = await rendererInputFingerprint(home23Root);
    if (rendererBefore !== rendererAfter) throw commandError('preparation_state_changed');
    await assertCapabilityStillPrepared(home23Root, capabilityKey);
  }

  if (!rendered?.ecosystemSource || rendered.configuredProcessNames.length === 0) {
    throw commandError('brain_operations_not_configured');
  }
  const ecosystemWouldChange = !ecosystemBefore.exists
    || !ecosystemBefore.bytes.equals(Buffer.from(rendered.ecosystemSource, 'utf8'));
  let ecosystemRegenerated = false;
  if (!dryRun && ecosystemWouldChange) {
    await writeEcosystemAtomic(ecosystemPath, rendered.ecosystemSource, ecosystemBefore);
    ecosystemRegenerated = true;
  }

  const live = await inspectPm2(
    dependencies,
    rendered.configuredProcessNames,
    capabilityKey,
    deriveMemoryAuthorityAttestationKey(capabilityKey),
    dryRun && keyWouldBeCreated,
  );
  if (!dryRun) await assertCapabilityStillPrepared(home23Root, capabilityKey);
  const filesystemChanged = keyCreated || permissionsRepaired || ecosystemRegenerated;
  const filesystemWouldChange = filesystemChanged
    || keyWouldBeCreated
    || permissionsWouldBeRepaired
    || ecosystemWouldChange;
  return {
    dryRun,
    filesystemChanged,
    filesystemWouldChange,
    keyCreated,
    keyWouldBeCreated,
    permissionsRepaired,
    permissionsWouldBeRepaired,
    secretsModeBefore,
    secretsModeAfter,
    ecosystemRegenerated,
    ecosystemWouldChange,
    configuredProcessNames: [...rendered.configuredProcessNames],
    changedProcessNames: live.changedProcessNames,
    restartRequired: live.changedProcessNames.length > 0,
    liveEnvVerified: live.liveEnvVerified,
  };
}

function projectOperatorOperation(record) {
  return {
    operationId: record.operationId,
    requestId: record.requestId,
    operationType: record.operationType,
    requesterAgent: record.requesterAgent,
    target: record.target,
    state: record.state,
    phase: record.phase,
    recordVersion: record.recordVersion,
    eventSequence: record.eventSequence,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt,
    lastProviderActivityAt: record.lastProviderActivityAt,
    lastProgressAt: record.lastProgressAt,
  };
}

function isCanonicalDirectory(stat) {
  return stat.isDirectory() && !stat.isSymbolicLink();
}

async function readCanonicalDirectory(directoryPath, { optional = false } = {}) {
  try {
    const before = await fs.promises.lstat(directoryPath, { bigint: true });
    if (!isCanonicalDirectory(before)) throw commandError('brain_operations_store_invalid');
    const entries = await fs.promises.readdir(directoryPath, { withFileTypes: true });
    const after = await fs.promises.lstat(directoryPath, { bigint: true });
    if (!isCanonicalDirectory(after) || before.dev !== after.dev || before.ino !== after.ino) {
      throw commandError('brain_operations_store_invalid');
    }
    return entries;
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    if (error.code === 'brain_operations_store_invalid') throw error;
    throw commandError('brain_operations_store_invalid', error);
  }
}

async function listBrainOperations(home23Root, dependencies) {
  const instancesRoot = path.join(home23Root, 'instances');
  const instanceEntries = await readCanonicalDirectory(instancesRoot, { optional: true });
  const createStoreReader = dependencies.createStoreReader
    || require('../../engine/src/dashboard/brain-operations/store-reader.js')
      .createBrainOperationStoreReader;
  if (typeof createStoreReader !== 'function') throw commandError('brain_operations_store_invalid');

  const requesters = [];
  const operations = [];
  for (const entry of (instanceEntries || []).sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) throw commandError('brain_operations_store_invalid');
    if (!entry.isDirectory()) continue;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(entry.name)) {
      throw commandError('brain_operations_store_invalid');
    }
    const instanceRoot = path.join(instancesRoot, entry.name);
    if (await readCanonicalDirectory(instanceRoot, { optional: false }) === null) {
      throw commandError('brain_operations_store_invalid');
    }
    const runtimeRoot = path.join(instanceRoot, 'runtime');
    if (await readCanonicalDirectory(runtimeRoot, { optional: true }) === null) continue;
    const operationsRoot = path.join(runtimeRoot, 'brain-operations');
    if (await readCanonicalDirectory(operationsRoot, { optional: true }) === null) continue;

    let records;
    try {
      records = await createStoreReader({
        operationsRoot,
        expectedRequester: entry.name,
      }).listNonterminalAuthorized();
    } catch (error) {
      throw commandError('brain_operations_store_invalid', error);
    }
    if (!Array.isArray(records)
        || records.some((record) => record?.requesterAgent !== entry.name
          || (record.state !== 'queued' && record.state !== 'running'))) {
      throw commandError('brain_operations_store_invalid');
    }
    requesters.push(entry.name);
    for (const record of records) operations.push(projectOperatorOperation(record));
  }

  operations.sort((left, right) => left.requesterAgent.localeCompare(right.requesterAgent)
    || left.operationId.localeCompare(right.operationId));
  const now = dependencies.now ? dependencies.now() : new Date();
  const checkedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  return { checkedAt, requesters, operations, count: operations.length };
}

export async function runBrainOperationsCommand(home23Root, args, dependencies = {}) {
  if (!Array.isArray(args)) throw commandError('brain_operations_usage');
  if (args[0] === 'prepare'
      && args.length <= 2
      && (args.length === 1 || args[1] === '--dry-run')) {
    return prepareBrainOperationsCapability(home23Root, {
      ...dependencies,
      dryRun: args[1] === '--dry-run',
    });
  }
  if (args.length === 4
      && args[0] === 'list'
      && args[1] === '--state'
      && args[2] === 'nonterminal'
      && args[3] === '--all-requesters') {
    return listBrainOperations(home23Root, dependencies);
  }
  throw commandError('brain_operations_usage');
}

export function buildScopedPm2RefreshArgs(receipt, rendererAuthorizedProcessNames) {
  if (!isRendererAuthorizedScope(rendererAuthorizedProcessNames)) {
    throw commandError('configured_processes_unauthorized');
  }
  if (!receipt?.restartRequired) throw commandError('refresh_not_required');
  if (receipt.liveEnvVerified !== true) throw commandError('live_env_unverified');
  const configured = receipt.configuredProcessNames;
  const changed = receipt.changedProcessNames;
  if (!Array.isArray(configured)
      || configured.length !== rendererAuthorizedProcessNames.length
      || configured.some((name, index) => name !== rendererAuthorizedProcessNames[index])) {
    throw commandError('configured_processes_unauthorized');
  }
  if (!Array.isArray(changed)
      || changed.length !== rendererAuthorizedProcessNames.length
      || changed.some((name, index) => name !== rendererAuthorizedProcessNames[index])) {
    throw commandError('changed_processes_invalid');
  }
  return [
    'start',
    'ecosystem.config.cjs',
    '--only',
    rendererAuthorizedProcessNames.join(','),
    '--update-env',
  ];
}

function isRendererAuthorizedScope(configured) {
  if (!Array.isArray(configured) || configured.length < 4
      || new Set(configured).size !== configured.length
      || configured.at(-1) !== 'home23-cosmo23') return false;
  let index = 0;
  while (index < configured.length - 1) {
    const engineName = configured[index];
    if (!/^home23-[a-z0-9][a-z0-9-]*$/.test(engineName)
        || engineName === 'home23-cosmo23'
        || configured[index + 1] !== `${engineName}-dash`) return false;
    index += 2;
    if (configured[index] === `${engineName}-mcp`) index += 1;
    if (configured[index] !== `${engineName}-harness`) return false;
    index += 1;
  }
  return index === configured.length - 1;
}
