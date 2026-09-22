/** Local release-feed inspection and authenticated development staging. */
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import http from 'node:http';
import { isAbsolute, join, resolve } from 'node:path';
import { readPrivateJSON } from './product-environment.js';
import { readProductManifest, verifyProductPayload } from './product-payload.js';
import { stageProductPayload } from './product-update-stage.js';

const FEED_SCHEMA = 'home23.release-feed.v1';
const TRUST_SCHEMA = 'home23.release-trust.v1';
const INSTALL_SCHEMA = 'home23.product-install.v1';
const HEX64 = /^[a-f0-9]{64}$/;
const HEX40 = /^[a-f0-9]{40}$/;
/** Hard cap for HTTP release-archive bodies exercised against a local test server. */
const RELEASE_ARCHIVE_MAX_BYTES = 64 * 1024 * 1024;
/** SPKI prefix for a 32-byte Ed25519 public key (RFC 8410). */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const reason = (code, message) => ({ code, message });

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function baseResult(extra = {}) {
  return {
    publisherTrust: 'unverified',
    canInstall: false,
    networkInstall: false,
    distribution: 'local-untrusted',
    installedPackageId: null,
    reasons: [],
    ...extra,
  };
}

function unavailable(reasons, installedPackageId = null) {
  return baseResult({ installedPackageId, status: 'unavailable', reasons });
}

function withRelease(result, release) {
  result.version = release.version;
  result.packageId = release.packageId;
  result.sourceCommit = release.sourceCommit;
  result.notes = release.notes;
  result.platform = release.platform;
  result.arch = release.arch;
  return result;
}

function readInstalledPackageId(homeRoot) {
  if (typeof homeRoot !== 'string' || !homeRoot) return null;
  const receiptPath = join(resolve(homeRoot), '.home23-install.json');
  try {
    if (!existsSync(receiptPath)) return null;
    const receipt = readPrivateJSON(receiptPath);
    if (!receipt || receipt.schema !== INSTALL_SCHEMA) return null;
    return typeof receipt.packageId === 'string' && receipt.packageId ? receipt.packageId : null;
  } catch {
    return null;
  }
}

function readFeed(feedPath) {
  if (typeof feedPath !== 'string' || !feedPath) {
    return { error: reason('feed_unavailable', 'A release feed path is required.') };
  }
  const path = resolve(feedPath);
  try {
    if (!existsSync(path) || !lstatSync(path).isFile()) {
      return { error: reason('feed_unavailable', 'The release feed is missing.') };
    }
    return { feed: JSON.parse(readFileSync(path, 'utf8')) };
  } catch {
    return { error: reason('feed_unreadable', 'The release feed could not be read as JSON.') };
  }
}

function offeredRelease(feed) {
  if (!feed || feed.schema !== FEED_SCHEMA) return null;
  if (feed.channel !== 'development' && feed.channel !== 'release') return null;
  if (!Array.isArray(feed.releases) || feed.releases.length === 0) return null;
  const release = feed.releases[0];
  if (!release || typeof release !== 'object') return null;
  if (typeof release.version !== 'string' || !release.version) return null;
  if (typeof release.packageId !== 'string' || !HEX64.test(release.packageId)) return null;
  if (typeof release.sourceCommit !== 'string' || !HEX40.test(release.sourceCommit)) return null;
  if (typeof release.platform !== 'string' || !release.platform) return null;
  if (typeof release.arch !== 'string' || !release.arch) return null;
  if (typeof release.minimumOs !== 'string' || !release.minimumOs) return null;
  if (typeof release.notes !== 'string') return null;
  const compatibility = release.compatibility;
  if (!compatibility || typeof compatibility !== 'object') return null;
  const artifact = release.artifact;
  if (!artifact || typeof artifact !== 'object') return null;
  if (artifact.kind !== 'local-directory') return null;
  if (typeof artifact.path !== 'string' || !isAbsolute(artifact.path)) return null;
  if (typeof artifact.sha256 !== 'string' || !HEX64.test(artifact.sha256)) return null;
  return release;
}

function compatibilityMatches(compatibility) {
  return compatibility?.installationSchema === INSTALL_SCHEMA
    && compatibility?.coordinationSchema === 20
    && compatibility?.stateMigration === 'schema_preserving_only';
}

