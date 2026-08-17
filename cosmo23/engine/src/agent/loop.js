'use strict';

/**
 * Cosmo research worker tool loop.
 * The model sees Cosmo tools, calls them, decides, executes, loops — the
 * proven one-agent shape. It is a WORKER inside the research ecology, not
 * the whole product: its `finish` completes this worker's mission only.
 * Workers emit candidates; they never write canonical Brain state, and a
 * worker finishing never settles the run. This is not Interactive chat.
 */

const { tools, executeTool, toChatTools } = require('./tools');
const { RESEARCH_PRODUCT_LOOP } = require('../../../lib/research-launch');
const { AUTH_REVOKED_WATCH_MESSAGE, isFatalAuthError } = require('../../../lib/auth-error');

const DEFAULT_MAX_TURNS = 80;

class LaunchLoop {
  constructor(options = {}) {
    this.config = options.config || {};
    this.orchestrator = options.orchestrator || null;
    this.logger = options.logger || console;
    this.client = options.client || null;
    this.plan = options.plan || null;
    // Expedition context set by the ecology: { id, lane, questionId }.
    // Candidates journaled by this worker carry this provenance.
    this.expedition = options.expedition || null;
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
    // Worker-level completion proposal: this worker's mission is done.
    // The ecology decides what that means; it does not settle the run and
    // it does not close the question.
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

      const response = await this.callLLM();
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
      this.logger?.info?.('Research Launch model turn', {
        turn: this.turns,
        chars: content.length
      });
      if (!this.finished && this.running && this.turns < this.maxTurns) {
        this.messages.push({
          role: 'user',
          content: 'Continue. Use tools. Call finish when the deliverable is written.'
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

  async callLLM() {
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

    return this.client.createCompletion({
      model,
      provider,
      messages: [
        { role: 'system', content: this.buildSystemPrompt() },
        ...this.messages
      ],
      tools: toChatTools(),
      temperature: 0.4,
      maxTokens: 4000
    });
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
      'Do the work. Do not ask for permission. Do not write a longer plan.',
      'Do not tell yourself to review what is already here. Query the Brain only if you need a fact.',
      'Write artifacts into outputs/. Remember findings. Call finish when the deliverable is done.'
    ].join('\n');
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

module.exports = { LaunchLoop, DEFAULT_MAX_TURNS, tools };
