'use strict';

const { types: { isProxy } } = require('node:util');

const {
  canonicalJson,
} = require('../../../shared/brain-operations/canonical-json.cjs');
const {
  memorySourceError,
  throwIfAborted,
} = require('../../../shared/memory-source/contracts.cjs');

const DEFAULT_MAX_NODES = 2_000;
const DEFAULT_MAX_EDGES = 8_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const MAX_IDENTIFIER_BYTES = 4 * 1024;
const MAX_METADATA_VALUE_BYTES = 4 * 1024;
const MAX_CONTENT_FIELD_BYTES = 8 * 1024 * 1024;

const INTELLIGENCE_SECTIONS = Object.freeze(new Map([
  ['executive', 'executive'],
  ['goal', 'goals'],
  ['goals', 'goals'],
  ['trajectory', 'trajectory'],
  ['thought', 'thoughts'],
  ['thoughts', 'thoughts'],
  ['insight', 'insights'],
  ['insights', 'insights'],
]));
const INCLUDE_VALUES = Object.freeze(new Set([
  'executive', 'goals', 'trajectory', 'thoughts', 'insights',
]));
const SECTION_VALUES = Object.freeze(new Set(['goal', 'insight', 'agent']));

function invalidRequest(message = 'invalid research intelligence request') {
  return memorySourceError('invalid_request', message, { status: 400, retryable: false });
}

function invalidSource(message = 'pinned source record is invalid') {
  return memorySourceError('invalid_memory_source', message, { status: 422, retryable: false });
}

function resultTooLarge(subject) {
  return memorySourceError('result_too_large', `${subject} exceeds the pinned intelligence limit`, {
    status: 413,
    retryable: false,
  });
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownDataValue(record, key) {
  if (!isPlainRecord(record)) throw invalidSource();
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, 'value')) throw invalidSource(`source field ${key} is not data`);
  return descriptor.value;
}

function boundedString(value, maxBytes, field, { allowEmpty = false } = {}) {
  if (value === undefined || value === null) return null;
  if (!['string', 'number'].includes(typeof value)) throw invalidSource(`${field} is not scalar`);
  const normalized = String(value);
  if ((!allowEmpty && !normalized) || normalized.includes('\0')
      || Buffer.byteLength(normalized, 'utf8') > maxBytes) {
    throw invalidSource(`${field} is not bounded`);
  }
  return normalized;
}

function requiredBoundedString(value, maxBytes, field) {
  const normalized = boundedString(value, maxBytes, field);
  if (normalized === null) throw invalidSource(`${field} is required`);
  return normalized;
}

function boundedContent(record, maxBytes) {
  for (const key of ['content', 'concept', 'text', 'summary']) {
    const value = ownDataValue(record, key);
    if (value === undefined || value === null) continue;
    let content;
    if (typeof value === 'string') content = value;
    else if (typeof value === 'number' || typeof value === 'boolean') content = String(value);
    else {
      try {
        content = canonicalJson(value);
      } catch (error) {
        throw invalidSource(`${key} is not canonical content`, { cause: error });
      }
    }
    if (Buffer.byteLength(content, 'utf8') > Math.min(MAX_CONTENT_FIELD_BYTES, maxBytes)) {
      throw resultTooLarge('projected node content');
    }
    return content;
  }
  return '';
}

function firstDefined(record, metadata, keys) {
  for (const key of keys) {
    const metadataValue = metadata ? ownDataValue(metadata, key) : undefined;
    if (metadataValue !== undefined && metadataValue !== null) return metadataValue;
    const directValue = ownDataValue(record, key);
    if (directValue !== undefined && directValue !== null) return directValue;
  }
  return null;
}

function canonicalSection(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLocaleLowerCase('en-US');
  if (['goal', 'goals'].includes(normalized)) return 'goal';
  if (['insight', 'insights'].includes(normalized)) return 'insight';
  if (['agent', 'agents'].includes(normalized)) return 'agent';
  if (normalized === 'executive') return 'executive';
  if (normalized === 'trajectory') return 'trajectory';
  if (['thought', 'thoughts'].includes(normalized)) return 'thought';
  return null;
}

