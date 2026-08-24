import type { Request, Response, RequestHandler } from 'express';
import express from 'express';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import type { AgentLoop } from '../agent/loop.js';
import type { ConversationHistory, HistoryRecord, StoredMessage } from '../agent/history.js';
import { isSafeConversationChatId } from '../chat/conversation-metadata.js';
import { VOICE_BLOCK } from '../agents/voice.js';

const REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
const REALTIME_WS_BASE = 'wss://api.openai.com/v1/realtime';
const SDP_MAX_BYTES = 64 * 1024;
const INSTRUCTIONS_MAX_CHARS = 12_000;
const CONSULT_QUESTION_MAX = 4000;
const DEFAULT_MAX_ACTIVE_SESSIONS = 8;
const SESSION_IDLE_MS = 30 * 60_000;
const VOICE_CONSULT_FAILURE_ANSWER = 'Home23 could not obtain a reliable answer promptly. Please try again.';
const VOICE_CONSULT_TURN_OPTIONS = {
  modelOverride: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
  effort: 'low',
  firstTokenTimeoutMs: 8_000,
  inactivityMs: 20_000,
  hardDurationMs: 30_000,
} as const;

export interface RealtimeWebSocketLike {
  on(event: 'open' | 'message' | 'close' | 'error', handler: (...args: unknown[]) => void): void;
  send(data: string): void;
  close(): void;
}

export type WebSocketFactory = (
  url: string,
  options: { headers: Record<string, string> },
) => RealtimeWebSocketLike;

export interface ChatRealtimeConfig {
  agentName: string;
  agent: Pick<AgentLoop, 'runWithTurn'>;
  history: Pick<ConversationHistory, 'load' | 'append'>;
  token?: string;
  openaiApiKey: string;
  fetchImpl?: typeof fetch;
  createWebSocket?: WebSocketFactory;
  maxActiveSessions?: number;
  realtimeCallsUrl?: string;
}

interface ActiveRealtimeSession {
  chatId: string;
  callId: string;
  ws: RealtimeWebSocketLike;
  idleTimer: ReturnType<typeof setTimeout>;
  userTranscriptIds: Set<string>;
  assistantTranscriptIds: Set<string>;
  consultCallIds: Set<string>;
}

const activeByCallId = new Map<string, ActiveRealtimeSession>();
const activeCallIdByChatId = new Map<string, string>();

function checkAuth(req: Request, res: Response, token?: string): boolean {
  if (!token) return true;
  const h = req.headers.authorization;
  if (h === `Bearer ${token}`) return true;
  res.status(401).json({ error: 'Unauthorized' });
  return false;
}

export function createRealtimeSessionTextParser(): RequestHandler {
  return express.text({
    type: ['application/sdp', 'text/plain'],
    limit: SDP_MAX_BYTES,
  });
}

function validateSdp(body: unknown): string | null {
  if (typeof body !== 'string') return null;
  if (!body.trim()) return null;
  if (Buffer.byteLength(body, 'utf8') > SDP_MAX_BYTES) return null;
  return body;
}

function messageText(record: HistoryRecord): string {
  if ('type' in record && record.type === 'session_boundary') return '';
  const msg = record as StoredMessage;
  if (typeof msg.content === 'string') return msg.content.trim();
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text.trim())
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

export function buildRealtimeInstructions(
  agentName: string,
  history: Pick<ConversationHistory, 'load'>,
  chatId: string,
): string {
  const records = history.load(chatId);
  const lines: string[] = [
    `You are ${agentName}, the Home23 voice assistant on a realtime call.`,
    VOICE_BLOCK,
    '',
    'You MUST call consult_home23 immediately for any request needing current state, tools, files, brain lookup, house or device state, or actions.',
    'Do not say you are checking, running, or waiting unless you have actually emitted the function call.',
    'Never invent pending or stuck tool state.',
    'For brief conversation that needs none of those capabilities, answer directly.',
    'Keep spoken replies concise unless the user asks for depth.',
  ];
  const recent: string[] = [];
  for (let i = records.length - 1; i >= 0 && recent.length < 12; i--) {
    const rec = records[i]!;
    if ('type' in rec && rec.type === 'session_boundary') continue;
    const text = messageText(rec);
    if (!text) continue;
    const role = (rec as StoredMessage).role === 'assistant' ? 'Assistant' : 'User';
    recent.unshift(`${role}: ${text.replace(/\s+/g, ' ').slice(0, 800)}`);
  }
  if (recent.length > 0) {
    lines.push('', 'Recent chat context:', ...recent);
  }
  let out = lines.join('\n');
  if (out.length > INSTRUCTIONS_MAX_CHARS) {
    out = out.slice(0, INSTRUCTIONS_MAX_CHARS);
  }
  return out;
}