function artifactDirectoryPresent(artifactPath) {
  try {
    const stat = lstatSync(artifactPath);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    return false;
  }
}

/** Inspect one local release feed against an optional installed home. Read-only. */
export function inspectReleaseFeed({ homeRoot, feedPath } = {}) {
  const installedPackageId = readInstalledPackageId(homeRoot);
  const loaded = readFeed(feedPath);
  if (loaded.error) return unavailable([loaded.error], installedPackageId);

  const feed = loaded.feed;
  const release = offeredRelease(feed);
  if (!release) {
    return unavailable([reason('feed_unavailable', 'The release feed has no offered release.')], installedPackageId);
  }

  const result = baseResult({ installedPackageId, status: 'available', reasons: [] });
  withRelease(result, release);

  if (feed.publisherTrust !== 'unverified') {
    result.status = 'damaged';
    result.reasons.push(reason('untrusted_feed_claim', 'This milestone only accepts unverified local release feeds.'));
    return result;
  }

  if (release.artifact.sha256 !== release.packageId) {
    result.status = 'damaged';
    result.reasons.push(reason('digest_mismatch', 'The release artifact digest does not match its package id.'));
    return result;
  }

  const artifactPath = resolve(release.artifact.path);
  if (!artifactDirectoryPresent(artifactPath)) {
    result.status = 'damaged';
    result.reasons.push(reason('artifact_missing', 'The release artifact directory is missing.'));
    return result;
  }

  let manifest;
  try {
    manifest = readProductManifest(artifactPath);
  } catch {
    result.status = 'damaged';
    result.reasons.push(reason('manifest_unreadable', 'The release artifact manifest could not be read.'));
    return result;
  }
  if (manifest.packageId !== release.packageId) {
    result.status = 'damaged';
    result.reasons.push(reason('manifest_package_mismatch', 'The artifact manifest package id does not match the offered release.'));
    return result;
  }

  if (release.platform !== process.platform || release.arch !== process.arch || !compatibilityMatches(release.compatibility)) {
    result.status = 'incompatible';
    result.reasons.push(reason('incompatible_release', 'The offered release does not match this machine or required compatibility contracts.'));
    return result;
  }

  if (installedPackageId && installedPackageId === release.packageId) {
    result.status = 'current';
    return result;
  }

  result.status = 'available';
  return result;
}

function readDevelopmentTrustKey(trustKeyPath) {
  if (typeof trustKeyPath !== 'string' || !trustKeyPath) {
    throw codedError('signature_invalid', 'A development release trust key path is required.');
  }
  const path = resolve(trustKeyPath);
  let body;
  try {
    if (!existsSync(path) || !lstatSync(path).isFile()) {
      throw codedError('signature_invalid', 'The development release trust key is missing.');
    }
    body = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error.code === 'signature_invalid') throw error;
    throw codedError('signature_invalid', 'The development release trust key could not be read.');
  }
  if (!body || body.schema !== TRUST_SCHEMA || body.algorithm !== 'ed25519' || body.trust !== 'development'
      || typeof body.publicKey !== 'string' || !body.publicKey) {
    throw codedError('signature_invalid', 'The development release trust key is invalid.');
  }
  let raw;
  try {
    raw = Buffer.from(body.publicKey, 'base64');
  } catch {
    throw codedError('signature_invalid', 'The development release trust key public key is invalid.');
  }
  if (raw.length !== 32) {
    throw codedError('signature_invalid', 'The development release trust key public key must be 32 raw bytes.');
  }
  try {
    return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
  } catch {
    throw codedError('signature_invalid', 'The development release trust key public key could not be loaded.');
  }
}

function verifyDevelopmentReleaseSignature(release, trustKeyPath) {
  const trust = release.trust;
  if (!trust || typeof trust !== 'object' || trust.algorithm !== 'ed25519'
      || typeof trust.signature !== 'string' || !trust.signature) {
    throw codedError('signature_invalid', 'The offered release is missing a development Ed25519 signature.');
  }
  const publicKey = readDevelopmentTrustKey(trustKeyPath);
  let signature;
  try {
    signature = Buffer.from(trust.signature, 'base64');
  } catch {
    throw codedError('signature_invalid', 'The offered release signature is not valid base64.');
  }
  let ok = false;
  try {
    ok = verify(null, Buffer.from(release.packageId, 'utf8'), publicKey, signature);
  } catch {
    throw codedError('signature_invalid', 'The offered release signature could not be verified.');
  }
  if (!ok) {
    throw codedError('signature_invalid', 'The offered release signature does not match the development trust key.');
  }
}

