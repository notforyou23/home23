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

import os from 'node:os';
import path from 'node:path';
import { getHome23Root } from '../config.js';
import { AgentLoop } from './loop.js';
import { ContextManager } from './context.js';
import { ConversationHistory } from './history.js';
import { createSeededToolRegistry } from './tools/index.js';
import { createRestrictedFileTools } from './tools/restricted-files.js';
import type { ToolContext } from './types.js';
import type { BrainOperationsClient } from './brain-operations/client.js';

export const PROPOSER_CHAT_PREFIX = 'proposer:shakedown';

export interface ProposerRoots {
  /** Home23 app root: HOME23_ROOT when set, else the packaged root (src/config.ts). */
  home23: string;
  /** Shakedown Shuffle site checkout: SHAKEDOWN_SITE_ROOT, else ~/websites/shakedownshuffle.com. */
  site: string;
  /** Jerry collection archive: JERRY_COLLECTION_ROOT, else a sibling two levels above the app root. */
  jerryCollection: string;
  workerWorkspace: string;
  contentDir: string;
}

/**
 * Operational roots for the proposer, resolved from the environment or the
 * app's own location — never a baked-in developer machine path. src/ ships
 * hash-verified, so an owner cannot edit such a default and on any other
 * machine it is simply wrong (release 186 defect D10).
 */
export function resolveProposerRoots(): ProposerRoots {
  const home23 = getHome23Root();
  const site = process.env.SHAKEDOWN_SITE_ROOT
    ? path.resolve(process.env.SHAKEDOWN_SITE_ROOT)
    : path.join(os.homedir(), 'websites', 'shakedownshuffle.com');
  const jerryCollection = process.env.JERRY_COLLECTION_ROOT
    ? path.resolve(process.env.JERRY_COLLECTION_ROOT)
    : path.resolve(home23, '..', '..', 'jerry-collection');
  return {
    home23,
    site,
    jerryCollection,
    workerWorkspace: path.join(home23, 'instances/workers/shakedown-jerry/workspace'),
    contentDir: path.join(home23, 'instances/jerry/workspace/projects/shakedownshuffle'),
  };
}

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
  const roots = resolveProposerRoots();
  const tools = createRestrictedFileTools({
    readRoots: [
      path.join(roots.site, 'shakedown-v2/outputs/publishing-pipeline'),
      path.join(roots.site, 'operator-reports'),
      path.join(roots.site, 'ops/jerry-collection/runtime'),
      path.join(roots.site, 'jerry-api/show-enrichment/artifacts'),
      roots.jerryCollection,
      // The whole project dir (status/, OPERATIONS.md, content/) is readable.
      // Do NOT grant a bare file as a root — compileRoots widens files to
      // their parent directory, which for SHAKEDOWN_STATUS.md would grant all
      // of Jerry's workspace. The proposer reads status/latest.json instead.
      roots.contentDir,
    ],
    // Writes: the worker's own workspace, and ONLY content/ (queue + drafts)
    // within the project dir — status/ stays cron-owned and read-only here.
    writeRoots: [roots.workerWorkspace, path.join(roots.contentDir, 'content')],
    denyPaths: [
      path.join(roots.site, 'jerry-api/.env'),
      path.join(roots.site, 'shakedown-v2/.env'),
      path.join(roots.site, 'private'),
      path.join(roots.workerWorkspace, 'source-clones'),
    ],
    maxWriteBytes: 256_000,
  });

  const contextManager = new ContextManager({
    workspacePath: roots.workerWorkspace,
    identityFiles: ['IDENTITY.md', 'PLAYBOOK.md', 'NOW.md'],
    heartbeatRefreshMs: 0,
    enginePort: deps.enginePort,
  });

  const history = new ConversationHistory(
    path.join(roots.workerWorkspace, 'state', 'history'), 200_000, 'proposer',
  );

  const toolContext: ToolContext = {
    scheduler: null,
    ttsService: null,
    browser: null,
    projectRoot: roots.workerWorkspace,
    enginePort: deps.enginePort,
    agentName: 'jerry',
    cosmo23BaseUrl: deps.cosmo23BaseUrl,
    brainRoute: null,
    workspacePath: roots.workerWorkspace,
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
    workspacePath: roots.workerWorkspace,
  });
}
