#!/usr/bin/env node
/** Finalize a verified local assembly for a private Developer ID channel.
 * `--plan` is read-only. `--execute` signs and submits to Apple, and must only
 * be used after the owner has authorized the specific identity/release.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readProductManifest, verifyProductPayload, writeProductManifest } from '../../cli/lib/product-payload.js';
import { readProductChannel } from '../../cli/lib/product-release-channel.js';
import { appTreeDigest, verifyPrebuiltMacClient } from './prebuilt-mac-client.mjs';

const run = (command, args, options = {}) => execFileSync(command, args, {
  encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options,
});
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const sha256 = async file => {
  const digest = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
};
const real = file => fs.realpathSync(file);
const within = (root, file) => file === root || file.startsWith(root + path.sep);
const plist = file => JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file]));
const appInfo = app => {
  const info = plist(path.join(app, 'Contents/Info.plist'));
  const executable = path.join(app, 'Contents/MacOS', info.CFBundleExecutable || '');
  if (!fs.statSync(executable).isFile()) throw new Error('App executable is missing');
  return { bundleIdentifier: info.CFBundleIdentifier, version: info.CFBundleShortVersionString,
    build: info.CFBundleVersion, minimumMacOS: info.LSMinimumSystemVersion,
    architectures: run('/usr/bin/lipo', ['-archs', executable]).trim().split(/\s+/), executable };
};
const cleanCommit = source => {
  if (run('git', ['status', '--porcelain'], { cwd: source }).trim()) throw new Error(`Source is dirty: ${source}`);
  return run('git', ['rev-parse', 'HEAD'], { cwd: source }).trim();
};

/** Refuse any capability loss when changing a development Mac app to production. */
export function assertProductionEntitlements(source, proposed, profile) {
  if (proposed?.['com.apple.application-identifier'] !== 'H7RZ65BN25.com.regina6.home23.mac' ||
      proposed?.['com.apple.developer.team-identifier'] !== 'H7RZ65BN25' ||
      profile?.['com.apple.application-identifier'] !== 'H7RZ65BN25.com.regina6.home23.mac' ||
      profile?.['com.apple.developer.team-identifier'] !== 'H7RZ65BN25') {
    throw new Error('Mac application and Team entitlements must match the provisioning profile');
  }
  if (source?.['com.apple.security.app-sandbox'] !== true ||
      proposed?.['com.apple.security.app-sandbox'] !== true) throw new Error('Mac sandbox must be preserved');
  for (const [key, value] of Object.entries(source)) {
    if (key === 'com.apple.developer.aps-environment') continue;
    if (JSON.stringify(proposed[key]) !== JSON.stringify(value)) throw new Error(`Production entitlement lost: ${key}`);
  }
  if (proposed['com.apple.developer.aps-environment'] !== 'production' ||
      profile?.['com.apple.developer.aps-environment'] !== 'production') {
    throw new Error('Production APNs requires matching entitlements and profile');
  }
  if (proposed['com.apple.developer.usernotifications.time-sensitive'] !== true ||
      profile['com.apple.developer.usernotifications.time-sensitive'] !== true) {
    throw new Error('Time-sensitive notifications require a matching production profile');
  }
  if (proposed['com.apple.security.get-task-allow'] === true || profile['get-task-allow'] === true) {
    throw new Error('Development debugger entitlement is forbidden in production');
  }
}

export function assertProductionNodeEntitlements(source, proposed) {
  if (source?.['com.apple.security.cs.allow-jit'] !== true ||
      proposed?.['com.apple.security.cs.allow-jit'] !== true) {
    throw new Error('Node hardened runtime must retain V8 JIT entitlement');
  }
  const permitted = Object.keys(source).filter(key => key !== 'com.apple.security.get-task-allow').sort();
  if (proposed?.['com.apple.security.get-task-allow'] === true ||
      Object.keys(proposed || {}).sort().join('\0') !== permitted.join('\0') ||
      permitted.some(key => JSON.stringify(proposed[key]) !== JSON.stringify(source[key]))) {
    throw new Error('Node production entitlements must preserve runtime exceptions without debugger access');
  }
}

