/**
 * live-problems orchestrator — exported entry for the engine boot path.
 *
 * Usage:
 *   const { initLiveProblems } = require('../live-problems');
 *   const live = initLiveProblems({ brainDir, memory, logger });
 *   live.start();
 *
 * The returned object exposes:
 *   - store  (LiveProblemStore)
 *   - loop   (LiveProblemsLoop)
 *   - start(), stop()
 *   - briefSnapshot() → shape consumed by pulse-remarks.gather()
 */

const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');
const { LiveProblemStore } = require('./store');
const { LiveProblemsLoop } = require('./loop');
const { seedAll } = require('./seed');
const { auditProblemList } = require('./audit');
const { TargetsRegistry } = require('./registry');

function loadActionAllowlistIntegrations() {
  try {
    const p = process.env.HOME23_ACTION_ALLOWLIST
      || path.join(__dirname, '..', '..', '..', 'configs', 'action-allowlist.yaml');
    const raw = yaml.load(fs.readFileSync(p, 'utf8')) || {};
    return raw.integrations || {};
  } catch {
    return {};
  }
}

function initLiveProblems({ brainDir, memory, logger, agentName, dashboardPort, bridgePort, harnessNotifyToken }) {
  const store = new LiveProblemStore({ brainDir, logger });
  const seeded = seedAll(store, { agentName, dashboardPort, bridgePort });
  try {
    const registry = new TargetsRegistry().load();
    for (const result of auditProblemList(seeded, { registry })) {
      for (const finding of result.findings) {
        const log = finding.severity === 'error' ? logger?.warn : logger?.info;
        log?.call(logger, '[live-problems] seed audit', {
          problemId: result.id,
          severity: finding.severity,
          code: finding.code,
          message: finding.message,
        });
      }
    }
  } catch (err) {
    logger?.warn?.('[live-problems] seed audit unavailable', { error: err.message });
  }

  const bport = bridgePort || process.env.BRIDGE_PORT || '5004';
  const harnessNotifyUrl = `http://127.0.0.1:${bport}/api/notify`;
  const harnessDiagnoseUrl = `http://127.0.0.1:${bport}/api/diagnose`;

  const ctxProvider = () => ({
    memory,
    brainDir,
    integrations: loadActionAllowlistIntegrations(),
    harnessNotifyUrl,
    harnessDiagnoseUrl,
    harnessNotifyToken: harnessNotifyToken || process.env.BRIDGE_TOKEN || '',
  });

  const loop = new LiveProblemsLoop({ store, logger, ctxProvider });

  return {
    store,
    loop,
    start() { loop.start(); },
    stop() { loop.stop(); },
    /**
     * Snapshot for the pulse brief. Shape:
     * {
     *   open:   [ {id, claim, ageMin, detail, chronic, escalated} ],
     *   resolvedJustNow: [ {id, claim, resolvedAt} ],  // resolved within last 30 min
     *   chronic: [ … same as open but state=chronic ],
     *   counts: { open, chronic, resolved, unverifiable },
     * }
     */
    briefSnapshot() {
      store.reloadIfChanged();
      const all = store.all();
      const now = Date.now();
      const open = [];
      const chronic = [];
      const resolvedJustNow = [];
      let resolved = 0, unverifiable = 0;
      for (const p of all) {
        if (p.state === 'open' || p.state === 'chronic') {
          const openedMs = p.openedAt ? Date.parse(p.openedAt) : now;
          const ageMin = Math.max(0, Math.round((now - openedMs) / 60000));
          const row = {
            id: p.id,
            claim: p.claim,
            ageMin,
            detail: p.lastResult?.detail || null,
            state: p.state,
            escalated: !!p.escalated,
            openedAt: p.openedAt || p.firstSeenAt || null,
            resolvedAt: p.resolvedAt || null,
            escalatedAt: p.escalatedAt || null,
            lastMentionedInPulseAt: p.lastMentionedInPulseAt || null,
            lastRemediation: (p.remediationLog || []).slice(-1)[0] || null,
          };
          if (p.state === 'chronic') chronic.push(row); else open.push(row);
        } else if (p.state === 'resolved') {
          resolved++;
          const resolvedAtMs = p.resolvedAt ? Date.parse(p.resolvedAt) : 0;
          if (resolvedAtMs && (now - resolvedAtMs) < 30 * 60 * 1000) {
            resolvedJustNow.push({ id: p.id, claim: p.claim, resolvedAt: p.resolvedAt });
          }
        } else if (p.state === 'unverifiable') {
          unverifiable++;
        }
      }
      return {
        open,
        chronic,
        resolvedJustNow,
        counts: { open: open.length, chronic: chronic.length, resolved, unverifiable },
      };
    },
    /** Mark open/chronic problems as mentioned — pulse calls this after firing a remark. */
    markMentioned(ids) {
      for (const id of ids || []) store.markMentionedInPulse(id);
    },
  };
}

module.exports = { initLiveProblems };
