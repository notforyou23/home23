import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { TrustKernel } = require('../../engine/src/trust/trust-kernel.js');

export async function handleTrustCommand(args, homeRoot) {
  const subcommand = args[0];
  if (!subcommand || subcommand === 'help' || subcommand === '--help') {
    printTrustUsage();
    return;
  }

  if (subcommand === 'explain') {
    const claimId = args[1];
    if (!claimId) throw new Error('Usage: home23 trust explain <claim-id>');
    const opts = parseOptions(args.slice(2));
    const kernel = kernelFromOptions(homeRoot, opts);
    const explanation = kernel.explain(claimId);
    if (opts.json) console.log(JSON.stringify(explanation, null, 2));
    else console.log(formatTrustExplanation(explanation));
    process.exitCode = explanation.safeToInherit ? 0 : 1;
    return;
  }

  if (subcommand === 'conflicts') {
    const opts = parseOptions(args.slice(1));
    const kernel = kernelFromOptions(homeRoot, opts);
    const conflicts = kernel.listConflicts();
    if (opts.json) {
      console.log(JSON.stringify({ conflicts }, null, 2));
    } else if (conflicts.length === 0) {
      console.log('Conflicts: none');
    } else {
      for (const item of conflicts) {
        console.log(`${item.claimId}: ${item.conflicts.map((c) => c.claimId).join(', ')}`);
      }
    }
    process.exitCode = conflicts.length === 0 ? 0 : 1;
    return;
  }

  if (subcommand === 'claim') {
    const claimId = args[1];
    if (!claimId) throw new Error('Usage: home23 trust claim <claim-id> --type ... --subject ... --predicate ... --value ...');
    const opts = parseOptions(args.slice(2));
    const required = ['type', 'subject', 'predicate', 'value'];
    for (const key of required) {
      if (opts[key] === undefined) throw new Error(`home23 trust claim requires --${key}`);
    }
    const kernel = kernelFromOptions(homeRoot, opts);
    const claim = kernel.recordClaim(claimFromOptions(claimId, opts));
    const explanation = kernel.explain(claim.id);
    if (opts.json) console.log(JSON.stringify(explanation, null, 2));
    else console.log(formatTrustExplanation(explanation));
    process.exitCode = explanation.safeToInherit ? 0 : 1;
    return;
  }

  if (subcommand === 'verify') {
    const claimId = args[1];
    if (!claimId) throw new Error('Usage: home23 trust verify <claim-id> --receipt path --type ... --subject ... --predicate ... --value ...');
    const opts = parseOptions(args.slice(2));
    const required = ['receipt', 'type', 'subject', 'predicate', 'value'];
    for (const key of required) {
      if (opts[key] === undefined) throw new Error(`home23 trust verify requires --${key}`);
    }
    if (!existsSync(resolve(opts.receipt))) throw new Error(`receipt not found: ${opts.receipt}`);
    const receipt = JSON.parse(readFileSync(resolve(opts.receipt), 'utf8'));
    if (!opts.observedAt && receipt.createdAt) opts.observedAt = receipt.createdAt;
    const kernel = kernelFromOptions(homeRoot, opts);
    const claim = kernel.recordVerifiedClaim({
      claim: claimFromOptions(claimId, opts),
      receipt,
      receiptPath: resolve(opts.receipt),
    });
    const explanation = kernel.explain(claim.id);
    if (opts.json) console.log(JSON.stringify(explanation, null, 2));
    else console.log(formatTrustExplanation(explanation));
    process.exitCode = explanation.safeToInherit ? 0 : 1;
    return;
  }

  throw new Error(`Unknown trust command: ${subcommand}`);
}

export function formatTrustExplanation(explanation) {
  if (!explanation?.claim) {
    return [
      `Status: ${explanation?.status || 'unknown_but_expected'}`,
      `Claim: ${explanation?.claimId || 'unknown'}`,
      'Safe to inherit: no',
      `Recommended action: ${explanation?.recommendedAction || 'record_or_refresh_claim'}`,
    ].join('\n');
  }

  const claim = explanation.claim;
  const lines = [
    `Status: ${explanation.status}`,
    `Claim: ${claim.subject} ${claim.predicate}=${formatValue(claim.value)}`,
    `Observed at: ${claim.observedAt || 'unknown'}`,
    `Verifier: ${claim.verifier || 'none'}`,
    `Scope: ${claim.scope}`,
    `Privacy: ${claim.privacyClass}`,
    `Safe to inherit: ${explanation.safeToInherit ? 'yes' : 'no'}`,
  ];

  if (explanation.freshness?.expiresAt) {
    lines.push(`Freshness: expires ${explanation.freshness.expiresAt}`);
  } else {
    lines.push('Freshness: archival_or_unbounded');
  }

  lines.push('Evidence:');
  if (explanation.evidence?.length) {
    for (const ref of explanation.evidence) {
      const status = ref.verified ? 'pass' : 'fail';
      const handle = ref.receiptId || ref.path || 'unknown';
      const pathPart = ref.path ? ` ${ref.path}` : '';
      lines.push(`  [${status}] ${handle}${pathPart}`);
    }
  } else {
    lines.push('  none');
  }

  if (explanation.conflicts?.length) {
    lines.push('Conflicts:');
    for (const conflict of explanation.conflicts) {
      lines.push(`  ${conflict.claimId} value=${formatValue(conflict.value)} actor=${conflict.actor || 'unknown'}`);
    }
  } else {
    lines.push('Conflicts: none');
  }

  if (explanation.reasons?.length) lines.push(`Reasons: ${explanation.reasons.join(', ')}`);
  if (explanation.recommendedAction) lines.push(`Recommended action: ${explanation.recommendedAction}`);
  return lines.join('\n');
}

export function parseTrustValue(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function claimFromOptions(claimId, opts) {
  return {
    id: claimId,
    type: opts.type,
    subject: opts.subject,
    predicate: opts.predicate,
    value: parseTrustValue(opts.value),
    actor: opts.actor || 'jerry',
    observedAt: opts.observedAt || new Date().toISOString(),
    sourceRefs: opts.source ? [{ type: 'source', path: resolve(opts.source) }] : [],
    confidence: opts.confidence !== undefined ? Number(opts.confidence) : undefined,
    freshnessTTL: opts.ttl || opts.ttlMs,
    scope: opts.scope || 'operational_internal',
    privacyClass: opts.privacyClass || opts.privacy || 'operational_internal',
    verifier: opts.verifier || null,
    status: opts.status || undefined,
  };
}

function kernelFromOptions(homeRoot, opts) {
  return new TrustKernel({
    storePath: opts.store ? resolve(opts.store) : defaultTrustStorePath(homeRoot, opts.agent || 'jerry'),
  });
}

function defaultTrustStorePath(homeRoot, agent) {
  return join(homeRoot, 'instances', agent, 'brain', 'trust', 'claims.jsonl');
}

function parseOptions(args) {
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') opts.json = true;
    else if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      opts[key] = value;
      i += 1;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  return opts;
}

function formatValue(value) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function printTrustUsage() {
  console.log(`
Home23 Trust Kernel

Commands:
  home23 trust explain <claim-id> [--agent jerry] [--store path] [--json]
  home23 trust conflicts [--agent jerry] [--store path] [--json]
  home23 trust claim <claim-id> --type T --subject S --predicate P --value V [--scope S] [--privacy-class C]
  home23 trust verify <claim-id> --receipt path --type T --subject S --predicate P --value V [--scope S] [--privacy-class C]
`);
}
