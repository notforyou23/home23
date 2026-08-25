/**
 * Verifier catalog — deterministic checks for live problems.
 *
 * Each verifier takes `args` (problem-specific) + `ctx` (runtime helpers) and
 * returns { ok, detail, observed } synchronously or via Promise. Never throws —
 * internal errors return ok:false with detail describing the failure so the
 * problem stays tracked rather than silently disappearing.
 *
 * Adding a new verifier: add an entry here and it becomes usable in any
 * live-problems.json record. No dispatcher changes needed.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, execSync } = require('child_process');
const http = require('http');
const https = require('https');

function normalizePm2RestartCount(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function expandPath(p) {
  if (!p) return p;
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return p;
}

function minutesSince(ts) {
  return (Date.now() - ts) / 60000;
}

/**
 * GET a small JSON document over localhost with a hard wall-clock deadline and
 * a bounded body. Used by identity probes that must never be able to hang: the
 * socket `timeout` option only covers idle sockets, so a deadline timer backs
 * it up and the response is capped so a wrong listener cannot stream forever.
 */
function simpleHttpGetJson(url, timeoutMs = 4000, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }
    const client = parsed.protocol === 'https:' ? https : http;
    let settled = false;
    let deadline = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      fn(value);
    };
    const req = client.get(parsed, { timeout: timeoutMs }, (res) => {
      let body = '';
      let bytes = 0;
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        bytes += Buffer.byteLength(chunk, 'utf8');
        if (bytes > maxBytes) {
          req.destroy(new Error(`response exceeded ${maxBytes} bytes`));
          return;
        }
        body += chunk;
      });
      res.on('end', () => finish(resolve, { status: res.statusCode || 0, body }));
      res.on('error', (err) => finish(reject, err));
    });
    deadline = setTimeout(() => {
      req.destroy(new Error(`deadline exceeded after ${timeoutMs}ms`));
    }, timeoutMs);
    deadline.unref?.();
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on('error', (err) => finish(reject, err));
  });
}

function simpleHttpGet(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.get(parsed, { timeout: timeoutMs }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode || 0 }));
    });
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on('error', reject);
  });
}

