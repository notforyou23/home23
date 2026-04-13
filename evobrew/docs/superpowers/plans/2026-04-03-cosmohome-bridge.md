# Cosmohome Evobrew Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `POST /api/chat` and `GET /health` routes to cosmohome2.3 agents so evobrew can dispatch to them as local providers.

**Architecture:** New `src/routes/evobrew-bridge.ts` exports a route handler factory. The WebhookServer gets a `getApp()` method to expose its Express instance. `home.ts` registers the bridge routes after the WebhookServer is created, passing in the Anthropic client and ContextManager.

**Tech Stack:** Anthropic SDK streaming (`messages.stream()`), Express, SSE.

**Target codebase:** `/Users/jtr/_JTR23_/cosmo-home_2.3/`

---

### Task 1: Create the evobrew bridge route handler

**Files:**
- Create: `src/routes/evobrew-bridge.ts`

- [ ] **Step 1: Create the bridge module**

Create `/Users/jtr/_JTR23_/cosmo-home_2.3/src/routes/evobrew-bridge.ts`:

```typescript
/**
 * Evobrew Bridge — SSE streaming route for evobrew local agent integration.
 *
 * Accepts evobrew's request format (messages, tools, systemPrompt),
 * merges with agent identity, calls Anthropic SDK with streaming,
 * translates stream events into UnifiedChunk SSE format.
 *
 * Does NOT execute tools — evobrew handles tool execution.
 */

import type { Request, Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import type { ContextManager } from '../agent/context.js';

export interface BridgeConfig {
  client: Anthropic;
  contextManager: ContextManager;
  defaultModel: string;
  token: string;
  agentName: string;
}

function writeSse(res: Response, data: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function createEvobrewChatHandler(config: BridgeConfig) {
  return async (req: Request, res: Response): Promise<void> => {
    // Auth
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${config.token}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { messages, tools, systemPrompt, model, maxTokens, temperature } = req.body ?? {};

    if (!messages || !Array.isArray(messages)) {
      res.status(400).json({ error: 'messages array required' });
      return;
    }

    // Merge system prompts: evobrew IDE context + agent identity
    const agentIdentity = config.contextManager.getSystemPrompt();
    const mergedSystem = systemPrompt
      ? `${systemPrompt}\n\n---\n\nAgent Identity (${config.agentName}):\n${agentIdentity}`
      : agentIdentity;

    // Resolve model — use request model if it's a real model name, otherwise agent default
    const effectiveModel = (model && !model.startsWith('local:'))
      ? model
      : config.defaultModel;

    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Track current tool block for tool_use_end
    let currentToolId: string | null = null;

    try {
      const stream = config.client.messages.stream({
        model: effectiveModel,
        system: mergedSystem,
        messages: messages as Anthropic.MessageParam[],
        tools: (tools || []) as Anthropic.Tool[],
        max_tokens: maxTokens || 64000,
        temperature: temperature ?? 0.7,
      });

      // Handle client disconnect
      const onClose = () => { stream.abort(); };
      req.on('close', onClose);

      for await (const event of stream) {
        switch (event.type) {
          case 'content_block_start': {
            const block = event.content_block;
            if (block.type === 'tool_use') {
              currentToolId = block.id;
              writeSse(res, {
                type: 'tool_use_start',
                toolId: block.id,
                toolName: block.name,
              });
            }
            // text blocks: wait for deltas
            break;
          }

          case 'content_block_delta': {
            const delta = event.delta;
            if (delta.type === 'text_delta') {
              writeSse(res, { type: 'text', text: delta.text });
            } else if (delta.type === 'input_json_delta') {
              writeSse(res, {
                type: 'tool_use_delta',
                toolId: currentToolId,
                argumentsDelta: delta.partial_json,
              });
            }
            break;
          }

          case 'content_block_stop': {
            if (currentToolId) {
              writeSse(res, { type: 'tool_use_end', toolId: currentToolId });
              currentToolId = null;
            }
            break;
          }

          case 'message_stop': {
            // Get the final message to determine stop reason
            const finalMessage = await stream.finalMessage();
            writeSse(res, {
              type: 'done',
              stopReason: finalMessage.stop_reason === 'tool_use' ? 'tool_use' : 'end_turn',
            });
            break;
          }
        }
      }

      req.removeListener('close', onClose);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[evobrew-bridge] Stream error:`, message);
      writeSse(res, { type: 'done', stopReason: 'error', error: message });
    }

    res.end();
  };
}

