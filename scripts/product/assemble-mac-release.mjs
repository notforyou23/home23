#!/usr/bin/env node
/** Assemble a local Host + Mac client download. Never installs or publishes. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyProductPayload } from '../../cli/lib/product-payload.js';
import { readProductChannel } from '../../cli/lib/product-release-channel.js';

const run = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...options });
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
const sha256 = async file => {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};
function sourceRevision(root) {
  if (run('git', ['status', '--porcelain'], { cwd: root }).trim()) throw new Error('Apple source must be clean; use a committed isolated checkout');
  return run('git', ['rev-parse', 'HEAD'], { cwd: root }).trim();
}
function appInfo(app) {
  const info = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Contents/Info.plist')]));
  if (!info.CFBundleExecutable || path.basename(info.CFBundleExecutable) !== info.CFBundleExecutable) throw new Error('Invalid app executable');
  const executable = path.join(app, 'Contents/MacOS', info.CFBundleExecutable);
  const architectures = run('/usr/bin/lipo', ['-archs', executable]).trim().split(/\s+/);
  return { bundleIdentifier: info.CFBundleIdentifier, version: info.CFBundleShortVersionString,
    build: info.CFBundleVersion, minimumMacOS: info.LSMinimumSystemVersion, architectures, executable };
}
export function assertReleasePair({ manifest, hostReceipt, host, client, appleCommit }) {
  if (manifest.platform !== 'darwin') throw new Error('Mac delivery requires a Darwin runtime');
  if (hostReceipt.status !== 'built' || !hostReceipt.runtimeIncluded ||
      hostReceipt.runtime?.packageId !== manifest.packageId || hostReceipt.runtime?.sourceCommit !== manifest.sourceCommit) {
    throw new Error('Host receipt does not identify this complete runtime');
  }
  if (hostReceipt.sourceCommit !== appleCommit) throw new Error('Host was built from a different Apple revision');
  if (host.bundleIdentifier !== 'com.home23.host' || client.bundleIdentifier !== 'com.regina6.home23.mac') {
    throw new Error('Unexpected Host or Mac client identity');
  }
  if (host.version !== client.version || host.build !== client.build || host.minimumMacOS !== client.minimumMacOS) {
    throw new Error('Embedded Host and visible app must share version, build, and minimum macOS');
  }
  const arch = manifest.arch === 'x64' ? 'x86_64' : manifest.arch;
  for (const app of [host, client]) {
    if (!app.architectures.includes(arch)) throw new Error('App does not support the runtime architecture');
    if (!/^\d+(\.\d+)*$/.test(app.minimumMacOS || '')) throw new Error('App minimum macOS is missing');
  }
}
export function localClientEntitlements(source) {
  // Profile-backed APNs is unavailable in an ad-hoc artifact. Preserve the
  // app sandbox and its file/network/media permissions instead of silently
  // building an unsandboxed client with a different persistence environment.
  const result = Object.fromEntries(Object.entries(source).filter(([key]) => key.startsWith('com.apple.security.')));
  if (result['com.apple.security.app-sandbox'] !== true) throw new Error('Mac client sandbox entitlement is required');
  return result;
}
export function newestMacOS(versions) {
  return [...versions].sort((a, b) => {
    const left = a.split('.').map(Number), right = b.split('.').map(Number);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      const diff = (right[i] || 0) - (left[i] || 0); if (diff) return diff;
    }
    return 0;
  })[0];
}
export async function assembleMacRelease({ payload, appleSource, appleCommit, output, developerDir, channelConfig }) {
  if (process.platform !== 'darwin') throw new Error('Mac release assembly requires macOS');
  payload = fs.realpathSync(payload); appleSource = fs.realpathSync(appleSource); output = path.resolve(output);
  if (!fs.statSync(path.dirname(output)).isDirectory()) throw new Error('Output parent must exist');
  // Resolve existing ancestors before enforcing separation (for /tmp and volume aliases).
  output = path.join(fs.realpathSync(path.dirname(output)), path.basename(output));
  if (fs.existsSync(output)) throw new Error('Output already exists; choose a new directory');
  for (const input of [payload, appleSource]) {
    if (inside(input, output) || inside(output, input)) throw new Error('Output must be separate from inputs');
  }
  const revision = sourceRevision(appleSource);
  if (!/^[a-f0-9]{40}$/.test(appleCommit || '') || revision !== appleCommit) throw new Error('Apple checkout must match the explicit full --apple-commit');
  const lockFile = 'Home23.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved';
  run('git', ['ls-files', '--error-unmatch', lockFile], { cwd: appleSource });
  const manifest = verifyProductPayload(payload);
  if (manifest.platform !== 'darwin') throw new Error('Mac assembly requires a Darwin payload');
  const env = { ...process.env, DEVELOPER_DIR: developerDir };
  run('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { env });
  fs.mkdirSync(output);
  const started = Date.now(), build = path.join(output, 'build'), release = path.join(output, 'Home23');
  fs.mkdirSync(build); fs.mkdirSync(release);
  const phase = message => process.stderr.write(`${message}\n`);
  phase('Building the Mac client');
  const derived = path.join(build, 'mac');
  run('/usr/bin/xcodebuild', ['-project', path.join(appleSource, 'Home23.xcodeproj'), '-scheme', 'Home23Mac',
    '-onlyUsePackageVersionsFromResolvedFile', '-configuration', 'Release', '-destination', 'generic/platform=macOS', '-derivedDataPath', derived,
    `ARCHS=${manifest.arch === 'x64' ? 'x86_64' : manifest.arch}`, 'ONLY_ACTIVE_ARCH=NO',
    'CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO', 'build'], { env, stdio: 'inherit' });
  if (sourceRevision(appleSource) !== revision) throw new Error('Apple source changed during assembly');
  const hostBuild = path.join(build, 'host');
  const clientApp = path.join(release, 'Home23.app');
  fs.renameSync(path.join(derived, 'Build/Products/Release/Home23Mac.app'), clientApp);
  const client = appInfo(clientApp);
  phase('Building the embedded Host with the verified runtime');
  run(process.execPath, [path.join(appleSource, 'scripts/build-home23-host.mjs'), '--output', hostBuild, '--payload', payload,
    '--version', client.version, '--build', client.build, '--minimum-macos', client.minimumMacOS], { env, stdio: 'inherit' });
  if (sourceRevision(appleSource) !== revision) throw new Error('Apple source changed during Host assembly');
  const hostReceipt = json(path.join(hostBuild, 'build-receipt.json'));
  const helperDirectory = path.join(clientApp, 'Contents/Library/LoginItems');
  fs.mkdirSync(helperDirectory, { recursive: true });
  const hostApp = path.join(helperDirectory, 'Home23Host.app');
  fs.renameSync(path.join(hostBuild, 'Home23 Host.app'), hostApp);
  const bundled = path.join(hostApp, 'Contents/Resources/Home23Runtime');
  const bundledManifest = verifyProductPayload(bundled);
  if (bundledManifest.packageId !== manifest.packageId) throw new Error('Bundled runtime changed');
  const host = appInfo(hostApp);
  assertReleasePair({ manifest, hostReceipt, host, client, appleCommit: revision });
  if (channelConfig) {
    readProductChannel(channelConfig);
    fs.copyFileSync(channelConfig, path.join(clientApp, 'Contents/Resources/release-channel.json'));
  }
  const lifecycleTool = path.join(clientApp, 'Contents/Resources/home23-app-lifecycle');
  run('/usr/bin/xcrun', ['swiftc', '-O', '-framework', 'AppKit',
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'mac-app-lifecycle.swift'), '-o', lifecycleTool], { env, stdio: 'inherit' });
  run('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', lifecycleTool]);
  // The Host builder already uses an ad-hoc signature. Do the same for the
  // local client, with no signing identity, key access, notarization or upload.
  const entitlementSource = path.join(appleSource, 'Home23Desktop/Home23Mac.entitlements');
  const entitlements = localClientEntitlements(JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', entitlementSource])));
  const entitlementFile = path.join(build, 'client-local-entitlements.plist');
  fs.writeFileSync(entitlementFile, JSON.stringify(entitlements));
  run('/usr/bin/plutil', ['-convert', 'xml1', entitlementFile]);
  run('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', '--entitlements', entitlementFile, clientApp], { stdio: 'inherit' });
  for (const app of [hostApp, clientApp]) run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  const signedEntitlements = path.join(build, 'signed-client-entitlements.plist');
  fs.writeFileSync(signedEntitlements, run('/usr/bin/codesign', ['-d', '--entitlements', ':-', clientApp]));
  const signed = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', signedEntitlements]));
  if (signed['com.apple.security.app-sandbox'] !== true) throw new Error('Signed Mac client lost its sandbox');
  const minimumMacOS = newestMacOS([host.minimumMacOS, client.minimumMacOS]);
  fs.writeFileSync(path.join(release, 'Start Here.txt'), `Home23 — local engineering candidate\n\nRequires macOS ${minimumMacOS} or later on ${manifest.arch}.\nCopy Home23.app to Applications and open it. Its Home23 Host helper and runtime are included inside the app.\n\nThis candidate is ad-hoc signed, not notarized or publicly released.\nThis assembly does not install apps or change an existing home.\nDo not bypass macOS security warnings to treat it as a consumer release.\n`);
  const publicAppInfo = async info => { const { executable, ...rest } = info; return { ...rest, executableSHA256: await sha256(executable) }; };
  const descriptor = { schema: 'home23.mac-release-set.v1', status: 'local-engineering-candidate',
    backendCommit: manifest.sourceCommit, appleCommit: revision, packageId: manifest.packageId,
    platform: 'darwin', arch: manifest.arch, minimumMacOS,
    host: await publicAppInfo(host), client: await publicAppInfo(client),
    appLayout: 'Home23.app/Contents/Library/LoginItems/Home23Host.app',
    signing: 'ad-hoc', channelConfigured: Boolean(channelConfig), clientSandbox: true, clientProfileCapabilities: 'APNs and time-sensitive notifications excluded from local ad-hoc build', notarized: false, published: false, installed: false,
    acceptance: 'assembly-only; owner journeys require separate receipts' };
  fs.writeFileSync(path.join(release, 'release.json'), JSON.stringify(descriptor, null, 2) + '\n');
  phase('Creating the combined local download');
  const archiveName = `Home23-${manifest.arch}-${manifest.packageId.slice(0, 12)}-${revision.slice(0, 12)}.zip`;
  const archive = path.join(output, archiveName);
  run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', release, archive]);
  const archiveSHA256 = await sha256(archive);
  fs.writeFileSync(`${archive}.sha256`, `${archiveSHA256}  ${archiveName}\n`);
  const receipt = { ...descriptor, archive: archiveName, archiveSHA256, bytes: fs.statSync(archive).size,
    elapsedSeconds: (Date.now() - started) / 1000 };
  fs.writeFileSync(path.join(output, 'assembly-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const names = { '--payload': 'payload', '--apple-source': 'appleSource', '--apple-commit': 'appleCommit', '--output': 'output', '--developer-dir': 'developerDir', '--channel-config': 'channelConfig' };
    const options = {};
    for (let i = 2; i < process.argv.length; i += 2) {
      const key = names[process.argv[i]], value = process.argv[i + 1];
      if (!key || !value || value.startsWith('--') || options[key]) throw new Error('Invalid or duplicate assembly argument');
      options[key] = value;
    }
    for (const key of ['payload', 'appleSource', 'appleCommit', 'output', 'developerDir']) if (!options[key]) throw new Error(`Missing ${key}; see docs/product-preview/SIGNING.md`);
    console.log(JSON.stringify(await assembleMacRelease(options), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
