'use strict';

/**
 * Cosmo research worker tool loop — the drill bit.
 * The model sees Cosmo tools, calls them, decides, executes, loops.
 * It is one descent of the drill, not the drill: its `finish` completes
 * this worker's phase, and the drill keeps going until cycles or time are
 * spent or the human stops it. This is not Interactive chat.
 */

const { tools, executeTool, toChatTools } = require('./tools');
const { writeBrainStream, bumpStreamEvidence } = require('./brain-stream');
const { hasPhaseWriteup } = require('../drill/writeup-gate');
const { RESEARCH_PRODUCT_LOOP } = require('../../../lib/research-launch');
const { AUTH_REVOKED_WATCH_MESSAGE, isFatalAuthError } = require('../../../lib/auth-error');

const DEFAULT_MAX_TURNS = 80;
const WRITE_NUDGE_AFTER_TURNS = 6;
const WRITE_NUDGE_TAIL_TURNS = 5;
const FORCE_FINISH_AFTER_TURNS = 8;
const DEFAULT_CALL_TIMEOUT_MS = 120000;

function writeNudgeMessage(turns, maxTurns) {
  const used = Number(turns) || 0;
  const cap = Number(maxTurns) > 0 ? Number(maxTurns) : DEFAULT_MAX_TURNS;
  const remaining = cap - used;
  if (used >= WRITE_NUDGE_AFTER_TURNS || remaining <= WRITE_NUDGE_TAIL_TURNS) {
    return 'Stop fetching. write_file a markdown writeup under outputs/, remember() the findings, then call finish. More harvest without a writeup cannot close this phase.';
  }
  return 'Continue. Use tools. Call finish when the deliverable is written.';
}

class LaunchLoop {
  constructor(options = {}) {
    this.config = options.config || {};
    this.orchestrator = options.orchestrator || null;
    this.logger = options.logger || console;
    this.client = options.client || null;
    this.plan = options.plan || null;
    // Drill context set by the DrillLoop: { cycle, goalId, goalNumber,
    // phaseNumber }. Candidates and sources journaled by this worker carry
    // this provenance.
    this.drill = options.drill || null;
    // Evidence: how much of this phase's work has reached the record —
    // thoughts, harvests, findings, writeups. Seeded by the drill from
    // earlier cycles on the same phase; the phase gate reads it.
    this.evidence = { streamed: Number(options.evidence?.streamed) || 0 };
    this.maxTurns = Number(options.maxTurns) > 0 ? Number(options.maxTurns) : DEFAULT_MAX_TURNS;
    this.messages = [];
    this.running = false;
    this.started = false;
    this.finished = false;
    this.finishSummary = null;
    this.turns = 0;
    this.productLoop = RESEARCH_PRODUCT_LOOP;
    this.fatalError = null;
    this._promise = null;
  }

  get phaseProvenance() {
    return {
      goalNumber: this.drill?.goalNumber ?? null,
      phaseNumber: this.drill?.phaseNumber ?? null
    };
  }

  hasCurrentPhaseWriteup() {
    return hasPhaseWriteup(this.runtimePath, this.phaseProvenance);
  }

  toolPolicy() {
    const remaining = this.maxTurns - this.turns;
    const writeupExists = this.hasCurrentPhaseWriteup();
    if (writeupExists && (this.turns >= FORCE_FINISH_AFTER_TURNS || remaining <= 2)) {
      return { allowedNames: ['finish'], toolChoice: 'required', stage: 'finish' };
    }
    if (!writeupExists
        && (Number(this.evidence?.streamed) || 0) > 0
        && (this.turns > WRITE_NUDGE_AFTER_TURNS || remaining <= WRITE_NUDGE_TAIL_TURNS)) {
      return { allowedNames: ['write_file'], toolChoice: 'required', stage: 'write' };
    }
    return { allowedNames: null, toolChoice: 'auto', stage: 'research' };
  }

  get runtimePath() {
    return this.orchestrator?.logsDir
      || this.orchestrator?.runtimePath
      || this.config?.logsDir
      || process.env.COSMO_RUNTIME_PATH
      || '';
  }

  start() {
    if (this.running) {
      return { started: true, reused: true, productLoop: RESEARCH_PRODUCT_LOOP };
    }
    this.running = true;
    this.started = true;
    this.finished = false;
    this.logger?.info?.('Research Launch loop starting', {
      productLoop: RESEARCH_PRODUCT_LOOP,
      goal: this.plan?.shortPlan?.goal || this.plan?.goal || this.plan?.title || null
    });
    this._promise = this.run().catch((err) => {
      if (isFatalAuthError(err)) {
        this.stopFatalAuth(err);
        return;
      }
      this.logger?.error?.('Research Launch loop failed', { error: err.message, stack: err.stack });
      this.running = false;
    });
    return { started: true, reused: false, productLoop: RESEARCH_PRODUCT_LOOP };
  }

