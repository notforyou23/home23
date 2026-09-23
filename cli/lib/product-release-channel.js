/** Bundled private release channel. This module never modifies a running home. */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs';
import https from 'node:https';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readProductManifest, verifyProductPayload } from './product-payload.js';
import { extractProductArchive } from './product-update-feed.js';
import { stageProductPayload } from './product-update-stage.js';

const hex64 = /^[a-f0-9]{64}$/;
const hex40 = /^[a-f0-9]{40}$/;
const rawKey = /^[A-Za-z0-9+/]{43}=$/;
const maxManifestBytes = 256 * 1024;
const maxArtifactBytes = 4 * 1024 * 1024 * 1024;
const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');

function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function httpsURL(value) {
  let url;
  try { url = new URL(value); } catch { throw failure('channel_invalid', 'Invalid release URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || !url.hostname) {
    throw failure('channel_invalid', 'Release URLs must use HTTPS without credentials or fragments');
  }
  return url;
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function signedReleaseBytes(release) { return Buffer.from(canonical(release), 'utf8'); }

export function readProductChannel(channelConfigPath) {
  const channel = JSON.parse(readFileSync(channelConfigPath, 'utf8'));
  if (channel?.schema !== 'home23.product-channel.v1' || channel.channel !== 'private'
      || !rawKey.test(channel.publicKey || '') || Buffer.from(channel.publicKey, 'base64').length !== 32) {
    throw failure('channel_invalid', 'Bundled release channel is invalid');
  }
  httpsURL(channel.manifestURL);
  return channel;
}

function validateArtifact(artifact, kind) {
  if (artifact?.kind !== kind || !hex64.test(artifact.sha256 || '')
      || !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0 || artifact.bytes > maxArtifactBytes) {
    throw failure('manifest_invalid', 'Release artifact metadata is invalid');
  }
  httpsURL(artifact.url);
}

export function verifyProductChannelManifest(channel, envelope) {
  const release = envelope?.release;
  if (envelope?.schema !== 'home23.signed-release.v1' || !release ||
      release.platform !== 'darwin' || !['arm64', 'x64'].includes(release.arch) ||
      !hex64.test(release.packageId || '') || !hex40.test(release.sourceCommit || '') ||
      typeof release.version !== 'string' || !/^\d+(?:\.\d+)*$/.test(release.version) ||
      !Number.isSafeInteger(release.appBuild) || release.appBuild <= 0 ||
      !/^\d+(?:\.\d+)*$/.test(release.minimumOs || '') ||
      release.compatibility?.installationSchema !== 'home23.product-install.v1' ||
      release.compatibility?.coordinationSchema !== 20 ||
      release.compatibility?.stateMigration !== 'schema_preserving_only' ||
      !Number.isSafeInteger(release.compatibility?.minimumClientBuild) || release.compatibility.minimumClientBuild < 0 ||
      release.appBundleIdentifier !== 'com.regina6.home23.mac' ||
      release.hostBundleIdentifier !== 'com.home23.host') {
    throw failure('manifest_invalid', 'Signed release compatibility or identity is invalid');
  }
  validateArtifact(release.runtime, 'https-tar');
  validateArtifact(release.app, 'https-zip');
  if (release.appDeliveryURL !== null) httpsURL(release.appDeliveryURL);
  const keyBytes = Buffer.from(channel.publicKey, 'base64');
  const key = createPublicKey({ key: Buffer.concat([spkiPrefix, keyBytes]), format: 'der', type: 'spki' });
  const signature = Buffer.from(envelope.signature || '', 'base64');
  if (signature.length !== 64 || !verify(null, signedReleaseBytes(release), key, signature)) {
    throw failure('signature_invalid', 'Release manifest signature is invalid');
  }
  return release;
}

function request(url, headers = {}) {
  return new Promise((resolveRequest, rejectRequest) => {
    const req = https.get(httpsURL(url), { headers, timeout: 30_000 }, resolveRequest);
    req.on('timeout', () => req.destroy(failure('channel_unavailable', 'Release server timed out')));
    req.on('error', rejectRequest);
  });
}
async function fetchManifest(url) {
  const response = await request(url);
  if (response.statusCode !== 200) { response.resume(); throw failure('channel_unavailable', 'Release manifest is unavailable'); }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response) {
    bytes += chunk.length;
    if (bytes > maxManifestBytes) { response.destroy(); throw failure('manifest_invalid', 'Release manifest is too large'); }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw failure('manifest_invalid', 'Release manifest is not JSON'); }
}
function compareVersion(left, right) {
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
  }
  return 0;
}
export async function inspectProductChannel({ channelConfigPath, installedPackageId, installedAppBuild, platform = process.platform, arch = process.arch, osVersion } = {}) {
  try {
    const channel = readProductChannel(channelConfigPath);
    const release = verifyProductChannelManifest(channel, await fetchManifest(channel.manifestURL));
    if (release.platform !== platform || release.arch !== arch || !osVersion || compareVersion(osVersion, release.minimumOs) < 0) {
      return { status: 'incompatible', release, reason: 'This Mac cannot run the offered release' };
    }
    const appCurrent = Number(installedAppBuild) >= release.appBuild;
    const runtimeCurrent = installedPackageId === release.packageId;
    return { status: appCurrent && runtimeCurrent ? 'current' : 'available', release,
      version: release.version, appBuild: release.appBuild, packageId: release.packageId,
      minimumClientBuild: release.compatibility.minimumClientBuild, appDeliveryURL: release.appDeliveryURL,
      components: { app: appCurrent ? 'current' : 'available', runtime: runtimeCurrent ? 'current' : 'available' } };
  } catch (error) {
    return { status: 'unavailable', reason: error.message, code: error.code || 'channel_unavailable' };
  }
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Resume with HTTP Range; never publish a partial file as verified. */
export async function downloadChannelArtifact({ artifact, destinationDirectory, name, onProgress }) {
  validateArtifact(artifact, artifact.kind);
  if (!['https-tar', 'https-zip'].includes(artifact.kind) || !/^[a-z0-9-]+$/.test(name)) {
    throw failure('manifest_invalid', 'Invalid release artifact selection');
  }
  const directory = resolve(destinationDirectory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const finalPath = join(directory, `${name}.${artifact.kind === 'https-tar' ? 'tar' : 'zip'}`);
  const partial = `${finalPath}.partial`;
  if (existsSync(finalPath) && statSync(finalPath).size === artifact.bytes && await hashFile(finalPath) === artifact.sha256) {
    return finalPath;
  }
  let offset = existsSync(partial) ? statSync(partial).size : 0;
  if (offset > artifact.bytes) { unlinkSync(partial); offset = 0; }
  const response = await request(artifact.url, offset ? { Range: `bytes=${offset}-` } : {});
  if (response.statusCode !== (offset ? 206 : 200)) {
    response.resume();
    throw failure('download_incomplete', 'Release server did not honor the required byte range');
  }
  const contentRange = response.headers['content-range'];
  if (offset && contentRange !== `bytes ${offset}-${artifact.bytes - 1}/${artifact.bytes}`) {
    response.resume(); throw failure('download_incomplete', 'Release server returned a different byte range');
  }
  const expectedLength = artifact.bytes - offset;
  if (Number(response.headers['content-length']) !== expectedLength) {
    response.resume(); throw failure('download_incomplete', 'Release artifact length changed');
  }
  const out = createWriteStream(partial, { flags: offset ? 'a' : 'w', mode: 0o600 });
  out.on('error', error => response.destroy(error));
  let copied = offset;
  try {
    for await (const chunk of response) {
      copied += chunk.length;
      if (copied > artifact.bytes) throw failure('download_incomplete', 'Release artifact exceeded its signed size');
      if (!out.write(chunk)) await new Promise((resolveDrain, rejectDrain) => { out.once('drain', resolveDrain); out.once('error', rejectDrain); });
      onProgress?.({ phase: 'downloading', bytesCopied: copied, bytesTotal: artifact.bytes });
    }
    await new Promise((resolveEnd, rejectEnd) => { out.end(resolveEnd); out.once('error', rejectEnd); });
  } catch (error) { out.destroy(); throw error; }
  if (copied !== artifact.bytes || await hashFile(partial) !== artifact.sha256) {
    throw failure('digest_mismatch', 'Release artifact is incomplete or has the wrong SHA-256');
  }
  renameSync(partial, finalPath);
  onProgress?.({ phase: 'verified', bytesCopied: copied, bytesTotal: artifact.bytes });
  return finalPath;
}

export async function downloadProductRelease({ release, destinationDirectory, onProgress } = {}) {
  // Call only with a release returned by inspectProductChannel; signed metadata
  // binds both artifacts and compatibility before either byte is downloaded.
  const runtimeArchive = await downloadChannelArtifact({ artifact: release.runtime, destinationDirectory,
    name: `runtime-${release.packageId}`, onProgress });
  const appArchive = await downloadChannelArtifact({ artifact: release.app, destinationDirectory,
    name: `app-${release.appBuild}`, onProgress });
  return { runtimeArchive, appArchive, packageId: release.packageId, appBuild: release.appBuild };
}

export async function checkConfiguredRelease({ homeRoot, installedAppPath, channelConfigPath, osVersion } = {}) {
  channelConfigPath ||= join(resolve(installedAppPath), 'Contents/Resources/release-channel.json');
  let installedPackageId = null;
  try { installedPackageId = JSON.parse(readFileSync(join(resolve(homeRoot), '.home23-install.json'), 'utf8')).packageId; }
  catch { /* An absent install has no current runtime. */ }
  let installedAppBuild = 0;
  try {
    const info = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(installedAppPath, 'Contents/Info.plist')], { encoding: 'utf8' }));
    installedAppBuild = Number(info.CFBundleVersion) || 0;
  } catch { /* An absent app has no current build. */ }
  const macOS = osVersion || (process.platform === 'darwin'
    ? execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim() : '0');
  return inspectProductChannel({ channelConfigPath, installedPackageId, installedAppBuild,
    osVersion: macOS, platform: process.platform, arch: process.arch });
}

