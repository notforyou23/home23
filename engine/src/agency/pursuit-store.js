import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

function nowIso() {
  return new Date().toISOString();
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function stableHash(input) {
  return createHash('sha256').update(String(input || '')).digest('hex');
}

function slugKey(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((word) => !['the', 'and', 'with', 'into', 'home23', 'jerry', 'diagnose', 'route', 'one', 'bounded'].includes(word))
    .slice(0, 10)
    .join('-') || 'pursuit';
}

function compactPursuit(pursuit) {
  if (!pursuit || typeof pursuit !== 'object') return pursuit;
  return {
    ...pursuit,
    history: Array.isArray(pursuit.history) ? pursuit.history.slice(-25) : [],
  };
}

export class PursuitStore {
  constructor({ brainDir, agentName = 'jerry' } = {}) {
    if (!brainDir) throw new Error('PursuitStore requires brainDir');
    this.brainDir = brainDir;
    this.agentName = agentName;
    this.dir = join(brainDir, 'agency');
    this.statePath = join(this.dir, 'state.json');
    this.inboxPath = join(this.dir, 'inbox.jsonl');
    this.pursuitsPath = join(this.dir, 'pursuits.jsonl');
    this.receiptsPath = join(this.dir, 'receipts.jsonl');
    this.consequencesPath = join(this.dir, 'consequences.jsonl');
    this.scratchPath = join(this.dir, 'scratch.jsonl');
    this.truthPath = join(this.dir, 'truth.jsonl');
    this.tasksPath = join(this.dir, 'tasks.jsonl');
    this.memoryCandidatesPath = join(this.dir, 'memory-candidates.jsonl');
    this.pursuitIndex = null;
    mkdirSync(this.dir, { recursive: true });
    for (const file of [this.inboxPath, this.pursuitsPath, this.receiptsPath, this.consequencesPath, this.scratchPath, this.truthPath, this.tasksPath, this.memoryCandidatesPath]) {
      if (!existsSync(file)) closeSync(openSync(file, 'a'));
    }
  }

  appendInbox(entry) {
    appendFileSync(this.inboxPath, `${JSON.stringify(entry)}\n`);
    return entry;
  }

  appendReceipt(entry) {
    appendFileSync(this.receiptsPath, `${JSON.stringify(entry)}\n`);
    return entry;
  }

  appendConsequence(entry) {
    appendFileSync(this.consequencesPath, `${JSON.stringify(entry)}\n`);
    return entry;
  }

  appendScratch(entry) {
    appendFileSync(this.scratchPath, `${JSON.stringify(entry)}\n`);
    return entry;
  }

  appendTruth(entry) {
    appendFileSync(this.truthPath, `${JSON.stringify(entry)}\n`);
    return entry;
  }

  appendTask(row) {
    appendFileSync(this.tasksPath, `${JSON.stringify(row)}\n`);
    return row;
  }

  appendMemoryCandidate(row) {
    appendFileSync(this.memoryCandidatesPath, `${JSON.stringify(row)}\n`);
    return row;
  }

  listInbox({ limit = 100 } = {}) {
    return readJsonl(this.inboxPath).slice(-limit).reverse();
  }

  listReceipts({ limit = 100 } = {}) {
    return readJsonl(this.receiptsPath).slice(-limit).reverse();
  }

  listConsequences({ limit = 100 } = {}) {
    return readJsonl(this.consequencesPath).slice(-limit).reverse();
  }

  listScratch({ limit = 100 } = {}) {
    return readJsonl(this.scratchPath).slice(-limit).reverse();
  }

  listTruth({ limit = 100 } = {}) {
    return readJsonl(this.truthPath).slice(-limit).reverse();
  }

  listTasks({ status = null, limit = 100 } = {}) {
    const latest = new Map();
    for (const row of readJsonl(this.tasksPath)) {
      const task = row.task || row;
      if (!task?.id) continue;
      latest.set(task.id, task);
    }
    let rows = Array.from(latest.values());
    if (status) {
      const statuses = Array.isArray(status) ? new Set(status) : new Set([status]);
      rows = rows.filter(row => statuses.has(row.status));
    }
    return rows
      .sort((a, b) => String(b.updatedAt || b.createdAt || b.at || '').localeCompare(String(a.updatedAt || a.createdAt || a.at || '')))
      .slice(0, limit);
  }

  listMemoryCandidates({ status = null, limit = 100 } = {}) {
    let rows = readJsonl(this.memoryCandidatesPath).map(row => row.candidate || row).filter(Boolean);
    if (status) {
      const statuses = Array.isArray(status) ? new Set(status) : new Set([status]);
      rows = rows.filter(row => statuses.has(row.status));
    }
    return rows
      .sort((a, b) => String(b.updatedAt || b.createdAt || b.at || '').localeCompare(String(a.updatedAt || a.createdAt || a.at || '')))
      .slice(0, limit);
  }

  getTask(id) {
    if (!id) return null;
    const rows = readJsonl(this.tasksPath);
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const task = rows[i]?.task || rows[i];
      if (task?.id === id) return task;
    }
    return null;
  }

  updateTask(id, patch = {}, event = {}) {
    const existing = this.getTask(id);
    if (!existing) throw new Error(`Agency task not found: ${id}`);
    const at = nowIso();
    const task = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: at,
    };
    this.appendTask({ type: event.type || 'updated', at, task, detail: event.detail || null });
    return task;
  }

  listPursuits({ status = null, limit = 100 } = {}) {
    const latest = this.loadPursuitIndex();
    let rows = Array.from(latest.values());
    if (status) {
      const statuses = Array.isArray(status) ? new Set(status) : new Set([status]);
      rows = rows.filter((row) => statuses.has(row.status));
    }
    return rows
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      .slice(0, limit);
  }

  getPursuit(id) {
    return this.loadPursuitIndex().get(id) || null;
  }

  findSimilar(candidate) {
    const key = this.pursuitKey(candidate);
    return this.listPursuits({ status: ['active', 'watch'], limit: 10000 })
      .find((row) => row.dedupeKey === key) || null;
  }

  createPursuit(candidate, decision) {
    const at = nowIso();
    const id = `ap_${stableHash(`${candidate.summary}|${at}|${randomUUID()}`).slice(0, 12)}`;
    const pursuit = {
      schema: 'home23.agency.pursuit.v1',
      id,
      dedupeKey: this.pursuitKey(candidate),
      title: candidate.title || this.titleFrom(candidate.summary),
      summary: candidate.summary,
      status: decision.route === 'watch' ? 'watch' : 'active',
      owner: candidate.owner || this.agentName,
      authorityLevel: candidate.authorityLevel || 'L1',
      source: candidate.source || 'manual',
      kind: candidate.kind || 'candidate',
      tags: Array.isArray(candidate.tags) ? candidate.tags : [],
      evidence: Array.isArray(candidate.evidence) ? candidate.evidence : [],
      linkedEvidence: Array.isArray(candidate.evidence) ? candidate.evidence : [],
      latestEvidence: Array.isArray(candidate.evidence) ? candidate.evidence.slice(-3) : [],
      declaredChangedFuture: Boolean(candidate.desiredChangedFuture || candidate.changedFuture),
      desiredChangedFuture: candidate.desiredChangedFuture || candidate.summary,
      whyItMatters: candidate.whyItMatters || candidate.relevance || candidate.desiredChangedFuture || candidate.summary,
      currentTheory: candidate.currentTheory || candidate.theory || 'Unproven until consequence receipts change state.',
      nextMove: candidate.nextMove || candidate.next || defaultNextMove(candidate),
      attentionBudget: candidate.attentionBudget || candidate.budget || defaultAttentionBudget(candidate),
      risk: candidate.risk || candidate.authorityLevel || 'L1',
      evidenceStandard: candidate.evidenceStandard || 'receipt_or_current_state_verifier',
      stopCondition: candidate.stopCondition || candidate.desiredChangedFuture || 'changed future is verified or the pursuit is explicitly discarded',
      decay: candidate.decay || { staleAfterHours: 168, action: 'surface_for_kill_or_defer' },
      escalation: candidate.escalation || { askJtrWhen: 'value_depends_on_jtr_judgment_or_authority_exceeds_policy' },
      whatWouldChangeMyMind: candidate.whatWouldChangeMyMind || 'newer verified state or jtr correction contradicts the current theory',
      sourceTruthStatus: candidate.sourceTruthStatus || 'unverified',
      verifier: candidate.verifier || null,
      artifacts: Array.isArray(candidate.artifacts) ? candidate.artifacts : [],
      createdAt: at,
      updatedAt: at,
      lastSeenAt: at,
      lastTouched: at,
      seenCount: 1,
      history: [{ at, status: 'created', reason: decision.reason }],
    };
    this.appendPursuitEvent({ type: 'created', at, pursuit });
    return pursuit;
  }

  updatePursuit(id, patch = {}, event = {}) {
    const existing = this.getPursuit(id);
    if (!existing) throw new Error(`Pursuit not found: ${id}`);
    const at = nowIso();
    const pursuit = {
      ...existing,
      ...patch,
      id: existing.id,
      updatedAt: at,
      history: [
        ...(existing.history || []),
        { at, status: patch.status || existing.status, reason: event.reason || event.type || 'updated' },
      ].slice(-25),
    };
    this.appendPursuitEvent({ type: event.type || 'updated', at, pursuit, detail: event.detail || null });
    return pursuit;
  }

  mergeSeen(existing, candidate, decision) {
    const evidence = [...(existing.evidence || []), ...(candidate.evidence || [])];
    const uniqueEvidence = [];
    const seen = new Set();
    for (const item of evidence) {
      const key = JSON.stringify(item);
      if (seen.has(key)) continue;
      seen.add(key);
      uniqueEvidence.push(item);
    }
    return this.updatePursuit(existing.id, {
      evidence: uniqueEvidence,
      linkedEvidence: uniqueEvidence,
      latestEvidence: uniqueEvidence.slice(-3),
      lastSeenAt: nowIso(),
      seenCount: Number(existing.seenCount || 1) + 1,
    }, { type: 'merged', reason: decision.reason });
  }

  transition(id, transition = {}) {
    const status = String(transition.status || transition.transition || 'updated');
    const pursuit = this.updatePursuit(id, {
      status,
      consequence: transition.consequence || null,
    }, { type: 'transition', reason: transition.reason || status, detail: transition });
    if (status === 'closed' || transition.consequence) {
      this.appendConsequence({
        schema: 'home23.agency.consequence.v1',
        at: nowIso(),
        pursuitId: id,
        status,
        changeType: transition.changeType || (status === 'closed' ? 'pursuit_closed' : 'pursuit_updated'),
        summary: transition.summary || transition.reason || null,
        evidence: transition.evidence || [],
      });
    }
    return pursuit;
  }

  appendPursuitEvent(row) {
    const compact = row?.pursuit ? { ...row, pursuit: compactPursuit(row.pursuit) } : row;
    appendFileSync(this.pursuitsPath, `${JSON.stringify(compact)}\n`);
    if (compact?.pursuit?.id) {
      this.loadPursuitIndex().set(compact.pursuit.id, compact.pursuit);
    }
    return compact;
  }

  loadPursuitIndex() {
    if (this.pursuitIndex) return this.pursuitIndex;
    const latest = new Map();
    for (const row of readJsonl(this.pursuitsPath)) {
      const pursuit = compactPursuit(row.pursuit);
      if (pursuit?.id) latest.set(pursuit.id, pursuit);
    }
    this.pursuitIndex = latest;
    return latest;
  }

  readState() {
    if (!existsSync(this.statePath)) return null;
    try { return JSON.parse(readFileSync(this.statePath, 'utf8')); } catch { return null; }
  }

  writeState(state) {
    writeFileSync(this.statePath, `${JSON.stringify(state, null, 2)}\n`);
    return state;
  }

  pursuitKey(candidate) {
    if (candidate.dedupeKey) return String(candidate.dedupeKey);
    const source = String(candidate.source || '');
    const tags = Array.isArray(candidate.tags) ? candidate.tags.join('-') : '';
    if (source === 'domain.good-life') {
      const mode = candidate.policyMode || candidate.policy?.mode || '';
      const lane = Array.isArray(candidate.tags) ? candidate.tags.find((tag) => /usefulness|continuity|viability|friction|recovery|coherence|development/.test(tag)) : '';
      return `good-life:${mode || lane || slugKey(candidate.summary)}`;
    }
    if (candidate.kind === 'observation' && source) {
      return `observation:${source}`;
    }
    return `${source}:${candidate.kind || 'candidate'}:${slugKey(candidate.summary)}`;
  }

  titleFrom(summary) {
    return String(summary || 'Agency pursuit').replace(/\s+/g, ' ').trim().slice(0, 96);
  }
}

function defaultNextMove(candidate) {
  if (candidate.authorityLevel === 'L4') return 'request jtr authority before action';
  if (candidate.desiredChangedFuture) return 'verify or propose the smallest reversible change toward the desired future';
  return 'collect one more piece of evidence or explicitly discard';
}

function defaultAttentionBudget(candidate) {
  if (candidate.authorityLevel === 'L3' || candidate.authorityLevel === 'L4') return { actionsPerWeek: 1, maxMinutesPerDay: 15 };
  if (candidate.kind === 'observation') return { actionsPerWeek: 1, maxMinutesPerDay: 5 };
  return { actionsPerWeek: 3, maxMinutesPerDay: 30 };
}
