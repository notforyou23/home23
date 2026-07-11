'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { createHash } = require('node:crypto');
const {
  canonicalJson,
} = require('../../../shared/brain-operations/canonical-json.cjs');
const {
  openConfinedRegularFile,
  assertStableOpenedFile,
} = require('../../../shared/memory-source/confined-file.cjs');
const {
  requireCompleteProviderResult,
} = require('../../../cosmo23/lib/provider-completion.js');
const {
  throwIfAborted,
} = require('../../../cosmo23/lib/provider-execution.js');
const {
  SYNTHESIS_OPERATION_LIMITS,
} = require('../../../cosmo23/lib/brain-operation-limits.js');
const {
  writeFileDurable,
} = require('../utils/durable-write.js');

const OPERATION_ID_PATTERN = /^brop_[A-Za-z0-9_-]{32}$/;
const PROVIDER_CALL_ID = 'synthesis';
const MAX_TRIGGER_BYTES = 256;
const MAX_THEME_BYTES = 512;
const MAX_RESULT_TEXT_BYTES = 16 * 1024;
const MAX_SEARCH_THEMES = 8;
const MAX_SEARCH_RESULTS_PER_THEME = 3;

const PROVIDER_INSTRUCTIONS = [
  'Analyze only the pinned Home23 brain evidence in the input.',
  'Return one complete JSON object and no markdown fences.',
  'Distinguish current high-salience evidence from historical index volume.',
  'Do not invent facts or claim coverage beyond the supplied pinned source.',
].join(' ');

const RESPONSE_SCHEMA = `Produce this JSON shape:
{
  "selfUnderstanding": {
    "summary": "2-3 sentences describing this brain",
    "currentObsessions": ["3-5 evidence-grounded themes"],
    "relationship": "one sentence describing how this brain relates to its user"
  },
  "consolidatedInsights": [
    {
      "title": "short title",
      "excerpt": "2-3 evidence-grounded sentences",
      "source": "topic or category",
      "themes": ["relevant tags"]
    }
  ],
  "recentActivity": ["recent activity supported by the supplied evidence"]
}
Return at most five consolidated insights. If the brain is sparse, say so honestly.`;

function typed(code, message, retryable = false, extra = {}) {
  return Object.assign(new Error(message), { code, retryable, ...extra });
}

function tooLarge(kind, limit) {
  return typed('result_too_large', `${kind} exceeds the synthesis byte limit`, false, {
    status: 413,
    limitKind: kind,
    limit,
  });
}

function validateLimits(overrides = {}) {
  if (!overrides || Array.isArray(overrides) || typeof overrides !== 'object') {
    throw typed('invalid_request', 'Synthesis limits must be an object');
  }
  const output = {};
  for (const key of ['maxPromptBytes', 'maxProviderOutputBytes', 'maxBrainStateBytes']) {
    const ceiling = SYNTHESIS_OPERATION_LIMITS[key];
    const value = overrides[key] ?? ceiling;
    if (!Number.isSafeInteger(value) || value <= 0 || value > ceiling) {
      throw typed('invalid_request', `Invalid synthesis limit: ${key}`);
    }
    output[key] = value;
  }
  return Object.freeze(output);
}

function boundedText(value, label, maxBytes = MAX_RESULT_TEXT_BYTES, { optional = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return '';
    throw typed('synthesis_response_invalid', `${label} is required`);
  }
  if (typeof value !== 'string' || value.includes('\0')
      || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw typed('synthesis_response_invalid', `${label} is invalid`);
  }
  return value;
}

function exactTrigger(value) {
  const trigger = value ?? 'manual';
  if (typeof trigger !== 'string'
      || trigger.trim() !== trigger
      || trigger.length === 0
      || /[\u0000-\u001f\u007f]/.test(trigger)
      || Buffer.byteLength(trigger, 'utf8') > MAX_TRIGGER_BYTES) {
    throw typed('invalid_request', 'Synthesis trigger is invalid');
  }
  return trigger;
}

function safeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw typed('source_changed', `Pinned source ${label} is invalid`, true);
  }
  return value;
}

