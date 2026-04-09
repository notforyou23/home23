/**
 * SpawnGate — Deduplication guard for agent spawning
 *
 * DESIGN PRINCIPLE: Never just block. Either allow, or differentiate.
 *
 * When SpawnGate detects overlap with prior work, it does NOT block the spawn.
 * Instead, it enriches the mission with context about what was already done,
 * so the new agent can approach the task differently.
 *
 * Blocking only happens for true redundancy: the exact same mission was
 * attempted AND succeeded productively multiple times.
 */

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length >= 3);
}

function similarityScore(a, b) {
  const aTokens = new Set(tokenize(a));
  const bTokens = new Set(tokenize(b));

  if (aTokens.size === 0 || bTokens.size === 0) return 0;

  let intersection = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) intersection += 1;
  }

  const union = new Set([...aTokens, ...bTokens]).size;
  return union === 0 ? 0 : intersection / union;
}

function summarize(text, max = 160) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > max
    ? `${normalized.slice(0, max - 3)}...`
    : normalized;
}

class SpawnGate {
  constructor({ memory = null, resultsQueue = null, clusterStateStore = null } = {}, logger = null) {
    this.memory = memory;
    this.resultsQueue = resultsQueue;
    this.clusterStateStore = clusterStateStore;
    this.logger = logger;
    this.memoryThreshold = 0.9;
    this.resultsThreshold = 0.55;
    // True block only when overlap is very high AND prior work was productive
    this.hardBlockThreshold = 0.85;
  }

  setClusterStateStore(clusterStateStore) {
    this.clusterStateStore = clusterStateStore || null;
  }

  buildMissionKey(missionSpec = {}) {
    return [
      missionSpec.description,
      missionSpec.metadata?.sourceScope,
      missionSpec.metadata?.expectedOutput,
      missionSpec.metadata?.originalAgentType
    ]
      .filter(Boolean)
      .join(' | ');
  }

  /**
   * Check if a result represents genuinely productive, successful work.
   * Failed, errored, and unproductive agents do NOT count.
   */
  isProductiveResult(result) {
    if (!result || typeof result !== 'object') return false;

    const status = String(result.status || '');
    if (status === 'failed' || status === 'timeout' || status === 'completed_unproductive') return false;
    if (!status.startsWith('completed')) return false;

    // Execution errors don't count even if agent "completed"
    if (result.agentSpecificData?.metadata?.hadError || result.metadata?.hadError) return false;

    const findings = Array.isArray(result.results)
      ? result.results.filter(item => ['finding', 'insight', 'deliverable', 'synthesis'].includes(item?.type)).length
      : 0;

    const artifactCount =
      Number(result.agentSpecificData?.metadata?.artifactsCreated || 0) +
      Number(result.agentSpecificData?.metadata?.filesCreated || 0) +
      Number(result.metadata?.artifactsCreated || 0) +
      Number(result.metadata?.filesCreated || 0);

    return findings > 0 || artifactCount > 0 || Boolean(result.handoffSpec);
  }

  collectResults() {
    if (!this.resultsQueue) return [];

    const queue = Array.isArray(this.resultsQueue.queue) ? this.resultsQueue.queue : [];
    const history = Array.isArray(this.resultsQueue.history) ? this.resultsQueue.history : [];
    const processed = Array.isArray(this.resultsQueue.processed) ? this.resultsQueue.processed : [];

    return [...history, ...processed, ...queue];
  }

  async findMemoryMatches(missionKey) {
    if (!this.memory?.query || !missionKey) return [];

    try {
      const matches = await this.memory.query(missionKey, 8);
      return (matches || [])
        .filter(match => (match.similarity || 0) >= this.memoryThreshold)
        .map(match => ({
          similarity: match.similarity || 0,
          summary: summarize(match.content || match.concept || match.label || '')
        }));
    } catch (error) {
      this.logger?.debug?.('SpawnGate memory query failed', { error: error.message });
      return [];
    }
  }