/**
 * Resolve a development-signed local release for staging. Does not copy or touch the home.
 * Unverified feeds stay inspection-only; non-development trust claims are refused.
 */
function resolveDevelopmentReleaseForStaging({ feedPath, trustKeyPath }) {
  const loaded = readFeed(feedPath);
  if (loaded.error) throw codedError(loaded.error.code, loaded.error.message);

  const feed = loaded.feed;
  const release = offeredRelease(feed);
  if (!release) {
    throw codedError('feed_unavailable', 'The release feed has no offered release.');
  }

  if (feed.publisherTrust === 'unverified') {
    throw codedError('trust_required', 'Unverified local feeds must be inspected; they cannot be staged as authenticated releases.');
  }
  if (feed.publisherTrust !== 'development') {
    throw codedError('untrusted_feed_claim', 'Only development-signed local release feeds may be staged in this milestone.');
  }

  verifyDevelopmentReleaseSignature(release, trustKeyPath);

  if (release.artifact.sha256 !== release.packageId) {
    throw codedError('digest_mismatch', 'The release artifact digest does not match its package id.');
  }

  const artifactPath = resolve(release.artifact.path);
  let manifest;
  try {
    manifest = readProductManifest(artifactPath);
  } catch {
    throw codedError('digest_mismatch', 'The release artifact manifest could not be read for digest verification.');
  }
  if (manifest.packageId !== release.packageId) {
    throw codedError('digest_mismatch', 'The artifact manifest package id does not match the offered release.');
  }

  return { release, artifactPath, manifest };
}

function manifestFileBytesTotal(manifest) {
  return manifest.files
    .filter(entry => entry.type === 'file')
    .reduce((total, entry) => total + entry.size, 0);
}

function stagedFileBytesCopied(staging, manifest) {
  const payload = join(staging, 'payload');
  let copied = 0;
  for (const entry of manifest.files) {
    if (entry.type !== 'file') continue;
    try {
      if (existsSync(join(payload, entry.path))) copied += entry.size;
    } catch {
      // Ignore probe failures; stageProductPayload owns integrity.
    }
  }
  return copied;
}

function stageClaimIsCopying(staging) {
  const claimPath = `${staging}.home23-stage.json`;
  try {
    if (!existsSync(claimPath)) return false;
    const claim = readPrivateJSON(claimPath);
    return Boolean(claim && claim.status === 'copying');
  } catch {
    return false;
  }
}

/**
 * Stage a development-signed local release without mutating the home or applying it.
 * Unverified feeds stay inspection-only; non-development trust claims are refused.
 */
export function stageAuthenticatedRelease({ homeRoot, feedPath, staging, trustKeyPath } = {}) {
  const { release, artifactPath } = resolveDevelopmentReleaseForStaging({ feedPath, trustKeyPath });

  if (typeof staging !== 'string' || !staging) {
    throw codedError('feed_unavailable', 'A staging path is required.');
  }
  const destination = resolve(staging);

  stageProductPayload({
    homeRoot,
    candidatePayload: artifactPath,
    staging: destination,
  });

  const staged = verifyProductPayload(join(destination, 'payload'));
  if (staged.packageId !== release.packageId) {
    throw codedError('digest_mismatch', 'The staged payload package id does not match the offered release.');
  }

  return {
    ok: true,
    status: 'staged',
    packageId: release.packageId,
    publisherTrust: 'development',
    canInstall: false,
    networkInstall: false,
    homeMutated: false,
  };
}

/**
 * Download (stage) a development-signed local release with resumable copy progress.
 * Never mutates the home, never applies an update, and never claims production trust.
 */
