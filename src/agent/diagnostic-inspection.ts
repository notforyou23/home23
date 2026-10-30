/** A bounded diagnostic inspection is a read capability, never a repair grant.
 * A per-turn seeded registry enforces this boundary for every provider path. */
import { createRequire } from 'node:module';
import { existsSync, statSync, realpathSync, readdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadavg, totalmem, freemem, uptime, platform } from 'node:os';
import path from 'node:path';
import { ToolRegistry } from './tools/index.js';
import { createRestrictedFileTools, canonicalizeFilePath, isWithinFileRoot } from './tools/restricted-files.js';
import { cronListTool } from './tools/cron.js';
import { workListTool } from './tools/work.js';
import { agencyBriefTool } from './tools/agency.js';
import type { AgentResponse, ToolContext, ToolDefinition, ToolResult } from './types.js';

const { normalizeBoundedAgendaIntent } = createRequire(import.meta.url)('../../engine/src/cognition/bounded-intent.js') as {
  normalizeBoundedAgendaIntent(raw: unknown, refs: unknown): InspectionIntent | null;
};
interface InspectionIntent { schema: string; operation: 'inspect' | 'verify'; targetRef: string; question: string; expectedEvidence: string; stopCondition: string; evidenceRefs: string[] }
export const INSPECTION_AUTHORITY_REFUSED = 'inspection_authority_refused';
const MAX_CALLS = 12;
const MAX_RESULT_CHARS = 24_000;
const MAX_FILE_BYTES = 128_000;
const EXECUTION_MS = 180_000;
const execFileAsync = promisify(execFile);
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const PRIVATE_NAME = /^(?:\..+|config\.ya?ml|settings(?:\..+)?\.json|secrets?(?:\..+)?|credentials?(?:\..+)?|auth(?:entication)?(?:\..+)?|tokens?(?:\..+)?|id_[a-z0-9_]+(?:\.pub)?|.*\.(?:key|pem|p12|pfx|keystore|sqlite|sqlite3|db))$/i;

export interface DiagnosticInspectionOptions {
  registry: Pick<ToolRegistry, 'get'>;
  instanceDir: string;
  workspacePath: string;
  /** Only existing public code/document directories are included, never config/instances. */
  sourceRoot?: string;
  /** Test seam for the constant, argument-free snapshot; never accepted from a model. */
  runtimeSnapshot?: () => Promise<unknown>;
}
export interface DiagnosticInspection {
  mode: 'inspection';
  mission: string;
  registry: ToolRegistry;
  turnOptions: { inactivityMs: number; hardDurationMs: number; firstTokenTimeoutMs: number; suppressCompletionPush: true; delegatedTurn: true; delegatedContext: { systemPrompt: string; workspacePath: string; baseSystemPrompt: string } };
  failureReason(): string | null;
  executionStatus(response: AgentResponse): 'completed' | 'failed';
}

async function runtimeSnapshot(): Promise<unknown> {
  const capturedAt = new Date().toISOString();
  const base = { capturedAt, kind: 'runtime_snapshot', platform: platform(), loadAverage: loadavg(),
    totalMemoryBytes: totalmem(), freeMemoryBytes: freemem(), uptimeSeconds: uptime() };
  if (platform() !== 'darwin' && platform() !== 'linux') return { ...base, processes: [], processEvidence: 'unavailable on this platform' };
  // No shell, argv, environment dump, model-selected command, or service control.
  const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid=,%cpu=,%mem=,rss=,etime=,comm='], {
    encoding: 'utf8', timeout: 2_000, maxBuffer: 256_000, shell: false,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  });
  const all = stdout.trim().split('\n').filter(Boolean).map(line => {
    const fields = line.trim().split(/\s+/);
    return { pid: Number(fields[0]), parentPid: Number(fields[1]), cpuPercent: Number(fields[2]), memoryPercent: Number(fields[3]),
      residentKiB: Number(fields[4]), elapsed: fields[5], executable: fields.slice(6).join(' ').slice(0, 180) };
  }).filter(row => Number.isSafeInteger(row.pid) && row.pid > 0 && Number.isFinite(row.cpuPercent));
  all.sort((a, b) => b.cpuPercent - a.cpuPercent || b.residentKiB - a.residentKiB);
  return { ...base, processes: all.slice(0, 100), processesObserved: all.length,
    coverage: 'top 100 by current process CPU; process names only, no arguments or environment', truncated: all.length > 100 };
}

/** Null means legacy metadata is ABSENT. Any present but malformed envelope
 * throws before dispatch and must never select the full repair registry. */
