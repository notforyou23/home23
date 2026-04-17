/**
 * Targets Registry — the canonical vocabulary for live-problems.
 *
 * Loads config/targets.yaml and answers two questions:
 *   1. Is this verifier arg pointing at a real target? (hallucination guard)
 *   2. What targets exist? (fed to the promoter's LLM system prompt)
 *
 * Hand-curated. Nothing writes to it from code. Expanding vocabulary = edit
 * the yaml. That's the point — autonomy is bounded by jtr-approved reality.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const os = require('os');

const DEFAULT_PATH = path.resolve(__dirname, '..', '..', '..', 'config', 'targets.yaml');

function expandHome(p) {
  if (!p || typeof p !== 'string') return p;
  return p.startsWith('~') ? p.replace(/^~/, os.homedir()) : p;
}

class TargetsRegistry {
  constructor({ filePath } = {}) {
    this.filePath = filePath || DEFAULT_PATH;
    this._cache = null;
    this._cacheMtimeMs = 0;
  }

  /** Load (or reload if file changed). Synchronous; returns the raw registry. */
  load() {
    try {
      const stat = fs.statSync(this.filePath);
      if (this._cache && stat.mtimeMs === this._cacheMtimeMs) return this._cache;
      const raw = yaml.load(fs.readFileSync(this.filePath, 'utf8')) || {};
      const data = {
        files: Array.isArray(raw.files) ? raw.files : [],
        urls: Array.isArray(raw.urls) ? raw.urls : [],
        pm2: Array.isArray(raw.pm2) ? raw.pm2 : [],
        mounts: Array.isArray(raw.mounts) ? raw.mounts : [],
        sensors: Array.isArray(raw.sensors) ? raw.sensors : [],
      };
      this._cache = data;
      this._cacheMtimeMs = stat.mtimeMs;
      return data;
    } catch {
      return { files: [], urls: [], pm2: [], mounts: [], sensors: [] };
    }
  }

  /**
   * Check whether a proposed verifier spec only references targets in the
   * registry. Returns { ok: true } or { ok: false, reason }.
   *
   * "Strict" checks on file paths, PM2 names, and mounts (LLM hallucinates
   * these most). URLs use host-pattern fallback (localhost / private / Tailscale)
   * plus explicit registry match for foreign endpoints.
   */
  validateVerifier(spec) {
    if (!spec || !spec.type) return { ok: false, reason: 'missing spec.type' };
    const reg = this.load();
    const args = spec.args || {};

    // For composed verifiers, validate every child
    if (spec.type === 'composed') {
      const children = Array.isArray(args.verifiers) ? args.verifiers : [];
      if (children.length === 0) return { ok: false, reason: 'composed has no children' };
      for (let i = 0; i < children.length; i++) {
        const r = this.validateVerifier(children[i]);
        if (!r.ok) return { ok: false, reason: `child[${i}]: ${r.reason}` };
      }
      return { ok: true };
    }

    if (spec.type === 'file_mtime' || spec.type === 'file_exists' || spec.type === 'jsonl_recent_match') {
      const p = typeof args.path === 'string' ? args.path : '';
      if (!p) return { ok: false, reason: `${spec.type} needs args.path` };
      const known = reg.files.some((f) => expandHome(f.path) === expandHome(p));
      if (!known) return { ok: false, reason: `file not in registry: ${p}` };
      return { ok: true };
    }

    if (spec.type === 'pm2_status') {
      const name = typeof args.name === 'string' ? args.name : '';
      if (!name) return { ok: false, reason: 'pm2_status needs args.name' };
      const known = reg.pm2.some((p) => p.name === name);
      if (!known) return { ok: false, reason: `pm2 name not in registry: ${name}` };
      return { ok: true };
    }

    if (spec.type === 'disk_free') {
      const mount = typeof args.mount === 'string' ? args.mount : '';
      if (!mount) return { ok: false, reason: 'disk_free needs args.mount' };
      const known = reg.mounts.some((m) => m.mount === mount);
      if (!known) return { ok: false, reason: `mount not in registry: ${mount}` };
      return { ok: true };
    }

    if (spec.type === 'http_ping' || spec.type === 'jsonpath_http') {
      const url = typeof args.url === 'string' ? args.url : '';
      if (!url) return { ok: false, reason: `${spec.type} needs args.url` };
      // Registry match OR host-pattern fallback (local/private/tailscale).
      const registered = reg.urls.some((u) => u.url === url || urlShareOrigin(u.url, url));
      if (registered) return { ok: true };
      // Fallback: only allow localhost / private / Tailscale hosts.
      try {
        const u = new URL(url);
        const host = u.hostname;
        const localLike = host === 'localhost' || host === '127.0.0.1' || host === '::1';
        const tailscale = /^100\.\d+\.\d+\.\d+$/.test(host);
        const privateNet = /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(host);
        if (localLike || tailscale || privateNet) return { ok: true };
      } catch { /* fall through */ }
      return { ok: false, reason: `url host not in registry and not on local/private network: ${url}` };
    }

    // graph_not_empty / node_count_stable — engine-internal, no external target
    if (spec.type === 'graph_not_empty' || spec.type === 'node_count_stable') {
      return { ok: true };
    }

    // Unknown types → reject (promoter should only propose known types)
    return { ok: false, reason: `unknown verifier type: ${spec.type}` };
  }

  /** Compact text summary used in the promoter's system prompt. */
  toPromptText() {
    const reg = this.load();
    const lines = [];
    lines.push('KNOWN TARGETS REGISTRY (the ONLY surfaces you may reference in proposed verifiers):');
    if (reg.files.length) {
      lines.push('Files:');
      for (const f of reg.files) lines.push(`  - ${f.path}${f.description ? ` — ${f.description}` : ''}`);
    }
    if (reg.urls.length) {
      lines.push('URLs:');
      for (const u of reg.urls) lines.push(`  - ${u.url}${u.description ? ` — ${u.description}` : ''}`);
    }
    if (reg.pm2.length) {
      lines.push('PM2 processes:');
      for (const p of reg.pm2) lines.push(`  - ${p.name}${p.description ? ` — ${p.description}` : ''}`);
    }
    if (reg.mounts.length) {
      lines.push('Filesystem mounts:');
      for (const m of reg.mounts) lines.push(`  - ${m.mount}${m.description ? ` — ${m.description}` : ''}`);
    }
    if (reg.sensors.length) {
      lines.push('Sensors (use jsonpath_http against /api/sensors with sensors[id=X].ts):');
      for (const s of reg.sensors) lines.push(`  - ${s.id}${s.description ? ` — ${s.description}` : ''}`);
    }
    lines.push('Any file/URL/pm2 name/mount NOT in this registry is off-limits. If the concern is about something not listed here, return verifiable:false with reason="target not in registry".');
    return lines.join('\n');
  }
}

function urlShareOrigin(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin === ub.origin;
  } catch { return false; }
}

module.exports = { TargetsRegistry };
