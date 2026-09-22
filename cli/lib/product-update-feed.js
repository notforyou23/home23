/** Read-only local release-feed inspection. No network, staging, or home writes. */
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { readPrivateJSON } from './product-environment.js';
import { readProductManifest } from './product-payload.js';

const FEED_SCHEMA = 'home23.release-feed.v1';
const INSTALL_SCHEMA = 'home23.product-install.v1';
const HEX64 = /^[a-f0-9]{64}$/;
const HEX40 = /^[a-f0-9]{40}$/;

const reason = (code, message) => ({ code, message });

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
