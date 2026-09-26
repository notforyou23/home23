#!/usr/bin/env node
/** Independent recovery entry. This file is copied beside the journal, outside the package being replaced. */
import { recoverProductUpdate, resumeProductUpdate } from './product-update-apply.js';

const args = process.argv.slice(2);
let homeRoot, abort = false;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--home' && args[index + 1]) homeRoot = args[++index];
  else if (args[index] === '--abort') abort = true;
}
// --abort returns a home whose update stopped before switching to service on
// its current version, instead of resuming the update.
const result = abort ? await recoverProductUpdate({ homeRoot }) : await resumeProductUpdate({ homeRoot });
process.stdout.write(`${JSON.stringify(result)}\n`);
// A completed recover closes the journal as aborted, which is not an update result.
if (abort ? result.status !== 'aborted' : result.ok === false) process.exitCode = 1;
