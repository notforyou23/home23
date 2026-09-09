#!/usr/bin/env node
/** Build a machine-specific, dependency-complete Home23 Host payload from Git. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { inventoryProductPayload, verifyProductPayload, writeProductManifest } from '../../cli/lib/product-payload.js';

const run = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options });
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
export function inspectProductNode(nodePath) {
  nodePath = fs.realpathSync(nodePath);
  const metadata = JSON.parse(run(nodePath, ['-p', 'JSON.stringify({platform:process.platform,arch:process.arch,nodeVersion:process.version})']));
  if (!/^v22\./.test(metadata.nodeVersion) || metadata.platform !== process.platform || metadata.arch !== process.arch) {
    throw new Error('Use a Node 22 binary matching the build machine platform and architecture');
  }
  // Homebrew Node links to the builder's private installation. Copying just
  // that executable looks portable but fails on the recipient's machine.
  if (process.platform === 'darwin') {
    const libraries = run('/usr/bin/otool', ['-L', nodePath]).split('\n').slice(1).map(line => line.trim().split(' (')[0]).filter(Boolean);
    if (libraries.some(library => !library.startsWith('/usr/lib/') && !library.startsWith('/System/Library/'))) {
      throw new Error('Node depends on non-system libraries; use the self-contained official Node distribution');
    }
  } else {
    throw new Error('The initial Host package builder supports macOS; Linux packaging needs its own dependency portability verification');
  }
  return metadata;
}
function normalizeModes(root) {
  for (const name of fs.readdirSync(root)) {
    const file = path.join(root, name), stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) { fs.chmodSync(file, 0o755); normalizeModes(file); }
    else if (stat.isFile()) fs.chmodSync(file, (stat.mode & 0o111) ? 0o755 : 0o644);
    else throw new Error(`Unexpected special file in package: ${file}`);
  }
}
export function buildProductPayload({ sourceRoot, commit = 'HEAD', outputPath, nodePath, npmPath, cachePath }) {
  sourceRoot = fs.realpathSync(sourceRoot); outputPath = path.resolve(outputPath);
  nodePath = fs.realpathSync(nodePath); npmPath = fs.realpathSync(npmPath); cachePath = path.resolve(cachePath);
  if (inside(sourceRoot, outputPath) || inside(outputPath, sourceRoot)) throw new Error('Build output must be separate from source');
  if (fs.existsSync(outputPath)) throw new Error('Product output already exists; choose a new output directory');
  if (run('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: sourceRoot }).trim()) throw new Error('Commit tracked source changes before building a product payload');
  const sourceCommit = run('git', ['rev-parse', '--verify', `${commit}^{commit}`], { cwd: sourceRoot }).trim();
  const metadata = inspectProductNode(nodePath);
  const nodeDistribution = path.dirname(path.dirname(nodePath));
  const nodeLicense = path.join(nodeDistribution, 'LICENSE');
  if (!fs.existsSync(nodeLicense)) throw new Error('The Node distribution LICENSE must accompany its binary');
  const tracked = run('git', ['ls-tree', '-r', '--name-only', sourceCommit], { cwd: sourceRoot }).trim().split('\n');
  const forbidden = tracked.filter(file => /^(instances\/|config\/(home|targets|secrets)\.yaml$|config\/(agents|cron-jobs)\.json$|ecosystem\.config\.cjs$|\.env$|engine\/\.env$|evobrew\/\.env$)/.test(file));
  if (forbidden.length) throw new Error(`Source commit contains local installation state: ${forbidden.join(', ')}`);
  for (const file of ['package-lock.json', 'engine/package-lock.json', 'evobrew/package-lock.json', 'scripts/product/runtime-tools/package-lock.json']) {
    if (!tracked.includes(file)) throw new Error(`Pinned product dependency lock is missing: ${file}`);
  }
  fs.mkdirSync(outputPath, { mode: 0o755 });
  const app = path.join(outputPath, 'app'); fs.mkdirSync(app, { mode: 0o755 });
  const archive = path.join(outputPath, '.source.tar');
  // Export only committed files. No source checkout node_modules, local
  // credentials, symlinked dependencies or lived resident state are copied.
  run('git', ['archive', '--format=tar', '--output', archive, sourceCommit], { cwd: sourceRoot });
  run('/usr/bin/tar', ['-xf', archive, '-C', app]); fs.unlinkSync(archive);
  normalizeModes(app); inventoryProductPayload(app);
  const bin = path.join(outputPath, 'bin'); fs.mkdirSync(bin, { mode: 0o755 });
  fs.copyFileSync(nodePath, path.join(bin, 'node')); fs.chmodSync(path.join(bin, 'node'), 0o755);
  const notices = path.join(outputPath, 'notices'); fs.mkdirSync(notices, { mode: 0o755 });
  fs.copyFileSync(nodeLicense, path.join(notices, 'NODE-LICENSE'));
  fs.writeFileSync(path.join(notices, 'README.txt'), 'Home23 Host runtime\n\nNode license and bundled dependency notices: NODE-LICENSE.\nJavaScript dependencies retain their upstream package metadata and license files in each node_modules package.\nThe product manifest is an integrity inventory, not a publisher signature.\n');
  const tools = path.join(outputPath, 'tools'); fs.mkdirSync(tools, { mode: 0o755 });
  for (const name of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(app, 'scripts', 'product', 'runtime-tools', name), path.join(tools, name));
  fs.mkdirSync(cachePath, { recursive: true });
  // node-gyp's generated make include flags do not safely quote a Node header
  // root containing spaces (external macOS volumes commonly have them). Only
  // this tiny temporary alias lives on the system disk; headers, dependencies,
  // npm cache and the complete payload remain at their selected locations.
  const headerAliasRoot = fs.mkdtempSync('/private/tmp/home23-node-headers-');
  const headerAlias = path.join(headerAliasRoot, 'node');
  fs.symlinkSync(nodeDistribution, headerAlias, 'dir');
  const env = { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: process.env.HOME, USER: process.env.USER,
    TMPDIR: path.join(cachePath, 'tmp'), npm_config_cache: cachePath, npm_config_devdir: path.join(cachePath, 'node-gyp'),
    npm_config_nodedir: headerAlias, npm_config_userconfig: '/dev/null', npm_config_audit: 'false', npm_config_fund: 'false' };
  fs.mkdirSync(env.TMPDIR, { recursive: true });
  try {
  for (const directory of [app, path.join(app, 'engine'), path.join(app, 'evobrew'), tools]) {
    process.stderr.write(`Installing locked dependencies: ${path.relative(outputPath, directory)}\n`);
    run(path.join(bin, 'node'), [npmPath, 'ci', '--no-audit', '--no-fund'], { cwd: directory, env, stdio: 'inherit', timeout: 20 * 60 * 1000 });
  }
  run(path.join(bin, 'node'), [path.join(app, 'scripts', 'release', 'build.mjs')], { cwd: app, env, stdio: 'inherit', timeout: 180000 });
  // Load the important native modules with exactly the binary distributed to
  // recipients. Compilation success alone does not prove the ABI matches.
  run(path.join(bin, 'node'), ['--input-type=commonjs', '-e', `
    const {createRequire}=require('node:module');
    const root=createRequire(process.cwd()+'/package.json');
    const db=new (root('better-sqlite3'))(':memory:'); db.prepare('SELECT 1').get(); db.close();
    root('hnswlib-node');
    createRequire(process.cwd()+'/engine/package.json')('hnswlib-node');
    createRequire(process.cwd()+'/evobrew/package.json')('node-pty');
    createRequire(process.cwd()+'/package.json')('tsx');
  `], { cwd: app, env, stdio: 'inherit', timeout: 30000 });
  normalizeModes(outputPath);
  const manifest = writeProductManifest(outputPath, { ...metadata, sourceCommit });
  verifyProductPayload(outputPath);
  return { status: 'packaged', packageId: manifest.packageId, sourceCommit, outputPath, ...metadata, fileCount: manifest.files.length };
  } finally { fs.rmSync(headerAliasRoot, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const values = {}; const names = { '--source': 'sourceRoot', '--commit': 'commit', '--output': 'outputPath', '--node': 'nodePath', '--npm': 'npmPath', '--cache': 'cachePath' };
    for (let index = 2; index < process.argv.length; index += 2) {
      const key = names[process.argv[index]], value = process.argv[index + 1];
      if (!key || !value || value.startsWith('--')) throw new Error('Usage: package.mjs --source ROOT --commit COMMIT --output NEW_DIRECTORY --node NODE --npm NPM_CLI --cache CACHE_DIRECTORY');
      values[key] = value;
    }
    for (const key of ['sourceRoot', 'outputPath', 'nodePath', 'npmPath', 'cachePath']) if (!values[key]) throw new Error(`Missing package argument: ${key}`);
    console.log(JSON.stringify(buildProductPayload(values), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
