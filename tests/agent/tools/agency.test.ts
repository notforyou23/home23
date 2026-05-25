import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  agencyBriefTool,
  agencyListTool,
  agencyCreatePursuitTool,
  agencyCreateTaskTool,
  agencyCloseTaskTool,
  agencyClosePursuitTool,
  agencyDiscardCandidateTool,
  agencyIntakeWorldStreamTool,
  agencyProposeDeltaTool,
  agencyRaiseQuestionTool,
  agencyRecordClaimTool,
  agencyRequestAuthorityTool,
  agencyScratchNoteTool,
  agencyTickTool,
} from '../../../src/agent/tools/agency.js';
import type { ToolContext } from '../../../src/agent/types.js';

function ctx(fetchImpl: typeof fetch): ToolContext {
  return {
    scheduler: null,
    ttsService: null,
    browser: null,
    projectRoot: '/tmp/home23',
    enginePort: 5001,
    agentName: 'jerry',
    cosmo23BaseUrl: 'http://localhost:43210',
    brainRoute: null,
    workspacePath: '/tmp/home23/instances/jerry/workspace',
    tempDir: '/tmp/home23/.tmp',
    contextManager: {
      getSystemPrompt: () => '',
      getPromptSourceInfo: () => ({ generatedAt: '', totalSections: 0, loadedFiles: [] }),
      invalidate: () => undefined
    },
    subAgentTracker: { active: 0, maxConcurrent: 1, queue: [] },
    chatId: 'test',
    telegramAdapter: null,
    runAgentLoop: null,
    workerConnectorBaseUrl: 'http://bridge.test',
    fetch: fetchImpl
  };
}

test('agency_list reads state and pursuits from bridge API', async () => {
  const calls: string[] = [];
  const fakeFetch = async (url: string | URL | Request) => {
    calls.push(String(url));
    if (String(url).endsWith('/api/agency/state')) {
      return new Response(JSON.stringify({ agent: 'jerry', mode: 'dry_run' }), { status: 200 });
    }
    return new Response(JSON.stringify({ pursuits: [{ id: 'ap_1', title: 'Verify dashboard', status: 'active' }] }), { status: 200 });
  };

  const result = await agencyListTool.execute({}, ctx(fakeFetch as typeof fetch));
  assert.deepEqual(calls, ['http://bridge.test/api/agency/state', 'http://bridge.test/api/agency/pursuits']);
  assert.match(result.content, /Verify dashboard/);
});

test('agency_brief answers the resident success-test questions from bridge API', async () => {
  const fakeFetch = async (url: string | URL | Request) => {
    assert.equal(String(url), 'http://bridge.test/api/agency/brief');
    return new Response(JSON.stringify({
      text: [
        'What we are following: Repair agency dashboard receipt chain.',
        'What changed: Agency dashboard now shows body organs.',
        'What I am doing next: advance_one_step.',
        'What I need from jtr: approve public publication.',
      ].join('\n'),
    }), { status: 200 });
  };

  const result = await agencyBriefTool.execute({}, ctx(fakeFetch as typeof fetch));
  assert.match(result.content, /What we are following/);
  assert.match(result.content, /What changed/);
  assert.match(result.content, /What I need from jtr/);
});

test('agency_create_pursuit posts an intake packet', async () => {
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), 'http://bridge.test/api/agency/intake');
    assert.equal(init?.method, 'POST');
    assert.match(String(init?.body), /Dashboard publish should have a verifier/);
    return new Response(JSON.stringify({ decision: { route: 'pursue' }, pursuit: { id: 'ap_1' } }), { status: 200 });
  };

  const result = await agencyCreatePursuitTool.execute({
    summary: 'Dashboard publish should have a verifier',
    authorityLevel: 'L2',
  }, ctx(fakeFetch as typeof fetch));

  assert.match(result.content, /ap_1/);
});

