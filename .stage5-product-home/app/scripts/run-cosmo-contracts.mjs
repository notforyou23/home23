import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { cosmoSourcePath } = require('./lib/cosmo-source.cjs');
const result = spawnSync('npm', ['test'], { cwd: cosmoSourcePath('.'), stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
