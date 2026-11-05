import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { TrustKernel } = require('../../../engine/src/trust/trust-kernel.js');

function tempKernel() {
  const dir = mkdtempSync(join(tmpdir(), 'home23-trust-kernel-'));
  const storePath = join(dir, 'trust', 'claims.jsonl');
  return { dir, storePath, kernel: new TrustKernel({ storePath }) };
}

function passReceipt(subject = 'from-the-inside/099') {
  return {
    receiptVersion: 'evidence.v1',
    receiptId: `ev_${subject.replace(/[^a-z0-9]+/gi, '_')}`,
    actor: 'jerry',
    action: 'verify_claim',
    subject,
    checks: [{ name: 'verified', pass: true }],
    result: 'pass',
    claimLevel: 'verified_claim',
    createdAt: '2026-05-08T12:00:00.000Z',
  };
}

test('TrustKernel blocks consequential claims that lack verified receipts', () => {
  const { dir, kernel } = tempKernel();
  try {
    kernel.recordClaim({
      id: 'good_life.open_problems.zero',
      type: 'good_life.state',
      subject: 'good-life',
      predicate: 'open_problems',
      value: 0,
      actor: 'jerry',
      observedAt: '2026-05-08T12:00:00.000Z',
      scope: 'autonomous_action',
      privacyClass: 'operational_internal',
      status: 'candidate_claim',
      freshnessTTL: 5 * 60 * 1000,
    });

    const explanation = kernel.explain('good_life.open_problems.zero', {
      now: '2026-05-08T12:01:00.000Z',
    });

    assert.equal(explanation.status, 'candidate_claim');
    assert.equal(explanation.safeToInherit, false);
    assert.ok(explanation.reasons.includes('claim_not_verified'));
    assert.ok(explanation.reasons.includes('consequential_claim_requires_verified_receipt'));
    assert.equal(explanation.recommendedAction, 'run_or_attach_verifier_receipt');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TrustKernel promotes receipt-backed consequential claims as safe to inherit', () => {
  const { dir, storePath, kernel } = tempKernel();
  try {
    const receipt = passReceipt();
    const receiptPath = join(dir, '099.evidence.json');
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

    const claim = kernel.recordVerifiedClaim({
      claim: {
        id: 'from-the-inside.issue.099.published',
        type: 'issue.published',
        subject: 'from-the-inside/099',
        predicate: 'published',
        value: true,
        actor: 'jerry',
        observedAt: '2026-05-08T12:00:00.000Z',
        scope: 'public_artifact',
        privacyClass: 'public_artifact',
        verifier: 'verify-from-the-inside-publish',
      },
      receipt,
      receiptPath,
    });

    const explanation = kernel.explain(claim.id, { now: '2026-05-08T12:04:00.000Z' });

    assert.equal(explanation.status, 'known_verified');
    assert.equal(explanation.safeToInherit, true);
    assert.equal(explanation.claim.id, 'from-the-inside.issue.099.published');
    assert.equal(explanation.evidence[0].receiptId, receipt.receiptId);
    assert.equal(explanation.evidence[0].verified, true);
    assert.equal(explanation.conflicts.length, 0);
    assert.ok(existsSync(storePath));
    const events = readFileSync(storePath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(events[0].eventType, 'claim.verified');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TrustKernel marks verified claims stale after their freshness TTL expires', () => {
  const { dir, kernel } = tempKernel();
  try {
    kernel.recordVerifiedClaim({
      claim: {
        id: 'good_life.open_problems.zero',
        type: 'good_life.state',
        subject: 'good-life',
        predicate: 'open_problems',
        value: 0,
        actor: 'jerry',
        observedAt: '2026-05-08T12:00:00.000Z',
        scope: 'user_facing_status',
        privacyClass: 'operational_internal',
        freshnessTTL: 5 * 60 * 1000,
        verifier: 'good-life-live-problems-projection',
      },
      receipt: passReceipt('good-life/open-problems'),
      receiptPath: join(dir, 'good-life.evidence.json'),
    });

    const explanation = kernel.explain('good_life.open_problems.zero', {
      now: '2026-05-08T12:06:00.000Z',
    });

    assert.equal(explanation.status, 'known_stale');
    assert.equal(explanation.safeToInherit, false);
    assert.ok(explanation.reasons.includes('freshness_ttl_expired'));
    assert.equal(explanation.recommendedAction, 'refresh_claim_verification');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TrustKernel records failed receipts as unverified claims', () => {
  const { dir, storePath, kernel } = tempKernel();
  try {
    const receipt = {
      ...passReceipt('from-the-inside/099'),
      result: 'fail',
      claimLevel: 'candidate_claim',
    };
    kernel.recordVerifiedClaim({
      claim: {
        id: 'from-the-inside.issue.099.published',
        type: 'issue.published',
        subject: 'from-the-inside/099',
        predicate: 'published',
        value: true,
        actor: 'jerry',
        observedAt: '2026-05-08T12:00:00.000Z',
        scope: 'public_artifact',
        privacyClass: 'public_artifact',
        verifier: 'verify-from-the-inside-publish',
      },
      receipt,
      receiptPath: join(dir, '099.evidence.json'),
    });

    const explanation = kernel.explain('from-the-inside.issue.099.published', {
      now: '2026-05-08T12:01:00.000Z',
    });
    const events = readFileSync(storePath, 'utf8').trim().split('\n').map(JSON.parse);

    assert.equal(events[0].eventType, 'claim.verification_failed');
    assert.equal(explanation.status, 'known_unverified');
    assert.equal(explanation.safeToInherit, false);
    assert.ok(explanation.reasons.includes('consequential_claim_requires_verified_receipt'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TrustKernel surfaces verified claim conflicts instead of choosing a silent winner', () => {
  const { dir, kernel } = tempKernel();
  try {
    const base = {
      type: 'good_life.state',
      subject: 'good-life',
      predicate: 'open_problems',
      actor: 'jerry',
      observedAt: '2026-05-08T12:00:00.000Z',
      scope: 'autonomous_action',
      privacyClass: 'operational_internal',
      freshnessTTL: 10 * 60 * 1000,
      verifier: 'projection-check',
    };
    kernel.recordVerifiedClaim({
      claim: { ...base, id: 'good_life.open_problems.zero', value: 0 },
      receipt: passReceipt('good-life/open-problems-zero'),
      receiptPath: join(dir, 'zero.evidence.json'),
    });
    kernel.recordVerifiedClaim({
      claim: { ...base, id: 'good_life.open_problems.one', value: 1 },
      receipt: passReceipt('good-life/open-problems-one'),
      receiptPath: join(dir, 'one.evidence.json'),
    });

    const explanation = kernel.explain('good_life.open_problems.zero', {
      now: '2026-05-08T12:02:00.000Z',
    });

    assert.equal(explanation.status, 'known_conflicted');
    assert.equal(explanation.safeToInherit, false);
    assert.ok(explanation.reasons.includes('claim_conflict_detected'));
    assert.equal(explanation.conflicts.length, 1);
    assert.equal(explanation.conflicts[0].claimId, 'good_life.open_problems.one');
    assert.equal(explanation.recommendedAction, 'write_reconciliation_receipt');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TrustKernel lets user corrections outrank inherited assumptions without erasing the conflict', () => {
  const { dir, kernel } = tempKernel();
  try {
    const inherited = {
      type: 'bridge.state',
      subject: 'pressure-bridge',
      predicate: 'freshness',
      value: 'stale',
      actor: 'jerry',
      observedAt: '2026-05-08T12:00:00.000Z',
      scope: 'autonomous_action',
      privacyClass: 'operational_internal',
      freshnessTTL: 60 * 60 * 1000,
      authority: 'inherited_assumption',
      actionPosture: 'do_not_broaden',
    };
    kernel.recordClaim({
      ...inherited,
      id: 'pressure.freshness.inherited-stale',
      status: 'durable_memory',
    });
    kernel.recordVerifiedClaim({
      claim: {
        ...inherited,
        id: 'pressure.freshness.user-current',
        value: 'current',
        actor: 'jtr',
        authority: 'user_correction',
        actionPosture: 'inherit_for_subject_only',
      },
      receipt: passReceipt('pressure/freshness-user-correction'),
      receiptPath: join(dir, 'pressure.evidence.json'),
    });

    const correction = kernel.explain('pressure.freshness.user-current', {
      now: '2026-05-08T12:10:00.000Z',
    });
    const oldAssumption = kernel.explain('pressure.freshness.inherited-stale', {
      now: '2026-05-08T12:10:00.000Z',
    });

    assert.equal(correction.status, 'known_verified');
    assert.equal(correction.safeToInherit, true);
    assert.equal(correction.claim.authority, 'user_correction');
    assert.equal(correction.claim.actionPosture, 'inherit_for_subject_only');
    assert.equal(correction.conflicts[0].claimId, 'pressure.freshness.inherited-stale');
    assert.equal(correction.conflicts[0].resolution, 'current_claim_overrides_lower_authority');
    assert.equal(oldAssumption.status, 'known_conflicted');
    assert.equal(oldAssumption.safeToInherit, false);
    assert.equal(oldAssumption.conflicts[0].resolution, 'higher_authority_claim_overrides_current');
    assert.equal(oldAssumption.recommendedAction, 'accept_higher_authority_correction');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TrustKernel blocks analogy claims that lack structural hypothesis discipline', () => {
  const { dir, kernel } = tempKernel();
  try {
    kernel.recordClaim({
      id: 'analogy.house.low-pass-filter',
      type: 'analogy_hypothesis',
      subject: 'house-as-low-pass-filter',
      predicate: 'structural_correspondence',
      value: true,
      actor: 'jerry',
      observedAt: '2026-05-11T16:00:00.000Z',
      scope: 'autonomous_action',
      privacyClass: 'operational_internal',
      status: 'candidate_claim',
      analogy: {
        sourceDomain: 'electronic low-pass filter',
        targetDomain: 'house pressure envelope',
      },
    });

    const explanation = kernel.explain('analogy.house.low-pass-filter', {
      now: '2026-05-11T16:01:00.000Z',
    });

    assert.equal(explanation.safeToInherit, false);
    assert.ok(explanation.reasons.includes('analogy_requires_structural_mapping'));
    assert.ok(explanation.reasons.includes('analogy_requires_mechanism'));
    assert.ok(explanation.reasons.includes('analogy_requires_falsifiable_predictions'));
    assert.equal(explanation.recommendedAction, 'refine_analogy_hypothesis');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TrustKernel can inherit verified analogy hypotheses with mapping, mechanism, and predictions', () => {
  const { dir, kernel } = tempKernel();
  try {
    kernel.recordVerifiedClaim({
      claim: {
        id: 'analogy.house.low-pass-filter',
        type: 'analogy_hypothesis',
        subject: 'house-as-low-pass-filter',
        predicate: 'structural_correspondence',
        value: true,
        actor: 'jerry',
        observedAt: '2026-05-11T16:00:00.000Z',
        scope: 'autonomous_action',
        privacyClass: 'operational_internal',
        analogy: {
          sourceDomain: 'electronic low-pass filter',
          targetDomain: 'house pressure envelope',
          structuralMapping: [
            { source: 'attenuates high-frequency signal', target: 'damps rapid pressure fluctuations' },
          ],
          mechanism: 'building envelope air exchange delays rapid outside pressure changes',
          falsifiablePredictions: [
            'rapid outside pressure changes should appear damped or delayed in the indoor pressure log',
          ],
        },
      },
      receipt: passReceipt('analogy/house-low-pass-filter'),
      receiptPath: join(dir, 'analogy.evidence.json'),
    });

    const explanation = kernel.explain('analogy.house.low-pass-filter', {
      now: '2026-05-11T16:01:00.000Z',
    });

    assert.equal(explanation.status, 'known_verified');
    assert.equal(explanation.safeToInherit, true);
    assert.deepEqual(explanation.claim.sourceIssues, undefined);
    assert.equal(explanation.claim.analogy.falsifiablePredictions.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
