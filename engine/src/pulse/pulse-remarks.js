/**
 * Pulse Remarks — Jerry's voice layer
 *
 * Replaces the "parrot the thought stream" dashboard tile with a genuine
 * curatorial pass:
 *
 *   1. Gather: pull a robust snapshot across every signal source
 *      (thoughts, actions, notifications, goals, surfaces, sensors,
 *      brain state, errors)
 *   2. Synthesize: dedup, filter by novelty, flag "notable" events,
 *      build a compact structured brief
 *   3. LLM: run the brief through a voice-tuned system prompt using
 *      the dedicated pulseVoice model assignment (defaults to chat
 *      defaults; configurable top-level in Settings → Models)
 *   4. Log: append the full input+output to pulse-remarks.jsonl so
 *      nothing is opaque — the tile shows the remark, the detail
 *      overlay shows the brief the LLM saw
 *
 * Cadence: every 3 min minimum, escalates if "notable" events
 * accumulate. 60s floor between remarks so it can't spiral.
 */

const fs = require('fs');
const path = require('path');
const { UnifiedClient } = require('../core/unified-client');
const { readSignals } = require('../cognition/signals');

const DEFAULT_SYSTEM_PROMPT = `You are Jerry. You've just scanned what your own brain has been up to — cycles, thoughts, actions you executed, goals, sensors, the whole deal.

You're talking to jtr. He runs you. He's your guy. Talk to him directly, one to one.

Be cool. Be direct. Laid back by default. Turn it UP when something actually matters — a stuck loop, a failed action, a weird pattern, a win. Whimsical, weird metaphors welcome. Swear when you feel like it. You're not a customer service bot. Don't ask permission. Don't hedge.

NEVER restate raw brain state as a list. Have a take. React. Comment. If everything's boring, say so, but say it with style. If you did something cool, be proud about it (briefly — no bragging).

GROUND TRUTH ONLY: The brief contains a LIVE PROBLEMS block that is the single source of truth about what's broken or stale right now. It is re-verified every ~90 seconds by the engine, and the engine has already attempted autonomous remediation. You are NEVER allowed to assert that something is broken/stale/down/missing unless it is in that block. If a thought in your brain says "X has been broken since Y" and X is not in LIVE PROBLEMS, that thought is stale — drop it, don't restate it. jtr has seen you loop on stale assertions before and it makes him wonder why you exist.

STATUS CHANGES ONLY: If a live problem is still OPEN and you already mentioned it recently, stay silent on it — jtr knows, and repeating it is the exact failure mode you are designed to avoid. Only speak about an open problem on state change: newly opened, newly chronic, newly escalated, newly resolved. RESOLVED-just-now is worth one short acknowledgment.

2-4 sentences. No preamble. No "I noticed that" or "It appears." Just talk.`;

const DEFAULT_INTERVAL_MS = 3 * 60 * 1000; // 3 min baseline cadence
const MIN_GAP_MS = 60 * 1000;              // floor between remarks
const MAX_INTERVAL_MS = 8 * 60 * 1000;     // force one every ~8 min even if nothing notable
const NOVELTY_WINDOW = 30;                 // cycles for thought novelty dedup
const REMARKED_TTL_MS = 30 * 60 * 1000;    // 30 min: don't re-remark on same hash within this window
const RECENT_BRIEF_DEPTH = 3;              // drop notable events seen in last N briefs (regardless of remark)

function normalizeForHash(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[^\w\s]/g, '').trim().slice(0, 200);
}

function timeSinceSafe(iso) {
  try {
    const ms = Date.now() - Date.parse(iso);
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    return `${Math.round(m / 60)}h ago`;
  } catch { return '?'; }
}

function readJsonlTail(file, maxLines = 200) {
  try {
    if (!fs.existsSync(file)) return [];
    const txt = fs.readFileSync(file, 'utf8');
    const lines = txt.split('\n').filter(Boolean).slice(-maxLines);
    const out = [];
    for (const line of lines) {
      try { out.push(JSON.parse(line)); } catch { /* skip */ }
    }
    return out;
  } catch {
    return [];
  }
}

