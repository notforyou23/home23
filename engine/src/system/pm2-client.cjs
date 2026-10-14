'use strict';

/** Product children query their launchd supervisor through its guarded client.
 * They must never invoke the bundled PM2 CLI, which creates a daemon when a
 * connection is lost. Source installations retain their existing PATH PM2. */
const childProcess = require('node:child_process');
const { execFile, spawn } = childProcess;
const { promisify } = require('node:util');
const { dirname, isAbsolute, join, resolve } = require('node:path');

const execFileAsync = promisify(execFile);
const PRODUCT_COMMANDS = new Set(['jlist', 'start', 'restart', 'stop', 'delete']);
const PRODUCT_CLIENT = `
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
try {
  const [home, commands, delay] = process.argv.slice(1);
  if (Number(delay) > 0) await new Promise(resolve => setTimeout(resolve, Number(delay)));
  const { productSupervisorCommand } = await import(pathToFileURL(join(home, 'app/cli/lib/product-supervisor.js')).href);
  const result = await productSupervisorCommand(home, JSON.parse(commands));
  process.stdout.write(result.stdout || '');
} catch (error) {
  console.error(error.code || 'host_supervisor_unavailable');
  process.exitCode = 75;
}
`;

function pm2Invocation(args, options = {}, delayMs = 0) {
  const environment = options.env || process.env;
  const productParent = process.env.HOME23_PRODUCT_HOST === 'true';
  if (!productParent && environment.HOME23_PRODUCT_HOST !== 'true') return { file: 'pm2', args, options };
  // Cleaning a child environment must not turn a product role into a source
  // operator or redirect it to another home's supervisor.
  if (productParent && environment.HOME23_ROOT && environment.HOME23_ROOT !== process.env.HOME23_ROOT) {
    throw Object.assign(new Error('The product supervisor home differs from its parent.'), { code: 'host_supervisor_ambiguous' });
  }
  const app = productParent ? process.env.HOME23_ROOT : environment.HOME23_ROOT;
  if (typeof app !== 'string' || !isAbsolute(app) || resolve(app) !== join(dirname(resolve(app)), 'app')) {
    throw Object.assign(new Error('The product supervisor home is unavailable.'), { code: 'host_supervisor_unavailable' });
  }
  if (!Array.isArray(args) || !PRODUCT_COMMANDS.has(args[0]) || args.includes('all') || args.includes('--no-daemon')) {
    throw Object.assign(new Error('Unsupported product supervisor command.'), { code: 'host_supervisor_ambiguous' });
  }
  // The imported product control module builds its own home-specific PM2
  // environment. No house-child PM2 metadata or credentials enter this worker.
  return {
    file: process.execPath,
    args: ['--input-type=module', '-e', PRODUCT_CLIENT, dirname(resolve(app)), JSON.stringify(args), String(delayMs)],
    options: { ...options, shell: false, env: { HOME23_PRODUCT_HOST: 'true', HOME23_ROOT: resolve(app), LANG: 'en_US.UTF-8' } },
  };
}

/** Opaque shell PM2 commands cannot safely retain the private client guard.
 * Refuse known CLI/module invocations; log-file reads such as pm2.log remain
 * available. This is a routing guard, not a shell security sandbox. */
function refuseProductPm2Shell(command, environment = process.env) {
  if (process.env.HOME23_PRODUCT_HOST !== 'true' && environment.HOME23_PRODUCT_HOST !== 'true') return null;
  if (typeof command !== 'string') return null;
  const executable = /(?:^|[^a-z0-9_.-])pm2(?:-runtime)?(?=$|[\s@'";|&()<>{}])|node_modules\/pm2(?:\/|$)/i;
  const packageImport = /(?:require|import)\s*\(\s*['"]pm2\/|\b(?:from|import)\s+['"]pm2\/|--(?:import|require)(?:\s+|=)['"]?pm2\//i;
  if (!executable.test(command) && !packageImport.test(command)) return null;
  return { is_error: true, content: 'host_supervisor_command_required: PM2 shell commands are unavailable in a product home. Use the Home23 supervisor controls.' };
}

function runPm2Sync(args, options = {}, execute = (...callArgs) => childProcess.execFileSync(...callArgs)) {
  const command = pm2Invocation(args, options);
  return execute(command.file, command.args, command.options);
}

async function runPm2(args, options = {}, execute = execFileAsync) {
  const command = pm2Invocation(args, options);
  return execute(command.file, command.args, command.options);
}

function schedulePm2(args, { delayMs = 1000, ...options } = {}, execute = spawn) {
  const command = pm2Invocation(args, options, delayMs);
  const child = command.file === 'pm2'
    ? execute('sh', ['-c', 'sleep "$1"; shift; exec "$@"', 'home23-pm2-client', String(delayMs / 1000), 'pm2', ...args], { ...options, detached: true, stdio: 'ignore' })
    : execute(command.file, command.args, { ...command.options, detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}

module.exports = { pm2Invocation, runPm2, runPm2Sync, schedulePm2, refuseProductPm2Shell };
