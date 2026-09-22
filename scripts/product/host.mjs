#!/usr/bin/env node
/** Native Host bridge: one JSON result on stdout; credentials enter stdin only. */
import { absoluteHome, productEnvironment } from '../../cli/lib/product-environment.js';
const originalStdout = process.stdout.write.bind(process.stdout);
// Third-party preparation modules use console.log. Keep protocol stdout clean.
console.log = console.info = (...values) => console.error(...values);
const args = process.argv.slice(2);
const action = args.shift();
let homeRoot;
const sensitive = [];
try {
  const options = {};
  while (args.length) {
    const key = args.shift();
    if (key === '--admit') {
      if (action !== 'update' || options.admit) throw new Error('Usage: host.mjs preview|stage|update|update-resume|check-update|stage-release|download-release|backup|backup-inspect|move|install|catalog|status|create|semantic-prepare|start|stop --home ABS [--payload ABS] [--staging ABS] [--feed ABS] [--trust-key ABS] [--archive ABS] [--key ABS] [--inspection ABS] [--destination ABS] [--admit]');
      options.admit = true;
      continue;
    }
    if (!['--home', '--payload', '--staging', '--feed', '--trust-key', '--archive', '--key', '--inspection', '--destination'].includes(key) || !args.length || options[key]) throw new Error('Usage: host.mjs preview|stage|update|update-resume|check-update|stage-release|download-release|backup|backup-inspect|move|install|catalog|status|create|semantic-prepare|start|stop --home ABS [--payload ABS] [--staging ABS] [--feed ABS] [--trust-key ABS] [--archive ABS] [--key ABS] [--inspection ABS] [--destination ABS] [--admit]');
    options[key] = args.shift();
  }
  if (action !== 'backup-inspect') homeRoot = absoluteHome(options['--home']);
  if (options['--staging'] && !['stage', 'update', 'stage-release', 'download-release'].includes(action)) throw new Error('--staging is only supported by stage, update, stage-release, and download-release.');
  if (options['--feed'] && !['check-update', 'stage-release', 'download-release'].includes(action)) throw new Error('--feed is only supported by check-update, stage-release, and download-release.');
  if (options['--trust-key'] && !['stage-release', 'download-release'].includes(action)) throw new Error('--trust-key is only supported by stage-release and download-release.');
  let input = {};
  if (action === 'stage' || action === 'update') input.staging = options['--staging'];
  if (options.admit) input.admit = true;
  if (action === 'move') {
    if (!options['--destination'] || !options['--archive'] || !options['--key']) throw new Error('move requires --destination, --archive, and --key.');
    const { moveHome } = await import('../../cli/lib/product-backup.js');
    const result = await moveHome({ sourceHome: homeRoot, destinationRoot: options['--destination'], archivePath: options['--archive'], keyPath: options['--key'] });
    originalStdout(JSON.stringify(result) + '\n');
    if (result.ok === false) process.exitCode = 1;
  } else if (action === 'backup' || action === 'backup-inspect') {
    const { createHomeBackup, inspectHomeBackup } = await import('../../cli/lib/product-backup.js');
    const result = action === 'backup'
      ? await createHomeBackup({ homeRoot, archivePath: options['--archive'], keyPath: options['--key'] })
      : await inspectHomeBackup({ archivePath: options['--archive'], keyPath: options['--key'], inspectionRoot: options['--inspection'] });
    originalStdout(JSON.stringify(result) + '\n');
    if (result.ok === false) process.exitCode = 1;
  } else if (action === 'download-release') {
    if (!options['--feed'] || !options['--staging'] || !options['--trust-key']) throw new Error('download-release requires --feed, --staging, and --trust-key.');
    const { downloadDevelopmentRelease } = await import('../../cli/lib/product-update-feed.js');
    const result = downloadDevelopmentRelease({
      homeRoot, feedPath: options['--feed'], staging: options['--staging'], trustKeyPath: options['--trust-key'],
      onProgress: progress => process.stderr.write(`${JSON.stringify(progress)}\n`),
    });
    originalStdout(JSON.stringify(result) + '\n');
    if (result.ok === false) process.exitCode = 1;
  } else if (action === 'stage-release') {
    if (!options['--feed'] || !options['--staging'] || !options['--trust-key']) throw new Error('stage-release requires --feed, --staging, and --trust-key.');
    const { stageAuthenticatedRelease } = await import('../../cli/lib/product-update-feed.js');
    const result = stageAuthenticatedRelease({ homeRoot, feedPath: options['--feed'], staging: options['--staging'], trustKeyPath: options['--trust-key'] });
    originalStdout(JSON.stringify(result) + '\n');
    if (result.ok === false) process.exitCode = 1;
  } else if (action === 'check-update') {
    if (!options['--feed']) throw new Error('check-update requires --feed ABS.');
    const { inspectReleaseFeed } = await import('../../cli/lib/product-update-feed.js');
    const result = inspectReleaseFeed({ homeRoot, feedPath: options['--feed'] });
    originalStdout(JSON.stringify(result) + '\n');
    if (result.status === 'unavailable' || result.status === 'damaged' || result.status === 'incompatible') process.exitCode = 1;
  } else if (action === 'update' || action === 'update-resume') {
    const { applyProductUpdate, resumeProductUpdate } = await import('../../cli/lib/product-update-apply.js');
    const result = action === 'update-resume'
      ? await resumeProductUpdate({ homeRoot })
      : await applyProductUpdate({ homeRoot, candidatePayload: options['--payload'], staging: input.staging, admit: input.admit === true });
    originalStdout(JSON.stringify(result) + '\n');
    if (result.ok === false) process.exitCode = 1;
  } else {
  if (action === 'create') {
    let raw = '';
    for await (const part of process.stdin) { raw += part; if (Buffer.byteLength(raw) > 65536) throw new Error('Home23 setup input is too large.'); }
    try { input = JSON.parse(raw || '{}'); } catch { throw new Error('Home23 setup requires a valid JSON profile on stdin.'); }
    if (typeof input.credential?.apiKey === 'string') sensitive.push(input.credential.apiKey, input.credential.apiKey.trim());
  }
  const cleanEnv = productEnvironment(homeRoot);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, cleanEnv);
  // Redact supplied credentials even if a downstream dependency logs an error.
  const originalError = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => originalError(sensitive.filter(Boolean).reduce((value, secret) => value.split(secret).join('[redacted]'), String(chunk)), ...rest);
  const { runHostAction } = await import('../../cli/lib/product-host.js');
  const result = await runHostAction(action, { homeRoot, payloadPath: options['--payload'], input });
  originalStdout(JSON.stringify(result) + '\n');
  if (result.ok === false) process.exitCode = 1;
  }
} catch (error) {
  const message = sensitive.filter(Boolean).reduce((value, secret) => value.split(secret).join('[redacted]'), String(error.message || 'Home23 Host operation failed.'));
  originalStdout(JSON.stringify({ ok: false, status: 'degraded', homeRoot, error: { code: error.code || 'host_operation_failed', message } }) + '\n');
  process.exitCode = 1;
}
