import { IDEMPOTENT_OPERATION_TOOLS } from './operation-work-policy.js';
import { delegationCapabilityError } from './delegation-capabilities.js';
/**
 * Foreground tool policy: only bounded, fast tools may run inside a speaking
 * turn. Anything that can materially delay conversation must become durable
 * Work before execution starts.
 *
 * Tools that already create Work at their own boundary are handed off
 * (no wait). Tools that have no create-Work path in this lane are refused
 * with a detach request for Lane 2.
 */

import { isForegroundConversation } from './foreground-admission.js';
import type { AgentEvent, ToolContext, TurnRuntimeContext } from './types.js';
import type { MediaAttachment } from '../types.js';
import type { CoordinationWorkDestination } from '../work/types.js';

export const FOREGROUND_SHELL_MAX_TIMEOUT_MS = 8_000;

export type ForegroundToolAction = 'permit' | 'handoff' | 'require_work' | 'refuse';

export interface ForegroundDetachRequest {
  canonicalArgs?: Record<string, unknown>;
  parentOrigin?: import('./types.js').CoordinationTurnOrigin;
  tool: string;
  reason: string;
  chatId: string;
  turnId?: string;
  channelId?: string;
  conversationId?: string;
  originMessageId?: string;
  principalId?: string;
  targetPrincipalId?: string;
  residentBinding?: string;
  residentInstanceId?: string;
  authorityReference?: string;
  /** Stable identity of this exact tool invocation inside the speaking turn. */
  invocationId?: string;
  instruction?: string;
  /** Scoped assignment selected by the speaking resident for background execution. */
  executionInstruction?: string;
  /** Bounded owner-safe copy that names this independent Working Thread. */
  assignmentLabel?: string;
  /** In-process exact invocation. Durable recovery fails interrupted roots rather than replaying this closure. */
  execute?: (input: {
    destination: CoordinationWorkDestination;
    attemptChatId: string;
    abortController: AbortController;
    onEvent: (event: AgentEvent) => void;
  }) => Promise<{ text: string; artifacts?: readonly MediaAttachment[] }>;
  /** Existing speaking-turn Work used only to recover exact owner authority. */
  speakingWorkId?: string;
}

export type ForegroundDetachOutcome =
  | { created: true; handle: { workId: string } }
  | { created: false; missing: string[] };

export interface ForegroundToolDecision {
  action: ForegroundToolAction;
  tool: string;
  input: Record<string, unknown>;
  reason?: string;
  request?: ForegroundDetachRequest;
}

const REQUIRE_WORK_TOOLS = new Set([
  ...IDEMPOTENT_OPERATION_TOOLS,
  'skills_run', 'bot_invoke', 'cron_run', 'worker_run', 'generate_image', 'generate_music', 'tts',
  'coding_run',
  'coding_continue',
  'spawn_agent',
  'brain_query_export',
]);

/** These cannot yet preserve an exact joined lifecycle, lineage, or result. */
const UNJOINED_DURABLE_TOOLS = new Set<string>();

function asRecord(input: Record<string, unknown>): Record<string, unknown> {
  return { ...input };
}

function scopedExecutionInstruction(name: string, input: Record<string, unknown>, ownerText?: string): string | undefined {
  let encoded: string;
  try { encoded = JSON.stringify(input); } catch { return ownerText; }
  if (!encoded) return ownerText;
  return [
    'Carry out the exact background tool intent selected by the speaking turn.',
    `Invoke ${name} once with these exact JSON arguments:`,
    encoded,
    'Keep all execution inside this Working Thread and return one final owner-facing result.',
  ].join('\n');
}

function boundedAssignment(value: string): string | undefined {
  const collapsed = value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (!collapsed) return undefined;
  // The signed admission contract bounds UTF-8 bytes, not UTF-16 code units.
  // Reserve the ellipsis bytes and iterate code points so truncation cannot
  // split a surrogate pair or exceed the wire limit for non-ASCII assignments.
  if (Buffer.byteLength(collapsed, 'utf8') <= 280) return collapsed;
  let prefix = '';
  let bytes = 0;
  for (const point of collapsed) {
    const width = Buffer.byteLength(point, 'utf8');
    if (bytes + width > 277) break;
    prefix += point;
    bytes += width;
  }
  return `${prefix.trimEnd()}…`;
}