test('agency_close_pursuit transitions a pursuit with consequence evidence', async () => {
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), 'http://bridge.test/api/agency/pursuits/ap_1/transition');
    assert.equal(init?.method, 'POST');
    assert.match(String(init?.body), /closed/);
    assert.match(String(init?.body), /receipt/);
    return new Response(JSON.stringify({ pursuit: { id: 'ap_1', status: 'closed' } }), { status: 200 });
  };

  const result = await agencyClosePursuitTool.execute({
    pursuitId: 'ap_1',
    summary: 'Verifier passed',
    evidenceRef: 'receipt:abc',
  }, ctx(fakeFetch as typeof fetch));

  assert.match(result.content, /closed/);
});

test('agency_discard_candidate and agency_request_authority use explicit transitions', async () => {
  const seen: string[] = [];
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
    seen.push(`${String(url)} ${init?.method || 'GET'} ${String(init?.body || '')}`);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  await agencyDiscardCandidateTool.execute({ candidateId: 'cand_1', reason: 'noise' }, ctx(fakeFetch as typeof fetch));
  await agencyRequestAuthorityTool.execute({ pursuitId: 'ap_1', authorityLevel: 'L4', reason: 'needs restart' }, ctx(fakeFetch as typeof fetch));

  assert.match(seen[0], /\/api\/agency\/intake/);
  assert.match(seen[0], /discarded_by_chat/);
  assert.match(seen[1], /\/api\/agency\/pursuits\/ap_1\/transition/);
  assert.match(seen[1], /request_authority/);
});

test('agency_intake_world_stream and agency_tick call resident spine APIs', async () => {
  const seen: string[] = [];
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
    seen.push(`${String(url)} ${init?.method || 'GET'} ${String(init?.body || '')}`);
    if (String(url).endsWith('/api/agency/world-stream')) {
      return new Response(JSON.stringify({ receipt: { outcome: 'explicit_no_change' } }), { status: 200 });
    }
    return new Response(JSON.stringify({ selected: { pursuitId: 'ap_1' }, editor: { verdict: 'allow' } }), { status: 200 });
  };

  const intake = await agencyIntakeWorldStreamTool.execute({
    source: 'x.timeline',
    kind: 'timeline_report',
    summary: 'Generic hype, no consequence',
    seen: ['post-1'],
    explicitNoChange: true,
  }, ctx(fakeFetch as typeof fetch));
  const tick = await agencyTickTool.execute({ reason: 'test' }, ctx(fakeFetch as typeof fetch));

  assert.match(intake.content, /explicit_no_change/);
  assert.match(tick.content, /ap_1/);
  assert.match(seen[0], /\/api\/agency\/world-stream/);
  assert.match(seen[1], /\/api\/agency\/tick/);
});

test('agency_propose_delta calls bounded delta arbitration API', async () => {
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), 'http://bridge.test/api/agency/deltas');
    assert.equal(init?.method, 'POST');
    assert.match(String(init?.body), /watch_item_created/);
    return new Response(JSON.stringify({ decision: { route: 'approved_dry_run' }, authority: { reason: 'dry_run_records_intent_only' } }), { status: 200 });
  };

  const result = await agencyProposeDeltaTool.execute({
    changeType: 'watch_item_created',
    summary: 'Watch agent agency product news.',
    authorityLevel: 'L1',
  }, ctx(fakeFetch as typeof fetch));

  assert.match(result.content, /approved_dry_run/);
});