export function resolveDiagnosticInspection(problem: unknown, options: DiagnosticInspectionOptions): DiagnosticInspection | null {
  const p = record(problem);
  if (!Object.hasOwn(p, 'inspection')) return null;
  const intent = normalizeBoundedAgendaIntent(p.inspection, p.inspectionEvidenceRefs);
  if (!intent || typeof p.id !== 'string' || p.id.length < 1 || p.id.length > 300 || /[\x00-\x1f\x7f]/.test(p.id)) {
    throw new TypeError('invalid bounded diagnostic inspection');
  }
  const roots = [options.instanceDir, options.workspacePath].map(root => realpathSync(root));
  if (options.sourceRoot) for (const subdir of ['src', 'engine/src', 'shared', 'docs']) {
    const candidate = path.join(options.sourceRoot, subdir);
    if (existsSync(candidate) && statSync(candidate).isDirectory()) roots.push(realpathSync(candidate));
  }
  const readRoots = [...new Set(roots)];
  const restricted = createRestrictedFileTools({ readRoots, writeRoots: [], denyPaths: [path.join(options.instanceDir, 'config.yaml')], maxReadBytes: 64_000 });
  const fileRead = restricted.find(tool => tool.name === 'read_file')!;
  let failure: string | null = null;
  const started = Date.now();
  const refuse = (reason: string, tool: string, ctx?: ToolContext): ToolResult => {
    failure ??= reason;
    ctx?.turnRuntime?.abortController.abort(Object.assign(new Error('inspection authority refused'), { code: INSPECTION_AUTHORITY_REFUSED }));
    return { is_error: true, content: JSON.stringify({ code: INSPECTION_AUTHORITY_REFUSED, reason, tool }), metadata: { code: INSPECTION_AUTHORITY_REFUSED } };
  };
  const keysAre = (input: Record<string, unknown>, allowed: readonly string[]) => Object.keys(input).every(key => allowed.includes(key));
  const authorizePath = (input: Record<string, unknown>, tool: string, ctx: ToolContext): { file: string } | ToolResult => {
    if (typeof input.path !== 'string' || !path.isAbsolute(input.path) || input.path.includes('\0') || input.path.split(/[\\/]/).includes('..')) return refuse('an absolute, non-traversing read path is required', tool, ctx);
    try {
      const file = canonicalizeFilePath(input.path, false);
      const root = readRoots.find(candidate => isWithinFileRoot(candidate, file));
      if (!root || path.relative(root, file).split(path.sep).some(name => PRIVATE_NAME.test(name))) return refuse('path is outside inspection roots or is private credential/state material', tool, ctx);
      return { file };
    } catch { return { is_error: true, content: 'Inspection source is unavailable.' }; }
  };
  const bounded = (tool: ToolDefinition): ToolDefinition => ({ ...tool, async execute(input, ctx) {
    const result = await tool.execute(input, ctx);
    return result.content.length > MAX_RESULT_CHARS ? { ...result, content: result.content.slice(0, MAX_RESULT_CHARS) + '\n[inspection output truncated]', metadata: { ...result.metadata, truncated: true } } : result;
  } });
  const tools: ToolDefinition[] = [{
    name: 'read_file', description: 'Read a bounded regular file inside inspection roots. Credentials, hidden paths, databases and traversal are unavailable.',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 1000 } }, required: ['path'], additionalProperties: false },
    async execute(input, ctx) {
      if (!keysAre(input, ['path', 'offset', 'limit']) || input.offset !== undefined && (!Number.isSafeInteger(input.offset) || Number(input.offset) < 0) || input.limit !== undefined && (!Number.isSafeInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 1000)) return refuse('invalid bounded file arguments', 'read_file', ctx);
      const auth = authorizePath(input, 'read_file', ctx); if (!('file' in auth)) return auth;
      const stat = statSync(auth.file);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return { is_error: true, content: 'Inspection file is not regular or exceeds the 128000-byte read budget; use a bounded status tool.' };
      return fileRead.execute({ ...input, path: auth.file }, ctx);
    },
  }, {
    name: 'list_files', description: 'List a bounded directory inside inspection roots, excluding private names and escaping links.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    async execute(input, ctx) {
      if (!keysAre(input, ['path'])) return refuse('invalid directory arguments', 'list_files', ctx);
      const auth = authorizePath(input, 'list_files', ctx); if (!('file' in auth)) return auth;
      if (!statSync(auth.file).isDirectory()) return { is_error: true, content: 'Inspection source is not a directory.' };
      const entries = readdirSync(auth.file, { withFileTypes: true }).slice(0, 300).filter(entry => {
        if (PRIVATE_NAME.test(entry.name)) return false;
        try { const resolved = realpathSync(path.join(auth.file, entry.name)); return readRoots.some(root => isWithinFileRoot(root, resolved)) && !path.relative(readRoots.find(root => isWithinFileRoot(root, resolved))!, resolved).split(path.sep).some(name => PRIVATE_NAME.test(name)); } catch { return false; }
      }).map(entry => `${entry.isDirectory() ? 'd' : '-'} ${entry.name}`);
      return { content: entries.join('\n') || '(empty readable directory)', metadata: { bounded: true, maxEntries: 300 } };
    },
  }, {
    name: 'runtime_snapshot', description: 'Read current memory/load and a bounded process snapshot. No arguments, command lines, environment, or service control.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    async execute(input, ctx) { if (Object.keys(input).length) return refuse('runtime snapshot accepts no arguments', 'runtime_snapshot', ctx); return { content: JSON.stringify(await (options.runtimeSnapshot ?? runtimeSnapshot)()) }; },
  }];
  // Use exact audited read definitions. Generic registry wrappers deliberately
  // refuse restricted chats and must not be copied or bypassed by changing ids.
  for (const original of [cronListTool, workListTool, agencyBriefTool]) {
    const name = original.name;
    if (!options.registry.get(name)) continue;
    const allowed = name === 'cron_list' ? ['show_disabled'] : name === 'work_list' ? ['include_terminal', 'limit'] : [];
    tools.push({ ...original, input_schema: name === 'agency_brief' ? { type: 'object', properties: {}, additionalProperties: false } : { ...original.input_schema, additionalProperties: false },
      async execute(input, ctx) {
        if (!keysAre(input, allowed) || ['show_disabled', 'include_terminal'].some(key => input[key] !== undefined && typeof input[key] !== 'boolean')
          || input.limit !== undefined && (!Number.isSafeInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 20)) return refuse('invalid read-only inspection arguments', name, ctx);
        // agency_brief can POST surfaced obligations; this branch can only GET.
        return original.execute(name === 'agency_brief' ? {} : input, ctx);
      },
    });
  }
  class InspectionRegistry extends ToolRegistry {
    private count = 0;
    constructor() { super('seeded'); for (const tool of tools) this.register(bounded(tool)); }
    override async execute(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      if (failure !== null) return refuse('inspection has already stopped after a refusal', name, ctx);
      if (++this.count > MAX_CALLS || Date.now() - started > EXECUTION_MS) return refuse('inspection tool/time budget exhausted', name, ctx);
      if (!this.get(name)) return refuse('tool is outside the inspection capability set', name, ctx);
      if (!input || typeof input !== 'object' || Array.isArray(input)) return refuse('tool arguments must be an object', name, ctx);
      return super.execute(name, input, ctx);
    }
  }
  const registry = new InspectionRegistry();
  const systemPrompt = 'Perform one bounded read-only inspection. Tool availability is the execution boundary. Do not repair, write, restart, schedule, delegate, contact anyone or fetch arbitrary network content. A successful read does not verify a repair. State missing evidence plainly and stop at the stated condition.';
  const mission = [
    `BOUNDED READ-ONLY INSPECTION — ${p.id}`, `Operation: ${intent.operation}`, `Target evidence reference: ${intent.targetRef}`,
    `Question: ${intent.question}`, `Expected evidence: ${intent.expectedEvidence}`, `Stop condition: ${intent.stopCondition}`,
    'Readable roots (private files are excluded):', ...readRoots.map(root => `  ${root}`),
    'Original runtime evidence references:', ...intent.evidenceRefs.map(ref => `  ${ref}`), '', systemPrompt,
    'Report the evidence observed, its time/coverage, and any unresolved question. Do not claim remediation or independent task verification from your own summary.',
  ].join('\n');
  return { mode: 'inspection', mission, registry, failureReason: () => failure,
    executionStatus: response => failure === null && response.terminalStatus === 'complete' ? 'completed' : 'failed',
    turnOptions: { inactivityMs: 60_000, hardDurationMs: EXECUTION_MS, firstTokenTimeoutMs: 60_000, suppressCompletionPush: true, delegatedTurn: true,
      delegatedContext: { systemPrompt, baseSystemPrompt: systemPrompt, workspacePath: options.workspacePath } } };
}
