'use strict';

/**
 * Stale Contradictions
 *
 * Reads truth.jsonl directly. Finds claims stuck in 'contested' status for
 * more than 72 hours — these are contradictions the system cannot resolve on
 * its own and has been carrying as permanent noise.
 *
 * Would have caught: 7 contradictions stuck for weeks due to string-vs-ID bug.
 */

const fs = require('fs');
const path = require('path');

const STALE_THRESHOLD_HOURS = 72;

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

  // Compute latest state per claim ID (last entry wins)
  const latest = new Map();
  for (const claim of claims) {
    if (claim?.id) latest.set(claim.id, claim);
  }

  const now = Date.now();
  const findings = [];

  for (const claim of latest.values()) {
    if (claim.status !== 'contested') continue;
    if (!claim.contradicts) continue;

    const acceptedAt = claim.acceptedAt ? Date.parse(claim.acceptedAt) : null;
    if (!acceptedAt) continue;

    const ageHours = (now - acceptedAt) / (60 * 60 * 1000);
    if (ageHours < STALE_THRESHOLD_HOURS) continue;

    // Check if contradicts is a claim ID (resolvable) or a string (implicit)
    const contradictsIsClaimId = /^[a-f0-9_]{8,}$/.test(String(claim.contradicts));

    findings.push({
      id: `stale_contradictions:${claim.id}`,
      severity: 'warning',
      code: contradictsIsClaimId ? 'stale_contested_claim' : 'stale_implicit_contradiction',
      message: `Claim ${claim.id} has been contested for ${ageHours.toFixed(0)}h (threshold: ${STALE_THRESHOLD_HOURS}h)`,
      evidence: {
        claimId: claim.id,
        claim: claim.claim?.slice(0, 120),
        contradicts: claim.contradicts,
        contradictsIsClaimId,
        ageHours: Math.round(ageHours),
        acceptedAt: claim.acceptedAt,
      },
      autoFixable: !contradictsIsClaimId,
      async autoFix() {
        const resolution = {
          id: claim.id,
          claim: claim.claim,
          sourceType: claim.sourceType,
          sourceRef: claim.sourceRef,
          contradicts: claim.contradicts,
          status: 'resolved',
          resolutionReason: 'diagnostic_auto_resolved_stale_implicit_contradiction',
          resolvedAt: new Date().toISOString(),
          resolvedBy: 'diagnostic:stale_contradictions',
        };
        fs.appendFileSync(truthPath, JSON.stringify(resolution) + '\n');
        return {
          action: 'resolved_stale_implicit_contradiction',
          result: 'ok',
          evidence: { claimId: claim.id, ageHours: Math.round(ageHours) },
          reversible: true,
        };
      },
    });
  }

  return { ok: true, findings };
}

module.exports = {
  id: 'stale_contradictions',
  label: 'Stale Contradictions',
  intervalMs: 30 * 60 * 1000, // 30 min
  run,
};