# GPT-5.6 Responses Reasoning Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add strict GPT-5.6 reasoning-effort configuration and runtime controls to the Home23 TypeScript harness while preserving non-Codex provider behavior and leaving engine/feeder code unchanged.

**Architecture:** A small harness-owned effort module defines the accepted values, validation, configuration resolution, and default. Effort is carried as an explicit per-turn option, with configured chat/model/alias values resolved at the AgentLoop boundary. The Codex OAuth Responses path alone translates the resolved value to `reasoning: { effort }`; OpenAI Chat Completions payloads never receive `reasoning_effort`.

**Tech Stack:** TypeScript, Node test runner with `tsx`, js-yaml, existing Home23 AgentLoop/CommandHandler/CronScheduler architecture.

**Spec:** User request: required GPT-5.6 Responses API reasoning-effort controls in Home23.

## Global Constraints

- Accepted effort values are exactly `none|low|medium|high|xhigh|max`.
- Configured values, tool inputs, and persisted agentTurn values are strictly validated; invalid input must fail before dispatch or persistence.
- Chat default and per-model/model-alias overrides are harness configuration, not engine/feeder configuration.
- The current-chat `/effort` command supports inspect, set, and reset without an LLM round trip.
- OpenAI OAuth-backed GPT-5.6 Responses requests send `reasoning: { effort: <value> }` and never send Chat Completions `reasoning_effort`.
- Existing provider/model routing remains unchanged for non-GPT-5.6 and non-Codex paths.
- Do not modify `engine/`, `cosmo23/`, or feeder code; repository design policy scopes this feature to the harness/configuration layer.
- Preserve local runtime state and commit only public source, tests, config examples, and the implementation plan.

---

### Task 1: Define effort values and configuration resolution

**Files:**
- Create: `src/agent/reasoning-effort.ts`
- Modify: `src/types.ts`
- Modify: `src/agent/model-resolution.ts`
- Modify: `src/config.ts`
- Modify: `config/home.yaml.example`
- Modify: `cli/lib/agent-config-builder.cjs`
- Test: `tests/agent/reasoning-effort.test.ts`

**Interfaces:**
- Produces `ReasoningEffort`, `REASONING_EFFORTS`, `DEFAULT_REASONING_EFFORT`, `parseReasoningEffort`, and strict config validation helpers.
- Produces alias metadata with optional `reasoningEffort` and `resolveModelOverride()` results carrying that alias override.
- Produces `HomeConfig.chat.reasoningEffort`, `HomeConfig.models.reasoningEffort`, and alias-level `reasoningEffort` types.

- [ ] **Step 1: Write the failing tests**

```ts
test('accepts exactly the six reasoning effort values', () => {
  for (const value of ['none', 'low', 'medium', 'high', 'xhigh', 'max']) {
    assert.equal(parseReasoningEffort(value), value);
  }
  for (const value of ['', 'LOW', 'ultra', 1, null]) {
    assert.throws(() => parseReasoningEffort(value), /none, low, medium, high, xhigh, max/);
  }
});

test('model alias resolution carries an alias effort override', () => {
  assert.deepEqual(resolveModelOverride('gpt56', {
    gpt56: { provider: 'openai-codex', model: 'gpt-5.6-sol', reasoningEffort: 'xhigh' },
  }), {
    model: 'gpt-5.6-sol', provider: 'openai-codex', reasoningEffort: 'xhigh',
  });
});

test('config effort validation rejects invalid chat, model, and alias values', () => {
  assert.throws(() => validateReasoningEffortConfig({ chat: { reasoningEffort: 'ultra' } }), /chat\.reasoningEffort/);
  assert.throws(() => validateReasoningEffortConfig({ models: { reasoningEffort: { 'gpt-5.6-sol': 'ultra' } } }), /models\.reasoningEffort/);
  assert.throws(() => validateReasoningEffortConfig({ models: { aliases: { gpt56: { reasoningEffort: 'ultra' } } } }), /models\.aliases\.gpt56\.reasoningEffort/);
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --import tsx --test tests/agent/reasoning-effort.test.ts`

Expected: FAIL because the effort module and alias/config interfaces do not exist.

- [ ] **Step 3: Implement the minimal typed validator and config surface**

Use one literal tuple for the six values. Make `parseReasoningEffort(undefined)` return `undefined` for optional fields, but throw for every supplied non-string or unknown value. Validate the merged YAML object in `loadConfig()` before casting it to `HomeConfig`. Add `chat.reasoningEffort: medium` to the public example, a `models.reasoningEffort` map example, and one alias-level override; seed the same optional field shape from `buildAgentConfig()` without changing provider/model defaults.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `node --import tsx --test tests/agent/reasoning-effort.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/reasoning-effort.ts src/types.ts src/agent/model-resolution.ts src/config.ts config/home.yaml.example cli/lib/agent-config-builder.cjs tests/agent/reasoning-effort.test.ts docs/superpowers/plans/2026-08-19-gpt-5-6-reasoning-controls.md
git commit -m "feat: define reasoning effort controls"
```

