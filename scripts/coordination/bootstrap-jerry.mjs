#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { bootstrapJerry } from '../../dist/coordination/operations/index.js';

const args=process.argv.slice(2);const value=(name)=>{const i=args.indexOf(name);return i<0?null:args[i+1]??null;};const apply=args.includes('--apply');
if(args.includes('--live')||args.includes('--canary'))throw new Error('bootstrap tool never sends a live canary or changes authority');
const database=value('--database');if(!database)throw new Error('--database is required');
let authority;if(apply){if(value('--confirm')!=='APPLY_FEATURE_OFF_JERRY_BOOTSTRAP')throw new Error('--apply requires --confirm APPLY_FEATURE_OFF_JERRY_BOOTSTRAP');const file=value('--authority-evidence');if(!file)throw new Error('--apply requires --authority-evidence');authority=JSON.parse(readFileSync(resolve(file),'utf8'));}
const receipt=await bootstrapJerry({databasePath:resolve(database),apply,authority,serverInstanceId:value('--server-instance')??'home23-jerry-harness',keyVersion:Number(value('--key-version')??'1')});
process.stdout.write(`${JSON.stringify(receipt,null,2)}\n`);