function sectionFromTag(tag) {
  if (typeof tag !== 'string') return null;
  const normalized = tag.toLocaleLowerCase('en-US');
  if (normalized === 'goal' || normalized === 'goals' || normalized.startsWith('goal_')) return 'goal';
  if (normalized === 'insight' || normalized === 'insights') return 'insight';
  if (normalized === 'agent' || normalized === 'agent_finding') return 'agent';
  if (normalized === 'agent_insight') return 'insight';
  if (normalized === 'thought' || normalized === 'thoughts') return 'thought';
  if (normalized === 'executive' || normalized.startsWith('executive_')) return 'executive';
  if (normalized === 'trajectory' || normalized.startsWith('trajectory_')) return 'trajectory';
  return null;
}

function sectionIdFromTag(tag, section) {
  if (typeof tag !== 'string' || !section) return null;
  const prefix = `${section}_`;
  if (!tag.toLocaleLowerCase('en-US').startsWith(prefix) || tag.length === prefix.length) return null;
  return tag.slice(prefix.length);
}

function projectNode(record, maxBytes) {
  if (!isPlainRecord(record)) throw invalidSource('node is not a plain record');
  const rawMetadata = ownDataValue(record, 'metadata');
  if (rawMetadata !== null && rawMetadata !== undefined && !isPlainRecord(rawMetadata)) {
    throw invalidSource('node metadata is not a plain record');
  }
  const metadataSource = rawMetadata || null;
  const id = requiredBoundedString(ownDataValue(record, 'id'), MAX_IDENTIFIER_BYTES, 'node.id');
  const tag = boundedString(firstDefined(record, metadataSource, ['tag']),
    MAX_METADATA_VALUE_BYTES, 'node.tag', { allowEmpty: true });
  const kind = boundedString(firstDefined(record, metadataSource, ['kind', 'type']),
    MAX_METADATA_VALUE_BYTES, 'node.kind', { allowEmpty: true });
  const explicitSection = firstDefined(record, metadataSource, ['section', 'sectionKind']);
  const section = explicitSection !== null
    ? canonicalSection(explicitSection)
    : canonicalSection(kind) || sectionFromTag(tag);
  const sectionId = boundedString(
    firstDefined(record, metadataSource, [
      'sectionId', 'section_id',
      ...(section === 'goal' ? ['goalId', 'goal_id'] : []),
      ...(section === 'insight' ? ['insightId', 'insight_id'] : []),
      ...(section === 'agent' ? ['agentId', 'agent_id'] : []),
    ]) ?? sectionIdFromTag(tag, section),
    MAX_METADATA_VALUE_BYTES,
    'node.sectionId',
    { allowEmpty: false },
  );
  const cluster = boundedString(firstDefined(record, metadataSource, ['cluster']),
    MAX_METADATA_VALUE_BYTES, 'node.cluster', { allowEmpty: true });
  return {
    id,
    content: boundedContent(record, maxBytes),
    metadata: {
      kind,
      section,
      sectionId,
      tag,
      cluster,
    },
  };
}

function projectEdge(record) {
  if (!isPlainRecord(record)) throw invalidSource('edge is not a plain record');
  const source = requiredBoundedString(
    ownDataValue(record, 'source') ?? ownDataValue(record, 'from'),
    MAX_IDENTIFIER_BYTES,
    'edge.source',
  );
  const target = requiredBoundedString(
    ownDataValue(record, 'target') ?? ownDataValue(record, 'to'),
    MAX_IDENTIFIER_BYTES,
    'edge.target',
  );
  const rawType = ownDataValue(record, 'type');
  const type = rawType === undefined || rawType === null
    ? 'associative'
    : boundedString(rawType, MAX_METADATA_VALUE_BYTES, 'edge.type');
  const rawWeight = ownDataValue(record, 'weight');
  const weight = rawWeight === undefined || rawWeight === null ? 0 : Number(rawWeight);
  if (!Number.isFinite(weight)) throw invalidSource('edge.weight is not finite');
  return { source, target, type, weight };
}

