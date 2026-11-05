/**
 * Temporal Context — the brain's sense of where-we-are-in-time
 *
 * Loads jtr's ground-truth schedule from instances/<agent>/workspace/TEMPORAL.md
 * (YAML frontmatter), computes the current phase, and emits a structured
 * `temporalContext` block attached to thoughts and passed into LLM prompts.
 *
 * The module is a pure utility — calling it has no side effects beyond reading
 * the file. The legacy role rotation is unaffected; thoughts just carry
 * additional temporal metadata from now on.
 *
 * Part of Foundation 2 (Temporal Awareness) of the thinking-machine-cycle
 * rebuild. See docs/superpowers/specs/2026-04-18-thinking-machine-cycle.md.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const DEFAULT_WORKWEEK = {
  workDays: ['mon', 'tue', 'wed', 'thu', 'fri'],
  morningStart: '07:00',
  eveningStart: '18:00',
  lateNightStart: '23:00',
};

// Cache parsed TEMPORAL.md in-memory. Re-read on mtime change so jtr's edits
// are picked up without a process restart.
const cache = new Map(); // workspacePath → { mtimeMs, config }

function clearCache() {
  cache.clear();
}

/**
 * Read and parse TEMPORAL.md from the given workspace directory.
 * Returns a config object or null if the file is missing / malformed.
 */
function loadTemporalConfig(workspacePath) {
  const filePath = path.join(workspacePath, 'TEMPORAL.md');
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }

  const cached = cache.get(workspacePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.config;
  }

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*(\n|$)/);
  if (!fmMatch) return null;

  let parsed;
  try {
    parsed = yaml.load(fmMatch[1]) || {};
  } catch {
    return null;
  }

  const config = {
    timezone: parsed.timezone || 'UTC',
    workweek: { ...DEFAULT_WORKWEEK, ...(parsed.workweek || {}) },
    rhythms: Array.isArray(parsed.rhythms) ? parsed.rhythms : [],
    overrides: Array.isArray(parsed.overrides) ? parsed.overrides : [],
  };

  cache.set(workspacePath, { mtimeMs: stat.mtimeMs, config });
  return config;
}

// Parse "HH:MM" into minutes-since-midnight (local to the timezone)
function parseClock(hhmm) {
  if (typeof hhmm !== 'string') return 0;
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return 0;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/**
 * Return {dayName, minutesSinceMidnight} for a Date in the given IANA timezone.
 * Uses Intl.DateTimeFormat so DST / timezone rules are correct without a library.
 */
function computeLocalTimeParts(now, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const weekday = (parts.find(p => p.type === 'weekday')?.value || 'Mon').slice(0, 3).toLowerCase();
  let hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
  if (hour === 24) hour = 0; // some runtimes emit "24" for midnight
  const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);

  return {
    dayName: weekday,
    minutesSinceMidnight: hour * 60 + minute,
  };
}

function computePhase(minutesSinceMidnight, workweek) {
  const morning = parseClock(workweek.morningStart);
  const evening = parseClock(workweek.eveningStart);
  const lateNight = parseClock(workweek.lateNightStart);
  const noon = 12 * 60;

  if (minutesSinceMidnight >= lateNight) return 'late-night';
  if (minutesSinceMidnight < morning) return 'late-night';
  if (minutesSinceMidnight < noon) return 'morning';
  if (minutesSinceMidnight < evening) return 'afternoon';
  return 'evening';
}

function isWorkday(dayName, workDays) {
  return Array.isArray(workDays) && workDays.map(d => d.toLowerCase()).includes(dayName);
}

function activeOverride(now, overrides) {
  if (!Array.isArray(overrides)) return null;
  const nowMs = now.getTime();
  for (const ov of overrides) {
    if (!ov || !ov.start || !ov.end) continue;
    const startMs = new Date(ov.start).getTime();
    const endMs = new Date(ov.end).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    if (nowMs >= startMs && nowMs <= endMs) return ov;
  }
  return null;
}

