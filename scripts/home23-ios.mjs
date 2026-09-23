#!/usr/bin/env node
// Local iPhone release entry point. Installation-specific authority stays untracked.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...options });
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const readJSON = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const plist = p => JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', p]));
const insist = (condition, message) => { if (!condition) throw new Error(message); };

export function parseInvocation(argv, defaultInstallation = root) {
  const positional = [];
  let installation = defaultInstallation;
  let installationSelected = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--installation') {
      insist(!installationSelected, 'Provide --installation only once.');
      const selected = argv[++index];
      insist(selected && !selected.startsWith('-'), 'Provide a path after --installation.');
      installation = path.resolve(selected);
      installationSelected = true;
    } else {
      insist(!value.startsWith('--'), `Unknown option: ${value}`);
      positional.push(value);
    }
  }
  insist(positional.length <= 3, 'Too many command arguments.');
  const [command, arg, output] = positional;
  return { installation, command, arg, output };
}

export function buildArguments({ source, output, buildNumber, port }) {
  // Scheme-wide identity overrides also rename every embedded extension.
  // Target identities come from the selected source and are checked afterward.
  return [
    '-project', path.join(source, 'Home23.xcodeproj'), '-scheme', 'Home23',
    '-configuration', 'Debug', '-derivedDataPath', path.join(output, 'DerivedData'),
    '-destination', 'generic/platform=iOS', '-disableAutomaticPackageResolution',
    'CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO', 'CODE_SIGN_ENTITLEMENTS=',
    'ENABLE_DEBUG_DYLIB=NO', `CURRENT_PROJECT_VERSION=${buildNumber}`,
    `HOME23_CONNECTED_AGENTS_PORT=${port}`, 'build',
  ];
}

export function verifySigningLifetime(profileExpiresAt, certificateExpiresAt, now = Date.now(), minimumDays = 60) {
  const expiresAt = Math.min(Date.parse(profileExpiresAt), Date.parse(certificateExpiresAt));
  insist(Number.isFinite(expiresAt), 'Signing expiration is invalid.');
  const remainingDays = Math.floor((expiresAt - now) / 86400000);
  insist(remainingDays >= minimumDays, `Home23 signing has only ${remainingDays} days left; renew the certificate and profile before shipping (minimum ${minimumDays} days).`);
  return { expiresAt: new Date(expiresAt).toISOString(), remainingDays, minimumDays };
}

function signingReadiness(config, minimumDays = 60) {
  insist(/^[A-Fa-f0-9]{40}$/.test(config.signingCertificateSHA1 ?? ''), 'Pin the exact Home23 signing certificate fingerprint.');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-signing-'));
  try {
    const decoded = path.join(temporary, 'profile.plist');
    run('/usr/bin/security', ['cms', '-D', '-i', config.profile, '-o', decoded]);
    const raw = key => run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', decoded]).trim();
    // Profiles may include both an expiring and a renewed certificate. Validate
    // the exact configured signer, not whichever certificate Apple lists first.
    let certificate;
    for (let index = 0; ; index += 1) {
      let encoded;
      try { encoded = raw(`DeveloperCertificates.${index}`); } catch { break; }
      const candidate = new crypto.X509Certificate(Buffer.from(encoded, 'base64'));
      if (candidate.fingerprint.replaceAll(':', '').toUpperCase() === config.signingCertificateSHA1.toUpperCase()) {
        certificate = candidate;
        break;
      }
    }
    insist(certificate, 'Profile does not contain the pinned signing certificate.');
    return verifySigningLifetime(raw('ExpirationDate'), certificate.validTo, Date.now(), minimumDays);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

export function verifySource(config) {
  const source = fs.realpathSync(config.sourceRoot);
  const contract = fs.readFileSync(path.join(source, 'Home23Shared/Sources/Home23Shared/ProductContracts/ConnectedAgentsContract.swift'), 'utf8');
  insist(contract.includes(`packSHA256 = "${config.contractSHA256}"`), 'Selected source has the wrong persistence contract; do not build it.');
  for (const rel of ['Home23/Sources/Product/Next/Home23NextPhoneShell.swift', 'Home23/Sources/Product/Work/ProductWorkThreadViewModel.swift']) {
    insist(fs.existsSync(path.join(source, rel)), `Selected source is missing current product code: ${rel}`);
  }
  return source;
}

export function verifyMetadata(info, config) {
  insist(info.CFBundleIdentifier === config.bundleIdentifier, 'Wrong installed app identity.');
  insist(info.CFBundleDisplayName === config.displayName && info.CFBundleName === config.displayName, 'App must be named Home23.');
  insist(/^\d+$/.test(String(info.CFBundleVersion)) && Number(info.CFBundleVersion) >= config.minimumBuild, 'App build is older than the supported build floor.');
  insist(String(info.Home23ConnectedAgentsPort) === config.port, 'Wrong Connected Agents endpoint.');
}

function inventory(directory) {
  const result = {};
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name), relative = path.relative(directory, absolute);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isSymbolicLink()) result[relative] = { link: fs.readlinkSync(absolute) };
      else if (entry.isFile()) result[relative] = sha(fs.readFileSync(absolute));
    }
  }
  visit(directory);
  return result;
}

