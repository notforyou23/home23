'use strict';

const { parseWithFallback } = require('../core/json-repair');

/**
 * MotorCortex turns critic-kept agenda records into bounded engine actions.
 *
 * This is intentionally not a raw shell/file layer. It routes through the
 * orchestrator's named agenda executor, which already fans into ACT or the
 * live-problems diagnostic path. The point is continuity: think -> agenda ->
 * act -> audit, without giving background cognition ungated hands.
 */
class MotorCortex {
  constructor(opts = {}) {
    this.executeAgendaItem = typeof opts.executeAgendaItem === 'function' ? opts.executeAgendaItem : null;
    this.canAct = typeof opts.canAct === 'function' ? opts.canAct : (() => true);
    this.agendaStore = opts.agendaStore || null;
    this.logger = opts.logger || console;
    this.enabled = opts.enabled !== false;
  }

  compileMotorIntents(args = {}) {
    const verdict = args.finalVerdict || args.verdict || {};
    const thoughtText = String(args.thought?.text || args.thoughtText || '').trim();
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
      const normalized = this._normalizeCandidate(item);
      if (!normalized) return;
      const key = this._candidateKey(normalized.content);
      if (seen.has(key)) return;
      seen.add(key);
      decisions.push({
        status: 'rejected',
        source,
        content: normalized.content,
        detail,
      });
    };

    for (const item of Array.isArray(verdict.agendaCandidates) ? verdict.agendaCandidates : []) {
      const normalized = this._normalizeCandidate(item);
      if (!normalized) continue;
      if (this.canAct(normalized, args)) addAccepted('critique_agenda', normalized);
      else addRejected('critique_agenda', normalized, 'agenda item failed motor policy');
    }

    const rawAgenda = this._rawAgendaCandidates(verdict.raw);
    for (const item of rawAgenda) {
      addRejected('critique_raw_agenda', item, 'critique agenda filter rejected this candidate before motor routing');
    }

    if (accepted.length === 0) {
      for (const item of this._extractThoughtCandidates(thoughtText)) {
        const normalized = this._normalizeCandidate(item);
        if (!normalized) continue;
        if (this.canAct(normalized, args)) addAccepted('thought_text', normalized);
        else addRejected('thought_text', normalized, 'thought text did not compile to a bounded motor action');
      }
    }

    if (accepted.length === 0 && decisions.length === 0) {
      decisions.push({
        status: 'no_action',
        source: 'motor_compiler',
        content: null,
        detail: 'kept thought contained no bounded motor intent',
      });
    }

    return { accepted, decisions };
  }

  async actOnAgendaItem(item, context = {}) {
    const agendaId = item?.id || null;
    const content = String(item?.content || '').trim();
    const actor = context.actor || 'motor-cortex';

    if (!this.enabled) {
      return this._result('skipped', agendaId, 'motor cortex disabled');
    }
    if (!agendaId || !content) {
      return this._result('rejected', agendaId, 'agenda item with id and content required');
    }
    if (!this.executeAgendaItem) {
      return this._result('rejected', agendaId, 'no bounded agenda executor configured');
    }
    if (!this.canAct(item, context)) {
      return this._result('rejected', agendaId, 'agenda item failed motor policy');
    }

    try {
      const action = await this.executeAgendaItem(item, {
        ...context,
        actor,
        origin: 'thinking-machine',
      });
      const acted = Boolean(action?.directAction || action?.problemId || action?.action);
      if (acted && this.agendaStore?.updateStatus) {
        this.agendaStore.updateStatus(agendaId, 'acted_on', {
          actor,
          note: action.detail || action.status || action.action || 'motor action routed',
        });
      }
      this.logger.info?.('[motor-cortex] agenda action routed', {
        agendaId,
        action: action?.action || null,
        target: action?.target || action?.problemId || null,
        status: action?.status || null,
      });
      return {
        status: acted ? 'acted' : 'no_action',
        agendaId,
        action: action || null,
      };
    } catch (error) {
      this.logger.warn?.('[motor-cortex] agenda action failed', {
        agendaId,
        error: error?.message || String(error),
      });
      return this._result('failed', agendaId, error?.message || String(error));
    }
  }

  _result(status, agendaId, detail) {
    return { status, agendaId, detail };
  }

  _normalizeCandidate(item) {
    if (!item || typeof item !== 'object') return null;
    const content = String(item.content || '').trim();
    if (!content) return null;
    return {
      content,
      kind: ['decision', 'question', 'idea'].includes(item.kind) ? item.kind : 'idea',
      topicTags: Array.isArray(item.topicTags) ? item.topicTags.filter(t => typeof t === 'string') : [],
    };
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

  _extractThoughtCandidates(text) {
    if (!text) return [];
    const actionish = /\b(fix|resolve|verify|investigate|check|audit|restore|re-trigger|retrigger|re-enable|reenable|update|implement|diagnose|execute|determine|compare|correlate|compile|write|produce|generate)\b/i;
    const concrete = /(?:api\b|endpoint\b|dashboard\b|shortcut\b|health\b|sauna\b|pressure\b|sensor\b|bridge\b|pipeline\b|correlation\b|cron\b|pm2\b|process\b|syntaxerror\b|log\b|config\b|workflow\b|harness\b|chrome cdp\b|disk\b|port\b|recent\.md\b|heartbeat\.md\b|run-intraday-review\.js\b|brain-housekeeping\b|node count\b|regression\b|hrv\b|vo2\b|heart rate\b|wrist temp\b|sleep\b|run\b|gpx\b|route\b|artifact\b|report\b|document\b)/i;
    const chunks = text
      .replace(/\n+/g, ' ')
      .split(/(?<=[.!?])\s+/)
      .map(s => s.trim())
      .filter(Boolean);
    const candidates = [];
    for (const chunk of chunks) {
      if (!actionish.test(chunk) || !concrete.test(chunk)) continue;
      candidates.push({
        content: chunk.length > 320 ? `${chunk.slice(0, 317)}...` : chunk,
        kind: 'idea',
        topicTags: ['motor-compiler'],
      });
      if (candidates.length >= 3) break;
    }
    return candidates;
  }
}

module.exports = { MotorCortex };
