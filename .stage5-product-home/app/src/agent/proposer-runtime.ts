/**
 * ShakedownJerry proposer runtime — Task 7 of
 * docs/superpowers/plans/2026-07-25-shakedown-jerry-proposer.md.
 *
 * Builds a fully separate AgentLoop for the proposer: its own workspace,
 * identity files, history namespace, and — the point — a SEEDED registry
 * holding only root-confined file tools. No shell, no browser, no subagents,
 * no cron, no web. The generic 68-tool registry independently refuses
 * proposer:* chat ids (registry boundary guard), so confinement holds from
 * both directions.
 *
 * Read roots mirror surface.json (the Task 2 read surface); write roots are
 * exactly the worker workspace and Jerry's shakedownshuffle content dir
 * (editorial queue + drafts). jerry-api/.env, shakedown-v2/.env, and the
 * site's private/ tree are denied even though .env files sit inside granted
 * read roots — deny overrides allow.
 */

import path from 'node:path';
import { AgentLoop } from './loop.js';
import { ContextManager } from './context.js';
import { ConversationHistory } from './history.js';
import { createSeededToolRegistry } from './tools/index.js';
import { createRestrictedFileTools } from './tools/restricted-files.js';
import type { ToolContext } from './types.js';
import type { BrainOperationsClient } from './brain-operations/client.js';

const SITE = '/Users/jtr/websites/shakedownshuffle.com';
const H23 = '/Users/jtr/_JTR23_/release/home23';
const WORKER_WORKSPACE = path.join(H23, 'instances/workers/shakedown-jerry/workspace');
const CONTENT_DIR = path.join(H23, 'instances/jerry/workspace/projects/shakedownshuffle');

export const PROPOSER_CHAT_PREFIX = 'proposer:shakedown';

export interface ProposerRuntimeDeps {
  apiKey: string;
  baseURL?: string;
  model: string;
  provider?: string;
  enginePort: number;
  cosmo23BaseUrl: string;
  tempDir: string;
  /** Required by ToolContext; no seeded tool uses it (no brain tools are registered). */
  brainOperations: BrainOperationsClient;
}

export function createShakedownProposerAgent(deps: ProposerRuntimeDeps): AgentLoop {
  const tools = createRestrictedFileTools({
    readRoots: [
      path.join(SITE, 'shakedown-v2/outputs/publishing-pipeline'),
      path.join(SITE, 'operator-reports'),
      path.join(SITE, 'ops/jerry-collection/runtime'),
      path.join(SITE, 'jerry-api/show-enrichment/artifacts'),
      '/Users/jtr/_JTR23_/jerry-collection',
      // The whole project dir (status/, OPERATIONS.md, content/) is readable.
      // Do NOT grant a bare file as a root — compileRoots widens files to
      // their parent directory, which for SHAKEDOWN_STATUS.md would grant all
      // of Jerry's workspace. The proposer reads status/latest.json instead.
      CONTENT_DIR,
    ],
    // Writes: the worker's own workspace, and ONLY content/ (queue + drafts)
    // within the project dir — status/ stays cron-owned and read-only here.
    writeRoots: [WORKER_WORKSPACE, path.join(CONTENT_DIR, 'content')],
    denyPaths: [
      path.join(SITE, 'jerry-api/.env'),
      path.join(SITE, 'shakedown-v2/.env'),
      path.join(SITE, 'private'),
      path.join(WORKER_WORKSPACE, 'source-clones'),
    ],
    maxWriteBytes: 256_000,
  });

  const contextManager = new ContextManager({
    workspacePath: WORKER_WORKSPACE,
    identityFiles: ['IDENTITY.md', 'PLAYBOOK.md', 'NOW.md'],
    heartbeatRefreshMs: 0,
    enginePort: deps.enginePort,
  });

  const history = new ConversationHistory(
    path.join(WORKER_WORKSPACE, 'state', 'history'), 200_000, 'proposer',
  );

  const toolContext: ToolContext = {
    scheduler: null,
    ttsService: null,
    browser: null,
    projectRoot: WORKER_WORKSPACE,
    enginePort: deps.enginePort,
    agentName: 'jerry',
    cosmo23BaseUrl: deps.cosmo23BaseUrl,
    brainRoute: null,
    workspacePath: WORKER_WORKSPACE,
    tempDir: deps.tempDir,
    contextManager,
    subAgentTracker: { active: 0, maxConcurrent: 0, queue: [] },
    chatId: PROPOSER_CHAT_PREFIX,
    telegramAdapter: null,
    runAgentLoop: null,
    brainOperations: deps.brainOperations,
    turnRuntime: null,
  };

  return new AgentLoop({
    apiKey: deps.apiKey,
    baseURL: deps.baseURL,
    model: deps.model,
    provider: deps.provider,
    maxTokens: 8192,
    temperature: 0.4,
    registry: createSeededToolRegistry(tools),
    contextManager,
    history,
    toolContext,
    workspacePath: WORKER_WORKSPACE,
  });
}