const verifiers = {
  /**
   * File has been modified within the last maxAgeMin minutes.
   * args: { path, maxAgeMin }
   */
  file_mtime({ path: p, maxAgeMin }) {
    try {
      const full = expandPath(p);
      if (!fs.existsSync(full)) {
        return { ok: false, detail: `missing: ${p}`, observed: { exists: false } };
      }
      const stat = fs.statSync(full);
      const ageMin = minutesSince(stat.mtimeMs);
      const ok = ageMin <= (maxAgeMin ?? 360);
      return {
        ok,
        detail: ok
          ? `fresh (${ageMin.toFixed(1)} min old)`
          : `stale (${ageMin.toFixed(1)} min old, threshold ${maxAgeMin})`,
        observed: { mtime: stat.mtime.toISOString(), ageMin },
      };
    } catch (err) {
      return { ok: false, detail: `stat failed: ${err.message}` };
    }
  },

  /**
   * File exists (and optionally is non-empty).
   * args: { path, minBytes }
   */
  file_exists({ path: p, minBytes }) {
    try {
      const full = expandPath(p);
      if (!fs.existsSync(full)) return { ok: false, detail: `missing: ${p}` };
      if (minBytes !== undefined) {
        const stat = fs.statSync(full);
        if (stat.size < minBytes) {
          return { ok: false, detail: `too small (${stat.size} < ${minBytes})`, observed: { size: stat.size } };
        }
      }
      return { ok: true, detail: 'exists' };
    } catch (err) {
      return { ok: false, detail: `stat failed: ${err.message}` };
    }
  },

  /**
   * Instantiate the local create_file tool and verify bytes actually hit disk.
   * This turns "write path is intercepted" claims into a binary filesystem
   * check instead of another narrative artifact.
   *
   * args: {
   *   modulePath: "engine/src/ide/tools.js",
   *   filePath?: "probe/create_file_probe.txt",
   *   workingDirectory?: "/tmp/probe-root",
   *   content?: "probe text",
   *   keepProbe?: false
   * }
   */
  async create_file_tool_probe(args = {}) {
    const modulePath = expandPath(args.modulePath);
    if (!modulePath) return { ok: false, detail: 'modulePath required' };
    if (!fs.existsSync(modulePath)) {
      return { ok: false, detail: `tool module missing: ${modulePath}`, observed: { modulePath } };
    }

    const filePath = args.filePath || 'probe/create_file_probe.txt';
    const content = args.content || `home23-create-file-probe ${new Date().toISOString()}\n`;
    const createdTempRoot = !args.workingDirectory;
    const root = args.workingDirectory
      ? path.resolve(expandPath(args.workingDirectory))
      : fs.mkdtempSync(path.join(os.tmpdir(), 'home23-create-file-probe-'));

    try {
      fs.mkdirSync(root, { recursive: true });

      const resolvedModulePath = path.resolve(modulePath);
      delete require.cache[resolvedModulePath];
      const mod = require(resolvedModulePath);
      const ToolExecutor = mod.ToolExecutor || mod.default || mod;
      if (typeof ToolExecutor !== 'function') {
        return {
          ok: false,
          detail: 'tool module does not export ToolExecutor',
          observed: { modulePath: resolvedModulePath },
        };
      }

      const executor = new ToolExecutor(null, root);
      if (typeof executor.createFile !== 'function') {
        return {
          ok: false,
          detail: 'ToolExecutor has no createFile function',
          observed: { modulePath: resolvedModulePath },
        };
      }

      const result = await executor.createFile(filePath, content);
      const candidatePaths = [
        result?.path,
        path.isAbsolute(filePath) ? filePath : path.join(root, filePath),
      ].filter(Boolean);
      const diskPath = candidatePaths.find((candidate) => fs.existsSync(candidate));

      if (!diskPath) {
        return {
          ok: false,
          detail: 'createFile returned but no file was written',
          observed: { modulePath: resolvedModulePath, root, filePath, result },
        };
      }

      const disk = fs.readFileSync(diskPath, 'utf8');
      const ok = disk === content;
      const stat = fs.statSync(diskPath);
      return {
        ok,
        detail: ok
          ? `wrote and read back ${stat.size} bytes`
          : `readback mismatch (${stat.size} bytes at ${diskPath})`,
        observed: {
          modulePath: resolvedModulePath,
          root,
          filePath,
          diskPath,
          bytes: stat.size,
          contentMatches: ok,
          result,
        },
      };
    } catch (err) {
      return {
        ok: false,
        detail: `createFile probe failed: ${err.message}`,
        observed: { modulePath, root, filePath },
      };
    } finally {
      if (createdTempRoot && args.keepProbe !== true) {
        try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    }
  },

  /**
   * PM2 process is online (or any matching the name glob is online).
   * args: { name }
   */
  pm2_status({ name }) {
    if (!name) return { ok: false, detail: 'name required' };
    try {
      const out = execFileSync('pm2', ['jlist'], { encoding: 'utf8', timeout: 8000 });
      const list = JSON.parse(out);
      const matches = list.filter(p => p.name === name);
      if (matches.length === 0) {
        return { ok: false, detail: `not registered: ${name}` };
      }
      const online = matches.filter(p => p.pm2_env?.status === 'online');
      if (online.length === 0) {
        const statuses = matches.map(p => p.pm2_env?.status || '?').join(',');
        return { ok: false, detail: `status=${statuses}`, observed: { statuses } };
      }
      return {
        ok: true,
        detail: 'online',
        observed: {
          restarts: normalizePm2RestartCount(online[0].pm2_env?.restart_time),
        },
      };
    } catch (err) {
      return { ok: false, detail: `pm2 jlist failed: ${err.message}` };
    }
  },

  /**
   * PM2 process is online and is the process actually serving a localhost port.
   * Catches stale/orphan listeners where HTTP still responds but an older
   * process owns the socket instead of the current PM2 child.
   *
   * Ownership is established by asking the listener who it is, not by reading
   * the kernel socket table. On macOS 27 `lsof` can wedge uninterruptibly
   * inside proc_pidfdinfo: neither its own timeout nor SIGKILL reaps it, so a
   * scoped `lsof -iTCP:<port>` is NOT safe here — one run per verifier tick
   * accumulates unkillable processes and zombie helpers until the host is
   * unusable. This verifier therefore never shells out to lsof and has no lsof
   * fallback. The only child process it runs is the PM2 jlist that was already
   * required to resolve the expected pid.
   *
   * Fail-closed: HTTP success alone is never enough. The identity document must
   * parse and must report a pid equal to PM2's pid for the named process. A
   * stale listener answers with its own (stale) pid; a listener from an older
   * build has no identity route and answers 404; an unreachable or malformed
   * answer is a failure, not a pass.
   *
   * args: { name, port, host?, path?, timeoutMs? }
   * ctx: { execFileSync?, httpGetJson? } — injection points for tests.
   */
  async pm2_port_owner({ name, port, host, path: identityPath, timeoutMs }, ctx = {}) {
    if (!name) return { ok: false, detail: 'name required' };
    if (!port) return { ok: false, detail: 'port required' };

    const portText = String(port).trim();
    if (!/^\d+$/.test(portText)) return { ok: false, detail: `invalid port: ${port}` };

    const hostText = String(host || '127.0.0.1').trim() || '127.0.0.1';
    const pathText = String(identityPath || '/home23/process.json').trim() || '/home23/process.json';
    const probeTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
      ? Number(timeoutMs)
      : 4000;
    const identityUrl = `http://${hostText}:${portText}${pathText}`;

    const run = ctx.execFileSync || execFileSync;
    let pm2Pid = null;
    let status = null;

    try {
      const out = run('pm2', ['jlist'], { encoding: 'utf8', timeout: 15000 });
      const list = JSON.parse(out);
      const matches = list.filter(p => p.name === name);
      if (matches.length === 0) {
        return { ok: false, detail: `not registered: ${name}`, observed: { name, port: portText } };
      }

      const online = matches.find(p => p.pm2_env?.status === 'online');
      if (!online) {
        const statuses = matches.map(p => p.pm2_env?.status || '?').join(',');
        return {
          ok: false,
          detail: `status=${statuses}`,
          observed: { name, port: portText, statuses },
        };
      }

      status = online.pm2_env?.status || null;
      pm2Pid = Number.parseInt(String(online.pid || ''), 10);
      if (!Number.isFinite(pm2Pid) || pm2Pid <= 0) {
        return {
          ok: false,
          detail: `pm2 pid unavailable for ${name}`,
          observed: { name, port: portText, status, pm2Pid: online.pid || null },
        };
      }
    } catch (err) {
      return { ok: false, detail: `pm2 jlist failed: ${err.message}`, observed: { name, port: portText } };
    }

    const base = { name, port: portText, pm2Pid, status, identityUrl };
    const getJson = ctx.httpGetJson || simpleHttpGetJson;

    let response;
    try {
      response = await getJson(identityUrl, probeTimeoutMs);
    } catch (err) {
      return {
        ok: false,
        detail: `no identity answer on port ${portText} for ${name} pid ${pm2Pid}: ${err.message}`,
        observed: { ...base, reachable: false },
      };
    }

    const httpStatus = Number(response?.status);
    if (!Number.isFinite(httpStatus) || httpStatus < 200 || httpStatus >= 300) {
      return {
        ok: false,
        detail: `identity endpoint on port ${portText} returned HTTP ${response?.status ?? '?'} — listener is not ${name} pid ${pm2Pid}`,
        observed: { ...base, reachable: true, httpStatus: Number.isFinite(httpStatus) ? httpStatus : null },
      };
    }

    let identity = response?.json;
    if (identity === undefined) {
      try {
        identity = JSON.parse(String(response?.body ?? ''));
      } catch (err) {
        return {
          ok: false,
          detail: `identity endpoint on port ${portText} returned malformed JSON: ${err.message}`,
          observed: { ...base, reachable: true, httpStatus },
        };
      }
    }

    if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
      return {
        ok: false,
        detail: `identity endpoint on port ${portText} returned a non-object body`,
        observed: { ...base, reachable: true, httpStatus },
      };
    }

    const listenerPid = Number.parseInt(String(identity.pid ?? ''), 10);
    if (!Number.isFinite(listenerPid) || listenerPid <= 0) {
      return {
        ok: false,
        detail: `identity endpoint on port ${portText} reported no usable pid`,
        observed: { ...base, reachable: true, httpStatus, listenerPid: null },
      };
    }

    const observed = {
      ...base,
      reachable: true,
      httpStatus,
      listenerPid,
      listenerService: typeof identity.service === 'string' ? identity.service : null,
      listenerAgent: typeof identity.agent === 'string' ? identity.agent : null,
      listenerPm2Name: typeof identity.pm2Name === 'string' ? identity.pm2Name : null,
      listenerPort: Number.isFinite(Number(identity.port)) ? Number(identity.port) : null,
      listenerStartedAt: typeof identity.startedAt === 'string' ? identity.startedAt : null,
    };

    const ok = listenerPid === pm2Pid;
    return {
      ok,
      detail: ok
        ? `port ${portText} owned by ${name} pid ${pm2Pid}`
        : `port ${portText} owned by stale pid ${listenerPid}, expected ${name} pid ${pm2Pid}`,
      observed,
    };
  },

  /**
   * HTTP GET returns 2xx within timeoutMs.
   * args: { url, timeoutMs, expectStatus }
   */
  async http_ping({ url, timeoutMs = 5000, expectStatus }) {
    if (!url) return { ok: false, detail: 'url required' };
    try {
      const res = await simpleHttpGet(url, timeoutMs);
      const status = res.status;
      const expected = expectStatus ?? 200;
      const ok = Array.isArray(expected)
        ? expected.includes(status)
        : (typeof expected === 'number' ? status === expected : status >= 200 && status < 300);
      return {
        ok,
        detail: ok ? `${status}` : `unexpected status ${status}`,
        observed: { status },
      };
    } catch (err) {
      return { ok: false, detail: `http failed: ${err.message}` };
    }
  },

  /**
   * Mount has >= minGiB free.
   * args: { mount, minGiB }
   */
  async disk_free({ mount = '/', minGiB = 5 }) {
    try {
      // statfs works on both Linux and macOS; `df -g` was a BSD-only flag
      // that failed with "invalid option" on GNU coreutils.
      const st = await fs.promises.statfs(mount);
      const availGi = Number(((Number(st.bavail) * Number(st.bsize)) / (1024 ** 3)).toFixed(2));
      if (!Number.isFinite(availGi)) return { ok: false, detail: `cannot compute free space for ${mount}` };
      const ok = availGi >= minGiB;
      return {
        ok,
        detail: ok ? `${availGi}GiB free` : `only ${availGi}GiB free (need ${minGiB})`,
        observed: { availGi },
      };
    } catch (err) {
      return { ok: false, detail: `statfs failed: ${err.message}` };
    }
  },

  /**
   * Brain graph has >= minNodes nodes. Uses the memory instance if provided.
   * args: { minNodes }
   */
  graph_not_empty({ minNodes = 1 }, ctx = {}) {
    const memory = ctx.memory;
    if (!memory || !memory.nodes) return { ok: false, detail: 'no memory ref' };
    const count = memory.nodes.size || memory.nodes.length || 0;
    const ok = count >= minNodes;
    return {
      ok,
      detail: ok ? `${count} nodes` : `only ${count} nodes (need ${minNodes})`,
      observed: { count },
    };
  },

  /**
   * Node count has not regressed more than `dropThreshold` (0..1) below the
   * all-time high-water mark. High-water tracked in brain/brain-high-water.json
   * and updated whenever current exceeds it. Needs memory + brainDir in ctx.
   *
   * Useful for catching silent data loss (save-side regressions, in-process
   * pruning bugs, cluster-sync issues) that the 50%-drop save safeguard
   * wouldn't trip on their own.
   *
   * args: { dropThreshold, minBaseline }
   */
  node_count_stable({ dropThreshold = 0.1, minBaseline = 100 }, ctx = {}) {
    const memory = ctx.memory;
    const brainDir = ctx.brainDir;
    if (!memory?.nodes) return { ok: false, detail: 'no memory ref' };
    if (!brainDir) return { ok: false, detail: 'no brainDir in ctx' };

    const current = memory.nodes.size ?? memory.nodes.length ?? 0;
    const hwFile = path.join(brainDir, 'brain-high-water.json');

    let hw = { maxNodeCount: 0, lastSeen: null, acceptedMaxNodeCount: null };
    try {
      const raw = fs.readFileSync(hwFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.maxNodeCount === 'number') hw = { ...hw, ...parsed };
    } catch { /* first run or bad file */ }

    // Intentional rebuild / door-closure: acceptedMaxNodeCount resets the floor
    // so a deliberate shrink is not treated as data-loss forever.
    const hasAccepted = typeof hw.acceptedMaxNodeCount === 'number' && hw.acceptedMaxNodeCount >= 0;

    // Update all-time high-water when current is a new maximum (informational).
    if (current > (hw.maxNodeCount || 0)) {
      const next = {
        ...hw,
        maxNodeCount: current,
        lastSeen: new Date().toISOString(),
      };
      try {
        fs.writeFileSync(hwFile + '.tmp', JSON.stringify(next, null, 2));
        fs.renameSync(hwFile + '.tmp', hwFile);
      } catch { /* advisory — don't block verification */ }
      hw = next;
    }

    let effectiveHighWater = hasAccepted ? hw.acceptedMaxNodeCount : hw.maxNodeCount;

    // After accepted rebuild, grow accepted baseline when we climb past it.
    if (hasAccepted && current > hw.acceptedMaxNodeCount) {
      const next = {
        ...hw,
        acceptedMaxNodeCount: current,
        lastSeen: new Date().toISOString(),
      };
      try {
        fs.writeFileSync(hwFile + '.tmp', JSON.stringify(next, null, 2));
        fs.renameSync(hwFile + '.tmp', hwFile);
      } catch { /* advisory */ }
      hw = next;
      effectiveHighWater = current;
    }

    // Not enough baseline — treat as ok, keep collecting data.
    if (effectiveHighWater < minBaseline) {
      return {
        ok: true,
        detail: `building baseline (${current} nodes, high-water ${effectiveHighWater}${hasAccepted ? ', accepted rebuild' : ''})`,
        observed: { current, highWater: effectiveHighWater, accepted: hasAccepted },
      };
    }

    const floor = Math.floor(effectiveHighWater * (1 - dropThreshold));
    const ok = current >= floor;
    return {
      ok,
      detail: ok
        ? `stable (${current} nodes, high-water ${effectiveHighWater}${hasAccepted ? ', accepted rebuild' : ''})`
        : `regression: ${current} nodes, dropped below ${floor} (high-water ${effectiveHighWater}${hasAccepted ? ', accepted rebuild' : ''})`,
      observed: { current, highWater: effectiveHighWater, floor, accepted: hasAccepted, allTimeHigh: hw.maxNodeCount },
    };
  },
};

