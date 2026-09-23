#!/usr/bin/env node
/** Bind an unsigned Mac client build to exact source inputs for later assembly. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const run = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...options });
const relevant = file => /^(Home23\/|Home23Shared\/|Home23Desktop\/|Home23\.xcodeproj\/|Configs\/)/.test(file);
const hashFile = async file => {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};
const add = (hash, fields) => { for (const field of fields) hash.update(String(field)).update('\0'); };

export function sourceFootprint(appleSource) {
  if (run('git', ['status', '--porcelain'], { cwd: appleSource }).trim()) throw new Error('Apple source must be clean');
  const commit = run('git', ['rev-parse', 'HEAD'], { cwd: appleSource }).trim();
  // Git's object IDs bind exact committed file bytes and modes. Restrict the
  // footprint to source/project inputs so a later documentation merge can
  // reuse the compiled client without misrepresenting its build provenance.
  const entries = run('git', ['ls-tree', '-r', '-z', 'HEAD', 'Home23', 'Home23Shared', 'Home23Desktop', 'Home23.xcodeproj', 'Configs'],
    { cwd: appleSource, encoding: 'buffer' }).toString('utf8').split('\0').filter(Boolean);
  const hash = createHash('sha256');
  let fileCount = 0;
  for (const entry of entries) {
    const match = /^(\d{6}) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
    if (!match || !relevant(match[3])) throw new Error('Unsupported Apple source tree entry');
    add(hash, [match[3], match[1], match[2]]);
    fileCount++;
  }
  if (!fileCount) throw new Error('Apple executable source footprint is empty');
  return { commit, sha256: hash.digest('hex'), fileCount,
    roots: ['Home23', 'Home23Shared', 'Home23Desktop', 'Home23.xcodeproj', 'Configs'] };
}

export async function appTreeDigest(app) {
  const root = fs.realpathSync(app);
  const hash = createHash('sha256');
  let fileCount = 0;
  async function walk(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      const location = path.join(dir, entry.name);
      const mode = fs.lstatSync(location).mode & 0o777;
      if (entry.isDirectory()) { add(hash, ['d', name, mode]); await walk(location, name); }
      else if (entry.isSymbolicLink()) { add(hash, ['l', name, mode, fs.readlinkSync(location)]); fileCount++; }
      else if (entry.isFile()) { add(hash, ['f', name, mode, await hashFile(location)]); fileCount++; }
      else throw new Error(`Unsupported app tree entry: ${name}`);
    }
  }
  await walk(root);
  return { sha256: hash.digest('hex'), fileCount };
}

export function macClientInfo(app) {
  const info = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Contents/Info.plist')]));
  if (!info.CFBundleExecutable || path.basename(info.CFBundleExecutable) !== info.CFBundleExecutable) throw new Error('Invalid Mac client executable');
  const executable = path.join(app, 'Contents/MacOS', info.CFBundleExecutable);
  return { bundleIdentifier: info.CFBundleIdentifier, version: info.CFBundleShortVersionString,
    build: info.CFBundleVersion, minimumMacOS: info.LSMinimumSystemVersion,
    architectures: run('/usr/bin/lipo', ['-archs', executable]).trim().split(/\s+/) };
}

export async function makePrebuiltMacClientReceipt({ appleSource, appleCommit, app, output, developerDir }) {
  appleSource = fs.realpathSync(appleSource); app = fs.realpathSync(app);
  const source = sourceFootprint(appleSource);
  if (source.commit !== appleCommit || !/^[a-f0-9]{40}$/.test(appleCommit)) throw new Error('Explicit Apple commit does not match clean checkout');
  const client = macClientInfo(app);
  if (client.bundleIdentifier !== 'com.regina6.home23.mac' || client.version !== '2.0' || client.build !== '180' ||
      !client.architectures.includes('arm64')) throw new Error('Prebuilt Mac client identity/version/architecture mismatch');
  const entitlement = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(appleSource, 'Home23Desktop/Home23Mac.entitlements')]));
  if (entitlement['com.apple.security.app-sandbox'] !== true) throw new Error('Mac client source does not require sandbox');
  if (spawnSync('/usr/bin/codesign', ['--verify', app], { encoding: 'utf8' }).status === 0) throw new Error('Expected unsigned Mac client');
  const before = sourceFootprint(appleSource);
  if (before.sha256 !== source.sha256 || before.commit !== source.commit) throw new Error('Apple source changed while recording build');
  const receipt = { schema: 'home23.prebuilt-mac-client.v1', signing: 'unsigned', source,
    client, appTree: await appTreeDigest(app), app,
    developerDir: fs.realpathSync(developerDir), configuration: 'Release',
    destination: 'generic/platform=macOS', toolchain: run('/usr/bin/xcodebuild', ['-version'],
      { env: { ...process.env, DEVELOPER_DIR: developerDir } }).trim(),
    sandboxEntitlementsSHA256: await hashFile(path.join(appleSource, 'Home23Desktop/Home23Mac.entitlements')) };
  if (sourceFootprint(appleSource).sha256 !== source.sha256) throw new Error('Apple source changed while recording build');
  fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  return receipt;
}

export async function verifyPrebuiltMacClient({ receiptPath, app, appleSource, appleCommit, arch }) {
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  if (receipt.schema !== 'home23.prebuilt-mac-client.v1' || receipt.signing !== 'unsigned' ||
      receipt.configuration !== 'Release' || receipt.destination !== 'generic/platform=macOS') throw new Error('Invalid prebuilt Mac client receipt');
  const source = sourceFootprint(appleSource);
  if (source.commit !== appleCommit || receipt.source?.sha256 !== source.sha256 ||
      receipt.source?.fileCount !== source.fileCount || !/^[a-f0-9]{40}$/.test(receipt.source?.commit || '')) {
    throw new Error('Prebuilt Mac client source has drifted');
  }
  if (receipt.source.commit !== appleCommit && spawnSync('git', ['merge-base', '--is-ancestor', receipt.source.commit, appleCommit],
      { cwd: appleSource, encoding: 'utf8' }).status !== 0) throw new Error('Prebuilt source commit is not an ancestor');
  if (fs.realpathSync(app) !== fs.realpathSync(receipt.app)) throw new Error('Prebuilt app path differs from receipt');
  const actual = macClientInfo(app);
  if (JSON.stringify(actual) !== JSON.stringify(receipt.client) || actual.bundleIdentifier !== 'com.regina6.home23.mac' ||
      !actual.architectures.includes(arch)) throw new Error('Prebuilt Mac client identity differs');
  const digest = await appTreeDigest(app);
  if (digest.sha256 !== receipt.appTree?.sha256 || digest.fileCount !== receipt.appTree?.fileCount) throw new Error('Prebuilt Mac client artifact changed');
  if (await hashFile(path.join(appleSource, 'Home23Desktop/Home23Mac.entitlements')) !== receipt.sandboxEntitlementsSHA256) {
    throw new Error('Mac sandbox entitlements changed since client build');
  }
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const names = { '--apple-source': 'appleSource', '--apple-commit': 'appleCommit', '--app': 'app',
      '--output': 'output', '--developer-dir': 'developerDir' }, args = {};
    for (let i = 2; i < process.argv.length; i += 2) {
      const key = names[process.argv[i]], value = process.argv[i + 1];
      if (!key || !value || value.startsWith('--') || args[key]) throw new Error('Invalid prebuilt client argument');
      args[key] = value;
    }
    for (const key of Object.values(names)) if (!args[key]) throw new Error(`Missing ${key}`);
    console.log(JSON.stringify(await makePrebuiltMacClientReceipt(args), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
