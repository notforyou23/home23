#!/usr/bin/env node
/** Independent recovery entry. This file is copied beside the journal, outside the package being replaced. */
import { resumeProductUpdate } from './product-update-apply.js';

const args = process.argv.slice(2);
let homeRoot;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--home' && args[index + 1]) homeRoot = args[++index];
}
const result = await resumeProductUpdate({ homeRoot });
process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.ok === false) process.exitCode = 1;
