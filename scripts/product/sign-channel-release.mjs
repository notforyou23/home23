#!/usr/bin/env node
/** Produce a signed private-channel manifest from reviewed, published-ready artifacts. No upload. */
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { createReadStream, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { signedReleaseBytes } from '../../cli/lib/product-release-channel.js';

const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index], value = process.argv[index + 1];
  if (!name?.startsWith('--') || !value || value.startsWith('--') || options[name]) throw new Error('Invalid manifest argument');
  options[name] = value;
}
for (const name of ['--receipt', '--runtime-archive', '--app-archive', '--runtime-url', '--app-url', '--private-key', '--output']) {
  if (!options[name]) throw new Error(`Missing ${name}`);
}
const receipt = JSON.parse(readFileSync(options['--receipt'], 'utf8'));
if (receipt.schema !== 'home23.mac-release-set.v1' || receipt.signing !== 'developer-id'
    || receipt.notarized !== true || receipt.appLayout !== 'Home23.app/Contents/Library/LoginItems/Home23Host.app') {
  throw new Error('Only a Developer ID signed, notarized single-app release may be published');
}
const hash = async file => { const digest = createHash('sha256'); for await (const chunk of createReadStream(file)) digest.update(chunk); return digest.digest('hex'); };
const artifact = async (kind, file, url) => {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) throw new Error('Artifact URL must be HTTPS');
  return { kind, url: parsed.href, sha256: await hash(file), bytes: statSync(file).size };
};
const release = {
  version: receipt.client.version, appBuild: Number(receipt.client.build), packageId: receipt.packageId,
  sourceCommit: receipt.backendCommit, platform: 'darwin', arch: receipt.arch, minimumOs: receipt.minimumMacOS,
  appBundleIdentifier: 'com.regina6.home23.mac', hostBundleIdentifier: 'com.home23.host',
  compatibility: { installationSchema: 'home23.product-install.v1', coordinationSchema: 20,
    stateMigration: 'schema_preserving_only', minimumClientBuild: Number(options['--minimum-client-build'] || 0) },
  appDeliveryURL: options['--mobile-app-url'] || null,
  runtime: await artifact('https-tar', options['--runtime-archive'], options['--runtime-url']),
  app: await artifact('https-zip', options['--app-archive'], options['--app-url']),
};
if (!Number.isSafeInteger(release.compatibility.minimumClientBuild) || release.compatibility.minimumClientBuild < 0) throw new Error('Invalid minimum client build');
if (release.appDeliveryURL && new URL(release.appDeliveryURL).protocol !== 'https:') throw new Error('Mobile delivery URL must be HTTPS');
const privateKey = createPrivateKey(readFileSync(options['--private-key']));
if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Release signing key must be Ed25519');
const envelope = { schema: 'home23.signed-release.v1', release,
  signature: sign(null, signedReleaseBytes(release), privateKey).toString('base64') };
writeFileSync(resolve(options['--output']), JSON.stringify(envelope, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ output: resolve(options['--output']), packageId: release.packageId, appBuild: release.appBuild }));