### Task 2: Thread effort through turns and the GPT-5.6 Codex Responses request

**Files:**
- Modify: `src/agent/types.ts`
- Modify: `src/agent/turn-entrypoint.ts`
- Modify: `src/agent/loop.ts`
- Modify: `src/agent/text-generation.ts`
- Modify: `src/home.ts`
- Test: `tests/agent/text-generation.test.ts`
- Test: `tests/agent/chat-turn-model-override.test.ts`
- Test: `tests/agent/turn-entrypoints.test.ts`

**Interfaces:**
- `executeTrackedTurn`, `AgentLoopRunner`, and `AgentLoop.runWithTurn` accept optional `effort?: ReasoningEffort`.
- `AgentLoop` resolves explicit per-turn effort before alias/model override, then configured model/alias effort, then chat default, then `medium`.
- `AgentLoop` emits `reasoning: { effort }` only in the `openai-codex` GPT-5.6 Responses payload.
- `generateText` accepts optional `reasoningEffort` for its OAuth Codex Responses helper and uses the same GPT-5.6-only translation.

- [ ] **Step 1: Write failing request and propagation tests**

```ts
test('GPT-5.6 Codex text generation sends Responses reasoning and no Chat Completions field', async () => {
  // Capture the POST body for provider=openai-codex, model=gpt-5.6-terra,
  // reasoningEffort='xhigh'; assert body.reasoning equals { effort: 'xhigh' }
  // and Object.hasOwn(body, 'reasoning_effort') is false.
});

test('executeTrackedTurn forwards effort to runWithTurn', async () => {
  // Use the existing fake tracked agent and assert captured.effort === 'high'.
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `node --import tsx --test tests/agent/text-generation.test.ts tests/agent/chat-turn-model-override.test.ts tests/agent/turn-entrypoints.test.ts`

Expected: FAIL because turn options and the GPT-5.6 request do not yet carry effort.

- [ ] **Step 3: Implement minimal turn propagation and request translation**

Add effort to the existing option objects and runtime model context without mutating the configured AgentLoop default. Preserve `max_output_tokens`, tool conversion, streaming, and all existing provider branches. In both Codex Responses builders, conditionally spread `reasoning: { effort }` only when the model is GPT-5.6; do not add `reasoning_effort` anywhere. Pass chat/model settings from `home.ts` into the AgentLoop constructor.

- [ ] **Step 4: Run the focused tests to verify they pass**

Run: `node --import tsx --test tests/agent/text-generation.test.ts tests/agent/chat-turn-model-override.test.ts tests/agent/turn-entrypoints.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/types.ts src/agent/turn-entrypoint.ts src/agent/loop.ts src/agent/text-generation.ts src/home.ts tests/agent/text-generation.test.ts tests/agent/chat-turn-model-override.test.ts tests/agent/turn-entrypoints.test.ts
git commit -m "feat: send GPT-5.6 reasoning effort through Codex"
```

### Task 3: Add sub-agent and cron effort inputs and propagation

**Files:**
- Modify: `src/agent/tools/subagent.ts`
- Modify: `src/agent/tools/cron.ts`
- Modify: `src/scheduler/cron.ts`
- Modify: `src/home.ts`
- Test: `tests/agent/tools/subagent-isolation.test.ts`
- Test: `tests/agent/tools/cron.test.ts`
- Test: `tests/scheduler/cron.test.ts`

**Interfaces:**
- `spawn_agent` accepts `effort` from the six-value enum, validates before async-work creation, and passes it as `options.effort`.
- `cron_schedule` accepts `effort` only for `agentTurn`, stores it on `JobPayload`, and rejects invalid values before `addJob`.
- `cron_update` can set an existing agentTurn effort with the same strict validation.
- `home.ts` passes `job.payload.effort` into `executeTrackedTurn` for cron agent turns.

- [ ] **Step 1: Write failing tool and scheduler tests**

```ts
test('spawn_agent passes a valid effort to the sub-agent turn', async () => {
  // Execute with { task: '...', effort: 'high' } and assert captured.options is
  // { effort: 'high' }.
});

test('spawn_agent rejects invalid effort before claiming work', async () => {
  // Execute with effort:'ultra'; assert is_error and zero loop/work calls.
});

