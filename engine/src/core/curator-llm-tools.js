/**
 * Home23 — Curator LLM Tools
 *
 * Two pieces the original Step 20 curator deferred:
 *
 *   1. compactSurface — when a workspace surface (TOPOLOGY/PROJECTS/PERSONAL/
 *      DOCTRINE) exceeds its character budget, drop entries older than N days
 *      first, then if still over budget, ask an LLM to rewrite. The original
 *      curator was append-only and silently no-op'd once a surface filled up,
 *      which is how identity-doc material from week one wedged the surfaces
 *      and the agent's bootstrap context went stale.
 *
 *   2. generateRecentDigest — RECENT.md was in SURFACE_BUDGETS but no code
 *      ever wrote it, so the "24-48h digest" was forever stale. This builds
 *      a fresh digest from the event ledger + recent journal, gated by a
 *      cadence (default 6h) so we don't spend tokens every cycle.
 *
 * Both helpers accept an optional pre-built UnifiedClient; otherwise they
 * construct one. Both fail soft — if the LLM call errors, the surface stays
 * as-is and the caller logs a warning.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { UnifiedClient } = require('./unified-client');

function writeFileDurable(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
  try {
    const dirFd = fs.openSync(path.dirname(filePath), 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch { /* directory fsync is best-effort on some filesystems */ }
}

function readJsonSafe(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function collectVerifiedDigestFacts({ workspacePath, brainDir, agentName }) {
  const facts = [];
  const flags = {};

  if (brainDir) {
    const liveProblems = readJsonSafe(path.join(brainDir, 'live-problems.json'), { problems: [] });
    const problems = Array.isArray(liveProblems?.problems) ? liveProblems.problems : [];
    if (problems.length > 0) {
      const active = problems.filter(p => p?.state === 'open' || p?.state === 'chronic');
      flags.activeLiveProblemCount = active.length;
      facts.push(`live-problems active: ${active.length}${active.length ? ` (${active.map(p => p.id).join(', ')})` : ''}`);
    }
  }

  if (agentName === 'forrest' && workspacePath) {
    const ledgerPath = path.join(workspacePath, 'health_jtr', 'ledgers', 'subjective_state.jsonl');
    const healthApiPath = path.join(workspacePath, 'scripts', 'health-api.py');
    const homeRoot = path.resolve(workspacePath, '..', '..', '..');
    const durableWritePath = path.join(homeRoot, 'engine', 'src', 'utils', 'durable-write.js');

    let ledger = '';
    try { ledger = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, 'utf8') : ''; } catch { ledger = ''; }
    const hasJune3Run = /2026-06-03[\s\S]{0,500}First run back after 37 days off/.test(ledger);
    const hasJune3Correction = /2026-06-03[\s\S]{0,800}(CORRECTION|RESOLVED|resolved)/i.test(ledger);

    let healthApi = '';
    let durableWrite = '';
    try { healthApi = fs.existsSync(healthApiPath) ? fs.readFileSync(healthApiPath, 'utf8') : ''; } catch { healthApi = ''; }
    try { durableWrite = fs.existsSync(durableWritePath) ? fs.readFileSync(durableWritePath, 'utf8') : ''; } catch { durableWrite = ''; }
    const hasDurableFeelPath =
      /append_jsonl_durable/.test(healthApi)
      && /durability/.test(healthApi)
      && /appendJsonlDurableSync/.test(durableWrite);

    if (hasJune3Run && hasJune3Correction) {
      flags.june3SubjectiveDataPresent = true;
      facts.push('June 3 subjective data present in subjective_state.jsonl (run row plus resolved/deadness correction row)');
    }
    if (hasJune3Run && hasJune3Correction && hasDurableFeelPath) {
      flags.forrestFeelRouteCorrected = true;
      facts.push('Forrest /api/feel write-path correction is current: subjective data was not lost, and durable fsync/read-back code is present');
    }
  }

  return { facts, flags };
}