// ─── Compositional primitives ──────────────────────────────
// These three cover most of what narrow types would require, by taking
// structured args that describe WHERE to look and WHAT to check for. They
// grow the verifier vocabulary without growing the catalog.

/**
 * Walk a dot-path or bracket-path into a parsed JSON value.
 * Supports:
 *   foo
 *   foo.bar
 *   foo[0].bar                  — numeric index
 *   sensors[id=system.cpu].ts   — match array element where element.id == value
 *   byKey.weather.lastUpdateMs
 * Returns undefined if any step is missing.
 */
function walkPath(obj, pathStr) {
  if (obj == null || !pathStr) return obj;
  // Tokenize: split on '.' but keep bracket contents intact. Then for each
  // dotted piece, pull out trailing bracket segments.
  const raw = String(pathStr);
  const tokens = [];
  let buf = '';
  let depth = 0;
  for (const ch of raw) {
    if (ch === '[') depth++;
    if (ch === ']') depth--;
    if (ch === '.' && depth === 0) {
      if (buf) tokens.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf) tokens.push(buf);
  // Each token can have trailing [N] or [field=value] segments
  let cur = obj;
  for (const t of tokens) {
    if (cur == null) return undefined;
    const pieces = t.split(/(?=\[)/);   // "foo[0][id=x]" → ["foo","[0]","[id=x]"]
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i];
      if (cur == null) return undefined;
      if (piece.startsWith('[') && piece.endsWith(']')) {
        const inner = piece.slice(1, -1);
        if (/^\d+$/.test(inner)) {
          cur = cur[parseInt(inner, 10)];
        } else if (inner.includes('=')) {
          const [k, v] = inner.split('=').map((s) => s.trim());
          if (!Array.isArray(cur)) return undefined;
          cur = cur.find((el) => el && String(el[k]) === v);
        } else {
          cur = cur[inner];
        }
      } else {
        cur = cur[piece];
      }
    }
  }
  return cur;
}