/** Sign leaves before their containing code bundles; never rely on --deep signing. */
export function nestedSigningOrder(relativeMachO, relativeBundles) {
  const bundles = [...new Set(relativeBundles)].sort((a, b) => b.split('/').length - a.split('/').length || a.localeCompare(b));
  // A framework may contain auxiliary dylibs as well as its primary binary.
  // Sign every Mach-O leaf, then seal the framework bundle from inside out.
  const leaves = [...new Set(relativeMachO)]
    .sort((a, b) => b.split('/').length - a.split('/').length || a.localeCompare(b));
  return [...leaves, ...bundles];
}

export function assertAssemblyDescriptor(receipt, host, client, manifest) {
  const architecture = manifest.arch === 'x64' ? 'x86_64' : manifest.arch;
  if (receipt?.schema !== 'home23.mac-release-set.v1' || receipt.status !== 'local-engineering-candidate' ||
      receipt.signing !== 'ad-hoc' || receipt.notarized !== false || receipt.published !== false ||
      receipt.installed !== false || receipt.channelConfigured !== false ||
      receipt.appLayout !== 'Home23.app/Contents/Library/LoginItems/Home23Host.app') {
    throw new Error('Input is not an unmodified local single-app assembly receipt');
  }
  if (receipt.packageId !== manifest.packageId || receipt.backendCommit !== manifest.sourceCommit ||
      receipt.arch !== manifest.arch || receipt.platform !== manifest.platform ||
      receipt.host?.bundleIdentifier !== 'com.home23.host' ||
      receipt.client?.bundleIdentifier !== 'com.regina6.home23.mac' ||
      host.bundleIdentifier !== receipt.host.bundleIdentifier || client.bundleIdentifier !== receipt.client.bundleIdentifier ||
      host.version !== client.version || host.build !== client.build ||
      host.minimumMacOS !== client.minimumMacOS ||
      host.version !== receipt.host.version || host.build !== receipt.host.build ||
      client.version !== receipt.client.version || client.build !== receipt.client.build ||
      !host.architectures.includes(architecture) || !client.architectures.includes(architecture)) {
    throw new Error('Input assembly, embedded runtime and app identities differ');
  }
}

function decodeProfile(file) {
  const decoded = run('/usr/bin/security', ['cms', '-D', '-i', file]);
  const extract = (key, format = 'json') => {
    const result = spawnSync('/usr/bin/plutil', ['-extract', key, format, '-o', '-', '-'],
      { input: decoded, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`Provisioning profile is missing ${key}`);
    return format === 'json' ? JSON.parse(result.stdout) : result.stdout.trim();
  };
  return { teamIdentifiers: extract('TeamIdentifier'), platform: extract('Platform'),
    entitlements: extract('Entitlements'),
    expiration: extract('ExpirationDate', 'raw') };
}

function signedEntitlements(file) {
  const result = spawnSync('/usr/bin/codesign', ['-d', '--entitlements', ':-', file],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0 || !result.stdout.includes('<plist')) throw new Error('Signed entitlements are unavailable');
  const parsed = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'],
    { input: result.stdout, encoding: 'utf8' });
  if (parsed.status !== 0) throw new Error('Signed entitlements are invalid');
  return JSON.parse(parsed.stdout);
}

function availableDeveloperId(sha1) {
  if (!/^[A-Fa-f0-9]{40}$/.test(sha1 || '')) return false;
  const listing = run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']);
  return listing.split('\n').some(line => line.includes(sha1.toUpperCase()) &&
    line.includes('"Developer ID Application: ') && line.includes('(H7RZ65BN25)'));
}

