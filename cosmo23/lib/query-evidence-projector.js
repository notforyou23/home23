'use strict';

const {
  redactPrivatePaths: redactProviderPrivatePaths,
} = require('./provider-record-sanitizer');

const TEXT_FIELDS = Object.freeze([
  'title', 'concept', 'summary', 'content', 'statement', 'keyPhrase', 'text',
]);
const EDGE_TEXT_FIELDS = Object.freeze(['label', 'evidence', 'summary', 'content', 'text']);
const TIMESTAMP_FIELDS = Object.freeze([
  'timestamp', 'createdAt', 'updatedAt', 'observedAt', 'validAt',
]);
const MAX_STRUCTURE_DEPTH = 12;
const MAX_STRUCTURE_PROPERTIES = 20_000;
const MAX_TAGS = 16;
const MAX_QUERY_EVIDENCE_IDENTIFIER_BYTES = 512;

const RECORD_LIMITS = Object.freeze({
  quick: Object.freeze({ maxContentBytes: 1_536, maxRecordBytes: 3_072 }),
  full: Object.freeze({ maxContentBytes: 2_048, maxRecordBytes: 4_096 }),
  expert: Object.freeze({ maxContentBytes: 3_072, maxRecordBytes: 5_120 }),
  dive: Object.freeze({ maxContentBytes: 3_072, maxRecordBytes: 5_120 }),
});

function typed(code, message) {
  return Object.assign(new Error(message), { code, retryable: false });
}

function projectionRecordLimits(mode) {
  if (typeof mode !== 'string' || !Object.hasOwn(RECORD_LIMITS, mode)) {
    throw typed('invalid_request', `Unsupported Query projection mode: ${String(mode)}`);
  }
  return RECORD_LIMITS[mode];
}

function assertLimits(options) {
  const maxContentBytes = options?.maxContentBytes;
  const maxRecordBytes = options?.maxRecordBytes;
  if (!Number.isSafeInteger(maxContentBytes) || maxContentBytes <= 0
      || !Number.isSafeInteger(maxRecordBytes) || maxRecordBytes <= maxContentBytes) {
    throw typed('invalid_request', 'Query evidence record limits are invalid');
  }
  return { maxContentBytes, maxRecordBytes };
}

function validateStructure(value, ancestors = new Set(), state = { properties: 0 }, depth = 0) {
  if (value === null || typeof value !== 'object') return;
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof Date) return;
  if (ancestors.has(value)) {
    throw typed('source_invalid', 'Query evidence contains a cycle');
  }
  if (depth > MAX_STRUCTURE_DEPTH) {
    throw typed('source_invalid', 'Query evidence nesting is unbounded');
  }
  if (Array.isArray(value) && value.length > MAX_STRUCTURE_PROPERTIES) {
    throw typed('source_invalid', 'Query evidence collection is unbounded');
  }
  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (cause) {
    throw typed('source_invalid', 'Query evidence structure is unreadable');
  }
  ancestors.add(value);
  try {
    for (const descriptor of Object.values(descriptors)) {
      state.properties += 1;
      if (state.properties > MAX_STRUCTURE_PROPERTIES) {
        throw typed('source_invalid', 'Query evidence object is unbounded');
      }
      if (!Object.hasOwn(descriptor, 'value')) {
        throw typed('source_invalid', 'Accessor-backed Query evidence is unsafe');
      }
      validateStructure(descriptor.value, ancestors, state, depth + 1);
    }
  } finally {
    ancestors.delete(value);
  }
}

function dataProperty(record, key) {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, 'value')) {
    throw typed('source_invalid', 'Accessor-backed Query evidence is unsafe');
  }
  return descriptor.value;
}

function redactPrivatePaths(value) {
  const redacted = redactProviderPrivatePaths(value);
  return { value: redacted, redacted: redacted !== value };
}

