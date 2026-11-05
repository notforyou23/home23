'use strict';

const crypto = require('crypto');

function safeClientId(clientId) {
  const normalized = String(clientId || '').trim();
  if (!normalized) {
    throw new Error('client_id is required');
  }
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(normalized)) {
    throw new Error('Invalid client_id format');
  }
  return normalized;
}

function toInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function createTerminalWsProtocol(options = {}) {
  if (!options.sessionManager) {
    throw new Error('sessionManager is required');
  }

  const sessionManager = options.sessionManager;
  const maxIncomingMessageBytes = toInt(options.maxIncomingMessageBytes, 128 * 1024, 512, 2 * 1024 * 1024);
  const queueHighWatermarkBytes = toInt(options.queueHighWatermarkBytes, 256 * 1024, 16 * 1024, 16 * 1024 * 1024);
  const queueLowWatermarkBytes = toInt(options.queueLowWatermarkBytes, 96 * 1024, 8 * 1024, queueHighWatermarkBytes);
  const maxQueuedOutboundBytes = toInt(options.maxQueuedOutboundBytes, 2 * 1024 * 1024, 64 * 1024, 64 * 1024 * 1024);

  function connectionId() {
    return crypto.randomBytes(8).toString('hex');
  }

  function safeSend(state, payload) {
    if (state.closed || state.ws.readyState !== state.ws.OPEN) return;

    let serialized;
    try {
      serialized = JSON.stringify(payload);
    } catch (error) {
      serialized = JSON.stringify({ type: 'error', error: 'Failed to serialize payload' });
    }

    const bytes = Buffer.byteLength(serialized, 'utf8');

    if (state.queue.length > 0 || state.ws.bufferedAmount >= queueHighWatermarkBytes) {
      state.queue.push(serialized);
      state.queueBytes += bytes;

      if (state.queueBytes > maxQueuedOutboundBytes) {
        try {
          if (state.ws.readyState === state.ws.OPEN) {
            state.ws.send(JSON.stringify({
              type: 'error',
              error: 'Outbound queue overflow'
            }));
          }
        } catch (_) {
          // ignore best-effort error send
        }
        closeConnection(state, 1011, 'queue overflow');
        return;
      }

      setBackpressure(state, true);
      ensureFlushLoop(state);
      return;
    }

    try {
      state.ws.send(serialized);
    } catch (error) {
      closeConnection(state, 1011, 'send failed');
    }
  }

  function setBackpressure(state, enabled) {
    if (!state.attachedSessionId) return;
    if (state.backpressured === enabled) return;
    state.backpressured = enabled;

    try {
      sessionManager.setBackpressure(
        state.attachedSessionId,
        state.clientId,
        state.connectionId,
        enabled
      );
    } catch (_) {
      // ignore stale session errors while disconnecting
    }
  }

  function ensureFlushLoop(state) {
    if (state.flushTimer) return;

    state.flushTimer = setInterval(() => {
      if (state.closed || state.ws.readyState !== state.ws.OPEN) {
        stopFlushLoop(state);
        return;
      }

      while (
        state.queue.length > 0 &&
        state.ws.bufferedAmount < queueLowWatermarkBytes &&
        state.ws.readyState === state.ws.OPEN
      ) {
        const serialized = state.queue.shift();
        state.queueBytes -= Buffer.byteLength(serialized, 'utf8');

        try {
          state.ws.send(serialized);
        } catch (error) {
          closeConnection(state, 1011, 'send failed');
          return;
        }
      }

      if (state.queue.length === 0 && state.ws.bufferedAmount < queueLowWatermarkBytes) {
        setBackpressure(state, false);
      }

      if (state.queue.length === 0 && state.ws.bufferedAmount === 0) {
        stopFlushLoop(state);
      }
    }, 20);

    if (typeof state.flushTimer.unref === 'function') {
      state.flushTimer.unref();
    }
  }

  function stopFlushLoop(state) {
    if (!state.flushTimer) return;
    clearInterval(state.flushTimer);
    state.flushTimer = null;
  }

  function detachSession(state) {
    if (!state.attachedSessionId) return;

    setBackpressure(state, false);

    if (typeof state.detachListener === 'function') {
      try {
        state.detachListener();
      } catch (_) {
        // ignore
      }
      state.detachListener = null;
    }

    try {
      sessionManager.unregisterConnection(
        state.attachedSessionId,
        state.clientId,
        state.connectionId
      );
    } catch (_) {
      // ignore stale session cleanup errors
    }

    state.attachedSessionId = null;
  }

  function attachSession(state, sessionId) {
    detachSession(state);

    const attached = sessionManager.attach(sessionId, state.clientId, {
      onData: ({ data, ts }) => {
        safeSend(state, {
          type: 'output',
          session_id: sessionId,
          data,
          ts
        });
      },
      onExit: ({ exit_code, signal, ts }) => {
        safeSend(state, {
          type: 'exit',
          session_id: sessionId,
          exit_code,
          signal,
          ts
        });
      },
      onState: (metadata) => {
        safeSend(state, {
          type: 'state',
          session: metadata
        });
      }
    });

    sessionManager.registerConnection(sessionId, state.clientId, state.connectionId);

    state.attachedSessionId = sessionId;
    state.detachListener = attached.detach;

    safeSend(state, {
      type: 'ready',
      session: attached.metadata,
      replay: attached.buffer || ''
    });
  }

  function closeConnection(state, code = 1000, reason = 'closed') {
    if (state.closed) return;
    state.closed = true;

    detachSession(state);
    stopFlushLoop(state);

    try {
      state.ws.close(code, reason);
    } catch (_) {
      // ignore
    }
  }

  function handleMessage(state, rawData, isBinary = false) {
    if (isBinary) {
      safeSend(state, { type: 'error', error: 'Binary frames are not supported' });
      return;
    }

    const text = typeof rawData === 'string' ? rawData : String(rawData || '');
    if (!text) return;

    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > maxIncomingMessageBytes) {
      safeSend(state, { type: 'error', error: 'Message too large' });
      return;
    }

    let msg;
    try {
      msg = JSON.parse(text);
    } catch (error) {
      safeSend(state, { type: 'error', error: 'Invalid JSON message' });
      return;
    }

    const type = String(msg.type || '').trim().toLowerCase();

    try {
      if (type === 'attach') {
        const sid = String(msg.session_id || '').trim();
        if (!sid) {
          safeSend(state, { type: 'error', error: 'session_id required for attach' });
          return;
        }
        attachSession(state, sid);
        return;
      }

      if (type === 'input') {
        const sid = String(msg.session_id || state.attachedSessionId || '').trim();
        if (!sid) {
          safeSend(state, { type: 'error', error: 'No attached session' });
          return;
        }

        const data = typeof msg.data === 'string' ? msg.data : String(msg.data ?? '');
        sessionManager.write(sid, state.clientId, data);
        return;
      }

      if (type === 'resize') {
        const sid = String(msg.session_id || state.attachedSessionId || '').trim();
        if (!sid) {
          safeSend(state, { type: 'error', error: 'No attached session' });
          return;
        }

        const cols = toInt(msg.cols, 120, 10, 500);
        const rows = toInt(msg.rows, 34, 5, 300);
        sessionManager.resize(sid, state.clientId, cols, rows);
        return;
      }

      if (type === 'close') {
        const sid = String(msg.session_id || state.attachedSessionId || '').trim();
        if (!sid) {
          safeSend(state, { type: 'error', error: 'No attached session' });
          return;
        }

        sessionManager.closeSession(sid, state.clientId, {
          force: true,
          reason: 'client-close'
        });

        if (state.attachedSessionId === sid) {
          detachSession(state);
        }

        safeSend(state, {
          type: 'state',
          session: {
            session_id: sid,
            state: 'closed'
          }
        });
        return;
      }

      if (type === 'ping') {
        safeSend(state, {
          type: 'pong',
          ts: new Date().toISOString()
        });
        return;
      }

      if (type === 'list') {
        safeSend(state, {
          type: 'sessions',
          sessions: sessionManager.listSessions(state.clientId)
        });
        return;
      }

      safeSend(state, {
        type: 'error',
        error: `Unknown message type: ${type}`
      });
    } catch (error) {
      safeSend(state, {
        type: 'error',
        error: error.message || 'Terminal message handling failed'
      });
    }
  }

  function handleConnection(ws, req, context = {}) {
    const clientId = safeClientId(context.clientId);
    const state = {
      ws,
      req,
      clientId,
      connectionId: connectionId(),
      attachedSessionId: null,
      detachListener: null,
      queue: [],
      queueBytes: 0,
      flushTimer: null,
      backpressured: false,
      closed: false
    };

    safeSend(state, {
      type: 'ready',
      connection_id: state.connectionId,
      client_id: state.clientId,
      ts: new Date().toISOString()
    });

    ws.on('message', (data, isBinary) => {
      handleMessage(state, data, isBinary === true);
    });

    ws.on('close', () => {
      closeConnection(state, 1000, 'peer-closed');
    });

    ws.on('error', () => {
      closeConnection(state, 1011, 'socket-error');
    });
  }

  return {
    handleConnection
  };
}

module.exports = {
  createTerminalWsProtocol
};
