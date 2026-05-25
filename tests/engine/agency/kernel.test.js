import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgencyKernel } from '../../../engine/src/agency/resident-kernel.js';
import { AuthorityPolicy } from '../../../engine/src/agency/authority-policy.js';

function readJsonl(path) {
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

function brainDir() {
  const dir = mkdtempSync(join(tmpdir(), 'home23-agency-'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('AgencyKernel dry-run intake selects actionable observations into pursuits with receipts', async () => {
  const dir = brainDir();
  const kernel = new AgencyKernel({
    brainDir: dir,
    agentName: 'jerry',
    config: { enabled: true, mode: 'dry_run' },
  });

  const result = await kernel.intake({
    source: 'work.worker-runs',
    kind: 'worker_receipt',
    summary: 'Systems worker found stale dashboard publish loop and recommends a bounded verifier.',
    evidence: [{ type: 'worker_receipt', ref: 'wr_1' }],
    authorityLevel: 'L2',
    desiredChangedFuture: 'Dashboard publish loop has a current verifier receipt.',
    verifier: { type: 'worker_receipt', ref: 'wr_1' },
    tags: ['dashboard', 'worker'],
  });

  assert.equal(result.decision.route, 'pursue');
  assert.equal(result.pursuit.status, 'active');
  assert.equal(result.pursuit.authorityLevel, 'L2');
  assert.equal(result.pursuit.stopCondition, 'Dashboard publish loop has a current verifier receipt.');

  const agencyDir = join(dir, 'agency');
  const inbox = readJsonl(join(agencyDir, 'inbox.jsonl'));
  const pursuits = readJsonl(join(agencyDir, 'pursuits.jsonl'));
  const receipts = readJsonl(join(agencyDir, 'receipts.jsonl'));
  const state = JSON.parse(readFileSync(join(agencyDir, 'state.json'), 'utf8'));

  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].decision.route, 'pursue');
  assert.equal(pursuits.some(row => row.type === 'created' && row.pursuit.id === result.pursuit.id), true);
  assert.equal(receipts.some(row => row.event === 'selected' && row.pursuitId === result.pursuit.id), true);
  assert.equal(state.agent, 'jerry');
  assert.equal(state.mode, 'dry_run');
  assert.equal(state.attention.currentPursuitId, result.pursuit.id);
});

test('AgencyKernel dedupes repeated Good Life usefulness drift into one pursuit', async () => {
  const dir = brainDir();
  const kernel = new AgencyKernel({
    brainDir: dir,
    agentName: 'jerry',
    config: { enabled: true, mode: 'dry_run' },
  });

  const first = await kernel.intake({
    source: 'domain.good-life',
    kind: 'good_life_policy',
    summary: 'Diagnose Good Life usefulness drift; route one bounded Home23 action.',
    evidence: [{ type: 'good-life', ref: '2026-05-25T10:00:00.000Z' }],
    authorityLevel: 'L2',
    tags: ['good-life', 'usefulness'],
  });
  const second = await kernel.intake({
    source: 'domain.good-life',
    kind: 'good_life_policy',
    summary: 'Diagnose Good Life usefulness drift; route one bounded Home23 action.',
    evidence: [{ type: 'good-life', ref: '2026-05-25T10:05:00.000Z' }],
    authorityLevel: 'L2',
    tags: ['good-life', 'usefulness'],
  });

  assert.equal(first.pursuit.id, second.pursuit.id);
  assert.equal(second.decision.route, 'pursue');
  assert.equal(second.decision.reason, 'merged_with_existing_pursuit');
  assert.equal(second.pursuit.seenCount, 2);
});

test('AgencyKernel dedupes repeated Step24 observations by channel instead of metric text', async () => {
  const dir = brainDir();
  const kernel = new AgencyKernel({
    brainDir: dir,
    agentName: 'jerry',
    config: { enabled: true, mode: 'dry_run' },
  });

  const first = await kernel.handleObservation({
    channelId: 'machine.memory',
    traceId: 'trace:first',
    payload: { freePct: 2.5, at: '2026-05-25T10:00:00.000Z' },
  });
  const second = await kernel.handleObservation({
    channelId: 'machine.memory',
    traceId: 'trace:second',
    payload: { freePct: 1.8, at: '2026-05-25T10:05:00.000Z' },
  });

  assert.equal(first.pursuit.id, second.pursuit.id);
  assert.equal(first.pursuit.status, 'watch');
  assert.equal(second.decision.reason, 'merged_with_existing_pursuit');
  assert.equal(second.pursuit.seenCount, 2);
});

test('AuthorityPolicy blocks L4 actions without explicit approval even in live mode', () => {
  const policy = new AuthorityPolicy({ mode: 'live' });

  assert.deepEqual(policy.evaluate({ authorityLevel: 'L2', action: 'worker_run' }), {
    allowed: true,
    level: 'L2',
    reason: 'live_low_risk_allowed',
  });
  assert.deepEqual(policy.evaluate({ authorityLevel: 'L4', action: 'pm2_restart' }), {
    allowed: false,
    level: 'L4',
    reason: 'requires_human_approval',
  });
});

test('AgencyKernel loads a charter and enforces active/watch attention caps', async () => {
  const dir = brainDir();
  const charterPath = join(dir, 'agency-charter.yaml');
  writeFileSync(charterPath, [
    'attention:',
    '  maxActivePursuits: 2',
    '  maxWatchItems: 1',
    'bootcamp:',
    '  enabled: true',
    '',
  ].join('\n'));
  const kernel = new AgencyKernel({
    brainDir: dir,
    agentName: 'jerry',
    charterPath,
    config: { enabled: true, mode: 'dry_run' },
  });

  await kernel.intake({
    source: 'x.timeline',
    kind: 'timeline_report',
    summary: 'Agent agency evidence should be pursued from the X timeline.',
    evidence: [{ type: 'telegram', ref: 'msg-1' }],
    desiredChangedFuture: 'Jerry follows the agent agency signal instead of just reporting it.',
  });
  await kernel.intake({
    source: 'work.worker-runs',
    kind: 'worker_receipt',
    summary: 'Worker found a stale dashboard contract that should be repaired.',
    evidence: [{ type: 'worker_receipt', ref: 'wr-1' }],
  });
  const third = await kernel.intake({
    source: 'curriculum',
    kind: 'digestion',
    summary: 'Curriculum digestion proposes a recovery posture update.',
    evidence: [{ type: 'artifact', ref: 'curriculum-1' }],
  });
  await kernel.intake({
    source: 'research',
    kind: 'research_summary',
    summary: 'Interesting research with no immediate changed future.',
    evidence: [{ type: 'research', ref: 'r-1' }],
    tags: ['research'],
  });
  await kernel.intake({
    source: 'telegram',
    kind: 'link',
    summary: 'Another maybe useful link with no consequence yet.',
    evidence: [{ type: 'telegram', ref: 'msg-2' }],
  });

  assert.equal(third.decision.route, 'defer');
  assert.equal(third.decision.reason, 'active_attention_budget_exhausted');

  const state = kernel.state();
  assert.equal(state.charter.attention.maxActivePursuits, 2);
  assert.equal(state.bootcamp.enabled, true);
  assert.equal(state.attention.activePursuits, 2);
  assert.equal(state.attention.watchItems, 1);
  assert.equal(state.attention.deferredItems >= 1, true);
});

test('AgencyKernel exposes the body organ contract in canonical state', async () => {
  const dir = brainDir();
  const kernel = new AgencyKernel({
    brainDir: dir,
    agentName: 'jerry',
    config: { enabled: true, mode: 'dry_run' },
  });

  const state = kernel.state();
  const organs = state.organs || {};

  assert.equal(organs.crons.kind, 'scheduler');
  assert.equal(organs.crons.canSense.includes('cron reports'), true);
  assert.equal(organs.crons.canChange.includes('bounded schedules'), true);
  assert.equal(organs.crons.mustNeverDoAlone.includes('create recurring work without pursuit binding'), true);
  assert.equal(organs.workers.failureSurface, 'worker receipts and agency consequences');
  assert.match(organs.chat.commandSurface, /agency tools/);
});

test('AgencyKernel builds the live success-test brief from resident state', async () => {
  const dir = brainDir();
  const kernel = new AgencyKernel({
    brainDir: dir,
    agentName: 'jerry',
    config: { enabled: true, mode: 'dry_run' },
  });

  const active = await kernel.intake({
    source: 'work.worker-runs',
    kind: 'worker_receipt',
    summary: 'Repair agency dashboard receipt chain.',
    evidence: [{ type: 'worker_receipt', ref: 'wr-active' }],
    authorityLevel: 'L2',
    desiredChangedFuture: 'Agency dashboard shows consequence receipts.',
  });
  await kernel.intake({
    source: 'research',
    kind: 'research_summary',
    summary: 'Watch agent agency interface patterns.',
    evidence: [{ type: 'research', ref: 'research-watch' }],
    tags: ['research'],
  });
  kernel.recordConsequence({
    at: '2026-05-25T21:00:00.000Z',
    pursuitId: active.pursuit.id,
    status: 'applied',
    changeType: 'dashboard_contract_changed',
    summary: 'Agency dashboard now shows body organs.',
    evidence: [{ type: 'file', ref: 'home23-dashboard.js' }],
  });
  await kernel.intake({
    source: 'chat',
    kind: 'operator_request',
    summary: 'Publish public From The Inside issue.',
    evidence: [{ type: 'chat', ref: 'msg-1' }],
    authorityLevel: 'L4',
    desiredChangedFuture: 'Public issue is published.',
  });
  const tick = await kernel.tick({ reason: 'test-brief', now: '2026-05-25T21:05:00.000Z' });

  const brief = kernel.brief();

  assert.equal(brief.schema, 'home23.agency.brief.v1');
  assert.equal(brief.questions.whatFollowing.length > 0, true);
  assert.equal(brief.questions.whatFollowing.some(item => item.id === active.pursuit.id), true);
  assert.equal(brief.questions.whatChanged[0].changeType, 'dashboard_contract_changed');
  assert.equal(brief.questions.whatDoingNext.kind, tick.nextAction.kind);
  assert.equal(brief.questions.whatNeedFromJtr.some(item => item.authorityLevel === 'L4'), true);
  assert.match(brief.text, /What we are following/);
  assert.match(brief.text, /What changed/);
  assert.match(brief.text, /What I need from jtr/);
});

test('AgencyKernel resident tick advances one pursuit and records scratch, editor, and consequence receipts', async () => {
  const dir = brainDir();
  const kernel = new AgencyKernel({
    brainDir: dir,
    agentName: 'jerry',
    config: { enabled: true, mode: 'dry_run', charter: { attention: { maxActivePursuits: 5, maxWatchItems: 20 } } },
  });

  const intake = await kernel.intake({
    source: 'newsletter',
    kind: 'newsletter_draft',
    summary: 'This newsletter repeats that Home23 becomes real by noticing feedback loops.',
    evidence: [{ type: 'draft', ref: 'from-the-inside-thermal' }],
    desiredChangedFuture: 'Newsletter must cite lived system change or be rejected.',
  });
  const tick = await kernel.tick({ reason: 'test-resident-tick', now: '2026-05-25T15:00:00.000Z' });

  assert.equal(tick.selected.pursuitId, intake.pursuit.id);
  assert.equal(tick.editor.verdict, 'veto');
  assert.equal(tick.nextAction.kind, 'require_consequence');
  assert.equal(tick.state.nextAction.kind, 'require_consequence');

  const agencyDir = join(dir, 'agency');
  assert.equal(existsSync(join(agencyDir, 'scratch.jsonl')), true);
  assert.equal(existsSync(join(agencyDir, 'truth.jsonl')), true);
  const scratch = readJsonl(join(agencyDir, 'scratch.jsonl'));
  const consequences = readJsonl(join(agencyDir, 'consequences.jsonl'));
  const receipts = readJsonl(join(agencyDir, 'receipts.jsonl'));
  assert.equal(scratch.some(row => row.kind === 'resident_tick'), true);
  assert.equal(consequences.some(row => row.changeType === 'explicit_no_change' && row.pursuitId === intake.pursuit.id), true);
  assert.equal(receipts.some(row => row.event === 'resident_tick' && row.pursuitId === intake.pursuit.id), true);
});

test('AgencyKernel world-stream intake creates explicit discard/no-change receipts instead of silent delivery', async () => {
  const dir = brainDir();
  const kernel = new AgencyKernel({
    brainDir: dir,
    agentName: 'jerry',
    config: { enabled: true, mode: 'dry_run' },
  });

  const result = await kernel.intakeWorldStream({
    source: 'x.timeline',
    kind: 'timeline_report',
    summary: 'Ten generic agent hype posts with no new mechanism and no Home23 implication.',
    seen: ['post-1', 'post-2'],
    discarded: [{ ref: 'post-1', reason: 'generic hype' }],
    explicitNoChange: true,
  });

  assert.equal(result.decision.route, 'discard');
  assert.equal(result.receipt.event, 'world_stream_assimilated');
  assert.equal(result.receipt.outcome, 'explicit_no_change');
  assert.equal(result.receipt.seen.length, 2);

  const consequences = readJsonl(join(dir, 'agency', 'consequences.jsonl'));
  assert.equal(consequences.some(row => row.changeType === 'explicit_no_change'), true);
});

test('AgencyKernel turns world-stream operator corrections into durable truth claims', async () => {
  const dir = brainDir();
  const kernel = new AgencyKernel({
    brainDir: dir,
    agentName: 'jerry',
    config: { enabled: true, mode: 'dry_run' },
  });

  const generated = kernel.recordClaim({
    id: 'claim_old_frame',
    claim: 'The old newsletter feedback-loop frame is still useful.',
    sourceType: 'generated_doctrine',
    sourceRef: 'newsletter-draft',
  });
  const result = await kernel.intakeWorldStream({
    source: 'telegram.message',
    kind: 'operator_correction',
    summary: 'Correction: the old newsletter feedback-loop frame is exhausted unless it cites lived system change.',
    seen: ['Correction: the old newsletter feedback-loop frame is exhausted unless it cites lived system change.'],
    claim: {
      claim: 'The old newsletter feedback-loop frame is exhausted unless it cites lived system change.',
      sourceType: 'jtr_correction',
      sourceRef: 'telegram:123:99',
      contradicts: generated.id,
    },
    evidence: [{ type: 'message', ref: 'telegram:123:99' }],
    tags: ['world-stream', 'conversation', 'correction'],
  });

  const state = kernel.state();
  const truthRows = readJsonl(join(dir, 'agency', 'truth.jsonl'));
  const receipts = readJsonl(join(dir, 'agency', 'receipts.jsonl'));
  const consequences = readJsonl(join(dir, 'agency', 'consequences.jsonl'));

  assert.equal(result.decision.route, 'claim');
  assert.equal(result.receipt.outcome, 'durable_claim');
  assert.equal(result.claim.sourceType, 'jtr_correction');
  assert.equal(state.truth.supersededClaims, 1);
  assert.equal(truthRows.some(row => row.id === generated.id && row.status === 'superseded'), true);
  assert.equal(receipts.some(row => row.event === 'world_stream_assimilated' && row.outcome === 'durable_claim'), true);
  assert.equal(consequences.some(row => row.changeType === 'belief_updated' && row.status === 'claim_recorded'), true);
});

test('AgencyKernel source-of-truth hierarchy keeps jtr correction above generated doctrine', async () => {
  const dir = brainDir();
  const kernel = new AgencyKernel({
    brainDir: dir,
    agentName: 'jerry',
    config: { enabled: true, mode: 'dry_run' },
  });

  const generated = kernel.recordClaim({
    claim: 'Newsletter feedback-loop skeleton is acceptable.',
    sourceType: 'generated_doctrine',
    sourceRef: 'newsletter-policy',
  });
  const correction = kernel.recordClaim({
    claim: 'Newsletter feedback-loop skeleton is exhausted and should be vetoed.',
    sourceType: 'jtr_correction',
    sourceRef: 'evolve.md',
    contradicts: generated.id,
  });
  const state = kernel.state();

  assert.equal(correction.authorityRank < generated.authorityRank, true);
  assert.equal(state.truth.unresolvedContradictions, 0);
  assert.equal(state.truth.supersededClaims, 1);
  assert.equal(state.truth.currentSourceHierarchy[0], 'current_verified_state');
});

test('AgencyKernel demotes lower-authority claims when higher-authority corrections arrive', async () => {
  const dir = brainDir();
  const kernel = new AgencyKernel({
    brainDir: dir,
    agentName: 'jerry',
    config: { enabled: true, mode: 'dry_run' },
  });

  const generated = kernel.recordClaim({
    id: 'claim_newsletter_ok',
    claim: 'Repeating the feedback-loop newsletter frame is still useful.',
    sourceType: 'generated_doctrine',
    sourceRef: 'newsletter-draft',
    at: '2026-05-24T10:00:00.000Z',
  });
  const correction = kernel.recordClaim({
    id: 'claim_newsletter_exhausted',
    claim: 'Repeating the feedback-loop newsletter frame is exhausted and should be rejected unless it cites lived change.',
    sourceType: 'jtr_correction',
    sourceRef: 'evolve.md',
    contradicts: generated.id,
    at: '2026-05-25T10:00:00.000Z',
  });
  const state = kernel.state();
  const truthRows = readJsonl(join(dir, 'agency', 'truth.jsonl'));
  const receipts = readJsonl(join(dir, 'agency', 'receipts.jsonl'));

  assert.equal(correction.status, 'current');
  assert.equal(state.truth.unresolvedContradictions, 0);
  assert.equal(state.truth.supersededClaims, 1);
  assert.equal(state.truth.currentClaims.some(row => row.id === correction.id), true);
  assert.equal(state.truth.currentClaims.some(row => row.id === generated.id), false);
  assert.equal(truthRows.some(row => row.id === generated.id && row.status === 'superseded' && row.supersededBy === correction.id), true);
  assert.equal(receipts.some(row => row.event === 'truth_claim_superseded' && row.claimId === generated.id && row.supersededBy === correction.id), true);
});

test('AgencyKernel keeps lower-authority contradictions unresolved against verified state', async () => {
  const dir = brainDir();
  const kernel = new AgencyKernel({
    brainDir: dir,
    agentName: 'jerry',
    config: { enabled: true, mode: 'dry_run' },
  });

  const verified = kernel.recordClaim({
    id: 'claim_current_route',
    claim: 'The agency brief API is live at /api/agency/brief.',
    sourceType: 'current_verified_state',
    sourceRef: 'curl:/api/agency/brief',
    at: '2026-05-25T11:00:00.000Z',
  });
  const rumor = kernel.recordClaim({
    id: 'claim_route_missing',
    claim: 'The agency brief API does not exist.',
    sourceType: 'narrative',
    sourceRef: 'old-summary',
    contradicts: verified.id,
    at: '2026-05-25T11:05:00.000Z',
  });
  const state = kernel.state();
  const truthRows = readJsonl(join(dir, 'agency', 'truth.jsonl'));

  assert.equal(rumor.status, 'contested');
  assert.equal(state.truth.unresolvedContradictions, 1);
  assert.equal(state.openContradictions.some(row => row.id === rumor.id), true);
  assert.equal(state.truth.currentClaims.some(row => row.id === verified.id), true);
  assert.equal(truthRows.some(row => row.id === verified.id && row.status === 'superseded'), false);
});

test('AgencyKernel decays stale truth claims out of current state projection', async () => {
  const dir = brainDir();
  const kernel = new AgencyKernel({
    brainDir: dir,
    agentName: 'jerry',
    config: { enabled: true, mode: 'dry_run' },
  });

  const stale = kernel.recordClaim({
    id: 'claim_old_newsletter_contract',
    claim: 'The newsletter can use the old feedback-loop frame.',
    sourceType: 'generated_doctrine',
    sourceRef: 'old-newsletter-policy',
    at: '2026-05-01T10:00:00.000Z',
    decay: { staleAt: '2026-05-02T10:00:00.000Z', reason: 'old generated doctrine expired' },
  });
  const current = kernel.recordClaim({
    id: 'claim_current_brief_contract',
    claim: 'The resident brief must answer what is followed, changed, next, and needed.',
    sourceType: 'current_verified_state',
    sourceRef: 'curl:/api/agency/brief',
    at: '2026-05-25T10:00:00.000Z',
  });
  const state = kernel.state();

  assert.equal(stale.status, 'current');
  assert.equal(state.truth.staleClaims, 1);
  assert.equal(state.truth.currentClaims.some(row => row.id === stale.id), false);
  assert.equal(state.truth.currentClaims.some(row => row.id === current.id), true);
  assert.equal(state.truth.staleClaimRefs.some(row => row.id === stale.id && row.decayReason === 'old generated doctrine expired'), true);
});

test('AgencyKernel reconciles preexisting pursuit overflow down to charter caps', async () => {
  const dir = brainDir();
  const kernel = new AgencyKernel({
    brainDir: dir,
    agentName: 'jerry',
    config: { enabled: true, mode: 'dry_run', charter: { attention: { maxActivePursuits: 1, maxWatchItems: 1 } } },
  });

  await kernel.intake({
    source: 'work.worker-runs',
    kind: 'worker_receipt',
    summary: 'First active repair thread.',
    evidence: [{ type: 'worker_receipt', ref: 'wr-1' }],
  });
  const second = await kernel.intake({
    source: 'work.live-problems',
    kind: 'live_problem',
    summary: 'Second active repair thread.',
    evidence: [{ type: 'live_problem', ref: 'lp-1' }],
  });
  kernel.store.updatePursuit(second.pursuit.id, { status: 'active' }, { type: 'test_force_overflow', reason: 'simulate preexisting overflow' });

  const state = kernel.state();

  assert.equal(state.attention.activePursuits, 1);
  assert.equal(state.attention.deferredItems, 1);
  const statuses = [kernel.pursuit(second.pursuit.id).status, ...kernel.pursuits({ status: 'deferred' }).map(row => row.status)];
  assert.equal(statuses.includes('deferred'), true);
});

test('AgencyKernel arbitrates behavioral deltas through bounded authority', async () => {
  const dir = brainDir();
  const kernel = new AgencyKernel({
    brainDir: dir,
    agentName: 'jerry',
    config: { enabled: true, mode: 'dry_run' },
  });

  const lowRisk = kernel.proposeDelta({
    changeType: 'watch_item_created',
    summary: 'Create a watch item for agent agency product news.',
    authorityLevel: 'L1',
    reversible: true,
  });
  const highRisk = kernel.proposeDelta({
    changeType: 'public_publication_or_posting',
    summary: 'Publish the newsletter publicly.',
    authorityLevel: 'L4',
    reversible: false,
  });

  assert.equal(lowRisk.decision.route, 'approved_dry_run');
  assert.equal(lowRisk.authority.allowed, false);
  assert.equal(lowRisk.authority.reason, 'dry_run_records_intent_only');
  assert.equal(highRisk.decision.route, 'requires_approval');
  assert.equal(highRisk.authority.level, 'L4');

  const consequences = readJsonl(join(dir, 'agency', 'consequences.jsonl'));
  assert.equal(consequences.some(row => row.changeType === 'watch_item_created' && row.status === 'approved_dry_run'), true);
  assert.equal(consequences.some(row => row.changeType === 'public_publication_or_posting' && row.status === 'requires_approval'), true);
});

test('AgencyKernel editor kill verdict demotes stale watch threads with receipts', async () => {
  const dir = brainDir();
  const kernel = new AgencyKernel({
    brainDir: dir,
    agentName: 'jerry',
    config: { enabled: true, mode: 'dry_run' },
  });

  const intake = await kernel.intake({
    source: 'research',
    kind: 'research_summary',
    summary: 'Repeated research summary with no consequence.',
    evidence: [{ type: 'research', ref: 'r-1' }],
    tags: ['research'],
  });
  kernel.store.updatePursuit(intake.pursuit.id, { status: 'watch', seenCount: 21 }, {
    type: 'test_force_stale_watch',
    reason: 'simulate repeated watch loop',
  });

  const tick = await kernel.tick({ reason: 'test-kill-review', now: '2026-05-25T16:00:00.000Z' });
  const pursuit = kernel.pursuit(intake.pursuit.id);
  const receipts = readJsonl(join(dir, 'agency', 'receipts.jsonl'));
  const consequences = readJsonl(join(dir, 'agency', 'consequences.jsonl'));

  assert.equal(tick.editor.verdict, 'kill');
  assert.equal(tick.nextAction.kind, 'kill_stale_thread');
  assert.equal(pursuit.status, 'discarded');
  assert.equal(receipts.some(row => row.event === 'discarded' && row.reason === 'watch_item_repeated_without_consequence'), true);
  assert.equal(consequences.some(row => row.pursuitId === intake.pursuit.id && row.changeType === 'stale_thread_killed'), true);
});

test('AgencyKernel live low-risk watch deltas apply bounded resident state changes', async () => {
  const dir = brainDir();
  const kernel = new AgencyKernel({
    brainDir: dir,
    agentName: 'jerry',
    config: { enabled: true, mode: 'live' },
  });

  const result = kernel.proposeDelta({
    changeType: 'watch_item_created',
    summary: 'Watch agent agency product news for concrete Home23 implications.',
    authorityLevel: 'L1',
    reversible: true,
    source: 'delta-test',
    evidence: [{ type: 'manual_verification', ref: 'step28-live-watch-delta' }],
    desiredChangedFuture: 'Jerry maintains one watch item instead of losing the signal.',
    nextMove: 'review once during resident tick',
    tags: ['agency', 'watch'],
  });

  const watches = kernel.pursuits({ status: 'watch', limit: 10 });
  const receipts = readJsonl(join(dir, 'agency', 'receipts.jsonl'));
  const consequences = readJsonl(join(dir, 'agency', 'consequences.jsonl'));

  assert.equal(result.decision.route, 'approved_live');
  assert.equal(result.authority.allowed, true);
  assert.equal(result.applied?.kind, 'watch_item_created');
  assert.equal(watches.length, 1);
  assert.equal(watches[0].summary, 'Watch agent agency product news for concrete Home23 implications.');
  assert.equal(receipts.some(row => row.event === 'delta_applied' && row.changeType === 'watch_item_created'), true);
  assert.equal(consequences.some(row => row.status === 'applied' && row.changeType === 'watch_item_created'), true);
});

test('AgencyKernel closes pursuits when worker receipts prove the stop condition', async () => {
  const dir = brainDir();
  const kernel = new AgencyKernel({
    brainDir: dir,
    agentName: 'jerry',
    config: { enabled: true, mode: 'dry_run' },
  });

  const intake = await kernel.intake({
    source: 'work.worker-runs',
    kind: 'worker_receipt',
    summary: 'Repair dashboard agency receipt chain.',
    evidence: [{ type: 'worker_receipt', ref: 'wr-open' }],
    authorityLevel: 'L2',
    desiredChangedFuture: 'Dashboard agency receipt chain has a verifier-backed closure receipt.',
    stopCondition: 'Worker verifier returns ok and cites the changed file.',
  });

  const result = await kernel.intakeWorldStream({
    source: 'work.worker-runs',
    kind: 'worker_receipt',
    summary: 'Worker verifier passed and cites the changed dashboard file.',
    pursuitId: intake.pursuit.id,
    consequenceStatus: 'closed',
    changedFuture: 'Dashboard agency receipt chain now has verifier-backed closure.',
    evidence: [{ type: 'worker_receipt', ref: 'wr-close' }],
    desiredChangedFuture: 'Dashboard agency receipt chain has a verifier-backed closure receipt.',
    tags: ['worker', 'verifier'],
  });

  const closed = kernel.pursuit(intake.pursuit.id);
  const receipts = readJsonl(join(dir, 'agency', 'receipts.jsonl'));
  const consequences = readJsonl(join(dir, 'agency', 'consequences.jsonl'));

  assert.equal(result.decision.route, 'close');
  assert.equal(result.pursuit.id, intake.pursuit.id);
  assert.equal(closed.status, 'closed');
  assert.equal(receipts.some(row => row.event === 'closed' && row.pursuitId === intake.pursuit.id && row.reason === 'receipt_proved_stop_condition'), true);
  assert.equal(consequences.some(row => row.pursuitId === intake.pursuit.id && row.changeType === 'pursuit_closed_by_receipt'), true);
});

test('AgencyKernel attaches non-closing world-stream receipts to named pursuits', async () => {
  const dir = brainDir();
  const kernel = new AgencyKernel({
    brainDir: dir,
    agentName: 'jerry',
    config: { enabled: true, mode: 'dry_run' },
  });
  const intake = await kernel.intake({
    source: 'scheduler.cron.bootcamp',
    kind: 'cron_bootcamp_audit',
    summary: 'Recurring cron needs resident oversight.',
    evidence: [{ type: 'cron_job', ref: 'job-1' }],
    authorityLevel: 'L2',
    desiredChangedFuture: 'Recurring cron is accountable to resident pursuit.',
  });

  const result = await kernel.intakeWorldStream({
    source: 'cron.job-1',
    kind: 'cron_report',
    pursuitId: intake.pursuit.id,
    consequenceStatus: 'advanced',
    summary: 'Cron job-1 finished with status ok.',
    evidence: [{ type: 'cron_result', ref: 'job-1' }],
    tags: ['cron'],
  });

  const pursuit = kernel.pursuit(intake.pursuit.id);
  const receipts = readJsonl(join(dir, 'agency', 'receipts.jsonl'));
  const consequences = readJsonl(join(dir, 'agency', 'consequences.jsonl'));
  const pursuitRows = readJsonl(join(dir, 'agency', 'pursuits.jsonl')).filter(row => row.pursuit?.id === intake.pursuit.id);

  assert.equal(result.decision.route, 'attach');
  assert.equal(result.pursuit.id, intake.pursuit.id);
  assert.equal(pursuit.status, 'active');
  assert.deepEqual(pursuit.latestEvidence, [{ type: 'cron_result', ref: 'job-1' }]);
  assert.equal(receipts.some(row => row.event === 'pursuit_evidence_assimilated' && row.pursuitId === intake.pursuit.id), true);
  assert.equal(consequences.some(row => row.changeType === 'cron_report' && row.status === 'advanced'), true);
  assert.equal(pursuitRows.at(-1).type, 'world_stream_attached');
});

test('AgencyKernel bootcamp kill review demotes stale watch loops even while advancing an active pursuit', async () => {
  const dir = brainDir();
  const kernel = new AgencyKernel({
    brainDir: dir,
    agentName: 'jerry',
    config: { enabled: true, mode: 'dry_run' },
  });

  const active = await kernel.intake({
    source: 'work.worker-runs',
    kind: 'worker_receipt',
    summary: 'Active repair pursuit that should remain selected.',
    evidence: [{ type: 'worker_receipt', ref: 'wr-active' }],
    authorityLevel: 'L2',
    desiredChangedFuture: 'Active repair advances one step.',
  });
  const watch = await kernel.intake({
    source: 'research',
    kind: 'research_summary',
    summary: 'Repeated watch loop with no consequence should be killed.',
    evidence: [{ type: 'research', ref: 'watch-stale' }],
    tags: ['research'],
  });
  kernel.store.updatePursuit(watch.pursuit.id, { status: 'watch', seenCount: 21 }, {
    type: 'test_force_stale_watch',
    reason: 'simulate repeated watch loop behind active pursuit',
  });

  const tick = await kernel.tick({ reason: 'test-bootcamp-kill-review', now: '2026-05-25T17:00:00.000Z' });
  const stale = kernel.pursuit(watch.pursuit.id);
  const activeAfter = kernel.pursuit(active.pursuit.id);
  const receipts = readJsonl(join(dir, 'agency', 'receipts.jsonl'));
  const consequences = readJsonl(join(dir, 'agency', 'consequences.jsonl'));

  assert.equal(tick.selected.pursuitId, active.pursuit.id);
  assert.equal(activeAfter.status, 'active');
  assert.equal(stale.status, 'discarded');
  assert.equal(tick.killReview.killed.length, 1);
  assert.equal(tick.killReview.killed[0].pursuitId, watch.pursuit.id);
  assert.equal(receipts.some(row => row.event === 'kill_review' && row.pursuitId === watch.pursuit.id), true);
  assert.equal(consequences.some(row => row.pursuitId === watch.pursuit.id && row.changeType === 'stale_thread_killed'), true);
});

test('AgencyKernel records external consequences with receipts and meaningful-action state', async () => {
  const dir = brainDir();
  const kernel = new AgencyKernel({
    brainDir: dir,
    agentName: 'jerry',
    config: { enabled: true, mode: 'dry_run' },
  });
  const intake = await kernel.intake({
    source: 'scheduler.cron.bootcamp',
    kind: 'cron_bootcamp_audit',
    summary: 'Legacy recurring cron needs resident oversight.',
    evidence: [{ type: 'cron_job', ref: 'legacy-recurring' }],
    authorityLevel: 'L2',
    desiredChangedFuture: 'Legacy cron is bound to a resident pursuit.',
  });

  const result = kernel.recordConsequence({
    at: '2026-05-25T20:00:00.000Z',
    pursuitId: intake.pursuit.id,
    status: 'applied',
    changeType: 'cron_bound_to_pursuit',
    summary: 'Legacy recurring cron is now bound to resident pursuit ap_legacy.',
    evidence: [{ type: 'cron_job', ref: 'legacy-recurring' }],
  });

  const receipts = readJsonl(join(dir, 'agency', 'receipts.jsonl'));
  const consequences = readJsonl(join(dir, 'agency', 'consequences.jsonl'));
  const state = JSON.parse(readFileSync(join(dir, 'agency', 'state.json'), 'utf8'));

  assert.equal(result.changeType, 'cron_bound_to_pursuit');
  assert.equal(receipts.some(row => row.event === 'external_consequence' && row.pursuitId === intake.pursuit.id), true);
  assert.equal(consequences.some(row => row.changeType === 'cron_bound_to_pursuit' && row.status === 'applied'), true);
  assert.equal(state.lastMeaningfulActions[0].changeType, 'cron_bound_to_pursuit');
});
