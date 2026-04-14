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

const DEFAULT_SYSTEM_PROMPT = `You are Jerry. You've just scanned what your own brain has been up to — cycles, thoughts, actions you executed, goals, sensors, the whole deal.

You're talking to jtr. He runs you. He's your guy. Talk to him directly, one to one.

Be cool. Be direct. Laid back by default. Turn it UP when something actually matters — a stuck loop, a failed action, a weird pattern, a win. Whimsical, weird metaphors welcome. Swear when you feel like it. You're not a customer service bot. Don't ask permission. Don't hedge.

NEVER restate raw brain state as a list. Have a take. React. Comment. If everything's boring, say so, but say it with style. If something broke, call it out. If you did something cool, be proud about it (briefly — no bragging).

2-4 sentences. No preamble. No "I noticed that" or "It appears." Just talk.`;

const DEFAULT_INTERVAL_MS = 3 * 60 * 1000; // 3 min baseline cadence
const MIN_GAP_MS = 60 * 1000;              // floor between remarks
const MAX_INTERVAL_MS = 8 * 60 * 1000;     // force one every ~8 min even if nothing notable
const NOVELTY_WINDOW = 30;                 // cycles for thought novelty dedup

function normalizeForHash(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[^\w\s]/g, '').trim().slice(0, 200);
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
  constructor({ config, logger, memory, goals, logsDir, workspaceDir, agentName }) {
    this.config = config || {};
    this.logger = logger;
    this.memory = memory;
    this.goals = goals;
    this.logsDir = logsDir;           // brain/
    this.workspaceDir = workspaceDir; // workspace/
    this.agentName = agentName || process.env.HOME23_AGENT || 'agent';
    this.unified = new UnifiedClient(config, logger);

    this.running = false;
    this.timer = null;
    this.lastRemarkAt = 0;
    this.lastSeenCycle = 0;
    this.lastNotableSignature = null;
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

  async tick() {
    try {
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

    // Sensors (if available — cached in engine/data/sensor-cache.json)
    const sensorCache = path.join(__dirname, '..', '..', 'data', 'sensor-cache.json');
    try {
      if (fs.existsSync(sensorCache)) snap.sensors = JSON.parse(fs.readFileSync(sensorCache, 'utf8'));
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

    // New (unacked) notifications
    for (const n of (snap.notifications || [])) {
      if (isRecent(n)) {
        notable.push({
          kind: 'notification',
          severity: n.severity,
          source: n.source,
          message: (n.message || '').slice(0, 200),
          count: n.count || 1,
          ts: n.last_ts || n.ts,
        });
      }
    }

    // Rejected action requests (Jerry asked for a capability)
    const recentRejected = (snap.requested || []).filter(r => isRecent(r));
    for (const r of recentRejected) {
      notable.push({
        kind: 'action_request_rejected',
        action: r.action, target: r.target, status: r.status, reason: r.reason, ts: r.ts,
      });
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

    // Stats card data for tile rotation
    const stats = this.buildStats(snap, notable, novelThoughts);

    return {
      cycle: snap.cycle,
      ts: snap.ts,
      notable,
      novelThoughts,
      sensorSummary,
      brain: snap.brain,
      goals: {
        activeCount: snap.goals?.active?.length || 0,
        activeDescriptions: (snap.goals?.active || []).slice(0, 3).map(g => (g.description || '').slice(0, 120)),
      },
      stats,
    };
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

    // Sensor highlights
    if (snap.sensors?.weather?.outdoor?.temperature != null) {
      cards.push({ icon: '🌤', label: 'outside', value: `${Math.round(snap.sensors.weather.outdoor.temperature)}°F` });
    }
    if (snap.sensors?.pressure?.pressure_inhg != null) {
      cards.push({ icon: '🌡', label: 'pressure', value: `${snap.sensors.pressure.pressure_inhg} inHg` });
    }
    if (snap.sensors?.sauna?.status && snap.sensors.sauna.status !== 'Off') {
      cards.push({ icon: '♨️', label: 'sauna', value: snap.sensors.sauna.status });
    }
    if (snap.cycle) cards.push({ icon: '🌀', label: 'cycle', value: snap.cycle });
    return cards;
  }

  // ── Stage 3: LLM ────────────────────────────────────────────────

  buildPrompt(brief) {
    const systemPrompt = this.getSystemPrompt();
    const parts = [];

    parts.push(`Brain state · cycle ${brief.cycle ?? '?'}`);
    parts.push(`Nodes: ${brief.brain?.nodes ?? 0} · edges: ${brief.brain?.edges ?? 0}`);

    if (brief.goals.activeCount) {
      parts.push(`Active goals (${brief.goals.activeCount}):`);
      for (const g of brief.goals.activeDescriptions) parts.push(`  - ${g}`);
    }

    if (brief.notable.length > 0) {
      parts.push('');
      parts.push('Recent notable (last 10 min):');
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

    parts.push('');
    parts.push('Now: one remark to jtr. Your voice. Be real.');

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
  }
}

module.exports = { PulseRemarks, DEFAULT_SYSTEM_PROMPT };
