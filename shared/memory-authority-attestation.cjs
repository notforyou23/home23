'use strict';

const { createHash, createHmac, timingSafeEqual } = require('node:crypto');
const { canonicalJson } = require('./brain-operations/canonical-json.cjs');

const ATTESTATION_SCHEMA = 'home23.memory-authority-attestation.v1';
const ATTESTATION_ALGORITHM = 'hmac-sha256';
const ATTESTATION_ENV = 'HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY';
const DERIVATION_CONTEXT = 'home23.memory-authority-attestation.v1';
const MAX_TEXT_BYTES = 16 * 1024;
const MAX_REF_BYTES = 2 * 1024;
const MAX_ARRAY_ITEMS = 64;

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function profileOf(node) {
  const metadataProfile = asRecord(asRecord(node?.metadata).provenance);
  if (metadataProfile.schema === 'home23.node-provenance.v1') return metadataProfile;
  const provenance = asRecord(node?.provenance);
  const nested = asRecord(provenance.node_profile);
  if (nested.schema === 'home23.node-provenance.v1') return nested;
  if (provenance.schema === 'home23.node-provenance.v1') return provenance;
  return null;
}

function boundedString(value, maxBytes = MAX_REF_BYTES) {
  if (typeof value !== 'string') return null;
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > maxBytes) {
    throw new RangeError(`memory authority value exceeds ${maxBytes} bytes`);
  }
  return value;
}

function boundedScalar(value, maxBytes = MAX_REF_BYTES) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') {
    throw new TypeError('memory authority value must be a scalar');
  }
  return boundedString(value, maxBytes);
}

function boundedArray(value, maxBytes = MAX_REF_BYTES) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new TypeError('memory authority value must be an array');
  }
  if (value.length > MAX_ARRAY_ITEMS) {
    throw new RangeError(`memory authority array exceeds ${MAX_ARRAY_ITEMS} items`);
  }
  return value.map((entry) => boundedScalar(entry, maxBytes));
}

function boundedTime(value) {
  if (value === null || value === undefined || value === '') return null;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : boundedScalar(value, 128);
}

function profilePayload(profile) {
  const projected = {};
  for (const field of [
    'schema', 'authorityClass', 'authority_class', 'retrievalDomain', 'retrieval_domain',
    'semanticTime', 'semantic_time', 'generationMethod', 'generation_method',
    'sourcePath', 'source_path', 'contentHash', 'content_hash', 'expiresAt',
    'operationalAuthority', 'traceId', 'trace_id',
    'requiresFreshVerification',
  ]) {
    if (Object.hasOwn(profile, field)) projected[field] = boundedScalar(profile[field]);
  }
  for (const field of [
    'sourceRefs', 'source_refs', 'evidenceRefs', 'evidence_refs', 'derivedNodeIds',
    'scope', 'missingEvidence', 'closureProofRefs', 'closure_proof_refs',
    'verificationRequirements', 'verification_requirements',
    'consolidationSourceIds', 'consolidation_source_ids',
  ]) {
    if (Object.hasOwn(profile, field)) projected[field] = boundedArray(profile[field]);
  }
  return projected;
}

function metadataPayload(metadata) {
  const projected = {};
  for (const field of [
    'kind', 'status', 'goalId', 'goal_id', 'incidentId', 'incident_id',
    'resolutionType', 'resolution_type', 'resolved_at', 'resolvedAt',
    'supersedes_goal_id', 'corrects_node_id', 'correction_of',
    'source', 'channel', 'source_path', 'sourcePath', 'generation_method',
    'trace_id', 'traceId', 'asserted_at', 'source_event_at', 'source_time',
    'report_time', 'reported_at', 'created_at', 'content_hash', 'source_hash',
    'receipt_id', 'confidence_decay', 'superseded_by', 'source_class',
    'salienceWeight',
  ]) {
    if (Object.hasOwn(metadata, field)) projected[field] = boundedScalar(metadata[field]);
  }
  for (const field of [
    'source_refs', 'verifier_refs', 'closure_proof_refs', 'resolution_proof_refs',
    'supersedes', 'supersedes_ids', 'supersedesIds', 'corrects',
    'consolidation_source_ids', 'verification_requirements',
  ]) {
    if (Object.hasOwn(metadata, field)) projected[field] = boundedArray(metadata[field]);
  }
  return projected;
}

function provenancePayload(provenance) {
  const projected = {};
  for (const field of [
    'generation_method', 'trace_id', 'sourceClass', 'source_class',
    'salienceWeight', 'reason', 'retention',
  ]) {
    if (Object.hasOwn(provenance, field)) projected[field] = boundedScalar(provenance[field]);
  }
  for (const field of ['source_refs', 'supersedes', 'consolidation_source_ids']) {
    if (Object.hasOwn(provenance, field)) projected[field] = boundedArray(provenance[field]);
  }
  return projected;
}

function authorityPayload(authority) {
  const projected = {};
  for (const field of [
    'presentTenseAuthority', 'temporalStatus', 'producedAt', 'sourceRef',
  ]) {
    if (Object.hasOwn(authority, field)) projected[field] = boundedScalar(authority[field]);
  }
  for (const field of ['authorityOrder', 'verificationBeforeReuse']) {
    if (Object.hasOwn(authority, field)) projected[field] = boundedArray(authority[field]);
  }
  return projected;
}