function productionInputs(options, sourceEntitlements, sourceNodeEntitlements) {
  const missing = [];
  for (const [name, label] of [['identity', 'Developer ID Application identity SHA-1'],
    ['entitlements', 'production Mac entitlements plist'], ['nodeEntitlements', 'production Node hardened-runtime entitlements plist'],
    ['macProfile', 'matching Developer ID provisioning profile'],
    ['channelConfig', 'bundled private channel configuration'], ['notaryProfile', 'notarytool keychain profile name']]) {
    if (!options[name]) missing.push(label);
  }
  let identityAvailable = false, profile = null, entitlements = null, nodeEntitlements = null, channel = null;
  if (options.identity) identityAvailable = availableDeveloperId(options.identity);
  if (options.entitlements) {
    entitlements = plist(real(options.entitlements));
    // The proposed file is independently reviewable before a profile exists.
    // A supplied profile is checked against it below.
    assertProductionEntitlements(sourceEntitlements, entitlements, entitlements);
  }
  if (options.nodeEntitlements) {
    nodeEntitlements = plist(real(options.nodeEntitlements));
    assertProductionNodeEntitlements(sourceNodeEntitlements, nodeEntitlements);
  }
  if (options.macProfile) profile = decodeProfile(real(options.macProfile));
  if (options.channelConfig) channel = readProductChannel(real(options.channelConfig));
  if (entitlements && profile) {
    assertProductionEntitlements(sourceEntitlements, entitlements, profile.entitlements);
    if (!profile.platform.includes('OSX') || !profile.teamIdentifiers.includes('H7RZ65BN25') ||
        profile.entitlements['com.apple.application-identifier'] !== 'H7RZ65BN25.com.regina6.home23.mac' ||
        !Number.isFinite(Date.parse(profile.expiration)) || Date.parse(profile.expiration) <= Date.now()) {
      throw new Error('Mac provisioning profile has wrong identity or has expired');
    }
  }
  if (options.identity && !identityAvailable) missing.push('specified Developer ID Application identity is not installed');
  return { missing, identityAvailable, profile, entitlements, nodeEntitlements, channel };
}

function isMachO(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const bytes = Buffer.alloc(4);
    if (fs.readSync(fd, bytes, 0, 4, 0) !== 4) return false;
    return ['cffaedfe', 'feedfacf', 'cefaedfe', 'feedface', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']
      .includes(bytes.toString('hex'));
  } finally { fs.closeSync(fd); }
}

function discoverCode(root, { ignored = [] } = {}) {
  const machO = [], bundles = [];
  function walk(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const file = path.join(directory, entry.name);
      if (ignored.some(skip => relative === skip || relative.startsWith(skip + '/'))) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (/\.(?:framework|xpc|appex|app)$/.test(entry.name)) {
          if (/\.(?:appex|xpc|app)$/.test(entry.name)) throw new Error(`Nested executable bundle needs explicit capability policy: ${relative}`);
          bundles.push(relative);
        }
        walk(file, relative);
      } else if (entry.isFile() && entry.name !== 'manifest.json' && isMachO(file)) machO.push(relative);
      else if (!entry.isFile()) throw new Error(`Unsupported code entry: ${relative}`);
    }
  }
  walk(root);
  return { machO, bundles };
}

async function assertAssemblyLayout(app, helper, prebuilt) {
  const allowedAdditions = new Set(['Contents/Library', 'Contents/Library/LoginItems',
    'Contents/Library/LoginItems/Home23Host.app', 'Contents/_CodeSignature',
    'Contents/Resources/home23-app-lifecycle']);
  const skip = relative => relative === 'Contents/Library/LoginItems/Home23Host.app' ||
    relative.startsWith('Contents/Library/LoginItems/Home23Host.app/') ||
    relative === 'Contents/_CodeSignature' || relative.startsWith('Contents/_CodeSignature/');
  async function walk(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (skip(relative)) continue;
      const built = path.join(app, relative), original = path.join(prebuilt, relative);
      if (!fs.existsSync(original)) {
        if (!allowedAdditions.has(relative)) throw new Error(`Unexpected assembly client file: ${relative}`);
      } else {
        const left = fs.lstatSync(built), right = fs.lstatSync(original);
        if (left.isDirectory() !== right.isDirectory() || left.isSymbolicLink() !== right.isSymbolicLink() ||
            (left.mode & 0o777) !== (right.mode & 0o777)) throw new Error(`Assembly changed prebuilt client layout: ${relative}`);
        if (left.isSymbolicLink() && fs.readlinkSync(built) !== fs.readlinkSync(original)) {
          throw new Error(`Assembly changed prebuilt client link: ${relative}`);
        }
        if (left.isFile() && relative !== 'Contents/MacOS/Home23Mac' &&
            await sha256(built) !== await sha256(original)) throw new Error(`Assembly changed prebuilt client resource: ${relative}`);
      }
      if (entry.isDirectory()) await walk(built, relative);
    }
  }
  await walk(app);
  const expectedHelper = new Set(['Contents', 'Contents/MacOS', 'Contents/MacOS/Home23Host',
    'Contents/Info.plist', 'Contents/Resources', 'Contents/Resources/Home23Host.icns',
    'Contents/Resources/Home23Runtime', 'Contents/_CodeSignature']);
  function walkHelper(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (relative === 'Contents/Resources/Home23Runtime' || relative === 'Contents/_CodeSignature') continue;
      if (!expectedHelper.has(relative)) throw new Error(`Unexpected embedded Host file: ${relative}`);
      if (entry.isDirectory()) walkHelper(path.join(directory, entry.name), relative);
    }
  }
  walkHelper(helper);
}

