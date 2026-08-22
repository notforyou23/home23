/**
 * WorkspaceInsightsPublisher — emits a synthesis artifact to
 * workspace/insights/ every N cycles. Source cluster is selected via
 * an injected selector (default: the highest-confidence recent topic
 * from the MemoryObjectStore).
 */

'use strict';

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function resolveNow(now) {
  return typeof now === 'function' ? now() : now;
}

async function attemptWorkspaceInsightsCatchUp({
  ledger,
  publisher,
  now = Date.now(),
  reason = 'force',
  logger = console,
  skippedMessage = `[publish] workspace-insights ${reason} skipped: no cluster available`,
} = {}) {
  const effectiveNow = resolveNow(now);
  const starvingBefore = ledger?.listStarving?.({ now: effectiveNow }) || [];
  if (!starvingBefore.includes('workspace_insights')) {
    return { result: null, starvingBefore, starvingAfter: starvingBefore };
  }
  if (!publisher?.forcePublish) {
    return { result: null, starvingBefore, starvingAfter: starvingBefore };
  }
  const result = await publisher.forcePublish({ reason });
  if (!result) {
    logger.info?.(skippedMessage);
  }
  return {
    result,
    starvingBefore,
    starvingAfter: ledger?.listStarving?.({ now: resolveNow(now) }) || [],
  };
}

export class WorkspaceInsightsPublisher {
  constructor({ outDir, cadenceCycles = 50, selectCluster, ledger, logger }) {
    if (!outDir) throw new Error('WorkspaceInsightsPublisher requires outDir');
    this.outDir = outDir;
    this.cadenceCycles = cadenceCycles;
    this.selectCluster = selectCluster || (() => null);
    this.ledger = ledger;
    this.logger = logger || console;
  }

  async onCycle({ cycleIndex }) {
    if (!Number.isInteger(cycleIndex) || cycleIndex < 1) return null;
    if (cycleIndex % this.cadenceCycles !== 0) return null;
    return this._publish({ cycleIndex });
  }

  async forcePublish({ cycleIndex = null, reason = 'force' } = {}) {
    return this._publish({ cycleIndex, reason });
  }

  async _publish({ cycleIndex = null, reason = 'cadence' } = {}) {
    const cluster = await this.selectCluster();
    if (!cluster) return null;
    try { mkdirSync(this.outDir, { recursive: true }); } catch {}
    const generatedAt = new Date().toISOString();
    const date = generatedAt.slice(0, 10);
    const slug = (cluster.topic || 'insight').replace(/[^a-z0-9-]+/gi, '-').toLowerCase().slice(0, 60);
    const path = join(this.outDir, `${date}-${slug}.md`);
    const body = [
      `# Insight — ${cluster.topic}`,
      '',
      ...(Number.isInteger(cycleIndex) && cycleIndex > 0 ? [`**Cycle:** ${cycleIndex}`] : []),
      ...(reason !== 'cadence' ? [`**Trigger:** ${reason}`] : []),
      `**Generated:** ${generatedAt}`,
      '',
      '## Summary',
      cluster.summary || '',
      '',
      '## Source Observations',
      (cluster.observations || []).map((o) => `- ${o.sourceRef || o.memoryObjectId || '(no ref)'}`).join('\n'),
      '',
    ].join('\n');
    writeFileSync(path, body);
    await this.ledger?.record?.({ target: 'workspace_insights', artifact: path });
    const triggerSuffix = reason === 'cadence' ? '' : ` (${reason})`;
    this.logger.info?.(`[publish] workspace-insights${triggerSuffix}: ${path}`);
    return path;
  }
}

export async function attemptWorkspaceInsightsStartupCatchUp({
  ledger,
  publisher,
  now = Date.now(),
  logger = console,
} = {}) {
  const { result } = await attemptWorkspaceInsightsCatchUp({
    ledger,
    publisher,
    now,
    reason: 'startup-catch-up',
    logger,
    skippedMessage: '[publish] workspace-insights startup catch-up skipped: no cluster available',
  });
  return result;
}

export function createWorkspaceInsightsStarvationMonitor({
  ledger,
  publisher,
  now = () => Date.now(),
  logger = console,
} = {}) {
  let inFlight = null;
  return async function monitorWorkspaceInsightsStarvation() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const { starvingAfter } = await attemptWorkspaceInsightsCatchUp({
          ledger,
          publisher,
          now,
          reason: 'starvation-catch-up',
          logger,
          skippedMessage: '[publish] workspace-insights starvation catch-up skipped: no cluster available',
        });
        return starvingAfter;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };
}

/**
 * Default cluster selector: reads memory-objects.json and returns the
 * topic with the highest total confidence.
 */
export function selectHighestConfidenceCluster(brainDir) {
  return () => {
    try {
      const path = join(brainDir, 'memory-objects.json');
      if (!existsSync(path)) return null;
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      const all = Array.isArray(raw?.objects) ? raw.objects : [];
      if (!all.length) return null;
      const byTopic = new Map();
      for (const mo of all) {
        const t = mo.provenance?.source_refs?.[1] || mo.type || 'uncategorized';
        if (!byTopic.has(t)) byTopic.set(t, { topic: t, observations: [], totalConfidence: 0 });
        const g = byTopic.get(t);
        g.observations.push({ sourceRef: mo.provenance?.source_refs?.[0], memoryObjectId: mo.memory_id });
        g.totalConfidence += mo.confidence?.score || 0;
      }
      const sorted = [...byTopic.values()].sort((a, b) => b.totalConfidence - a.totalConfidence);
      const top = sorted[0];
      if (!top) return null;
      return {
        topic: top.topic,
        observations: top.observations.slice(0, 10),
        summary: `Top cluster by total confidence: ${top.topic} — ${top.observations.length} observations, total confidence ${top.totalConfidence.toFixed(2)}`,
      };
    } catch { return null; }
  };
}