test('agency_propose_delta can pass a pursuit note delta through the bridge API', async () => {
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), 'http://bridge.test/api/agency/deltas');
    assert.equal(init?.method, 'POST');
    const body = JSON.parse(String(init?.body || '{}'));
    assert.equal(body.changeType, 'pursuit_note_added');
    assert.equal(body.pursuitId, 'ap_note');
    assert.equal(body.currentTheory, 'The signal matters only if it changes resident behavior.');
    assert.equal(body.nextMove, 'apply the smallest bounded change');
    assert.deepEqual(body.evidence, [{ type: 'reference', ref: 'brief-2' }]);
    return new Response(JSON.stringify({ decision: { route: 'approved_live' }, authority: { reason: 'live_low_risk_allowed' } }), { status: 200 });
  };

  const result = await agencyProposeDeltaTool.execute({
    changeType: 'pursuit_note_added',
    pursuitId: 'ap_note',
    summary: 'Attach the research implication to the living pursuit.',
    currentTheory: 'The signal matters only if it changes resident behavior.',
    nextMove: 'apply the smallest bounded change',
    evidenceRef: 'brief-2',
    authorityLevel: 'L1',
  }, ctx(fakeFetch as typeof fetch));

  assert.match(result.content, /approved_live/);
});

test('agency_propose_delta can pass a watch close delta through the bridge API', async () => {
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), 'http://bridge.test/api/agency/deltas');
    assert.equal(init?.method, 'POST');
    const body = JSON.parse(String(init?.body || '{}'));
    assert.equal(body.changeType, 'watch_item_closed');
    assert.equal(body.pursuitId, 'ap_watch');
    assert.equal(body.summary, 'Watched signal exhausted without further consequence.');
    assert.deepEqual(body.evidence, [{ type: 'reference', ref: 'watch:closed' }]);
    return new Response(JSON.stringify({ decision: { route: 'approved_live' }, authority: { reason: 'live_low_risk_allowed' } }), { status: 200 });
  };

  const result = await agencyProposeDeltaTool.execute({
    changeType: 'watch_item_closed',
    pursuitId: 'ap_watch',
    summary: 'Watched signal exhausted without further consequence.',
    evidenceRef: 'watch:closed',
    authorityLevel: 'L1',
  }, ctx(fakeFetch as typeof fetch));

  assert.match(result.content, /approved_live/);
});

test('agency_propose_delta can pass a pursuit kill delta through the bridge API', async () => {
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), 'http://bridge.test/api/agency/deltas');
    assert.equal(init?.method, 'POST');
    const body = JSON.parse(String(init?.body || '{}'));
    assert.equal(body.changeType, 'pursuit_killed');
    assert.equal(body.pursuitId, 'ap_kill');
    assert.equal(body.summary, 'Report-only thread should stop consuming resident attention.');
    assert.deepEqual(body.evidence, [{ type: 'reference', ref: 'kill:receipt' }]);
    return new Response(JSON.stringify({ decision: { route: 'approved_live' }, authority: { reason: 'live_low_risk_allowed' } }), { status: 200 });
  };

  const result = await agencyProposeDeltaTool.execute({
    changeType: 'pursuit_killed',
    pursuitId: 'ap_kill',
    summary: 'Report-only thread should stop consuming resident attention.',
    evidenceRef: 'kill:receipt',
    authorityLevel: 'L1',
  }, ctx(fakeFetch as typeof fetch));

  assert.match(result.content, /approved_live/);
});

test('agency_propose_delta can pass a state posture delta through the bridge API', async () => {
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), 'http://bridge.test/api/agency/deltas');
    assert.equal(init?.method, 'POST');
    const body = JSON.parse(String(init?.body || '{}'));
    assert.equal(body.changeType, 'state_posture_updated');
    assert.equal(body.target, 'self.posture');
    assert.equal(body.posture, 'agency-bootcamp-kill-review');
    assert.deepEqual(body.evidence, [{ type: 'reference', ref: 'curriculum:bootcamp' }]);
    return new Response(JSON.stringify({ decision: { route: 'approved_live' }, authority: { reason: 'live_low_risk_allowed' } }), { status: 200 });
  };

  const result = await agencyProposeDeltaTool.execute({
    changeType: 'state_posture_updated',
    target: 'self.posture',
    posture: 'agency-bootcamp-kill-review',
    summary: 'Curriculum digestion changed Jerry posture toward kill-review bootcamp.',
    evidenceRef: 'curriculum:bootcamp',
    authorityLevel: 'L1',
  }, ctx(fakeFetch as typeof fetch));

  assert.match(result.content, /approved_live/);
});

