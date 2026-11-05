#!/usr/bin/env node
'use strict';

const path = require('path');
const { EventLedger } = require('../engine/src/core/event-ledger.js');

const DEFAULT_LEDGER = path.resolve(__dirname, '..', 'instances', 'jerry', 'brain', 'event-ledger.jsonl');

function main(argv) {
  const args = parseArgs(argv);
  if (!args.subject || args.help) {
    printUsage();
    return args.help ? 0 : 2;
  }

  const ledgerPath = path.resolve(args.ledger || DEFAULT_LEDGER);
  const ledger = new EventLedger(path.dirname(ledgerPath), { ledgerPath });
  const projection = ledger.projectSubject(args.subject);

  if (args.json) {
    process.stdout.write(`${JSON.stringify(projection, null, 2)}\n`);
    return projection.eventCount > 0 ? 0 : 1;
  }

  console.log(`[state-event] subject=${projection.subject}`);
  console.log(`[state-event] ledger=${ledgerPath}`);
  console.log(`[state-event] events=${projection.eventCount}`);
  if (projection.latestEventType) console.log(`[state-event] latest=${projection.latestEventType}`);
  for (const event of projection.events) {
    const evidence = event.payload?.evidence?.receiptId ? ` receipt=${event.payload.evidence.receiptId}` : '';
    const causedBy = event.payload?.causedBy ? ` causedBy=${event.payload.causedBy}` : '';
    console.log(`${event.timestamp} ${event.event_type} actor=${event.actor}${evidence}${causedBy}`);
  }
  return projection.eventCount > 0 ? 0 : 1;
}

function parseArgs(argv) {
  const out = { subject: null, ledger: null, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--ledger') out.ledger = argv[++i];
    else if (arg === '--json') out.json = true;
    else if (!out.subject) out.subject = arg;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  return out;
}

function printUsage() {
  console.error([
    'Usage: scripts/trace-state-event <subject> [--ledger path] [--json]',
    '',
    'Examples:',
    '  scripts/trace-state-event live-problem/health_log_fresh',
    '  scripts/trace-state-event from-the-inside/099 --ledger instances/jerry/projects/from-the-inside/events/state-events.jsonl',
  ].join('\n'));
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  console.error(`[state-event] ERROR: ${err.message}`);
  process.exitCode = 2;
}