/**
 * Expand template tokens in an arg value. Supports:
 *   {{now}}         → Date.now()
 *   {{now-N}}       → Date.now() - N (N in ms, useful for freshness ops)
 *   {{iso:now-Nms}} → ISO string of now - N ms
 *   anything else   → literal
 */
function expandTemplate(v) {
  if (typeof v !== 'string') return v;
  const m = v.match(/^\{\{\s*(iso:)?now(?:\s*-\s*(\d+))?\s*(ms|min|sec|h)?\s*\}\}$/);
  if (!m) return v;
  const isIso = !!m[1];
  const n = m[2] ? parseInt(m[2], 10) : 0;
  const unit = m[3] || 'ms';
  const mult = unit === 'h' ? 3_600_000 : unit === 'min' ? 60_000 : unit === 'sec' ? 1_000 : 1;
  const t = Date.now() - n * mult;
  return isIso ? new Date(t).toISOString() : t;
}

function isRetryableMissingJsonPath(jsonPath, op, observed) {
  if (observed !== undefined) return false;
  if (op === 'absent' || op === 'falsy') return false;
  const path = String(jsonPath || '');
  return path.includes('[') && path.includes('=') && path.includes(']');
}

function maybeLoadNotificationAcks(filePath, args) {
  if (args.ackPath === false || args.overlayNotificationAcks === false) return null;
  const explicit = typeof args.ackPath === 'string' ? expandPath(args.ackPath) : null;
  const candidates = explicit
    ? [explicit]
    : [
        path.join(path.dirname(filePath), '..', 'notifications-ack.json'),
        path.join(path.dirname(filePath), 'notifications-ack.json'),
      ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return JSON.parse(fs.readFileSync(candidate, 'utf8')) || {};
      }
    } catch { /* ignore malformed/mid-write ack files */ }
  }
  return null;
}

function overlayNotificationAck(entry, acks) {
  if (!acks || !entry?.payload?.id || !acks[entry.payload.id]) return entry;
  return {
    ...entry,
    payload: {
      ...entry.payload,
      acknowledged: true,
      acknowledged_at: acks[entry.payload.id].acknowledged_at,
    },
  };
}

function compareValues(observed, op, expected) {
  // Normalize date-like strings for numeric ops so verifiers can say
  // "lastUpdate > now-1h" even if the JSON field is an ISO string.
  const observedNum =
    typeof observed === 'number' ? observed :
    typeof observed === 'string' && !Number.isNaN(Date.parse(observed)) ? Date.parse(observed) :
    NaN;
  const expectedNum =
    typeof expected === 'number' ? expected :
    typeof expected === 'string' && !Number.isNaN(Date.parse(expected)) ? Date.parse(expected) :
    NaN;
  const bothNumeric = !Number.isNaN(observedNum) && !Number.isNaN(expectedNum);
  switch (op) {
    case '>':  return bothNumeric && observedNum > expectedNum;
    case '>=': return bothNumeric && observedNum >= expectedNum;
    case '<':  return bothNumeric && observedNum < expectedNum;
    case '<=': return bothNumeric && observedNum <= expectedNum;
    case '==': return observed === expected || (bothNumeric && observedNum === expectedNum);
    case '!=': return observed !== expected && !(bothNumeric && observedNum === expectedNum);
    case 'exists':  return observed !== undefined && observed !== null;
    case 'absent':  return observed === undefined || observed === null;
    case 'truthy':  return Boolean(observed);
    case 'falsy':   return !observed;
    case 'matches': {
      if (observed == null) return false;
      try { return new RegExp(String(expected)).test(String(observed)); }
      catch { return false; }
    }
    case 'not_matches': {
      if (observed == null) return true;
      try { return !(new RegExp(String(expected)).test(String(observed))); }
      catch { return false; }
    }
    default:
      return false;
  }
}

function parseLogTimestamp(line, now = new Date()) {
  const iso = line.match(/\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\b/);
  if (iso) {
    const ms = Date.parse(iso[1]);
    return Number.isFinite(ms) ? ms : null;
  }

  const bracketed = line.match(/^\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]/);
  if (!bracketed) return null;

  const hh = Number.parseInt(bracketed[1], 10);
  const mm = Number.parseInt(bracketed[2], 10);
  const ss = bracketed[3] ? Number.parseInt(bracketed[3], 10) : 0;

  const local = new Date(now);
  local.setHours(hh, mm, ss, 0);
  if (local.getTime() > now.getTime() + 5 * 60_000) local.setDate(local.getDate() - 1);

  const utc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hh, mm, ss, 0));
  if (utc.getTime() > now.getTime() + 5 * 60_000) utc.setUTCDate(utc.getUTCDate() - 1);

  // Home23 log files can contain both local and UTC-only `[HH:MM:SS]` stamps
  // after restarts/log rotation. Use the interpretation closest to now.
  const candidates = [local.getTime(), utc.getTime()];
  candidates.sort((a, b) => Math.abs(now.getTime() - a) - Math.abs(now.getTime() - b));
  return candidates[0];
}

