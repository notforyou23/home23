'use strict';

const { parseWithFallback } = require('../core/json-repair');
const crypto = require('node:crypto');
const { hasBoundedIntent, boundedIntentForItem } = require('./bounded-intent');

function routingRecord(reasonCode, record = {}) {
  return { ...record, routingVersion: 2, routingDecisionId: `motor:${crypto.randomUUID()}`, reasonCode };
}

/**
 * MotorCortex turns critic-kept agenda records into bounded engine actions.
 *
 * Fresh cognition compiles only source-grounded, typed inspections. Previously
 * stored agenda items retain their existing direct execution policy. The
 * orchestrator and inspection consumer enforce the same read-only boundary.
 */
class MotorCortex {
  constructor(opts = {}) {
    this.executeAgendaItem = typeof opts.executeAgendaItem === 'function' ? opts.executeAgendaItem : null;
    this.canAct = typeof opts.canAct === 'function' ? opts.canAct : (() => true);
    this.agendaStore = opts.agendaStore || null;
    this.logger = opts.logger || console;
    this.enabled = opts.enabled !== false;
    // Set only by the runtime factory, never by an agenda/model payload.
    this.autonomousOptional = opts.autonomousOptional === true;
  }

  compileMotorIntents(args = {}) {
    const verdict = args.finalVerdict || args.verdict || {};
    const accepted = [];
    const decisions = [];
    const seen = new Set();

    const addAccepted = (source, item) => {
      const normalized = this._normalizeCandidate(item);
      if (!normalized) return;
      const key = this._candidateKey(normalized.content);
      if (seen.has(key)) return;
      seen.add(key);
      accepted.push({ ...normalized, source });
    };

    const addRejected = (source, item, detail) => {
      const normalized = this._normalizeCandidate(item, true);
      if (!normalized) return;
      const key = this._candidateKey(normalized.content);
      if (seen.has(key)) return;
      seen.add(key);
      decisions.push(routingRecord('policy_rejected', {
        status: 'rejected',
        source,
        content: normalized.content,
        detail,
      }));
    };

    for (const item of Array.isArray(verdict.agendaCandidates) ? verdict.agendaCandidates : []) {
      const normalized = hasBoundedIntent(item) ? this._normalizeCandidate({ ...item,
        intentEvidenceRefs: args.evidenceRefs }) : null;
      if (!normalized) { addRejected('critique_agenda', item, 'invalid bounded agenda intent'); continue; }
      if (this.canAct(normalized, args)) addAccepted('critique_agenda', normalized);
      else addRejected('critique_agenda', normalized, 'agenda item failed motor policy');
    }

    const rawAgenda = this._rawAgendaCandidates(verdict.raw);
    for (const item of rawAgenda) {
      addRejected('critique_raw_agenda', item, 'critique agenda filter rejected this candidate before motor routing');
    }

    // Raw critique and thought prose can explain a refusal, never create
    // execution authority. Explicit [] and omitted proposals remain silence.

    if (accepted.length === 0 && decisions.length === 0) {
      decisions.push(routingRecord('no_bounded_intent', {
        status: 'no_action',
        source: 'motor_compiler',
        content: null,
        detail: 'kept thought contained no bounded motor intent',
      }));
    }

    return { accepted, decisions };
  }

  async actOnAgendaItem(item, context = {}) {
    const agendaId = item?.id || null;
    const content = String(item?.content || '').trim();
    const actor = context.actor || 'motor-cortex';

    if (!this.enabled) {
      return this._result('skipped', agendaId, 'motor cortex disabled', 'disabled');
    }
    if (!agendaId || !content) {
      return this._result('rejected', agendaId, 'agenda item with id and content required');
    }
    if (!this.executeAgendaItem) {
      return this._result('rejected', agendaId, 'no bounded agenda executor configured', 'executor_unavailable');
    }
    if (!this.canAct(item, context)) {
      return this._result('rejected', agendaId, 'agenda item failed motor policy');
    }

    try {
      const action = await this.executeAgendaItem(item, {
        ...context,
        actor,
        origin: 'thinking-machine',
        autonomousOptional: this.autonomousOptional && context.ownerRequested !== true && context.criticalRecovery !== true,
      });
      const status = executionDisposition(action);
      const acted = status === 'acted' || status === 'dispatched';
      if (acted && this.agendaStore?.updateStatus) {
        this.agendaStore.updateStatus(agendaId, 'acted_on', {
          actor,
          note: status === 'dispatched' ? `Dispatched ${action.turnId}; result pending` : action.detail || action.status || action.action || 'motor action routed',
        });
      }
      this.logger.info?.('[motor-cortex] agenda action routed', {
        agendaId,
        action: action?.action || null,
        target: action?.target || action?.problemId || null,
        status: action?.status || null,
      });
      return routingRecord(({ acted: 'execution_completed', failed: 'execution_failed', no_action: 'no_bounded_intent' })[status] || status, {
        status,
        agendaId,
        action: action || null,
        turnId: action?.turnId || null,
      });
    } catch (error) {
      this.logger.warn?.('[motor-cortex] agenda action failed', {
        agendaId,
        error: error?.message || String(error),
      });
      return this._result('failed', agendaId, error?.message || String(error), 'execution_failed');
    }
  }

  _result(status, agendaId, detail, reasonCode = 'policy_rejected') {
    return routingRecord(reasonCode, { status, agendaId, detail });
  }

  _normalizeCandidate(item, rejected = false) {
    if (!item || typeof item !== 'object') return null;
    const content = String(item.content || '').trim();
    if (!content) return null;
    const normalized = {
      content,
      kind: ['decision', 'question', 'idea'].includes(item.kind) ? item.kind : 'idea',
      topicTags: Array.isArray(item.topicTags) ? item.topicTags.filter(t => typeof t === 'string') : [],
    };
    if (!hasBoundedIntent(item)) return normalized;
    const intent = boundedIntentForItem(item);
    if (!intent) return rejected ? normalized : null;
    return { ...normalized, boundedIntent: intent, intentEvidenceRefs: [...item.intentEvidenceRefs] };
  }

  _candidateKey(content) {
    return String(content || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  _rawAgendaCandidates(rawText) {
    if (!rawText || typeof rawText !== 'string') return [];
    try {
      const parsed = parseWithFallback(rawText, 'object');
      if (!Array.isArray(parsed?.agendaCandidates)) return [];
      return parsed.agendaCandidates;
    } catch {
      return [];
    }
  }

}

function executionDisposition(action) {
  if (!action) return 'no_action';
  if (['failed', 'blocked', 'rejected', 'error'].includes(action.status)) return 'failed';
  if (action.status === 'dry_run') return 'simulated';
  if (action.status === 'not_attempted') return 'not_attempted';
  if (action.action === 'diagnose_agenda') return action.turnId ? 'dispatched' : 'queued';
  return action.directAction || action.action ? 'acted' : 'no_action';
}

module.exports = { MotorCortex, executionDisposition, routingRecord };