/** Product copy only: never expose the complete structured tool arguments. */
function ownerSafeAssignment(input: Record<string, unknown>, ownerText?: string): string | undefined {
  for (const key of ['task', 'prompt', 'instruction', 'text', 'input', 'answer']) {
    const value = input[key];
    if (typeof value !== 'string') continue;
    const bounded = boundedAssignment(value);
    if (bounded) return bounded;
  }
  return typeof ownerText === 'string' ? boundedAssignment(ownerText) : undefined;
}

export function classifyForegroundTool(name: string): ForegroundToolAction {
  if (name === 'shell') {
    return 'handoff';
  }
  if (UNJOINED_DURABLE_TOOLS.has(name)) return 'refuse';
  if (REQUIRE_WORK_TOOLS.has(name)) return 'require_work';
  return 'permit';
}

function copyExistingDetachFacts(
  ctx: Pick<ToolContext, 'chatId' | 'authenticatedUserMessage'> & {
    turnRuntime?: TurnRuntimeContext | null;
    channelId?: string;
    conversationId?: string;
    originMessageId?: string;
    principalId?: string;
    targetPrincipalId?: string;
    residentBinding?: string;
    residentInstanceId?: string;
    authorityReference?: string;
    coordinationWorkDestination?: ToolContext['coordinationWorkDestination'];
    parentToolCallId?: string;
  },
): Pick<
  ForegroundDetachRequest,
  | 'channelId'
  | 'conversationId'
  | 'originMessageId'
  | 'principalId'
  | 'targetPrincipalId'
  | 'residentBinding'
  | 'residentInstanceId'
  | 'authorityReference'
  | 'instruction'
> {
  const origin = ctx.turnRuntime?.coordinationOrigin;
  const delivery = ctx.turnRuntime?.coordinationDelivery;
  const residentBinding = origin?.authorityReference?.startsWith('resident:')
    ? origin.authorityReference.slice('resident:'.length)
    : undefined;
  const instruction = ctx.authenticatedUserMessage?.text;
  return {
    ...(ctx.channelId || origin?.channelId ? { channelId: ctx.channelId ?? origin!.channelId } : {}),
    ...(ctx.conversationId || delivery?.conversationId ? { conversationId: ctx.conversationId ?? delivery!.conversationId } : {}),
    ...(ctx.originMessageId || origin?.originMessageId ? { originMessageId: ctx.originMessageId ?? origin!.originMessageId! } : {}),
    ...(ctx.principalId ? { principalId: ctx.principalId } : {}),
    ...(ctx.targetPrincipalId || origin?.holderPrincipalId ? { targetPrincipalId: ctx.targetPrincipalId ?? origin!.holderPrincipalId } : {}),
    ...(ctx.residentBinding || residentBinding ? { residentBinding: ctx.residentBinding ?? residentBinding! } : {}),
    ...(ctx.residentInstanceId || origin?.holderInstanceId ? { residentInstanceId: ctx.residentInstanceId ?? origin!.holderInstanceId } : {}),
    ...(ctx.authorityReference || origin?.authorityReference ? { authorityReference: ctx.authorityReference ?? origin!.authorityReference } : {}),
    ...(instruction ? { instruction } : {}),
  };
}