test('agency_propose_delta can pass a prompt update delta through the bridge API', async () => {
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), 'http://bridge.test/api/agency/deltas');
    assert.equal(init?.method, 'POST');
    const body = JSON.parse(String(init?.body || '{}'));
    assert.equal(body.changeType, 'prompt_updated');
    assert.equal(body.target, 'chat.agency_context');
    assert.equal(body.promptScope, 'agency_bootcamp_reports');
    assert.equal(body.promptText, 'Reports must state their agency outcome before delivery.');
    assert.deepEqual(body.evidence, [{ type: 'reference', ref: 'curriculum:agency-bootcamp' }]);
    return new Response(JSON.stringify({ decision: { route: 'approved_live' }, authority: { reason: 'live_low_risk_allowed' } }), { status: 200 });
  };

  const result = await agencyProposeDeltaTool.execute({
    changeType: 'prompt_updated',
    target: 'chat.agency_context',
    promptScope: 'agency_bootcamp_reports',
    promptText: 'Reports must state their agency outcome before delivery.',
    summary: 'Curriculum digestion changed future report prompting.',
    evidenceRef: 'curriculum:agency-bootcamp',
    authorityLevel: 'L1',
  }, ctx(fakeFetch as typeof fetch));

  assert.match(result.content, /approved_live/);
});

test('agency_propose_delta can pass a memory candidate delta through the bridge API', async () => {
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), 'http://bridge.test/api/agency/deltas');
    assert.equal(init?.method, 'POST');
    const body = JSON.parse(String(init?.body || '{}'));
    assert.equal(body.changeType, 'memory_candidate_created');
    assert.equal(body.pursuitId, 'ap_memory');
    assert.equal(body.memoryDomain, 'doctrine');
    assert.equal(body.memoryContent, 'Timeline reports need agency outcomes before delivery.');
    assert.deepEqual(body.evidence, [{ type: 'reference', ref: 'x:agency-outcomes' }]);
    return new Response(JSON.stringify({ decision: { route: 'approved_live' }, authority: { reason: 'live_low_risk_allowed' } }), { status: 200 });
  };

  const result = await agencyProposeDeltaTool.execute({
    changeType: 'memory_candidate_created',
    pursuitId: 'ap_memory',
    memoryDomain: 'doctrine',
    memoryContent: 'Timeline reports need agency outcomes before delivery.',
    summary: 'Remember the agency outcome rule for reports.',
    evidenceRef: 'x:agency-outcomes',
    authorityLevel: 'L1',
  }, ctx(fakeFetch as typeof fetch));

  assert.match(result.content, /approved_live/);
});

test('agency_propose_delta can pass a dashboard contract delta through the bridge API', async () => {
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), 'http://bridge.test/api/agency/deltas');
    assert.equal(init?.method, 'POST');
    const body = JSON.parse(String(init?.body || '{}'));
    assert.equal(body.changeType, 'dashboard_contract_changed');
    assert.equal(body.target, 'dashboard.agency');
    assert.equal(body.surface, 'agency_inspector');
    assert.equal(body.contractText, 'Show receipts before visual status.');
    assert.deepEqual(body.evidence, [{ type: 'reference', ref: 'dashboard:agency' }]);
    return new Response(JSON.stringify({ decision: { route: 'approved_live' }, authority: { reason: 'live_low_risk_allowed' } }), { status: 200 });
  };

  const result = await agencyProposeDeltaTool.execute({
    changeType: 'dashboard_contract_changed',
    target: 'dashboard.agency',
    surface: 'agency_inspector',
    contractText: 'Show receipts before visual status.',
    summary: 'Dashboard contract now prioritizes evidence chains.',
    evidenceRef: 'dashboard:agency',
    authorityLevel: 'L1',
  }, ctx(fakeFetch as typeof fetch));

  assert.match(result.content, /approved_live/);
});

