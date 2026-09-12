import WebSocket from 'ws';

const LIVE_SESSIONS_URL = 'https://api.openai.com/v1/live/sessions';
const MAX_EVENT_BYTES = 1_048_576;

export interface GptLiveEvent {
  type: string;
  [key: string]: unknown;
}

export interface GptLiveCloseResult {
  finalized: boolean;
  reason: string;
  /** Last observed cumulative usage; final only when finalized is true. */
  usageSeconds?: number;
  /** HTTP hangup acceptance is not a substitute for session.closed. */
  hangupAcknowledged?: boolean;
}

export interface GptLiveConnection {
  sessionId: string;
  answerSdp: string;
  send(event: GptLiveEvent): void;
  close(): Promise<GptLiveCloseResult>;
}

export type GptLiveSocket = Pick<WebSocket, 'on' | 'send' | 'close' | 'terminate' | 'readyState'>;

export interface GptLiveSessionOptions {
  apiKey: string;
  sdp: string;
  instructions: string;
  input?: Array<{ role: 'user' | 'assistant'; text: string }>;
  voice?: string;
  onEvent(event: GptLiveEvent): void | Promise<void>;
  onDisconnect?(result: GptLiveCloseResult): void;
  fetch?: typeof globalThis.fetch;
  webSocketFactory?: (url: string, options: WebSocket.ClientOptions) => GptLiveSocket;
  requestTimeoutMs?: number;
  attachTimeoutMs?: number;
  closeTimeoutMs?: number;
  hangupTimeoutMs?: number;
}

