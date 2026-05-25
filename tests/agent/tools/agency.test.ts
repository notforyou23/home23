import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  agencyBriefTool,
  agencyListTool,
  agencyCreatePursuitTool,
  agencyClosePursuitTool,
  agencyDiscardCandidateTool,
  agencyIntakeWorldStreamTool,
  agencyProposeDeltaTool,
  agencyRequestAuthorityTool,
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