export function downloadDevelopmentRelease({
  homeRoot,
  feedPath,
  trustKeyPath,
  staging,
  onProgress,
} = {}) {
  const report = (progress) => {
    if (typeof onProgress === 'function') onProgress(progress);
  };

  let packageId = null;
  let bytesCopied = 0;
  let bytesTotal = 0;

  try {
    const { release, artifactPath, manifest } = resolveDevelopmentReleaseForStaging({
      feedPath,
      trustKeyPath,
    });
    packageId = release.packageId;
    bytesTotal = manifestFileBytesTotal(manifest);

    if (typeof staging !== 'string' || !staging) {
      throw codedError('feed_unavailable', 'A staging path is required.');
    }
    const destination = resolve(staging);

    report({ phase: 'checking', bytesCopied: 0, bytesTotal, packageId });

    const resumed = stageClaimIsCopying(destination);
    bytesCopied = resumed ? stagedFileBytesCopied(destination, manifest) : 0;
    report({
      phase: resumed ? 'resuming' : 'copying',
      bytesCopied,
      bytesTotal,
      packageId,
    });

    stageProductPayload({
      homeRoot,
      candidatePayload: artifactPath,
      staging: destination,
    });

    const staged = verifyProductPayload(join(destination, 'payload'));
    if (staged.packageId !== release.packageId) {
      throw codedError('digest_mismatch', 'The staged payload package id does not match the offered release.');
    }

    bytesCopied = bytesTotal;
    report({ phase: 'staged', bytesCopied, bytesTotal, packageId });

    return {
      ok: true,
      status: 'staged',
      packageId: release.packageId,
      publisherTrust: 'development',
      canInstall: false,
      networkInstall: false,
      homeMutated: false,
      resumed,
    };
  } catch (error) {
    report({ phase: 'failed', bytesCopied, bytesTotal, packageId });
    throw error;
  }
}

const STAGE_CLAIM_SCHEMA = 'home23.product-stage.v1';

function stageClaimPath(staging) {
  return `${resolve(staging)}.home23-stage.json`;
}

/**
 * Read an existing stage claim for download recovery without installing or mutating the home.
 * A missing claim is absent (not current). A copying claim is the recovery point.
 * Reports damage when a staged claim disagrees with the payload manifest; does not rewrite or delete.
 */
export function recoverDownload({ staging } = {}) {
  if (typeof staging !== 'string' || !staging) {
    return { status: 'absent', packageId: null, resumed: false };
  }

  const destination = resolve(staging);
  const claimPath = stageClaimPath(destination);
  if (!existsSync(claimPath)) {
    return { status: 'absent', packageId: null, resumed: false };
  }

  let claim;
  try {
    claim = readPrivateJSON(claimPath);
  } catch {
    return { status: 'damaged', packageId: null, resumed: false };
  }

  if (!claim || claim.schema !== STAGE_CLAIM_SCHEMA
      || typeof claim.candidatePackageId !== 'string' || !claim.candidatePackageId
      || !['copying', 'staged'].includes(claim.status)) {
    const packageId = typeof claim?.candidatePackageId === 'string' && claim.candidatePackageId
      ? claim.candidatePackageId
      : null;
    return { status: 'damaged', packageId, resumed: false };
  }

  const packageId = claim.candidatePackageId;

  if (claim.status === 'copying') {
    return { status: 'copying', packageId, resumed: true };
  }

  // staged — compare claim to payload manifest; report damage only (no rewrite/delete).
  try {
    const manifest = readProductManifest(join(destination, 'payload'));
    if (manifest.packageId !== packageId) {
      return { status: 'damaged', packageId, resumed: false };
    }
  } catch {
    return { status: 'damaged', packageId, resumed: false };
  }

  return { status: 'staged', packageId, resumed: false };
}

/**
 * Accept only explicit loopback HTTP URLs with a port. No HTTPS, no public hosts.
 */
function assertLoopbackHttpArchiveUrl(url) {
  if (typeof url !== 'string' || !url) {
    throw codedError('network_refused', 'A loopback HTTP release archive URL is required.');
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw codedError('network_refused', 'The release archive URL is not a valid loopback HTTP address.');
  }
  if (parsed.protocol !== 'http:') {
    throw codedError('network_refused', 'Release archive downloads accept only http://127.0.0.1 or http://localhost.');
  }
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw codedError('network_refused', 'Release archive downloads refuse non-loopback hosts.');
  }
  if (!parsed.port) {
    throw codedError('network_refused', 'Release archive downloads require an explicit loopback port.');
  }
  return parsed;
}