function truncateUtf8(value, maxBytes) {
  const redaction = redactPrivatePaths(String(value));
  if (Buffer.byteLength(redaction.value, 'utf8') <= maxBytes) {
    return Object.freeze({
      value: redaction.value,
      bytes: Buffer.byteLength(redaction.value, 'utf8'),
      truncated: redaction.redacted,
    });
  }
  let result = '';
  let bytes = 0;
  for (const character of redaction.value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return Object.freeze({ value: result, bytes, truncated: true });
}

function queryEvidenceIdentifier(value) {
  if (typeof value !== 'string' && !Number.isSafeInteger(value)) {
    return null;
  }
  const identifier = String(value);
  if (!identifier
      || Buffer.byteLength(identifier, 'utf8') > MAX_QUERY_EVIDENCE_IDENTIFIER_BYTES) {
    return null;
  }
  return redactProviderPrivatePaths(identifier) === identifier ? identifier : null;
}

function safeIdentifier(value, label) {
  const identifier = queryEvidenceIdentifier(value);
  if (identifier === null) {
    throw typed('source_invalid', `Query evidence ${label} is invalid`);
  }
  return identifier;
}

function preflightQueryEvidenceEdge(rawEdge) {
  if (!rawEdge || typeof rawEdge !== 'object' || Array.isArray(rawEdge)) {
    throw typed('source_invalid', 'Query evidence edge must be an object');
  }
  validateStructure(rawEdge);
  const source = dataProperty(rawEdge, 'source')
    ?? dataProperty(rawEdge, 'from')
    ?? dataProperty(rawEdge, 'sourceId');
  const target = dataProperty(rawEdge, 'target')
    ?? dataProperty(rawEdge, 'to')
    ?? dataProperty(rawEdge, 'targetId');
  return Object.freeze({
    source: queryEvidenceIdentifier(source),
    target: queryEvidenceIdentifier(target),
  });
}

function safeShortString(value, maxBytes = 256) {
  if (typeof value !== 'string' || !value) return null;
  return truncateUtf8(value, maxBytes);
}

function safeScalar(value) {
  if (typeof value === 'boolean' || Number.isSafeInteger(value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const string = safeShortString(value, 256);
  return string?.value || null;
}

function addTextFields(output, record, fields, maxContentBytes) {
  let remaining = maxContentBytes;
  let truncated = false;
  for (const field of fields) {
    const value = dataProperty(record, field);
    if (typeof value !== 'string' || !value) continue;
    if (remaining <= 0) {
      truncated = true;
      continue;
    }
    const excerpt = truncateUtf8(value, remaining);
    if (excerpt.value) output[field] = excerpt.value;
    remaining -= excerpt.bytes;
    truncated = truncated || excerpt.truncated;
  }
  return truncated;
}

function addClassification(output, record) {
  for (const field of ['type', 'tag', 'status']) {
    const safe = safeShortString(dataProperty(record, field), 128);
    if (safe?.value) output[field] = safe.value;
  }
  const tags = dataProperty(record, 'tags');
  if (Array.isArray(tags)) {
    const safeTags = [];
    for (const tag of tags.slice(0, MAX_TAGS)) {
      const safe = safeShortString(tag, 96);
      if (safe?.value) safeTags.push(safe.value);
    }
    if (safeTags.length) output.tags = safeTags;
  }
}

function addProvenance(output, record) {
  const direct = safeScalar(dataProperty(record, 'provenance'));
  if (direct !== null) {
    output.provenance = direct;
    return;
  }
  const metadata = dataProperty(record, 'metadata');
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return;
  for (const key of ['provenance', 'source', 'origin']) {
    const scalar = safeScalar(dataProperty(metadata, key));
    if (scalar !== null) {
      output.provenance = scalar;
      return;
    }
  }
}

function addTimestamps(output, record) {
  for (const field of TIMESTAMP_FIELDS) {
    const scalar = safeScalar(dataProperty(record, field));
    if (scalar !== null) output[field] = scalar;
  }
}

function addSalience(output, record) {
  for (const key of ['salience', 'weight', 'activation']) {
    const value = dataProperty(record, key);
    if (typeof value === 'number' && Number.isFinite(value)) {
      output.salience = Math.max(0, Math.min(1, value));
      return;
    }
  }
}

function serializeProjected(output, maxRecordBytes) {
  let json = JSON.stringify(output);
  let bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > maxRecordBytes && Array.isArray(output.tags)) {
    while (bytes > maxRecordBytes && output.tags.length) {
      output.tags.pop();
      output.contentTruncated = true;
      json = JSON.stringify(output);
      bytes = Buffer.byteLength(json, 'utf8');
    }
    if (!output.tags.length) delete output.tags;
  }
  for (const field of [...EDGE_TEXT_FIELDS, ...TEXT_FIELDS].reverse()) {
    while (bytes > maxRecordBytes && typeof output[field] === 'string' && output[field]) {
      const over = bytes - maxRecordBytes;
      const currentBytes = Buffer.byteLength(output[field], 'utf8');
      const target = Math.max(0, currentBytes - over - 32);
      const reduced = truncateUtf8(output[field], target);
      if (reduced.value) output[field] = reduced.value;
      else delete output[field];
      output.contentTruncated = true;
      json = JSON.stringify(output);
      bytes = Buffer.byteLength(json, 'utf8');
    }
  }
  for (const field of [
    ...TIMESTAMP_FIELDS, 'provenance', 'tag', 'salience', 'label',
  ]) {
    if (bytes <= maxRecordBytes) break;
    delete output[field];
    output.contentTruncated = true;
    json = JSON.stringify(output);
    bytes = Buffer.byteLength(json, 'utf8');
  }
  if (bytes > maxRecordBytes) {
    throw typed('result_too_large', 'Compacted Query evidence cannot fit its record limit');
  }
  return Object.freeze({ value: Object.freeze(output), json, bytes });
}

function projectQueryEvidenceNode(rawNode, options) {
  const limits = assertLimits(options);
  if (!rawNode || typeof rawNode !== 'object' || Array.isArray(rawNode)) {
    throw typed('source_invalid', 'Query evidence node must be an object');
  }
  validateStructure(rawNode);
  const id = dataProperty(rawNode, 'id')
    ?? dataProperty(rawNode, 'nodeId')
    ?? dataProperty(rawNode, 'key');
  const output = { id: safeIdentifier(id, 'node ID') };
  addClassification(output, rawNode);
  addSalience(output, rawNode);
  addProvenance(output, rawNode);
  addTimestamps(output, rawNode);
  const truncated = addTextFields(output, rawNode, TEXT_FIELDS, limits.maxContentBytes);
  if (truncated) output.contentTruncated = true;
  return serializeProjected(output, limits.maxRecordBytes);
}

function projectQueryEvidenceEdgeFromPreflight(rawEdge, limits, preflight) {
  const output = {
    source: safeIdentifier(preflight.source, 'edge source'),
    target: safeIdentifier(preflight.target, 'edge target'),
  };
  addClassification(output, rawEdge);
  addProvenance(output, rawEdge);
  addTimestamps(output, rawEdge);
  const edgeContentBudget = Math.min(limits.maxContentBytes, 1_024);
  const truncated = addTextFields(output, rawEdge, EDGE_TEXT_FIELDS, edgeContentBudget);
  if (truncated) output.contentTruncated = true;
  return serializeProjected(output, limits.maxRecordBytes);
}

function projectQueryEvidenceEdge(rawEdge, options) {
  const limits = assertLimits(options);
  return projectQueryEvidenceEdgeFromPreflight(
    rawEdge,
    limits,
    preflightQueryEvidenceEdge(rawEdge),
  );
}

function projectRetainedQueryEvidenceEdge(rawEdge, options, retainedIds) {
  const limits = assertLimits(options);
  if (!(retainedIds instanceof Set)) {
    throw typed('invalid_request', 'Retained Query evidence IDs must be a Set');
  }
  const preflight = preflightQueryEvidenceEdge(rawEdge);
  if (preflight.source === null || preflight.target === null
      || !retainedIds.has(preflight.source) || !retainedIds.has(preflight.target)) {
    return null;
  }
  return projectQueryEvidenceEdgeFromPreflight(rawEdge, limits, preflight);
}

module.exports = {
  MAX_QUERY_EVIDENCE_IDENTIFIER_BYTES,
  projectQueryEvidenceEdge,
  projectQueryEvidenceNode,
  projectRetainedQueryEvidenceEdge,
  projectionRecordLimits,
  queryEvidenceIdentifier,
  truncateUtf8,
};
