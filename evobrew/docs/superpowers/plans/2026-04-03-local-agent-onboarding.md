# Local Agent Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register local agents (HTTP-based, tool-calling) as first-class providers in evobrew's model picker and agentic loop.

**Architecture:** New `LocalAgentAdapter` extends `ProviderAdapter`, communicates with agents via HTTP+SSE, yields `UnifiedChunk` objects. Agents are configured in `~/.evobrew/config.json` under `providers.local_agents[]`. Each agent gets a `local:<id>` provider ID. Evobrew runs the tool loop; the agent provides LLM reasoning.

**Tech Stack:** Node.js native `fetch` (for HTTP+SSE streaming), existing provider registry, existing ProviderAdapter base class.

---

### Task 1: Create LocalAgentAdapter

**Files:**
- Create: `server/providers/adapters/local-agent.js`

- [ ] **Step 1: Create the adapter file**

Create `server/providers/adapters/local-agent.js`:

```js
/**
 * Local Agent Adapter
 *
 * Connects to a local agent process via HTTP+SSE.
 * The agent provides LLM reasoning; evobrew provides tools.
 * Protocol: POST request with messages+tools, SSE response with UnifiedChunk events.
 */

const { ProviderAdapter } = require('./base.js');
const { ErrorTypes, createError } = require('../types/unified.js');

class LocalAgentAdapter extends ProviderAdapter {
  constructor(config = {}) {
    super(config);
    this._id = config.id || 'local-agent';
    this._name = config.name || 'Local Agent';
    this._url = config.url;
    this._endpoint = config.endpoint || '/api/chat';
    this._apiKey = config.apiKey;
    this._capabilities = {
      tools: true,
      vision: false,
      thinking: false,
      streaming: true,
      caching: false,
      maxOutputTokens: config.capabilities?.maxOutputTokens || 64000,
      contextWindow: config.capabilities?.contextWindow || 128000,
      ...config.capabilities
    };
  }

  get id() { return this._id; }
  get name() { return this._name; }
  get capabilities() { return this._capabilities; }

  getAvailableModels() { return [this._id]; }

  supportsModel(modelId) {
    return modelId === this._id || modelId === this._name.toLowerCase();
  }

  _initClient() {
    // No SDK client — we use native fetch
    this._client = { url: this._url, endpoint: this._endpoint };
  }

  convertTools(tools) {
    // Pass through — agents accept JSON Schema (Anthropic format)
    return tools;
  }

  parseToolCalls(response) {
    // Tool calls are parsed from stream chunks, not from a response object
    return response?.toolCalls || [];
  }

  normalizeResponse(response) {
    return response;
  }

  async createMessage(request) {
    const chunks = [];
    for await (const chunk of this.streamMessage(request)) {
      chunks.push(chunk);
    }
    // Build response from accumulated chunks
    let text = '';
    const toolCalls = [];
    let currentTool = null;

    for (const chunk of chunks) {
      if (chunk.type === 'text' && chunk.text) text += chunk.text;
      if (chunk.type === 'tool_use_start') {
        currentTool = { id: chunk.toolId, name: chunk.toolName, arguments: '' };
      }
      if (chunk.type === 'tool_use_delta' && currentTool) {
        currentTool.arguments += chunk.argumentsDelta || '';
      }
      if (chunk.type === 'tool_use_end' && currentTool) {
        try { currentTool.arguments = JSON.parse(currentTool.arguments); } catch (_) {}
        toolCalls.push(currentTool);
        currentTool = null;
      }
    }

    return {
      content: text,
      toolCalls,
      stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 }
    };
  }

  async *streamMessage(request) {
    const url = `${this._url}${this._endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream'
    };
    if (this._apiKey) {
      headers['Authorization'] = `Bearer ${this._apiKey}`;
    }

    const body = JSON.stringify({
      messages: request.messages,
      tools: request.tools || [],
      model: request.model || this._id,
      maxTokens: request.maxTokens || 64000,
      temperature: request.temperature ?? 0.1,
      systemPrompt: request.systemPrompt || ''
    });

    let response;
    try {
      response = await fetch(url, { method: 'POST', headers, body });
    } catch (err) {
      throw createError({
        type: ErrorTypes.SERVER,
        message: `Agent "${this._name}" at ${this._url} is not reachable: ${err.message}`,
        retryable: false,
        originalError: err
      });
    }

    if (!response.ok) {
      let errorBody = '';
      try { errorBody = await response.text(); } catch (_) {}
      let errorType = ErrorTypes.SERVER;
      if (response.status === 401 || response.status === 403) errorType = ErrorTypes.AUTH;
      if (response.status === 429) errorType = ErrorTypes.RATE_LIMIT;
      throw createError({
        type: errorType,
        message: `Agent "${this._name}" returned ${response.status}: ${errorBody}`,
        retryable: errorType === ErrorTypes.RATE_LIMIT || errorType === ErrorTypes.SERVER
      });
    }

    // Parse SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // Keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue; // Skip empty lines and comments

        if (trimmed.startsWith('data: ')) {
          const data = trimmed.slice(6);
          if (data === '[DONE]') return;

          try {
            const chunk = JSON.parse(data);
            yield chunk; // Already in UnifiedChunk format
          } catch (parseErr) {
            console.warn(`[LocalAgent:${this._id}] Failed to parse SSE chunk:`, data);
          }
        }
      }
    }

    // Process any remaining buffer
    if (buffer.trim().startsWith('data: ')) {
      const data = buffer.trim().slice(6);
      if (data && data !== '[DONE]') {
        try {
          yield JSON.parse(data);
        } catch (_) {}
      }
    }
  }

  isRateLimitError(error) {
    return error?.type === ErrorTypes.RATE_LIMIT || error?.status === 429;
  }

  isServerError(error) {
    return error?.type === ErrorTypes.SERVER || (error?.status >= 500 && error?.status < 600);
  }

  isAuthError(error) {
    return error?.type === ErrorTypes.AUTH || error?.status === 401 || error?.status === 403;
  }
}