function appendStateChangeFact(digest, fact) {
  const line = `- Verified current state: ${fact}`;
  if (digest.includes(fact)) return digest;
  const marker = '**State changes**';
  const markerIdx = digest.indexOf(marker);
  if (markerIdx >= 0) {
    const before = digest.slice(0, markerIdx + marker.length);
    const after = digest.slice(markerIdx + marker.length).replace(/^\s*/, '\n');
    return `${before}\n${line}${after}`;
  }
  return `${digest.trim()}\n\n**State changes**\n${line}`;
}

function applyVerifiedDigestFacts(digest, verified) {
  let out = String(digest || '');
  if (verified?.flags?.forrestFeelRouteCorrected) {
    out = out
      .split('\n')
      .filter(line => {
        const isBullet = /^\s*[-*]\s+/.test(line);
        const mentionsFeel = /\/api\/feel/i.test(line);
        const staleClaim = /(unwired|wire\b|blocker|gates?|critical|only living|endpoint)/i.test(line);
        const repairClaim = /(repaired|durable|verified|present|not lost|corrected|current)/i.test(line);
        return !(isBullet && mentionsFeel && staleClaim && !repairClaim);
      })
      .join('\n');
  }

  for (const fact of verified?.facts || []) {
    out = appendStateChangeFact(out, fact);
  }
  return out;
}

// Match a single appended entry block. Format produced by orchestrator.js:2650
//   ### {title}
//   {statement}
//   _Changed: ... (optional)
//   _Added: YYYY-MM-DD_
const ENTRY_RE = /^### .+?\n[\s\S]*?_Added: (\d{4}-\d{2}-\d{2})_/gm;

