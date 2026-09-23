#!/usr/bin/env node
/** Create a release runtime tar without touching an installation. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { verifyProductPayload } from '../../cli/lib/product-payload.js';

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--payload' || args[2] !== '--output') {
  throw new Error('Usage: archive-runtime.mjs --payload ABS --output NEW-ABS.tar');
}
const payload = resolve(args[1]), output = resolve(args[3]);
if (existsSync(output)) throw new Error('Refusing to replace an existing archive');
const manifest = verifyProductPayload(payload);
execFileSync('/usr/bin/tar', ['--format', 'pax', '-cf', output, '-C', payload, '.'], { stdio: 'inherit' });
const digest = createHash('sha256');
for await (const chunk of createReadStream(output)) digest.update(chunk);
const receipt = { schema: 'home23.runtime-archive.v1', packageId: manifest.packageId,
  sourceCommit: manifest.sourceCommit, archive: output, sha256: digest.digest('hex'), bytes: statSync(output).size };
writeFileSync(`${output}.json`, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify(receipt));
