import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { inspectIdentitySource } from '../src/agent/identity-maintenance.js';
const workspace = path.resolve(process.argv[2] || '.');
const configFile = path.resolve(workspace, '../config.yaml');
const config = existsSync(configFile) ? yaml.load(readFileSync(configFile,'utf8')) as any : {};
const identity = config?.chat?.identityFiles ?? [];
const startup = config?.situationalAwareness?.bootstrap?.reads ?? ['NOW.md','PLAYBOOK.md'];
const triggered = (config?.situationalAwareness?.triggeredSurfaces ?? []).map((surface: any) => surface.file);
const sources = [...new Set<string>([...identity,...startup,...triggered])];
const files = sources.length ? sources : readdirSync(workspace).filter(file => /\.md$/i.test(file));
console.log(JSON.stringify({ workspace, files: files.map(file => ({...inspectIdentitySource(workspace,file),
  identity: identity.includes(file), startup: startup.includes(file), triggered: triggered.includes(file)})),
  note: 'File dates are observations, not proof of factual freshness. Review conflicting and superseded guidance against owner decisions before consolidation.' }, null, 2));