/**
 * Scan a plain text log tail for a regex within a recent time window.
 * Supports ISO timestamps and Home23's `[HH:MM:SS] LEVEL ...` log format.
 *
 * args: {
 *   path: "instances/jerry/logs/engine-err.log",
 *   pattern: "\\[TimeoutManager\\] Cycle timeout exceeded",
 *   windowMinutes?: 30,
 *   maxCount?: 0,
 *   minCount?: null,
 *   maxLines?: 5000,
 *   contextPattern?: "\\[cycle-phase\\] timeout context",
 *   contextWindowLines?: 3
 * }
 */
verifiers.log_recent_count = async function logRecentCount(args = {}) {
  const { path: filePath, pattern } = args;
  if (!filePath) return { ok: false, detail: 'path required' };
  if (!pattern) return { ok: false, detail: 'pattern required' };

  const full = expandPath(filePath);
  if (!fs.existsSync(full)) return { ok: false, detail: `missing: ${filePath}` };

  let re;
  try {
    re = new RegExp(pattern);
  } catch (err) {
    return { ok: false, detail: `invalid pattern: ${err.message}` };
  }
  let contextRe = null;
  if (args.contextPattern) {
    try {
      contextRe = new RegExp(args.contextPattern);
    } catch (err) {
      return { ok: false, detail: `invalid contextPattern: ${err.message}` };
    }
  }
  let sinceRe = null;
  if (args.sincePattern) {
    try {
      sinceRe = new RegExp(args.sincePattern);
    } catch (err) {
      return { ok: false, detail: `invalid sincePattern: ${err.message}` };
    }
  }

  const windowMin = Number.isFinite(args.windowMinutes) ? args.windowMinutes : 60;
  const maxLines = Math.min(args.maxLines || 5000, 50000);
  const hasMin = Number.isFinite(args.minCount);
  const minCount = hasMin ? args.minCount : null;
  const maxCount = Number.isFinite(args.maxCount) ? args.maxCount : 0;
  const now = new Date();
  const cutoffMs = now.getTime() - windowMin * 60_000;

  try {
    const raw = fs.readFileSync(full, 'utf8');
    const lines = raw.split('\n');
    let start = Math.max(0, lines.length - maxLines);
    let sinceLineMatched = false;
    if (sinceRe) {
      for (let i = lines.length - 1; i >= start; i--) {
        const line = lines[i];
        if (!line) continue;
        if (sinceRe.test(line)) {
          start = i + 1;
          sinceLineMatched = true;
          sinceRe.lastIndex = 0;
          break;
        }
        sinceRe.lastIndex = 0;
      }
    }
    let matchCount = 0;
    let scanned = 0;
    let timestamped = 0;
    let firstMatch = null;
    let lastMatch = null;
    const contextWindowLines = Math.max(0, Math.min(args.contextWindowLines || 3, 20));

    const summarizeContext = (line) => {
      const jsonStart = line.indexOf('{');
      if (jsonStart === -1) return line.slice(0, 180);
      try {
        const parsed = JSON.parse(line.slice(jsonStart));
        const parts = [];
        if (parsed.phase) parts.push(`phase=${parsed.phase}`);
        if (Number.isFinite(parsed.phaseElapsedMs)) parts.push(`phaseElapsedMs=${parsed.phaseElapsedMs}`);
        if (Number.isFinite(parsed.elapsedMs)) parts.push(`elapsedMs=${parsed.elapsedMs}`);
        return parts.length ? parts.join(' ') : line.slice(0, 180);
      } catch {
        return line.slice(0, 180);
      }
    };

    for (let i = start; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      scanned++;
      if (!re.test(line)) continue;
      re.lastIndex = 0;
      const tsMs = parseLogTimestamp(line, now);
      if (!tsMs || tsMs < cutoffMs) continue;
      timestamped++;
      matchCount++;
      const item = {
        ts: new Date(tsMs).toISOString(),
        line: line.slice(0, 180),
      };
      if (contextRe) {
        for (let j = i + 1; j <= Math.min(lines.length - 1, i + contextWindowLines); j++) {
          const contextLine = lines[j];
          if (!contextLine) continue;
          if (!contextRe.test(contextLine)) {
            contextRe.lastIndex = 0;
            continue;
          }
          contextRe.lastIndex = 0;
          item.contextLine = contextLine.slice(0, 240);
          item.contextSummary = summarizeContext(contextLine);
          break;
        }
      }
      if (!firstMatch) firstMatch = item;
      lastMatch = item;
    }

    const ok = hasMin ? matchCount >= minCount : matchCount <= maxCount;
    const threshold = hasMin ? `need ${minCount}` : `limit ${maxCount}`;
    const contextDetail = lastMatch?.contextSummary ? `; latest context ${lastMatch.contextSummary}` : '';
    return {
      ok,
      detail: `${matchCount} matching log entries in last ${windowMin}m (${threshold}); scanned ${scanned}${contextDetail}`,
      observed: { matchCount, windowMin, maxCount, minCount, scanned, timestamped, sinceLineMatched, firstMatch, lastMatch },
    };
  } catch (err) {
    return { ok: false, detail: `read failed: ${err.message}` };
  }
};

/**
 * Verify a Home23 harness cron-jobs.json file has no enabled jobs stuck in an
 * error streak.
 *
 * args: {
 *   path: "instances/forrest/conversations/cron-jobs.json",
 *   maxConsecutiveErrors?: 0,
 *   jobNamePattern?: "HealthKit|dashboard"
 * }
 */
