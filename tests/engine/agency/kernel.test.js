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

test('AgencyKernel records low-signal Step24 machine observations as discard receipts instead of watch spam', async () => {
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

  assert.equal(first.decision.route, 'discard');
  assert.equal(second.decision.route, 'discard');
  assert.equal(first.pursuit, null);
  assert.equal(second.pursuit, null);
  assert.equal(kernel.state().attention.watchItems, 0);

  const receipts = readJsonl(join(dir, 'agency', 'receipts.jsonl'));
  assert.equal(receipts.filter(row => row.event === 'discarded' && row.reason === 'raw_observation_not_attention').length, 2);
});

test('AgencyKernel discards low-signal heartbeat observations instead of spending watch attention', async () => {
  const dir = brainDir();
  const kernel = new AgencyKernel({
    brainDir: dir,
    agentName: 'jerry',
    config: { enabled: true, mode: 'dry_run' },
  });

  const result = await kernel.handleObservation({
    channelId: 'work.heartbeat',
    traceId: 'trace:heartbeat',
    payload: { tick: 1, at: '2026-05-25T17:00:00.000Z' },
  });

  assert.equal(result.decision.route, 'discard');
  assert.equal(result.decision.reason, 'raw_observation_not_attention');
  assert.equal(result.pursuit, null);
  assert.equal(kernel.state().attention.activePursuits, 0);
  assert.equal(kernel.state().attention.watchItems, 0);

  const receipts = readJsonl(join(dir, 'agency', 'receipts.jsonl'));
  assert.equal(receipts.some(row => row.event === 'discarded' && row.reason === 'raw_observation_not_attention'), true);
});

test('AgencyKernel discards legacy raw observation pursuits during state reconciliation', async () => {
  const dir = brainDir();
  const kernel = new AgencyKernel({
    brainDir: dir,
    agentName: 'jerry',
    config: { enabled: true, mode: 'dry_run' },
  });
  const candidate = kernel.router.normalize({
    source: 'work.heartbeat',
    kind: 'observation',
    summary: '[work.heartbeat] {"tick":1,"at":"2026-05-25T17:00:00.000Z"}',
    evidence: [{ type: 'observation', ref: 'trace:heartbeat' }],
    authorityLevel: 'L2',
    tags: ['work.heartbeat'],
  });
  const legacy = kernel.store.createPursuit(candidate, {
    route: 'pursue',
    reason: 'legacy_raw_observation_selected_active',
  });

  const state = kernel.ensureState();
  const reconciled = kernel.pursuit(legacy.id);
  const receipts = readJsonl(join(dir, 'agency', 'receipts.jsonl'));

  assert.equal(reconciled.status, 'discarded');
  assert.equal(state.attention.activePursuits, 0);
  assert.equal(state.attention.watchItems, 0);
  assert.equal(receipts.some(row => row.event === 'discarded' && row.reason === 'raw_observation_not_attention'), true);
});

test('AgencyKernel discards legacy unbound mechanical cron watch rows during state reconciliation', async () => {
  const dir = brainDir();
  const kernel = new AgencyKernel({
    brainDir: dir,
    agentName: 'jerry',
    config: { enabled: true, mode: 'dry_run' },
  });
  const candidate = kernel.router.normalize({
    source: 'cron.agent-one-shot',
    kind: 'cron_report',
    summary: 'Cron agent-one-shot (exec) finished with status ok.',
    evidence: [{ type: 'cron_result', ref: 'agent-one-shot' }],
    authorityLevel: 'L1',
    tags: ['world-stream', 'cron'],
  });
  const legacy = kernel.store.createPursuit(candidate, {
    route: 'watch',
    reason: 'legacy_mechanical_cron_selected_watch',
  });

  const state = kernel.ensureState();
  const reconciled = kernel.pursuit(legacy.id);
  const receipts = readJsonl(join(dir, 'agency', 'receipts.jsonl'));

  assert.equal(reconciled.status, 'discarded');
  assert.equal(state.attention.watchItems, 0);
  assert.equal(receipts.some(row => row.event === 'discarded' && row.reason === 'mechanical_cron_no_change_not_attention'), true);
});