function activeRhythms(dayName, phase, rhythms) {
  if (!Array.isArray(rhythms)) return [];
  return rhythms
    .filter(r => {
      if (!r || !r.name) return false;
      const days = Array.isArray(r.days) ? r.days.map(d => d.toLowerCase()) : [];
      const phases = Array.isArray(r.phases) ? r.phases : [];
      return days.includes(dayName) && phases.includes(phase);
    })
    .map(r => r.name);
}

/**
 * Build the temporalContext block.
 *
 * @param {object} opts
 * @param {Date} [opts.now] — defaults to new Date()
 * @param {string} opts.workspacePath — instances/<agent>/workspace
 * @param {object} [opts.loopState] — optional felt-duration inputs (awakeFor, lastSlept, continuousRun, lastConversation) in ms; omitted fields are reported as null
 * @param {Array} [opts.referencedNodes] — optional [{nodeId, createdAt}] to compute ages against now
 * @param {Array} [opts.problemAges] — optional [{problemId, firstSeenAt}] to compute ages
 *
 * @returns {object} temporalContext — always returns a valid block even if TEMPORAL.md is missing
 */
function buildTemporalContext(opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const config = opts.workspacePath ? loadTemporalConfig(opts.workspacePath) : null;

  const timezone = config?.timezone || 'America/New_York';
  const workweek = config?.workweek || DEFAULT_WORKWEEK;
  const { dayName, minutesSinceMidnight } = computeLocalTimeParts(now, timezone);
  const phase = computePhase(minutesSinceMidnight, workweek);
  const dayType = isWorkday(dayName, workweek.workDays) ? 'weekday' : 'weekend';

  const override = activeOverride(now, config?.overrides || []);
  const rhythms = activeRhythms(dayName, phase, config?.rhythms || []);

  const workweekPhase = override?.workweekPhase
    || (rhythms.find(name => name === 'deep-work' || name === 'family-evening' || name === 'weekend' || name === 'sauna' || name === 'late-night-thinking') || null);

  const loopState = opts.loopState || {};
  const referencedNodes = Array.isArray(opts.referencedNodes) ? opts.referencedNodes : [];
  const problemAges = Array.isArray(opts.problemAges) ? opts.problemAges : [];

  return {
    now: now.toISOString(),
    configLoaded: Boolean(config),
    jtrTime: {
      timezone,
      dayName,
      phase,
      dayType,
      workweekPhase,
      activeRhythms: rhythms,
      activeOverride: override ? {
        start: override.start,
        end: override.end,
        workweekPhase: override.workweekPhase,
        description: override.description,
      } : null,
    },
    relative: {
      referencedNodeAges: referencedNodes
        .filter(n => n && n.createdAt)
        .map(n => ({
          nodeId: n.nodeId,
          ageMs: now.getTime() - new Date(n.createdAt).getTime(),
        })),
      problemAges: problemAges
        .filter(p => p && p.firstSeenAt)
        .map(p => ({
          problemId: p.problemId,
          ageMs: now.getTime() - new Date(p.firstSeenAt).getTime(),
        })),
    },
    loopDuration: {
      awakeForMs: loopState.awakeForMs ?? null,
      lastSleptMs: loopState.lastSleptMs ?? null,
      continuousRunMs: loopState.continuousRunMs ?? null,
      lastConversationMs: loopState.lastConversationMs ?? null,
    },
  };
}

/**
 * Human-readable single-sentence summary of the current jtr-time.
 * Used by the dashboard inference surface for the "brain thinks it's ___" display.
 */
function humanSummary(ctx) {
  if (!ctx) return 'unknown';
  const t = ctx.jtrTime;
  const rhythms = t.activeRhythms?.length ? t.activeRhythms.join(', ') : 'no named rhythm';
  const override = t.activeOverride
    ? ` — override: ${t.activeOverride.description || t.activeOverride.workweekPhase}`
    : '';
  return `${t.phase} ${t.dayType} (${t.dayName}) · rhythm: ${rhythms}${override}`;
}

module.exports = {
  loadTemporalConfig,
  buildTemporalContext,
  humanSummary,
  clearCache,
  // exported for testing
  _internal: { computePhase, computeLocalTimeParts, parseClock, isWorkday, activeOverride, activeRhythms },
};
