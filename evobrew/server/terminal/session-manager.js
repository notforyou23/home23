'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const pty = require('node-pty');
const { EventEmitter } = require('events');
const crypto = require('crypto');

function toInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

function nowIso() {
  return new Date().toISOString();
}

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

function ensureNodePtySpawnHelper() {
  if (process.platform !== 'darwin') return;

  const prebuildRoot = path.join(__dirname, '..', '..', 'node_modules', 'node-pty', 'prebuilds');
  if (!fs.existsSync(prebuildRoot)) {
    return;
  }

  let entries = [];
  try {
    entries = fs.readdirSync(prebuildRoot, { withFileTypes: true });
  } catch (_) {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const helperPath = path.join(prebuildRoot, entry.name, 'spawn-helper');
    try {
      const stat = fs.statSync(helperPath);
      if (!stat.isFile()) continue;
      if ((stat.mode & 0o111) === 0) {
        const target = stat.mode | 0o755;
        fs.chmodSync(helperPath, target);
      }
    } catch (_) {
      // Ignore missing platform-specific helper entries.
    }
  }
}

function escapeRegExp(input) {
  return String(input).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sessionId() {
  return crypto.randomBytes(12).toString('hex');
}

function getUnixShellLaunchArgs(shellPath) {
  const shellName = path.basename(String(shellPath || '')).toLowerCase();

  if (shellName === 'zsh') {
    return ['-f'];
  }

  if (shellName === 'bash') {
    return ['--noprofile', '--norc'];
  }

  if (shellName === 'fish') {
    return ['--no-config'];
  }

  if (shellName === 'sh' || shellName === 'dash' || shellName === 'ksh') {
    return [];
  }

  return [];
}

function buildIsolatedTerminalEnv(baseEnv, extraEnv = {}, metadata = {}) {
  const env = {
    ...baseEnv,
    TERM: 'xterm-256color',
    COLORTERM: baseEnv.COLORTERM || 'truecolor',
    ...extraEnv
  };

  [
    'TMUX',
    'TMUX_PANE',
    'TMUX_TMPDIR',
    'STY',
    'WINDOW',
    'ZELLIJ',
    'ZELLIJ_SESSION_NAME',
    'ZELLIJ_PANE_ID'
  ].forEach((key) => {
    delete env[key];
  });

  env.EVOBREW_TERMINAL_SESSION = '1';
  if (metadata.clientId) {
    env.EVOBREW_TERMINAL_CLIENT_ID = String(metadata.clientId);
  }

  return env;
}

function resolveCanonicalPathForBoundary(absolutePath) {
  let candidate = path.resolve(absolutePath);
  while (!fs.existsSync(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return fs.realpathSync(candidate);
}

function isPathWithinBoundary(targetPath, allowedRoot) {
  if (!allowedRoot) return true;
  const normalizedTarget = path.resolve(targetPath);
  const normalizedRoot = path.resolve(allowedRoot);
  if (!(normalizedTarget === normalizedRoot || normalizedTarget.startsWith(normalizedRoot + path.sep))) {
    return false;
  }
  const canonicalRoot = resolveCanonicalPathForBoundary(normalizedRoot);
  const canonicalTarget = resolveCanonicalPathForBoundary(normalizedTarget);
  return canonicalTarget === canonicalRoot || canonicalTarget.startsWith(canonicalRoot + path.sep);
}

class TerminalSessionManager {
  constructor(options = {}) {
    this._sessions = new Map();
    this._clientSessions = new Map();
    this._options = this._normalizeOptions(options);
    this._spawnHelperFixApplied = false;

    this._sweepTimer = setInterval(() => {
      this._sweepIdleSessions();
    }, 30_000);
    if (typeof this._sweepTimer.unref === 'function') {
      this._sweepTimer.unref();
    }
  }

  _ensureSpawnHelperExecutable() {
    if (this._spawnHelperFixApplied) return;
    this._spawnHelperFixApplied = true;
    try {
      ensureNodePtySpawnHelper();
    } catch (_) {
      // Intentionally silent: creation will surface a clear spawn error later.
    }
  }

  _normalizeOptions(options = {}) {
    return {
      enabled: options.enabled !== false,
      maxSessionsPerClient: toInt(options.maxSessionsPerClient, 6, 1, 100),
      maxBufferBytes: toInt(options.maxBufferBytes, 2 * 1024 * 1024, 64 * 1024, 64 * 1024 * 1024),
      maxInputBytes: toInt(options.maxInputBytes, 256 * 1024, 256, 4 * 1024 * 1024),
      maxOutputChunkBytes: toInt(options.maxOutputChunkBytes, 128 * 1024, 1024, 4 * 1024 * 1024),
      idleTimeoutMs: toInt(options.idleTimeoutMs, 30 * 60 * 1000, 10_000, 24 * 60 * 60 * 1000),
      hardKillTimeoutMs: toInt(options.hardKillTimeoutMs, 10_000, 1_000, 60_000),
      exitedSessionTtlMs: toInt(options.exitedSessionTtlMs, 5 * 60 * 1000, 10_000, 24 * 60 * 60 * 1000),
      defaultCols: toInt(options.defaultCols, 120, 40, 500),
      defaultRows: toInt(options.defaultRows, 34, 10, 300)
    };
  }

  updateOptions(options = {}) {
    this._options = this._normalizeOptions({ ...this._options, ...options });
  }

  getOptions() {
    return { ...this._options };
  }

  isEnabled() {
    return this._options.enabled === true;
  }

  _getClientSessionSet(clientId) {
    let set = this._clientSessions.get(clientId);
    if (!set) {
      set = new Set();
      this._clientSessions.set(clientId, set);
    }
    return set;
  }

  _resolveCwd(cwd, allowedRoot = null) {
    const requested = cwd && String(cwd).trim() ? String(cwd).trim() : process.cwd();
    const resolved = path.resolve(requested);

    if (!fs.existsSync(resolved)) {
      throw new Error(`Terminal cwd does not exist: ${resolved}`);
    }

    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      throw new Error(`Terminal cwd is not a directory: ${resolved}`);
    }

    if (!isPathWithinBoundary(resolved, allowedRoot)) {
      throw new Error('Terminal cwd is outside allowed root');
    }

    return resolved;
  }

  _resolveShell(shellOverride = '') {
    const platform = os.platform();

    if (shellOverride && String(shellOverride).trim()) {
      const explicit = String(shellOverride).trim();
      return {
        shell: explicit,
        shellType: platform === 'win32' ? 'powershell' : 'unix',
        args: platform === 'win32' ? ['-NoLogo', '-NoProfile'] : getUnixShellLaunchArgs(explicit)
      };
    }

    if (platform === 'win32') {
      const candidates = [
        process.env.POWERSHELL || 'powershell.exe',
        process.env.COMSPEC || 'cmd.exe'
      ].filter(Boolean);

      for (const candidate of candidates) {
        const lc = candidate.toLowerCase();
        if (lc.includes('powershell') || lc.endsWith('pwsh') || lc.endsWith('pwsh.exe')) {
          return { shell: candidate, shellType: 'powershell', args: ['-NoLogo', '-NoProfile'] };
        }
      }

      return { shell: candidates[0], shellType: 'cmd', args: [] };
    }

    return {
      shell: process.env.SHELL || '/bin/bash',
      shellType: 'unix',
      args: getUnixShellLaunchArgs(process.env.SHELL || '/bin/bash')
    };
  }

  _sessionMetadata(session) {
    return {
      session_id: session.id,
      client_id: session.clientId,
      name: session.name,
      shell: session.shell,
      shell_type: session.shellType,
      cwd: session.cwd,
      cols: session.cols,
      rows: session.rows,
      state: session.state,
      persistent: session.persistent,
      created_at: session.createdAt,
      last_active_at: session.lastActiveAt,
      exit_code: session.exitCode,
      signal: session.signal,
      attached_connections: session.connections.size,
      flow_paused: session.flowPaused,
      buffer_bytes: session.bufferBytes
    };
  }

  _emit(session, eventName, payload) {
    session.emitter.emit(eventName, payload);
  }

  _appendBuffer(session, chunk) {
    if (!chunk) return;
    const chunkBytes = Buffer.byteLength(chunk, 'utf8');
    if (chunkBytes <= 0) return;

    session.buffer.push(chunk);
    session.bufferBytes += chunkBytes;

    while (session.bufferBytes > this._options.maxBufferBytes && session.buffer.length > 0) {
      const removed = session.buffer.shift();
      if (!removed) continue;
      session.bufferBytes -= Buffer.byteLength(removed, 'utf8');
    }

    if (session.buffer.length > 512) {
      const merged = session.buffer.join('');
      session.buffer = [merged];
      session.bufferBytes = Buffer.byteLength(merged, 'utf8');
    }
  }

  _setSessionFlowPaused(session, paused) {
    if (!session || session.state !== 'running') return;
    if (session.flowPaused === paused) return;
    session.flowPaused = paused;

    try {
      if (paused && typeof session.pty.pause === 'function') {
        session.pty.pause();
      } else if (!paused && typeof session.pty.resume === 'function') {
        session.pty.resume();
      }
    } catch (error) {
      console.warn('[TERMINAL] Failed toggling PTY flow:', error.message);
    }
  }

  _recomputeFlow(session) {
    if (!session) return;
    const shouldPause = session.backpressure.size > 0;
    this._setSessionFlowPaused(session, shouldPause);
  }

  _ensureSession(sessionIdValue, clientId) {
    const id = String(sessionIdValue || '').trim();
    const session = this._sessions.get(id);
    if (!session) {
      throw new Error(`Terminal session not found: ${id}`);
    }

    if (clientId && session.clientId !== clientId) {
      throw new Error('Access denied: terminal session belongs to another client');
    }

    return session;
  }

  createSession(params = {}) {
    if (!this.isEnabled()) {
      throw new Error('Terminal feature is disabled');
    }

    const clientId = safeClientId(params.clientId);
    const clientSet = this._getClientSessionSet(clientId);
    this._ensureSpawnHelperExecutable();

    if (clientSet.size >= this._options.maxSessionsPerClient) {
      throw new Error(`Client has reached terminal session limit (${this._options.maxSessionsPerClient})`);
    }

    const cols = toInt(params.cols, this._options.defaultCols, 10, 500);
    const rows = toInt(params.rows, this._options.defaultRows, 5, 300);
    const persistent = params.persistent !== false;
    const resolvedCwd = this._resolveCwd(params.cwd, params.allowedRoot || null);
    const shellInfo = this._resolveShell(params.shell || '');

    const id = sessionId();
    const createdAt = nowIso();
    const env = buildIsolatedTerminalEnv(
      process.env,
      params.env && typeof params.env === 'object' ? params.env : {},
      { clientId }
    );

    const ptyProcess = pty.spawn(shellInfo.shell, shellInfo.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: resolvedCwd,
      env,
      encoding: 'utf8'
    });

    const session = {
      id,
      clientId,
      name: String(params.name || `terminal-${clientSet.size + 1}`),
      shell: shellInfo.shell,
      shellType: shellInfo.shellType,
      cwd: resolvedCwd,
      cols,
      rows,
      state: 'running',
      persistent,
      createdAt,
      lastActiveAt: createdAt,
      exitCode: null,
      signal: null,
      pty: ptyProcess,
      emitter: new EventEmitter(),
      buffer: [],
      bufferBytes: 0,
      connections: new Set(),
      backpressure: new Set(),
      flowPaused: false,
      hardKillTimer: null,
      cleanupTimer: null
    };

    session.emitter.setMaxListeners(200);

    ptyProcess.onData((chunk) => {
      const data = typeof chunk === 'string' ? chunk : String(chunk || '');
      if (!data) return;

      session.lastActiveAt = nowIso();
      this._appendBuffer(session, data);

      if (Buffer.byteLength(data, 'utf8') > this._options.maxOutputChunkBytes) {
        const maxBytes = this._options.maxOutputChunkBytes;
        let cursor = 0;
        while (cursor < data.length) {
          const piece = data.slice(cursor, cursor + maxBytes);
          cursor += maxBytes;
          this._emit(session, 'data', { session_id: session.id, data: piece, ts: nowIso() });
        }
      } else {
        this._emit(session, 'data', { session_id: session.id, data, ts: nowIso() });
      }
    });

    ptyProcess.onExit((event) => {
      session.state = 'exited';
      session.exitCode = typeof event?.exitCode === 'number' ? event.exitCode : 0;
      session.signal = event?.signal ?? null;
      session.lastActiveAt = nowIso();

      if (session.hardKillTimer) {
        clearTimeout(session.hardKillTimer);
        session.hardKillTimer = null;
      }

      this._emit(session, 'exit', {
        session_id: session.id,
        exit_code: session.exitCode,
        signal: session.signal,
        ts: session.lastActiveAt
      });

      if (session.cleanupTimer) {
        clearTimeout(session.cleanupTimer);
      }

      session.cleanupTimer = setTimeout(() => {
        this._removeSession(session.id);
      }, session.persistent ? this._options.exitedSessionTtlMs : 5_000);
      if (typeof session.cleanupTimer.unref === 'function') {
        session.cleanupTimer.unref();
      }
    });

    this._sessions.set(id, session);
    clientSet.add(id);

    return {
      ...this._sessionMetadata(session),
      initial_buffer: ''
    };
  }

  listSessions(clientId) {
    const normalizedClientId = safeClientId(clientId);
    const sessionIds = this._clientSessions.get(normalizedClientId);
    if (!sessionIds || sessionIds.size === 0) {
      return [];
    }

    return Array.from(sessionIds)
      .map((id) => this._sessions.get(id))
      .filter(Boolean)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .map((session) => this._sessionMetadata(session));
  }

  getSession(sessionIdValue, clientId) {
    const normalizedClientId = safeClientId(clientId);
    const session = this._ensureSession(sessionIdValue, normalizedClientId);
    return this._sessionMetadata(session);
  }

  getBufferTail(sessionIdValue, clientId, maxBytes = this._options.maxBufferBytes) {
    const normalizedClientId = safeClientId(clientId);
    const session = this._ensureSession(sessionIdValue, normalizedClientId);
    const joined = session.buffer.join('');
    if (!joined) return '';

    const limit = toInt(maxBytes, this._options.maxBufferBytes, 1024, this._options.maxBufferBytes);
    if (Buffer.byteLength(joined, 'utf8') <= limit) return joined;

    // Approximate trim to avoid repeated byte slicing work for very large output.
    return joined.slice(joined.length - limit);
  }

  attach(sessionIdValue, clientId, handlers = {}) {
    const normalizedClientId = safeClientId(clientId);
    const session = this._ensureSession(sessionIdValue, normalizedClientId);

    const subscriptions = [];

    if (typeof handlers.onData === 'function') {
      const listener = (payload) => handlers.onData(payload);
      session.emitter.on('data', listener);
      subscriptions.push(() => session.emitter.off('data', listener));
    }

    if (typeof handlers.onExit === 'function') {
      const listener = (payload) => handlers.onExit(payload);
      session.emitter.on('exit', listener);
      subscriptions.push(() => session.emitter.off('exit', listener));
    }

    if (typeof handlers.onState === 'function') {
      handlers.onState(this._sessionMetadata(session));
    }

    return {
      metadata: this._sessionMetadata(session),
      buffer: this.getBufferTail(session.id, normalizedClientId),
      detach: () => {
        while (subscriptions.length > 0) {
          const fn = subscriptions.pop();
          try {
            fn();
          } catch (_) {
            // ignore
          }
        }
      }
    };
  }

  registerConnection(sessionIdValue, clientId, connectionId) {
    const normalizedClientId = safeClientId(clientId);
    const session = this._ensureSession(sessionIdValue, normalizedClientId);
    session.connections.add(String(connectionId));
    session.lastActiveAt = nowIso();
    return this._sessionMetadata(session);
  }

  unregisterConnection(sessionIdValue, clientId, connectionId) {
    const normalizedClientId = safeClientId(clientId);
    const session = this._ensureSession(sessionIdValue, normalizedClientId);
    session.connections.delete(String(connectionId));
    session.backpressure.delete(String(connectionId));
    this._recomputeFlow(session);
  }

  setBackpressure(sessionIdValue, clientId, sourceId, enabled) {
    const normalizedClientId = safeClientId(clientId);
    const session = this._ensureSession(sessionIdValue, normalizedClientId);
    const source = String(sourceId);

    if (enabled) {
      session.backpressure.add(source);
    } else {
      session.backpressure.delete(source);
    }

    this._recomputeFlow(session);
  }

  write(sessionIdValue, clientId, data) {
    const normalizedClientId = safeClientId(clientId);
    const session = this._ensureSession(sessionIdValue, normalizedClientId);

    if (session.state !== 'running') {
      throw new Error('Terminal session is not running');
    }

    const payload = typeof data === 'string' ? data : String(data ?? '');
    if (!payload) {
      return { success: true, bytes: 0 };
    }

    const bytes = Buffer.byteLength(payload, 'utf8');
    if (bytes > this._options.maxInputBytes) {
      throw new Error(`Terminal input exceeds max_input_bytes (${this._options.maxInputBytes})`);
    }

    session.pty.write(payload);
    session.lastActiveAt = nowIso();

    return {
      success: true,
      session_id: session.id,
      bytes
    };
  }

  resize(sessionIdValue, clientId, cols, rows) {
    const normalizedClientId = safeClientId(clientId);
    const session = this._ensureSession(sessionIdValue, normalizedClientId);

    const width = toInt(cols, session.cols, 10, 500);
    const height = toInt(rows, session.rows, 5, 300);

    session.cols = width;
    session.rows = height;

    if (session.state === 'running') {
      try {
        session.pty.resize(width, height);
      } catch (error) {
        console.warn('[TERMINAL] Resize failed:', error.message);
      }
    }

    session.lastActiveAt = nowIso();

    return {
      success: true,
      session_id: session.id,
      cols: session.cols,
      rows: session.rows
    };
  }

  closeSession(sessionIdValue, clientId, options = {}) {
    const normalizedClientId = safeClientId(clientId);
    const session = this._ensureSession(sessionIdValue, normalizedClientId);
    this._terminateSession(session, options.reason || 'closed', options.force === true);

    return {
      success: true,
      session_id: session.id,
      state: session.state
    };
  }

  _terminateSession(session, reason = 'terminated', force = false) {
    if (!session) return;

    if (session.cleanupTimer) {
      clearTimeout(session.cleanupTimer);
      session.cleanupTimer = null;
    }

    if (session.state === 'running') {
      session.state = 'closing';
      session.lastActiveAt = nowIso();

      try {
        session.pty.kill();
      } catch (error) {
        console.warn('[TERMINAL] PTY kill failed:', error.message);
      }

      session.hardKillTimer = setTimeout(() => {
        try {
          session.pty.kill();
        } catch (_) {
          // ignore
        }
        this._removeSession(session.id);
      }, this._options.hardKillTimeoutMs);

      if (typeof session.hardKillTimer.unref === 'function') {
        session.hardKillTimer.unref();
      }
    }

    if (force) {
      this._removeSession(session.id);
      return;
    }

    this._emit(session, 'state', {
      session_id: session.id,
      state: session.state,
      reason,
      ts: nowIso()
    });
  }

  _removeSession(sessionIdValue) {
    const session = this._sessions.get(sessionIdValue);
    if (!session) return;

    if (session.hardKillTimer) {
      clearTimeout(session.hardKillTimer);
      session.hardKillTimer = null;
    }
    if (session.cleanupTimer) {
      clearTimeout(session.cleanupTimer);
      session.cleanupTimer = null;
    }

    try {
      if (session.state === 'running' || session.state === 'closing') {
        session.pty.kill();
      }
    } catch (_) {
      // ignore
    }

    this._sessions.delete(session.id);
    const clientSet = this._clientSessions.get(session.clientId);
    if (clientSet) {
      clientSet.delete(session.id);
      if (clientSet.size === 0) {
        this._clientSessions.delete(session.clientId);
      }
    }

    session.emitter.removeAllListeners();
  }

  _matchPattern(collected, waitFor) {
    if (!waitFor) return false;
    if (waitFor instanceof RegExp) {
      return waitFor.test(collected);
    }
    return collected.includes(String(waitFor));
  }

  async waitFor(sessionIdValue, clientId, options = {}) {
    const normalizedClientId = safeClientId(clientId);
    const session = this._ensureSession(sessionIdValue, normalizedClientId);

    const timeoutMs = toInt(options.timeoutMs, 30_000, 100, 10 * 60 * 1000);
    const maxOutputBytes = toInt(options.maxOutputBytes, 512 * 1024, 1_024, 16 * 1024 * 1024);
    const waitFor = options.waitFor || options.pattern || '';
    const waitForExit = options.waitForExit === true;

    let collected = '';
    let truncated = false;

    const append = (chunk) => {
      if (!chunk) return;
      collected += chunk;
      while (Buffer.byteLength(collected, 'utf8') > maxOutputBytes) {
        collected = collected.slice(Math.floor(collected.length * 0.2));
        truncated = true;
      }
    };

    return new Promise((resolve) => {
      const seed = this.getBufferTail(session.id, normalizedClientId, maxOutputBytes);
      append(seed);

      if (waitFor && this._matchPattern(collected, waitFor)) {
        resolve({
          success: true,
          session_id: session.id,
          output: collected,
          truncated,
          timed_out: false,
          matched: true,
          exited: session.state === 'exited',
          exit_code: session.exitCode,
          signal: session.signal
        });
        return;
      }

      if (waitForExit && session.state === 'exited') {
        resolve({
          success: true,
          session_id: session.id,
          exited: true,
          exit_code: session.exitCode,
          signal: session.signal,
          output: collected,
          truncated,
          timed_out: false,
          matched: false
        });
        return;
      }

      let settled = false;
      let timeout = null;
      let detach = null;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (detach) detach();
        resolve({
          success: true,
          session_id: session.id,
          output: collected,
          truncated,
          timed_out: false,
          matched: false,
          exited: session.state === 'exited',
          exit_code: session.exitCode,
          signal: session.signal,
          ...result
        });
      };

      detach = this.attach(session.id, normalizedClientId, {
        onData: ({ data }) => {
          append(data);
          if (waitFor && this._matchPattern(collected, waitFor)) {
            finish({ matched: true });
          }
        },
        onExit: ({ exit_code, signal }) => {
          if (waitForExit) {
            finish({ exited: true, exit_code, signal });
          }
        }
      }).detach;

      timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (detach) detach();
        resolve({
          success: true,
          session_id: session.id,
          output: collected,
          truncated,
          timed_out: true,
          matched: false,
          exited: session.state === 'exited',
          exit_code: session.exitCode,
          signal: session.signal
        });
      }, timeoutMs);

      if (typeof timeout.unref === 'function') {
        timeout.unref();
      }
    });
  }

  _buildExitMarkerCommand(shellType, marker) {
    if (shellType === 'powershell') {
      return `Write-Output "${marker}:$LASTEXITCODE"`;
    }
    if (shellType === 'cmd') {
      return `echo ${marker}:%ERRORLEVEL%`;
    }
    return `printf "\\n${marker}:%s\\n" "$?"`;
  }

  async runCompatibilityCommand(params = {}) {
    const clientId = safeClientId(params.clientId || 'ai');
    const timeoutMs = toInt(params.timeoutMs, 30_000, 100, 10 * 60 * 1000);
    const command = String(params.command || '').trim();

    if (!command) {
      throw new Error('Terminal command is required');
    }

    const created = this.createSession({
      clientId,
      cwd: params.cwd,
      allowedRoot: params.allowedRoot || null,
      cols: params.cols,
      rows: params.rows,
      persistent: false,
      name: 'compat-run-terminal'
    });

    const sid = created.session_id;
    const session = this._ensureSession(sid, clientId);
    const marker = `__EVOBREW_EXIT_${Date.now()}_${Math.random().toString(16).slice(2)}__`;
    const markerCommand = this._buildExitMarkerCommand(session.shellType, marker);

    this.write(sid, clientId, `${command}\r`);
    this.write(sid, clientId, `${markerCommand}\r`);

    const waitResult = await this.waitFor(sid, clientId, {
      pattern: marker,
      timeoutMs,
      maxOutputBytes: Math.min(this._options.maxBufferBytes, 4 * 1024 * 1024)
    });

    const output = String(waitResult.output || '');
    const markerRegex = new RegExp(`${escapeRegExp(marker)}:(-?\\d+)`);
    const markerMatch = output.match(markerRegex);

    let exitCode = markerMatch ? Number.parseInt(markerMatch[1], 10) : session.exitCode;
    if (!Number.isFinite(exitCode)) {
      exitCode = waitResult.timed_out ? 124 : 0;
    }

    const markerIndex = output.indexOf(marker);
    const cleanedOutput = markerIndex >= 0 ? output.slice(0, markerIndex).trimEnd() : output.trimEnd();

    this.closeSession(sid, clientId, { force: true, reason: 'compat-finished' });

    return {
      output: cleanedOutput,
      exitCode,
      success: exitCode === 0 && !waitResult.timed_out,
      session_id: sid,
      truncated: waitResult.truncated === true,
      timedOut: waitResult.timed_out === true
    };
  }

  _sweepIdleSessions() {
    const now = Date.now();
    for (const session of this._sessions.values()) {
      if (session.state !== 'running') continue;

      const last = Date.parse(session.lastActiveAt || session.createdAt);
      if (!Number.isFinite(last)) continue;
      const idleMs = now - last;

      // Do not idle-kill active attached sessions.
      if (session.connections.size > 0) continue;

      if (idleMs >= this._options.idleTimeoutMs) {
        this._terminateSession(session, 'idle-timeout', true);
      }
    }
  }

  shutdown() {
    if (this._sweepTimer) {
      clearInterval(this._sweepTimer);
      this._sweepTimer = null;
    }

    for (const sessionIdValue of Array.from(this._sessions.keys())) {
      this._removeSession(sessionIdValue);
    }
  }
}

let singleton = null;

function configureTerminalSessionManager(options = {}) {
  if (!singleton) {
    singleton = new TerminalSessionManager(options);
  } else {
    singleton.updateOptions(options);
  }
  return singleton;
}

function getTerminalSessionManager() {
  if (!singleton) {
    singleton = new TerminalSessionManager({});
  }
  return singleton;
}

module.exports = {
  TerminalSessionManager,
  configureTerminalSessionManager,
  getTerminalSessionManager,
  toBool,
  toInt
};