function memoryAuthorityAttestationPayload(node) {
  const profile = profileOf(node);
  if (!profile) throw new TypeError('memory authority profile is required');
  const identity = boundedScalar(node?.id ?? node?.memory_id);
  if (!((typeof identity === 'string' && identity.trim())
      || (Number.isSafeInteger(identity) && identity >= 0))) {
    throw new TypeError('memory authority durable identity is required');
  }
  const evidence = asRecord(node?.evidence);
  const provenance = asRecord(node?.provenance);
  return {
    v: 1,
    identity,
    content: {
      concept: boundedScalar(node?.concept, MAX_TEXT_BYTES),
      content: boundedScalar(node?.content, MAX_TEXT_BYTES),
      statement: boundedScalar(node?.statement, MAX_TEXT_BYTES),
      summary: boundedScalar(node?.summary, MAX_TEXT_BYTES),
      title: boundedScalar(node?.title, MAX_TEXT_BYTES),
      keyPhrase: boundedScalar(node?.keyPhrase, MAX_TEXT_BYTES),
    },
    classification: {
      tag: boundedScalar(node?.tag),
      type: boundedScalar(node?.type),
      tags: boundedArray(node?.tags),
      actor: boundedScalar(node?.actor),
      status: boundedScalar(node?.status),
      asserted_at: boundedTime(node?.asserted_at),
      source_event_at: boundedTime(node?.source_event_at),
      source_time: boundedTime(node?.source_time),
      reported_at: boundedTime(node?.reported_at),
      created: boundedTime(node?.created),
      created_at: boundedTime(node?.created_at),
      superseded_by: boundedScalar(node?.superseded_by),
      confidence_decay: boundedScalar(node?.confidence_decay),
      source_class: boundedScalar(node?.source_class),
      sourceClass: boundedScalar(node?.sourceClass),
      salienceWeight: boundedScalar(node?.salienceWeight),
      incidentId: boundedScalar(node?.incidentId),
      incident_id: boundedScalar(node?.incident_id),
      goalId: boundedScalar(node?.goalId),
      goal_id: boundedScalar(node?.goal_id),
      resolved_at: boundedTime(node?.resolved_at),
      resolvedAt: boundedTime(node?.resolvedAt),
    },
    profile: profilePayload(profile),
    provenance: provenancePayload(provenance),
    provenanceAuthority: authorityPayload(asRecord(provenance.authority)),
    evidenceLinks: boundedArray(evidence.evidence_links),
    metadata: metadataPayload(asRecord(node?.metadata)),
  };
}

function assertKey(key) {
  const valid = (typeof key === 'string' && /^[a-f0-9]{64}$/i.test(key))
    || (Buffer.isBuffer(key) && key.length === 32);
  if (!valid) throw new TypeError('memory authority attestation key is unavailable');
}

function deriveMemoryAuthorityAttestationKey(capabilityKey) {
  assertKey(capabilityKey);
  return createHmac('sha256', capabilityKey).update(DERIVATION_CONTEXT).digest('hex');
}

function memoryAuthorityAttestationKeyId(key = process.env[ATTESTATION_ENV]) {
  assertKey(key);
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function createMemoryAuthorityAttestation(node, key) {
  assertKey(key);
  const payload = canonicalJson(memoryAuthorityAttestationPayload(node));
  const signature = createHmac('sha256', key).update(payload).digest('base64url');
  const keyId = memoryAuthorityAttestationKeyId(key);
  return Object.freeze({
    schema: ATTESTATION_SCHEMA,
    algorithm: ATTESTATION_ALGORITHM,
    keyId,
    signature,
  });
}

function attestMemoryAuthority(node, key = process.env[ATTESTATION_ENV]) {
  const profile = profileOf(node);
  if (!profile) throw new TypeError('memory authority profile is required');
  profile.attestation = createMemoryAuthorityAttestation(node, key);
  return node;
}

function attestMemoryAuthorityIfAvailable(node, key = process.env[ATTESTATION_ENV]) {
  if (key === undefined || key === null || key === '') return node;
  try {
    return attestMemoryAuthority(node, key);
  } catch {
    const profile = profileOf(node);
    if (profile) {
      try { delete profile.attestation; } catch { /* verification still fails closed */ }
    }
    return node;
  }
}

function verifyMemoryAuthorityAttestation(node, key = process.env[ATTESTATION_ENV]) {
  const profile = profileOf(node);
  const attestation = asRecord(profile?.attestation);
  if (attestation.schema !== ATTESTATION_SCHEMA
      || attestation.algorithm !== ATTESTATION_ALGORITHM
      || typeof attestation.keyId !== 'string'
      || typeof attestation.signature !== 'string') return false;
  try {
    assertKey(key);
    const expected = createMemoryAuthorityAttestation(node, key);
    const suppliedBytes = Buffer.from(attestation.signature, 'base64url');
    const expectedBytes = Buffer.from(expected.signature, 'base64url');
    return attestation.keyId === expected.keyId
      && suppliedBytes.length === 32
      && expectedBytes.length === suppliedBytes.length
      && timingSafeEqual(expectedBytes, suppliedBytes);
  } catch {
    return false;
  }
}

module.exports = {
  ATTESTATION_ALGORITHM,
  ATTESTATION_ENV,
  ATTESTATION_SCHEMA,
  attestMemoryAuthority,
  attestMemoryAuthorityIfAvailable,
  createMemoryAuthorityAttestation,
  deriveMemoryAuthorityAttestationKey,
  memoryAuthorityAttestationKeyId,
  memoryAuthorityAttestationPayload,
  verifyMemoryAuthorityAttestation,
};
