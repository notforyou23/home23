#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function build(root) {
  root=fs.realpathSync(root);
  const pointer=path.join(root,'instances','.house','coordination','active-release.json');
  try { fs.lstatSync(pointer); throw new Error('Refusing build in a managed live installation. Build an isolated candidate; see docs/reference/MANAGED-RELEASES.md.'); }
  catch(error) { if(error.code!=='ENOENT') throw error; }
  execFileSync(process.execPath,[path.join(root,'node_modules/typescript/bin/tsc')],{cwd:root,stdio:'inherit'});
  // tsc follows static imports, not readFile(new URL(...)) asset dependencies.
  const assets=path.join(root,'src/coordination/contracts/v1');
  if(fs.existsSync(assets)) fs.cpSync(assets,path.join(root,'dist/coordination/contracts/v1'),{recursive:true});
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  try { if(process.argv.length>2) throw new Error('Build accepts no overrides; use a separate typecheck command for noEmit.');build(process.cwd()); }
  catch(error) { console.error(error.message);process.exitCode=1; }
}
