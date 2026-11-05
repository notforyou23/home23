import { plannedRecoveryPolicy } from '../agent/operation-work-policy.js';
import { classifyForegroundTool } from '../agent/foreground-tool-policy.js';
import type { CoordinationTurnOrigin } from '../agent/types.js';
import { ResidentProtocolError, type JsonValue } from '../coordination/resident-protocol/index.js';

export interface PlannedToolExecution {
  kind: 'planned_tool';
  invocationId: string;
  toolName: string;
  canonicalArgs: Record<string, JsonValue>;
  executionInstruction: string;
  title: string;
  recoveryPolicy: 'safe_before_start' | 'idempotent_operation' | 'idempotent_bot_invocation';
}
export interface ForegroundDetachmentRequest extends Omit<PlannedToolExecution, 'kind'> {
  parentOrigin: CoordinationTurnOrigin;
  residentSlug: string;
  summary: string;
}
export interface ForegroundDetachmentAck { accepted: true; workId: string; invocationId: string }
const invalid = (): never => { throw new ResidentProtocolError('request_invalid', 'invalid planned invocation'); };
function bounded(value: unknown, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value) > limit) return invalid();
  return value;
}
export function canonicalToolArguments(value: unknown): Record<string, JsonValue> {
  const visit = (v: unknown, depth: number): JsonValue => {
    if (depth > 24) return invalid();
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (Array.isArray(v)) return v.map(x => visit(x, depth + 1));
    if (!v || typeof v !== 'object' || Object.getPrototypeOf(v) !== Object.prototype) return invalid();
    return Object.fromEntries(Object.keys(v).sort().map(k => [k, visit((v as Record<string, unknown>)[k], depth + 1)]));
  };
  if (!value || Array.isArray(value) || typeof value !== 'object') return invalid();
  const result = visit(value, 0) as Record<string, JsonValue>;
  if (Buffer.byteLength(JSON.stringify(result)) > 65_536) return invalid();
  return result;
}
export function parsePlannedToolExecution(raw: unknown): PlannedToolExecution {
  const v = raw as PlannedToolExecution;
  if (!v || v.kind !== 'planned_tool' || v.recoveryPolicy !== plannedRecoveryPolicy(v.toolName) || classifyForegroundTool(v.toolName) !== 'require_work') return invalid();
  return { kind: 'planned_tool', invocationId: bounded(v.invocationId, 256), toolName: bounded(v.toolName, 128), canonicalArgs: canonicalToolArguments(v.canonicalArgs), executionInstruction: bounded(v.executionInstruction, 16_384), title: bounded(v.title, 280), recoveryPolicy: v.recoveryPolicy };
}
export function parseForegroundDetachmentRequest(raw: unknown): ForegroundDetachmentRequest {
  const v = raw as ForegroundDetachmentRequest;
  if (!v || !v.parentOrigin || v.parentOrigin.kind !== 'coordination') return invalid();
  const { kind: _, ...planned } = parsePlannedToolExecution({ ...v, kind: 'planned_tool' });
  const o = v.parentOrigin;
  for (const key of ['workId','attemptId','leaseId','holderPrincipalId','holderInstanceId','authorityReference','channelId'] as const) bounded(o[key], 512);
  if (!Number.isSafeInteger(o.fencingToken) || o.fencingToken < 1) return invalid();
  if (o.originMessageId !== null) bounded(o.originMessageId, 256);
  if (o.roundId !== null) bounded(o.roundId, 256);
  return { ...planned, parentOrigin: { ...o }, residentSlug: bounded(v.residentSlug, 63), summary: bounded(v.summary, 1000) };
}