function assertOperationId(operationId) {
  if (typeof operationId !== 'string' || !OPERATION_ID_PATTERN.test(operationId)) {
    throw typed('operation_id_invalid', 'Canonical synthesis operation ID required');
  }
  return operationId;
}

function eventText(value, fallback) {
  if (typeof value !== 'string' || value.length === 0
      || /[\u0000-\u001f\u007f]/.test(value)
      || Buffer.byteLength(value, 'utf8') > 128) return fallback;
  return value;
}

function providerEventAt(value) {
  return typeof value === 'string' && value.length <= 128 && !value.includes('\0')
    ? value
    : null;
}

function extractJsonObject(raw) {
  const text = String(raw || '').trim();
  if (!text) throw typed('synthesis_response_invalid', 'empty synthesis response');

  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(text);
  const candidates = [];
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  candidates.push(text);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && !Array.isArray(parsed) && typeof parsed === 'object') return parsed;
    } catch { /* try extracting the first balanced object */ }

    const start = candidate.indexOf('{');
    if (start === -1) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < candidate.length; index += 1) {
      const character = candidate[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === '{') depth += 1;
      else if (character === '}') {
        depth -= 1;
        if (depth === 0) {
          const parsed = JSON.parse(candidate.slice(start, index + 1));
          if (parsed && !Array.isArray(parsed) && typeof parsed === 'object') return parsed;
          break;
        }
      }
    }
  }

  throw typed('synthesis_response_invalid', 'no complete JSON object found in synthesis response');
}

function normalizedStringArray(value, label, { maxItems, maxBytes = MAX_RESULT_TEXT_BYTES } = {}) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw typed('synthesis_response_invalid', `${label} is invalid`);
  }
  return value.map((entry, index) => boundedText(entry, `${label}[${index}]`, maxBytes));
}

function normalizeSynthesis(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw typed('synthesis_response_invalid', 'Synthesis response must be an object');
  }
  const understanding = value.selfUnderstanding ?? {};
  if (!understanding || Array.isArray(understanding) || typeof understanding !== 'object') {
    throw typed('synthesis_response_invalid', 'selfUnderstanding is invalid');
  }
  const insights = value.consolidatedInsights ?? [];
  if (!Array.isArray(insights) || insights.length > 5) {
    throw typed('synthesis_response_invalid', 'consolidatedInsights is invalid');
  }
  return {
    selfUnderstanding: {
      summary: boundedText(
        understanding.summary ?? 'Synthesis produced no self-understanding.',
        'selfUnderstanding.summary',
      ),
      currentObsessions: normalizedStringArray(
        understanding.currentObsessions,
        'selfUnderstanding.currentObsessions',
        { maxItems: 8 },
      ),
      relationship: boundedText(
        understanding.relationship ?? '',
        'selfUnderstanding.relationship',
      ),
    },
    consolidatedInsights: insights.map((insight, index) => {
      if (!insight || Array.isArray(insight) || typeof insight !== 'object') {
        throw typed('synthesis_response_invalid', `consolidatedInsights[${index}] is invalid`);
      }
      return {
        title: boundedText(insight.title ?? '', `consolidatedInsights[${index}].title`),
        excerpt: boundedText(insight.excerpt ?? '', `consolidatedInsights[${index}].excerpt`, 64 * 1024),
        source: boundedText(insight.source ?? '', `consolidatedInsights[${index}].source`),
        themes: normalizedStringArray(insight.themes, `consolidatedInsights[${index}].themes`, {
          maxItems: 32,
        }),
      };
    }),
    recentActivity: normalizedStringArray(value.recentActivity, 'recentActivity', {
      maxItems: 64,
      maxBytes: 64 * 1024,
    }),
  };
}

class Utf8BudgetWriter {
  constructor(limit, initialBytes = 0) {
    this.limit = limit;
    this.bytes = initialBytes;
    this.parts = [];
    if (this.bytes > this.limit) throw tooLarge('prompt', this.limit);
  }

  append(value) {
    const text = String(value);
    const bytes = Buffer.byteLength(text, 'utf8');
    if (this.bytes + bytes > this.limit) throw tooLarge('prompt', this.limit);
    this.parts.push(text);
    this.bytes += bytes;
    return this;
  }

