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

function expandPath(p) {
  if (!p) return p;
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return p;
}

function minutesSince(ts) {
  return (Date.now() - ts) / 60000;
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
      return { ok: true, detail: 'online', observed: { restarts: online[0].pm2_env?.restart_time } };
    } catch (err) {
      return { ok: false, detail: `pm2 jlist failed: ${err.message}` };
    }
  },

  /**
   * HTTP GET returns 2xx within timeoutMs.
   * args: { url, timeoutMs, expectStatus }
   */
  async http_ping({ url, timeoutMs = 5000, expectStatus }) {
    if (!url) return { ok: false, detail: 'url required' };
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
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
      return { ok: false, detail: `fetch failed: ${err.message}` };
    } finally {
      clearTimeout(to);
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
    // Short-form human detail
    const obsSnippet = observed === undefined ? 'undefined'
      : typeof observed === 'object' ? JSON.stringify(observed).slice(0, 80)
      : String(observed).slice(0, 80);
    const valSnippet = value === undefined ? '—'
      : typeof value === 'object' ? JSON.stringify(value).slice(0, 80)
      : String(value).slice(0, 80);
    return {
      ok: passed,
      detail: `${jsonPath}=${obsSnippet} ${op} ${valSnippet} → ${passed ? 'pass' : 'fail'}`,
      observed: { value: observed, compared: value },
    };
  } catch (err) {
    return { ok: false, detail: `fetch failed: ${err.message}` };
  } finally {
    clearTimeout(to);
  }
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
  const windowMin = Number.isFinite(args.windowMinutes) ? args.windowMinutes : 60;
  const maxLines = Math.min(args.maxLines || 5000, 50000);
  const matchField = args.matchField;
  const matchValue = args.matchValue;
  const matchOp = args.matchOp || '==';
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
      if (matchField != null) {
        const fv = walkPath(entry, matchField);
        if (!compareValues(fv, matchOp, matchValue)) continue;
      }
      matchCount++;
      lastMatch = { ts: tsRaw, entrySnippet: JSON.stringify(entry).slice(0, 120) };
    }
    const ok = matchCount >= minCount;
    return {
      ok,
      detail: ok
        ? `${matchCount} matching entries in last ${windowMin}m${lastMatch ? ` (latest ${lastMatch.ts})` : ''}`
        : `only ${matchCount} matching entries in last ${windowMin}m (need ${minCount}); scanned ${scanned}`,
      observed: { matchCount, scanned, windowMin, lastMatch },
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