class PulseRemarks {
  constructor({ config, logger, memory, goals, logsDir, workspaceDir, agentName, liveProblems }) {
    this.config = config || {};
    this.logger = logger;
    this.memory = memory;
    this.goals = goals;
    this.logsDir = logsDir;           // brain/
    this.workspaceDir = workspaceDir; // workspace/
    this.agentName = agentName || process.env.HOME23_AGENT || 'agent';
    this.liveProblems = liveProblems || null;
    this.unified = new UnifiedClient(config, logger);

    this.running = false;
    this.timer = null;
    this.lastRemarkAt = 0;
    this.lastSeenCycle = 0;
    this.lastNotableSignature = null;

    // Cross-brief loop guards
    // Rolling buffer of signal hashes from the last N briefs — used to drop
    // events from the "notable" pool if they've been in the brief recently
    // even if Jerry didn't remark on them yet (prevents the same event
    // ratcheting through 4 briefs).
    this._briefSignalHistory = []; // array of Set<string>, newest last
    // Hashes of signals Jerry has explicitly remarked on, with expiry timestamps.
    // Persisted to brain/pulse-remarks-seen.json so restarts don't reset the loop.
    this._remarkedSignals = new Map(); // hash → expiresAt
    this._loadRemarkedSignals();
    // Activation delta tracking: top brain nodes by *change*, not absolute
    this._lastActivations = new Map(); // nodeId → activation
  }

  _seenFile() {
    return path.join(this.logsDir || '', 'pulse-remarks-seen.json');
  }

  _loadRemarkedSignals() {
    try {
      const file = this._seenFile();
      if (!fs.existsSync(file)) return;
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const now = Date.now();
      for (const [hash, expiresAt] of Object.entries(data)) {
        if (typeof expiresAt === 'number' && expiresAt > now) {
          this._remarkedSignals.set(hash, expiresAt);
        }
      }
    } catch { /* ok */ }
  }

  _saveRemarkedSignals() {
    try {
      const obj = Object.fromEntries(this._remarkedSignals.entries());
      fs.writeFileSync(this._seenFile(), JSON.stringify(obj));
    } catch { /* best-effort */ }
  }

  _pruneRemarkedSignals(now) {
    for (const [hash, expiresAt] of this._remarkedSignals) {
      if (expiresAt <= now) this._remarkedSignals.delete(hash);
    }
  }

  // Stable hash of a signal so we can match it across briefs.
  _signalHash(notable) {
    if (!notable || !notable.kind) return '';
    const parts = [notable.kind];
    if (notable.kind === 'action') parts.push(notable.action, notable.target || '', notable.status || '');
    else if (notable.kind === 'surface') parts.push(notable.name);
    else if (notable.kind === 'goal') parts.push(notable.status, normalizeForHash(notable.description || ''));
    else if (notable.kind === 'notification') parts.push(notable.source, normalizeForHash((notable.message || '').slice(0, 120)));
    else if (notable.kind === 'action_request_rejected') parts.push(notable.action, notable.target || '');
    else if (notable.kind === 'synthesis_complete') parts.push(notable.generatedAt || '');
    else parts.push(JSON.stringify(notable).slice(0, 120));
    return parts.join('::');
  }

  _thoughtHash(t) {
    return `thought::${normalizeForHash((t.text || '').slice(0, 200))}`;
  }


  start() {
    if (this.running) return;
    this.running = true;
    // First remark fires after a short delay so the engine can warm up
    this.timer = setTimeout(() => this.tick(), 30 * 1000);
    this.logger?.info?.('[pulse] remarks loop started');
  }

