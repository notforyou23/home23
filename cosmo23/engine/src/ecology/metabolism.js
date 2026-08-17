'use strict';

/**
 * Sleep/Dream Memory Metabolism — a transaction, not a prose genre (Inv 10).
 *
 * Every metabolism run:
 *   1. pins the immutable parent (questions + promotion ledger tail + last
 *      commit) and the candidate-journal high-water mark;
 *   2. acquires an exclusive lease with a fencing token;
 *   3. replays the candidate journal through the pinned high-water mark;
 *   4. builds a staged child view — never mutates the parent while staging;
 *   5. consolidates duplicate candidates with explicit alias mappings;
 *   6. generates dream candidates as unverified hypotheses (origin=dream);
 *   7. has the Principal propose epistemic changes;
 *   8. CAS-commits the child against the pinned parent and live fence, or
 *      rolls back completely;
 *   9. emits a wake briefing with exact diffs.
 *
 * Dreams cannot directly create sourced facts or change epistemic status —
 * dream output enters the candidate journal typed origin=dream and may only
 * mature through later expeditions and promotion.
 */

const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { isFatalAuthError } = require('../../../lib/auth-error');
const { extractJson } = require('./principal');

function attemptId() {
  return `met_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function normalizeWords(text) {
  return new Set(String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((word) => word.length > 2));
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const word of a) if (b.has(word)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

class Metabolism {
  constructor({ runtimePath, questions, promotionGate, principal, journal, client, config, logger } = {}) {
    this.runtimePath = runtimePath;
    this.questions = questions;
    this.promotionGate = promotionGate;
    this.principal = principal;
    this.journal = journal;
    this.client = client || null;
    this.config = config || {};
    this.logger = logger || console;

    this.dir = path.join(runtimePath, 'ecology');
    this.candidatesFile = path.join(runtimePath, 'outputs', 'candidates', 'findings.jsonl');
    this.commitsFile = path.join(this.dir, 'commits.jsonl');
    this.lockFile = path.join(this.dir, '.metabolism.lock');
    this.briefingsDir = path.join(this.dir, 'wake-briefings');
  }

  async lastCommit() {
    try {
      const raw = await fsp.readFile(this.commitsFile, 'utf8');
      const lines = raw.trim().split('\n').filter(Boolean);
      if (lines.length === 0) return null;
      return JSON.parse(lines[lines.length - 1]);
    } catch {
      return null;
    }
  }

  async parentFingerprint() {
    const [questionsRaw, promotionTail, last] = await Promise.all([
      fsp.readFile(this.questions.file, 'utf8').catch(() => '[]'),
      this.promotionGate.ledgerTail(),
      this.lastCommit()
    ]);
    return sha256([
      sha256(questionsRaw),
      promotionTail.tailHash,
      last?.commitId || 'commit-genesis'
    ].join('|'));
  }

  async candidatesLength() {
    try {
      const stat = await fsp.stat(this.candidatesFile);
      return stat.size;
    } catch {
      return 0;
    }
  }

  async replayCandidates(fromByte, toByte) {
    if (toByte <= fromByte) return [];
    let raw;
    try {
      raw = await fsp.readFile(this.candidatesFile, 'utf8');
    } catch {
      return [];
    }
    const slice = raw.slice(fromByte, toByte);
    return slice.split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  }

  async acquireLease(attempt) {
    await fsp.mkdir(this.dir, { recursive: true });
    const fencingToken = crypto.randomBytes(8).toString('hex');
    const lease = { attemptId: attempt, fencingToken, pid: process.pid, at: Date.now() };
    try {
      await fsp.writeFile(this.lockFile, JSON.stringify(lease), { flag: 'wx' });
      return lease;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // A stale lease (older than 30 minutes) is evidence of a crashed
      // attempt; archive it rather than deleting evidence.
      try {
        const existing = JSON.parse(await fsp.readFile(this.lockFile, 'utf8'));
        if (Date.now() - (existing.at || 0) > 30 * 60 * 1000) {
          await fsp.rename(this.lockFile, `${this.lockFile}.stale-${existing.attemptId || 'unknown'}`);
          await fsp.writeFile(this.lockFile, JSON.stringify(lease), { flag: 'wx' });
          return lease;
        }
      } catch { /* fall through to conflict */ }
      return null;
    }
  }

  async releaseLease(lease) {
    try {
      const current = JSON.parse(await fsp.readFile(this.lockFile, 'utf8'));
      if (current.fencingToken === lease.fencingToken) {
        await fsp.unlink(this.lockFile);
      }
    } catch { /* already released */ }
  }

  async leaseIsLive(lease) {
    try {
      const current = JSON.parse(await fsp.readFile(this.lockFile, 'utf8'));
      return current.fencingToken === lease.fencingToken;
    } catch {
      return false;
    }
  }

  consolidate(candidates) {
    const groups = [];
    const wordSets = candidates.map((candidate) => normalizeWords(candidate.content));
    const assigned = new Array(candidates.length).fill(false);
    for (let i = 0; i < candidates.length; i++) {
      if (assigned[i]) continue;
      const group = { kept: candidates[i], aliases: [] };
      assigned[i] = true;
      for (let j = i + 1; j < candidates.length; j++) {
        if (assigned[j]) continue;
        if (jaccard(wordSets[i], wordSets[j]) >= 0.8) {
          group.aliases.push(candidates[j]);
          assigned[j] = true;
        }
      }
      groups.push(group);
    }
    return groups;
  }

  async dream({ candidates, incubating }) {
    if (!this.client || typeof this.client.createCompletion !== 'function') {
      return { hypotheses: [], questions: [], contradictions: [], degraded: true };
    }
    const system = [
      'You are the dreaming, default-mode cognition of an autonomous research mind.',
      'Given recent candidate findings and incubating questions, produce:',
      '- bridge hypotheses connecting distant material (unverified),',
      '- new research questions worth incubating or pursuing,',
      '- contradictions or tensions you notice.',
      'These are dreams: unverified, typed, never facts. Reply as JSON only:',
      '{"hypotheses":["..."],"questions":[{"text":"...","why":"..."}],"contradictions":["..."]}'
    ].join('\n');
    const user = [
      'Recent candidates:',
      ...candidates.slice(0, 30).map((candidate) => `- ${String(candidate.content || '').slice(0, 200)}`),
      '',
      'Incubating questions:',
      ...incubating.slice(0, 10).map((question) => `- ${question.text.slice(0, 160)}`)
    ].join('\n');

    const model = this.config.models?.fast || this.config.models?.primary;
    const response = await this.client.createCompletion({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      temperature: 0.9,
      maxTokens: 1200
    });
    if (isFatalAuthError(response)) {
      const err = new Error('Dream model call failed: authentication_error');
      err.type = 'authentication_error';
      throw err;
    }
    const parsed = extractJson(response?.choices?.[0]?.message?.content) || {};
    return {
      hypotheses: Array.isArray(parsed.hypotheses) ? parsed.hypotheses.filter(Boolean).slice(0, 6) : [],
      questions: Array.isArray(parsed.questions) ? parsed.questions.filter((question) => question?.text).slice(0, 4) : [],
      contradictions: Array.isArray(parsed.contradictions) ? parsed.contradictions.filter(Boolean).slice(0, 4) : [],
      degraded: false
    };
  }

  /**
   * Run one sleep/dream transaction. Returns a typed result; on any failure
   * the parent stays untouched and the result is { committed: false }.
   *
   * options.failBeforeCommit is a test-only fault-injection hook proving the
   * rollback path.
   */
  async run({ memory, seedQuestion = null, failBeforeCommit = false } = {}) {
    const attempt = attemptId();
    const startedAt = Date.now();

    const lease = await this.acquireLease(attempt);
    if (!lease) {
      await this.journal?.append('metabolism_conflict', { attemptId: attempt, reason: 'lease_held' });
      return { committed: false, attemptId: attempt, reason: 'lease_held' };
    }

    let staged = null;
    try {
      // 1. Pin the parent and the candidate high-water mark.
      const parentHash = await this.parentFingerprint();
      const last = await this.lastCommit();
      const fromByte = last?.candidatesHighWaterMark || 0;
      const toByte = await this.candidatesLength();
      await this.journal?.append('metabolism_started', {
        attemptId: attempt, parentHash, fromByte, toByte
      });

      // 2-3. Replay the journal through the pinned high-water mark.
      const replayed = await this.replayCandidates(fromByte, toByte);
      await this.questions.load();
      const incubating = this.questions.list({ status: 'incubating' });

      // 4-6. Staged child: consolidation + dream candidates. Parent untouched.
      const groups = this.consolidate(replayed);
      const consolidations = groups
        .filter((group) => group.aliases.length > 0)
        .map((group) => ({ keptId: group.kept.id, aliasIds: group.aliases.map((alias) => alias.id) }));
      const uniqueCandidates = groups.map((group) => group.kept);

      let dreamOutput = { hypotheses: [], questions: [], contradictions: [], degraded: true };
      let dreamTurns = 0;
      if (replayed.length > 0 || incubating.length > 0) {
        dreamOutput = await this.dream({ candidates: uniqueCandidates, incubating });
        dreamTurns = dreamOutput.degraded ? 0 : 1;
      }

      // 7. Principal proposes epistemic changes over the replayed material.
      let review = { decisions: [], degraded: true };
      let principalTurns = 0;
      if (this.principal && (uniqueCandidates.length > 0 || incubating.length > 0)) {
        review = await this.principal.wakeReview({
          candidates: uniqueCandidates,
          questions: this.questions.list(),
          seedQuestion
        });
        principalTurns = review.degraded ? 0 : 1;
      }

      staged = {
        attemptId: attempt,
        parentHash,
        fromByte,
        toByte,
        consolidations,
        dreamOutput,
        decisions: review.decisions,
        turnsUsed: dreamTurns + principalTurns
      };

      if (failBeforeCommit) {
        throw new Error('injected_failure_before_commit');
      }

      // 8. CAS commit: parent unchanged and lease still ours, or rollback.
      const parentNow = await this.parentFingerprint();
      if (parentNow !== parentHash || !(await this.leaseIsLive(lease))) {
        throw new Error('cas_conflict');
      }

      await this.journal?.append('metabolism_commit_pending', { attemptId: attempt, parentHash });

      // Apply: dream candidates enter the candidate journal (typed,
      // unverified). Promotions and question changes go through the
      // deterministic gates. Dream output never changes epistemic status.
      const dreamCandidateIds = [];
      const dreamEntries = [
        ...staged.dreamOutput.hypotheses.map((text) => ({ kind: 'hypothesis', content: text })),
        ...staged.dreamOutput.contradictions.map((text) => ({ kind: 'contradiction', content: text }))
      ];
      for (const entry of dreamEntries) {
        const id = `cand_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
        const row = {
          id,
          type: 'candidate_finding',
          kind: entry.kind,
          content: entry.content,
          tag: entry.kind,
          at: Date.now(),
          source: 'metabolism',
          origin: 'dream',
          attemptId: attempt,
          promoted: false,
          epistemicStatus: 'unverified'
        };
        await fsp.mkdir(path.dirname(this.candidatesFile), { recursive: true });
        await fsp.appendFile(this.candidatesFile, `${JSON.stringify(row)}\n`);
        dreamCandidateIds.push(id);
      }

      const dreamQuestions = [];
      for (const dreamQuestion of staged.dreamOutput.questions) {
        const question = await this.questions.create({
          text: dreamQuestion.text,
          origin: 'dream',
          lane: 'incubation',
          why: dreamQuestion.why || 'dream incubation',
          provenance: { originatedBy: 'dream', preauthored: false, expeditionId: null },
          status: 'incubating'
        });
        dreamQuestions.push(question.id);
      }

      const promotions = [];
      const questionChanges = [];
      for (const decision of staged.decisions) {
        await this.journal?.append('principal_decision', decision);
        if (decision.kind === 'promotion_proposal') {
          const result = await this.promotionGate.promote({ decision, memory });
          promotions.push({ decisionId: decision.id, candidateId: decision.candidateId, ...result });
        } else if (decision.kind === 'question_lifecycle_proposal') {
          try {
            await this.questions.transition(decision.questionId, decision.newStatus, {
              by: 'principal',
              reason: decision.rationale,
              decisionId: decision.id
            });
            questionChanges.push({ decisionId: decision.id, questionId: decision.questionId, applied: true });
          } catch (err) {
            questionChanges.push({
              decisionId: decision.id,
              questionId: decision.questionId,
              applied: false,
              reason: err.message
            });
          }
        }
      }

      const commit = {
        commitId: sha256(`${parentHash}|${attempt}|${toByte}`),
        parentCommitId: last?.commitId || 'commit-genesis',
        parentHash,
        attemptId: attempt,
        at: Date.now(),
        candidatesHighWaterMark: toByte,
        replayedCandidates: replayed.length,
        consolidations,
        dreamCandidateIds,
        dreamQuestionIds: dreamQuestions,
        promotionsApplied: promotions.filter((promotion) => promotion.promoted).length,
        promotionsRefused: promotions.filter((promotion) => !promotion.promoted).length,
        questionChangesApplied: questionChanges.filter((change) => change.applied).length,
        turnsUsed: staged.turnsUsed,
        durationMs: Date.now() - startedAt
      };
      await fsp.appendFile(this.commitsFile, `${JSON.stringify(commit)}\n`);
      await this.journal?.append('metabolism_committed', commit);

      // 9. Wake briefing with exact diffs.
      const briefing = await this.writeWakeBriefing({ commit, promotions, questionChanges, staged });

      return {
        committed: true,
        attemptId: attempt,
        commit,
        promotions,
        questionChanges,
        dreamQuestions,
        briefingPath: briefing,
        turnsUsed: staged.turnsUsed
      };
    } catch (err) {
      await this.journal?.append('metabolism_rolled_back', {
        attemptId: attempt,
        reason: err.message,
        fatalAuth: isFatalAuthError(err)
      });
      if (isFatalAuthError(err)) {
        throw err;
      }
      return { committed: false, attemptId: attempt, reason: err.message };
    } finally {
      await this.releaseLease(lease);
    }
  }

  async writeWakeBriefing({ commit, promotions, questionChanges, staged }) {
    try {
      await fsp.mkdir(this.briefingsDir, { recursive: true });
      const file = path.join(this.briefingsDir, `${commit.attemptId}.md`);
      const lines = [
        `# Wake briefing — ${new Date(commit.at).toISOString()}`,
        '',
        `Commit \`${commit.commitId.slice(0, 12)}\` (parent \`${String(commit.parentCommitId).slice(0, 12)}\`)`,
        '',
        `- Replayed candidates: ${commit.replayedCandidates}`,
        `- Consolidations: ${commit.consolidations.length}`,
        `- Dream candidates: ${commit.dreamCandidateIds.length} (unverified, origin=dream)`,
        `- Dream questions incubated: ${commit.dreamQuestionIds.length}`,
        `- Promotions applied: ${commit.promotionsApplied} (refused: ${commit.promotionsRefused})`,
        `- Question lifecycle changes: ${commit.questionChangesApplied}`,
        '',
        '## Promotions',
        ...promotions.map((promotion) => `- ${promotion.candidateId}: ${promotion.promoted ? `promoted (node ${promotion.record?.nodeId})` : `refused (${promotion.reason})`}`),
        '',
        '## Question changes',
        ...questionChanges.map((change) => `- ${change.questionId}: ${change.applied ? 'applied' : `refused (${change.reason})`}`),
        '',
        '## Dream material (unverified)',
        ...staged.dreamOutput.hypotheses.map((text) => `- hypothesis: ${text}`),
        ...staged.dreamOutput.contradictions.map((text) => `- contradiction: ${text}`),
        ...staged.dreamOutput.questions.map((question) => `- question: ${question.text}`)
      ];
      await fsp.writeFile(file, lines.join('\n'));
      return file;
    } catch (err) {
      this.logger?.warn?.('Wake briefing write failed', { error: err.message });
      return null;
    }
  }
}

module.exports = { Metabolism };