test('agency_propose_delta can pass a worker delegation delta through the bridge API', async () => {
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), 'http://bridge.test/api/agency/deltas');
    assert.equal(init?.method, 'POST');
    const body = JSON.parse(String(init?.body || '{}'));
    assert.equal(body.changeType, 'worker_delegated');
    assert.equal(body.pursuitId, 'ap_worker');
    assert.equal(body.worker, 'worker:agency-inspector-verifier');
    assert.equal(body.handoffObjective, 'Verify receipt chains.');
    assert.deepEqual(body.evidence, [{ type: 'reference', ref: 'worker:delegate' }]);
    return new Response(JSON.stringify({ decision: { route: 'approved_live' }, authority: { reason: 'live_low_risk_allowed' } }), { status: 200 });
  };

  const result = await agencyProposeDeltaTool.execute({
    changeType: 'worker_delegated',
    pursuitId: 'ap_worker',
    worker: 'worker:agency-inspector-verifier',
    handoffObjective: 'Verify receipt chains.',
    summary: 'Delegate agency inspector verification.',
    evidenceRef: 'worker:delegate',
    authorityLevel: 'L2',
  }, ctx(fakeFetch as typeof fetch));

  assert.match(result.content, /approved_live/);
});

test('agency_propose_delta can pass a cron adjustment delta through the bridge API', async () => {
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), 'http://bridge.test/api/agency/deltas');
    assert.equal(init?.method, 'POST');
    const body = JSON.parse(String(init?.body || '{}'));
    assert.equal(body.changeType, 'cron_adjusted');
    assert.equal(body.pursuitId, 'ap_cron');
    assert.equal(body.jobId, 'field-report-daily');
    assert.equal(body.cronExpr, '0 8 * * 1-5');
    assert.deepEqual(body.evidence, [{ type: 'reference', ref: 'cron:field-report-daily' }]);
    return new Response(JSON.stringify({ decision: { route: 'approved_live' }, authority: { reason: 'live_low_risk_allowed' } }), { status: 200 });
  };

  const result = await agencyProposeDeltaTool.execute({
    changeType: 'cron_adjusted',
    pursuitId: 'ap_cron',
    jobId: 'field-report-daily',
    cronExpr: '0 8 * * 1-5',
    summary: 'Reduce field report cadence during agency bootcamp.',
    evidenceRef: 'cron:field-report-daily',
    authorityLevel: 'L2',
  }, ctx(fakeFetch as typeof fetch));

  assert.match(result.content, /approved_live/);
});

test('agency_record_claim writes a resident truth claim through bridge API', async () => {
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), 'http://bridge.test/api/agency/claims');
    assert.equal(init?.method, 'POST');
    assert.match(String(init?.body), /jtr_correction/);
    assert.match(String(init?.body), /old newsletter frame is exhausted/);
    return new Response(JSON.stringify({
      claim: {
        id: 'claim_1',
        sourceType: 'jtr_correction',
        status: 'current',
      },
    }), { status: 200 });
  };

  const result = await agencyRecordClaimTool.execute({
    claim: 'The old newsletter frame is exhausted.',
    sourceType: 'jtr_correction',
    sourceRef: 'telegram:123:99',
    contradicts: 'claim_old',
  }, ctx(fakeFetch as typeof fetch));

  assert.match(result.content, /claim_1/);
  assert.match(result.content, /jtr_correction/);
});

test('agency_scratch_note records a private scratch thought without promoting it', async () => {
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), 'http://bridge.test/api/agency/scratch');
    assert.equal(init?.method, 'POST');
    const body = JSON.parse(String(init?.body || '{}'));
    assert.equal(body.kind, 'provisional_theory');
    assert.equal(body.note, 'This might be noise until evidence changes it.');
    assert.equal(body.provisionalTheory, 'The report theme is not yet actionable.');
    assert.deepEqual(body.evidence, [{ type: 'reference', ref: 'timeline:maybe' }]);
    return new Response(JSON.stringify({
      scratch: {
        id: 'scratch_1',
        visibility: 'private',
        promoted: false,
      },
    }), { status: 200 });
  };

  const result = await agencyScratchNoteTool.execute({
    kind: 'provisional_theory',
    note: 'This might be noise until evidence changes it.',
    provisionalTheory: 'The report theme is not yet actionable.',
    evidenceRef: 'timeline:maybe',
  }, ctx(fakeFetch as typeof fetch));

  assert.match(result.content, /scratch_1/);
  assert.match(result.content, /private/);
});

