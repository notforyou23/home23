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
   * PM2 process is online and is the process that owns a listening TCP port.
   * Catches stale/orphan listeners where HTTP still responds but an older
   * process owns the socket instead of the current PM2 child.
   * args: { name, port }
   */
  pm2_port_owner({ name, port }, ctx = {}) {
    if (!name) return { ok: false, detail: 'name required' };
    if (!port) return { ok: false, detail: 'port required' };

    const portText = String(port).trim();
    if (!/^\d+$/.test(portText)) return { ok: false, detail: `invalid port: ${port}` };

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

    let lsofOut = '';
    try {
      lsofOut = run('lsof', ['-nP', `-iTCP:${portText}`, '-sTCP:LISTEN'], { encoding: 'utf8', timeout: 5000 });
    } catch (err) {
      return {
        ok: false,
        detail: `no listener on port ${portText} for ${name} pid ${pm2Pid}`,
        observed: { name, port: portText, pm2Pid, status, listenerPids: [] },
      };
    }

    const listenerPids = [...new Set(String(lsofOut)
      .trim()
      .split('\n')
      .slice(1)
      .map(line => Number.parseInt(line.trim().split(/\s+/)[1], 10))
      .filter(pid => Number.isFinite(pid) && pid > 0))];

    if (listenerPids.length === 0) {
      return {
        ok: false,
        detail: `no listener on port ${portText} for ${name} pid ${pm2Pid}`,
        observed: { name, port: portText, pm2Pid, status, listenerPids },
      };
    }

    const ok = listenerPids.includes(pm2Pid);
    return {
      ok,
      detail: ok
        ? `port ${portText} owned by ${name} pid ${pm2Pid}`
        : `port ${portText} owned by stale pid ${listenerPids.join(',')}, expected ${name} pid ${pm2Pid}`,
      observed: { name, port: portText, pm2Pid, status, listenerPids },
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
  disk_free({ mount = '/', minGiB = 5 }) {
    try {
      const out = execSync(`df -g ${JSON.stringify(mount)}`, { encoding: 'utf8', timeout: 5000 });
      const lines = out.trim().split('\n');
      if (lines.length < 2) return { ok: false, detail: 'df output unparseable' };
      const cols = lines[1].split(/\s+/);
      // macOS df -g columns: Filesystem Size Used Avail Capacity iused ifree %iused Mounted
      const availGi = parseFloat(cols[3]);
      if (isNaN(availGi)) return { ok: false, detail: `cannot parse avail from: ${lines[1]}` };
      const ok = availGi >= minGiB;
      return {
        ok,
        detail: ok ? `${availGi}GiB free` : `only ${availGi}GiB free (need ${minGiB})`,
        observed: { availGi },
      };
    } catch (err) {
      return { ok: false, detail: `df failed: ${err.message}` };
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

    let hw = { maxNodeCount: 0, lastSeen: null };
    try {
      const raw = fs.readFileSync(hwFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.maxNodeCount === 'number') hw = parsed;
    } catch { /* first run or bad file */ }

    // Update high-water when current is a new maximum.
    if (current > hw.maxNodeCount) {
      const next = { maxNodeCount: current, lastSeen: new Date().toISOString() };
      try {
        fs.writeFileSync(hwFile + '.tmp', JSON.stringify(next, null, 2));
        fs.renameSync(hwFile + '.tmp', hwFile);
      } catch { /* advisory — don't block verification */ }
      hw = next;
    }

    // Not enough baseline — treat as ok, keep collecting data.
    if (hw.maxNodeCount < minBaseline) {
      return {
        ok: true,
        detail: `building baseline (${current} nodes, high-water ${hw.maxNodeCount})`,
        observed: { current, highWater: hw.maxNodeCount },
      };
    }

    const floor = Math.floor(hw.maxNodeCount * (1 - dropThreshold));
    const ok = current >= floor;
    return {
      ok,
      detail: ok
        ? `stable (${current} nodes, high-water ${hw.maxNodeCount})`
        : `regression: ${current} nodes, dropped below ${floor} (high-water ${hw.maxNodeCount})`,
      observed: { current, highWater: hw.maxNodeCount, floor },
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
      try { entry = JSON.parse(line); } catch { continue; }
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