test('AgencyKernel tracks live-problem observations by problem id and closes on resolved verifier state', async () => {
  const dir = brainDir();
  const kernel = new AgencyKernel({
    brainDir: dir,
    agentName: 'jerry',
    config: { enabled: true, mode: 'dry_run' },
  });

  const opened = await kernel.handleObservation({
    channelId: 'work.live-problems',
    sourceRef: 'live-problem:lp-agency:2026-05-25T10:00:00.000Z',
    verifierId: 'live-problems:poll',
    payload: {
      id: 'lp-agency',
      state: 'open',
      claim: 'Agency dashboard receipt chain is missing verifier closure.',
      updatedAt: '2026-05-25T10:00:00.000Z',
      verifier: { type: 'http', args: { path: '/api/agency/state' } },
    },
  });
  const resolved = await kernel.handleObservation({
    channelId: 'work.live-problems',
    sourceRef: 'live-problem:lp-agency:2026-05-25T10:10:00.000Z',
    verifierId: 'live-problems:poll',
    payload: {
      id: 'lp-agency',
      state: 'resolved',
      claim: 'Agency dashboard receipt chain is missing verifier closure.',
      updatedAt: '2026-05-25T10:10:00.000Z',
      resolvedAt: '2026-05-25T10:10:00.000Z',
      lastResult: { ok: true, detail: 'agency state route returned truth projection' },
    },
  });

  const closed = kernel.pursuit(opened.pursuit.id);
  const receipts = readJsonl(join(dir, 'agency', 'receipts.jsonl'));
  const consequences = readJsonl(join(dir, 'agency', 'consequences.jsonl'));

  assert.equal(opened.pursuit.dedupeKey, 'live-problem:lp-agency');
  assert.equal(resolved.decision.route, 'close');
  assert.equal(resolved.pursuit.id, opened.pursuit.id);
  assert.equal(closed.status, 'closed');
  assert.equal(receipts.some(row => row.event === 'closed' && row.source === 'work.live-problems'), true);
  assert.equal(consequences.some(row => row.pursuitId === opened.pursuit.id && row.changeType === 'pursuit_closed_by_receipt'), true);
});

test('AgencyKernel treats resolved live-problem observations without an open pursuit as no-change evidence', async () => {
  const dir = brainDir();
  const kernel = new AgencyKernel({
    brainDir: dir,
    agentName: 'jerry',
    config: { enabled: true, mode: 'dry_run' },
  });

  const result = await kernel.handleObservation({
    channelId: 'work.live-problems',
    sourceRef: 'live-problem:already-resolved:2026-05-25T10:10:00.000Z',
    verifierId: 'live-problems:poll',
    payload: {
      id: 'already-resolved',
      state: 'resolved',
      claim: 'Already resolved verifier claim.',
      updatedAt: '2026-05-25T10:10:00.000Z',
      resolvedAt: '2026-05-25T10:10:00.000Z',
      lastResult: { ok: true, detail: 'verifier passed' },
    },
  });

  const receipts = readJsonl(join(dir, 'agency', 'receipts.jsonl'));
  const consequences = readJsonl(join(dir, 'agency', 'consequences.jsonl'));

  assert.equal(result.decision.route, 'discard');
  assert.equal(result.decision.reason, 'explicit_no_change');
  assert.equal(result.pursuit, null);
  assert.equal(kernel.state().attention.activePursuits, 0);
  assert.equal(receipts.some(row => row.event === 'world_stream_assimilated' && row.outcome === 'explicit_no_change'), true);
  assert.equal(consequences.some(row => row.changeType === 'explicit_no_change' && /already-resolved/.test(row.summary || '')), true);
});

test('AgencyKernel closes legacy active resolved live-problem pursuits during state reconciliation', async () => {
  const dir = brainDir();
  const kernel = new AgencyKernel({
    brainDir: dir,
    agentName: 'jerry',
    config: { enabled: true, mode: 'dry_run' },
  });
  const candidate = kernel.router.normalize({
    source: 'work.live-problems',
    kind: 'live_problem',
    dedupeKey: 'live-problem:legacy-resolved',
    summary: 'Legacy resolved live problem.',
    evidence: [{ type: 'live_problem', ref: 'live-problem:legacy-resolved', state: 'resolved' }],
    authorityLevel: 'L2',
    desiredChangedFuture: 'Live problem legacy-resolved is resolved with verifier evidence.',
    stopCondition: 'live-problem legacy-resolved state becomes resolved or unverifiable with receipt',
    tags: ['work.live-problems', 'live-problem', 'resolved'],
  });
  const legacy = kernel.store.createPursuit(candidate, {
    route: 'pursue',
    reason: 'legacy_resolved_live_problem_selected_active',
  });

  const state = kernel.ensureState();
  const reconciled = kernel.pursuit(legacy.id);
  const receipts = readJsonl(join(dir, 'agency', 'receipts.jsonl'));
  const consequences = readJsonl(join(dir, 'agency', 'consequences.jsonl'));

  assert.equal(reconciled.status, 'closed');
  assert.equal(state.attention.activePursuits, 0);
  assert.equal(receipts.some(row => row.event === 'closed' && row.reason === 'resolved_live_problem_verified'), true);
  assert.equal(consequences.some(row => row.pursuitId === legacy.id && row.changeType === 'pursuit_closed_by_receipt'), true);
});