export function applyForegroundToolPolicy(
  name: string,
  input: Record<string, unknown>,
  ctx: Pick<ToolContext, 'chatId' | 'authenticatedUserMessage'> & {
    turnRuntime?: TurnRuntimeContext | null;
    channelId?: string;
    conversationId?: string;
    originMessageId?: string;
    principalId?: string;
    targetPrincipalId?: string;
    residentBinding?: string;
    residentInstanceId?: string;
    authorityReference?: string;
    coordinationWorkDestination?: ToolContext['coordinationWorkDestination'];
    parentToolCallId?: string;
  },
): ForegroundToolDecision {
  if (name === 'spawn_agent') {
    const reason = delegationCapabilityError(input);
    if (reason) return { action: 'refuse', tool: name, input, reason };
  }
  if (name === 'brain_synthesize' && input.action === 'status') return { action: 'permit', tool: name, input };
  const foreground = isForegroundConversation({
    chatId: ctx.chatId,
    coordinationOrigin: ctx.turnRuntime?.coordinationOrigin,
  }) || Boolean(
    ctx.turnRuntime?.coordinationOrigin && !ctx.coordinationWorkDestination
  );
  if (!foreground) {
    if (ctx.coordinationWorkDestination && UNJOINED_DURABLE_TOOLS.has(name)) {
      return {
        action: 'refuse',
        tool: name,
        input,
        reason: `${name} cannot yet preserve the canonical Working Thread lifecycle, lineage, and result; it cannot safely run from a Working Thread`,
      };
    }
    return { action: 'permit', tool: name, input };
  }

  // Canonical promotion runs specialists joined inside their Working Thread,
  // including requests that originally selected detached mode. Reject this
  // incompatible selection before committing immutable invocation arguments.
  if (name === 'spawn_agent' && input.isolated === false && (
    input.mode === 'joined' || ctx.chatId.startsWith('coordination:') ||
    Boolean(ctx.turnRuntime?.coordinationOrigin)
  )) {
    return {
      action: 'refuse', tool: name, input,
      reason: 'Joined specialists are always isolated. Select spawn_agent again with isolated:true or omit isolated; no Working Thread was created for this invalid selection',
    };
  }

  const kind = classifyForegroundTool(name);
  if (kind === 'permit') {
    return { action: 'permit', tool: name, input };
  }

  if (kind === 'refuse') {
    return {
      action: 'refuse',
      tool: name,
      input,
      reason: `${name} cannot yet preserve the canonical Working Thread lifecycle, lineage, and result; it cannot safely run from a speaking turn or Working Thread`,
    };
  }

  if (kind === 'require_work') {
    const executionInstruction = scopedExecutionInstruction(
      name,
      input,
      ctx.authenticatedUserMessage?.text,
    );
    const assignmentLabel = ownerSafeAssignment(input, ctx.authenticatedUserMessage?.text);
    const request: ForegroundDetachRequest = {
      tool: name,
      reason: `${name} can materially delay conversation and must become durable Work before execution`,
      chatId: ctx.chatId,
      turnId: ctx.turnRuntime?.turnId,
      ...(ctx.turnRuntime?.coordinationOrigin
        ? { speakingWorkId: ctx.turnRuntime.coordinationOrigin.workId }
        : {}),
      ...copyExistingDetachFacts(ctx),
      ...(ctx.parentToolCallId ? { invocationId: ctx.parentToolCallId } : {}),
      ...(executionInstruction ? { executionInstruction } : {}),
      ...(assignmentLabel ? { assignmentLabel } : {}),
    };
    return {
      action: 'require_work',
      tool: name,
      input,
      reason: request.reason,
      request,
    };
  }

  const next = asRecord(input);
  if (name === 'shell') {
    const requested = Number(next.timeout_ms);
    const timeoutMs = Number.isFinite(requested) && requested > 0
      ? Math.min(Math.floor(requested), FOREGROUND_SHELL_MAX_TIMEOUT_MS)
      : FOREGROUND_SHELL_MAX_TIMEOUT_MS;
    next.timeout_ms = timeoutMs;
    return {
      action: 'handoff',
      tool: name,
      input: next,
      reason: `foreground shell timeout clamped to ${FOREGROUND_SHELL_MAX_TIMEOUT_MS}ms`,
    };
  }

  return { action: 'permit', tool: name, input };
}

function isDetachOutcome(value: unknown): value is ForegroundDetachOutcome {
  return Boolean(value) && typeof value === 'object' && 'created' in (value as object);
}

export function foregroundDetachRefusal(
  decision: ForegroundToolDecision,
  outcome?: ForegroundDetachOutcome | void,
): string {
  if (isDetachOutcome(outcome) && outcome.created) {
    return [
      `Foreground policy: ${decision.tool} was handed off.`,
      decision.reason ?? 'This operation must become durable Work before execution.',
      'A Working Thread was created and is running separately from this conversation.',
      'Use work_list only to inspect Work that is already active.',
    ].join(' ');
  }
  const missing = isDetachOutcome(outcome) && !outcome.created && outcome.missing.length > 0
    ? `missing: ${outcome.missing.join(', ')}.`
    : 'required coordination facts or ports are missing.';
  return [
    `Foreground policy: ${decision.tool} was not started.`,
    decision.reason ?? 'This operation must become durable Work before execution.',
    `Detach did not create Work; ${missing}`,
    'Do not claim this assignment exists as Work.',
    'Use work_list only to inspect Work that is already active.',
  ].join(' ');
}
