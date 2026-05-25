import type { CronJob, JobResult } from '../scheduler/cron.js';

const URL_RE = /\bhttps?:\/\/\S+/i;
const STRUCTURAL_RE = /\b(agency|evolve|step28|resident|spine|pursuit|fix|build|change|broken|wrong|timeline|research|newsletter|cron)\b/i;
const CORRECTION_RE = /\b(correction|that's wrong|that is wrong|you are wrong|not true|actually)\b/i;
const INTAKE_SCHEMA = 'home23.agency.intake-packet.v1';

export interface AgencyWorldStreamPacket {
  source: string;
  kind: string;
  summary: string;
  seen: string[];
  discarded: Array<{ ref: string; reason: string }>;
  explicitNoChange?: boolean;
  pursuitId?: string;
  consequenceStatus?: string;
  changedFuture?: string;
  desiredChangedFuture?: string;
  nextMove?: string;
  claim?: {
    claim: string;
    sourceType: string;
    sourceRef?: string;
    contradicts?: string;
  };
  actionWorthy?: Array<Record<string, unknown>>;
  watchItems?: Array<Record<string, unknown>>;
  contradictions?: Array<Record<string, unknown>>;
  evidence: Array<{ type: string; ref: string }>;
  tags: string[];
}

export interface WorldStreamMessage {
  channel: string;
  chatId: string;
  text?: string;
  timestamp?: number;
  messageId?: string;
  id?: string;
}

export interface WorldStreamResponse {
  text?: string;
}

interface ReportIntakePacket {
  schema?: string;
  summary?: string;
  actionWorthy?: Array<Record<string, unknown>>;
  watchItems?: Array<Record<string, unknown>>;
  contradictions?: Array<Record<string, unknown>>;
  discardedNoise?: Array<{ ref?: string; reason?: string }>;
  explicitNoChange?: boolean;
  desiredChangedFuture?: string;
  nextMove?: string;
  tags?: string[];
}

function messageReference(message: WorldStreamMessage): string {
  return [message.channel, message.chatId, message.messageId || message.id || message.timestamp].filter(Boolean).join(':');
}

function readBalancedJsonAfterMarker(text: string, marker: string): string | null {
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return null;
  const start = text.indexOf('{', markerIndex + marker.length);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = inString;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function readFirstBalancedJson(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = inString;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function extractReportIntakePacket(text: string): ReportIntakePacket | null {
  const fromMarker = readBalancedJsonAfterMarker(text, 'AGENCY_INTAKE_PACKET');
  const jsonText = fromMarker || (text.includes(INTAKE_SCHEMA) ? readFirstBalancedJson(text) : null);
  if (!jsonText) return null;
  try {
    const parsed = JSON.parse(jsonText) as ReportIntakePacket;
    if (parsed && parsed.schema === INTAKE_SCHEMA) return parsed;
  } catch {
    return null;
  }
  return null;
}

function packetItemsText(label: string, items: Array<Record<string, unknown>> | undefined): string[] {
  if (!Array.isArray(items) || items.length === 0) return [];
  return items.map((item, index) => {
    const summary = typeof item.summary === 'string'
      ? item.summary
      : typeof item.title === 'string'
        ? item.title
        : JSON.stringify(item);
    return `${label} ${index + 1}: ${summary}`;
  });
}

export function buildIncomingMessagePacket(message: WorldStreamMessage, text = message.text): AgencyWorldStreamPacket {
  const clean = String(text || '').trim();
  const hasLink = URL_RE.test(clean);
  const structural = STRUCTURAL_RE.test(clean);
  const correction = CORRECTION_RE.test(clean);
  const messageRef = messageReference(message);
  if (correction) {
    const claimText = clean.replace(/^\s*(correction|actually)\s*[:,-]?\s*/i, '').trim() || clean;
    return {
      source: `${message.channel}.message`,
      kind: 'operator_correction',
      summary: `${message.channel} correction: ${claimText.slice(0, 240)}`,
      seen: clean ? [clean.slice(0, 2000)] : [],
      discarded: [],
      explicitNoChange: false,
      desiredChangedFuture: 'Resident truth hierarchy records the correction as a durable claim and demotes weaker contradicted claims when linked.',
      nextMove: 'record jtr correction into source-of-truth hierarchy and surface any unresolved contradiction',
      claim: {
        claim: claimText,
        sourceType: 'jtr_correction',
        sourceRef: messageRef,
      },
      evidence: [{ type: 'message', ref: messageRef }],
      tags: ['world-stream', 'conversation', 'correction', message.channel],
    };
  }
  return {
    source: `${message.channel}.message`,
    kind: hasLink ? 'inbound_link' : 'conversation_message',
    summary: `${message.channel} inbound ${hasLink ? 'link/message' : 'message'}: ${clean.slice(0, 240)}`,
    seen: clean ? [clean.slice(0, 2000)] : [],
    discarded: [],
    explicitNoChange: !hasLink && !structural,
    desiredChangedFuture: hasLink || structural
      ? 'Resident Jerry decides whether this conversation input changes a pursuit, watch item, claim, task, handoff, question, or explicit no-change receipt.'
      : undefined,
    nextMove: hasLink
      ? 'triage link against standing pursuits and source-of-truth hierarchy'
      : structural
        ? 'fold conversation into resident agency state or explicitly reject it'
        : 'record no-change conversation receipt',
    evidence: [{ type: 'message', ref: messageRef }],
    tags: ['world-stream', 'conversation', message.channel],
  };
}

export function buildOutgoingResponsePacket(message: WorldStreamMessage, response: WorldStreamResponse): AgencyWorldStreamPacket {
  const text = String(response.text || '').trim();
  const messageRef = messageReference(message);
  return {
    source: `${message.channel}.response`,
    kind: 'conversation_response',
    summary: `Jerry response to ${message.channel}:${message.chatId}: ${text.slice(0, 240)}`,
    seen: text ? [text.slice(0, 2000)] : [],
    discarded: [],
    explicitNoChange: true,
    nextMove: 'response delivered; resident state changes must be represented by separate pursuit, claim, task, handoff, or delta receipts',
    evidence: [{ type: 'response', ref: messageRef }],
    tags: ['world-stream', 'conversation-response', message.channel],
  };
}

export function buildCronResultPacket(job: CronJob, result: JobResult): AgencyWorldStreamPacket {
  const payload = job.payload as Record<string, unknown>;
  const response = String(result.response || result.error || '').trim();
  const pursuitId = typeof job.agency?.pursuitId === 'string' ? job.agency.pursuitId : undefined;
  const intakePacket = extractReportIntakePacket(response);
  const packetSeen = intakePacket
    ? [
        ...packetItemsText('action', intakePacket.actionWorthy),
        ...packetItemsText('watch', intakePacket.watchItems),
        ...packetItemsText('contradiction', intakePacket.contradictions),
      ]
    : [];
  const packetHasSignal = Boolean(
    intakePacket &&
    (
      (Array.isArray(intakePacket.actionWorthy) && intakePacket.actionWorthy.length > 0) ||
      (Array.isArray(intakePacket.watchItems) && intakePacket.watchItems.length > 0) ||
      (Array.isArray(intakePacket.contradictions) && intakePacket.contradictions.length > 0) ||
      intakePacket.desiredChangedFuture
    ),
  );
  const discarded = intakePacket?.discardedNoise?.map(item => ({
    ref: String(item.ref || 'report_noise'),
    reason: String(item.reason || 'discarded_by_report_intake'),
  })) || [];
  const payloadDeclaresAgencyChange = typeof payload.agencyChangedFuture === 'string' || typeof payload.agencyNextMove === 'string';
  const unboundMechanicalNoChange = !pursuitId && !intakePacket && !payloadDeclaresAgencyChange && result.status === 'ok';
  const explicitNoChange = intakePacket
    ? Boolean(intakePacket.explicitNoChange || !packetHasSignal)
    : (unboundMechanicalNoChange || (!pursuitId && (!response || result.status !== 'ok')));
  const desiredChangedFuture = typeof payload.agencyChangedFuture === 'string'
    ? payload.agencyChangedFuture
    : intakePacket?.desiredChangedFuture
      || (pursuitId ? `Cron outcome updates resident pursuit ${pursuitId} with latest scheduler evidence.` : undefined);
  const nextMove = typeof payload.agencyNextMove === 'string'
    ? payload.agencyNextMove
    : intakePacket?.nextMove
      || (pursuitId
        ? 'attach scheduler outcome to the bound resident pursuit and continue/repair based on semantic status'
        : (unboundMechanicalNoChange ? 'record no-change cron receipt; no resident pursuit or watch item created' : undefined));
  const satisfiedStopCondition = Boolean(pursuitId && result.status === 'ok' && result.semanticStatus === 'satisfied');
  const consequenceStatus = pursuitId
    ? (satisfiedStopCondition ? 'closed' : (result.status === 'ok' && result.semanticStatus !== 'failed' ? 'advanced' : 'failed'))
    : undefined;
  const changedFuture = satisfiedStopCondition
    ? `Cron ${job.id} satisfied the stop condition for resident pursuit ${pursuitId}.`
    : undefined;
  return {
    source: `cron.${job.id}`,
    kind: 'cron_report',
    summary: intakePacket?.summary || `Cron ${job.id} (${payload.kind || 'unknown'}) finished with status ${result.status}.`,
    seen: packetSeen.length ? packetSeen : (response ? [response.slice(0, 2000)] : []),
    discarded,
    explicitNoChange,
    pursuitId,
    consequenceStatus,
    changedFuture,
    desiredChangedFuture,
    nextMove,
    actionWorthy: intakePacket?.actionWorthy,
    watchItems: intakePacket?.watchItems,
    contradictions: intakePacket?.contradictions,
    evidence: [{ type: 'cron_result', ref: job.id }],
    tags: ['world-stream', 'cron', ...(intakePacket?.tags || [])],
  };
}