module.exports = { LocalAgentAdapter };
```

- [ ] **Step 2: Syntax check**

Run: `node --check server/providers/adapters/local-agent.js`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add server/providers/adapters/local-agent.js
git commit -m "feat: add LocalAgentAdapter for HTTP+SSE local agents"
```

---

### Task 2: Register local-agent factory in the registry

**Files:**
- Modify: `server/providers/registry.js:51-97` (_registerBuiltinFactories)
- Modify: `server/providers/registry.js:374-419` (parseProviderId)
- Modify: `server/providers/registry.js:453-457` (initializeProvider)

- [ ] **Step 1: Add the require at the top of registry.js**

At the top of `server/providers/registry.js`, after the existing adapter requires (find the existing require statements for adapters), add:

```js
const { LocalAgentAdapter } = require('./adapters/local-agent.js');
```

Note: The existing requires may be inline in the factories. Check the top of the file. If adapters are required inline in the factory functions, follow that pattern instead — require inside the factory:

```js
// In _registerBuiltinFactories(), after the ollama-cloud factory (after line ~130):
this.adapterFactories.set('local-agent', (config) => {
  const { LocalAgentAdapter } = require('./adapters/local-agent.js');
  return new LocalAgentAdapter(config);
});
```

- [ ] **Step 2: Add `local:` prefix detection to parseProviderId()**

At the top of `parseProviderId()` (line 374), before the existing heuristics, add:

```js
parseProviderId(modelId) {
    // Local agents use "local:" prefix — the full ID is the provider ID
    if (modelId.startsWith('local:')) {
      return modelId;
    }

    // Handle prefixed format: "anthropic/claude-sonnet-4"
    // ... rest of existing code
```

- [ ] **Step 3: Route `local:*` IDs in initializeProvider()**

In `initializeProvider()` at line 453, the existing code calls `this.createAdapter(providerId, config)` which calls `this.adapterFactories.get(providerId)`. For `local:coz`, there's no factory with that exact key. Add routing:

