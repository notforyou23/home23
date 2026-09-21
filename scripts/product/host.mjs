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
      if (action !== 'update' || options.admit) throw new Error('Usage: host.mjs preview|stage|update|update-resume|install|catalog|status|create|semantic-prepare|start|stop --home ABS [--payload ABS] [--staging ABS] [--admit]');
      options.admit = true;
      continue;
    }
    if (!['--home', '--payload', '--staging'].includes(key) || !args.length || options[key]) throw new Error('Usage: host.mjs preview|stage|update|update-resume|install|catalog|status|create|semantic-prepare|start|stop --home ABS [--payload ABS] [--staging ABS] [--admit]');
    options[key] = args.shift();
  }
  homeRoot = absoluteHome(options['--home']);
  if (options['--staging'] && !['stage', 'update'].includes(action)) throw new Error('--staging is only supported by stage and update.');
  let input = {};
  if (action === 'stage' || action === 'update') input.staging = options['--staging'];
  if (options.admit) input.admit = true;
  if (action === 'update' || action === 'update-resume') {
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