const sign = (file, identity, extra = []) => run('/usr/bin/codesign',
  ['--force', '--sign', identity, '--options', 'runtime', '--timestamp', ...extra, file], { stdio: 'inherit' });
const verifySignature = file => run('/usr/bin/codesign', ['--verify', '--strict', file], { stdio: 'inherit' });
const signedTeam = file => {
  const result = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', file], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Signed code identity could not be read');
  const output = result.stderr;
  return /^TeamIdentifier=(.+)$/m.exec(output)?.[1];
};
function signCodeTree(root, identity, exclusions = [], entitlementsByRelative = {}) {
  const { machO, bundles } = discoverCode(root, { ignored: exclusions });
  for (const relative of nestedSigningOrder(machO, bundles)) {
    const file = path.join(root, relative);
    sign(file, identity, entitlementsByRelative[relative] ? ['--entitlements', entitlementsByRelative[relative]] : []);
    verifySignature(file);
    if (signedTeam(file) !== 'H7RZ65BN25') throw new Error(`Signed nested code has wrong Team ID: ${relative}`);
  }
  return { machO: machO.length, bundles: bundles.length };
}

function smokeSignedRuntime(runtime) {
  const app = path.join(runtime, 'app');
  const source = String.raw`
    const { createRequire } = require('node:module');
    const root = createRequire(process.cwd() + '/package.json');
    const embedder = createRequire(process.cwd() + '/scripts/embedder/package.json');
    const db = new (root('better-sqlite3'))(':memory:');
    if (db.prepare('SELECT 1 AS n').get().n !== 1) throw Error('SQLite result mismatch');
    db.close();
    root('hnswlib-node');
    embedder('onnxruntime-node');
    let sum = 0; const add = n => n + 1;
    for (let i = 0; i < 100000; i++) sum = add(sum);
    if (sum !== 100000) throw Error('V8 execution mismatch');
    embedder('sharp')({ create: { width: 1, height: 1, channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toBuffer()
      .then(bytes => { if (!bytes.length) throw Error('sharp output empty'); })
      .catch(error => { console.error(error); process.exitCode = 1; });
  `;
  run(path.join(runtime, 'bin/node'), ['--input-type=commonjs', '-e', source],
    { cwd: app, stdio: 'inherit', timeout: 30_000 });
}