function unlinkQuiet(path) {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // Best-effort cleanup of a partial temp download.
  }
}

/**
 * GET a release archive from a local loopback HTTP server only.
 * Writes payload.bin only after the body sha256 matches expectedSha256.
 * Does not install, does not touch a home, and does not claim production trust.
 */
export function downloadReleaseArchive({
  url,
  destinationDirectory,
  expectedSha256,
  onProgress,
} = {}) {
  const report = (progress) => {
    if (typeof onProgress === 'function') onProgress(progress);
  };

  let bytesCopied = 0;
  let bytesTotal = null;
  let tempPath = null;

  const fail = (error) => {
    if (tempPath) unlinkQuiet(tempPath);
    report({ phase: 'failed', bytesCopied, bytesTotal });
    return error;
  };

  let parsed;
  try {
    parsed = assertLoopbackHttpArchiveUrl(url);
  } catch (error) {
    throw fail(error);
  }

  if (typeof destinationDirectory !== 'string' || !destinationDirectory) {
    throw fail(codedError('download_incomplete', 'A destination directory is required.'));
  }
  if (typeof expectedSha256 !== 'string' || !HEX64.test(expectedSha256)) {
    throw fail(codedError('digest_mismatch', 'An expected sha256 digest is required.'));
  }

  const destDir = resolve(destinationDirectory);
  const finalPath = join(destDir, 'payload.bin');
  tempPath = join(destDir, `.payload-${randomBytes(8).toString('hex')}.tmp`);

  try {
    mkdirSync(destDir, { recursive: true });
  } catch {
    throw fail(codedError('download_incomplete', 'The destination directory could not be prepared.'));
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const reject = (error) => rejectPromise(fail(error));

    let settled = false;
    const settleReject = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const settleResolve = (value) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };

    const req = http.get(parsed, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        settleReject(codedError('network_refused', 'Release archive downloads do not follow redirects.'));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        settleReject(codedError('download_incomplete', 'The release archive response was incomplete.'));
        return;
      }

      const contentLength = res.headers['content-length'];
      if (contentLength !== undefined) {
        const parsedLength = Number(contentLength);
        bytesTotal = Number.isFinite(parsedLength) ? parsedLength : null;
      }

      const hash = createHash('sha256');
      const out = createWriteStream(tempPath);
      let writeFailed = false;

      const abort = (error) => {
        writeFailed = true;
        res.destroy();
        out.destroy();
        settleReject(error);
      };

      out.on('error', () => {
        abort(codedError('download_incomplete', 'The release archive could not be written.'));
      });

      res.on('data', (chunk) => {
        if (writeFailed || settled) return;
        bytesCopied += chunk.length;
        if (bytesCopied > RELEASE_ARCHIVE_MAX_BYTES) {
          abort(codedError('download_incomplete', 'The release archive exceeds the 64 MiB limit.'));
          return;
        }
        hash.update(chunk);
        if (!out.write(chunk)) {
          res.pause();
          out.once('drain', () => res.resume());
        }
        report({ phase: 'downloading', bytesCopied, bytesTotal });
      });

      res.on('error', () => {
        abort(codedError('download_incomplete', 'The release archive download failed.'));
      });

      res.on('end', () => {
        if (writeFailed || settled) return;
        if (bytesTotal !== null && bytesCopied !== bytesTotal) {
          abort(codedError('download_incomplete', 'The release archive body was truncated.'));
          return;
        }
        out.end(() => {
          if (writeFailed || settled) return;
          const digest = hash.digest('hex');
          if (digest !== expectedSha256) {
            abort(codedError('digest_mismatch', 'The downloaded release archive digest does not match.'));
            return;
          }
          try {
            renameSync(tempPath, finalPath);
            tempPath = null;
          } catch {
            abort(codedError('download_incomplete', 'The verified release archive could not be finalized.'));
            return;
          }
          report({ phase: 'verified', bytesCopied, bytesTotal });
          settleResolve({
            ok: true,
            path: finalPath,
            sha256: digest,
            bytesCopied,
            bytesTotal,
          });
        });
      });
    });

    req.on('error', () => {
      settleReject(codedError('download_incomplete', 'The release archive request failed.'));
    });
  });
}