export function buildRealtimeSessionPayload(instructions: string): Record<string, unknown> {
  return {
    type: 'realtime',
    model: 'gpt-realtime-2.1',
    instructions,
    audio: {
      input: {
        transcription: { model: 'gpt-live-transcribe' },
        turn_detection: { type: 'semantic_vad' },
      },
      output: { voice: 'marin' },
    },
    tool_choice: 'auto',
    tools: [{
      type: 'function',
      name: 'consult_home23',
      description: 'Ask the full Home23 agent (tools, brain, files) a focused question and return the answer for speech.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'Focused question for the Home23 agent.' },
        },
        required: ['question'],
        additionalProperties: false,
      },
    }],
  };
}

function extractCallIdFromLocation(location: string | null | undefined): string | null {
  if (!location) return null;
  const match = location.match(/calls\/([^/?#\s]+)/i);
  return match?.[1] ?? null;
}

function safetyIdentifier(agentName: string, chatId: string): string {
  return createHash('sha256').update(`${agentName}:${chatId}`).digest('hex');
}

function defaultWebSocketFactory(url: string, options: { headers: Record<string, string> }): RealtimeWebSocketLike {
  return new WebSocket(url, { headers: options.headers }) as unknown as RealtimeWebSocketLike;
}

function diagnosticToken(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value) ? value : 'invalid';
}

function logSideband(
  level: 'info' | 'warn' | 'error',
  event: string,
  sessionCallId: string,
  details = '',
): void {
  const line = `[chat-realtime] ${event} session_call_id=${diagnosticToken(sessionCallId)}${details ? ` ${details}` : ''}`;
  console[level](line);
}

function buildVoiceConsultPrompt(question: string): string {
  return [
    'This is a realtime voice tool consult. Treat it as a one-shot request.',
    'Use tools immediately. Do not narrate progress. Do not use TTS. Do not claim or report work as pending or running.',
    'Do not start durable or background work, and use at most 2 tool calls.',
    'Return one concise factual answer. If current state cannot be obtained promptly, say that plainly.',
    '',
    'Actual user question:',
    question,
  ].join('\n');
}

function isExactSessionActive(session: ActiveRealtimeSession): boolean {
  return activeByCallId.get(session.callId) === session;
}

function clearSession(callId: string, closeSocket = true): void {
  const session = activeByCallId.get(callId);
  if (!session) return;
  clearTimeout(session.idleTimer);
  activeByCallId.delete(callId);
  if (activeCallIdByChatId.get(session.chatId) === callId) {
    activeCallIdByChatId.delete(session.chatId);
  }
  if (closeSocket) {
    try { session.ws.close(); } catch { /* ignore */ }
  }
}

function touchSession(session: ActiveRealtimeSession): void {
  clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => clearSession(session.callId), SESSION_IDLE_MS);
}

function persistOnce(
  session: ActiveRealtimeSession,
  config: ChatRealtimeConfig,
  role: 'user' | 'assistant',
  dedupeId: string,
  text: string,
): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const bucket = role === 'user' ? session.userTranscriptIds : session.assistantTranscriptIds;
  if (bucket.has(dedupeId)) return;
  bucket.add(dedupeId);
  config.history.append(session.chatId, [{ role, content: trimmed }]);
  touchSession(session);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function handleConsultHome23(
  session: ActiveRealtimeSession,
  config: ChatRealtimeConfig,
  callId: string,
  rawArgs: string,
  source: string,
): Promise<void> {
  if (session.consultCallIds.has(callId)) return;
  session.consultCallIds.add(callId);

  let question = '';
  let invalidReason = 'missing_question';
  try {
    const parsed: unknown = JSON.parse(rawArgs);
    if (isRecord(parsed) && typeof parsed.question === 'string') {
      question = parsed.question.trim();
      invalidReason = question.length > CONSULT_QUESTION_MAX ? 'question_too_long' : 'missing_question';
    } else {
      invalidReason = 'invalid_arguments';
    }
  } catch {
    invalidReason = 'invalid_arguments_json';
  }
  if (!question || question.length > CONSULT_QUESTION_MAX) {
    logSideband(
      'warn',
      'function_call_malformed',
      session.callId,
      `function_call_id=${diagnosticToken(callId)} source=${diagnosticToken(source)} reason=${invalidReason}`,
    );
    session.ws.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify({ error: 'invalid question' }),
      },
    }));
    session.ws.send(JSON.stringify({ type: 'response.create' }));
    touchSession(session);
    return;
  }

  logSideband(
    'info',
    'function_call_dispatch',
    session.callId,
    `function_call_id=${diagnosticToken(callId)} source=${diagnosticToken(source)}`,
  );

  const consultChatId = `voice-consult:${session.callId}`;
  const startedAtMs = Date.now();
  let answer = VOICE_CONSULT_FAILURE_ANSWER;
  let status: 'success' | 'failure' = 'failure';
  try {
    const prompt = buildVoiceConsultPrompt(question);
    const { response } = await config.agent.runWithTurn(consultChatId, prompt, VOICE_CONSULT_TURN_OPTIONS);
    const result = await response;
    const text = result.text?.trim();
    if (text) {
      answer = text;
      status = 'success';
    }
  } catch {
    // The realtime model receives only the stable user-safe answer above.
  }

  const elapsedMs = Math.max(0, Date.now() - startedAtMs);
  logSideband(
    status === 'success' ? 'info' : 'warn',
    'function_call_complete',
    session.callId,
    `function_call_id=${diagnosticToken(callId)} source=${diagnosticToken(source)} status=${status} elapsed_ms=${elapsedMs}`,
  );

  if (!isExactSessionActive(session)) {
    logSideband(
      'warn',
      'function_call_result_dropped',
      session.callId,
      `function_call_id=${diagnosticToken(callId)} source=${diagnosticToken(source)} status=${status} elapsed_ms=${elapsedMs} reason=session_inactive`,
    );
    return;
  }

  session.ws.send(JSON.stringify({
    type: 'conversation.item.create',
    item: {
      type: 'function_call_output',
      call_id: callId,
      output: JSON.stringify({ answer }),
    },
  }));
  session.ws.send(JSON.stringify({ type: 'response.create' }));
  touchSession(session);
}