function sourceInventory(source) {
  const result = {};
  for (const rel of ['Home23', 'Home23Shared/Sources', 'Home23.xcodeproj', 'scripts']) {
    for (const [file, digest] of Object.entries(inventory(path.join(source, rel)))) {
      if (!file.includes('xcuserdata/')) result[`${rel}/${file}`] = digest;
    }
  }
  result['Home23Shared/Package.swift'] = sha(fs.readFileSync(path.join(source, 'Home23Shared/Package.swift')));
  return result;
}

export function extensionSigningManifest(config) {
  const manifest = config.extensionSigningManifest;
  insist(typeof manifest === 'string' && path.isAbsolute(manifest), 'Pin an absolute extensionSigningManifest path in the installation configuration.');
  insist(fs.statSync(manifest).isFile(), 'The extension signing manifest must be a file.');
  return manifest;
}

function verifyApp(app, config) {
  insist(path.isAbsolute(app), 'Use an absolute app path.');
  const info = plist(path.join(app, 'Info.plist'));
  verifyMetadata(info, config);
  const binary = path.join(app, `${info.CFBundleExecutable}.debug.dylib`);
  const bytes = fs.readFileSync(fs.existsSync(binary) ? binary : path.join(app, info.CFBundleExecutable));
  insist(bytes.includes(Buffer.from(config.contractSHA256)), 'Compiled app has the wrong persistence contract.');
  insist(bytes.includes(Buffer.from('ProductWorkThreadsViewModel')), 'Compiled app lacks current Working Threads.');
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  const signatureDetails = spawnSync('/usr/bin/codesign', ['-d', '--verbose=4', app], { encoding: 'utf8' });
  insist(signatureDetails.status === 0 && signatureDetails.stderr.includes(`Authority=${config.signingIdentity}`), 'App has the wrong signing certificate.');
  const certificateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-signed-certificate-'));
  try {
    const prefix = path.join(certificateDirectory, 'certificate');
    run('/usr/bin/codesign', ['-d', '--extract-certificates=' + prefix, app], { stdio: ['ignore', 'pipe', 'ignore'] });
    const certificate = new crypto.X509Certificate(fs.readFileSync(prefix + '0'));
    insist(certificate.fingerprint.replaceAll(':', '').toUpperCase() === config.signingCertificateSHA1?.toUpperCase(), 'App was signed with a different certificate fingerprint.');
  } finally { fs.rmSync(certificateDirectory, { recursive: true, force: true }); }

  insist(sha(fs.readFileSync(path.join(app, 'embedded.mobileprovision'))) === sha(fs.readFileSync(config.profile)), 'App has a different provisioning profile.');
  const signature = run('/usr/bin/codesign', ['-d', '--entitlements', ':-', app], { stdio: ['ignore', 'pipe', 'ignore'] });
  const ent = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { input: signature }));
  const expected = plist(config.entitlements);
  insist(JSON.stringify(Object.entries(ent).sort()) === JSON.stringify(Object.entries(expected).sort()), 'Signed entitlements differ from the pinned identity.');
  const extensionVerification = run('/usr/bin/python3', [
    path.join(config.sourceRoot, 'scripts/ios-extension-signing.py'), 'verify',
    '--app', app, '--parent-profile', config.profile,
    '--identity', config.signingCertificateSHA1, '--manifest', extensionSigningManifest(config),
  ]).trim();
  return { info, files: inventory(app), extensionVerification };
}