function exactOwnObject(value, allowedKeys, field) {
  if (!isPlainRecord(value)) throw invalidRequest(`${field} must be an exact object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length > 0) throw invalidRequest(`${field} has symbols`);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowedKeys.has(key) || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      throw invalidRequest(`${field}.${key} is not allowed`);
    }
  }
  return descriptors;
}

function normalizeSelection(selection) {
  const descriptors = exactOwnObject(selection, new Set(['kind', 'section', 'sectionId', 'include']), 'selection');
  const kind = descriptors.kind?.value;
  if (!['brain', 'section', 'intelligence'].includes(kind)) throw invalidRequest('selection.kind is invalid');
  const section = descriptors.section?.value;
  const sectionId = descriptors.sectionId?.value;
  const include = descriptors.include?.value;

  if (kind === 'brain') {
    if (section !== undefined || sectionId !== undefined || include !== undefined) {
      throw invalidRequest('brain selection cannot include section fields');
    }
    return Object.freeze({ kind });
  }
  if (kind === 'section') {
    if (!SECTION_VALUES.has(section) || typeof sectionId !== 'string' || !sectionId
        || sectionId.includes('\0')
        || Buffer.byteLength(sectionId, 'utf8') > MAX_METADATA_VALUE_BYTES
        || include !== undefined) {
      throw invalidRequest('exact section and sectionId are required');
    }
    return Object.freeze({ kind, section, sectionId });
  }
  if (section !== undefined || sectionId !== undefined) {
    throw invalidRequest('intelligence selection cannot include exact section fields');
  }
  const normalizedInclude = include === undefined
    ? [...INCLUDE_VALUES]
    : include;
  if (!Array.isArray(normalizedInclude)
      || isProxy(normalizedInclude)
      || Object.getPrototypeOf(normalizedInclude) !== Array.prototype
      || normalizedInclude.length > INCLUDE_VALUES.size
      || new Set(normalizedInclude).size !== normalizedInclude.length
      || normalizedInclude.some((entry) => !INCLUDE_VALUES.has(entry))) {
    throw invalidRequest('selection.include is invalid');
  }
  const includeDescriptors = Object.getOwnPropertyDescriptors(normalizedInclude);
  if (Object.getOwnPropertySymbols(normalizedInclude).length > 0) {
    throw invalidRequest('selection.include is invalid');
  }
  for (let index = 0; index < normalizedInclude.length; index += 1) {
    const descriptor = includeDescriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      throw invalidRequest('selection.include is invalid');
    }
  }
  for (const [key, descriptor] of Object.entries(includeDescriptors)) {
    if (key === 'length') continue;
    if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= normalizedInclude.length
        || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      throw invalidRequest('selection.include is invalid');
    }
  }
  return Object.freeze({ kind, include: Object.freeze([...normalizedInclude]) });
}

function parseLimit(value, fallback, { name, min }) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min) throw invalidRequest(`${name} is invalid`);
  return value;
}

function matchesSelection(node, selection) {
  if (selection.kind === 'brain') return true;
  if (selection.kind === 'section') {
    return node.metadata.section === selection.section
      && node.metadata.sectionId === selection.sectionId;
  }
  const intelligenceSection = INTELLIGENCE_SECTIONS.get(node.metadata.section);
  return intelligenceSection ? selection.include.includes(intelligenceSection) : false;
}

function addContentBytes(state, kind, value, maxBytes) {
  const bytes = Buffer.byteLength(canonicalJson(value), 'utf8');
  const count = state[`${kind}Count`];
  const next = state.bytes + bytes + (count > 0 ? 1 : 0);
  if (next > maxBytes) throw resultTooLarge('canonical intelligence content');
  state.bytes = next;
  state[`${kind}Count`] = count + 1;
}

function normalizeSummary(summary, returnedNodes, returnedEdges) {
  if (!isPlainRecord(summary)) throw invalidSource('source summary is invalid');
  const boundedCount = (key) => {
    const value = ownDataValue(summary, key);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  };
  return {
    nodes: boundedCount('nodes'),
    edges: boundedCount('edges'),
    clusters: boundedCount('clusters'),
    returnedNodes,
    returnedEdges,
  };
}

async function readPinnedIntelligence(sourcePin, selection, options = {}) {
  const normalizedSelection = normalizeSelection(selection);
  const maxNodes = parseLimit(options.maxNodes, DEFAULT_MAX_NODES, { name: 'maxNodes', min: 0 });
  const maxEdges = parseLimit(options.maxEdges, DEFAULT_MAX_EDGES, { name: 'maxEdges', min: 0 });
  const maxBytes = parseLimit(options.maxBytes, DEFAULT_MAX_BYTES, { name: 'maxBytes', min: 1 });
  const signal = options.signal;
  throwIfAborted(signal);

  if (!sourcePin || typeof sourcePin !== 'object') throw invalidRequest('source pin is required');
  const summarize = sourcePin.summarize;
  const iterateNodes = sourcePin.iterateNodes;
  const iterateEdges = sourcePin.iterateEdges;
  const getEvidence = sourcePin.getEvidence;
  if (typeof summarize !== 'function' || typeof iterateNodes !== 'function'
      || typeof iterateEdges !== 'function' || typeof getEvidence !== 'function') {
    throw invalidRequest('canonical pinned source surface is required');
  }

  const sourceSummary = await summarize.call(sourcePin, { signal });
  throwIfAborted(signal);

  const content = { nodes: [], edges: [] };
  const contentBytes = {
    bytes: Buffer.byteLength(canonicalJson({ nodes: [], edges: [] }), 'utf8'),
    nodeCount: 0,
    edgeCount: 0,
  };
  if (contentBytes.bytes > maxBytes) throw resultTooLarge('canonical intelligence content');
  const selectedIds = new Set();

  for await (const record of iterateNodes.call(sourcePin, { signal })) {
    throwIfAborted(signal);
    const projected = projectNode(record, maxBytes);
    if (!matchesSelection(projected, normalizedSelection)) continue;
    if (content.nodes.length >= maxNodes) throw resultTooLarge('selected node count');
    if (selectedIds.has(projected.id)) throw invalidSource('duplicate selected node id');
    addContentBytes(contentBytes, 'node', projected, maxBytes);
    selectedIds.add(projected.id);
    content.nodes.push(projected);
  }
  throwIfAborted(signal);

  if (normalizedSelection.kind === 'section' && content.nodes.length === 0) return null;

  for await (const record of iterateEdges.call(sourcePin, { signal })) {
    throwIfAborted(signal);
    const projected = projectEdge(record);
    if (!selectedIds.has(projected.source) || !selectedIds.has(projected.target)) continue;
    if (content.edges.length >= maxEdges) throw resultTooLarge('selected edge count');
    addContentBytes(contentBytes, 'edge', projected, maxBytes);
    content.edges.push(projected);
  }
  throwIfAborted(signal);

  const measuredBytes = Buffer.byteLength(canonicalJson(content), 'utf8');
  if (measuredBytes !== contentBytes.bytes || measuredBytes > maxBytes) {
    throw resultTooLarge('canonical intelligence content');
  }
  const filters = normalizedSelection.kind === 'brain'
    ? { kind: 'brain' }
    : normalizedSelection.kind === 'section'
      ? { ...normalizedSelection }
      : { kind: 'intelligence', include: [...normalizedSelection.include] };
  const evidence = getEvidence.call(sourcePin, {
    filters,
    limits: { maxNodes, maxEdges, maxBytes },
    returnedTotals: { nodes: content.nodes.length, edges: content.edges.length },
    completeCoverage: true,
  });
  throwIfAborted(signal);

  return {
    content,
    selection: normalizedSelection.kind === 'intelligence'
      ? { kind: normalizedSelection.kind, include: [...normalizedSelection.include] }
      : { ...normalizedSelection },
    summary: normalizeSummary(sourceSummary, content.nodes.length, content.edges.length),
    evidence,
  };
}

module.exports = {
  readPinnedIntelligence,
};
