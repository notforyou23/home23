import type { ToolContext, ToolDefinition } from '../types.js';

function baseUrl(ctx: ToolContext): string {
  return ctx.workerConnectorBaseUrl || `http://127.0.0.1:${process.env.HOME23_BRIDGE_PORT || '5004'}`;
}

function fetcher(ctx: ToolContext): typeof fetch {
  return ctx.fetch || fetch;
}

async function jsonRequest(ctx: ToolContext, path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetcher(ctx)(`${baseUrl(ctx)}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers || {}) },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error((data && typeof data === 'object' && 'error' in data) ? String(data.error) : `HTTP ${res.status}`);
  }
  return data;
}

export const agencyListTool: ToolDefinition = {
  name: 'agency_list',
  description: 'Show Jerry resident agency state and active/watch pursuits.',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
  async execute(_input, ctx) {
    const state = await jsonRequest(ctx, '/api/agency/state');
    const pursuits = await jsonRequest(ctx, '/api/agency/pursuits');
    return { content: JSON.stringify({ state, pursuits }, null, 2) };
  },
};

export const agencyBriefTool: ToolDefinition = {
  name: 'agency_brief',
  description: 'Answer the resident success-test question from live agency state: what Jerry is following, what changed, what he is doing next, and what he needs from jtr.',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
  async execute(_input, ctx) {
    const data = await jsonRequest(ctx, '/api/agency/brief') as { text?: string };
    return { content: data.text || JSON.stringify(data, null, 2) };
  },
};

export const agencyCreatePursuitTool: ToolDefinition = {
  name: 'agency_create_pursuit',
  description: 'Create or merge a resident agency pursuit from an explicit candidate/intake packet.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      authorityLevel: { type: 'string', enum: ['L0', 'L1', 'L2', 'L3', 'L4'] },
      desiredChangedFuture: { type: 'string' },
      evidenceRef: { type: 'string' },
      source: { type: 'string' },
      kind: { type: 'string' },
    },
    required: ['summary'],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const evidenceRef = typeof input.evidenceRef === 'string' && input.evidenceRef.trim()
      ? [{ type: 'reference', ref: input.evidenceRef }]
      : [];
    const data = await jsonRequest(ctx, '/api/agency/intake', {
      method: 'POST',
      body: JSON.stringify({
        source: input.source || 'chat',
        kind: input.kind || 'chat_pursuit',
        summary: input.summary,
        authorityLevel: input.authorityLevel || 'L1',
        desiredChangedFuture: input.desiredChangedFuture,
        evidence: evidenceRef,
        tags: ['chat'],
      }),
    }) as { decision?: { route?: string }; pursuit?: { id?: string } };
    return { content: `Agency intake ${data.decision?.route || 'unknown'}${data.pursuit?.id ? `: ${data.pursuit.id}` : ''}` };
  },
};

export const agencyCreateTaskTool: ToolDefinition = {
  name: 'agency_create_task',
  description: 'Create a resident agency task or routed handoff tied to a pursuit without claiming the task is complete.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      pursuitId: { type: 'string' },
      actionKind: { type: 'string' },
      authorityLevel: { type: 'string', enum: ['L0', 'L1', 'L2', 'L3', 'L4'] },
      handoffTo: { type: 'string' },
      handoffObjective: { type: 'string' },
      evidenceRef: { type: 'string' },
    },
    required: ['summary'],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const evidence = typeof input.evidenceRef === 'string' && input.evidenceRef.trim()
      ? [{ type: 'reference', ref: input.evidenceRef }]
      : [];
    const handoff = input.handoffTo || input.handoffObjective
      ? {
          to: input.handoffTo,
          objective: input.handoffObjective,
        }
      : undefined;
    const data = await jsonRequest(ctx, '/api/agency/tasks', {
      method: 'POST',
      body: JSON.stringify({
        summary: input.summary,
        pursuitId: input.pursuitId,
        actionKind: input.actionKind || 'bounded_action',
        authorityLevel: input.authorityLevel || 'L2',
        handoff,
        evidence,
      }),
    }) as { task?: { id?: string; status?: string; summary?: string } };
    return { content: `Agency task ${data.task?.id || 'created'} (${data.task?.status || 'open'}): ${data.task?.summary || input.summary}` };
  },
};

export const agencyCloseTaskTool: ToolDefinition = {
  name: 'agency_close_task',
  description: 'Close a resident agency task with evidence so handoffs do not become stale resident queues.',
  input_schema: {
    type: 'object',
    properties: {
      taskId: { type: 'string' },
      summary: { type: 'string' },
      evidenceRef: { type: 'string' },
    },
    required: ['taskId', 'summary'],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const taskId = String(input.taskId || '').trim();
    const evidence = typeof input.evidenceRef === 'string' && input.evidenceRef.trim()
      ? [{ type: 'reference', ref: input.evidenceRef }]
      : [];
    const data = await jsonRequest(ctx, `/api/agency/tasks/${encodeURIComponent(taskId)}/transition`, {
      method: 'POST',
      body: JSON.stringify({
        status: 'closed',
        summary: input.summary,
        evidence,
      }),
    }) as { task?: { id?: string; status?: string; closureSummary?: string } };
    return { content: `Agency task ${data.task?.id || taskId} (${data.task?.status || 'closed'}): ${data.task?.closureSummary || input.summary}` };
  },
};

export const agencyUpdatePursuitTool: ToolDefinition = {
  name: 'agency_update_pursuit',
  description: 'Transition or annotate a resident agency pursuit.',
  input_schema: {
    type: 'object',
    properties: {
      pursuitId: { type: 'string' },
      status: { type: 'string', enum: ['active', 'watch', 'closed', 'discarded', 'blocked'] },
      summary: { type: 'string' },
      currentTheory: { type: 'string' },
      nextMove: { type: 'string' },
      desiredChangedFuture: { type: 'string' },
      stopCondition: { type: 'string' },
      whatWouldChangeMyMind: { type: 'string' },
      evidenceRef: { type: 'string' },
    },
    required: ['pursuitId', 'status'],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const data = await transition(ctx, String(input.pursuitId), {
      status: input.status,
      summary: input.summary,
      currentTheory: input.currentTheory,
      nextMove: input.nextMove,
      desiredChangedFuture: input.desiredChangedFuture,
      stopCondition: input.stopCondition,
      whatWouldChangeMyMind: input.whatWouldChangeMyMind,
      evidenceRef: input.evidenceRef,
    });
    return { content: JSON.stringify(data, null, 2) };
  },
};

export const agencyClosePursuitTool: ToolDefinition = {
  name: 'agency_close_pursuit',
  description: 'Close a resident agency pursuit with consequence evidence.',
  input_schema: {
    type: 'object',
    properties: {
      pursuitId: { type: 'string' },
      summary: { type: 'string' },
      evidenceRef: { type: 'string' },
    },
    required: ['pursuitId', 'summary'],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const data = await transition(ctx, String(input.pursuitId), {
      status: 'closed',
      summary: input.summary,
      evidenceRef: input.evidenceRef,
    }) as { pursuit?: { status?: string } };
    return { content: `Agency pursuit ${input.pursuitId} ${data.pursuit?.status || 'updated'}` };
  },
};

export const agencyDiscardCandidateTool: ToolDefinition = {
  name: 'agency_discard_candidate',
  description: 'Record an explicit discard decision for an agency inbox candidate.',
  input_schema: {
    type: 'object',
    properties: {
      candidateId: { type: 'string' },
      reason: { type: 'string' },
    },
    required: ['candidateId', 'reason'],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const data = await jsonRequest(ctx, '/api/agency/intake', {
      method: 'POST',
      body: JSON.stringify({
        candidateId: input.candidateId,
        source: 'chat',
        kind: 'discarded_by_chat',
        summary: input.reason,
        authorityLevel: 'L0',
        tags: ['chat', 'discard'],
      }),
    });
    return { content: JSON.stringify(data, null, 2) };
  },
};

export const agencyRequestAuthorityTool: ToolDefinition = {
  name: 'agency_request_authority',
  description: 'Request higher authority for a resident agency pursuit without executing the action.',
  input_schema: {
    type: 'object',
    properties: {
      pursuitId: { type: 'string' },
      authorityLevel: { type: 'string', enum: ['L3', 'L4'] },
      reason: { type: 'string' },
    },
    required: ['pursuitId', 'authorityLevel', 'reason'],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const data = await transition(ctx, String(input.pursuitId), {
      transition: 'request_authority',
      status: 'blocked',
      authorityLevel: input.authorityLevel,
      reason: input.reason,
    });
    return { content: JSON.stringify(data, null, 2) };
  },
};

export const agencyIntakeWorldStreamTool: ToolDefinition = {
  name: 'agency_intake_world_stream',
  description: 'Assimilate a world-stream item such as a timeline report, link, research output, cron report, or newsletter draft into discard/memory/watch/pursuit/task/question/no-change receipts.',
  input_schema: {
    type: 'object',
    properties: {
      source: { type: 'string' },
      kind: { type: 'string' },
      summary: { type: 'string' },
      seen: { type: 'array', items: { type: 'string' } },
      discarded: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            ref: { type: 'string' },
            reason: { type: 'string' },
          },
          required: ['ref', 'reason'],
          additionalProperties: false,
        },
      },
      explicitNoChange: { type: 'boolean' },
      desiredChangedFuture: { type: 'string' },
      nextMove: { type: 'string' },
    },
    required: ['source', 'kind', 'summary'],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const data = await jsonRequest(ctx, '/api/agency/world-stream', {
      method: 'POST',
      body: JSON.stringify(input),
    }) as { receipt?: { outcome?: string }; decision?: { route?: string }; pursuit?: { id?: string } };
    return { content: `World stream ${data.receipt?.outcome || data.decision?.route || 'assimilated'}${data.pursuit?.id ? `: ${data.pursuit.id}` : ''}` };
  },
};

export const agencyRecordClaimTool: ToolDefinition = {
  name: 'agency_record_claim',
  description: 'Record a durable resident truth claim or jtr correction into the source-of-truth hierarchy.',
  input_schema: {
    type: 'object',
    properties: {
      claim: { type: 'string' },
      sourceType: {
        type: 'string',
        enum: ['current_verified_state', 'jtr_correction', 'verifier_receipt', 'worker_receipt', 'source_artifact', 'generated_doctrine', 'narrative'],
      },
      sourceRef: { type: 'string' },
      contradicts: { type: 'string' },
    },
    required: ['claim', 'sourceType'],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const data = await jsonRequest(ctx, '/api/agency/claims', {
      method: 'POST',
      body: JSON.stringify({
        claim: input.claim,
        sourceType: input.sourceType,
        sourceRef: input.sourceRef,
        contradicts: input.contradicts,
      }),
    }) as { claim?: { id?: string; sourceType?: string; status?: string } };
    return { content: `Agency claim ${data.claim?.id || 'recorded'} (${data.claim?.sourceType || input.sourceType}, ${data.claim?.status || 'unknown'})` };
  },
};

export const agencyTickTool: ToolDefinition = {
  name: 'agency_tick',
  description: 'Run one resident agency tick: select one pursuit, apply editor/veto governance, and write scratch/consequence receipts.',
  input_schema: {
    type: 'object',
    properties: {
      reason: { type: 'string' },
    },
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const data = await jsonRequest(ctx, '/api/agency/tick', {
      method: 'POST',
      body: JSON.stringify({ reason: input.reason || 'chat_requested_tick' }),
    });
    return { content: JSON.stringify(data, null, 2) };
  },
};

export const agencyScratchNoteTool: ToolDefinition = {
  name: 'agency_scratch_note',
  description: 'Record a private resident scratch note for provisional theories, dead ends, wrong takes, or messy cognition without promoting it to a claim, pursuit, or public artifact.',
  input_schema: {
    type: 'object',
    properties: {
      kind: { type: 'string' },
      note: { type: 'string' },
      provisionalTheory: { type: 'string' },
      pursuitId: { type: 'string' },
      evidenceRef: { type: 'string' },
    },
    required: ['note'],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const evidence = typeof input.evidenceRef === 'string' && input.evidenceRef.trim()
      ? [{ type: 'reference', ref: input.evidenceRef }]
      : [];
    const data = await jsonRequest(ctx, '/api/agency/scratch', {
      method: 'POST',
      body: JSON.stringify({
        kind: input.kind || 'scratch_note',
        note: input.note,
        provisionalTheory: input.provisionalTheory,
        pursuitId: input.pursuitId,
        evidence,
      }),
    }) as { scratch?: { id?: string; visibility?: string; promoted?: boolean } };
    return { content: `Agency scratch ${data.scratch?.id || 'recorded'} (${data.scratch?.visibility || 'private'}, promoted=${data.scratch?.promoted === true})` };
  },
};

export const agencyRaiseQuestionTool: ToolDefinition = {
  name: 'agency_raise_question',
  description: 'Raise a bounded question for jtr when resident agency needs operator judgment, taste, authority, or clarification before changing behavior.',
  input_schema: {
    type: 'object',
    properties: {
      question: { type: 'string' },
      reason: { type: 'string' },
      pursuitId: { type: 'string' },
      authorityLevel: { type: 'string', enum: ['L1', 'L2', 'L3', 'L4'] },
      evidenceRef: { type: 'string' },
    },
    required: ['question', 'reason'],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const evidence = typeof input.evidenceRef === 'string' && input.evidenceRef.trim()
      ? [{ type: 'reference', ref: input.evidenceRef }]
      : [];
    const data = await jsonRequest(ctx, '/api/agency/questions', {
      method: 'POST',
      body: JSON.stringify({
        question: input.question,
        reason: input.reason,
        pursuitId: input.pursuitId,
        authorityLevel: input.authorityLevel || 'L3',
        evidence,
      }),
    }) as { question?: { id?: string; status?: string; question?: string } };
    return { content: `Agency question ${data.question?.id || 'raised'} (${data.question?.status || 'open'}): ${data.question?.question || input.question}` };
  },
};

export const agencyProposeDeltaTool: ToolDefinition = {
  name: 'agency_propose_delta',
  description: 'Propose a behavioral or structural delta for the resident spine to arbitrate through bounded authority.',
  input_schema: {
    type: 'object',
    properties: {
      changeType: { type: 'string' },
      summary: { type: 'string' },
      authorityLevel: { type: 'string', enum: ['L0', 'L1', 'L2', 'L3', 'L4'] },
      reversible: { type: 'boolean' },
      target: { type: 'string' },
      pursuitId: { type: 'string' },
      promptScope: { type: 'string' },
      promptText: { type: 'string' },
      memoryDomain: { type: 'string', enum: ['ops', 'project', 'personal', 'doctrine', 'meta'] },
      memoryContent: { type: 'string' },
      surface: { type: 'string' },
      contractText: { type: 'string' },
      worker: { type: 'string' },
      handoffObjective: { type: 'string' },
      jobId: { type: 'string' },
      cronExpr: { type: 'string' },
      everyMs: { type: 'number' },
      announceMode: { type: 'string', enum: ['none', 'failures', 'summary', 'full'] },
      deliveryProfile: { type: 'string' },
      currentTheory: { type: 'string' },
      nextMove: { type: 'string' },
      posture: { type: 'string' },
      evidenceRef: { type: 'string' },
    },
    required: ['changeType', 'summary'],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const evidence = typeof input.evidenceRef === 'string' && input.evidenceRef.trim()
      ? [{ type: 'reference', ref: input.evidenceRef }]
      : [];
    const data = await jsonRequest(ctx, '/api/agency/deltas', {
      method: 'POST',
      body: JSON.stringify({
        changeType: input.changeType,
        summary: input.summary,
        authorityLevel: input.authorityLevel || 'L1',
        reversible: input.reversible !== false,
        target: input.target,
        pursuitId: input.pursuitId,
        promptScope: input.promptScope,
        promptText: input.promptText,
        memoryDomain: input.memoryDomain,
        memoryContent: input.memoryContent,
        surface: input.surface,
        contractText: input.contractText,
        worker: input.worker,
        handoffObjective: input.handoffObjective,
        jobId: input.jobId,
        cronExpr: input.cronExpr,
        everyMs: input.everyMs,
        announceMode: input.announceMode,
        deliveryProfile: input.deliveryProfile,
        currentTheory: input.currentTheory,
        nextMove: input.nextMove,
        posture: input.posture,
        evidence,
      }),
    }) as { decision?: { route?: string }; authority?: { reason?: string } };
    return { content: `Agency delta ${data.decision?.route || 'unknown'}: ${data.authority?.reason || ''}`.trim() };
  },
};

async function transition(ctx: ToolContext, pursuitId: string, body: Record<string, unknown>) {
  return jsonRequest(ctx, `/api/agency/pursuits/${encodeURIComponent(pursuitId)}/transition`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
