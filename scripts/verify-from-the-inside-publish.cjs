#!/usr/bin/env node
'use strict';

const path = require('path');
const {
  DEFAULT_PROJECT_DIR,
  DEFAULT_SITE_DIR,
  verifyFromTheInsidePublish,
} = require('../engine/src/evidence/from-the-inside-publish.js');

async function main(argv) {
  const args = parseArgs(argv);
  if (!args.issue || args.help) {
    printUsage();
    return args.help ? 0 : 2;
  }

  const result = await verifyFromTheInsidePublish({
    issue: args.issue,
    projectDir: args.projectDir || DEFAULT_PROJECT_DIR,
    siteDir: args.siteDir || DEFAULT_SITE_DIR,
    publicBaseUrl: args.publicBaseUrl,
    writeReceipt: args.writeReceipt || args.writeEventLog || args.writeTrustClaim,
    writeEventLog: args.writeEventLog || args.writeReceipt,
    writeTrustClaim: args.writeTrustClaim || args.writeReceipt || args.writeEventLog,
    writeProofPacket: args.writeProofPacket || args.writeReceipt || args.writeEventLog || args.writeTrustClaim,
    trustStorePath: args.trustStorePath,
    checkRemote: args.checkRemote,
    correctionOf: args.correctionOf || null,
  });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const receipt = result.receipt;
    console.log(`[evidence] ${receipt.subject} ${receipt.result} ${receipt.receiptId}`);
    if (result.receiptPath) console.log(`[evidence] receipt: ${result.receiptPath}`);
    if (result.proofPacketPath) console.log(`[evidence] proof packet: ${result.proofPacketPath}`);
    if (result.eventLogPath) console.log(`[evidence] event log: ${result.eventLogPath}`);
    if (result.trustStorePath) console.log(`[trust] store: ${result.trustStorePath}`);
    if (result.trustExplanation) console.log(`[trust] safe_to_inherit: ${result.trustExplanation.safeToInherit ? 'yes' : 'no'} (${result.trustExplanation.status})`);
    for (const check of receipt.checks) {
      const status = check.pass ? 'pass' : 'fail';
      console.log(`[check] ${status.padEnd(4)} ${check.name}${check.detail ? ` - ${check.detail}` : ''}`);
    }
  }

  return result.receipt.result === 'pass' ? 0 : 1;
}

function parseArgs(argv) {
  const out = {
    issue: null,
    projectDir: null,
    siteDir: null,
    publicBaseUrl: null,
    writeReceipt: false,
    checkRemote: false,
    correctionOf: null,
    writeEventLog: false,
    writeTrustClaim: false,
    writeProofPacket: false,
    trustStorePath: null,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--project-dir') out.projectDir = path.resolve(argv[++i]);
    else if (arg === '--site-dir') out.siteDir = path.resolve(argv[++i]);
    else if (arg === '--public-base-url') out.publicBaseUrl = argv[++i];
    else if (arg === '--write-receipt') out.writeReceipt = true;
    else if (arg === '--write-event') out.writeEventLog = true;
    else if (arg === '--write-trust') out.writeTrustClaim = true;
    else if (arg === '--write-proof-packet') out.writeProofPacket = true;
    else if (arg === '--trust-store') out.trustStorePath = path.resolve(argv[++i]);
    else if (arg === '--check-remote') out.checkRemote = true;
    else if (arg === '--correction-of') out.correctionOf = argv[++i];
    else if (arg === '--json') out.json = true;
    else if (!out.issue) out.issue = arg;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  return out;
}

function printUsage() {
  console.error([
    'Usage: scripts/verify-from-the-inside-publish <issue> [--write-receipt] [--write-proof-packet] [--write-event] [--write-trust] [--check-remote]',
    '',
    'Checks local issue JSON, rendered public HTML, copied JSON, homepage, feed, sitemap,',
    'and next-issue state, then emits an evidence.v1 receipt and optional Field Report proof packet.',
  ].join('\n'));
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}).catch((err) => {
  console.error(`[evidence] ERROR: ${err.message}`);
  process.exitCode = 2;
});