async function inspectAssembly(options) {
  const assembly = real(options.assembly), payload = real(options.payload);
  const backendSource = real(options.backendSource), appleSource = real(options.appleSource);
  const prebuiltClient = real(options.prebuiltClient), prebuiltReceipt = real(options.prebuiltClientReceipt);
  const receipt = json(path.join(assembly, 'assembly-receipt.json'));
  if (cleanCommit(backendSource) !== receipt.backendCommit || cleanCommit(appleSource) !== receipt.appleCommit) {
    throw new Error('Input assembly does not match clean maintained source commits');
  }
  if (typeof receipt.archive !== 'string' || path.basename(receipt.archive) !== receipt.archive ||
      !/^[a-f0-9]{64}$/.test(receipt.archiveSHA256 || '')) throw new Error('Input assembly archive receipt is invalid');
  const archive = path.join(assembly, receipt.archive);
  if (await sha256(archive) !== receipt.archiveSHA256 || fs.statSync(archive).size !== receipt.bytes) {
    throw new Error('Input assembly archive bytes differ from receipt');
  }
  const app = path.join(assembly, 'Home23/Home23.app');
  const helper = path.join(app, 'Contents/Library/LoginItems/Home23Host.app');
  const runtime = path.join(helper, 'Contents/Resources/Home23Runtime');
  const manifest = verifyProductPayload(runtime);
  if (verifyProductPayload(payload).packageId !== manifest.packageId) throw new Error('Input payload and embedded runtime differ');
  const host = appInfo(helper), client = appInfo(app);
  assertAssemblyDescriptor(receipt, host, client, manifest);
  if (await sha256(host.executable) !== receipt.host.executableSHA256 ||
      await sha256(client.executable) !== receipt.client.executableSHA256) {
    throw new Error('Input app executables differ from assembly receipt');
  }
  const hostBuild = json(path.join(assembly, 'build/host/build-receipt.json'));
  if (hostBuild.status !== 'built' || hostBuild.sourceCommit !== receipt.appleCommit ||
      hostBuild.runtime?.packageId !== manifest.packageId ||
      !Array.isArray(hostBuild.sources) || hostBuild.sources.length === 0 ||
      hostBuild.sources.some(source => !within(appleSource, source.path) ||
        createHash('sha256').update(fs.readFileSync(source.path)).digest('hex') !== source.sha256)) {
    throw new Error('Host build source receipt differs from maintained Apple source');
  }
  const prebuilt = await verifyPrebuiltMacClient({ receiptPath: prebuiltReceipt, app: prebuiltClient,
    appleSource, appleCommit: receipt.appleCommit, arch: manifest.arch });
  if (receipt.prebuiltClientSourceSHA256 !== prebuilt.source.sha256 ||
      receipt.prebuiltClientArtifactSHA256 !== prebuilt.appTree.sha256) {
    throw new Error('Mac client prebuilt receipt differs from assembly');
  }
  await assertAssemblyLayout(app, helper, prebuiltClient);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  if (signedEntitlements(app)['com.apple.security.app-sandbox'] !== true) {
    throw new Error('Input assembly lost Mac sandbox');
  }
  const originalEntitlements = plist(path.join(appleSource, 'Home23Desktop/Home23Mac.entitlements'));
  const originalNodeEntitlements = signedEntitlements(path.join(payload, 'bin/node'));
  return { assembly, payload, backendSource, appleSource, prebuiltClient, prebuiltReceipt,
    receipt, archive, app, helper, runtime, manifest, host, client, originalEntitlements,
    originalNodeEntitlements, appTree: await appTreeDigest(app) };
}

export async function planMacFinalization(options) {
  if (!options.output || !path.isAbsolute(options.output) || fs.existsSync(options.output)) {
    throw new Error('Final output must be a new absolute directory');
  }
  const output = path.join(real(path.dirname(options.output)), path.basename(options.output));
  for (const input of [options.assembly, options.payload, options.backendSource, options.appleSource,
    options.prebuiltClient, options.prebuiltClientReceipt]) {
    const root = real(input);
    if (within(root, output) || within(output, root)) throw new Error('Final output must be separate from every input');
  }
  const input = await inspectAssembly(options);
  const production = productionInputs(options, input.originalEntitlements, input.originalNodeEntitlements);
  const runtimeCode = discoverCode(input.runtime);
  const hostCode = discoverCode(input.helper, { ignored: ['Contents/Resources/Home23Runtime'] });
  const appCode = discoverCode(input.app, { ignored: ['Contents/Library/LoginItems/Home23Host.app'] });
  return { schema: 'home23.mac-finalization-plan.v1', status: production.missing.length ? 'missing-inputs' : 'ready-for-authorized-execution',
    input: { assemblyArchiveSHA256: input.receipt.archiveSHA256, appTreeSHA256: input.appTree.sha256,
      backendCommit: input.receipt.backendCommit, appleCommit: input.receipt.appleCommit,
      packageIdBeforeSigning: input.manifest.packageId, version: input.client.version, build: input.client.build,
      identities: [input.client.bundleIdentifier, input.host.bundleIdentifier] },
    output, missing: production.missing,
    code: { runtimeMachO: runtimeCode.machO.length, runtimeBundles: runtimeCode.bundles.length,
      hostMachO: hostCode.machO.length, hostBundles: hostCode.bundles.length,
      appMachO: appCode.machO.length, appBundles: appCode.bundles.length },
    sequence: ['copy and bind input archive/app tree', 'embed channel and production profile',
      'sign all runtime native code', 'regenerate and verify runtime manifest/package ID',
      'sign nested framework/native code and lifecycle tool', 'sign Host, then Mac with full production entitlements',
      'verify Team IDs, sandbox, APNs capabilities and signatures', 'notarize and staple the app',
      'reverify unchanged runtime; archive and hash final runtime/app bytes; write publication-ready receipt'] };
}