export async function prepareConfiguredRelease({ homeRoot, installedAppPath, channelConfigPath, staging,
  downloadDirectory, osVersion, onProgress } = {}) {
  const checked = await checkConfiguredRelease({ homeRoot, installedAppPath, channelConfigPath, osVersion });
  if (checked.status !== 'available') throw failure(checked.code || 'release_unavailable', checked.reason || 'No compatible update is available');
  const release = checked.release;
  const files = await downloadProductRelease({ release, destinationDirectory: downloadDirectory, onProgress });
  const extracted = join(resolve(downloadDirectory), `runtime-${release.packageId}.extracted`);
  let usableExtraction = false;
  if (existsSync(extracted)) {
    try { usableExtraction = verifyProductPayload(extracted).packageId === release.packageId; }
    catch { /* An interrupted extraction is rebuilt from the verified archive. */ }
    if (!usableExtraction) rmSync(extracted, { recursive: true, force: true });
  }
  if (!usableExtraction) {
    mkdirSync(extracted, { mode: 0o700 });
    extractProductArchive({ archivePath: files.runtimeArchive, destinationDirectory: extracted });
  }
  const manifest = readProductManifest(extracted);
  if (manifest.packageId !== release.packageId || manifest.sourceCommit !== release.sourceCommit) {
    throw failure('digest_mismatch', 'Release runtime does not match its signed manifest');
  }
  const staged = stageProductPayload({ homeRoot, candidatePayload: extracted, staging });
  if (staged.receipt.candidatePackageId !== release.packageId) throw failure('digest_mismatch', 'Staged runtime changed');
  const { prepareMacApplication } = await import('./product-app-update.js');
  const app = prepareMacApplication({ archivePath: files.appArchive, installedAppPath, release });
  return { status: 'prepared', release, candidatePayload: join(resolve(staging), 'payload'),
    staging: resolve(staging), preparedAppPath: app.preparedAppPath, installedAppPath: app.installedAppPath,
    lifecyclePath: app.lifecyclePath,
    packageId: release.packageId, appBuild: release.appBuild };
}