test('AgencyKernel discards legacy resolved live-problem observation rows during state reconciliation', async () => {
  const dir = brainDir();
  const kernel = new AgencyKernel({
    brainDir: dir,
    agentName: 'jerry',
    config: { enabled: true, mode: 'dry_run' },
  });
  const candidate = kernel.router.normalize({
    source: 'work.live-problems',
    kind: 'observation',
    summary: '[work.live-problems] {"state":"resolved","id":"legacy-observation"}',
    evidence: [{ type: 'observation', ref: 'trace:legacy-resolved-live-problem' }],
    authorityLevel: 'L2',
    tags: ['work.live-problems'],
  });
  const legacy = kernel.store.createPursuit(candidate, {
    route: 'pursue',
    reason: 'legacy_resolved_live_problem_observation_selected_active',
  });

  const state = kernel.ensureState();
  const reconciled = kernel.pursuit(legacy.id);
  const receipts = readJsonl(join(dir, 'agency', 'receipts.jsonl'));

  assert.equal(reconciled.status, 'discarded');
  assert.equal(state.attention.activePursuits, 0);
  assert.equal(receipts.some(row => row.event === 'discarded' && row.reason === 'resolved_live_problem_observation_not_attention'), true);
});

test('AgencyKernel keeps separate live-problem pursuits for separate problem ids', async () => {
  const dir = brainDir();
  const kernel = new AgencyKernel({
    brainDir: dir,
    agentName: 'jerry',
    config: { enabled: true, mode: 'dry_run' },
  });

  const first = await kernel.handleObservation({
    channelId: 'work.live-problems',
    sourceRef: 'live-problem:lp-one:2026-05-25T10:00:00.000Z',
    payload: { id: 'lp-one', state: 'open', claim: 'First live problem.', updatedAt: '2026-05-25T10:00:00.000Z' },
  });
  const second = await kernel.handleObservation({
    channelId: 'work.live-problems',
    sourceRef: 'live-problem:lp-two:2026-05-25T10:01:00.000Z',
    payload: { id: 'lp-two', state: 'open', claim: 'Second live problem.', updatedAt: '2026-05-25T10:01:00.000Z' },
  });

  assert.notEqual(first.pursuit.id, second.pursuit.id);
  assert.equal(first.pursuit.dedupeKey, 'live-problem:lp-one');
  assert.equal(second.pursuit.dedupeKey, 'live-problem:lp-two');
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

test('AgencyKernel projects authority requests and blocked pursuits as active obligations in canonical state', async () => {
  const dir = brainDir();
  const kernel = new AgencyKernel({
    brainDir: dir,
    agentName: 'jerry',
    config: { enabled: true, mode: 'dry_run' },
  });

  const authority = await kernel.intake({
    source: 'chat',
    kind: 'operator_request',
    summary: 'Restart PM2 and publish public issue.',
    evidence: [{ type: 'chat', ref: 'msg-authority' }],
    authorityLevel: 'L4',
    desiredChangedFuture: 'Public issue is published after approval.',
  });
  const blocked = await kernel.intake({
    source: 'work.worker-runs',
    kind: 'worker_receipt',
    summary: 'Worker needs jtr decision about private calendar access.',
    evidence: [{ type: 'worker_receipt', ref: 'wr-blocked' }],
    authorityLevel: 'L3',
    desiredChangedFuture: 'Calendar access decision is made.',
  });
  kernel.transition(blocked.pursuit.id, {
    transition: 'blocked',
    reason: 'needs jtr taste/judgment before continuing',
  });

  const state = kernel.state();

  assert.equal(state.obligations.length, 2);
  assert.equal(state.obligations.some(item => item.kind === 'authority_request' && item.candidateId === authority.candidate.candidateId), true);
  assert.equal(state.obligations.some(item => item.kind === 'blocked_pursuit' && item.pursuitId === blocked.pursuit.id), true);
  assert.equal(state.obligations.every(item => item.status === 'open'), true);
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

test('AgencyKernel exposes cron retirement proposals as an operator evidence-chain inspector view', async () => {
  const dir = brainDir();
  const kernel = new AgencyKernel({
    brainDir: dir,
    agentName: 'jerry',
    config: { enabled: true, mode: 'dry_run' },
  });
  const intake = await kernel.intake({
    source: 'cron.bootcamp',
    kind: 'legacy_recurring_cron',
    summary: 'Recurring cron "Daily Field Report" must prove consequence or retire.',
    evidence: [{ type: 'cron_job', ref: 'field-report-daily', name: 'Daily Field Report' }],
    authorityLevel: 'L2',
    desiredChangedFuture: 'Daily Field Report either creates pursuit/watch/discard receipts or is retired.',
    tags: ['cron', 'agency-bootcamp'],
  });

  kernel.recordConsequence({
    pursuitId: intake.pursuit.id,
    status: 'proposed',
    changeType: 'cron_retirement_proposed',
    summary: 'Recurring cron "Daily Field Report" is proposed for retirement because it produced no consequence.',
    evidence: [
      { type: 'cron_job', ref: 'field-report-daily', name: 'Daily Field Report', schedule: '0 8 * * *' },
      { type: 'agency_pursuit', ref: intake.pursuit.id, status: 'closed', summary: intake.pursuit.summary },
      { type: 'cron_run_log_excerpt', ref: 'field-report-daily', status: 'ok', semanticStatus: 'unknown', responsePreview: 'Delivered Telegram report without agency packet.' },
    ],
  });

  const inspector = kernel.inspector({ filter: 'cron_retirement_proposals', limit: 10 });
  const proposal = inspector.filters.cronRetirementProposals.items[0];

  assert.equal(inspector.schema, 'home23.agency.inspector.v1');
  assert.equal(inspector.filter, 'cron_retirement_proposals');
  assert.equal(inspector.filters.cronRetirementProposals.count, 1);
  assert.equal(proposal.pursuitId, intake.pursuit.id);
  assert.equal(proposal.job.ref, 'field-report-daily');
  assert.equal(proposal.pursuit.ref, intake.pursuit.id);
  assert.equal(proposal.runEvidence[0].semanticStatus, 'unknown');
  assert.match(proposal.summary, /proposed for retirement/);
  assert.equal(proposal.evidenceChain.some(item => item.type === 'cron_run_log_excerpt'), true);
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

test('AgencyKernel fans structured report packets into child pursuits, claims, and discard receipts', async () => {
  const dir = brainDir();
  const kernel = new AgencyKernel({
    brainDir: dir,
    agentName: 'jerry',
    config: { enabled: true, mode: 'dry_run' },
  });

  const result = await kernel.intakeWorldStream({
    source: 'cron.x-timeline-evening',
    kind: 'timeline_report',
    summary: 'Timeline surfaced one concrete agency implementation signal.',
    seen: ['action 1: Bind report outputs to resident pursuits.'],
    actionWorthy: [{
      summary: 'Bind report outputs to resident pursuits.',
      desiredChangedFuture: 'Timeline report output becomes resident pursuit evidence instead of delivery-only content.',
      nextMove: 'implement structured report fan-out',
      evidenceRef: 'x-post-agent-agency',
    }],
    watchItems: [{
      summary: 'Watch repeated autonomy discourse for concrete implementation details.',
      nextMove: 'check for mechanisms, not vibe',
      evidenceRef: 'x-autonomy-watch',
    }],
    contradictions: [{
      claim: 'Delivery to Telegram is sufficient completion for timeline reports.',
      contradicts: 'claim_delivery_not_completion',
      sourceRef: 'legacy-report-contract',
    }],
    discarded: [{ ref: 'viral meta thread', reason: 'no durable Home23 action' }],
    desiredChangedFuture: 'Report digestion updates standing agency implementation pursuit.',
    nextMove: 'merge with Home23 agency spine pursuit',
    tags: ['world-stream', 'x-timeline', 'agency'],
  });

  const pursuits = kernel.pursuits({ limit: 20 });
  const active = pursuits.filter(row => row.status === 'active');
  const watch = pursuits.filter(row => row.status === 'watch');
  const receipts = readJsonl(join(dir, 'agency', 'receipts.jsonl'));
  const consequences = readJsonl(join(dir, 'agency', 'consequences.jsonl'));
  const truthRows = readJsonl(join(dir, 'agency', 'truth.jsonl'));

  assert.equal(result.decision.route, 'fanout');
  assert.equal(result.children.actionWorthy.length, 1);
  assert.equal(result.children.watchItems.length, 1);
  assert.equal(result.children.contradictions.length, 1);
  assert.equal(result.children.discarded.length, 1);
  assert.equal(active.some(row => row.summary === 'Bind report outputs to resident pursuits.'), true);
  assert.equal(watch.some(row => row.summary === 'Watch repeated autonomy discourse for concrete implementation details.'), true);
  assert.equal(truthRows.some(row => row.claim === 'Delivery to Telegram is sufficient completion for timeline reports.'), true);
  assert.equal(receipts.some(row => row.event === 'world_stream_child_selected' && row.route === 'pursue'), true);
  assert.equal(receipts.some(row => row.event === 'world_stream_child_selected' && row.route === 'watch'), true);
  assert.equal(receipts.some(row => row.event === 'world_stream_child_discarded' && row.reason === 'no durable Home23 action'), true);
  assert.equal(consequences.some(row => row.changeType === 'structured_report_fanout' && row.status === 'fanout'), true);
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

test('AgencyKernel live low-risk pursuit note deltas update existing pursuit theory and next move', async () => {
  const dir = brainDir();
  const kernel = new AgencyKernel({
    brainDir: dir,
    agentName: 'jerry',
    config: { enabled: true, mode: 'live' },
  });
  const intake = await kernel.intake({
    source: 'research',
    kind: 'research_summary',
    summary: 'Agent agency interfaces need resident consequence tracking.',
    authorityLevel: 'L2',
    evidence: [{ type: 'research', ref: 'brief-1' }],
    desiredChangedFuture: 'Agency interface research changes Jerry resident behavior.',
  });

  const result = kernel.proposeDelta({
    changeType: 'pursuit_note_added',
    pursuitId: intake.pursuit.id,
    summary: 'X timeline evidence suggests the next move is implementation, not another digest.',
    currentTheory: 'Agent agency research is useful only when it changes Home23 resident behavior.',
    nextMove: 'apply the smallest bounded engine change and verify a receipt',
    authorityLevel: 'L1',
    reversible: true,
    evidence: [{ type: 'research_note', ref: 'brief-2' }],
  });

  const pursuit = kernel.pursuit(intake.pursuit.id);
  const receipts = readJsonl(join(dir, 'agency', 'receipts.jsonl'));
  const consequences = readJsonl(join(dir, 'agency', 'consequences.jsonl'));

  assert.equal(result.decision.route, 'approved_live');
  assert.equal(result.applied?.kind, 'pursuit_note_added');
  assert.equal(result.applied?.pursuitId, intake.pursuit.id);
  assert.equal(pursuit.currentTheory, 'Agent agency research is useful only when it changes Home23 resident behavior.');
  assert.equal(pursuit.nextMove, 'apply the smallest bounded engine change and verify a receipt');
  assert.equal(pursuit.agencyNotes[0].summary, 'X timeline evidence suggests the next move is implementation, not another digest.');
  assert.equal(pursuit.latestEvidence[0].ref, 'brief-2');
  assert.equal(receipts.some(row => row.event === 'delta_applied' && row.changeType === 'pursuit_note_added'), true);
  assert.equal(consequences.some(row => row.status === 'applied' && row.changeType === 'pursuit_note_added'), true);
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

test('AgencyKernel closes cron bootcamp pursuits when binding consequence satisfies the stop condition', async () => {
  const dir = brainDir();
  const kernel = new AgencyKernel({
    brainDir: dir,
    agentName: 'jerry',
    config: { enabled: true, mode: 'dry_run' },
  });
  const intake = await kernel.intake({
    source: 'scheduler.cron.bootcamp',
    kind: 'cron_bootcamp_audit',
    summary: 'Recurring cron "Daily Field Report" is running without resident agency pursuit binding.',
    evidence: [{ type: 'cron_job', ref: 'field-report-daily', name: 'Daily Field Report' }],
    authorityLevel: 'L2',
    desiredChangedFuture: 'Recurring cron "Daily Field Report" is bound to a resident pursuit, demoted, or retired under agency bootcamp.',
    stopCondition: 'The cron is bound to a pursuit, demoted, or retired with a receipt.',
    tags: ['cron', 'agency-bootcamp', 'legacy-recurring-work'],
  });

  kernel.recordConsequence({
    at: '2026-05-25T21:20:00.000Z',
    source: 'scheduler.cron.bootcamp',
    pursuitId: intake.pursuit.id,
    status: 'applied',
    changeType: 'cron_bound_to_pursuit',
    summary: `Recurring cron "Daily Field Report" is now bound to resident pursuit ${intake.pursuit.id}.`,
    evidence: [{ type: 'cron_job', ref: 'field-report-daily', name: 'Daily Field Report' }],
  });

  const pursuit = kernel.pursuit(intake.pursuit.id);
  const consequences = readJsonl(join(dir, 'agency', 'consequences.jsonl'));
  const receipts = readJsonl(join(dir, 'agency', 'receipts.jsonl'));

  assert.equal(pursuit.status, 'closed');
  assert.equal(kernel.state().attention.activePursuits, 0);
  assert.equal(receipts.some(row => row.event === 'closed' && row.reason === 'cron_bootcamp_stop_condition_satisfied'), true);
  assert.equal(consequences.some(row => row.pursuitId === intake.pursuit.id && row.changeType === 'pursuit_closed_by_receipt'), true);
});

test('AgencyKernel reconciles legacy cron bootcamp pursuits already bound by consequence receipts', async () => {
  const dir = brainDir();
  const kernel = new AgencyKernel({
    brainDir: dir,
    agentName: 'jerry',
    config: { enabled: true, mode: 'dry_run' },
  });
  const candidate = kernel.router.normalize({
    source: 'scheduler.cron.bootcamp',
    kind: 'cron_bootcamp_audit',
    summary: 'Recurring cron "Ticker" is running without resident agency pursuit binding.',
    evidence: [{ type: 'cron_job', ref: 'ticker', name: 'Ticker' }],
    authorityLevel: 'L2',
    desiredChangedFuture: 'Recurring cron "Ticker" is bound to a resident pursuit, demoted, or retired under agency bootcamp.',
    stopCondition: 'The cron is bound to a pursuit, demoted, or retired with a receipt.',
    tags: ['cron', 'agency-bootcamp', 'legacy-recurring-work'],
  });
  const legacy = kernel.store.createPursuit(candidate, {
    route: 'pursue',
    reason: 'legacy_bootcamp_audit_selected_active',
  });
  kernel.store.appendConsequence({
    schema: 'home23.agency.consequence.v1',
    at: '2026-05-25T21:21:00.000Z',
    pursuitId: legacy.id,
    status: 'applied',
    changeType: 'cron_bound_to_pursuit',
    summary: `Recurring cron "Ticker" is now bound to resident pursuit ${legacy.id}.`,
    evidence: [{ type: 'cron_job', ref: 'ticker', name: 'Ticker' }],
  });

  const state = kernel.ensureState();
  const pursuit = kernel.pursuit(legacy.id);
  const receipts = readJsonl(join(dir, 'agency', 'receipts.jsonl'));

  assert.equal(pursuit.status, 'closed');
  assert.equal(state.attention.activePursuits, 0);
  assert.equal(receipts.some(row => row.event === 'closed' && row.reason === 'cron_bootcamp_stop_condition_satisfied'), true);
});

test('AgencyKernel caps pursuit history snapshots so startup review cannot inflate the ledger', async () => {
  const dir = brainDir();
  const kernel = new AgencyKernel({
    brainDir: dir,
    agentName: 'jerry',
    config: { enabled: true, mode: 'dry_run' },
  });
  const intake = await kernel.intake({
    source: 'scheduler.cron.bootcamp',
    kind: 'cron_bootcamp_audit',
    summary: 'Recurring cron should stay accountable without inflating pursuit history.',
    evidence: [{ type: 'cron_job', ref: 'job-history' }],
    authorityLevel: 'L2',
    desiredChangedFuture: 'Startup agency review remains bounded.',
  });

  for (let i = 0; i < 40; i += 1) {
    kernel.transition(intake.pursuit.id, {
      status: 'active',
      reason: `bounded history update ${i}`,
    });
  }

  const pursuit = kernel.pursuit(intake.pursuit.id);
  const pursuitRows = readJsonl(join(dir, 'agency', 'pursuits.jsonl'))
    .filter(row => row.pursuit?.id === intake.pursuit.id);
  const lastRow = pursuitRows.at(-1);

  assert.equal(pursuit.history.length <= 25, true);
  assert.equal(lastRow.pursuit.history.length <= 25, true);
});
