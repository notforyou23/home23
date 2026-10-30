'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { appendSeedProjectionOnce } = require('../../../shared/seed-source-projection.cjs');
const { readSeedLearning, normalizeLearningDecision, executionTargetTag, evaluateLearnedDecision } = require('../../../shared/seed-learning.cjs');
const { flushActionFeedback } = require('./action-feedback');
const { boundedIntentTarget } = require('./bounded-intent');

function appendInspectionReceipt(brainDir, receipt, fresh = false) {
  appendSeedProjectionOnce(path.join(brainDir, 'actions.jsonl'), receipt, { newUnique: fresh });
  return flushActionFeedback(brainDir);
}

/** The original runtime intent owns eligibility. Read-only projection retries
 * never invoke an inspection or manufacture a later law for older receipts. */
function prepareAgendaInspection({ brainDir, workspaceDir, conversationsDir, agentName, problemId, agendaId, intent,
  autonomousOptional = false, ownerRequested = false, criticalRecovery = false, readLearning } = {}) {
  const executionId = crypto.randomUUID(), ts = new Date().toISOString();
  const target = boundedIntentTarget(intent), targetTag = executionTargetTag(target);
  const optionalAuto = autonomousOptional === true && ownerRequested !== true && criticalRecovery !== true;
  const decision = normalizeLearningDecision({ schema: 'home23.learning-decision.v1',
    decisionId: `action:${executionId}`, scope: 'execution:diagnose_agenda',
    tags: ['execution', 'action', targetTag], criterion: 'execution', sourceRefs: [`action:${executionId}`], observedAt: ts });
  if (!brainDir || !decision || typeof agentName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(agentName)) {
    throw new Error('runtime inspection provenance unavailable; inspection not attempted');
  }
  const receipt = { event_id: `inspection-intent:${executionId}`, event_type: 'AgendaInspectionIntent', payload: {},
    stage: 'execute', phase: 'intent', executionId, action: 'diagnose_agenda', target, agendaId,
    learningVersion: 2, outcomeCriterion: 'execution', outcomeTrialId: `action:${executionId}`,
    executionAttempted: false, executionContext: { targetTag, optionalAuto,
      origin: optionalAuto ? 'background-cognitive-cycle' : ownerRequested ? 'owner-request' : criticalRecovery ? 'critical-recovery' : 'direct' },
    learningDecisionEvent: { event_id: crypto.randomUUID(), event_type: 'LearningDecisionObserved',
      session_id: `action:${executionId}`, object_id: executionId, actor: 'engine-inspection-dispatcher',
      timestamp: ts, ts, payload: { ...decision, learningVersion: 2 } },
    runtimeInspection: { problemId, agentName, chatId: `inspection:${problemId}`,
      conversationsDir: path.resolve(conversationsDir || process.env.HOME23_CONVERSATIONS_DIR || path.join(brainDir, '..', 'conversations')) },
    source: 'bounded_agenda_inspection', reason: intent.question, ts, timestamp: ts };
  const projection = appendInspectionReceipt(brainDir, receipt, true);
  const notAttempted = (detail, learning = null) => {
    appendInspectionReceipt(brainDir, { ...receipt, event_id: `inspection-outcome:${executionId}`,
      event_type: 'AgendaInspectionOutcome', phase: 'outcome', status: 'not_attempted',
      executionAttempted: false, detail, ...(learning ? { learning } : {}) });
    return { admitted: false, receipt, status: 'not_attempted', detail, learning };
  };
  if (optionalAuto && projection.pendingBytes > 0) return notAttempted('inspection decision witness projection is pending; no inspection dispatched');
  let learning = null;
  if (optionalAuto) {
    let snapshot;
    try { snapshot = typeof readLearning === 'function' ? readLearning()
      : readSeedLearning(path.join(workspaceDir || path.join(brainDir, '..', 'workspace'), '..', 'substrate', 'seed-01')); }
    catch { snapshot = null; }
    learning = evaluateLearnedDecision(snapshot, { scope: decision.scope, tags: decision.tags, requiredTags: [targetTag] });
    if (learning.suppress) return notAttempted('optional inspection deferred by target-specific execution learning; no inspection dispatched', learning);
  }
  return { admitted: true, receipt, learning };
}