  findResultMatches(missionKey) {
    const productive = this.collectResults().filter(r => this.isProductiveResult(r));

    return productive
      .map(result => {
        const comparisonText = [
          result.mission?.description,
          result.handoffSpec?.reason,
          ...(Array.isArray(result.results)
            ? result.results
                .filter(item => ['finding', 'insight', 'synthesis'].includes(item?.type))
                .slice(0, 3)
                .map(item => item.content)
            : [])
        ]
          .filter(Boolean)
          .join(' | ');

        const score = similarityScore(missionKey, comparisonText);
        return {
          agentId: result.agentId,
          agentType: result.agentType,
          score,
          mission: summarize(result.mission?.description || ''),
          keyFindings: Array.isArray(result.results)
            ? result.results
                .filter(item => item?.type === 'finding')
                .slice(0, 3)
                .map(item => summarize(item.content || '', 100))
            : []
        };
      })
      .filter(match => match.score >= this.resultsThreshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  }

  /**
   * Evaluate a mission for overlap with prior work.
   *
   * Returns one of three outcomes:
   *   - { allowed: true, action: 'proceed' } — no overlap, go ahead
   *   - { allowed: true, action: 'differentiate', priorWork: [...] } — overlap found,
   *     mission enriched with prior work context so agent can approach differently
   *   - { allowed: false, action: 'block', reason: '...' } — true redundancy,
   *     only when very high overlap with multiple productive completions
   */
  async evaluate(missionSpec = {}) {
    // Explicit bypass
    if (missionSpec.metadata?.disableSpawnGate) {
      return { allowed: true, action: 'proceed', reason: null, evidence: { memoryMatches: [], resultMatches: [] } };
    }

    const missionKey = this.buildMissionKey(missionSpec);
    if (!missionKey) {
      return { allowed: true, action: 'proceed', reason: null, evidence: { memoryMatches: [], resultMatches: [] } };
    }

    const [memoryMatches, resultMatches] = await Promise.all([
      this.findMemoryMatches(missionKey),
      Promise.resolve(this.findResultMatches(missionKey))
    ]);

    const hasMemoryOverlap = memoryMatches.length > 0;
    const hasResultOverlap = resultMatches.length > 0;

    // No overlap at all — proceed normally
    if (!hasMemoryOverlap && !hasResultOverlap) {
      return { allowed: true, action: 'proceed', reason: null, evidence: { memoryMatches, resultMatches } };
    }

    // Check for true redundancy: very high overlap AND multiple productive results
    const highOverlapResults = resultMatches.filter(m => m.score >= this.hardBlockThreshold);
    const isPlanTask = missionSpec.metadata?.isPlanTask || missionSpec.metadata?.guidedMission;

    if (highOverlapResults.length >= 2 && !isPlanTask) {
      // True redundancy — this exact thing has been done productively twice already
      const reason = `true_redundancy: ${highOverlapResults.length} productive completions at ≥${this.hardBlockThreshold} similarity`;
      this.logger?.info?.('SpawnGate: true redundancy detected, blocking', {
        missionKey: summarize(missionKey, 80),
        productiveMatches: highOverlapResults.length,
        topScore: highOverlapResults[0].score.toFixed(2)
      });
      return { allowed: false, action: 'block', reason, evidence: { memoryMatches, resultMatches } };
    }

    // Overlap detected but not true redundancy — DIFFERENTIATE, don't block
    // Enrich the mission with context about what was already done
    const priorWork = resultMatches.map(m => ({
      agentId: m.agentId,
      agentType: m.agentType,
      similarity: m.score,
      mission: m.mission,
      keyFindings: m.keyFindings
    }));

    // Build differentiation context that will be injected into the mission
    const diffContext = this._buildDifferentiationContext(priorWork, memoryMatches);

    this.logger?.info?.('SpawnGate: overlap detected, differentiating mission', {
      missionKey: summarize(missionKey, 80),
      priorAgents: priorWork.length,
      topSimilarity: resultMatches[0]?.score?.toFixed(2) || memoryMatches[0]?.similarity?.toFixed(2),
      differentiation: summarize(diffContext, 100)
    });

    return {
      allowed: true,
      action: 'differentiate',
      reason: null,
      evidence: { memoryMatches, resultMatches },
      priorWork,
      differentiationContext: diffContext
    };
  }

  /**
   * Build context text that tells the new agent what was already done
   * so it can approach the task differently.
   */
  _buildDifferentiationContext(priorWork, memoryMatches) {
    const parts = [];

    if (priorWork.length > 0) {
      parts.push('PRIOR WORK ON THIS TOPIC (do NOT repeat — build on or approach differently):');
      for (const pw of priorWork.slice(0, 3)) {
        parts.push(`- Agent ${pw.agentType || 'unknown'} (similarity: ${(pw.similarity * 100).toFixed(0)}%): ${pw.mission}`);
        if (pw.keyFindings.length > 0) {
          parts.push(`  Key findings: ${pw.keyFindings.join('; ')}`);
        }
      }
    }

    if (memoryMatches.length > 0) {
      parts.push('EXISTING KNOWLEDGE (already in memory):');
      for (const mm of memoryMatches.slice(0, 3)) {
        parts.push(`- ${mm.summary}`);
      }
    }

    parts.push('YOUR TASK: Extend, deepen, or take a different angle from the prior work. Do not duplicate.');

    return parts.join('\n');
  }

  /**
   * Annotate a task that was blocked (only for true redundancy).
   */
  async annotateBlockedTask(taskId, reason, evidence = {}) {
    if (!this.clusterStateStore || !taskId) return;

    try {
      const task = await this.clusterStateStore.getTask(taskId);
      if (!task) return;

      task.state = 'BLOCKED';
      task.failureReason = reason;
      task.metadata = task.metadata || {};
      task.metadata.spawnGateBlocked = true;
      task.metadata.spawnGateReason = reason;
      task.metadata.spawnGateEvidence = evidence;
      task.updatedAt = Date.now();

      await this.clusterStateStore.upsertTask(task);
    } catch (error) {
      this.logger?.warn?.('SpawnGate failed to annotate blocked task', {
        taskId,
        error: error.message
      });
    }
  }

  archiveBlockedGoal(goals, goalId, reason, evidence = {}) {
    if (!goals || !goalId) return false;

    try {
      const goal = Array.isArray(goals.getGoals?.())
        ? goals.getGoals().find(item => item.id === goalId)
        : null;

      if (goal) {
        goal.metadata = goal.metadata || {};
        goal.metadata.spawnGateReason = reason;
        goal.metadata.spawnGateEvidence = evidence;
        goal.metadata.spawnGateBlockedAt = new Date().toISOString();
      }

      if (typeof goals.archiveGoal === 'function') {
        return goals.archiveGoal(goalId, `spawn_gate:${reason}`);
      }
    } catch (error) {
      this.logger?.warn?.('SpawnGate failed to archive blocked goal', {
        goalId,
        error: error.message
      });
    }

    return false;
  }
}

module.exports = {
  SpawnGate,
  similarityScore
};
