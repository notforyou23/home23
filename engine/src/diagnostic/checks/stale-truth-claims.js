'use strict';

/**
 * Stale Truth Claims
 *
 * Reads truth.jsonl for claims with status 'current' that reference files
 * which no longer exist or have been modified after the claim was made.
 * These are claims the system still believes but reality has moved on.
 *
 * Would have caught: stale claims about old From The Inside unit state.
 */

const fs = require('fs');
const path = require('path');

async function run(ctx) {
  const truthPath = path.join(ctx.brainDir, 'agency', 'truth.jsonl');
  if (!fs.existsSync(truthPath)) {
    return { ok: true, findings: [] };
  }

  let claims;
  try {
    const raw = fs.readFileSync(truthPath, 'utf8');
    claims = raw.split('\n').filter(l => l.trim()).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch (err) {
    return { ok: false, error: `failed to read truth.jsonl: ${err.message}`, findings: [] };
  }

  // Latest state per claim ID
  const latest = new Map();
  for (const claim of claims) {
    if (claim?.id) latest.set(claim.id, claim);
  }

  const findings = [];

  for (const claim of latest.values()) {
    if (claim.status !== 'current') continue;
    if (!claim.sourceRef) continue;

    // Check if sourceRef is a file path
    let refPath = claim.sourceRef;
    if (refPath.startsWith('~/')) {
      refPath = path.join(os.homedir(), refPath.slice(2));
    }
    if (!refPath.startsWith('/')) continue; // not a path

    // Check if the referenced file still exists
    if (!fs.existsSync(refPath)) {
      findings.push({
        id: `stale_truth_claims:${claim.id}`,
        severity: 'warning',
        code: 'truth_claim_source_missing',
        message: `Claim ${claim.id} references ${refPath} which no longer exists`,
        evidence: {
          claimId: claim.id,
          claim: claim.claim?.slice(0, 120),
          sourceRef: claim.sourceRef,
          sourceExists: false,
        },
        autoFixable: false, // demoting a truth claim needs jtr or higher authority
      });
      continue;
    }

    // Check if the file was modified after the claim was accepted
    const acceptedAt = claim.acceptedAt ? Date.parse(claim.acceptedAt) : null;
    if (!acceptedAt) continue;

    try {
      const stat = fs.statSync(refPath);
      const fileMtime = stat.mtimeMs;
      if (fileMtime > acceptedAt + 60000) { // 1 min grace
        findings.push({
          id: `stale_truth_claims:${claim.id}:modified`,
          severity: 'info',
          code: 'truth_claim_source_modified',
          message: `Claim ${claim.id} source file modified after claim was accepted`,
          evidence: {
            claimId: claim.id,
            claim: claim.claim?.slice(0, 120),
            sourceRef: claim.sourceRef,
            acceptedAt: claim.acceptedAt,
            fileMtime: new Date(fileMtime).toISOString(),
          },
          autoFixable: false,
        });
      }
    } catch {
      // stat failed — can't check
    }
  }

  return { ok: true, findings };
}

const os = require('os');

module.exports = {
  id: 'stale_truth_claims',
  label: 'Stale Truth Claims',
  intervalMs: 30 * 60 * 1000, // 30 min
  run,
};