async function main() {
  const { installation, command, arg, output } = parseInvocation(process.argv.slice(2));
  const config = readJSON(path.join(installation, 'instances/.house/home23-ios.json'));
  if (command === 'status') {
    console.log(JSON.stringify({ ...config, verifiedSource: verifySource(config), signing: signingReadiness(config, 0) }, null, 2));
    return;
  }
  if (command === 'verify') {
    const result = verifyApp(arg, config);
    console.log(JSON.stringify({ info: result.info, artifactSHA256: sha(JSON.stringify(result.files)), extensionVerification: result.extensionVerification }, null, 2));
    return;
  }
  if (command === 'build' || command === 'compile') {
    insist(/^\d+$/.test(arg ?? '') && Number(arg) >= config.minimumBuild, 'Provide a numeric build at or above the current build floor.');
    insist(output && path.isAbsolute(output) && !fs.existsSync(output), 'Provide a new absolute output directory.');
    const signing = command === 'build' ? signingReadiness(config) : null;
    const extensionManifest = command === 'build' ? extensionSigningManifest(config) : null;
    const source = verifySource(config), before = sourceInventory(source);
    fs.mkdirSync(output, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(output, 'source-before.json'), JSON.stringify(before, null, 2));
    const args = buildArguments({ source, output, buildNumber: arg, port: config.port });
    fs.writeFileSync(path.join(output, 'build-request.json'), JSON.stringify({ installation, source, args, signing }, null, 2));
    run('/usr/bin/xcodebuild', args, { cwd: source, env: { ...process.env, DEVELOPER_DIR: config.developerDir }, stdio: 'inherit' });
    const after = sourceInventory(source);
    fs.writeFileSync(path.join(output, 'source-after.json'), JSON.stringify(after, null, 2));
    insist(JSON.stringify(before) === JSON.stringify(after), 'Source changed during build. Review it before signing.');
    const app = path.join(output, 'DerivedData/Build/Products/Debug-iphoneos/Home23.app');
    verifyMetadata(plist(path.join(app, 'Info.plist')), config);
    if (command === 'compile') {
      fs.writeFileSync(path.join(output, 'unsigned-artifact.json'), JSON.stringify({ app, signed: false, installable: false, sourceUnchanged: true }, null, 2));
      console.log(`Compiled unsigned Home23 ${arg}: ${app}. Signing and verification are still required; do not install this artifact.`);
      return;
    }

    run(path.join(source, 'scripts/sign-home23-ios.sh'), [app, config.profile, config.entitlements, config.signingCertificateSHA1], {
      stdio: 'inherit', env: { ...process.env, HOME23_IOS_EXTENSION_SIGNING_MANIFEST: extensionManifest },
    });
    const verified = verifyApp(app, config);
    fs.writeFileSync(path.join(output, 'verified-artifact.json'), JSON.stringify(verified, null, 2));
    console.log(`Verified Home23 ${arg}: ${app}\nInstallation is a separate explicit operation.`);
    return;
  }
  throw new Error('Usage: node scripts/home23-ios.mjs [--installation /path/to/installation] status | verify /absolute/Home23.app | compile NUMBER /absolute/new-output-directory | build NUMBER /absolute/new-output-directory');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
