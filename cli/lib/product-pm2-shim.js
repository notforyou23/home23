/** Read-only PM2 compatibility for scripts running inside a product home. */
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { productSupervisorCommand } from './product-supervisor.js';

const READ_COMMANDS = new Set(['jlist', 'list', 'ls', 'status']);
const USE_HOST = 'Use the Home23 Host to manage processes.';
const cell = value => String(value ?? '').replace(/[\t\r\n\x1b]/g, ' ');

export async function runProductPm2Shim(args, {
  environment = process.env, command = productSupervisorCommand,
  stdout = process.stdout, stderr = process.stderr,
} = {}) {
  const refuse = message => { stderr.write(`home23_pm2_read_only: ${message} ${USE_HOST}\n`); return 1; };
  // No arguments or flags can reach PM2's parser. Even display aliases use
  // the one guarded jlist request, never PM2's list/daemon lifecycle paths.
  if (!Array.isArray(args) || !READ_COMMANDS.has(args[0]) ||
      args.length > 2 || (args.length === 2 && args[1] !== '--silent')) {
    return refuse('Only jlist, list, ls and status are available to workspace scripts.');
  }
  if (!environment.HOME23_PRODUCT_HOST) return refuse('This shim requires a Home23 product home.');
  const app = environment.HOME23_ROOT;
  if (typeof app !== 'string' || !isAbsolute(app) || resolve(app) !== join(dirname(resolve(app)), 'app')) {
    return refuse('The Home23 product home is unavailable.');
  }
  let raw, rows;
  try {
    ({ stdout: raw } = await command(dirname(resolve(app)), ['jlist', '--silent']));
    rows = JSON.parse(raw);
    if (typeof raw !== 'string' || !Array.isArray(rows)) throw new Error('Invalid supervisor inventory');
  } catch {
    // Do not expose child error output (which can contain environment values)
    // or try an alternate PM2 executable when the supervisor is unavailable.
    return refuse('The resident supervisor is unavailable or returned invalid JSON. This shim cannot create a PM2 daemon.');
  }
  if (args[0] === 'jlist') stdout.write(raw); // Preserve the JSON bytes for existing samplers.
  else stdout.write('id\tname\tstatus\tpid\n' + rows.map(row => [
    row?.pm_id ?? row?.pm2_env?.pm_id, row?.name ?? row?.pm2_env?.name, row?.pm2_env?.status, row?.pid,
  ].map(cell).join('\t')).join('\n') + (rows.length ? '\n' : ''));
  return 0;
}