/** Safe to expose to callers: deliberately excludes upstream response text/cause. */
export class GptLiveProviderError extends Error {
  constructor(public readonly code: string, public readonly status?: number) {
    super(`GPT-Live ${code.replaceAll('_', ' ')}${status ? ` (${status})` : ''}`);
    this.name = 'GptLiveProviderError';
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.min(value, 120_000) : fallback;
}

function usageSeconds(event: GptLiveEvent): number | undefined {
  const seconds = record(event.usage)?.seconds;
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

// The browser owns media and captions. Only the trusted sideband can supply
// instructions, backend results, or delegate work. Permissions are startup-only.
const FRONTEND_CLIENT_EVENTS = ['session.close', 'session.input_audio.mute', 'session.input_audio.unmute'];
const FRONTEND_SERVER_EVENTS = [
  'session.started', 'session.closed', 'session.input_transcript.delta',
  'session.output_transcript.delta', 'session.usage.updated',
  'session.delegation.created',
  'session.input_audio.muted', 'session.input_audio.unmuted', 'error',
];

/**
 * Create WebRTC media and attach our private control connection before returning
 * the SDP answer. This transport does not own resident work or retry side effects.
 * Schema: https://developers.openai.com/api/reference/resources/live/methods/create
 */
export async function createGptLiveWebRtcSession(options: GptLiveSessionOptions): Promise<GptLiveConnection> {
  if (!options.apiKey.trim()) throw new GptLiveProviderError('missing_api_key');
  if (!options.sdp.trim() || Buffer.byteLength(options.sdp) > 65_536) {
    throw new GptLiveProviderError('invalid_sdp');
  }
  if ((options.input?.length ?? 0) > 128) throw new GptLiveProviderError('history_limit_exceeded');
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const requestTimeout = positiveTimeout(options.requestTimeoutMs, 20_000);
  const attachTimeout = positiveTimeout(options.attachTimeoutMs, 15_000);
  const closeTimeout = positiveTimeout(options.closeTimeoutMs, 2_500);
  const hangupTimeout = positiveTimeout(options.hangupTimeoutMs, 2_000);
  const authorization = { Authorization: `Bearer ${options.apiKey}` };

  async function request(url: string, body?: unknown, timeoutMs = requestTimeout): Promise<unknown> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new GptLiveProviderError('request_timeout'));
      }, timeoutMs);
      timeout.unref();
    });
    try {
      return await Promise.race([(async () => {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: { ...authorization, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal,
          redirect: 'error',
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new GptLiveProviderError('request_rejected', response.status);
        }
        if (body === undefined) {
          await response.body?.cancel().catch(() => {});
          return undefined;
        }
        return await response.json();
      })(), expired]);
    } catch (error) {
      if (error instanceof GptLiveProviderError) throw error;
      throw new GptLiveProviderError('request_failed');
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  const created = record(await request(LIVE_SESSIONS_URL, {
    session: {
      model: 'gpt-live-1',
      delegation: { type: 'client' },
      instructions: options.instructions,
      store: false,
      ...(options.voice ? { audio: { output: { voice: options.voice } } } : {}),
      ...(options.input?.length ? {
        input: options.input.map(message => ({
          type: 'message', role: message.role,
          content: [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: message.text }],
        })),
      } : {}),
      client: { data_channel: {
        allowed_client_events: FRONTEND_CLIENT_EVENTS,
        allowed_server_events: FRONTEND_SERVER_EVENTS.map(type => ({ type })),
      } },
    },
    transport: { type: 'webrtc', sdp: options.sdp },
  }));
  const sessionId = record(created?.session)?.id;
  const answerSdp = record(created?.transport)?.sdp;
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 2_048) {
    throw new GptLiveProviderError('invalid_session_response');
  }
  // Preserve opaque IDs; encode only the URL path component, never infer a prefix.
  const sessionUrl = `${LIVE_SESSIONS_URL}/${encodeURIComponent(sessionId)}`;
  let hangupPromise: Promise<boolean> | undefined;
  const hangup = (): Promise<boolean> => hangupPromise ??= request(`${sessionUrl}/hangup`, undefined, hangupTimeout)
    .then(() => true, () => false);
  if (typeof answerSdp !== 'string' || !answerSdp.trim()) {
    await hangup();
    throw new GptLiveProviderError('invalid_session_response');
  }

  let socket: GptLiveSocket;
  try {
    socket = (options.webSocketFactory ?? ((url, config) => new WebSocket(url, config)))(
      `${sessionUrl.replace('https:', 'wss:')}/attach`,
      { headers: authorization, handshakeTimeout: attachTimeout, maxPayload: MAX_EVENT_BYTES },
    );
  } catch {
    await hangup();
    throw new GptLiveProviderError('attach_failed');
  }

  let opened = false;
  let closing = false;
  let result: GptLiveCloseResult | undefined;
  let latestUsage: number | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveClosed!: (value: GptLiveCloseResult) => void;
  const closed = new Promise<GptLiveCloseResult>(resolve => { resolveClosed = resolve; });
  let resolveAttached!: () => void;
  let rejectAttached!: (error: GptLiveProviderError) => void;
  const attached = new Promise<void>((resolve, reject) => {
    resolveAttached = resolve;
    rejectAttached = reject;
  });
  const attachTimer = setTimeout(() => fail('attach_timeout'), attachTimeout);
  attachTimer.unref();

  function finish(final: GptLiveCloseResult): void {
    if (result) return;
    result = final;
    clearTimeout(attachTimer);
    if (closeTimer) clearTimeout(closeTimer);
    // Finalization has already drained provider events, or has failed explicitly.
    // Terminate avoids ws's additional 30-second close handshake resource timer.
    socket.terminate();
    const notify = () => {
      resolveClosed(final);
      if (!closing) {
        try { options.onDisconnect?.(final); } catch { /* consumer owns its diagnostics */ }
      }
    };
    if (final.finalized) notify();
    else void hangup().then(acknowledged => { final.hangupAcknowledged = acknowledged; notify(); });
  }

  function fail(reason: string): void {
    if (result) return;
    if (!opened) rejectAttached(new GptLiveProviderError(reason));
    finish({ finalized: false, reason, ...(latestUsage === undefined ? {} : { usageSeconds: latestUsage }) });
  }

  socket.on('open', () => {
    if (result) return;
    opened = true;
    clearTimeout(attachTimer);
    resolveAttached();
  });
  socket.on('error', () => fail(opened ? 'connection_failed' : 'attach_failed'));
  socket.on('close', () => fail(opened ? 'connection_closed' : 'attach_failed'));
  socket.on('message', (data: WebSocket.RawData) => {
    if (result) return;
    let parsed: Record<string, unknown> | undefined;
    try { parsed = record(JSON.parse(data.toString())); } catch { fail('invalid_server_event'); return; }
    if (!parsed || typeof parsed.type !== 'string') { fail('invalid_server_event'); return; }
    let event = parsed as GptLiveEvent;
    if (event.type === 'session.usage.updated' || event.type === 'session.closed') {
      latestUsage = usageSeconds(event) ?? latestUsage;
    }
    if (event.type === 'session.closed') {
      const reasons = ['close_requested', 'expired', 'content', 'remote_hangup', 'connection_lost'];
      finish({
        finalized: true,
        reason: typeof event.reason === 'string' && reasons.includes(event.reason) ? event.reason : 'closed',
        ...(latestUsage === undefined ? {} : { usageSeconds: latestUsage }),
      });
    }
    // Keep reflected audio out of application event/history queues: WebRTC owns it.
    if (event.type === 'session.input_audio.append' || event.type === 'session.output_audio.delta') return;
    if (event.type === 'error') {
      const detail = record(event.error);
      event = {
        type: 'error',
        error: {
          message: 'GPT-Live rejected a session command.',
          ...Object.fromEntries(['type', 'code', 'client_event_id'].flatMap(key => {
            const value = detail?.[key];
            return typeof value === 'string' && !value.includes(options.apiKey)
              && /^[a-zA-Z0-9_.:-]{1,512}$/.test(value) ? [[key, value]] : [];
          })),
        },
      };
    }
    try {
      Promise.resolve(options.onEvent(event)).catch(() => fail('event_handler_failed'));
    } catch { fail('event_handler_failed'); }
  });

  try { await attached; } catch (error) {
    await hangup();
    throw error;
  }
  if (result) {
    await closed;
    throw new GptLiveProviderError('connection_closed_during_attach');
  }

  return {
    sessionId,
    answerSdp,
    send(event) {
      if (closing || result || socket.readyState !== WebSocket.OPEN) {
        throw new GptLiveProviderError('connection_unavailable');
      }
      if (event.type === 'session.start' || event.type === 'session.input_audio.append' || event.type === 'session.close') {
        throw new GptLiveProviderError('invalid_sideband_command');
      }
      try {
        socket.send(JSON.stringify(event), error => { if (error) fail('send_failed'); });
      } catch { fail('send_failed'); throw new GptLiveProviderError('send_failed'); }
    },
    close() {
      if (closing || result) return closed;
      closing = true;
      closeTimer = setTimeout(() => fail('close_timeout'), closeTimeout);
      closeTimer.unref();
      try {
        socket.send(JSON.stringify({ type: 'session.close' }), error => { if (error) fail('send_failed'); });
      } catch { fail('send_failed'); }
      return closed;
    },
  };
}
