'use strict';

const {
  projectMemoryRelations,
  hasAuthenticatedAuthorityEvidence,
} = require('./memory-authority.cjs');

const MAX_ANN_LABEL_BYTES = 256 * 1024;
const MAX_ANN_LABEL_ID_BYTES = 4 * 1024;
const MAX_ANN_LABEL_CONCEPT_BYTES = 512;
const MAX_ANN_LABEL_TAG_BYTES = 1024;
const MAX_ANN_LABEL_CLUSTER_BYTES = 1024;
const MAX_ANN_LABEL_CREATED_BYTES = 256;
const MAX_ANN_LABEL_SOURCE_CLASS_BYTES = 128;
const MAX_ANN_LABEL_AUTHORITY_BYTES = 128;
const MAX_ANN_SOURCE_REF_BYTES = 240;
const MAX_ANN_SOURCE_CHAIN = 2;
const ANN_AUTHORITY_PROJECTION_SCHEMA = 'home23.ann-authority-projection.v1';

function contractError(message) {
  const error = new TypeError(message);
  error.code = 'invalid_ann_label';
  return error;
}

function utf8Bytes(value) {
  return Buffer.byteLength(value, 'utf8');
}

function compactUtf8(value, maxBytes) {
  let output = typeof value === 'string' ? value : '';
  while (utf8Bytes(output) > maxBytes && output.length > 0) {
    output = output.slice(0, Math.floor(output.length * 0.9));
  }
  return Buffer.from(output, 'utf8').toString('utf8');
}

function nullableFiniteNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function optionalFiniteNumber(value) {
  return Number.isFinite(value) ? value : undefined;
}

function nullableString(value, maxBytes) {
  return typeof value === 'string' ? compactUtf8(value, maxBytes) : null;
}

function nullableCluster(value) {
  if (Number.isFinite(value)) return value;
  return nullableString(value, MAX_ANN_LABEL_CLUSTER_BYTES);
}

function redactAnnSourceRef(value) {
  if (typeof value !== 'string') return null;
  let output = value.replace(
    /\b([A-Za-z][A-Za-z0-9+.-]*:)(\/(?!\/)(?:[^/\x00\s"'`<>\])},;]+\/)+[^/\x00\s"'`<>\])},;]+)/gu,
    (_match, prefix, localPath) => {
      const basename = localPath.split('/').filter(Boolean).at(-1) || 'source';
      return `${prefix}[redacted-path]/${basename}`;
    },
  );
  for (const pattern of [
    /file:\/\/(?:localhost)?\/[^\x00\s"'`<>\])},;]+/giu,
    /\\\\[^\s\\/"'`<>\])},;]+\\[^\s"'`<>\])},;]+/gu,
    /(?<![A-Za-z0-9_.-])[A-Za-z]:[\\/][^\x00\s"'`<>\])},;]+/gu,
    /(?<![A-Za-z0-9_.:\/\]\-])\/[^\x00\s"'`<>\])},;]+/gu,
  ]) {
    output = output.replace(pattern, (match) => {
      const normalized = match.replace(/^file:\/\/(?:localhost)?/iu, '');
      return `[redacted-path]/${normalized.split(/[\\/]/u).filter(Boolean).at(-1) || 'source'}`;
    });
  }
  return compactUtf8(output, MAX_ANN_SOURCE_REF_BYTES);
}

function projectAnnSourceChain(value) {
  const result = [];
  for (const entry of Array.isArray(value) ? value : []) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const kind = typeof entry.kind === 'string'
      ? compactUtf8(entry.kind, MAX_ANN_LABEL_AUTHORITY_BYTES)
      : null;
    const ref = redactAnnSourceRef(entry.ref);
    if (!kind || !ref) continue;
    result.push({ kind, ref });
    if (result.length >= MAX_ANN_SOURCE_CHAIN) break;
  }
  return result;
}

function projectAnnLabel(label, {
  fallbackSourceClass,
  fallbackSalienceWeight,
  trustedProjection = false,
} = {}) {
  if (!label || typeof label !== 'object' || Array.isArray(label)) {
    throw contractError('ANN label must be an object');
  }
  if (typeof label.id !== 'string' || label.id.length === 0) {
    throw contractError('ANN label id must be a non-empty string');
  }
  if (utf8Bytes(label.id) > MAX_ANN_LABEL_ID_BYTES) {
    throw contractError('ANN label id exceeds byte limit');
  }
  const sourceClass = label.source_class
    ?? label.sourceClass
    ?? label.provenance?.sourceClass
    ?? fallbackSourceClass;
  const salienceWeight = label.salienceWeight ?? fallbackSalienceWeight;
  const projected = {
    id: Buffer.from(label.id, 'utf8').toString('utf8'),
    concept: compactUtf8(label.concept, MAX_ANN_LABEL_CONCEPT_BYTES),
    tag: nullableString(label.tag, MAX_ANN_LABEL_TAG_BYTES),
    weight: nullableFiniteNumber(label.weight),
    activation: nullableFiniteNumber(label.activation),
    cluster: nullableCluster(label.cluster),
    created: nullableString(label.created, MAX_ANN_LABEL_CREATED_BYTES),
    source_class: typeof sourceClass === 'string'
      ? compactUtf8(sourceClass, MAX_ANN_LABEL_SOURCE_CLASS_BYTES)
      : undefined,
    salienceWeight: optionalFiniteNumber(salienceWeight),
    retrievalDomain: typeof label.retrievalDomain === 'string'
      ? compactUtf8(label.retrievalDomain, MAX_ANN_LABEL_AUTHORITY_BYTES)
      : undefined,
    authorityClass: typeof label.authorityClass === 'string'
      ? compactUtf8(label.authorityClass, MAX_ANN_LABEL_AUTHORITY_BYTES)
      : undefined,
    semanticTime: typeof label.semanticTime === 'string'
      ? compactUtf8(label.semanticTime, MAX_ANN_LABEL_AUTHORITY_BYTES)
      : undefined,
    status: typeof label.status === 'string'
      ? compactUtf8(label.status, MAX_ANN_LABEL_AUTHORITY_BYTES)
      : undefined,
    sourceChain: projectAnnSourceChain(label.sourceChain),
    evidencePresent: trustedProjection === true
      ? label.evidencePresent === true
      : hasAuthenticatedAuthorityEvidence(label),
    authorityRelations: projectMemoryRelations(label, { trustedProjection }),
  };
  for (const key of Object.keys(projected)) {
    if (projected[key] === undefined
        || (Array.isArray(projected[key]) && projected[key].length === 0)) delete projected[key];
  }
  if (utf8Bytes(JSON.stringify(projected)) > MAX_ANN_LABEL_BYTES) {
    throw contractError('ANN projected label exceeds byte limit');
  }
  return projected;
}

module.exports = {
  ANN_AUTHORITY_PROJECTION_SCHEMA,
  MAX_ANN_LABEL_BYTES,
  MAX_ANN_LABEL_CONCEPT_BYTES,
  projectAnnLabel,
};