  stop() {
    this.running = false;
    this.logger?.info?.('Research Launch loop stopped', { turns: this.turns });
  }

  markFinished(summary) {
    // Worker-level completion: this bit's phase is done. The drill decides
    // what happens next — a worker finishing is never the end of the run.
    this.finished = true;
    this.finishSummary = summary || 'done';
    this.running = false;
  }

  stopFatalAuth(detail) {
    this.running = false;
    this.fatalError = AUTH_REVOKED_WATCH_MESSAGE;
    const detailText = typeof detail === 'string'
      ? detail
      : (detail?.message || detail?.errorType || detail?.error?.message || null);
    this.logger?.error?.(AUTH_REVOKED_WATCH_MESSAGE, {
      productLoop: RESEARCH_PRODUCT_LOOP,
      errorType: 'authentication_error',
      detail: detailText,
      turns: this.turns
    });
    this.emitProgress({
      type: 'launch_loop_error',
      fatal: true,
      errorType: 'authentication_error',
      message: AUTH_REVOKED_WATCH_MESSAGE
    });
  }

  async run() {
    const short = this.plan?.shortPlan || this.plan || {};
    const goal = short.goal || this.plan?.title || 'Research the stated topic';
    const constraints = Array.isArray(short.constraints) ? short.constraints : [];
    const deliverable = short.deliverable || 'Write the research into this run and Brain.';

    this.messages = [{
      role: 'user',
      content: [
        `Goal: ${goal}`,
        constraints.length ? `Constraints:\n${constraints.map((item) => `- ${item}`).join('\n')}` : null,
        `Deliverable: ${deliverable}`,
        'Use the tools. Write findings into the Brain and artifacts into outputs/. Call finish when the deliverable is done.'
      ].filter(Boolean).join('\n\n')
    }];

    while (this.running && !this.finished && this.turns < this.maxTurns) {
      this.turns += 1;
      this.logger?.info?.('Research Launch loop turn', { turn: this.turns, maxTurns: this.maxTurns });
      this.emitProgress({ type: 'launch_loop_turn', turn: this.turns });

      const response = await this.callLLM(this.toolPolicy());
      const assistantMsg = response?.choices?.[0]?.message;
      const content = assistantMsg?.content || '';
      if (isFatalAuthError(response) || isFatalAuthError(content)) {
        this.stopFatalAuth(response || content);
        break;
      }
      if (!assistantMsg) {
        this.logger?.warn?.('Research Launch loop: empty model response', { turn: this.turns });
        continue;
      }

      const toolCalls = assistantMsg.tool_calls;
      if (toolCalls && toolCalls.length > 0) {
        this.messages.push(assistantMsg);
        // Reasoning alongside tool calls is work too — onto the tape.
        if (typeof content === 'string' && content.trim()) {
          await this.streamThought(content);
        }
        for (const toolCall of toolCalls) {
          const name = toolCall.function?.name || 'unknown';
          let parsedArgs = {};
          try {
            parsedArgs = JSON.parse(toolCall.function?.arguments || '{}');
          } catch (err) {
            parsedArgs = { _parseError: err.message, raw: toolCall.function?.arguments };
          }

          this.logger?.info?.('Research Launch tool', { turn: this.turns, tool: name });
          this.emitProgress({ type: 'launch_loop_tool', turn: this.turns, tool: name });

          const result = await executeTool(name, parsedArgs, {
            orchestrator: this.orchestrator,
            runtimePath: this.runtimePath,
            logger: this.logger,
            loop: this
          });

          this.messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: typeof result === 'string' ? result : String(result)
          });
        }
        continue;
      }

