'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RELEASE_ID = /^[a-f0-9]{40}$/;
const SECRET = /^[a-f0-9]{64}$/i;
const ALLOWED_RESIDENTS = Object.freeze({
  jerry: Object.freeze({ label: 'Jerry', secretProperty: 'residentJerryKey' }),
  forrest: Object.freeze({ label: 'Forrest', secretProperty: 'residentForrestKey' }),
});
const REQUIRED_RELEASE_FILES = Object.freeze([
  'scripts/coordination/run.mjs',
  'dist/coordination/resident-protocol/index.js',
  'dist/coordination-adapter/index.js',
]);

function readJsonFile(filePath, label, { privateFile = false } = {}) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  if (privateFile && (stat.mode & 0o077) !== 0) {
    throw new Error(`${label} must not be accessible to group or other users`);
  }
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} must contain valid JSON`, { cause: error });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return value;
}

function requireReleaseFile(releaseRoot, relativePath) {
  const filePath = path.join(releaseRoot, relativePath);
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`active coordination release is missing ${relativePath}`);
  }
}

function residentVersions(pointer) {
  if (pointer.schemaVersion === 1) {
    if (pointer.residentSlug !== 'jerry') {
      throw new Error('schemaVersion 1 active release may enable only resident jerry');
    }
    if (!Number.isSafeInteger(pointer.residentKeyVersion) || pointer.residentKeyVersion < 1) {
      throw new Error('coordination active-release pointer has an invalid Jerry keyVersion');
    }
    return new Map([['jerry', pointer.residentKeyVersion]]);
  }
  if (pointer.schemaVersion !== 2) {
    throw new Error('coordination active-release pointer schemaVersion must be 1 or 2');
  }
  if (!pointer.residents || typeof pointer.residents !== 'object' || Array.isArray(pointer.residents)) {
    throw new Error('coordination active-release pointer residents must be an object');
  }
  const entries = Object.entries(pointer.residents);
  if (entries.length === 0) {
    throw new Error('coordination active-release pointer must enable at least one resident');
  }
  const versions = new Map();
  for (const [slug, resident] of entries) {
    if (!Object.hasOwn(ALLOWED_RESIDENTS, slug)) {
      throw new Error(`coordination active-release pointer contains an unsupported resident: ${slug}`);
    }
    if (!resident || typeof resident !== 'object' || Array.isArray(resident)
        || !Number.isSafeInteger(resident.keyVersion) || resident.keyVersion < 1) {
      throw new Error(`coordination active-release pointer has an invalid ${slug} keyVersion`);
    }
    versions.set(slug, resident.keyVersion);
  }
  return versions;
}

/**
 * Resolve an ignored, installation-local Connected Agents deployment.
 *
 * A missing pointer means resident integration is intentionally managed by
 * public config. Once a pointer exists, every field is fail-closed: normal
 * ecosystem regeneration must not fall back to a stale release, share a
 * resident credential, or grant coordination authority to an unreviewed app.
 */
function resolveActiveCoordinationRelease(home23Root) {
  if (!path.isAbsolute(home23Root)) {
    throw new Error('Home23 root must be absolute');
  }
  const runtimeDir = path.join(home23Root, 'instances', '.house', 'coordination');
  const pointerPath = path.join(runtimeDir, 'active-release.json');
  if (!fs.existsSync(pointerPath)) return null;

  const pointer = readJsonFile(pointerPath, 'coordination active-release pointer');
  if (!RELEASE_ID.test(String(pointer.releaseId || ''))) {
    throw new Error('coordination active-release pointer has an invalid releaseId');
  }
  if (pointer.predecessorReleaseId !== null
      && pointer.predecessorReleaseId !== undefined
      && !RELEASE_ID.test(String(pointer.predecessorReleaseId))) {
    throw new Error('coordination active-release pointer has an invalid predecessorReleaseId');
  }
  const versions = residentVersions(pointer);

  const releaseRoot = path.join(runtimeDir, 'releases', pointer.releaseId);
  const releaseStat = fs.lstatSync(releaseRoot);
  if (!releaseStat.isDirectory() || releaseStat.isSymbolicLink()) {
    throw new Error('active coordination release must be a real directory');
  }
  for (const relativePath of REQUIRED_RELEASE_FILES) {
    requireReleaseFile(releaseRoot, relativePath);
  }

  const secrets = readJsonFile(
    path.join(runtimeDir, 'runtime-secrets.json'),
    'coordination runtime secrets',
    { privateFile: true },
  );
  if (!SECRET.test(String(secrets.capabilityToken || ''))) {
    throw new Error('coordination capability token must contain exactly 32 bytes of hex');
  }

  const socketRoot = path.join(
    os.tmpdir(),
    `home23-coord-${crypto.createHash('sha256').update(home23Root).digest('hex').slice(0, 12)}`,
  );
  const residents = {};
  const seenKeys = new Set();
  for (const [slug, keyVersion] of versions) {
    const definition = ALLOWED_RESIDENTS[slug];
    const key = String(secrets[definition.secretProperty] || '');
    if (!SECRET.test(key)) {
      throw new Error(`${definition.label} resident key must contain exactly 32 bytes of hex`);
    }
    const normalizedKey = key.toLowerCase();
    if (seenKeys.has(normalizedKey)) {
      throw new Error('resident keys must be distinct');
    }
    seenKeys.add(normalizedKey);
    const socketPath = path.join(socketRoot, `resident-${slug}.sock`);
    // Darwin rejects Unix-domain socket paths beyond 103 bytes.
    if (Buffer.byteLength(socketPath) > 103) {
      throw new Error(`${definition.label} resident socket path exceeds the Darwin limit`);
    }
    residents[slug] = Object.freeze({ slug, keyVersion, key, socketPath });
  }

  const frozenResidents = Object.freeze(residents);
  const legacyJerry = frozenResidents.jerry ?? null;
  return Object.freeze({
    releaseId: pointer.releaseId,
    predecessorReleaseId: pointer.predecessorReleaseId ?? null,
    releaseRoot,
    runtimeDir,
    socketRoot,
    residents: frozenResidents,
    capabilityToken: secrets.capabilityToken,
    // Compatibility for the deployed schemaVersion 1 dedicated config. New
    // callers must use residents so distinct authority remains explicit.
    residentSlug: Object.keys(frozenResidents).length === 1 ? Object.keys(frozenResidents)[0] : null,
    residentKeyVersion: legacyJerry?.keyVersion ?? null,
    residentKey: legacyJerry?.key ?? null,
  });
}

module.exports = { resolveActiveCoordinationRelease };
