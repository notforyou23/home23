#!/usr/bin/env node

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020');
const SCHEMA = JSON.parse(readFileSync(
  path.join(REPO_ROOT, 'contracts/schemas/query-notebook.schema.json'), 'utf8',
));
const QUERY_SCHEMA = JSON.parse(readFileSync(
  path.join(REPO_ROOT, 'contracts/schemas/query.schema.json'), 'utf8',
));
const ajv = new Ajv2020({ strict: false, allErrors: true, allowUnionTypes: true });
ajv.addSchema(SCHEMA, SCHEMA.$id);
ajv.addSchema(QUERY_SCHEMA, QUERY_SCHEMA.$id);
const validators = new Map();

const OPERATION_ID = /^brop_[A-Za-z0-9_-]{32}$/u;
const RESULT_VERSION = /^qrv1_[A-Za-z0-9_-]{43}$/u;
const REQUEST_ID = /^qreq_[A-Za-z0-9_-]{32}$/u;
const CREDENTIAL_ID = /^qncred_[A-Za-z0-9_-]{32}$/u;
const TERMINAL = new Set(['complete', 'partial', 'failed', 'cancelled', 'interrupted']);
const SUCCESS = new Set(['complete', 'partial']);
const SENSITIVE_KEY = /(?:authorization|cookie|token|secret|password|api[_-]?key|answer|privateContext|priorContext)/iu;

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_OVERALL_TIMEOUT_MS = 2 * 60 * 60_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_RECEIPT_BYTES = 512 * 1024;

export const HELP = `Usage:
  node scripts/verify-query-follow-up-live.mjs \\
    --agent <agent> \\
    --dashboard-url <protected-dashboard-origin> \\
    --harness-url <selected-agent-bridge-origin> \\
    --bridge-token-file <0600-nonsymlink-file> \\
    --output <receipt.json>

Optional existing terminal parent (both values are required together):
  --parent-operation-id <brop_...> --parent-result-version <qrv1_...>

The verifier enrolls a short-lived Query credential, proves legacy and opted
projections, starts a Direct root when no parent is supplied, then starts a
verified child and grandchild. It never writes credentials, answers, or private
follow-up context to its receipt.
`;