export function createHealthHandler(config: { agentName: string }) {
  return (_req: Request, res: Response): void => {
    res.json({ status: 'ok', agent: config.agentName });
  };
}
```

- [ ] **Step 2: Syntax check**

```bash
cd /Users/jtr/_JTR23_/cosmo-home_2.3 && npx tsc --noEmit src/routes/evobrew-bridge.ts 2>&1 || echo "Check for errors"
```

Note: This may show import errors since the file isn't wired in yet. The important thing is no syntax errors in the file itself. A simpler check:

```bash
node -e "require('typescript').transpileModule(require('fs').readFileSync('src/routes/evobrew-bridge.ts','utf8'), {compilerOptions:{module:99,target:99,esModuleInterop:true}}); console.log('OK')"
```

- [ ] **Step 3: Commit**

```bash
git add src/routes/evobrew-bridge.ts
git commit -m "feat: add evobrew bridge route handler"
```

---

### Task 2: Expose Express app from WebhookServer and register bridge routes

**Files:**
- Modify: `src/channels/webhooks.ts:58-63` (add getApp method)
- Modify: `src/home.ts:383-402` (register bridge routes after WebhookServer creation)

- [ ] **Step 1: Add getApp() to WebhookServer**

In `/Users/jtr/_JTR23_/cosmo-home_2.3/src/channels/webhooks.ts`, add a public method after the constructor (after line 73):

```typescript
  /** Expose Express app for adding external routes */
  getApp(): Application | null {
    return this.app;
  }
```

- [ ] **Step 2: Register bridge routes in home.ts**

In `/Users/jtr/_JTR23_/cosmo-home_2.3/src/home.ts`, add the import at the top (with the other imports):

```typescript
import { createEvobrewChatHandler, createHealthHandler } from './routes/evobrew-bridge.js';
```

Then, after the WebhookServer is created and registered (after line 402, after `enabledAdapters.push('webhook');`), add:

```typescript
    // Register evobrew bridge routes on the webhook server's Express app
    const webhookApp = adapter.getApp();
    if (webhookApp) {
      const bridgeConfig = {
        client: agent.getClient(),
        contextManager,
        defaultModel: agent.getModel(),
        token: wc.token,
        agentName: COSMO_INSTANCE,
      };
      webhookApp.post('/api/chat', createEvobrewChatHandler(bridgeConfig));
      webhookApp.get('/health', createHealthHandler({ agentName: COSMO_INSTANCE }));
      console.log(`[home] Evobrew bridge registered on webhook server (/api/chat, /health)`);
    }
```

IMPORTANT: The `agent` variable must be accessible at this point. Check that the `agent` variable (created at line 246) is in scope at line 402. It should be — both are in the same `main()` function scope.

Also verify that `COSMO_INSTANCE` is available — it should be defined earlier in the file as the instance name (e.g., "coz", "edison").

- [ ] **Step 3: Build the TypeScript**

```bash
cd /Users/jtr/_JTR23_/cosmo-home_2.3 && npx tsc
```

Expected: Clean build with no errors.

- [ ] **Step 4: Commit**

```bash
git add src/channels/webhooks.ts src/home.ts
git commit -m "feat: register evobrew bridge on webhook server"
```

---

### Task 3: Test end-to-end with evobrew

- [ ] **Step 1: Restart the cosmohome agent**

```bash
cd /Users/jtr/_JTR23_/cosmo-home_2.3 && pm2 restart cosmo23-coz
```

- [ ] **Step 2: Test health endpoint**

```bash
curl http://localhost:4611/health
```

Expected: `{"status":"ok","agent":"coz"}`

- [ ] **Step 3: Test bridge with a simple message**

```bash
curl -X POST http://localhost:4611/api/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(node -e "const c=require('./config/coz.yaml');console.log(c)" 2>/dev/null || echo 'TOKEN')" \
  -d '{"messages":[{"role":"user","content":"Say hello in one word"}],"tools":[],"maxTokens":100,"temperature":0.1}'
```

Expected: SSE stream with `data: {"type":"text","text":"Hello"}` and `data: {"type":"done","stopReason":"end_turn"}`.

Note: You may need to find the correct token from the config. Check `config/coz.yaml` or the running config for the webhook token.

- [ ] **Step 4: Configure evobrew to use the agent**

Add to `~/.evobrew/config.json` (manually or via `evobrew setup`):

```json
{
  "providers": {
    "local_agents": [
      {
        "name": "COZ",
        "id": "coz",
        "url": "http://localhost:4611",
        "endpoint": "/api/chat",
        "enabled": true
      }
    ]
  }
}
```

- [ ] **Step 5: Test from evobrew UI**

1. Start evobrew: `./bin/evobrew start`
2. Open in browser
3. Open model picker — verify "COZ" appears under "Local Agents"
4. Select COZ
5. Send a message
6. Verify response streams back

- [ ] **Step 6: Test tool calling**

With COZ selected in evobrew:
1. Ask "Read the file package.json in this folder"
2. Verify evobrew's tool loop executes `file_read`
3. Verify the result is sent back to COZ
4. Verify COZ responds with the file contents

- [ ] **Step 7: Commit any fixes**

```bash
git add -A && git commit -m "feat: evobrew bridge — tested and working"
```