verifiers.cron_job_errors = async function cronJobErrors(args = {}) {
  const { path: filePath } = args;
  if (!filePath) return { ok: false, detail: 'path required' };
  const full = expandPath(filePath);
  if (!fs.existsSync(full)) return { ok: false, detail: `missing: ${filePath}` };

  let nameRe = null;
  if (args.jobNamePattern) {
    try {
      nameRe = new RegExp(args.jobNamePattern, 'i');
    } catch (err) {
      return { ok: false, detail: `invalid jobNamePattern: ${err.message}` };
    }
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
    const jobs = Array.isArray(parsed) ? parsed : parsed?.jobs;
    if (!Array.isArray(jobs)) {
      return { ok: false, detail: 'cron state has no jobs array', observed: { path: filePath } };
    }

    const maxConsecutiveErrors = Number.isFinite(args.maxConsecutiveErrors)
      ? args.maxConsecutiveErrors
      : 0;
    let excludeRe = null;
    if (args.excludeNamePattern) {
      try {
        excludeRe = new RegExp(args.excludeNamePattern, 'i');
      } catch (err) {
        return { ok: false, detail: `invalid excludeNamePattern: ${err.message}` };
      }
    }
    const isEnabled = (job) => {
      if (Object.prototype.hasOwnProperty.call(job, 'enabled')) return job.enabled !== false;
      if (Object.prototype.hasOwnProperty.call(job, 'status')) return job.status !== 'disabled';
      return true;
    };
    const jobState = (job, key) => {
      const state = job.state && typeof job.state === 'object' ? job.state : {};
      return Object.prototype.hasOwnProperty.call(job, key) ? job[key] : state[key];
    };

    const failingJobs = jobs
      .filter((job) => isEnabled(job))
      .filter((job) => !nameRe || nameRe.test(String(job.name || job.id || '')))
      .filter((job) => !excludeRe || !excludeRe.test(String(job.name || job.id || '')))
      .map((job) => {
        const consecutiveErrors = Number(jobState(job, 'consecutiveErrors') || 0);
        const lastStatus = String(jobState(job, 'lastStatus') || '').toLowerCase();
        return {
          id: job.id || null,
          name: job.name || job.id || 'unnamed cron job',
          lastStatus: lastStatus || null,
          consecutiveErrors,
          lastRunAtMs: jobState(job, 'lastRunAtMs') || null,
          lastDurationMs: jobState(job, 'lastDurationMs') || null,
        };
      })
      .filter((job) =>
        job.lastStatus === 'error' && job.consecutiveErrors > maxConsecutiveErrors
      );

    if (failingJobs.length === 0) {
      return {
        ok: true,
        detail: '0 failing enabled cron jobs',
        observed: { totalJobs: jobs.length, failingJobs: [] },
      };
    }

    const labels = failingJobs.slice(0, 4)
      .map((job) => `${job.name} (${job.consecutiveErrors} errors)`)
      .join('; ');
    return {
      ok: false,
      detail: `${failingJobs.length} failing enabled cron job${failingJobs.length === 1 ? '' : 's'}: ${labels}`,
      observed: { totalJobs: jobs.length, failingJobs },
    };
  } catch (err) {
    return { ok: false, detail: `cron state read failed: ${err.message}`, observed: { path: filePath } };
  }
};

/**
 * GET a URL, parse JSON response, extract a dot-path, compare with op/value.
 * Covers: tile sensor freshness, pi-bridge health endpoints, live-problems
 * status checks, any JSON API with a mtime/count/status field.
 *
 * args: {
 *   url: "http://localhost:5002/api/sensors",
 *   timeoutMs?: 5000,
 *   path: "byKey.weather.lastUpdateMs",
 *   op:   ">" | ">=" | "<" | "<=" | "==" | "!=" | "exists" | "absent" | "matches" | "not_matches" | "truthy" | "falsy",
 *   value?: "{{now-3600000}}" | 100 | "healthy" | ...,    (optional for exists/absent/truthy/falsy)
 *   expectStatus?: 200,                                     (HTTP status guard; default = ok range)
 * }
 */
verifiers.jsonpath_http = async function jsonpath_http(args = {}) {
  const { url, timeoutMs = 5000, path: jsonPath, op, expectStatus } = args;
  if (!url) return { ok: false, detail: 'url required' };
  if (!op) return { ok: false, detail: 'op required' };

  const maxAttempts = Math.max(1, Math.floor(args.maxAttempts ?? 2));
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      const expected = expectStatus
        ? res.status === expectStatus
        : res.ok;
      if (!expected) {
        return { ok: false, detail: `HTTP ${res.status}${expectStatus ? ` (expected ${expectStatus})` : ''}`, observed: { status: res.status } };
      }
      const body = await res.json();
      const observed = walkPath(body, jsonPath);
      const value = expandTemplate(args.value);
      const passed = compareValues(observed, op, value);
      if (!passed && isRetryableMissingJsonPath(jsonPath, op, observed) && attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, Math.min(500 * attempt, 1500)));
        continue;
      }
      // Short-form human detail
      const obsSnippet = observed === undefined ? 'undefined'
        : typeof observed === 'object' ? JSON.stringify(observed).slice(0, 80)
        : String(observed).slice(0, 80);
      const valSnippet = value === undefined ? '—'
        : typeof value === 'object' ? JSON.stringify(value).slice(0, 80)
        : String(value).slice(0, 80);
      const retryDetail = attempt > 1 ? ` after ${attempt} attempts` : '';
      const missingDetail = !passed && isRetryableMissingJsonPath(jsonPath, op, observed) ? ' (missing selected array element)' : '';
      return {
        ok: passed,
        detail: `${jsonPath}=${obsSnippet} ${op} ${valSnippet} → ${passed ? 'pass' : 'fail'}${retryDetail}${missingDetail}`,
        observed: { value: observed, compared: value },
      };
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, Math.min(250 * attempt, 1000)));
      }
    } finally {
      clearTimeout(to);
    }
  }
  return { ok: false, detail: `fetch failed after ${maxAttempts} attempts: ${lastError?.message || 'unknown error'}` };
};

/**
 * Scan the tail of a JSONL file for entries matching criteria within a time
 * window. Returns ok=true if match count >= minCount (default 1).
 *
 * args: {
 *   path: "~/.health_log.jsonl",
 *   windowMinutes: 360,              (how far back; timestamps read from `tsField`)
 *   tsField?: "ts",                  (ISO or epoch-ms field; default "ts")
 *   matchField?: "type",             (optional; filters entries where entry[matchField] == matchValue or regex)
 *   matchValue?: "health",
 *   matchOp?: "==" | "matches",      (default "==")
 *   minCount?: 1,
 *   maxLines?: 5000,                 (safety cap on tail read)
 * }
 */