test('cron_schedule stores agentTurn effort and rejects invalid effort', async () => {
  // Schedule a one-shot agentTurn with effort:'xhigh'; assert payload.effort.
  // Repeat with effort:'ultra'; assert error and no scheduled job.
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `node --import tsx --test tests/agent/tools/subagent-isolation.test.ts tests/agent/tools/cron.test.ts tests/scheduler/cron.test.ts`

Expected: FAIL because the schemas, payload type, and runner options do not yet carry effort.

- [ ] **Step 3: Implement strict input validation and propagation**

Use the shared parser and enum in tool JSON schemas. Keep effort out of `exec` and `query` payloads, preserve all existing cron timeout/delivery/agency behavior, and pass the stored value only to agentTurn execution. Make malformed persisted agentTurn effort invalidate/skip the job with a clear scheduler warning rather than silently changing it.

- [ ] **Step 4: Run the focused tests to verify they pass**

Run: `node --import tsx --test tests/agent/tools/subagent-isolation.test.ts tests/agent/tools/cron.test.ts tests/scheduler/cron.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools/subagent.ts src/agent/tools/cron.ts src/scheduler/cron.ts src/home.ts tests/agent/tools/subagent-isolation.test.ts tests/agent/tools/cron.test.ts tests/scheduler/cron.test.ts
git commit -m "feat: propagate reasoning effort to background turns"
```

### Task 4: Implement live `/effort` chat control

**Files:**
- Modify: `src/commands/handler.ts`
- Modify: `src/home.ts`
- Test: `tests/commands/handler.test.ts`
- Test: `tests/agent/turn-entrypoints.test.ts`

**Interfaces:**
- `/effort` inspects the current chat’s override/effective value.
- `/effort <value>` sets only that chat’s live override.
- `/effort reset` removes that chat’s override and returns to configured model/default resolution.
- `CommandHandler.getEffort(chatId)` returns the optional current-chat override for the next tracked turn.

- [ ] **Step 1: Write failing command tests**

```ts
test('/effort supports inspect, set, and reset for one chat', async () => {
  // Construct the existing CommandHandler fixture, assert inspect, set high,
  // inspect high, reset, and inspect fallback; assert another chat is unchanged.
});

test('/effort rejects unknown values without changing the chat override', async () => {
  // Set high, issue /effort ultra, assert an error/allowed-values response and
  // getEffort(chatId) remains high.
});
```

- [ ] **Step 2: Run the focused command tests to verify they fail**

Run: `node --import tsx --test tests/commands/handler.test.ts`

Expected: FAIL because `/effort` and per-chat state do not yet exist.

- [ ] **Step 3: Implement the command and message-handler wiring**

Keep command handling pre-AgentLoop. Store only in-memory per-chat overrides, show the configured fallback on inspect/reset, include `/effort` in `/help`, and pass `commandHandler.getEffort(message.chatId)` into the ordinary `executeTrackedTurn` call. Do not persist live chat state into agent config or runtime files.

- [ ] **Step 4: Run focused tests to verify they pass**

Run: `node --import tsx --test tests/commands/handler.test.ts tests/agent/turn-entrypoints.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/handler.ts src/home.ts tests/commands/handler.test.ts tests/agent/turn-entrypoints.test.ts
git commit -m "feat: add live chat reasoning effort command"
```

### Task 5: Full verification, policy check, and final commit

**Files:**
- Modify only files already listed above if verification exposes a focused defect.

- [ ] **Step 1: Run the complete relevant TypeScript test groups**

Run: `npm test`

Expected: exit 0 with no failures.

- [ ] **Step 2: Run build/typecheck and contracts**

Run: `npm run build && npm run test:contracts`

Expected: both exit 0.

- [ ] **Step 3: Verify scope and public/local separation**

Run: `git status --short --branch`, `git diff --check`, `git diff --stat HEAD`, and `git diff --name-only HEAD | rg '^(engine/|cosmo23/)'`.

Expected: no whitespace errors, no runtime state staged, and no engine/feeder/COSMO files changed; the final commit range is inspected with `git show --name-only --format='' HEAD`.

- [ ] **Step 4: Commit any final focused verification fix**

```bash
git add src/agent/reasoning-effort.ts src/types.ts src/agent/model-resolution.ts src/config.ts config/home.yaml.example cli/lib/agent-config-builder.cjs src/agent/types.ts src/agent/turn-entrypoint.ts src/agent/loop.ts src/agent/text-generation.ts src/home.ts src/agent/tools/subagent.ts src/agent/tools/cron.ts src/scheduler/cron.ts src/commands/handler.ts tests/agent/reasoning-effort.test.ts tests/agent/text-generation.test.ts tests/agent/chat-turn-model-override.test.ts tests/agent/turn-entrypoints.test.ts tests/agent/tools/subagent-isolation.test.ts tests/agent/tools/cron.test.ts tests/scheduler/cron.test.ts tests/commands/handler.test.ts docs/superpowers/plans/2026-08-19-gpt-5-6-reasoning-controls.md
git commit -m "test: verify GPT-5.6 reasoning controls"
```

- [ ] **Step 5: Report exact files, commands, results, and remaining gaps**

State the final commit, changed-file list, exact checks run, engine/feeder policy constraint, and any unrun live OAuth/device verification separately from automated test evidence.