```js
initializeProvider(providerId, config) {
    // Route local:* IDs to the local-agent factory
    const factoryKey = providerId.startsWith('local:') ? 'local-agent' : providerId;
    const adapter = this.createAdapter(factoryKey, { ...config, id: providerId });
    this.register(adapter);
    return adapter;
}
```

This requires updating `createAdapter` usage or overriding. Actually, the cleaner approach: modify `createAdapter` to check for `local:` prefix:

```js
createAdapter(providerId, config) {
    const factoryKey = providerId.startsWith('local:') ? 'local-agent' : providerId;
    const factory = this.adapterFactories.get(factoryKey);
    if (!factory) {
      throw new Error(`Unknown provider: ${providerId}`);
    }
    return factory(config);
}
```

Find the existing `createAdapter` method (around line 438-445) and update it.

- [ ] **Step 4: Syntax check**

Run: `node --check server/providers/registry.js`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add server/providers/registry.js
git commit -m "feat: register local-agent factory and routing in provider registry"
```

---

### Task 3: Initialize local agents in createRegistry()

**Files:**
- Modify: `server/providers/index.js:214-228` (after Ollama, before LMStudio return)

- [ ] **Step 1: Add local agent initialization block**

After the Ollama initialization block (line 214, after `console.log('[Providers] ℹ️ Ollama disabled in config')`) and before the LMStudio block (line 216), add:

```js
  // Local Agents — HTTP-based agents configured in config.json
  const localAgents = evobrewConfig?.providers?.local_agents || [];
  for (const agent of localAgents) {
    if (agent.enabled === false) continue;
    const agentId = `local:${agent.id}`;
    try {
      registry.initializeProvider(agentId, {
        id: agentId,
        name: agent.name || agent.id,
        url: agent.url,
        endpoint: agent.endpoint || '/api/chat',
        capabilities: agent.capabilities || {},
        apiKey: agent.api_key
      });
      console.log(`[Providers] ✅ Local agent registered: ${agent.name || agent.id} (${agentId})`);
    } catch (err) {
      console.warn(`[Providers] ⚠️ Failed to register local agent ${agent.name || agent.id}:`, err.message);
    }
  }
```

- [ ] **Step 2: Syntax check**

Run: `node --check server/providers/index.js`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add server/providers/index.js
git commit -m "feat: initialize local agents from config in createRegistry"
```

---

### Task 4: Add local agent dispatch branch in ai-handler.js

**Files:**
- Modify: `server/ai-handler.js:1466-1480` (provider detection)
- Modify: `server/ai-handler.js:1860-1911` (after Ollama branch, add local agent branch)

- [ ] **Step 1: Add isLocalAgent detection**

At line 1466, after the existing provider detection flags, add:

```js
const isLocalAgent = providerId?.startsWith('local:');
```

- [ ] **Step 2: Add the local agent dispatch branch**