function validInspectionCompletion(problem, reported, { expectedToken, authorization } = {}) {
  if (typeof expectedToken !== 'string' || Buffer.byteLength(expectedToken) < 32
    || typeof authorization !== 'string') return false;
  const expected = Buffer.from(`Bearer ${expectedToken}`), provided = Buffer.from(authorization);
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return false;
  const original = problem?.inspectionExecution?.receipt;
  const expectedTurn = problem?.dispatchedTurnId || problem?.inspectionExecution?.turnId;
  const identityMatches = !!original && original.learningVersion === 2 && original.action === 'diagnose_agenda'
    && reported?.inspectionExecutionId === original.executionId
    && reported.inspectionCompletionSource === 'agent-loop-terminal'
    && ['completed', 'failed'].includes(reported.executionStatus)
    && typeof expectedTurn === 'string' && expectedTurn === reported.turnId;
  if (!identityMatches) return false;
  const native = readInspectionTerminal(problem);
  return !!native && reported.executionStatus === (native.status === 'success' ? 'completed' : 'failed');
}

/** Read only the native journal for this exact dispatch. A reported completion
 * or model trailer alone is never enough to teach execution reliability. */
function readInspectionTerminal(problem) {
  const container = problem?.inspectionExecution, receipt = container?.receipt;
  const runtime = receipt?.runtimeInspection;
  const turnId = problem?.dispatchedTurnId || container?.turnId;
  if (!runtime || runtime.problemId !== problem.id || container.executionId !== receipt.executionId
    || receipt.learningVersion !== 2 || receipt.action !== 'diagnose_agenda'
    || typeof turnId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(turnId)
    || typeof runtime.agentName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runtime.agentName)) return null;
  const chatId = `inspection:${problem.id}`;
  if (runtime.chatId !== chatId) return null;
  const file = path.join(runtime.conversationsDir, `${runtime.agentName}__${chatId.replace(/[^a-zA-Z0-9_-]/g, '_')}.jsonl`);
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024 || stat.size < 1) return null;
    const raw = fs.readFileSync(fd, 'utf8');
    const complete = raw.slice(0, raw.lastIndexOf('\n') + 1);
    const records = complete.split('\n').filter(Boolean).map(JSON.parse).filter(row => row.turn_id === turnId
      && (row.type === 'event' || row.chat_id === chatId));
    const starts = records.filter(row => row.type === 'turn' && row.status === 'pending');
    const ends = records.filter(row => row.type === 'turn' && row.status !== 'pending');
    if (starts.length !== 1 || ends.length !== 1) return null;
    const start = starts[0], end = ends[0];
    if (!Number.isFinite(Date.parse(start.started_at)) || !Number.isFinite(Date.parse(end.ended_at))
      || Date.parse(start.started_at) < Date.parse(receipt.ts) || Date.parse(end.ended_at) < Date.parse(start.started_at)) return null;
    const authorityRefused = records.some(row => {
      if (row.type !== 'event' || row.kind !== 'tool_result' || row.data?.success !== false) return false;
      try { return JSON.parse(row.data.exactResult).code === 'inspection_authority_refused'; }
      catch { return false; }
    });
    const status = end.status === 'complete' && !authorityRefused ? 'success'
      : ['complete', 'error', 'cancelled', 'timeout', 'orphaned', 'interrupted', 'stopped', 'failed'].includes(end.status) ? 'failed' : null;
    if (!status) return null;
    const identity = { start, end, authorityRefused };
    return { status, turnId, endedAt: end.ended_at, journalPath: file,
      terminalDigest: crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex'), authorityRefused };
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function projectInspectionTerminal(brainDir, problem) {
  if (!problem?.inspection || !problem?.inspectionExecution?.receipt) return false;
  const terminal = readInspectionTerminal(problem);
  if (!terminal) return false;
  const original = problem.inspectionExecution.receipt;
  const outcome = { ...original, event_id: `inspection-outcome:${original.executionId}`, event_type: 'AgendaInspectionOutcome',
    phase: 'outcome', status: terminal.status, executionAttempted: true,
    detail: terminal.status === 'success' ? 'native inspection turn completed; requested finding remains separately evidenced'
      : terminal.authorityRefused ? 'native inspection turn attempted an unavailable capability; authority refused'
        : 'native inspection turn ended unsuccessfully; no task accomplishment inferred',
    canonicalExecution: terminal, source: 'agent-loop-native-terminal', ts: terminal.endedAt, timestamp: terminal.endedAt };
  const projection = appendInspectionReceipt(brainDir, outcome);
  if (projection.pendingBytes > 0) return false;
  const changed = problem.inspectionExecution.terminalDigest !== terminal.terminalDigest;
  problem.inspectionExecution.turnId = terminal.turnId;
  problem.inspectionExecution.terminalDigest = terminal.terminalDigest;
  return changed;
}

module.exports = { prepareAgendaInspection, validInspectionCompletion, readInspectionTerminal, projectInspectionTerminal };
