import assert from 'node:assert/strict';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { AgentLoop } from '../../src/agent/loop.js';
import { ConversationHistory } from '../../src/agent/history.js';
import { executeTrackedTurn } from '../../src/agent/turn-entrypoint.js';
import { spawnAgentTool } from '../../src/agent/tools/subagent.js';
import { workCancelTool, workListTool, workStatusTool } from '../../src/agent/tools/work.js';
import type { AgentResponse, ToolContext } from '../../src/agent/types.js';
import { requestAsyncWorkCancel } from '../../src/work/cancel.js';
import { WorkRegistry } from '../../src/work/registry.js';
import { WorkStore } from '../../src/work/work-store.js';
import { TERMINAL_WORK_STATUSES, type AsyncWorkRecord } from '../../src/work/types.js';

type ConfigRecord = Record<string, unknown> & {
  models?: { aliases?: Record<string, { provider: string; model: string }> };
  providers?: Record<string, { apiKey?: string; baseUrl?: string }>;
};

const mainRoot = resolve(process.env.HOME23_REPLAY_CONFIG_ROOT || '');
const artifactDir = resolve(process.env.HOME23_REPLAY_ARTIFACT_DIR || '');
assert.ok(mainRoot && mainRoot !== '/', 'HOME23_REPLAY_CONFIG_ROOT is required');
assert.ok(artifactDir && artifactDir !== '/', 'HOME23_REPLAY_ARTIFACT_DIR is required');
mkdirSync(artifactDir, { recursive: true });

function loadYaml(path: string): ConfigRecord {
  return (yaml.load(readFileSync(path, 'utf8')) || {}) as ConfigRecord;
}

async function waitFor<T>(read: () => T | undefined, accept: (value: T) => boolean, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined && accept(value)) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`replay condition not reached within ${timeoutMs}ms`);
}

function workIdFromReceipt(content: string): string {
  const match = content.match(/\bwork (aw_[a-z0-9]+_[a-f0-9]+)\b/i);
  assert.ok(match?.[1], `spawn receipt did not contain a work ID: ${content}`);
  return match[1];
}

const runtimeRoot = mkdtempSync(join(tmpdir(), 'home23-agent-repair-replay-'));
const workspacePath = join(runtimeRoot, 'instances', 'jerry', 'workspace');
const conversationDir = join(runtimeRoot, 'conversations');
const workDir = join(runtimeRoot, 'instances', 'jerry', 'async-work');
mkdirSync(workspacePath, { recursive: true });

const receipt: Record<string, unknown> = {
  schema: 'home23.repair-replay.agent-work.v1',
  startedAt: new Date().toISOString(),
  runtimeRoot,
};