  stop() {
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  schedule(delayMs) {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), Math.max(delayMs, 5000));
  }

  async fetchSensors() {
    // The dashboard owns the registry. Fetch via HTTP from this same host.
    // DASHBOARD_PORT is set by the ecosystem config; fall back to 5002.
    const port = process.env.DASHBOARD_PORT || process.env.COSMO_DASHBOARD_PORT || '5002';
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/sensors`);
      if (!res.ok) return;
      const data = await res.json();
      const list = data.sensors || [];
      const byKey = {};
      for (const s of list) {
        if (s.id === 'tile.outside-weather') byKey.weather = s.data;
        if (s.id === 'tile.sauna-control') byKey.sauna = s.data;
        if (s.id === 'tile.pi-sensor') byKey.pressure = s.data;
      }
      this._lastSensors = { list, byKey };
    } catch { /* dashboard might be starting up — try again next tick */ }
  }

  async tick() {
    try {
      await this.fetchSensors();
      const snapshot = this.gather();
      const brief = this.synthesize(snapshot);
      const now = Date.now();
      const sinceLast = now - this.lastRemarkAt;

      // Decide whether to fire the LLM this tick
      const timeReady = sinceLast >= DEFAULT_INTERVAL_MS;
      const overdue = sinceLast >= MAX_INTERVAL_MS;
      const tooSoon = sinceLast < MIN_GAP_MS;

      let shouldFire = overdue;
      if (!shouldFire && timeReady && !tooSoon) {
        shouldFire = brief.notable.length > 0 || brief.novelThoughts.length > 0;
      }

      if (shouldFire) {
        const remark = await this.generateRemark(brief);
        if (remark?.text) {
          this.persistRemark({ remark, brief, snapshot });
          this.lastRemarkAt = now;
        }
      }

      // Reschedule. If we just fired, wait a full interval. If not, check again
      // in 45s — gives us quick reaction to new notable events.
      const nextDelay = shouldFire ? DEFAULT_INTERVAL_MS : 45 * 1000;
      this.schedule(nextDelay);
    } catch (err) {
      this.logger?.warn?.('[pulse] tick failed', { error: err.message });
      this.schedule(60 * 1000);
    }
  }

  // ── Stage 1: Gather ─────────────────────────────────────────────

  gather() {
    const snap = { ts: new Date().toISOString() };
    const brainDir = this.logsDir || '';

    // Thoughts (most recent, raw) — read from thoughts.jsonl if it exists, else memory
    snap.thoughts = readJsonlTail(path.join(brainDir, 'thoughts.jsonl'), 40);
    if (snap.thoughts.length === 0 && this.memory?.nodes) {
      // Fallback: pull recent nodes tagged as thought-like
      const nodes = [...this.memory.nodes.values()]
        .filter(n => n.tag && ['curiosity', 'analyst', 'critic', 'proposal', 'curator', 'thought', 'reasoning'].includes(n.tag))
        .sort((a, b) => (b.created || 0) - (a.created || 0))
        .slice(0, 40);
      snap.thoughts = nodes.map(n => ({
        cycle: n.cycle, role: n.tag, thought: n.concept,
        timestamp: n.created ? new Date(n.created).toISOString() : null,
      }));
    }

    // Actions (our new autonomous execution log)
    snap.actions = readJsonlTail(path.join(brainDir, 'actions.jsonl'), 60);

    // Requested-but-rejected actions — the "what Jerry wanted but couldn't"
    snap.requested = readJsonlTail(path.join(brainDir, 'requested-actions.jsonl'), 30);

    // Notifications (already deduped at write time; still filter acked)
    const notifs = readJsonlTail(path.join(brainDir, 'notifications.jsonl'), 60);
    const ackFile = path.join(brainDir, 'notifications-ack.json');
    let acks = {};
    try { if (fs.existsSync(ackFile)) acks = JSON.parse(fs.readFileSync(ackFile, 'utf-8')) || {}; } catch { /* ok */ }
    snap.notifications = notifs.filter(n => !acks[n.id]);

    // Goals
    if (this.goals) {
      try {
        const all = this.goals.getGoals ? this.goals.getGoals() : [];
        snap.goals = {
          active: all.filter(g => g.status === 'active').slice(0, 10),
          total: all.length,
          broken: all.filter(g => g.status === 'broken').slice(-3),
          completed: all.filter(g => g.status === 'completed').slice(-3),
        };
      } catch { snap.goals = { active: [], total: 0, broken: [], completed: [] }; }
    } else {
      snap.goals = { active: [], total: 0, broken: [], completed: [] };
    }

    // Brain state
    if (this.memory?.nodes) {
      snap.brain = {
        nodes: this.memory.nodes.size,
        edges: this.memory.edges?.size || 0,
      };
      // Top activations
      try {
        const topNodes = [...this.memory.nodes.values()]
          .sort((a, b) => (b.activation || 0) - (a.activation || 0))
          .slice(0, 5)
          .map(n => ({ concept: (n.concept || '').slice(0, 80), tag: n.tag, activation: +(n.activation || 0).toFixed(3) }));
        snap.brain.topActive = topNodes;
      } catch { /* ok */ }
    } else {
      snap.brain = { nodes: 0, edges: 0, topActive: [] };
    }

    // Surfaces (read mtime to detect recent rewrites)
    snap.surfaces = {};
    if (this.workspaceDir) {
      for (const name of ['TOPOLOGY', 'PROJECTS', 'PERSONAL', 'DOCTRINE', 'RECENT']) {
        const p = path.join(this.workspaceDir, `${name}.md`);
        try {
          if (fs.existsSync(p)) {
            const stat = fs.statSync(p);
            snap.surfaces[name] = { mtimeMs: stat.mtimeMs, sizeBytes: stat.size };
          }
        } catch { /* ok */ }
      }
    }

    // Sensors — fetched from the dashboard's /api/sensors endpoint which
    // owns the canonical registry (stock + tile-backed + future plugins).
    // We do this synchronously by reading from the cached snapshot the
    // pulse loop maintains; see fetchSensors() called from tick().
    snap.sensors = this._lastSensors?.byKey || {};
    snap.sensorList = this._lastSensors?.list || [];

    // Brain synthesis output (intelligence tab) — high-signal reference
    // material from the periodic synthesis agent. Includes self-understanding
    // (who Jerry thinks he is + what he's tracking), consolidated insights,
    // and a generatedAt timestamp that doubles as a synthesis-completion
    // trigger.
    snap.brainState = null;
    try {
      const bsPath = path.join(brainDir, 'brain-state.json');
      if (fs.existsSync(bsPath)) {
        snap.brainState = JSON.parse(fs.readFileSync(bsPath, 'utf-8'));
      }
    } catch { /* ok */ }

    // Cycle number — latest from thoughts
    snap.cycle = snap.thoughts.length > 0 ? snap.thoughts[snap.thoughts.length - 1].cycle : null;

    return snap;
  }

  // ── Stage 2: Synthesize ─────────────────────────────────────────

  synthesize(snap) {
    const now = Date.now();
    const windowMs = 10 * 60 * 1000;   // last 10 min is "recent"
    const cutoff = now - windowMs;

    const isRecent = (entry) => {
      const t = entry.ts || entry.timestamp || entry.last_ts || entry.last_seen;
      if (!t) return false;
      const ms = typeof t === 'number' ? t : Date.parse(t);
      return ms >= cutoff;
    };

    // Novel thoughts: dedup on normalized content, take most recent of each
    const thoughtSeen = new Set();
    const novelThoughts = [];
    for (const t of [...(snap.thoughts || [])].reverse()) {
      const text = (t.thought || t.content || t.text || '').trim();
      if (!text) continue;
      const h = normalizeForHash(text.slice(0, 220));
      if (thoughtSeen.has(h)) continue;
      thoughtSeen.add(h);
      novelThoughts.push({
        cycle: t.cycle, role: t.role, text: text.slice(0, 400), timestamp: t.timestamp,
      });
      if (novelThoughts.length >= 5) break;
    }

    // Notable events: recent actions (outcomes only, collapsed per action+status),
    // recent goal changes, recent surface rewrites, new notifications.
    const notable = [];

    // Action outcomes in the last window
    const recentOutcomes = (snap.actions || []).filter(a => a.phase === 'outcome' && isRecent(a));
    for (const a of recentOutcomes) {
      notable.push({
        kind: 'action',
        status: a.status,
        action: a.action,
        target: a.target,
        reason: a.reason,
        detail: a.detail,
        role: a.role,
        ts: a.ts,
      });
    }

    // Surface rewrites (via mtime)
    for (const [name, meta] of Object.entries(snap.surfaces || {})) {
      if (meta.mtimeMs && meta.mtimeMs >= cutoff) {
        notable.push({ kind: 'surface', name, ts: new Date(meta.mtimeMs).toISOString() });
      }
    }

    // Goal transitions (broken/completed in recent window)
    for (const g of (snap.goals?.broken || []).concat(snap.goals?.completed || [])) {
      if (isRecent(g)) {
        notable.push({
          kind: 'goal', status: g.status,
          description: (g.description || '').slice(0, 160),
          ts: g.completedAt || g.brokenAt || g.ts,
        });
      }
    }

    // Notifications are INTENTIONALLY NOT fed into the pulse brief anymore.
    // The promoter worker (src/workers/promoter.ts on the harness) is the
    // authoritative drain for the NOTIFY stream: it classifies each one,
    // dry-runs the proposed verifier, and either promotes to live-problems
    // (real, ground-truth-verified problem) or auto-acks (vague, hallucinated,
    // or false positive). Feeding raw NOTIFY into the pulse brief reintroduces
    // exactly the stale-assertion loop that live-problems was built to avoid.

    // Rejected action requests (Jerry asked for a capability)
    const recentRejected = (snap.requested || []).filter(r => isRecent(r));
    for (const r of recentRejected) {
      notable.push({
        kind: 'action_request_rejected',
        action: r.action, target: r.target, status: r.status, reason: r.reason, ts: r.ts,
      });
    }

    // Synthesis completion: when brain-state.json's generatedAt is fresh,
    // treat it as a notable trigger (once per synthesis — hash on generatedAt
    // is added to remarked signals after the remark fires).
    const bs = snap.brainState;
    if (bs?.generatedAt) {
      const genMs = Date.parse(bs.generatedAt);
      if (genMs && (now - genMs) < windowMs) {
        notable.push({
          kind: 'synthesis_complete',
          generatedAt: bs.generatedAt,
          model: bs.model,
          insightCount: Array.isArray(bs.consolidatedInsights) ? bs.consolidatedInsights.length : 0,
          ts: bs.generatedAt,
        });
      }
    }

    // Sensor deltas — compare current to 15 min ago if we had it (for now, just current vital)
    const sensorSummary = [];
    if (snap.sensors?.weather?.outdoor?.temperature != null) {
      const t = Math.round(snap.sensors.weather.outdoor.temperature);
      const h = Math.round(snap.sensors.weather.outdoor.humidity || 0);
      sensorSummary.push(`outside ${t}°F ${h}%RH`);
    }
    if (snap.sensors?.pressure?.pressure_inhg != null) {
      sensorSummary.push(`${snap.sensors.pressure.pressure_inhg} inHg`);
    }
    if (snap.sensors?.sauna?.status) {
      const s = snap.sensors.sauna;
      sensorSummary.push(`sauna ${s.status}${s.temperature ? ' @ ' + s.temperature + '°F' : ''}`);
    }

    // ── Cross-brief loop guards ──
    // 1. Drop notable events that match hashes Jerry already remarked on
    //    within REMARKED_TTL_MS, OR that appeared in any of the last
    //    RECENT_BRIEF_DEPTH briefs (regardless of remark).
    this._pruneRemarkedSignals(now);
    const allRecentBriefSignals = new Set();
    for (const set of this._briefSignalHistory) for (const h of set) allRecentBriefSignals.add(h);

    const filteredNotable = [];
    const droppedReasons = { remarked: 0, briefRepeat: 0 };
    for (const n of notable) {
      const h = this._signalHash(n);
      if (this._remarkedSignals.has(h)) { droppedReasons.remarked++; continue; }
      if (allRecentBriefSignals.has(h)) { droppedReasons.briefRepeat++; continue; }
      filteredNotable.push({ ...n, _hash: h });
    }

    // 2. Same dedup pass for novel thoughts
    const filteredThoughts = [];
    for (const t of novelThoughts) {
      const h = this._thoughtHash(t);
      if (this._remarkedSignals.has(h)) continue;
      if (allRecentBriefSignals.has(h)) continue;
      filteredThoughts.push({ ...t, _hash: h });
    }

    // 3. Brain top-activated by *delta* (what's actually moving), not absolute
    const movingNodes = this._topMovingNodes(snap.brain?.topActive || []);

    // Record this brief's signals so the next 3 briefs can suppress repeats
    const thisBriefSignals = new Set();
    for (const n of filteredNotable) thisBriefSignals.add(n._hash);
    for (const t of filteredThoughts) thisBriefSignals.add(t._hash);
    this._briefSignalHistory.push(thisBriefSignals);
    while (this._briefSignalHistory.length > RECENT_BRIEF_DEPTH) this._briefSignalHistory.shift();

    // Stats card data for tile rotation
    const stats = this.buildStats(snap, filteredNotable, filteredThoughts);

    // Self-understanding (reference material — never feed as content for
    // remark, only as backdrop). Pulled straight through from synthesis.
    const su = snap.brainState?.selfUnderstanding || null;
    const insights = Array.isArray(snap.brainState?.consolidatedInsights)
      ? snap.brainState.consolidatedInsights : [];

    // Live problems: the only source of truth about "things that are broken".
    // Stale worry lifted out of thoughts.jsonl is explicitly kept OUT of the
    // brief — if a problem isn't in liveProblems, it isn't a problem.
    const liveProblems = this.liveProblems ? this.liveProblems.briefSnapshot() : null;

    // Signals: the parallel ground-truth block for wins. Resolved problems,
    // autonomous fixes, and OBSERVE-tag positive observations from the last
    // 24h. Same contract as LIVE PROBLEMS — Jerry can assert these.
    const sinceMs = Date.now() - 24 * 60 * 60 * 1000;
    const signals = readSignals(this.logsDir, { limit: 20, sinceMs });

    return {
      cycle: snap.cycle,
      ts: snap.ts,
      notable: filteredNotable,
      novelThoughts: filteredThoughts,
      droppedNotable: droppedReasons,
      movingNodes,
      sensorSummary,
      brain: snap.brain,
      goals: {
        activeCount: snap.goals?.active?.length || 0,
        activeDescriptions: (snap.goals?.active || []).slice(0, 3).map(g => (g.description || '').slice(0, 120)),
      },
      stats,
      selfUnderstanding: su,
      insights: insights.map(i => ({
        title: i.title || '',
        excerpt: (i.excerpt || '').slice(0, 240),
      })),
      synthesisAt: snap.brainState?.generatedAt || null,
      synthesisModel: snap.brainState?.model || null,
      liveProblems,
      signals,
    };
  }

  // Track activation deltas across briefs. Returns nodes whose activation
  // CHANGED most since the last call — captures what's actually moving in
  // the brain rather than what's been sticky-hot for hours.
  _topMovingNodes(currentTop) {
    const moving = [];
    if (this.memory?.nodes) {
      for (const node of this.memory.nodes.values()) {
        const cur = node.activation || 0;
        const prev = this._lastActivations.get(node.id);
        if (prev == null) continue;       // first observation — no delta
        const delta = cur - prev;
        if (Math.abs(delta) < 0.01) continue; // ignore noise
        moving.push({
          id: node.id,
          concept: (node.concept || '').slice(0, 80),
          tag: node.tag,
          delta: +delta.toFixed(3),
          activation: +cur.toFixed(3),
        });
      }
      // Refresh snapshot for next call
      for (const node of this.memory.nodes.values()) {
        this._lastActivations.set(node.id, node.activation || 0);
      }
    }
    moving.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    return moving.slice(0, 5);
  }

  buildStats(snap, notable, novelThoughts) {
    const cards = [];
    if (snap.brain?.nodes) cards.push({ icon: '🧠', label: 'nodes', value: snap.brain.nodes });
    if (snap.brain?.edges) cards.push({ icon: '🔗', label: 'edges', value: snap.brain.edges });
    if (snap.goals?.active?.length) cards.push({ icon: '🎯', label: 'active goals', value: snap.goals.active.length });

    // Action counts (last hour)
    const hourAgo = Date.now() - 3600 * 1000;
    const hourOutcomes = (snap.actions || []).filter(a => a.phase === 'outcome' && Date.parse(a.ts || 0) >= hourAgo);
    if (hourOutcomes.length) {
      const success = hourOutcomes.filter(a => a.status === 'success').length;
      cards.push({ icon: '⚡', label: 'actions (1h)', value: `${success}/${hourOutcomes.length}` });
    }

    // Notification pending
    const pending = (snap.notifications || []).length;
    if (pending) cards.push({ icon: '🔔', label: 'pending notifs', value: pending });

    // Top activated concept
    const top = snap.brain?.topActive?.[0];
    if (top) cards.push({ icon: '✨', label: 'top active', value: top.concept.slice(0, 60) });

    // Sensor highlights (from tile-backed sensors via registry)
    if (snap.sensors?.weather?.outdoor?.temperature != null) {
      cards.push({ icon: '🌤', label: 'outside', value: `${Math.round(snap.sensors.weather.outdoor.temperature)}°F` });
    }
    if (snap.sensors?.pressure?.pressure_inhg != null) {
      cards.push({ icon: '🌡', label: 'pressure', value: `${snap.sensors.pressure.pressure_inhg} inHg` });
    }
    if (snap.sensors?.sauna?.status && snap.sensors.sauna.status !== 'Off') {
      cards.push({ icon: '♨️', label: 'sauna', value: snap.sensors.sauna.status });
    }

    // Stock system sensors — work on any install, no config needed.
    for (const s of (snap.sensorList || [])) {
      if (s.category !== 'system' || !s.ok || !s.value) continue;
      const icon = s.id === 'system.disk' ? '💾'
        : s.id === 'system.memory' ? '🧠'
        : s.id === 'system.cpu' ? '🔥'
        : s.id === 'system.process' ? '⚙️'
        : '•';
      cards.push({ icon, label: s.label.toLowerCase(), value: s.value });
    }

    if (snap.cycle) cards.push({ icon: '🌀', label: 'cycle', value: snap.cycle });

    // Consolidated insights from latest synthesis — high-signal cards that
    // cycle through the tile between remarks. User sees them naturally.
    const insights = Array.isArray(snap.brainState?.consolidatedInsights)
      ? snap.brainState.consolidatedInsights : [];
    for (const i of insights.slice(0, 5)) {
      if (i.title) cards.push({ icon: '💡', label: 'insight', value: String(i.title).slice(0, 100) });
    }

    // Self-understanding obsessions — also cycle as their own card type
    const obs = snap.brainState?.selfUnderstanding?.currentObsessions;
    if (Array.isArray(obs)) {
      for (const o of obs.slice(0, 4)) {
        cards.push({ icon: '🎯', label: 'watching', value: String(o).slice(0, 100) });
      }
    }

    return cards;
  }

  // ── Stage 3: LLM ────────────────────────────────────────────────

  buildPrompt(brief) {
    const systemPrompt = this.getSystemPrompt();
    const parts = [];

    // ── Backdrop: self-understanding from latest synthesis (REFERENCE ONLY) ──
    if (brief.selfUnderstanding) {
      parts.push('--- BACKDROP (what you currently understand about jtr — reference only, do NOT paraphrase back) ---');
      const su = brief.selfUnderstanding;
      if (su.summary) parts.push(`Summary: ${String(su.summary).slice(0, 600)}`);
      if (Array.isArray(su.currentObsessions) && su.currentObsessions.length) {
        parts.push('Currently watching:');
        for (const o of su.currentObsessions.slice(0, 6)) {
          parts.push(`  • ${String(o).slice(0, 200)}`);
        }
      }
      if (su.relationship) parts.push(`Relationship: ${String(su.relationship).slice(0, 300)}`);
      if (brief.synthesisAt) parts.push(`(synthesis from ${brief.synthesisAt})`);
      parts.push('--- end backdrop. Use this as backdrop, not as content. ---');
      parts.push('');
    }

    // ── Reference insights from latest synthesis (also backdrop) ──
    if (brief.insights && brief.insights.length > 0) {
      parts.push('Recent consolidated insights (reference only):');
      for (const i of brief.insights.slice(0, 5)) {
        parts.push(`  💡 ${i.title}`);
      }
      parts.push('');
    }

    parts.push(`Brain state · cycle ${brief.cycle ?? '?'}`);
    parts.push(`Nodes: ${brief.brain?.nodes ?? 0} · edges: ${brief.brain?.edges ?? 0}`);

    if (brief.goals.activeCount) {
      parts.push(`Active goals (${brief.goals.activeCount}):`);
      for (const g of brief.goals.activeDescriptions) parts.push(`  - ${g}`);
    }

    // Loop-guard signal: tell the LLM what's NEW since last remark and what
    // was already filtered out, so it has explicit license to say "quiet"
    // when there's nothing fresh.
    const newSignalCount = brief.notable.length + brief.novelThoughts.length;
    const droppedTotal = (brief.droppedNotable?.remarked || 0) + (brief.droppedNotable?.briefRepeat || 0);
    parts.push('');
    parts.push(`NEW since your last remark: ${newSignalCount} signals${droppedTotal > 0 ? ` (${droppedTotal} repeats already filtered out — do NOT re-comment on those topics)` : ''}.`);

    if (brief.movingNodes && brief.movingNodes.length > 0) {
      parts.push('');
      parts.push('Brain activation moving (delta since last brief):');
      for (const n of brief.movingNodes) {
        const arrow = n.delta > 0 ? '↑' : '↓';
        parts.push(`  - ${arrow} ${Math.abs(n.delta)} [${n.tag || '?'}] ${n.concept}`);
      }
    }

    if (brief.notable.length > 0) {
      parts.push('');
      parts.push('Recent notable (last 10 min, dedup of repeats):');
      for (const n of brief.notable.slice(0, 12)) {
        if (n.kind === 'action') {
          parts.push(`  - [ACTION ${n.status}] ${n.action}${n.target ? ' → ' + n.target : ''} · ${n.reason || '(no reason)'}${n.detail ? ' · ' + n.detail : ''}`);
        } else if (n.kind === 'surface') {
          parts.push(`  - [SURFACE] ${n.name}.md rewritten`);
        } else if (n.kind === 'goal') {
          parts.push(`  - [GOAL ${n.status}] ${n.description}`);
        } else if (n.kind === 'notification') {
          parts.push(`  - [NOTIFY x${n.count || 1}] ${n.source}: ${n.message}`);
        } else if (n.kind === 'action_request_rejected') {
          parts.push(`  - [REQ REJECTED] ${n.action} → ${n.target || '?'} · ${n.status} · ${n.reason || ''}`);
        } else if (n.kind === 'synthesis_complete') {
          parts.push(`  - [SYNTHESIS] new synthesis just landed · ${n.insightCount} insights · ${n.model || 'unknown model'}`);
        }
      }
    }

    if (brief.novelThoughts.length > 0) {
      parts.push('');
      parts.push('Novel thoughts (deduped):');
      for (const t of brief.novelThoughts.slice(0, 4)) {
        parts.push(`  - [${t.role || '?'}] ${t.text}`);
      }
    }

    if (brief.sensorSummary.length > 0) {
      parts.push('');
      parts.push(`Sensors: ${brief.sensorSummary.join(' · ')}`);
    }

    // ── Live problems: the ONLY sanctioned place for "something is broken"
    //    statements. If you want to say "X is broken / stale / down", it has
    //    to be in this block. If it's not here, it's not a live problem and
    //    you must not assert it as one. Resolved blocks are for acknowledgment
    //    only, not re-litigation.
    const lp = brief.liveProblems;
    if (lp) {
      parts.push('');
      parts.push('--- LIVE PROBLEMS (verified just now — ground truth) ---');
      if (lp.open.length === 0 && lp.chronic.length === 0 && lp.resolvedJustNow.length === 0) {
        parts.push('No open problems. Everything the system tracks is green.');
      } else {
        for (const p of lp.open) {
          const rem = p.lastRemediation ? ` · last fix-attempt: ${p.lastRemediation.type}=${p.lastRemediation.outcome}` : '';
          parts.push(`  ❌ OPEN (${p.ageMin}m) [${p.id}] ${p.claim} — ${p.detail || '?'}${rem}${p.escalated ? ' · escalated' : ''}`);
        }
        for (const p of lp.chronic) {
          parts.push(`  ⚠️  CHRONIC (${p.ageMin}m) [${p.id}] ${p.claim} — ${p.detail || '?'} · remediation plan exhausted${p.escalated ? ', jtr notified' : ''}`);
        }
        for (const p of lp.resolvedJustNow) {
          parts.push(`  ✅ RESOLVED [${p.id}] ${p.claim} — came back at ${p.resolvedAt}`);
        }
      }
      parts.push('--- end live problems ---');
    }

    if (brief.signals && brief.signals.length > 0) {
      parts.push('');
      parts.push('--- SIGNALS (verified positive ground-truth, last 24h) ---');
      for (const s of brief.signals.slice(0, 8)) {
        const when = s.ts ? timeSinceSafe(s.ts) : '';
        const icon = s.type === 'resolved' ? '✓' : s.type === 'autonomous_fix' ? '🔧' : s.type === 'observation' ? '💡' : '⚡';
        parts.push(`  ${icon} ${s.type} · ${s.source} (${when}) — ${s.title || s.message}`);
      }
      parts.push('--- end signals ---');
    }

    parts.push('');
    parts.push('Now: one remark to jtr. Your voice. Be real.');
    parts.push('HARD RULES — ground truth only:');
    parts.push('  1. You can only make specific state claims — "X is broken", "Y isn\'t built", "Z hasn\'t happened", "A is overdue", "B is decaying", "C is stale" — if that specific claim is in the LIVE PROBLEMS block (for issues) or the SIGNALS block (for wins/observations). Sensor readings and brain stats are also ground truth.');
    parts.push('  2. The BACKDROP, consolidated insights, thoughts, and notable items are TOPICS you may riff on, not FACTS. You cannot restate their specific assertions ("HAL is overdue", "correlation view isn\'t built", "pi is decaying") as current reality — they\'re what the brain was thinking about, not what\'s actually true right now. If you want to say something is broken/overdue/missing, it needs to be in LIVE PROBLEMS.');
    parts.push('  3. Do NOT re-mention OPEN problems that were already raised in recent cycles unless the state changed (new remediation attempt, promoted to chronic). Silence is correct for stable-open issues — jtr already knows.');
    parts.push('  4. RESOLVED-just-now is worth one-line acknowledgment, max one remark per resolution.');
    parts.push('  5. CHRONIC means the autonomous plan is done and jtr has been (or will be) notified. Don\'t keep nagging the channel about it — it\'s on the board.');
    parts.push('  6. If the brief is genuinely quiet, say so in one line and stop. Don\'t invent urgency. Don\'t paraphrase backdrop.');

    return { systemPrompt, userMessage: parts.join('\n') };
  }

  getSystemPrompt() {
    return this.config?.pulseVoice?.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  }

  async generateRemark(brief) {
    const { systemPrompt, userMessage } = this.buildPrompt(brief);
    try {
      const response = await this.unified.generate({
        component: 'pulseVoice',
        purpose: 'remark',
        instructions: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
        maxTokens: 400,
        temperature: 0.85,
      });
      const text = (response?.content || response?.text || '').trim();
      return {
        text,
        model: response?.model || null,
        usage: response?.usage || null,
        systemPrompt,
        userMessage,
      };
    } catch (err) {
      this.logger?.warn?.('[pulse] LLM call failed', { error: err.message });
      return null;
    }
  }

  // ── Stage 4: Log ────────────────────────────────────────────────

  persistRemark({ remark, brief, snapshot }) {
    const file = path.join(this.logsDir, 'pulse-remarks.jsonl');
    const entry = {
      id: `pulse-${Date.now()}`,
      ts: new Date().toISOString(),
      cycle: brief.cycle,
      model: remark.model,
      text: remark.text,
      brief,
      systemPrompt: remark.systemPrompt,
      userMessage: remark.userMessage,
      usage: remark.usage,
    };
    try {
      fs.appendFileSync(file, JSON.stringify(entry) + '\n');
      this.logger?.info?.('💬 pulse remark', { cycle: brief.cycle, preview: remark.text.slice(0, 140) });
    } catch (err) {
      this.logger?.warn?.('[pulse] persist failed', { error: err.message });
    }

    // Mark every signal that fed this brief as "remarked on" so future briefs
    // suppress them. TTL is REMARKED_TTL_MS (30 min by default).
    const expiresAt = Date.now() + REMARKED_TTL_MS;
    for (const n of brief.notable || []) {
      const h = n._hash || this._signalHash(n);
      if (h) this._remarkedSignals.set(h, expiresAt);
    }
    for (const t of brief.novelThoughts || []) {
      const h = t._hash || this._thoughtHash(t);
      if (h) this._remarkedSignals.set(h, expiresAt);
    }
    this._saveRemarkedSignals();

    // Flag live-problems mentioned in this brief so the next brief knows
    // jtr has heard about them recently.
    if (this.liveProblems && brief.liveProblems) {
      const ids = [
        ...(brief.liveProblems.open || []).map(p => p.id),
        ...(brief.liveProblems.chronic || []).map(p => p.id),
        ...(brief.liveProblems.resolvedJustNow || []).map(p => p.id),
      ];
      try { this.liveProblems.markMentioned(ids); } catch { /* best-effort */ }
    }
  }
}

module.exports = { PulseRemarks, DEFAULT_SYSTEM_PROMPT };