function dispatchRealtimeFunctionCall(
  session: ActiveRealtimeSession,
  config: ChatRealtimeConfig,
  source: string,
  candidate: Record<string, unknown>,
  allowMissingName: boolean,
): void {
  const hasName = Object.prototype.hasOwnProperty.call(candidate, 'name');
  if (hasName && (typeof candidate.name !== 'string' || !candidate.name)) {
    logSideband('warn', 'function_call_malformed', session.callId,
      `source=${diagnosticToken(source)} reason=invalid_name`);
    return;
  }
  if (!hasName && !allowMissingName) {
    logSideband('warn', 'function_call_malformed', session.callId,
      `source=${diagnosticToken(source)} reason=missing_name`);
    return;
  }
  if (hasName && candidate.name !== 'consult_home23') {
    logSideband('warn', 'function_call_ignored', session.callId,
      `source=${diagnosticToken(source)} reason=unknown_tool tool=${diagnosticToken(candidate.name)}`);
    return;
  }
  if (
    Object.prototype.hasOwnProperty.call(candidate, 'status')
    && candidate.status !== undefined
    && candidate.status !== 'completed'
  ) {
    logSideband('warn', 'function_call_ignored', session.callId,
      `source=${diagnosticToken(source)} reason=incomplete status=${diagnosticToken(candidate.status)}`);
    return;
  }

  const functionCallId = typeof candidate.call_id === 'string' ? candidate.call_id : '';
  const args = typeof candidate.arguments === 'string' ? candidate.arguments : '';
  if (!functionCallId || !args) {
    const reason = !functionCallId ? 'missing_call_id' : 'missing_arguments';
    logSideband('warn', 'function_call_malformed', session.callId,
      `source=${diagnosticToken(source)} reason=${reason}`);
    return;
  }
  if (session.consultCallIds.has(functionCallId)) {
    logSideband('info', 'function_call_ignored', session.callId,
      `function_call_id=${diagnosticToken(functionCallId)} source=${diagnosticToken(source)} reason=duplicate`);
    return;
  }

  void handleConsultHome23(session, config, functionCallId, args, source);
}