verifiers.jsonl_recent_match = async function jsonl_recent_match(args = {}) {
  const { path: filePath } = args;
  if (!filePath) return { ok: false, detail: 'path required' };
  const full = filePath.replace(/^~/, os.homedir());
  if (!fs.existsSync(full)) return { ok: false, detail: `missing: ${filePath}` };
  const tsField = args.tsField || 'ts';
  const minCount = Number.isFinite(args.minCount) ? args.minCount : 1;
  const hasMax = Number.isFinite(args.maxCount);
  const maxCount = hasMax ? args.maxCount : null;
  const windowMin = Number.isFinite(args.windowMinutes) ? args.windowMinutes : 60;
  const maxLines = Math.min(args.maxLines || 5000, 50000);
  const filters = Array.isArray(args.filters) ? args.filters.filter(f => f && f.field) : [];
  const notificationAcks = maybeLoadNotificationAcks(full, args);
  if (args.matchField != null) {
    filters.push({ field: args.matchField, op: args.matchOp || '==', value: args.matchValue });
  }
  const cutoffMs = Date.now() - windowMin * 60_000;
  try {
    // Read last maxLines lines efficiently enough for N up to 50k.
    const raw = fs.readFileSync(full, 'utf8');
    const lines = raw.split('\n');
    const start = Math.max(0, lines.length - maxLines);
    let matchCount = 0;
    let scanned = 0;
    let lastMatch = null;
    for (let i = start; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      scanned++;
      let entry;
      try { entry = overlayNotificationAck(JSON.parse(line), notificationAcks); } catch { continue; }
      const tsRaw = entry[tsField];
      const tsMs = typeof tsRaw === 'number' ? tsRaw : Date.parse(tsRaw || '');
      if (!tsMs || tsMs < cutoffMs) continue;
      let matched = true;
      for (const filter of filters) {
        const fv = walkPath(entry, filter.field);
        if (!compareValues(fv, filter.op || '==', filter.value)) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;
      matchCount++;
      lastMatch = { ts: tsRaw, entrySnippet: JSON.stringify(entry).slice(0, 120) };
    }
    const ok = matchCount >= minCount && (!hasMax || matchCount <= maxCount);
    return {
      ok,
      detail: ok
        ? `${matchCount} matching entries in last ${windowMin}m${hasMax ? ` (limit ${maxCount})` : ''}${lastMatch ? ` (latest ${lastMatch.ts})` : ''}`
        : hasMax && matchCount > maxCount
          ? `${matchCount} matching entries in last ${windowMin}m (limit ${maxCount}); scanned ${scanned}`
          : `only ${matchCount} matching entries in last ${windowMin}m (need ${minCount}); scanned ${scanned}`,
      observed: { matchCount, scanned, windowMin, minCount, maxCount, filters, lastMatch },
    };
  } catch (err) {
    return { ok: false, detail: `read failed: ${err.message}` };
  }
};

/**
 * Check that a JSONL bridge is not merely being written, but contains recent
 * semantic data. This catches the Health bridge failure mode where cron keeps
 * appending fresh wrapper timestamps around stale HealthKit payloads.
 *
 * args: {
 *   path: "~/.health_log.jsonl",
 *   metricDateField: "metrics.heartRateVariability.date",
 *   maxAgeDays: 3,
 *   maxLines?: 5000
 * }
 */
verifiers.jsonl_metric_date_fresh = async function jsonlMetricDateFresh(args = {}) {
  const { path: filePath } = args;
  if (!filePath) return { ok: false, detail: 'path required' };
  const full = filePath.replace(/^~/, os.homedir());
  if (!fs.existsSync(full)) return { ok: false, detail: `missing: ${filePath}` };

  const metricDateField = args.metricDateField || 'metrics.heartRateVariability.date';
  const maxAgeDays = Number.isFinite(args.maxAgeDays) ? args.maxAgeDays : 3;
  const maxLines = Math.min(args.maxLines || 5000, 50000);

  try {
    const raw = fs.readFileSync(full, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const start = Math.max(0, lines.length - maxLines);
    let newest = null;
    let newestEntryTs = null;
    let scanned = 0;

    for (let i = start; i < lines.length; i++) {
      let entry;
      try { entry = JSON.parse(lines[i]); } catch { continue; }
      scanned++;
      const value = walkPath(entry, metricDateField);
      const day = typeof value === 'string' ? value.slice(0, 10) : null;
      const ms = day ? Date.parse(`${day}T00:00:00Z`) : NaN;
      if (!Number.isFinite(ms)) continue;
      if (!newest || ms > newest.ms) {
        newest = { day, ms };
        newestEntryTs = entry.ts || null;
      }
    }

    if (!newest) {
      return {
        ok: false,
        detail: `no parseable metric date at ${metricDateField}; scanned ${scanned}`,
        observed: { scanned, metricDateField },
      };
    }

    const today = new Date();
    const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    const ageDays = Math.floor((todayUtc - newest.ms) / 86400000);
    const ok = ageDays <= maxAgeDays;
    return {
      ok,
      detail: ok
        ? `${metricDateField} fresh (${newest.day}, ${ageDays}d old)`
        : `${metricDateField} stale (${newest.day}, ${ageDays}d old, threshold ${maxAgeDays}d)`,
      observed: { metricDateField, newestMetricDate: newest.day, newestEntryTs, ageDays, maxAgeDays, scanned },
    };
  } catch (err) {
    return { ok: false, detail: `read failed: ${err.message}` };
  }
};

/**
 * Compose other verifiers. op=all_of → ok iff every child ok; op=any_of → ok
 * iff any child ok. Each child is a full verifier spec {type, args}. Evaluated
 * serially; each child gets the same ctx.
 *
 * args: {
 *   op: "all_of" | "any_of",
 *   verifiers: [ {type, args}, ... ],
 * }
 */
verifiers.composed = async function composed(args = {}, ctx = {}) {
  const { op = 'all_of' } = args;
  const specs = Array.isArray(args.verifiers) ? args.verifiers : [];
  if (specs.length === 0) return { ok: false, detail: 'composed: no child verifiers' };
  const results = [];
  for (const spec of specs) {
    // Avoid infinite recursion: cap composed depth.
    const depth = (ctx._composedDepth || 0) + 1;
    if (depth > 3) {
      results.push({ ok: false, detail: 'composed: max depth (3) exceeded' });
      continue;
    }
    results.push(await runVerifier(spec, { ...ctx, _composedDepth: depth }));
  }
  const okList = results.map((r) => r.ok);
  const ok = op === 'any_of' ? okList.some(Boolean) : okList.every(Boolean);
  const pass = okList.filter(Boolean).length;
  const detailParts = results.slice(0, 4).map((r, i) => `${specs[i]?.type}=${r.ok ? '✓' : '✗'}${r.detail ? `(${r.detail.slice(0, 60)})` : ''}`);
  return {
    ok,
    detail: `${op} ${pass}/${results.length} passed — ${detailParts.join(' · ')}${results.length > 4 ? ' …' : ''}`,
    observed: { op, pass, total: results.length, childResults: results.map((r) => ({ ok: r.ok, detail: r.detail })) },
  };
};

/**
 * Agenda handoff completion check. The agenda "Do it" path can create a
 * bounded live-problem whose only verifier is: did the diagnostic harness post
 * back a fix/diagnosis recipe for this agenda item after it was dispatched?
 *
 * args: {
 *   problemId: "agenda_ag-...",
 *   since?: ISO timestamp,
 *   outcomes?: ["fixed", "failed", "blocked", "unknown"]  // default: any
 * }
 */
verifiers.fix_recipe_recorded = async function fixRecipeRecorded(args = {}, ctx = {}) {
  const problemId = args.problemId;
  const brainDir = ctx.brainDir;
  if (!problemId) return { ok: false, detail: 'problemId required' };
  if (!brainDir) return { ok: false, detail: 'brainDir required' };

  const file = path.join(brainDir, 'live-problems.json');
  if (!fs.existsSync(file)) return { ok: false, detail: 'live-problems.json missing' };

  const sinceMs = args.since ? Date.parse(args.since) : 0;
  const allowed = Array.isArray(args.outcomes) && args.outcomes.length > 0
    ? new Set(args.outcomes.map((x) => String(x).toLowerCase()))
    : null;

  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const problem = (raw.problems || []).find((p) => p && p.id === problemId);
    if (!problem) return { ok: false, detail: `problem not found: ${problemId}` };

    const recipes = [
      ...(Array.isArray(problem.fixRecipeHistory) ? problem.fixRecipeHistory : []),
      ...(problem.fixRecipe ? [problem.fixRecipe] : []),
    ].filter(Boolean);
    const recipe = recipes
      .filter((r) => {
        const atMs = Date.parse(r.at || '');
        if (sinceMs && (!atMs || atMs < sinceMs)) return false;
        if (allowed && !allowed.has(String(r.dispatchOutcome || '').toLowerCase())) return false;
        return true;
      })
      .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))[0];

    if (!recipe) {
      return { ok: false, detail: `no diagnostic recipe recorded for ${problemId}` };
    }

    return {
      ok: true,
      detail: `recipe recorded (${recipe.dispatchOutcome || 'unknown'} / verifier ${recipe.verifierStatus || 'unknown'})`,
      observed: {
        at: recipe.at || null,
        dispatchOutcome: recipe.dispatchOutcome || null,
        verifierStatus: recipe.verifierStatus || null,
        turnId: recipe.turnId || null,
      },
    };
  } catch (err) {
    return { ok: false, detail: `read failed: ${err.message}` };
  }
};

