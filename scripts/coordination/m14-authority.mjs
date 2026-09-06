#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { executeM14AuthorityTransition } from '../../dist/coordination/operations/index.js';

const args=process.argv.slice(2);const value=(name)=>{const i=args.indexOf(name);return i<0?null:args[i+1]??null;};const apply=args.includes('--apply');
const database=value('--database'),evidence=value('--evidence');if(!database||!evidence)throw new Error('--database and --evidence are required');const input=JSON.parse(readFileSync(resolve(evidence),'utf8'));
const result=executeM14AuthorityTransition({databasePath:resolve(database),receipt:input.receipt,publicKeyPem:input.publicKeyPem,activeCanonicalWriters:input.activeCanonicalWriters,requestId:input.requestId,correlationId:input.correlationId,apply,liveAuthorized:apply&&value('--confirm')==='APPLY_SIGNED_M14_AUTHORITY'});
process.stdout.write(`${JSON.stringify(result,null,2)}\n`);
