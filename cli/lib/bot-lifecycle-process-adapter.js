/** Feature-off exact-name PM2 adapter for M28. */

import { execFileSync } from 'node:child_process';
import { startEcosystemProcesses, restartEcosystemProcesses } from './shared-service-start.js';

const PROCESS_NAME = /^home23-[a-z0-9][a-z0-9-]{0,127}$/;

function exactNames(names) {
  if (!Array.isArray(names) || names.length === 0) {
    throw Object.assign(new Error('At least one exact process name is required'), { code: 'process_names_invalid' });
  }
  const result = [...new Set(names)];
  if (result.length !== names.length || result.some((name) => typeof name !== 'string' || !PROCESS_NAME.test(name))) {
    throw Object.assign(new Error('Invalid or duplicate exact process name'), { code: 'process_names_invalid' });
  }
  return result;
}

export function createExactNameProcessController(options) {
  const home23Root = options?.installationRoot;
  if (typeof home23Root !== 'string' || !home23Root) throw new TypeError('installationRoot is required');
  const execFile = options.execFile || execFileSync;
  const env = options.env || process.env;

  return Object.freeze({
    startExact: async (names) => startEcosystemProcesses({
      home23Root, names: exactNames(names), execFile, env,
    }),
    stopExact: async (names) => {
      for (const name of exactNames(names)) {
        execFile('pm2', ['stop', name], { cwd: home23Root, env, stdio: 'pipe', timeout: 45_000 });
      }
    },
    restartExact: async (names) => restartEcosystemProcesses({
      home23Root, names: exactNames(names), execFile, env,
    }),
  });
}