      this.messages.push({ role: 'assistant', content });
      // Nothing stays boxed in the LLM turn: the worker's thinking is part
      // of the working stream and goes into the Brain as it happens.
      await this.streamThought(content);
      this.logger?.info?.('Research Launch model turn', {
        turn: this.turns,
        chars: content.length
      });
      if (!this.finished && this.running && this.turns < this.maxTurns) {
        this.messages.push({
          role: 'user',
          content: writeNudgeMessage(this.turns, this.maxTurns)
        });
      }
    }

    this.running = false;
    this.logger?.info?.('Research Launch loop settled', {
      turns: this.turns,
      finished: this.finished,
      summary: this.finishSummary
    });
  }

  async streamThought(content) {
    const text = String(content || '').trim();
    if (!text) return;
    try {
      const result = await writeBrainStream({
        runtimePath: this.runtimePath,
        memory: this.orchestrator?.memory || null,
        logger: this.logger
      }, {
        kind: 'thought',
        content: text.slice(0, 2000),
        cycle: this.drill?.cycle ?? null,
        workerId: this.drill?.workerId ?? null,
        goalNumber: this.drill?.goalNumber ?? null,
        phaseNumber: this.drill?.phaseNumber ?? null
      });
      if (result.streamed) bumpStreamEvidence(this);
    } catch (err) {
      this.logger?.warn?.('Thought stream write failed', { error: err.message });
    }
  }

  async callLLM(policy = {}) {
    if (!this.client) {
      this.client = this.orchestrator?.coordinator?.gpt5
        || this.orchestrator?.agentExecutor?.gpt5
        || null;
    }
    if (!this.client || typeof this.client.createCompletion !== 'function') {
      throw new Error('Research Launch loop has no LLM client with createCompletion');
    }

    const model = this.config.models?.primary
      || this.config.modelAssignments?.default?.model
      || this.config.models?.fast;
    const provider = this.config.modelAssignments?.default?.provider
      || this.config.models?.primaryProvider
      || undefined;

    const requestedTimeout = Number(this.config.drill?.workerCallTimeoutMs)
      || Number(this.config.timeouts?.operationTimeoutMs)
      || DEFAULT_CALL_TIMEOUT_MS;
    const deadlineRemaining = Number(this.drill?.deadlineAt) > 0
      ? Number(this.drill.deadlineAt) - Date.now()
      : null;
    if (deadlineRemaining !== null && deadlineRemaining <= 0) {
      const error = new Error('Research drill time budget exhausted before model call');
      error.code = 'DRILL_TIME_EXHAUSTED';
      throw error;
    }
    const timeoutMs = Math.max(
      1,
      deadlineRemaining === null ? requestedTimeout : Math.min(requestedTimeout, deadlineRemaining)
    );
    let timer = null;
    const completion = this.client.createCompletion({
      model,
      provider,
      messages: [
        { role: 'system', content: this.buildSystemPrompt() },
        ...this.messages
      ],
      tools: toChatTools(policy.allowedNames),
      toolChoice: policy.toolChoice || 'auto',
      temperature: 0.4,
      maxTokens: 4000
    });
    try {
      return await Promise.race([
        completion,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error(`Research worker model call timed out after ${timeoutMs}ms`);
            error.code = 'DRILL_WORKER_TIMEOUT';
            reject(error);
          }, timeoutMs);
          timer.unref?.();
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  buildSystemPrompt() {
    const short = this.plan?.shortPlan || this.plan || {};
    const domain = short.goal
      || this.orchestrator?.config?.architecture?.roleSystem?.guidedFocus?.domain
      || 'research';
    return [
      'You are Cosmo, an autonomous research mind. This is a research RUN, not a chat.',
      `Goal: ${domain}`,
      'You have files, shell, web search, skills, a coding backend, and Brain write tools.',
      'Search is one tool, not the research: curl known URLs, hit archives and forums with run_command, use coding_run and scripts. Every successful fetch leaves a Sources receipt no matter which path it took.',
      'Nothing you do stays boxed in a turn: your thinking, fetches, and findings stream to disk and into the Brain as they happen. Hidden work is waste.',
      'Do the work. Do not ask for permission. Do not write a longer plan.',
      'Do not tell yourself to review what is already here. Query the Brain only if you need a fact.',
      short.writeupPath ? `This phase's writeup path is outputs/${short.writeupPath}.` : null,
      'Write artifacts into outputs/. Remember findings. After a handful of harvest turns, stop fetching: write_file this phase\'s markdown writeup, remember() the findings, and call finish. Another phase\'s file and tape alone cannot close this phase.'
    ].filter(Boolean).join('\n');
  }

  emitProgress(event) {
    try {
      const emitter = this.orchestrator?._getEvents?.();
      if (emitter && typeof emitter.emitEvent === 'function') {
        emitter.emitEvent(event.type, event);
      }
    } catch {
      // Watch still has engine logs even if events are unavailable.
    }
  }

  getStatus() {
    return {
      running: this.running,
      started: this.started,
      finished: this.finished,
      turns: this.turns,
      productLoop: RESEARCH_PRODUCT_LOOP,
      summary: this.finishSummary,
      fatalError: this.fatalError || null,
      status: this.fatalError ? 'error' : (this.finished ? 'finished' : (this.running ? 'running' : 'stopped'))
    };
  }
}

module.exports = {
  LaunchLoop,
  DEFAULT_MAX_TURNS,
  WRITE_NUDGE_AFTER_TURNS,
  WRITE_NUDGE_TAIL_TURNS,
  FORCE_FINISH_AFTER_TURNS,
  DEFAULT_CALL_TIMEOUT_MS,
  writeNudgeMessage,
  tools
};