function errorWithCode(code, message = code, fields = {}) {
  return Object.assign(new Error(message), { code, ...fields });
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalOrigin(value, name) {
  let url;
  try { url = new URL(value); } catch (cause) {
    throw errorWithCode('url_invalid', `${name} must be an absolute HTTP origin`, { cause });
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw errorWithCode('url_invalid', `${name} must be an HTTP origin without credentials or path`);
  }
  return url.origin;
}

function integerOption(raw, name, fallback, minimum, maximum) {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw errorWithCode('invalid_argument', `--${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function parseArgv(argv) {
  const values = Object.create(null);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') { values.help = true; continue; }
    if (!token.startsWith('--') || token === '--') throw errorWithCode('invalid_argument');
    const equals = token.indexOf('=');
    const key = token.slice(2, equals < 0 ? undefined : equals);
    let value;
    if (equals >= 0) value = token.slice(equals + 1);
    else {
      value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw errorWithCode('invalid_argument');
      index += 1;
    }
    if (Object.hasOwn(values, key)) throw errorWithCode('duplicate_argument');
    values[key] = value;
  }
  return values;
}

export function parseOptions(argv = process.argv.slice(2)) {
  const values = parseArgv(argv);
  if (values.help) return { help: true };
  const allowed = new Set([
    'agent', 'dashboard-url', 'harness-url', 'bridge-token-file', 'output',
    'parent-operation-id', 'parent-result-version', 'poll-ms',
    'connect-timeout-ms', 'request-timeout-ms', 'overall-timeout-ms',
    'max-response-bytes', 'max-receipt-bytes',
  ]);
  if (Object.keys(values).some((key) => !allowed.has(key))) {
    throw errorWithCode('invalid_argument');
  }
  if (typeof values.agent !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u.test(values.agent)) {
    throw errorWithCode('missing_argument', '--agent is required');
  }
  for (const key of ['dashboard-url', 'harness-url', 'bridge-token-file', 'output']) {
    if (typeof values[key] !== 'string' || !values[key] || values[key].includes('\0')) {
      throw errorWithCode('missing_argument', `--${key} is required`);
    }
  }
  const parentOperationId = values['parent-operation-id'];
  const parentResultVersion = values['parent-result-version'];
  if ((parentOperationId === undefined) !== (parentResultVersion === undefined)
      || (parentOperationId !== undefined
        && (!OPERATION_ID.test(parentOperationId) || !RESULT_VERSION.test(parentResultVersion)))) {
    throw errorWithCode('parent_reference_invalid');
  }
  return {
    agent: values.agent,
    dashboardUrl: canonicalOrigin(values['dashboard-url'], 'dashboard URL'),
    harnessUrl: canonicalOrigin(values['harness-url'], 'harness URL'),
    bridgeTokenFile: path.resolve(values['bridge-token-file']),
    output: path.resolve(values.output),
    parentOperationId,
    parentResultVersion,
    pollMs: integerOption(values['poll-ms'], 'poll-ms', 2_000, 100, 60_000),
    connectTimeoutMs: integerOption(values['connect-timeout-ms'], 'connect-timeout-ms',
      DEFAULT_CONNECT_TIMEOUT_MS, 100, 300_000),
    requestTimeoutMs: integerOption(values['request-timeout-ms'], 'request-timeout-ms',
      DEFAULT_REQUEST_TIMEOUT_MS, 100, 300_000),
    overallTimeoutMs: integerOption(values['overall-timeout-ms'], 'overall-timeout-ms',
      DEFAULT_OVERALL_TIMEOUT_MS, 1_000, 24 * 60 * 60_000),
    maxResponseBytes: integerOption(values['max-response-bytes'], 'max-response-bytes',
      DEFAULT_MAX_RESPONSE_BYTES, 1_024, 16 * 1024 * 1024),
    maxReceiptBytes: integerOption(values['max-receipt-bytes'], 'max-receipt-bytes',
      DEFAULT_MAX_RECEIPT_BYTES, 16 * 1024, 16 * 1024 * 1024),
  };
}

function validateProjection(definition, value) {
  let validate = validators.get(definition);
  if (!validate) {
    if (!Object.hasOwn(SCHEMA.$defs, definition)) throw errorWithCode('public_projection_invalid');
    validate = ajv.compile({ $ref: `${SCHEMA.$id}#/$defs/${definition}` });
    validators.set(definition, validate);
  }
  if (!validate(value)) throw errorWithCode('public_projection_invalid');
  return value;
}

function validateQueryProjection(definition, value) {
  const key = `query:${definition}`;
  let validate = validators.get(key);
  if (!validate) {
    if (!Object.hasOwn(QUERY_SCHEMA.$defs, definition)) {
      throw errorWithCode('public_projection_invalid');
    }
    validate = ajv.compile({ $ref: `${QUERY_SCHEMA.$id}#/$defs/${definition}` });
    validators.set(key, validate);
  }
  if (!validate(value)) throw errorWithCode('public_projection_invalid');
  return value;
}

async function boundedBody(response, maxBytes, controller, requestTimeoutMs, overallSignal,
  stopAfter) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw errorWithCode('response_too_large');
  if (!response.body) return '';
  const timer = setTimeout(() => controller.abort(errorWithCode('request_timeout')),
    requestTimeoutMs);
  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) {
        controller.abort(errorWithCode('response_too_large'));
        throw errorWithCode('response_too_large');
      }
      chunks.push(buffer);
      if (stopAfter && Buffer.concat(chunks).includes(stopAfter)) break;
    }
  } catch (error) {
    if (overallSignal?.aborted) throw overallSignal.reason;
    if (controller.signal.aborted && controller.signal.reason?.code) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const collected = Buffer.concat(chunks).toString('utf8');
  if (!stopAfter) return collected;
  const boundary = collected.indexOf(stopAfter);
  return boundary < 0 ? collected : collected.slice(0, boundary + stopAfter.length);
}

