# Local Agent Onboarding — Design Spec

**Date:** 2026-04-03
**Scope:** Register local agents as first-class providers in evobrew's model picker

## Summary

Evobrew currently supports cloud providers (Anthropic, OpenAI, xAI, Ollama Cloud) and local model servers (Ollama, LMStudio). OpenClaw/COZ exists as a virtual provider with no real adapter — it's handled entirely in the frontend via WebSocket.

This spec adds a `LocalAgentAdapter` that lets any local agent (running on the same machine or reachable via network) show up in the model picker and participate in evobrew's agentic loop. The agent provides the "brain" (LLM reasoning), evobrew provides the "hands" (tool execution, file ops, terminal, brain search).

The primary targets are the cosmohome2.3 agents (COZ, Edison, Tick, Althea, Terrapin) which already run as PM2 processes with HTTP endpoints and use Anthropic-style tool calling.

## Protocol Contract

### Request (evobrew -> agent)

```
POST {agent.url}{agent.endpoint}
Content-Type: application/json

{
  "messages": [
    { "role": "system", "content": "You are an AI assistant..." },
    { "role": "user", "content": "Read the file at /src/index.js" },
    { "role": "assistant", "content": null, "tool_calls": [...] },
    { "role": "tool", "tool_use_id": "t1", "content": "file contents..." }
  ],
  "tools": [
    {
      "name": "file_read",
      "description": "Read contents of a file",
      "input_schema": {
        "type": "object",
        "properties": { "file_path": { "type": "string" } },
        "required": ["file_path"]
      }
    }
  ],
  "model": "coz",
  "maxTokens": 64000,
  "temperature": 0.1,
  "systemPrompt": "..."
}
```

Messages use the Anthropic SDK format (role: user/assistant/tool, tool_use blocks, tool_result blocks). This is what cosmohome agents already use internally.

Tools are provided in JSON Schema format — the same definitions evobrew sends to Claude/GPT.

### Response (agent -> evobrew)

SSE stream with `data:` prefixed JSON lines:

```
data: {"type": "text", "text": "Let me read that file."}
data: {"type": "tool_use_start", "toolId": "t1", "toolName": "file_read"}
data: {"type": "tool_use_delta", "toolId": "t1", "argumentsDelta": "{\"file_path\": \"/src/index.js\"}"}
data: {"type": "tool_use_end", "toolId": "t1"}
data: {"type": "done", "stopReason": "tool_use"}
```

Chunk types match `UnifiedChunk` from `server/providers/types/unified.js`:

| type | fields | meaning |
|------|--------|---------|
| `text` | `text` | Text content delta |
| `tool_use_start` | `toolId`, `toolName` | Start of a tool call |
| `tool_use_delta` | `toolId`, `argumentsDelta` | Partial JSON arguments |
| `tool_use_end` | `toolId` | Tool call arguments complete |
| `thinking` | `text` | Reasoning/thinking content (optional) |
| `done` | `stopReason` | Stream complete. `stopReason`: `"end_turn"` or `"tool_use"` |

When `stopReason` is `"tool_use"`, evobrew executes the requested tools and sends a new request with the tool results appended to the messages array. This loops until the agent returns `stopReason: "end_turn"`.

### Error responses

Non-2xx status codes with JSON body:
```json
{ "error": "message", "type": "auth_error" | "rate_limit" | "server_error" }
```

## Backend Changes

### New file: `server/providers/adapters/local-agent.js`

Implements `ProviderAdapter` from `server/providers/adapters/base.js`.

```
class LocalAgentAdapter extends ProviderAdapter {
  constructor({ id, name, url, endpoint, capabilities, apiKey })

  get id()            // e.g., "local:coz"
  get name()          // e.g., "COZ"
  get capabilities()  // from config, defaults: { tools: true, streaming: true, vision: false }

  getAvailableModels()  // returns [this.id]
  supportsModel(id)     // id === this.id

  async *streamMessage(request)  // POST to agent, parse SSE, yield UnifiedChunks
  convertTools(tools)            // pass through (agents accept JSON Schema)
  parseToolCalls(response)       // extract from accumulated chunks
}
```

Key implementation detail for `streamMessage()`:
- POST to `{url}{endpoint}` with the request body
- Set `Accept: text/event-stream` header
- If `apiKey` is configured, send `Authorization: Bearer {apiKey}`
- Read the response as a stream, parse SSE `data:` lines, yield `UnifiedChunk` objects
- On connection error, throw with `type: 'connection_error'` so the handler can show a meaningful message ("Agent at localhost:4611 is not reachable")

### Edit: `server/providers/index.js`

In `createRegistry()`, after existing provider init blocks:

```js
// Local agents
const localAgents = evobrewConfig?.providers?.local_agents || [];
for (const agent of localAgents) {
  if (!agent.enabled) continue;
  const agentId = `local:${agent.id}`;
  try {
    registry.initializeProvider(agentId, {
      id: agentId,
      name: agent.name,
      url: agent.url,
      endpoint: agent.endpoint || '/api/chat',
      capabilities: agent.capabilities || { tools: true, streaming: true, vision: false },
      apiKey: agent.api_key
    });
    console.log(`[Providers] Local agent registered: ${agent.name} (${agentId})`);
  } catch (err) {
    console.warn(`[Providers] Failed to register local agent ${agent.name}:`, err.message);
  }
}
```

### Edit: `server/providers/registry.js`

1. Register `local-agent` factory in `_registerBuiltinFactories()`:
```js
this.adapterFactories.set('local-agent', (config) => new LocalAgentAdapter(config));
```

2. In `parseProviderId()`, add `local:` prefix detection:
```js
if (modelId.startsWith('local:')) return modelId;  // full ID is the provider ID
```

3. In `initializeProvider()`, route `local:*` IDs to the `local-agent` factory by checking `if (providerId.startsWith('local:'))` before the existing factory lookup, and using `this.adapterFactories.get('local-agent')` to create the adapter.

### Edit: `server/ai-handler.js`

In the main dispatch loop inside `handleFunctionCalling()`, add a local agent branch:

```js
const isLocalAgent = providerId?.startsWith('local:');

// ... in the dispatch section:
} else if (isLocalAgent) {
  const agentProvider = provider || registry?.getProviderById(providerId);
  if (!agentProvider) {
    throw new Error(`Local agent "${providerId}" not registered. Check config.`);
  }
  // Use the same streaming pattern as Ollama:
  const stream = agentProvider.streamMessage({
    model: effectiveModel,
    messages: trimmedMessages,
    tools: availableTools,
    temperature,
    maxTokens,
    systemPrompt
  });
  // Process chunks same as other providers...
}
```

The tool execution loop after this branch is the same as existing providers — `ToolExecutor` runs the tools, results are appended to messages, next iteration starts.

### Edit: `server/server.js`

In `GET /api/providers/models` (~line 3139), local agents are picked up automatically from the registry — they return their model ID from `getAvailableModels()`. They should appear under a "Local Agents" group label. Add grouping logic:

```js
// After collecting all models from registry:
for (const [providerId, provider] of registry.providers) {
  if (providerId.startsWith('local:')) {
    // Group under "Local Agents"
    models.push({
      id: providerId,
      provider: providerId,
      value: qualifyModelSelection(providerId, providerId),
      label: provider.name,
      group: 'Local Agents'
    });
  }
}
```

### Edit: `lib/setup-wizard.js`

Add a "Local Agents" step after existing provider steps:

1. Ask: "Do you have local agents to connect? (y/n)"
2. If yes, loop: prompt for name, URL (default: `http://localhost:`), endpoint (default: `/api/chat`)
3. Test connectivity: `GET {url}/health` or `POST {url}{endpoint}` with empty messages
4. Save to `config.providers.local_agents[]`

## Config Shape

In `~/.evobrew/config.json`:

```json
{
  "providers": {
    "local_agents": [
      {
        "name": "COZ",
        "id": "coz",
        "url": "http://localhost:4611",
        "endpoint": "/api/chat",
        "capabilities": { "tools": true, "vision": false, "streaming": true },
        "enabled": true
      },
      {
        "name": "Edison",
        "id": "edison",
        "url": "http://localhost:4612",
        "endpoint": "/api/chat",
        "enabled": true
      },
      {
        "name": "Tick",
        "id": "tick",
        "url": "http://localhost:4613",
        "endpoint": "/api/chat",
        "capabilities": { "tools": true, "vision": false, "streaming": true },
        "enabled": true
      }
    ]
  }
}
```

## Agent-Side Bridge (cosmohome2.3)

Each cosmohome agent needs a new route. This is outside evobrew's codebase but part of the integration story:

```
POST /api/chat
```

This route:
1. Accepts the evobrew request format (messages, tools, systemPrompt)
2. Merges evobrew's system prompt with the agent's identity context (SOUL.md, MISSION.md, etc.)
3. Calls the agent's LLM (via the existing agent loop's model routing)
4. Streams the response back as SSE in UnifiedChunk format

This is ~100-150 lines in the cosmohome bridge layer (`src/home.ts` or a new `src/routes/evobrew-bridge.ts`).

## What this does NOT include

- **WebSocket mode** — HTTP+SSE covers all use cases for now. Can add later.
- **Auto-discovery** — Agents must be explicitly configured. No mDNS/broadcast scanning.
- **Agent-side tools** — The agent uses evobrew's tools only. Its own tools (brain_search, web_browse, etc.) are not exposed to evobrew. This keeps the security model simple.
- **Hermes agent integration** — Separate future effort. Once the local agent pattern works, Hermes could be onboarded as another local agent.
- **In-app agent configuration UI** — Config via wizard or manual edit only for v1.
- **OpenClaw migration** — OpenClaw stays as-is (virtual provider with frontend WebSocket). Could be migrated to this adapter pattern later.