After the Ollama branch (line 1911, after the `} else if (isOllamaModel) {` block's closing), and before the Ollama Cloud branch, add:

```js
      } else if (isLocalAgent) {
        // ============ LOCAL AGENT (HTTP+SSE) ============
        const trimmedMessages = trimMessages(messages, 200000);

        const agentProvider = provider || registry?.getProviderById(providerId);
        if (!agentProvider) {
          throw new Error(`Local agent "${providerId}" not registered. Check config.json providers.local_agents.`);
        }

        console.log(`[AI] Calling local agent ${providerId} (${agentProvider.name})`);

        try {
          const stream = agentProvider.streamMessage({
            model: effectiveModel,
            messages: trimmedMessages,
            tools: availableTools,
            temperature: 0.7,
            maxTokens: 64000,
            systemPrompt: systemPromptText
          });

          let textContent = '';

          for await (const chunk of stream) {
            if (chunk.type === 'text' && chunk.text) {
              textContent += chunk.text;
              eventEmitter?.({ type: 'response_chunk', chunk: chunk.text });
            }
            if (chunk.type === 'content_delta' && chunk.delta?.text) {
              textContent += chunk.delta.text;
              eventEmitter?.({ type: 'response_chunk', chunk: chunk.delta.text });
            }
            if (chunk.type === 'thinking' && chunk.text) {
              eventEmitter?.({ type: 'thinking', content: chunk.text });
            }
            if (chunk.type === 'tool_use_start') {
              eventEmitter?.({ type: 'tool_preparing', toolName: chunk.toolName, toolId: chunk.toolId });
            }
            if (chunk.type === 'tool_calls' && chunk.tool_calls) {
              toolCalls = chunk.tool_calls;
            }
            // Accumulate tool calls from streaming chunks
            if (chunk.type === 'tool_use_start' || chunk.type === 'tool_use_delta' || chunk.type === 'tool_use_end') {
              // The createMessage() on the adapter accumulates these into toolCalls
              // For streaming, we need to accumulate manually
              if (chunk.type === 'tool_use_start') {
                toolCalls.push({ id: chunk.toolId, name: chunk.toolName, arguments: '' });
              }
              if (chunk.type === 'tool_use_delta' && toolCalls.length > 0) {
                toolCalls[toolCalls.length - 1].arguments += chunk.argumentsDelta || '';
              }
              if (chunk.type === 'tool_use_end' && toolCalls.length > 0) {
                const tc = toolCalls[toolCalls.length - 1];
                if (typeof tc.arguments === 'string') {
                  try { tc.arguments = JSON.parse(tc.arguments); } catch (_) {}
                }
              }
            }
            if (chunk.type === 'done') {
              // Stream finished
            }
          }

          assistantMessage = {
            content: textContent,
            tool_calls: toolCalls.length > 0 ? toolCalls : null
          };

        } catch (agentError) {
          console.error(`[AI] Local agent ${providerId} error:`, agentError.message);
          throw new Error(`Local agent error (${providerId}): ${agentError.message}`);
        }

```

- [ ] **Step 3: Syntax check**

Run: `node --check server/ai-handler.js`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add server/ai-handler.js
git commit -m "feat: add local agent dispatch branch in ai-handler"
```

---

### Task 5: Surface local agents in the model picker

**Files:**
- Modify: `server/server.js:3227-3235` (GET /api/providers/models)

- [ ] **Step 1: Add local agents to the models list**

The registry's `listModels()` may not automatically include local agents since they're registered differently. Add explicit local agent inclusion after the OpenClaw virtual provider block (line 3235):

```js
    // Add OpenClaw (COZ) as a virtual provider option
    models.push({
      id: 'openclaw:coz',
      provider: 'openclaw',
      value: qualifyModelSelection('openclaw', 'openclaw:coz'),
      label: 'COZ \u2014 Agent with Memory'
    });

    // ADD: Include local agents from registry
    const allProviders = registry.getAllProviders();
    for (const provider of allProviders) {
      if (provider.id.startsWith('local:')) {
        // Check if not already in the models list
        const alreadyListed = models.some(m => m.id === provider.id);
        if (!alreadyListed) {
          models.push({
            id: provider.id,
            provider: provider.id,
            value: qualifyModelSelection(provider.id, provider.id),
            label: provider.name,
            group: 'Local Agents'
          });
        }
      }
    }
```

- [ ] **Step 2: Syntax check**

Run: `node --check server/server.js`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add server/server.js
git commit -m "feat: surface local agents in model picker endpoint"
```

---

### Task 6: Add Local Agents step to setup wizard

**Files:**
- Modify: `lib/setup-wizard.js:930-936` (providerOptions array)

- [ ] **Step 1: Add local-agents option to the provider list**

In the `providerOptions` array at line 930, add after the `local` option:

```js
{ value: 'local-agents', label: 'Local Agents', hint: 'Connect your own agent processes (HTTP)' }
```

- [ ] **Step 2: Add the local-agents configuration handler**

Find where other providers are handled in `stepProviders()` — there are `if (provider === 'openai')`, `if (provider === 'xai')`, etc. blocks. Add a new block for `local-agents`:

```js
    if (provider === 'local-agents') {
      console.log('\n📡 Local Agent Configuration');
      console.log('Connect HTTP-based agents that speak the evobrew tool-calling protocol.\n');

      if (!config.providers) config.providers = {};
      if (!config.providers.local_agents) config.providers.local_agents = [];

      let addMore = true;
      while (addMore) {
        const name = await promptInput('Agent name (e.g., COZ, Edison): ');
        if (!name) break;

        const id = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
        const url = await promptInput(`Agent URL [http://localhost:]: `) || 'http://localhost:';
        const endpoint = await promptInput(`Chat endpoint [/api/chat]: `) || '/api/chat';

        // Test connectivity
        console.log(`  Testing ${url}${endpoint}...`);
        let testOk = false;
        try {
          const resp = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
          testOk = resp.ok;
        } catch (_) {
          try {
            const resp = await fetch(`${url}${endpoint}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ messages: [], tools: [] }),
              signal: AbortSignal.timeout(5000)
            });
            testOk = resp.status < 500;
          } catch (_) {}
        }

        if (testOk) {
          console.log('  ✅ Agent reachable');
        } else {
          console.log('  ⚠️ Agent not reachable (saving config anyway — start the agent later)');
        }

        config.providers.local_agents.push({
          name,
          id,
          url,
          endpoint,
          enabled: true
        });
        console.log(`  ✅ Saved: ${name} (local:${id})\n`);

        const more = await promptInput('Add another agent? (y/n) [n]: ');
        addMore = more.toLowerCase() === 'y';
      }

      await saveConfig(config, projectRoot);
      continue;
    }
```

- [ ] **Step 3: Syntax check**

Run: `node --check lib/setup-wizard.js`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add lib/setup-wizard.js
git commit -m "feat: add Local Agents step to setup wizard"
```

---

### Task 7: End-to-end integration test

- [ ] **Step 1: Add test config entry**

Manually add a test agent to `~/.evobrew/config.json` (or use the wizard):

```json
{
  "providers": {
    "local_agents": [
      {
        "name": "Test Agent",
        "id": "test",
        "url": "http://localhost:9999",
        "endpoint": "/api/chat",
        "enabled": true
      }
    ]
  }
}
```

- [ ] **Step 2: Create a minimal test agent**

Create a throwaway test script `scripts/test-agent-server.js`:

```js
const http = require('http');

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/chat') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write('data: {"type":"text","text":"Hello from test agent! "}\n\n');
      res.write('data: {"type":"text","text":"I received your message."}\n\n');
      res.write('data: {"type":"done","stopReason":"end_turn"}\n\n');
      res.end();
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(9999, () => console.log('Test agent listening on http://localhost:9999'));
```

- [ ] **Step 3: Run the test agent and evobrew**

Terminal 1: `node scripts/test-agent-server.js`
Terminal 2: `node server/server.js`

- [ ] **Step 4: Verify end-to-end**

1. Open the app in a browser
2. Open the model picker dropdown
3. Verify "Test Agent" appears under "Local Agents" group
4. Select "Test Agent"
5. Send a message
6. Verify the response "Hello from test agent! I received your message." streams back

- [ ] **Step 5: Test with tool calling**

Update the test agent to return a tool call:

```js
// In the POST handler, replace the response with:
res.write('data: {"type":"text","text":"Let me check that file."}\n\n');
res.write('data: {"type":"tool_use_start","toolId":"t1","toolName":"file_read"}\n\n');
res.write('data: {"type":"tool_use_delta","toolId":"t1","argumentsDelta":"{\\"file_path\\": \\"/Users/jtr/_JTR23_/evobrew/package.json\\"}"}\n\n');
res.write('data: {"type":"tool_use_end","toolId":"t1"}\n\n');
res.write('data: {"type":"done","stopReason":"tool_use"}\n\n');
```

Verify that evobrew:
1. Receives the tool call
2. Executes `file_read` on `package.json`
3. Sends the result back to the agent
4. The agent responds with the file contents

- [ ] **Step 6: Clean up test script**

Remove `scripts/test-agent-server.js` and the test config entry.

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "feat: local agent onboarding — complete integration"
```