/**
 * OAuth credential lineage is still ours, and not about to lapse.
 *
 * Providers that rotate refresh tokens (OpenAI Codex, notably) invalidate every
 * older copy the moment any client re-mints for that account. The access token
 * keeps working for its full life regardless — 10 days for Codex — so the break
 * is invisible until something finally attempts a refresh, at which point every
 * consumer fails simultaneously. That is exactly how 2026-07-27 played out: the
 * Codex CLI re-minted on 07-22 and Home23 ran on borrowed time for 4.5 days.
 *
 * Comparing issue times catches the takeover the same day it happens, without
 * spending the refresh token to find out.
 *
 * args: {
 *   profilePath,             // credential store Home23 depends on
 *   profileKey,              // profile within that store
 *   rivalPath?,              // another client's store for the same account
 *   warnDaysBeforeExpiry?    // default 3
 * }
 */
verifiers.oauth_token_lineage_fresh = function oauthTokenLineageFresh(args = {}) {
  const { profilePath, profileKey, rivalPath } = args;
  const warnDays = Number.isFinite(args.warnDaysBeforeExpiry) ? args.warnDaysBeforeExpiry : 3;
  if (!profilePath || !profileKey) return { ok: false, detail: 'profilePath and profileKey required' };

  const decodeIat = (jwt) => {
    try {
      const payload = JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString('utf8'));
      return { iat: payload.iat ?? null, exp: payload.exp ?? null };
    } catch {
      return { iat: null, exp: null };
    }
  };

  let profile;
  try {
    const full = expandPath(profilePath);
    if (!fs.existsSync(full)) return { ok: false, detail: `missing: ${profilePath}` };
    profile = JSON.parse(fs.readFileSync(full, 'utf8'))?.profiles?.[profileKey];
  } catch (err) {
    return { ok: false, detail: `unreadable profile store: ${err.message}` };
  }
  if (!profile?.accessToken) return { ok: false, detail: `missing profile: ${profileKey}` };

  const claims = decodeIat(profile.accessToken);
  const expiresMs = Number.isFinite(profile.expires)
    ? profile.expires
    : (claims.exp ? claims.exp * 1000 : null);
  if (!expiresMs) return { ok: false, detail: 'profile token has no decodable expiry' };

  const now = Date.now();
  const hoursLeft = (expiresMs - now) / 3600000;
  const observed = {
    expiresAt: new Date(expiresMs).toISOString(),
    hoursLeft: Number(hoursLeft.toFixed(1)),
    superseded: false,
  };

  if (hoursLeft <= 0) {
    return { ok: false, detail: `access token expired ${Math.abs(hoursLeft).toFixed(1)}h ago`, observed };
  }

  // The early signal: another client re-minted for this same account, so our
  // refresh token is already dead even though the access token still works.
  if (rivalPath) {
    try {
      const rivalFull = expandPath(rivalPath);
      if (fs.existsSync(rivalFull)) {
        const rival = JSON.parse(fs.readFileSync(rivalFull, 'utf8'))?.tokens;
        const sameAccount = rival?.account_id && profile.accountId
          && String(rival.account_id) === String(profile.accountId);
        if (sameAccount && rival.access_token) {
          const rivalClaims = decodeIat(rival.access_token);
          if (rivalClaims.iat && claims.iat && rivalClaims.iat > claims.iat) {
            observed.superseded = true;
            observed.rivalIssuedAt = new Date(rivalClaims.iat * 1000).toISOString();
            observed.profileIssuedAt = new Date(claims.iat * 1000).toISOString();
            return {
              ok: false,
              detail: `lineage superseded: ${rivalPath} re-minted at ${observed.rivalIssuedAt}, `
                + `after ours at ${observed.profileIssuedAt} — our refresh token is presumed dead. `
                + `Access token still valid for ${hoursLeft.toFixed(1)}h.`,
              observed,
            };
          }
        }
      }
    } catch {
      // A rival store we cannot read is not evidence of takeover; fall through.
    }
  }

  if (hoursLeft < warnDays * 24) {
    return {
      ok: false,
      detail: `access token expires in ${hoursLeft.toFixed(1)}h (warn window ${warnDays}d)`,
      observed,
    };
  }

  return { ok: true, detail: `lineage current, ${(hoursLeft / 24).toFixed(1)}d until expiry`, observed };
};

function listVerifierTypes() {
  return Object.keys(verifiers);
}

async function runVerifier(spec, ctx) {
  if (!spec || !spec.type) return { ok: false, detail: 'missing verifier spec' };
  const fn = verifiers[spec.type];
  if (!fn) return { ok: false, detail: `unknown verifier type: ${spec.type}` };
  try {
    const out = await fn(spec.args || {}, ctx || {});
    return out;
  } catch (err) {
    return { ok: false, detail: `verifier threw: ${err.message}` };
  }
}

module.exports = { runVerifier, listVerifierTypes, verifiers };