let agent: AgentLoop | null = null;
try {
  const home = loadYaml(join(mainRoot, 'config', 'home.yaml'));
  const secrets = loadYaml(join(mainRoot, 'config', 'secrets.yaml'));
  const alias = home.models?.aliases?.sonnet;
  assert.deepEqual(alias, { provider: 'anthropic', model: 'claude-sonnet-5' });
  const anthropic = secrets.providers?.anthropic;
  const credential = anthropic?.apiKey || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
  assert.ok(credential, 'Jerry Anthropic credential is unavailable');
  process.env.ANTHROPIC_AUTH_TOKEN = credential;

  const history = new ConversationHistory(conversationDir, 100_000, 'jerry-replay');
  const workRegistry = new WorkRegistry({ store: new WorkStore(workDir), agent: 'jerry' });
  const contextManager = {
    getSystemPrompt: () => 'You are an isolated Home23 replay agent. Never call tools. Follow the requested response format exactly.',
    getPromptSourceInfo: () => ({ loadedFiles: [] }),
  };
  const emptyToolRegistry = {
    getAnthropicTools: () => [],
    getOpenAITools: () => [],
    get: () => undefined,
    execute: async () => ({ content: '' }),
  };
  const brainOperations = {
    withActivityHandler() { return this; },
    async searchContext() {
      return {
        results: [],
        sourceEvidence: { sourceHealth: 'healthy', matchOutcome: 'corpus_empty' },
      };
    },
  };
  const tracker = { active: 0, maxConcurrent: 3, queue: [] };
  const terminalDeliveries: Array<{ workId: string; text: string }> = [];
  const loopOutcomes: Array<{
    chatId: string;
    override?: { model: string; provider?: string };
    response?: AgentResponse;
    error?: string;
  }> = [];

  const ctx = {
    scheduler: null,
    ttsService: null,
    browser: null,
    projectRoot: runtimeRoot,
    enginePort: 1,
    agentName: 'jerry',
    cosmo23BaseUrl: 'http://127.0.0.1:1',
    brainRoute: null,
    workspacePath,
    tempDir: join(runtimeRoot, 'tmp'),
    contextManager,
    subAgentTracker: tracker,
    modelAliases: home.models?.aliases || {},
    chatId: 'replay-parent',
    telegramAdapter: null,
    workRegistry,
    brainOperations,
    turnRuntime: null,
    onWorkTerminal: (workId: string, text: string) => terminalDeliveries.push({ workId, text }),
  } as unknown as ToolContext;

  agent = new AgentLoop({
    apiKey: credential,
    baseURL: anthropic?.baseUrl,
    model: 'claude-sonnet-5',
    provider: 'anthropic',
    maxTokens: 128,
    temperature: 0,
    registry: emptyToolRegistry as never,
    contextManager: contextManager as never,
    history,
    toolContext: ctx,
    workspacePath,
  });
  agent.setProviderMap({
    anthropic: { apiKey: credential, baseURL: anthropic?.baseUrl },
  });

  ctx.runAgentLoop = async (_systemPrompt, userMessage, _tools, subCtx, options) => {
    const outcome: (typeof loopOutcomes)[number] = {
      chatId: subCtx.chatId,
      override: options?.modelOverride,
    };
    loopOutcomes.push(outcome);
    try {
      outcome.response = (await executeTrackedTurn(agent!, subCtx.chatId, userMessage, {
        modelOverride: options?.modelOverride,
        inactivityMs: 30_000,
        hardDurationMs: 60_000,
      })).response;
      return outcome.response;
    } catch (error) {
      outcome.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  };
  ctx.requestWorkCancel = (workId) => requestAsyncWorkCancel({
    registry: workRegistry,
    cancelCodingJob: async () => {},
    stopChat: (chatId) => agent!.stop(chatId).stopped,
  }, workId);

  const validReceipt = await spawnAgentTool.execute({
    task: 'Reply with exactly REPLAY_SONNET_OK and nothing else.',
    label: 'sonnet alias replay',
    model: 'sonnet',
  }, ctx);
  assert.notEqual(validReceipt.is_error, true, validReceipt.content);
  const validWorkId = workIdFromReceipt(validReceipt.content);
  const validTerminal = await waitFor(
    () => workRegistry.get(validWorkId),
    (value) => TERMINAL_WORK_STATUSES.has(value.status),
  );
  assert.equal(validTerminal.status, 'completed');
  const validChatId = validTerminal.resultHandle.type === 'subagent_chat'
    ? validTerminal.resultHandle.chatId
    : '';
  const validOutcome = loopOutcomes.find((value) => value.chatId === validChatId);
  const terminalDelivery = terminalDeliveries.find((value) => value.workId === validWorkId);
  assert.deepEqual(validOutcome?.override, alias);
  assert.equal(validOutcome?.response?.model, alias.model);
  assert.match(validOutcome?.response?.text || '', /REPLAY_SONNET_OK/);
  assert.doesNotMatch(JSON.stringify({ validOutcome, validTerminal }), /Unknown provider: unknown/);
  assert.ok(terminalDelivery, 'successful sub-agent result was not delivered to the terminal hook');

  const countBeforeInvalid = workRegistry.list().length;
  const invalidReceipt = await spawnAgentTool.execute({
    task: 'This must never run.',
    label: 'invalid alias replay',
    model: 'not-a-configured-alias',
  }, ctx);
  assert.equal(invalidReceipt.is_error, true);
  assert.match(invalidReceipt.content, /Unable to resolve sub-agent model override/);
  assert.doesNotMatch(invalidReceipt.content, /spawned/i);
  assert.equal(workRegistry.list().length, countBeforeInvalid);
  const countAfterInvalid = workRegistry.list().length;

  const cancelReceipt = await spawnAgentTool.execute({
    task: 'Perform a long, detailed analysis before replying. Do not reply early.',
    label: 'operator stop replay',
    model: 'sonnet',
  }, ctx);
  assert.notEqual(cancelReceipt.is_error, true, cancelReceipt.content);
  const cancelWorkId = workIdFromReceipt(cancelReceipt.content);
  const cancelWork = workRegistry.get(cancelWorkId);
  assert.ok(cancelWork && cancelWork.resultHandle.type === 'subagent_chat');
  await waitFor(
    () => agent!.isRunning(cancelWork.resultHandle.type === 'subagent_chat' ? cancelWork.resultHandle.chatId : '') || undefined,
    Boolean,
    10_000,
  );

  const activeList = await workListTool.execute({}, ctx);
  assert.match(activeList.content, new RegExp(cancelWorkId));
  const exactStatus = await workStatusTool.execute({ work_id: cancelWorkId }, ctx);
  assert.equal((JSON.parse(exactStatus.content) as AsyncWorkRecord).status, 'running');
  const cancelRequest = await workCancelTool.execute({ work_id: cancelWorkId }, ctx);
  assert.match(cancelRequest.content, /Cancellation requested/);
  const cancelled = await waitFor(
    () => workRegistry.get(cancelWorkId),
    (value) => TERMINAL_WORK_STATUSES.has(value.status),
    30_000,
  );
  assert.equal(cancelled.status, 'cancelled');
  assert.match(cancelled.error || '', /operator_stop/);
  const noActive = await workListTool.execute({}, ctx);
  assert.equal(noActive.content, 'No active durable async work.');
  await waitFor(() => tracker.active, (active) => active === 0, 10_000);

  receipt.alias = {
    requested: 'sonnet',
    resolvedProvider: alias.provider,
    resolvedModel: alias.model,
    workId: validWorkId,
    durableStatus: validTerminal.status,
    terminalDelivery: Boolean(terminalDelivery),
    providerResponseMarker: 'REPLAY_SONNET_OK',
  };
  receipt.invalidAlias = {
    requested: 'not-a-configured-alias',
    isError: invalidReceipt.is_error === true,
    durableCountBefore: countBeforeInvalid,
    durableCountAfter: countAfterInvalid,
  };
  receipt.workTools = {
    workId: cancelWorkId,
    listedWhileActive: activeList.content.includes(cancelWorkId),
    inspectedStatus: (JSON.parse(exactStatus.content) as AsyncWorkRecord).status,
    cancelResponse: cancelRequest.content,
    terminalStatus: cancelled.status,
    terminalError: cancelled.error,
    activeAfter: workRegistry.list({ active: true }).length,
  };
  receipt.terminalRecords = workRegistry.list().map((record) => ({
    workId: record.workId,
    label: record.label,
    status: record.status,
    error: record.error,
    resultHandle: record.resultHandle,
  }));
  receipt.loopOutcomes = loopOutcomes.map((outcome) => ({
    chatId: outcome.chatId,
    override: outcome.override,
    model: outcome.response?.model,
    textMarkerPresent: outcome.response?.text.includes('REPLAY_SONNET_OK') || false,
    error: outcome.error,
  }));
  receipt.completedAt = new Date().toISOString();
} catch (error) {
  receipt.failure = error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
  throw error;
} finally {
  try { agent?.stop(); } catch { /* best effort */ }
  const copiedDir = join(artifactDir, 'agent-runtime-evidence');
  mkdirSync(copiedDir, { recursive: true });
  for (const dir of [conversationDir, workDir]) {
    try {
      for (const name of readdirSync(dir)) {
        cpSync(join(dir, name), join(copiedDir, `${basename(dir)}-${name}`));
      }
    } catch { /* partial failure receipt remains useful */ }
  }
  rmSync(runtimeRoot, { recursive: true, force: true });
  receipt.cleanup = {
    runtimeRootRemoved: true,
    activeRunsAfterStop: agent?.getActiveRuns() || [],
  };
  writeFileSync(join(artifactDir, 'agent-work-replay.json'), JSON.stringify(receipt, null, 2));
}

console.log(JSON.stringify({
  ok: !receipt.failure,
  receipt: join(artifactDir, 'agent-work-replay.json'),
  alias: receipt.alias,
  invalidAlias: receipt.invalidAlias,
  workTools: receipt.workTools,
  cleanup: receipt.cleanup,
}, null, 2));