async function executeMacFinalization(options, plan) {
  if (plan.status !== 'ready-for-authorized-execution') throw new Error('Production inputs are incomplete');
  const input = await inspectAssembly(options);
  if (input.appTree.sha256 !== plan.input.appTreeSHA256 ||
      input.receipt.archiveSHA256 !== plan.input.assemblyArchiveSHA256) throw new Error('Input assembly changed after plan');
  const production = productionInputs(options, input.originalEntitlements, input.originalNodeEntitlements);
  const output = plan.output, release = path.join(output, 'Home23');
  fs.mkdirSync(output, { recursive: false, mode: 0o700 });
  fs.mkdirSync(release);
  run('/usr/bin/ditto', ['-x', '-k', input.archive, output]);
  const app = path.join(release, 'Home23.app');
  if ((await appTreeDigest(app)).sha256 !== input.appTree.sha256) throw new Error('Extracted app differs from verified assembly');
  const helper = path.join(app, 'Contents/Library/LoginItems/Home23Host.app');
  const runtime = path.join(helper, 'Contents/Resources/Home23Runtime');
  fs.copyFileSync(real(options.channelConfig), path.join(app, 'Contents/Resources/release-channel.json'));
  fs.copyFileSync(real(options.macProfile), path.join(app, 'Contents/embedded.provisionprofile'));
  if (await sha256(path.join(app, 'Contents/embedded.provisionprofile')) !== await sha256(options.macProfile)) {
    throw new Error('Embedded production profile changed');
  }
  const runtimeCode = signCodeTree(runtime, options.identity, [], { 'bin/node': real(options.nodeEntitlements) });
  assertProductionNodeEntitlements(input.originalNodeEntitlements, signedEntitlements(path.join(runtime, 'bin/node')));
  const oldManifest = readProductManifest(runtime);
  fs.unlinkSync(path.join(runtime, 'manifest.json'));
  const signedManifest = writeProductManifest(runtime, oldManifest);
  if (verifyProductPayload(runtime).packageId !== signedManifest.packageId) throw new Error('Signed runtime inventory is invalid');
  smokeSignedRuntime(runtime);
  const outsideHost = 'Contents/Library/LoginItems/Home23Host.app';
  const hostCode = signCodeTree(helper, options.identity,
    ['Contents/Resources/Home23Runtime', path.relative(input.helper, input.host.executable)]);
  const clientCode = signCodeTree(app, options.identity, [outsideHost, path.relative(input.app, input.client.executable)]);
  sign(helper, options.identity); verifySignature(helper);
  sign(app, options.identity, ['--entitlements', real(options.entitlements)]); verifySignature(app);
  for (const item of [helper, app]) {
    if (signedTeam(item) !== 'H7RZ65BN25') throw new Error('Developer ID team identity changed');
  }
  assertProductionEntitlements(input.originalEntitlements, signedEntitlements(app), production.profile.entitlements);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  const notaryZip = path.join(output, 'notary-submission.zip');
  run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, notaryZip]);
  const submission = JSON.parse(run('/usr/bin/xcrun', ['notarytool', 'submit', notaryZip,
    '--keychain-profile', options.notaryProfile, '--wait', '--output-format', 'json'],
  { env: { ...process.env, DEVELOPER_DIR: real(options.developerDir) } }));
  if (submission.status !== 'Accepted' || !submission.id) throw new Error('Apple notarization was not accepted');
  run('/usr/bin/xcrun', ['stapler', 'staple', app], { env: { ...process.env, DEVELOPER_DIR: real(options.developerDir) } });
  run('/usr/bin/xcrun', ['stapler', 'validate', app], { env: { ...process.env, DEVELOPER_DIR: real(options.developerDir) } });
  run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
  if (verifyProductPayload(runtime).packageId !== signedManifest.packageId) throw new Error('Notarization changed the embedded runtime');
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  const runtimeArchive = path.join(output, `Home23Runtime-${signedManifest.packageId}.tar`);
  run(process.execPath, [path.join(import.meta.dirname, 'archive-runtime.mjs'), '--payload', runtime, '--output', runtimeArchive]);
  const { archive: _unsignedArchive, archiveSHA256: _unsignedArchiveSHA256,
    bytes: _unsignedBytes, elapsedSeconds: _unsignedElapsedSeconds, ...inputMetadata } = input.receipt;
  const descriptor = { ...inputMetadata,
    host: { ...input.receipt.host, executableSHA256: await sha256(path.join(helper, 'Contents/MacOS/Home23Host')) },
    client: { ...input.receipt.client, executableSHA256: await sha256(path.join(app, 'Contents/MacOS/Home23Mac')) },
    status: 'ready-for-private-publication', signing: 'developer-id',
    notarized: true, published: false, installed: false, channelConfigured: true,
    clientProfileCapabilities: 'production APNs and time-sensitive notifications verified against embedded profile',
    acceptance: 'Developer ID signature, notarization, stapling and local Gatekeeper assessment; owner install still pending',
    packageId: signedManifest.packageId, unsignedPackageId: oldManifest.packageId,
    runtimeCode, hostCode, clientCode, developerIdTeam: 'H7RZ65BN25', notarizationId: submission.id,
    channelManifestURL: production.channel.manifestURL,
    productionProfileSHA256: await sha256(options.macProfile),
    productionEntitlementsSHA256: await sha256(options.entitlements),
    productionNodeEntitlementsSHA256: await sha256(options.nodeEntitlements),
    runtimeArchive: path.basename(runtimeArchive), runtimeArchiveSHA256: await sha256(runtimeArchive),
    runtimeArchiveBytes: fs.statSync(runtimeArchive).size };
  fs.writeFileSync(path.join(release, 'release.json'), JSON.stringify(descriptor, null, 2) + '\n');
  fs.writeFileSync(path.join(release, 'Start Here.txt'),
    `Home23 ${input.client.version} (${input.client.build}) — private family release\n\nInstall Home23.app as one application. Its home manager and runtime are embedded.\n`);
  const appArchive = path.join(output, `Home23-${signedManifest.packageId.slice(0, 12)}-mac.zip`);
  run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', release, appArchive]);
  const receipt = { ...descriptor, archive: path.basename(appArchive), archiveSHA256: await sha256(appArchive),
    bytes: fs.statSync(appArchive).size, appTreeSHA256: (await appTreeDigest(app)).sha256 };
  fs.writeFileSync(path.join(output, 'production-release-receipt.json'), JSON.stringify(receipt, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 });
  return receipt;
}