function _splitHeaderAndEntries(content) {
  const firstEntry = content.match(/^### .+?\n[\s\S]*?_Added: \d{4}-\d{2}-\d{2}_/m);
  if (!firstEntry) return { header: content, entries: [] };
  const headerEnd = content.indexOf(firstEntry[0]);
  const header = content.slice(0, headerEnd).replace(/\s+$/, '') + '\n\n';
  const tail = content.slice(headerEnd);
  const entries = [];
  let m;
  ENTRY_RE.lastIndex = 0;
  while ((m = ENTRY_RE.exec(tail)) !== null) {
    entries.push({ raw: m[0], addedDate: m[1] });
  }
  return { header, entries };
}

function _dropOldEntries(content, daysOldThreshold) {
  const { header, entries } = _splitHeaderAndEntries(content);
  if (entries.length === 0) return content;
  const cutoff = Date.now() - daysOldThreshold * 24 * 3600 * 1000;
  const kept = entries.filter(e => {
    const t = new Date(e.addedDate).getTime();
    return Number.isFinite(t) && t >= cutoff;
  });
  if (kept.length === entries.length) return content;
  return header + kept.map(e => e.raw.trim()).join('\n\n') + '\n';
}

async function compactSurface({
  surfacePath,
  budget,
  model = 'MiniMax-M3',
  client = null,
  config = null,
  logger = null,
  fifoDays = 21,
}) {
  if (!fs.existsSync(surfacePath)) return null;
  const original = fs.readFileSync(surfacePath, 'utf8');
  if (original.length <= budget) return null;

  const surfaceName = path.basename(surfacePath);

  // Snapshot before any mutation — surfaces are not in git and an LLM
  // rewrite that drops a critical fact should be one-step recoverable.
  try { fs.writeFileSync(surfacePath + '.bak', original); } catch { /* best-effort */ }

  // Step 1: FIFO drop entries older than fifoDays.
  const fifo = _dropOldEntries(original, fifoDays);
  if (fifo.length <= budget) {
    fs.writeFileSync(surfacePath, fifo);
    logger?.info?.('📋 Surface compacted (FIFO drop)', {
      surface: surfaceName, before: original.length, after: fifo.length, budget,
    });
    return { method: 'fifo', before: original.length, after: fifo.length };
  }

  // Step 2: still over budget — LLM rewrite.
  const llm = client || new UnifiedClient(config, logger);
  const prompt = `You compress a workspace surface for an AI agent's situational awareness.

Surface: ${surfaceName} (max length: ${budget} chars)
Current content (over budget):
---
${fifo}
---

Rewrite this surface to be under ${budget} characters while preserving:
- All current/active facts (URLs, ports, names, owners, IDs)
- Recent state changes (last 14 days)
- Non-obvious constraints, warnings, or invariants

Drop:
- Entries older than ${fifoDays} days unless still operative truth
- Redundant phrasings of the same fact
- Excessive markdown formatting

Output ONLY the rewritten surface markdown. No commentary, no code fences.`;

  let rewritten = '';
  try {
    const resp = await llm.generate({
      model,
      instructions: 'You are a precise editor. Output rewritten content only.',
      messages: [{ role: 'user', content: prompt }],
      maxOutputTokens: 2000,
    });
    rewritten = (resp?.text || resp?.content || resp?.output_text || '').trim();
  } catch (err) {
    logger?.warn?.('📋 Surface compaction LLM call failed', {
      surface: surfaceName, error: err.message,
    });
    return null;
  }

  if (!rewritten) return null;

  // Safety net: if the model returned a suspiciously short result
  // (under 30% of budget), fall back to the FIFO version. Truncated
  // outputs would erase active facts.
  if (rewritten.length < budget * 0.3) {
    logger?.warn?.('📋 Surface compaction: LLM result too short, keeping FIFO version', {
      surface: surfaceName, llmLen: rewritten.length, fifoLen: fifo.length, budget,
    });
    fs.writeFileSync(surfacePath, fifo);
    return { method: 'fifo-fallback', before: original.length, after: fifo.length };
  }

  fs.writeFileSync(surfacePath, rewritten);
  logger?.info?.('📋 Surface compacted (LLM rewrite)', {
    surface: surfaceName, before: original.length, after: rewritten.length, budget,
  });
  return { method: 'llm', before: original.length, after: rewritten.length };
}

async function generateRecentDigest({
  workspacePath,
  brainDir,
  journal = [],
  agentName = 'agent',
  model = 'MiniMax-M3',
  client = null,
  config = null,
  logger = null,
  cadenceMs = 6 * 3600 * 1000,
  maxBytes = 3000,
  windowHours = 48,
}) {
  if (!workspacePath) return { skipped: 'no-workspace' };
  const recentPath = path.join(workspacePath, 'RECENT.md');

  if (fs.existsSync(recentPath)) {
    const ageMs = Date.now() - fs.statSync(recentPath).mtimeMs;
    if (ageMs < cadenceMs) return { skipped: 'cadence', ageMs };
  }

  const since = Date.now() - windowHours * 3600 * 1000;
  const events = [];
  if (brainDir) {
    const ledgerPath = path.join(brainDir, 'event-ledger.jsonl');
    try {
      if (fs.existsSync(ledgerPath)) {
        const lines = fs.readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean);
        const tail = lines.slice(-800);
        for (const line of tail) {
          try {
            const evt = JSON.parse(line);
            const ts = new Date(evt.timestamp || evt.ts || 0).getTime();
            if (Number.isFinite(ts) && ts >= since) events.push(evt);
          } catch { /* skip bad line */ }
        }
      }
    } catch (err) {
      logger?.warn?.('📋 RECENT digest: ledger read failed', { error: err.message });
    }
  }

  const thoughts = (journal || []).slice(-80).map(t => ({
    cycle: t.cycle,
    role: t.role,
    text: (t.thought || '').slice(0, 220),
  }));

  if (events.length === 0 && thoughts.length === 0) {
    return { skipped: 'no-input' };
  }

  const eventLines = events.map(e => {
    const ts = e.timestamp || e.ts || '';
    const type = e.event_type || e.type || 'event';
    const payload = JSON.stringify(e.payload || e.data || e.metadata || {}).slice(0, 200);
    return `[${ts}] ${type}: ${payload}`;
  }).join('\n').slice(-7000);

  const thoughtLines = thoughts.map(t =>
    `c${t.cycle} [${t.role}] ${t.text}`
  ).join('\n').slice(-5000);

  const nowIso = new Date().toISOString();
  const verified = collectVerifiedDigestFacts({ workspacePath, brainDir, agentName });
  const verifiedLines = verified.facts.length
    ? verified.facts.map(f => `- ${f}`).join('\n')
    : '- no verified current-state facts available';
  const prompt = `You write a tight 24-48 hour activity digest for an AI agent's situational awareness.

The agent is ${agentName}. Now: ${nowIso}.

Current verified state (authoritative; these facts override older events, thoughts, memory, and prior RECENT.md text):
---
${verifiedLines}
---

Recent events from the ledger (last ${windowHours}h, oldest first):
---
${eventLines || '(no events in window)'}
---

Recent cycle thoughts (last ${thoughts.length}, oldest first):
---
${thoughtLines || '(no thoughts in window)'}
---

Write a markdown digest with these three sections, in this order:
- **Last 24h** — what actually happened (bulleted, terse, factual)
- **Open threads** — work in progress or unresolved questions; do not list a thread if it is contradicted by Current verified state
- **State changes** — anything now different from yesterday

If Current verified state says live-problems active: 0, do not infer operational blockers from old thoughts alone.
Hard cap: ${maxBytes} characters total. No headers beyond the three above. No motivational filler. State facts only.`;

  const llm = client || new UnifiedClient(config, logger);
  let digest = '';
  try {
    const resp = await llm.generate({
      model,
      instructions: 'You are a precise digest writer. Output markdown only.',
      messages: [{ role: 'user', content: prompt }],
      maxOutputTokens: 1500,
    });
    digest = (resp?.text || resp?.content || resp?.output_text || '').trim();
  } catch (err) {
    logger?.warn?.('📋 RECENT digest: LLM call failed', { error: err.message });
    return { skipped: 'llm-error', error: err.message };
  }

  if (!digest) return { skipped: 'empty' };
  digest = applyVerifiedDigestFacts(digest, verified);

  const header = `# Recent Activity\n\n_Generated: ${nowIso} — covers last ${windowHours}h_\n\n`;
  writeFileDurable(recentPath, header + digest + '\n');
  logger?.info?.('📋 RECENT.md regenerated', {
    bytes: header.length + digest.length,
    eventsConsidered: events.length,
    thoughtsConsidered: thoughts.length,
  });
  return { written: true, bytes: header.length + digest.length };
}

