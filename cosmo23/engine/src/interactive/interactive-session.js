/**
 * InteractiveSession - Core session class for COSMO interactive mode
 *
 * Provides a multi-turn, tool-calling conversation loop embedded within
 * an active COSMO research run. Uses the orchestrator's LLM client
 * (UnifiedClient via createCompletion) to drive an agentic loop with
 * the tools defined in interactive-tools.js.
 *
 * Usage:
 *   const session = new InteractiveSession(config, orchestrator, logger);
 *   await session.handleMessage('What has the brain learned?', event => { ... });
 */

const crypto = require('crypto');
const { tools, executeTool } = require('./interactive-tools');

class InteractiveSession {
  constructor(config, orchestrator, logger, options = {}) {
    this.config = config;
    this.orchestrator = orchestrator;
    this.logger = logger;
    this.messages = [];
    this.sessionId = crypto.randomUUID();
    this.active = true;
    this.runtimePath = orchestrator?.runtimePath
      || orchestrator?.config?.logsDir
      || process.env.COSMO_RUNTIME_PATH
      || '';

    // Accept an explicit client, or resolve from orchestrator
    this.client = options.client
      || orchestrator?.coordinator?.gpt5
      || orchestrator?.agentExecutor?.gpt5
      || null;

    if (!this.client) {
      this.logger?.warn?.('InteractiveSession: No LLM client found — will attempt lazy resolution');
    }
  }

  /**
   * Handle an incoming user message. Runs the agentic tool-calling loop
   * until the LLM produces a final text response or the iteration limit.
   *
   * @param {string} userMessage - The user's input
   * @param {function} streamCallback - Called with event objects:
   *   { type: 'thinking' }
   *   { type: 'tool_call', name, args }
   *   { type: 'tool_result', name, result }
   *   { type: 'chunk', content }
   *   { type: 'complete', content }
   *   { type: 'error', error }
   */
  async handleMessage(userMessage, streamCallback, options = {}) {
    // Ensure we have a callback
    const emit = typeof streamCallback === 'function'
      ? streamCallback
      : () => {};

    if (!this.active) {
      emit({ type: 'error', error: 'Session is no longer active.' });
      return;
    }

    // Store per-message overrides
    this._messageModel = options.model || null;
    this._messageProvider = options.provider || null;

    // Append user message
    this.messages.push({ role: 'user', content: userMessage });
    emit({ type: 'thinking' });

    const systemPrompt = this.buildSystemPrompt();
    const maxIterations = 25;
    let iterations = 0;

    try {
      while (iterations < maxIterations) {
        iterations++;

        // Call LLM with tools
        const response = await this.callLLM(systemPrompt);

        const assistantMsg = response.choices?.[0]?.message;
        if (!assistantMsg) {
          const errMsg = 'No response from LLM.';
          this.logger?.error('InteractiveSession: ' + errMsg);
          emit({ type: 'error', error: errMsg });
          return;
        }

        // Check for tool calls
        const toolCalls = assistantMsg.tool_calls;

        if (toolCalls && toolCalls.length > 0) {
          // Add assistant message (with tool calls) to history
          this.messages.push(assistantMsg);

          // Execute each tool call
          for (const tc of toolCalls) {
            const toolName = tc.function?.name || 'unknown';
            let parsedArgs = {};
            try {
              parsedArgs = JSON.parse(tc.function?.arguments || '{}');
            } catch (parseErr) {
              this.logger?.warn('Failed to parse tool arguments', {
                tool: toolName,
                raw: tc.function?.arguments,
                error: parseErr.message
              });
            }

            emit({ type: 'tool_call', name: toolName, args: parsedArgs });

            const result = await executeTool(toolName, parsedArgs, {
              orchestrator: this.orchestrator,
              runtimePath: this.runtimePath,
              logger: this.logger
            });

            // Emit truncated result for streaming UI
            emit({
              type: 'tool_result',
              name: toolName,
              result: typeof result === 'string' ? result.substring(0, 500) : String(result).substring(0, 500)
            });

            // Add tool result to conversation
            this.messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: typeof result === 'string' ? result : String(result)
            });
          }

          // Continue loop — let LLM process tool results
          continue;
        }

        // No tool calls — this is the final text response
        const content = assistantMsg.content || '';
        emit({ type: 'chunk', content });
        emit({ type: 'complete', content });
        this.messages.push({ role: 'assistant', content });
        break;
      }