function parseCLI(argv) {
  const names = { '--assembly': 'assembly', '--payload': 'payload', '--backend-source': 'backendSource',
    '--apple-source': 'appleSource', '--prebuilt-client': 'prebuiltClient',
    '--prebuilt-client-receipt': 'prebuiltClientReceipt', '--output': 'output',
    '--developer-dir': 'developerDir', '--identity': 'identity', '--entitlements': 'entitlements',
    '--node-entitlements': 'nodeEntitlements',
    '--mac-profile': 'macProfile', '--channel-config': 'channelConfig', '--notary-profile': 'notaryProfile' };
  const options = {}; let mode = null;
  for (let i = 0; i < argv.length; i++) {
    if (['--plan', '--execute'].includes(argv[i])) {
      if (mode) throw new Error('Choose one mode');
      mode = argv[i]; continue;
    }
    const key = names[argv[i]], value = argv[++i];
    if (!key || !value || value.startsWith('--') || options[key]) throw new Error('Invalid or duplicate argument');
    options[key] = value;
  }
  if (!mode) throw new Error('Specify --plan or --execute');
  for (const key of ['assembly', 'payload', 'backendSource', 'appleSource', 'prebuiltClient',
    'prebuiltClientReceipt', 'output', 'developerDir']) if (!options[key]) throw new Error(`Missing ${key}`);
  return { options, mode };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { options, mode } = parseCLI(process.argv.slice(2));
    const plan = await planMacFinalization(options);
    if (mode === '--plan') console.log(JSON.stringify(plan, null, 2));
    else console.log(JSON.stringify(await executeMacFinalization(options, plan), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