test('agency_raise_question records a bounded jtr question through the bridge API', async () => {
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), 'http://bridge.test/api/agency/questions');
    assert.equal(init?.method, 'POST');
    const body = JSON.parse(String(init?.body || '{}'));
    assert.equal(body.pursuitId, 'ap_newsletter');
    assert.equal(body.question, 'Should Jerry kill this newsletter unless it cites lived system change?');
    assert.equal(body.authorityLevel, 'L3');
    assert.deepEqual(body.evidence, [{ type: 'reference', ref: 'newsletter:next' }]);
    return new Response(JSON.stringify({
      question: {
        id: 'q_1',
        status: 'open',
        question: body.question,
      },
    }), { status: 200 });
  };

  const result = await agencyRaiseQuestionTool.execute({
    pursuitId: 'ap_newsletter',
    question: 'Should Jerry kill this newsletter unless it cites lived system change?',
    reason: 'value_depends_on_jtr_editorial_judgment',
    authorityLevel: 'L3',
    evidenceRef: 'newsletter:next',
  }, ctx(fakeFetch as typeof fetch));

  assert.match(result.content, /q_1/);
  assert.match(result.content, /open/);
});

test('agency_create_task records a resident task handoff through the bridge API', async () => {
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), 'http://bridge.test/api/agency/tasks');
    assert.equal(init?.method, 'POST');
    const body = JSON.parse(String(init?.body || '{}'));
    assert.equal(body.pursuitId, 'ap_task');
    assert.equal(body.summary, 'Run dashboard verifier repair worker.');
    assert.equal(body.actionKind, 'worker_delegation');
    assert.deepEqual(body.handoff, { to: 'worker:dashboard-repair', objective: 'Repair receipt chain.' });
    assert.deepEqual(body.evidence, [{ type: 'reference', ref: 'handoff:dashboard' }]);
    return new Response(JSON.stringify({
      task: {
        id: 'task_1',
        status: 'open',
        summary: body.summary,
      },
    }), { status: 200 });
  };

  const result = await agencyCreateTaskTool.execute({
    pursuitId: 'ap_task',
    summary: 'Run dashboard verifier repair worker.',
    actionKind: 'worker_delegation',
    handoffTo: 'worker:dashboard-repair',
    handoffObjective: 'Repair receipt chain.',
    evidenceRef: 'handoff:dashboard',
    authorityLevel: 'L2',
  }, ctx(fakeFetch as typeof fetch));

  assert.match(result.content, /task_1/);
  assert.match(result.content, /open/);
});

test('agency_close_task closes a resident task through the bridge API', async () => {
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), 'http://bridge.test/api/agency/tasks/task_1/transition');
    assert.equal(init?.method, 'POST');
    const body = JSON.parse(String(init?.body || '{}'));
    assert.equal(body.status, 'closed');
    assert.equal(body.summary, 'Verifier passed.');
    assert.deepEqual(body.evidence, [{ type: 'reference', ref: 'receipt:task' }]);
    return new Response(JSON.stringify({
      task: {
        id: 'task_1',
        status: 'closed',
      },
    }), { status: 200 });
  };

  const result = await agencyCloseTaskTool.execute({
    taskId: 'task_1',
    summary: 'Verifier passed.',
    evidenceRef: 'receipt:task',
  }, ctx(fakeFetch as typeof fetch));

  assert.match(result.content, /task_1/);
  assert.match(result.content, /closed/);
});