function attachSideband(config: ChatRealtimeConfig, chatId: string, callId: string, apiKey: string): void {
  const priorCallId = activeCallIdByChatId.get(chatId);
  if (priorCallId && priorCallId !== callId) {
    clearSession(priorCallId);
  }

  const wsFactory = config.createWebSocket ?? defaultWebSocketFactory;
  const ws = wsFactory(`${REALTIME_WS_BASE}?call_id=${encodeURIComponent(callId)}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'OpenAI-Beta': 'realtime=v1',
    },
  });

  const session: ActiveRealtimeSession = {
    chatId,
    callId,
    ws,
    idleTimer: setTimeout(() => clearSession(callId), SESSION_IDLE_MS),
    userTranscriptIds: new Set(),
    assistantTranscriptIds: new Set(),
    consultCallIds: new Set(),
  };
  activeByCallId.set(callId, session);
  activeCallIdByChatId.set(chatId, callId);

  ws.on('open', () => {
    if (activeByCallId.get(callId) === session) {
      logSideband('info', 'sideband_open', callId);
    }
  });

  ws.on('message', (raw: unknown) => {
    const current = activeByCallId.get(callId);
    if (!current) return;
    let event: Record<string, unknown>;
    try {
      const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
      event = JSON.parse(text) as Record<string, unknown>;
    } catch {
      logSideband('warn', 'sideband_event_malformed', callId, 'reason=invalid_json');
      return;
    }
    const type = typeof event.type === 'string' ? event.type : '';
    if (type === 'conversation.item.input_audio_transcription.completed') {
      const itemId = typeof event.item_id === 'string'
        ? event.item_id
        : typeof event.event_id === 'string'
          ? event.event_id
          : '';
      const transcript = typeof event.transcript === 'string' ? event.transcript : '';
      if (itemId && transcript.trim()) {
        persistOnce(current, config, 'user', itemId, transcript);
      }
      return;
    }
    if (type === 'response.output_audio_transcript.done') {
      const itemId = typeof event.item_id === 'string'
        ? event.item_id
        : typeof event.response_id === 'string'
          ? event.response_id
          : typeof event.event_id === 'string'
            ? event.event_id
            : '';
      const transcript = typeof event.transcript === 'string' ? event.transcript : '';
      if (itemId && transcript.trim()) {
        persistOnce(current, config, 'assistant', itemId, transcript);
      }
      return;
    }
    if (type === 'response.function_call_arguments.done') {
      dispatchRealtimeFunctionCall(current, config, type, event, true);
      return;
    }
    if (type === 'response.output_item.done') {
      if (!isRecord(event.item)) {
        logSideband('warn', 'sideband_event_malformed', callId,
          'source=response.output_item.done reason=missing_item');
        return;
      }
      if (event.item.type === 'function_call') {
        dispatchRealtimeFunctionCall(current, config, type, event.item, false);
      }
      return;
    }
    if (type === 'response.done') {
      if (!isRecord(event.response) || !Array.isArray(event.response.output)) {
        logSideband('warn', 'sideband_event_malformed', callId,
          'source=response.done reason=missing_output');
        return;
      }
      for (const item of event.response.output) {
        if (isRecord(item) && item.type === 'function_call') {
          dispatchRealtimeFunctionCall(current, config, type, item, false);
        }
      }
    }
  });

  ws.on('close', (...args: unknown[]) => {
    if (!activeByCallId.has(callId)) return;
    const code = typeof args[0] === 'number' ? ` code=${args[0]}` : '';
    logSideband('info', 'sideband_close', callId, code.trim());
    clearSession(callId, false);
  });
  ws.on('error', () => {
    if (!activeByCallId.has(callId)) return;
    logSideband('error', 'sideband_error', callId);
    clearSession(callId);
  });
}

function mapUpstreamError(status: number, bodyText: string): { status: number; error: string; code?: string } {
  let parsed: { error?: { message?: string; type?: string; code?: string } } = {};
  try {
    parsed = JSON.parse(bodyText) as typeof parsed;
  } catch { /* ignore */ }
  const upstreamMsg = parsed.error?.message?.replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]') ?? '';
  if (status === 401 || status === 403) {
    return { status: 502, error: 'OpenAI realtime authentication failed', code: 'upstream_auth' };
  }
  if (status === 429) {
    return { status: 503, error: 'OpenAI realtime rate limited', code: 'upstream_rate_limit' };
  }
  if (status >= 500) {
    return { status: 502, error: 'OpenAI realtime unavailable', code: 'upstream_error' };
  }
  return {
    status: 502,
    error: upstreamMsg ? `OpenAI realtime rejected request: ${upstreamMsg.slice(0, 200)}` : 'OpenAI realtime rejected request',
    code: parsed.error?.code ?? parsed.error?.type ?? 'upstream_rejected',
  };
}

/** POST /api/chat/realtime/session?chatId=X — WebRTC SDP offer → SDP answer + sideband monitor. */
export function createRealtimeSessionHandler(config: ChatRealtimeConfig) {
  const fetchImpl = config.fetchImpl ?? fetch;
  const maxActive = config.maxActiveSessions ?? DEFAULT_MAX_ACTIVE_SESSIONS;
  const callsUrl = config.realtimeCallsUrl ?? REALTIME_CALLS_URL;

  return async (req: Request, res: Response): Promise<void> => {
    if (!checkAuth(req, res, config.token)) return;

    const chatId = String(req.query.chatId ?? '').trim();
    if (!isSafeConversationChatId(chatId)) {
      res.status(400).json({ error: 'invalid chatId' });
      return;
    }

    const sdp = validateSdp(req.body);
    if (!sdp) {
      res.status(400).json({ error: 'nonempty SDP body required' });
      return;
    }

    const apiKey = config.openaiApiKey.trim();
    if (!apiKey) {
      res.status(503).json({ error: 'OpenAI API key not configured', code: 'openai_key_missing' });
      return;
    }

    if (activeByCallId.size >= maxActive) {
      res.status(503).json({ error: 'too many active realtime sessions', code: 'session_cap' });
      return;
    }

    const instructions = buildRealtimeInstructions(config.agentName, config.history, chatId);
    const sessionPayload = buildRealtimeSessionPayload(instructions);
    const form = new FormData();
    form.append('sdp', sdp);
    form.append('session', JSON.stringify(sessionPayload));

    let upstream: globalThis.Response;
    try {
      upstream = await fetchImpl(callsUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'OpenAI-Safety-Identifier': safetyIdentifier(config.agentName, chatId),
        },
        body: form,
      });
    } catch {
      res.status(502).json({ error: 'failed to reach OpenAI realtime', code: 'upstream_unreachable' });
      return;
    }

    const answerSdp = await upstream.text();
    if (!upstream.ok) {
      const mapped = mapUpstreamError(upstream.status, answerSdp);
      res.status(mapped.status).json({ error: mapped.error, code: mapped.code });
      return;
    }

    const callId = extractCallIdFromLocation(upstream.headers.get('location'));
    if (!callId) {
      res.status(502).json({ error: 'OpenAI realtime missing call id', code: 'upstream_call_id' });
      return;
    }

    res.setHeader('Content-Type', 'application/sdp');
    res.setHeader('X-Home23-Realtime-Call-ID', callId);
    res.status(200).send(answerSdp);

    try {
      attachSideband(config, chatId, callId, apiKey);
    } catch {
      logSideband('error', 'sideband_error', callId, 'phase=attach');
      clearSession(callId);
    }
  };
}

/** Test hook: reset module session state. */
export function _resetRealtimeSessionsForTests(): void {
  for (const callId of [...activeByCallId.keys()]) {
    clearSession(callId);
  }
}