  toString() {
    return this.parts.join('');
  }
}

async function readBoundedWorkspaceFile({ workspacePath, fileName, maxBytes, signal }) {
  throwIfAborted(signal);
  const filePath = path.join(workspacePath, fileName);
  const opened = await openConfinedRegularFile(workspacePath, filePath, {
    optional: true,
    maxBytes,
    signal,
  });
  if (opened === null) return { text: '', bytes: 0 };
  try {
    const bytes = await opened.handle.readFile(signal ? { signal } : undefined);
    throwIfAborted(signal);
    await assertStableOpenedFile(opened);
    throwIfAborted(signal);
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) {
      throw typed('source_unavailable', `${fileName} is not valid UTF-8`, false, { cause: error });
    }
    return { text, bytes: bytes.length };
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

function validateCommittedSynthesisState(state) {
  if (!state || Array.isArray(state) || typeof state !== 'object'
      || !OPERATION_ID_PATTERN.test(state.operationId || '')
      || !Number.isSafeInteger(state.sourceRevision)
      || state.sourceRevision < 0
      || typeof state.provider !== 'string'
      || typeof state.model !== 'string'
      || typeof state.generatedAt !== 'string'
      || !new RegExp(`^generation-${state.sourceRevision}-[a-f0-9]{24}$`)
        .test(state.generationMarker || '')
      || !/^sha256:[a-f0-9]{64}$/.test(state.brainStateSha256 || '')) {
    throw typed('synthesis_state_invalid', 'Committed synthesis state is invalid');
  }
  const generatedAt = Date.parse(state.generatedAt);
  if (!Number.isFinite(generatedAt)
      || new Date(generatedAt).toISOString() !== state.generatedAt) {
    throw typed('synthesis_state_invalid', 'Committed synthesis timestamp is invalid');
  }
  const withoutHash = Object.fromEntries(
    Object.entries(state).filter(([key]) => key !== 'brainStateSha256'),
  );
  let expected;
  try {
    expected = `sha256:${createHash('sha256')
      .update(canonicalJson(withoutHash), 'utf8')
      .digest('hex')}`;
  } catch (error) {
    throw typed('synthesis_state_invalid', 'Committed synthesis state is not canonical', false, {
      cause: error,
    });
  }
  if (state.brainStateSha256 !== expected) {
    throw typed('synthesis_state_invalid', 'Committed synthesis state hash mismatch');
  }
  return state;
}

async function readCommittedSynthesisState({
  brainDir,
  maxBytes = SYNTHESIS_OPERATION_LIMITS.maxBrainStateBytes,
  signal = null,
} = {}) {
  if (typeof brainDir !== 'string' || !path.isAbsolute(brainDir)) {
    throw typed('invalid_request', 'Absolute brain directory required');
  }
  const opened = await openConfinedRegularFile(brainDir, path.join(brainDir, 'brain-state.json'), {
    optional: true,
    maxBytes,
    signal,
  });
  if (opened === null) return null;
  try {
    const bytes = await opened.handle.readFile(signal ? { signal } : undefined);
    throwIfAborted(signal);
    await assertStableOpenedFile(opened);
    const state = JSON.parse(bytes.toString('utf8'));
    return validateCommittedSynthesisState(state);
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error?.code) throw error;
    throw typed('synthesis_state_invalid', 'Committed synthesis state is invalid', false, {
      cause: error,
    });
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

class SynthesisAgent {
  constructor({
    brainDir,
    workspacePath,
    providerAdapter = null,
    startSynthesisOperation = null,
    intervalHours = 4,
    logger = null,
    limits = {},
    clock = {},
    hooks = {},
    durableWriter = writeFileDurable,
    timers = {},
  } = {}) {
    if (typeof brainDir !== 'string' || !path.isAbsolute(brainDir)
        || typeof workspacePath !== 'string' || !path.isAbsolute(workspacePath)) {
      throw typed('synthesis_configuration_invalid', 'Brain and workspace paths are required');
    }
    this.brainDir = path.resolve(brainDir);
    this.workspacePath = path.resolve(workspacePath);
    this.statePath = path.join(this.brainDir, 'brain-state.json');
    this.providerAdapter = providerAdapter;
    this.startSynthesisOperation = startSynthesisOperation;
    this.intervalHours = Number(intervalHours);
    if (!Number.isFinite(this.intervalHours) || this.intervalHours <= 0 || this.intervalHours > 720) {
      throw typed('synthesis_configuration_invalid', 'Invalid synthesis interval');
    }
    this.logger = logger;
    this.limits = validateLimits(limits);
    this.now = typeof clock.now === 'function' ? clock.now : Date.now;
    this.hooks = hooks && typeof hooks === 'object' ? hooks : {};
    this.durableWriter = durableWriter;
    this.setTimeout = timers.setTimeout || setTimeout;
    this.clearTimeout = timers.clearTimeout || clearTimeout;
    this.setInterval = timers.setInterval || setInterval;
    this.clearInterval = timers.clearInterval || clearInterval;
    this.running = false;
    this._timer = null;
    this._startupTimer = null;
  }

  async _checkpoint(name, context = {}) {
    throwIfAborted(context.signal);
    if (typeof this.hooks[name] === 'function') await this.hooks[name](context);
    throwIfAborted(context.signal);
  }

  async _validateSourcePin(sourcePin, signal) {
    if (!sourcePin || typeof sourcePin.summarize !== 'function'
        || typeof sourcePin.searchKeyword !== 'function'
        || typeof sourcePin.compareAndSwap !== 'function') {
      throw typed('source_pin_required', 'Writable own-brain source pin required');
    }
    const descriptor = sourcePin.descriptor;
    const canonicalBrain = await fsp.realpath(this.brainDir).catch((error) => {
      throw typed('source_unavailable', 'Canonical brain directory is unavailable', true, {
        cause: error,
      });
    });
    if (!descriptor || descriptor.version !== 1
        || descriptor.canonicalRoot !== canonicalBrain
        || sourcePin.revision !== descriptor.cutoffRevision) {
      throw typed('source_changed', 'Synthesis source pin does not match the own brain', true);
    }
    safeInteger(sourcePin.revision, 'revision');
    throwIfAborted(signal);
    return descriptor;
  }

  async _readWorkspaceInputs(signal) {
    let remaining = this.limits.maxPromptBytes;
    const files = {};
    for (const fileName of ['SOUL.md', 'MISSION.md', 'BRAIN_INDEX.md']) {
      const value = await readBoundedWorkspaceFile({
        workspacePath: this.workspacePath,
        fileName,
        maxBytes: remaining,
        signal,
      });
      remaining -= value.bytes;
      files[fileName] = value.text;
    }
    return files;
  }

  async _summarizeSource(sourcePin, descriptor, signal) {
    throwIfAborted(signal);
    const summary = await sourcePin.summarize({ signal });
    throwIfAborted(signal);
    const expected = descriptor.summary || {};
    const normalized = {
      nodes: safeInteger(summary?.nodes, 'node count'),
      edges: safeInteger(summary?.edges, 'edge count'),
      clusters: safeInteger(summary?.clusters, 'cluster count'),
    };
    if (normalized.nodes !== safeInteger(expected.nodeCount, 'descriptor node count')
        || normalized.edges !== safeInteger(expected.edgeCount, 'descriptor edge count')
        || normalized.clusters !== safeInteger(expected.clusterCount, 'descriptor cluster count')) {
      throw typed('source_changed', 'Pinned source summary does not match its descriptor', true);
    }
    return normalized;
  }

  async _searchPinnedThemes(sourcePin, themes, signal) {
    const sections = [];
    for (const theme of themes.slice(0, MAX_SEARCH_THEMES)) {
      throwIfAborted(signal);
      const response = await sourcePin.searchKeyword({
        query: theme,
        topK: MAX_SEARCH_RESULTS_PER_THEME,
        signal,
      });
      throwIfAborted(signal);
      if (!response || !Array.isArray(response.results)
          || response.results.length > MAX_SEARCH_RESULTS_PER_THEME) {
        throw typed('source_changed', 'Pinned keyword search returned an invalid result', true);
      }
      if (response.results.length === 0) continue;
      const lines = [`### ${theme}`];
      for (const [index, result] of response.results.entries()) {
        if (!result || Array.isArray(result) || typeof result !== 'object') {
          throw typed('source_changed', 'Pinned keyword result is invalid', true);
        }
        const id = boundedText(result.id ?? `result-${index + 1}`, 'search result id', 1024);
        const concept = boundedText(result.concept ?? '', 'search result concept', 4096);
        lines.push(`- [${id}] ${concept}`);
      }
      sections.push(lines.join('\n'));
    }
    return sections;
  }

  _buildPrompt({ identity, indexDigest, sections, summary }) {
    const writer = new Utf8BudgetWriter(
      this.limits.maxPromptBytes,
      Buffer.byteLength(PROVIDER_INSTRUCTIONS, 'utf8'),
    );
    writer.append('Brain identity:\n---\n')
      .append(identity || '(no identity files found)')
      .append('\n---\n\nBrain knowledge index summary:\n---\n')
      .append(indexDigest || '(no compiled documents yet)')
      .append('\n---\n\nRepresentative pinned brain nodes:\n---\n');
    for (const section of sections) writer.append(section).append('\n\n');
    if (sections.length === 0) writer.append('(no matching keyword evidence)\n');
    writer.append('---\n\nPinned brain stats: ')
      .append(`${summary.nodes} nodes, ${summary.edges} edges, ${summary.clusters} clusters`)
      .append('\nPinned source evidence is authoritative only at the stated revision.\n\n')
      .append(RESPONSE_SCHEMA);
    return writer.toString();
  }

  async runOperation({ operationId, trigger = 'manual', sourcePin, signal = null, onEvent = null } = {}) {
    assertOperationId(operationId);
    const normalizedTrigger = exactTrigger(trigger);
    if (!this.providerAdapter || typeof this.providerAdapter.generate !== 'function') {
      throw typed('synthesis_unavailable', 'Synthesis provider is unavailable', true);
    }
    const provider = boundedText(this.providerAdapter.provider, 'provider', 256);
    const model = boundedText(this.providerAdapter.model, 'model', 256);
    const providerStallMs = this.providerAdapter.capabilities?.providerStallMs;
    if (!Number.isSafeInteger(providerStallMs) || providerStallMs <= 0) {
      throw typed('model_capability_invalid', 'Synthesis provider stall capability is invalid');
    }

    const startedAt = this.now();
    throwIfAborted(signal);
    const descriptor = await this._validateSourcePin(sourcePin, signal);
    const files = await this._readWorkspaceInputs(signal);
    const identity = [files['SOUL.md'], files['MISSION.md']].filter(Boolean).join('\n\n---\n\n');
    const index = files['BRAIN_INDEX.md'];
    const indexDigest = this._buildIndexDigest(index);
    const summary = await this._summarizeSource(sourcePin, descriptor, signal);
    await this._checkpoint('afterSummarize', { signal, sourcePin, summary });
    const themes = this._collectSearchThemes(index).slice(0, MAX_SEARCH_THEMES);
    const sections = await this._searchPinnedThemes(sourcePin, themes, signal);
    const input = this._buildPrompt({ identity, indexDigest, sections, summary });
    await this._checkpoint('beforeProvider', { signal, sourcePin });

    const emit = async (event) => {
      if (typeof onEvent === 'function') await onEvent(Object.freeze(event));
    };
    await emit({
      type: 'provider_selected',
      phase: 'synthesis',
      provider,
      model,
      providerStallMs,
      providerCallId: PROVIDER_CALL_ID,
      sourceRevision: sourcePin.revision,
    });
    throwIfAborted(signal);

    let outcome = 'failed';
    let completion;
    try {
      const raw = await this.providerAdapter.generate({
        instructions: PROVIDER_INSTRUCTIONS,
        input,
        signal,
        onProviderActivity: (child = {}) => {
          throwIfAborted(signal);
          if (typeof onEvent === 'function') {
            const returned = onEvent(Object.freeze({
              type: 'provider_activity',
              phase: 'synthesis',
              provider,
              model,
              providerCallId: PROVIDER_CALL_ID,
              childEventType: eventText(child?.type, 'provider_event'),
              providerEventAt: providerEventAt(child?.at),
              sourceRevision: sourcePin.revision,
            }));
            if (returned && typeof returned.then === 'function') {
              returned.catch(() => {});
              throw typed('worker_event_invalid', 'Provider activity sink must be synchronous');
            }
          }
        },
      });
      throwIfAborted(signal);
      await this._checkpoint('beforeCompletionValidation', { signal, sourcePin, raw });
      completion = requireCompleteProviderResult(raw);
      throwIfAborted(signal);
      outcome = 'complete';
    } catch (error) {
      if (signal?.aborted) {
        outcome = 'cancelled';
        throw signal.reason;
      }
      throw error;
    } finally {
      await emit({
        type: 'provider_call_terminal',
        phase: 'synthesis',
        provider,
        model,
        providerCallId: PROVIDER_CALL_ID,
        outcome,
      });
    }

    const providerOutputBytes = Buffer.byteLength(completion.content, 'utf8');
    if (providerOutputBytes > this.limits.maxProviderOutputBytes) {
      throw tooLarge('provider_output', this.limits.maxProviderOutputBytes);
    }
    await this._checkpoint('beforeJsonExtract', { signal, sourcePin, completion });
    throwIfAborted(signal);
    const synthesis = normalizeSynthesis(extractJsonObject(completion.content));
    throwIfAborted(signal);

    const generatedAt = new Date(this.now()).toISOString();
    const durationMs = Math.max(0, Math.floor(this.now() - startedAt));
    const markerDigest = createHash('sha256')
      .update(operationId, 'utf8')
      .update('\0', 'utf8')
      .update(generatedAt, 'utf8')
      .update('\0', 'utf8')
      .update(provider, 'utf8')
      .update('\0', 'utf8')
      .update(model, 'utf8')
      .digest('hex')
      .slice(0, 24);
    const generationMarker = `generation-${sourcePin.revision}-${markerDigest}`;
    const stateWithoutHash = {
      generatedAt,
      generationMarker,
      operationId,
      trigger: normalizedTrigger,
      sourceRevision: sourcePin.revision,
      provider,
      model,
      durationMs,
      brainStats: {
        nodes: summary.nodes,
        edges: summary.edges,
        clusters: summary.clusters,
        documentsCompiled: this._countCompiledDocs(index),
      },
      selfUnderstanding: synthesis.selfUnderstanding,
      consolidatedInsights: synthesis.consolidatedInsights,
      knowledgeIndex: indexDigest,
      recentActivity: synthesis.recentActivity,
    };
    const brainStateSha256 = `sha256:${createHash('sha256')
      .update(canonicalJson(stateWithoutHash), 'utf8')
      .digest('hex')}`;
    const brainState = { ...stateWithoutHash, brainStateSha256 };
    const serialized = `${canonicalJson(brainState)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > this.limits.maxBrainStateBytes) {
      throw tooLarge('brain_state', this.limits.maxBrainStateBytes);
    }

    await this._checkpoint('beforeCompareAndSwap', { signal, sourcePin, brainState });
    throwIfAborted(signal);
    const committed = await sourcePin.compareAndSwap(async () => {
      throwIfAborted(signal);
      await this._checkpoint('insideCompareAndSwap', { signal, sourcePin, brainState });
      throwIfAborted(signal);
      return this.durableWriter(this.statePath, serialized, { encoding: 'utf8', mode: 0o600 });
    });
    if (!committed || committed.committed !== true) {
      throw typed('source_changed', 'Pinned source changed before synthesis commit', true);
    }
    throwIfAborted(signal);

    return Object.freeze({
      generationMarker,
      generatedAt,
      sourceRevision: sourcePin.revision,
      provider,
      model,
      operationId,
      brainStateSha256,
    });
  }

  async run(trigger = 'manual') {
    if (typeof this.startSynthesisOperation !== 'function') {
      throw typed('synthesis_unavailable', 'Durable synthesis coordinator is unavailable', true);
    }
    if (this.running) return null;
    this.running = true;
    try {
      return await this.startSynthesisOperation({ trigger: exactTrigger(trigger) });
    } finally {
      this.running = false;
    }
  }

  startSchedule({ runOnStart = true } = {}) {
    const schedule = (trigger) => {
      void this.run(trigger).catch((error) => {
        this.logger?.error?.('[synthesis] scheduled start failed', {
          code: error?.code || 'synthesis_failed',
          message: error?.message || 'synthesis failed',
        });
      });
    };
    if (runOnStart) this._startupTimer = this.setTimeout(() => schedule('startup'), 30_000);
    this._timer = this.setInterval(() => schedule('scheduled'), this.intervalHours * 60 * 60 * 1000);
  }

  stopSchedule() {
    if (this._startupTimer) this.clearTimeout(this._startupTimer);
    if (this._timer) this.clearInterval(this._timer);
    this._startupTimer = null;
    this._timer = null;
  }

  getState() {
    try {
      const stat = fs.lstatSync(this.statePath);
      if (!stat.isFile() || stat.isSymbolicLink()
          || stat.size > this.limits.maxBrainStateBytes) return null;
      const state = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      return state && !Array.isArray(state) && typeof state === 'object' ? state : null;
    } catch {
      return null;
    }
  }

  _collectSearchThemes(index) {
    const themes = [
      'direct user conversation jtr current request',
      'Home23 Good Life agency current direction',
      'brain cleanup memory retrieval consolidation salience',
      'recent state snapshot current correction',
    ];
    const seen = new Set(themes.map((theme) => theme.toLocaleLowerCase('en-US')));
    if (!index) return themes;
    for (const line of index.split(/\r?\n/)) {
      if (!line.startsWith('## ')) continue;
      const theme = line
        .replace(/^##\s+/, '')
        .replace(/[`*_]/g, '')
        .replace(/Compiled from:.*/, '')
        .trim();
      const key = theme.toLocaleLowerCase('en-US');
      if (!theme || theme.length <= 2 || theme.startsWith('Compiled') || seen.has(key)) continue;
      if (Buffer.byteLength(theme, 'utf8') > MAX_THEME_BYTES) continue;
      themes.push(theme);
      seen.add(key);
      if (themes.length >= 64) break;
    }
    return themes;
  }

  _buildIndexDigest(index) {
    if (!index) return '';
    const lines = index.split(/\r?\n/);
    const header = lines.filter((line) =>
      /documents compiled:/i.test(line)
      || /last updated:/i.test(line)
      || /^#\s+/.test(line)).slice(0, 12);
    const headingCounts = new Map();
    for (const line of lines) {
      if (!line.startsWith('## ')) continue;
      const heading = line
        .replace(/^##\s+/, '')
        .replace(/[`*_]/g, '')
        .replace(/Compiled from:.*/, '')
        .trim();
      if (!heading || heading.startsWith('Compiled')
          || Buffer.byteLength(heading, 'utf8') > MAX_THEME_BYTES) continue;
      headingCounts.set(heading, (headingCounts.get(heading) || 0) + 1);
    }
    const headings = Array.from(headingCounts.entries())
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 40)
      .map(([heading, count]) => `- ${heading} (${count} index sections)`);
    return [
      ...header,
      '',
      'Index section counts only. Counts are not salience and are not current obsession evidence:',
      ...headings,
    ].join('\n').trim();
  }

  _countCompiledDocs(index) {
    if (!index) return 0;
    const match = index.match(/Documents compiled: (\d+)/);
    if (!match) return 0;
    const count = Number(match[1]);
    return Number.isSafeInteger(count) && count >= 0 ? count : 0;
  }
}

module.exports = {
  PROVIDER_CALL_ID,
  SynthesisAgent,
  Utf8BudgetWriter,
  extractJsonObject,
  normalizeSynthesis,
  readCommittedSynthesisState,
  validateCommittedSynthesisState,
};