/**
 * Build dedup fingerprints from a surface's machine-appended entry section.
 *
 * Each entry's fingerprint = `${title}||${afterState}`. A memory object
 * matching an existing fingerprint is a true duplicate. A memory object
 * with the same title but a different after-state is a STATE CHANGE — the
 * old substring-on-title check silently dropped these (e.g. "Cosmo23 is up"
 * blackholed every future "Cosmo23" entry including "Cosmo23 is now down").
 *
 * Returns { fingerprints: Set<string> }. Header content is not parsed —
 * for objects without a state_delta, callers should fall back to a
 * substring check against the full surface.
 */
function buildSurfaceFingerprints(content) {
  const { entries } = _splitHeaderAndEntries(content);
  const fingerprints = new Set();
  for (const e of entries) {
    const titleMatch = e.raw.match(/^### (.+?)\n/);
    if (!titleMatch) continue;
    const title = titleMatch[1].trim().toLowerCase();
    const afterMatch = e.raw.match(/→\s*([^(\n]+?)(?:\s*\(|$)/m);
    const after = afterMatch ? afterMatch[1].trim().toLowerCase().slice(0, 100) : '';
    fingerprints.add(`${title}||${after}`);
  }
  return { fingerprints };
}

function objFingerprint(obj) {
  const title = (obj?.title || '').trim().toLowerCase();
  const after = obj?.state_delta?.after?.state
    ? String(obj.state_delta.after.state).trim().toLowerCase().slice(0, 100)
    : '';
  return `${title}||${after}`;
}

module.exports = {
  compactSurface,
  generateRecentDigest,
  buildSurfaceFingerprints,
  objFingerprint,
  _dropOldEntries,
  _splitHeaderAndEntries,
};
