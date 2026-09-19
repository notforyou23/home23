#!/usr/bin/env node
// Installed launchd entrypoint: resolve the selected package on every restart.
import { readFileSync, lstatSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function serviceConfig(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error('Service config must be a private regular file');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  if (!config || config.version !== 1 || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(config.resident ?? '')) throw new Error('Invalid service configuration');
  for (const field of ['installation', 'sessionDirectory', 'bindingFile']) {
    if (typeof config[field] !== 'string' || !isAbsolute(config[field])) throw new Error(`${field} must be absolute`);
  }
  return config;
}

export async function main(args) {
  if (args.length !== 1) throw new Error('Usage: service.mjs <private-service-config.json>');
  const config = serviceConfig(resolve(args[0]));
  const require = createRequire(join(config.installation, 'package.json'));
  const { resolveActiveCoordinationRelease } = require(join(config.installation, 'cli/lib/coordination-active-release.cjs'));
  const active = resolveActiveCoordinationRelease(config.installation);
  if (!active?.residents[config.resident]) throw new Error('Configured resident is not enabled in the selected release');
  const ecosystem = require(join(config.installation, 'ecosystem.config.cjs'));
  const harness = ecosystem.apps.find(app => app.name === `home23-${config.resident}-harness`);
  const env = harness?.env;
  if (env?.HOME23_AGENT !== config.resident || env.HOME23_COORDINATION_RESIDENT_RUNTIME_ROOT !== active.releaseRoot) throw new Error('Saved harness environment does not match selected release');
  // Reuse the existing authenticated resident, without putting credentials in launchd/config.
  for (const key of ['HOME23_AGENT', 'HOME23_COORDINATION_SOCKET_PATH', 'HOME23_COORDINATION_SERVER_INSTANCE_ID', 'HOME23_COORDINATION_RESIDENT_CLIENT_INSTANCE_ID', 'HOME23_COORDINATION_RESIDENT_KEY_VERSION', 'HOME23_COORDINATION_RESIDENT_KEY']) {
    if (typeof env[key] !== 'string' || !env[key]) throw new Error(`Missing harness environment: ${key}`);
    process.env[key] = env[key];
  }
  console.log(JSON.stringify({ releaseId: active.releaseId, sessionDirectory: config.sessionDirectory, resident: config.resident }));
  const cli = await import(pathToFileURL(join(active.releaseRoot, 'dist/chess/cli.js')).href);
  await cli.main(['serve', config.sessionDirectory, config.bindingFile]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