      if (iterations >= maxIterations) {
        const msg = 'Reached maximum iteration limit (25). Stopping.';
        this.logger?.warn('InteractiveSession: ' + msg);
        emit({ type: 'complete', content: msg });
        this.messages.push({ role: 'assistant', content: msg });
      }
    } catch (err) {
      this.logger?.error('InteractiveSession.handleMessage error', {
        error: err.message,
        stack: err.stack
      });
      emit({ type: 'error', error: err.message });
    }

    // Trim history to prevent unbounded growth
    if (this.messages.length > 60) {
      this.messages = this.messages.slice(-60);
    }
  }

  /**
   * Call the LLM via createCompletion (OpenAI Chat Completions-compatible).
   * This uses the same path as the IDE agent, which handles tool calling
   * properly across all providers (OpenAI, Anthropic, xAI, local, Ollama Cloud).
   *
   * @param {string} systemPrompt - System-level instructions
   * @returns {object} Chat Completions-style response: { choices: [{ message }] }
   */
  async callLLM(systemPrompt) {
    // Lazy-resolve client if not found at construction
    if (!this.client) {
      this.client = this.orchestrator.coordinator?.gpt5
        || this.orchestrator.agentExecutor?.gpt5
        || null;
    }

    if (!this.client) {
      throw new Error('No LLM client available. The orchestrator must have a coordinator or agentExecutor with a gpt5 (UnifiedClient) instance.');
    }

    const model = this._messageModel
      || this.config.interactive?.model
      || this.config.models?.primary
      || 'gpt-4.1';
    const providerOverride = this._messageProvider || null;

    // Build full message array with system prompt
    const msgs = [
      { role: 'system', content: systemPrompt },
      ...this.messages
    ];

    // Convert tool definitions to Chat Completions format
    const toolDefs = tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters
      }
    }));

    // Use createCompletion — the OpenAI Chat Completions-compatible wrapper
    // that handles Responses API translation and works across all providers.
    // This is the same method the IDE agent uses for its agentic loop.
    const response = await this.client.createCompletion({
      model,
      provider: providerOverride,
      messages: msgs,
      tools: toolDefs,
      temperature: 0.7,
      maxTokens: 4000
    });

    return response;
  }

  /**
   * Build the system prompt with live run context.
   * @returns {string}
   */
  buildSystemPrompt() {
    const o = this.orchestrator;
    const memSize = o.memory?.nodes?.size || 0;
    const edgeSize = o.memory?.edges?.size || 0;
    const cycle = o.cycleCount || 0;
    const coherence = o.executiveRing?.getCoherenceScore?.();
    const coherenceStr = typeof coherence === 'number' ? coherence.toFixed(2) : 'N/A';
    const activeAgents = o.agentExecutor?.registry?.getActiveCount?.() || 0;
    const energy = o.stateModulator?.cognitiveState?.energy;
    const energyStr = typeof energy === 'number' ? energy.toFixed(2) : 'N/A';
    const domain = o.config?.architecture?.roleSystem?.guidedFocus?.domain || 'general';
    const topic = (o.config?.architecture?.roleSystem?.guidedFocus?.context || '').substring(0, 200);

    return `You are COSMO's interactive research assistant. You are embedded within an active COSMO research run.

CURRENT RUN CONTEXT:
- Domain: ${domain}
- Topic: ${topic}
- Cycle: ${cycle}
- Memory: ${memSize} nodes, ${edgeSize} edges
- Coherence: ${coherenceStr}
- Energy: ${energyStr}
- Active agents: ${activeAgents}

You have access to tools for querying the brain's knowledge graph, reading/writing files in the run directory, running terminal commands, and spawning COSMO research agents.

GUIDELINES:
- When the user asks about the research, query the brain first using brain_query.
- When they ask to take action, use the appropriate tool.
- When they ask to investigate something new, spawn an appropriate agent type.
- Be concise and direct. Show your work — when you use tools, explain what you found.
- For multi-step tasks, use tools iteratively. Don't guess when you can look things up.
- File writes are restricted to the outputs/ directory within the run.
- Terminal commands have a 30-second timeout and dangerous commands are blocked.`;
  }

  /**
   * Stop the session and clear history.
   */
  stop() {
    this.active = false;
    this.messages = [];
    this.logger?.info('InteractiveSession stopped', { sessionId: this.sessionId });
  }

  /**
   * Get session status.
   * @returns {object}
   */
  getStatus() {
    return {
      sessionId: this.sessionId,
      active: this.active,
      messageCount: this.messages.length
    };
  }
}

module.exports = { InteractiveSession };