export async function requestText(url, {
  fetchImpl = fetch, method = 'GET', headers = {}, body,
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_RESPONSE_BYTES,
  expectedStatuses,
  overallSignal,
  stopAfter,
} = {}) {
  if (overallSignal?.aborted) throw overallSignal.reason;
  const controller = new AbortController();
  const signal = overallSignal
    ? AbortSignal.any([controller.signal, overallSignal]) : controller.signal;
  const connectTimer = setTimeout(() => controller.abort(errorWithCode('connect_timeout')),
    connectTimeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      method, headers: { accept: 'application/json', ...headers }, body, signal,
    });
  } catch (error) {
    if (overallSignal?.aborted) throw overallSignal.reason;
    if (controller.signal.aborted && controller.signal.reason?.code) throw controller.signal.reason;
    throw errorWithCode('connect_failed', 'connection failed', { cause: error });
  } finally {
    clearTimeout(connectTimer);
  }
  const text = await boundedBody(
    response, maxBytes, controller, requestTimeoutMs, overallSignal, stopAfter,
  );
  if (expectedStatuses) {
    if (!expectedStatuses.includes(response.status)) {
      throw errorWithCode('unexpected_http_status', undefined, { status: response.status });
    }
  } else if (!response.ok) {
    let value;
    try { value = JSON.parse(text); } catch { value = null; }
    const code = value?.error?.code ?? value?.error ?? 'http_request_failed';
    throw errorWithCode(typeof code === 'string' ? code : 'http_request_failed', undefined, {
      status: response.status,
    });
  }
  return { response, text };
}

export async function requestJson(url, options = {}) {
  const result = await requestText(url, options);
  let value;
  try { value = result.text ? JSON.parse(result.text) : null; } catch (cause) {
    throw errorWithCode('response_json_invalid', undefined, { cause, status: result.response.status });
  }
  return { ...result, value };
}

async function loadBridgeToken(filename) {
  const before = await fsp.lstat(filename).catch((cause) => {
    throw errorWithCode('bridge_token_file_unsafe', undefined, { cause });
  });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
      || before.size < 1 || before.size > 4_096 || (before.mode & 0o077) !== 0) {
    throw errorWithCode('bridge_token_file_unsafe');
  }
  const token = (await fsp.readFile(filename, 'utf8')).trim();
  const after = await fsp.lstat(filename);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || !token || /\s/u.test(token)) throw errorWithCode('bridge_token_file_unsafe');
  return token;
}

function route(origin, pathname) {
  return new URL(pathname, `${origin}/`).toString();
}

function requestId() {
  return `qreq_${randomBytes(24).toString('base64url')}`;
}

function requestDefaults(options, signal) {
  return {
    connectTimeoutMs: options.connectTimeoutMs,
    requestTimeoutMs: options.requestTimeoutMs,
    maxBytes: options.maxResponseBytes,
    overallSignal: signal,
  };
}

function deviceHeaders(credential) {
  return {
    authorization: `Bearer ${credential.token}`,
    'x-home23-device-id': credential.credentialId,
  };
}

