'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const RECEIPT_VERSION = 'evidence.v1';

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = sortKeys(value[key]);
  }
  return out;
}

function artifactFromPath(filePath, opts = {}) {
  const resolved = path.resolve(String(filePath));
  const bytes = fs.readFileSync(resolved);
  return compactObject({
    role: opts.role || null,
    path: resolved,
    sha256: sha256Buffer(bytes),
    bytes: bytes.length,
    canonicalization: opts.canonicalization || 'file-bytes.v1',
  });
}

function artifactFromBytes({ url, path: filePath, bytes, role, canonicalization = 'response-bytes.v1' }) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes ?? ''), 'utf8');
  return compactObject({
    role: role || null,
    url: url || null,
    path: filePath ? path.resolve(String(filePath)) : null,
    sha256: sha256Buffer(buf),
    bytes: buf.length,
    canonicalization,
  });
}

function normalizeCheck(check) {
  const out = {
    name: String(check?.name || 'unnamed_check'),
    pass: Boolean(check?.pass),
  };
  if (check?.detail !== undefined) out.detail = String(check.detail);
  if (check?.observed !== undefined) out.observed = check.observed;
  if (check?.verifier !== undefined) out.verifier = check.verifier;
  return out;
}

function buildEvidenceReceipt(opts = {}) {
  const checks = Array.isArray(opts.checks) ? opts.checks.map(normalizeCheck) : [];
  const result = opts.result || (checks.every((c) => c.pass) ? 'pass' : 'fail');
  const claimLevel = opts.claimLevel || (result === 'pass' ? 'verified_claim' : 'candidate_claim');
  const createdAt = opts.createdAt || new Date().toISOString();

  const receipt = compactObject({
    receiptVersion: RECEIPT_VERSION,
    actor: String(opts.actor || 'unknown'),
    action: String(opts.action || 'unknown'),
    subject: String(opts.subject || 'unknown'),
    sourceSurface: opts.sourceSurface || null,
    sourceArtifacts: Array.isArray(opts.sourceArtifacts) ? opts.sourceArtifacts : [],
    derivedArtifacts: Array.isArray(opts.derivedArtifacts) ? opts.derivedArtifacts : [],
    checks,
    result,
    claimLevel,
    createdAt,
    correctionOf: opts.correctionOf || null,
    metadata: opts.metadata || null,
  });

  return {
    receiptId: `ev_${sha256Buffer(Buffer.from(canonicalJson(receipt))).slice(0, 24)}`,
    ...receipt,
  };
}

function writeEvidenceReceipt({ receipt, receiptPath, indexPath }) {
  if (!receipt || receipt.receiptVersion !== RECEIPT_VERSION) {
    throw new Error('writeEvidenceReceipt requires an evidence.v1 receipt');
  }
  if (!receiptPath) throw new Error('receiptPath required');
  const resolvedReceiptPath = path.resolve(receiptPath);
  fs.mkdirSync(path.dirname(resolvedReceiptPath), { recursive: true });
  fs.writeFileSync(resolvedReceiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');

  if (indexPath) {
    const resolvedIndexPath = path.resolve(indexPath);
    fs.mkdirSync(path.dirname(resolvedIndexPath), { recursive: true });
    const indexRecord = compactObject({
      receiptId: receipt.receiptId,
      path: resolvedReceiptPath,
      subject: receipt.subject,
      action: receipt.action,
      result: receipt.result,
      claimLevel: receipt.claimLevel,
      createdAt: receipt.createdAt,
      correctionOf: receipt.correctionOf || null,
    });
    fs.appendFileSync(resolvedIndexPath, `${JSON.stringify(indexRecord)}\n`, 'utf8');
  }

  return { receiptPath: resolvedReceiptPath, indexPath: indexPath ? path.resolve(indexPath) : null };
}

function safeReceiptPart(value) {
  return String(value || 'unknown')
    .trim()
    .replace(/[^a-z0-9_.-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160) || 'unknown';
}

function compactObject(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

module.exports = {
  RECEIPT_VERSION,
  artifactFromBytes,
  artifactFromPath,
  buildEvidenceReceipt,
  canonicalJson,
  safeReceiptPart,
  sha256Buffer,
  writeEvidenceReceipt,
};
