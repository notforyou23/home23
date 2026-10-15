#!/usr/bin/env node
// Build first: npm run build. --apply is an offline operator action; this
// command never stops Core or resident executors itself.
import { resolve } from 'node:path';
import { repairScheduledChannelWork } from '../../dist/coordination/operations/repair-scheduled-channel-work.js';

const usage = `Usage: node scripts/coordination/repair-scheduled-channel-work.mjs
  --database PATH --channel CHANNEL_ID [--journal-file PATH ...]
  [--apply --core-stopped --backup NEW_PATH]

Dry-run is the default and opens SQLite read-only (mode=ro).
Apply requires Core and affected resident executors stopped through their normal
lifecycle. It takes the product exclusive writer lock and refuses another writer.
Apply also requires the current schema, migrated by normal product startup first.
It verifies a SQLite backup plus manifest before opening the product writer.
It never closes Work from age or assistant text alone. Supply exact resident
conversation JSONL files to recover stopped/completed/timed-out turn evidence.
Existing terminal Work requires the scheduled card projection fix, not a rewrite.`;
const args = process.argv.slice(2);
if (args.includes('--help')) { process.stdout.write(usage + '\n'); process.exit(0); }
const values = new Map(); const flags = new Set(); const journals = [];
for (let index = 0; index < args.length; index++) {
  const option = args[index];
  if (['--apply', '--core-stopped'].includes(option)) {
    if (flags.has(option)) throw new Error(`duplicate option ${option}`);
    flags.add(option); continue;
  }
  if (!['--database', '--channel', '--backup', '--journal-file'].includes(option)) throw new Error('unknown option');
  const value = args[++index];
  if (!value || value.startsWith('--')) throw new Error(`missing value for ${option}`);
  if (option === '--journal-file') journals.push(resolve(value));
  else { if (values.has(option)) throw new Error(`duplicate option ${option}`); values.set(option, value); }
}
if (!values.has('--database') || !values.has('--channel')) throw new Error('--database and --channel are required; use --help');
try {
  const result = await repairScheduledChannelWork({ databasePath: resolve(values.get('--database')), channelId: values.get('--channel'),
    journalPaths: journals, apply: flags.has('--apply'), coreStopped: flags.has('--core-stopped'),
    ...(values.has('--backup') ? { backupPath: resolve(values.get('--backup')) } : {}) });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result.status === 'locked') process.exitCode = 2;
} catch (error) {
  // Do not print raw SQLite/journal values or stack traces from private state.
  process.stderr.write(`Scheduled Work repair refused: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exitCode = 1;
}