async function enroll(options, bridgeToken, signal) {
  const installationId = `follow-up-acceptance-${randomBytes(16).toString('hex')}`;
  const response = await requestJson(route(options.harnessUrl, '/api/device/query-credential'), {
    ...requestDefaults(options, signal), method: 'POST',
    headers: { authorization: `Bearer ${bridgeToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ installationId, agent: options.agent }),
  });
  const credential = validateProjection('queryNotebookDeviceCredential', response.value);
  if (!CREDENTIAL_ID.test(credential.credentialId) || typeof credential.token !== 'string'
      || !credential.token || !Number.isSafeInteger(credential.generation)
      || credential.generation < 1 || !Number.isFinite(Date.parse(credential.expiresAt))) {
    throw errorWithCode('public_projection_invalid');
  }
  return credential;
}

function assertCatalog(catalog, agent) {
  const pair = { provider: catalog?.defaults?.provider, model: catalog?.defaults?.model };
  if (catalog?.agent !== agent || catalog?.available !== true
      || typeof catalog?.selectedBrain?.id !== 'string' || !catalog.selectedBrain.id
      || typeof pair.provider !== 'string' || !pair.provider
      || typeof pair.model !== 'string' || !pair.model
      || catalog?.limits?.verifiedFollowUp !== true
      || catalog?.limits?.followUpProjection !== 'follow-up-v1'
      || catalog?.limits?.maxPriorContextChars !== 20_000
      || !catalog.models?.some((entry) => entry?.provider === pair.provider
        && (entry?.id ?? entry?.model) === pair.model)) {
    throw errorWithCode('catalog_unavailable');
  }
  return { brainId: catalog.selectedBrain.id, pair, mode: catalog.defaults.mode ?? 'dive' };
}

async function genericProtectedFieldProbe(options, catalog, credential, signal) {
  const protectedFields = new Map([
    ['kind', 'verifiedFollowUp'],
    ['schemaVersion', 1],
    ['followUpFrom', { operationId: `brop_${'F'.repeat(32)}`,
      resultVersion: `qrv1_${'F'.repeat(43)}` }],
    ['queryFollowUpLineage', {
      rootOperationId: `brop_${'F'.repeat(32)}`,
      parentOperationId: `brop_${'F'.repeat(32)}`,
      parentResultVersion: `qrv1_${'F'.repeat(43)}`,
      depth: 1, availableExchangeCount: 1, includedExchangeCount: 1,
      contextTruncated: false, sourceAnswerTruncated: false,
    }],
    ['_queryFollowUpContext', { version: 1, exchanges: [] }],
    ['verifiedConversationContext', { version: 1, exchanges: [] }],
  ]);
  const base = {
      agent: options.agent, brainId: catalog.brainId,
      query: 'This generic request must reject protected fields.',
      enablePGS: false, mode: catalog.mode, modelSelection: catalog.pair,
  };
  const receipts = [];
  for (const [field, value] of protectedFields) {
    const response = await requestJson(route(options.dashboardUrl, '/home23/api/query/run'), {
      ...requestDefaults(options, signal), method: 'POST',
      headers: {
        ...deviceHeaders(credential), 'content-type': 'application/json',
        'x-home23-query-request-id': requestId(), prefer: 'respond-async',
      },
      body: JSON.stringify({ ...base, [field]: value }),
      expectedStatuses: [400],
    });
    validateQueryProjection('queryRunResponse', response.value);
    if (response.value?.ok !== false
        || Reflect.ownKeys(response.value).length !== 2
        || response.value.error?.code !== 'invalid_request'
        || response.value.error?.retryable !== false
        || typeof response.value.error?.message !== 'string'
        || !response.value.error.message
        || Reflect.ownKeys(response.value.error).length !== 3) {
      throw errorWithCode('generic_protected_field_error_invalid');
    }
    receipts.push({ field, status: response.response.status, code: response.value.error.code });
  }
  return receipts;
}

async function startRoot(options, catalog, credential, signal) {
  if (options.parentOperationId) {
    return {
      operationId: options.parentOperationId,
      resultVersion: options.parentResultVersion,
      source: 'existing-parent',
    };
  }
  const response = await requestJson(route(options.dashboardUrl, '/home23/api/query/run'), {
    ...requestDefaults(options, signal), method: 'POST',
    headers: {
      ...deviceHeaders(credential), 'content-type': 'application/json',
      'x-home23-query-request-id': requestId(), prefer: 'respond-async',
    },
    body: JSON.stringify({
      agent: options.agent, brainId: catalog.brainId,
      query: 'Verified follow-up live acceptance root.', enablePGS: false,
      mode: catalog.mode, modelSelection: catalog.pair,
    }),
    expectedStatuses: [202],
  });
  if (!OPERATION_ID.test(response.value?.operationId)) throw errorWithCode('root_start_invalid');
  return { operationId: response.value.operationId, resultVersion: null, source: 'created-root' };
}

async function readStatus(options, credential, operationId, projected, signal) {
  const suffix = projected ? '?projection=follow-up-v1' : '';
  const response = await requestJson(route(
    options.dashboardUrl,
    `/home23/api/query/operations/${encodeURIComponent(operationId)}${suffix}`,
  ), { ...requestDefaults(options, signal), headers: deviceHeaders(credential) });
  return validateProjection(
    projected ? 'queryNotebookFollowUpProjectedSummary' : 'queryNotebookStatus', response.value,
  );
}

async function waitForTerminal(options, credential, operationId, signal) {
  while (true) {
    if (signal.aborted) throw signal.reason;
    const status = await readStatus(options, credential, operationId, false, signal);
    if (TERMINAL.has(status.executionState)) {
      if (!SUCCESS.has(status.executionState) || status.resultAvailability !== 'available'
          || !RESULT_VERSION.test(status.resultVersion)) {
        throw errorWithCode('operation_not_successful');
      }
      return status;
    }
    try { await delay(options.pollMs, undefined, { signal }); } catch {
      if (signal.aborted) throw signal.reason;
      throw errorWithCode('poll_failed');
    }
  }
}

async function readResult(options, credential, operationId, expectedResultVersion, signal) {
  const response = await requestJson(route(
    options.dashboardUrl,
    `/home23/api/query/operations/${encodeURIComponent(operationId)}/result`,
  ), { ...requestDefaults(options, signal), headers: deviceHeaders(credential) });
  const result = validateProjection('queryNotebookResult', response.value);
  if (result.operationId !== operationId || Object.hasOwn(result, 'followUpLineage')) {
    throw errorWithCode('public_projection_invalid');
  }
  if (result.resultVersion !== expectedResultVersion) {
    throw errorWithCode('result_version_mismatch');
  }
  return {
    resultVersion: result.resultVersion,
    resultBytes: Buffer.byteLength(JSON.stringify(result)),
    answerSha256: sha256(result.answer),
  };
}

function followUpBody(parent, catalog, query) {
  return {
    kind: 'verifiedFollowUp', schemaVersion: 1,
    followUpFrom: {
      operationId: parent.operationId, resultVersion: parent.resultVersion,
    },
    query, mode: catalog.mode, modelSelection: catalog.pair,
    enableSynthesis: true, includeOutputs: true, includeThoughts: true,
    includeCoordinatorInsights: true, allowActions: false,
  };
}

async function startFollowUp(options, catalog, credential, parent, query, signal) {
  const id = requestId();
  const body = JSON.stringify(followUpBody(parent, catalog, query));
  const headers = {
    ...deviceHeaders(credential), 'content-type': 'application/json',
    'x-home23-query-request-id': id,
  };
  const start = () => requestJson(route(options.dashboardUrl, '/home23/api/query/operations'), {
    ...requestDefaults(options, signal), method: 'POST', headers, body,
    expectedStatuses: [202],
  });
  const first = await start();
  const replay = await start();
  validateProjection('queryNotebookFollowUpAcceptedResponse', first.value);
  validateProjection('queryNotebookFollowUpAcceptedResponse', replay.value);
  if (first.value.requestId !== id || replay.value.requestId !== id
      || first.value.operationId !== replay.value.operationId) {
    throw errorWithCode('idempotency_replay_diverged');
  }
  return {
    operationId: first.value.operationId,
    requestIdSha256: sha256(id),
    requestSha256: sha256(body),
    replayStatuses: [first.response.status, replay.response.status],
  };
}

function parseSnapshot(text) {
  const data = text.split(/\r?\n/u).find((line) => line.startsWith('data: '));
  if (!data) throw errorWithCode('snapshot_invalid');
  try { return JSON.parse(data.slice(6)); } catch (cause) {
    throw errorWithCode('snapshot_invalid', undefined, { cause });
  }
}

async function readSnapshot(options, credential, operationId, projected, signal) {
  const projection = projected ? '&projection=follow-up-v1' : '';
  const response = await requestText(route(
    options.dashboardUrl,
    `/home23/api/query/operations/${encodeURIComponent(operationId)}/events?after=0&attachmentId=follow-up-verifier${projection}`,
  ), {
    ...requestDefaults(options, signal),
    headers: { ...deviceHeaders(credential), accept: 'text/event-stream' },
    stopAfter: '\n\n',
  });
  return validateProjection(
    projected ? 'queryNotebookFollowUpProjectedSnapshotEvent' : 'querySnapshotEvent',
    parseSnapshot(response.text),
  );
}

function assertLineage(operationId, value, expected) {
  if (operationId === expected.rootOperationId) {
    if (value !== null) throw errorWithCode('lineage_invalid');
    return;
  }
  const keys = [
    'rootOperationId', 'parentOperationId', 'parentResultVersion', 'depth',
    'availableExchangeCount', 'includedExchangeCount', 'contextTruncated',
    'sourceAnswerTruncated',
  ];
  if (!value || keys.some((key) => value[key] !== expected[key])
      || Reflect.ownKeys(value).length !== keys.length) throw errorWithCode('lineage_invalid');
}

function operationReceipt(status, resultReceipt, depth) {
  if (status.requestKind !== 'direct' || !status.configuration?.directModel
      || !Array.isArray(status.actions)
      || status.actions.some((action) => !['openResult', 'export'].includes(action.kind))) {
    throw errorWithCode('ordinary_direct_contract_invalid');
  }
  return {
    operationId: status.operationId,
    resultVersion: resultReceipt.resultVersion,
    depth,
    requestKind: status.requestKind,
    configuration: status.configuration,
    actions: status.actions.map((action) => action.kind),
    result: resultReceipt,
  };
}

function withoutLineage(value) {
  const { followUpLineage: _lineage, ...legacy } = value;
  return legacy;
}

async function verifyCompatibility(options, credential, operations, signal) {
  const legacyInventory = validateProjection('queryNotebookPage', (await requestJson(route(
    options.dashboardUrl, '/home23/api/query/notebook?limit=100',
  ), { ...requestDefaults(options, signal), headers: deviceHeaders(credential) })).value);
  if (legacyInventory.items.some((item) => Object.hasOwn(item, 'followUpLineage'))) {
    throw errorWithCode('legacy_shape_widened');
  }
  const optedInventory = validateProjection('queryNotebookFollowUpProjectedPage',
    (await requestJson(route(
      options.dashboardUrl, '/home23/api/query/notebook?limit=100&projection=follow-up-v1',
    ), { ...requestDefaults(options, signal), headers: deviceHeaders(credential) })).value);
  validateProjection('queryNotebookPage', {
    ...optedInventory,
    items: optedInventory.items.map(withoutLineage),
  });

  const [root, child, grandchild] = operations;
  const legacyById = new Map(legacyInventory.items.map((item) => [item.operationId, item]));
  const optedById = new Map(optedInventory.items.map((item) => [item.operationId, item]));
  try {
    for (const operation of operations) {
      const legacy = legacyById.get(operation.operationId);
      const opted = optedById.get(operation.operationId);
      if (!legacy || !opted || Object.hasOwn(legacy, 'followUpLineage')) {
        throw errorWithCode('inventory_chain_unproven');
      }
    }
    assertLineage(root.operationId, optedById.get(root.operationId).followUpLineage, {
      rootOperationId: root.operationId,
    });
    assertLineage(child.operationId, optedById.get(child.operationId).followUpLineage, {
      rootOperationId: root.operationId, parentOperationId: root.operationId,
      parentResultVersion: root.resultVersion, depth: 1,
      availableExchangeCount: 1, includedExchangeCount: 1,
      contextTruncated: false, sourceAnswerTruncated: false,
    });
    assertLineage(grandchild.operationId, optedById.get(grandchild.operationId).followUpLineage, {
      rootOperationId: root.operationId, parentOperationId: child.operationId,
      parentResultVersion: child.resultVersion, depth: 2,
      availableExchangeCount: 2, includedExchangeCount: 2,
      contextTruncated: false, sourceAnswerTruncated: false,
    });
  } catch (error) {
    if (error?.code === 'inventory_chain_unproven') throw error;
    throw errorWithCode('inventory_chain_unproven', undefined, { cause: error });
  }

  const legacyStatus = await readStatus(options, credential, root.operationId, false, signal);
  const projectedRoot = await readStatus(options, credential, root.operationId, true, signal);
  const projectedChild = await readStatus(options, credential, child.operationId, true, signal);
  const projectedGrandchild = await readStatus(
    options, credential, grandchild.operationId, true, signal,
  );
  validateProjection('queryNotebookStatus', withoutLineage(projectedChild));

  assertLineage(root.operationId, projectedRoot.followUpLineage, {
    rootOperationId: root.operationId,
  });
  assertLineage(child.operationId, projectedChild.followUpLineage, {
    rootOperationId: root.operationId, parentOperationId: root.operationId,
    parentResultVersion: root.resultVersion, depth: 1,
    availableExchangeCount: 1, includedExchangeCount: 1,
    contextTruncated: false, sourceAnswerTruncated: false,
  });
  assertLineage(grandchild.operationId, projectedGrandchild.followUpLineage, {
    rootOperationId: root.operationId, parentOperationId: child.operationId,
    parentResultVersion: child.resultVersion, depth: 2,
    availableExchangeCount: 2, includedExchangeCount: 2,
    contextTruncated: false, sourceAnswerTruncated: false,
  });

  const legacySnapshot = await readSnapshot(
    options, credential, root.operationId, false, signal,
  );
  const projectedSnapshot = await readSnapshot(
    options, credential, grandchild.operationId, true, signal,
  );
  validateProjection('querySnapshotEvent', withoutLineage(projectedSnapshot));
  assertLineage(grandchild.operationId, projectedSnapshot.followUpLineage, {
    rootOperationId: root.operationId, parentOperationId: child.operationId,
    parentResultVersion: child.resultVersion, depth: 2,
    availableExchangeCount: 2, includedExchangeCount: 2,
    contextTruncated: false, sourceAnswerTruncated: false,
  });

  return {
    legacyInventory: { schema: 'queryNotebookPage', hasFollowUpLineage: false,
      itemCount: legacyInventory.items.length },
    legacyStatus: { schema: 'queryNotebookStatus', hasFollowUpLineage:
      Object.hasOwn(legacyStatus, 'followUpLineage') },
    legacySnapshot: { schema: 'querySnapshotEvent', hasFollowUpLineage:
      Object.hasOwn(legacySnapshot, 'followUpLineage') },
    optedRoot: { schema: 'queryNotebookFollowUpProjectedSummary', lineage: null },
    optedChild: { schema: 'queryNotebookFollowUpProjectedSummary',
      lineage: projectedChild.followUpLineage },
    optedGrandchild: { schema: 'queryNotebookFollowUpProjectedSummary',
      lineage: projectedGrandchild.followUpLineage },
    optedMinusLineageValidatesLegacy: true,
    resultHasLineage: false,
  };
}

export function redactForReceipt(value) {
  const seen = new WeakSet();
  const visit = (entry, key = '') => {
    if (SENSITIVE_KEY.test(key) && !key.endsWith('Sha256')) return '[REDACTED]';
    if (entry === null || typeof entry !== 'object') return entry;
    if (seen.has(entry)) return '[CIRCULAR]';
    seen.add(entry);
    if (Array.isArray(entry)) return entry.map((item) => visit(item));
    return Object.fromEntries(Object.entries(entry).map(([nestedKey, nested]) => (
      [nestedKey, visit(nested, nestedKey)]
    )));
  };
  return visit(value);
}

export function encodeReceipt(receipt, maxBytes = DEFAULT_MAX_RECEIPT_BYTES) {
  const encoded = `${JSON.stringify(redactForReceipt(receipt), null, 2)}\n`;
  if (Buffer.byteLength(encoded) > maxBytes) throw errorWithCode('receipt_too_large');
  return encoded;
}

async function writeReceipt(filename, receipt, maxBytes) {
  const parent = path.dirname(filename);
  await fsp.mkdir(parent, { recursive: true, mode: 0o700 });
  const parentStat = await fsp.lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw errorWithCode('receipt_parent_unsafe');
  }
  const canonicalParent = await fsp.realpath(parent);
  const output = path.join(canonicalParent, path.basename(filename));
  const existing = await fsp.lstat(output).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) {
    throw errorWithCode('receipt_output_unsafe');
  }
  const temporary = path.join(canonicalParent,
    `.${path.basename(output)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const handle = await fsp.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(encodeReceipt(receipt, maxBytes)); await handle.sync(); }
    finally { await handle.close(); }
    await fsp.rename(temporary, output);
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
}

export async function runVerifier(options) {
  const startedAtMs = Date.now();
  const overallController = new AbortController();
  const overallTimer = setTimeout(() => overallController.abort(errorWithCode('overall_timeout')),
    options.overallTimeoutMs);
  try {
    const bridgeToken = await loadBridgeToken(options.bridgeTokenFile);
    const credential = await enroll(options, bridgeToken, overallController.signal);
    const catalogValue = (await requestJson(route(
      options.dashboardUrl, '/home23/api/query/catalog',
    ), { ...requestDefaults(options, overallController.signal) })).value;
    const catalog = assertCatalog(catalogValue, options.agent);
    const genericRunProtectedFields = await genericProtectedFieldProbe(
      options, catalog, credential, overallController.signal,
    );

    const rootStart = await startRoot(
      options, catalog, credential, overallController.signal,
    );
    const rootStatus = await waitForTerminal(
      options, credential, rootStart.operationId, overallController.signal,
    );
    if (rootStart.resultVersion && rootStart.resultVersion !== rootStatus.resultVersion) {
      throw errorWithCode('follow_up_result_version_conflict');
    }
    const rootResult = await readResult(
      options, credential, rootStart.operationId, rootStatus.resultVersion,
      overallController.signal,
    );
    const root = {
      ...operationReceipt(rootStatus, rootResult, 0), source: rootStart.source,
    };

    const childStart = await startFollowUp(options, catalog, credential, {
      operationId: root.operationId, resultVersion: root.resultVersion,
    }, 'Verified live follow up one.', overallController.signal);
    const childStatus = await waitForTerminal(
      options, credential, childStart.operationId, overallController.signal,
    );
    const childResult = await readResult(
      options, credential, childStart.operationId, childStatus.resultVersion,
      overallController.signal,
    );
    const child = {
      ...operationReceipt(childStatus, childResult, 1),
      replay: childStart,
    };

    const grandchildStart = await startFollowUp(options, catalog, credential, {
      operationId: child.operationId, resultVersion: child.resultVersion,
    }, 'Verified live follow up two.', overallController.signal);
    const grandchildStatus = await waitForTerminal(
      options, credential, grandchildStart.operationId, overallController.signal,
    );
    const grandchildResult = await readResult(
      options, credential, grandchildStart.operationId, grandchildStatus.resultVersion,
      overallController.signal,
    );
    const grandchild = {
      ...operationReceipt(grandchildStatus, grandchildResult, 2),
      replay: grandchildStart,
    };

    const operations = [root, child, grandchild];
    const compatibility = await verifyCompatibility(
      options, credential, operations, overallController.signal,
    );
    return {
      schemaVersion: 1,
      status: 'passed',
      startedAt: new Date(startedAtMs).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAtMs,
      agent: options.agent,
      dashboardOrigin: options.dashboardUrl,
      root: { operationId: root.operationId, source: root.source },
      operations,
      compatibility,
      genericRunProtectedFields,
    };
  } finally {
    clearTimeout(overallTimer);
  }
}

function safeError(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'verification_failed',
    ...(Number.isInteger(error?.status) ? { httpStatus: error.status } : {}),
  };
}

async function main() {
  let options;
  let receipt;
  let exitCode = 0;
  try {
    options = parseOptions();
    if (options.help) { process.stdout.write(HELP); return; }
    receipt = await runVerifier(options);
  } catch (error) {
    exitCode = 1;
    receipt = {
      schemaVersion: 1, status: 'failed', completedAt: new Date().toISOString(),
      agent: options?.agent ?? null, error: safeError(error),
    };
  }
  if (options?.output) {
    try { await writeReceipt(options.output, receipt, options.maxReceiptBytes); }
    catch (error) {
      exitCode = 1;
      process.stderr.write(`${JSON.stringify({ status: 'failed', error: safeError(error) })}\n`);
    }
  }
  process.stdout.write(`${JSON.stringify({ status: receipt.status, error: receipt.error })}\n`);
  process.exitCode = exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
