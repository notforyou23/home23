import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";

import { ContextManager } from "../../agent/context.js";
import { ConversationHistory } from "../../agent/history.js";
import { AgentLoop } from "../../agent/loop.js";
import {
  resolveModelOverride,
  type ModelAliases,
} from "../../agent/model-resolution.js";
import {
  DEFAULT_REASONING_EFFORT,
  REASONING_EFFORTS,
  type ReasoningEffort,
} from "../../agent/reasoning-effort.js";
import { createSeededToolRegistry } from "../../agent/tools/index.js";
import { generateImageTool, generateMusicTool } from "../../agent/tools/media.js";
import {
  canonicalReturnedArtifactDirectory,
  returnArtifactTool,
} from "../../agent/tools/return-artifact.js";
import type { AgentEvent, AgentResponse, ToolContext } from "../../agent/types.js";
import type { MediaAttachment } from "../../types.js";
import {
  detectReturnedArtifactContentType,
  isReturnedArtifactGenerator,
  MAX_RETURNED_ARTIFACT_BYTES,
  RETURNED_ARTIFACT_CONTENT_TYPES,
  returnedArtifactMediaType,
} from "../../returned-artifacts.js";
import { resolveProviderKey } from "../../agent/provider-credentials.js";
import { loadHomeConfig } from "../../config.js";
import { TurnStore } from "../../chat/turn-store.js";
import { isTurnEnvelope, type TurnEnvelope } from "../../chat/turn-types.js";
import type {
  ResidentAgentPort,
  ResidentDurableEvent,
  ResidentDurableTerminal,
  ResidentArtifactPromotionPort,
  ResidentInputAttachment,
  ResidentRun,
} from "../../coordination-adapter/index.js";
import type {
  ResidentModelCatalog,
  ResidentTurnSelectionReceipt,
  ResidentTurnSelectionRequest,
} from "../../coordination-adapter/types.js";
import {
  BOT_TURN_EVIDENCE_TAXONOMY,
  ResidentCoordinationAdapter,
  createM11ResidentCoordinationPort,
  type ResidentCommunicationPort,
} from "../../coordination-adapter/index.js";
import type { BotDirectoryRecord } from "../bots/index.js";
import { assertCoordinationId } from "../ids/index.js";
import type { CoordinationLeasePort } from "./types.js";
import type {
  DirectMessageExecutionTarget,
  DirectMessageExecutionRequest,
  DirectMessageHistoryEntry,
  DirectMessageTargetDescriptor,
} from "./direct-message.js";

const PERMANENT_RESIDENTS = new Set(["jerry", "forrest"]);
const ON_DEMAND_BOT_MESSAGE_CAPABILITIES = Object.freeze(["messages"] as const);
const ON_DEMAND_BOT_ATTACHMENT_CAPABILITIES = Object.freeze(["attachments", "messages"] as const);
const TURN_PREFIX = "coord-";

export interface OnDemandBotModelConfiguration {
  defaultModel: string;
  defaultProvider: string;
  defaultReasoningEffort: ReasoningEffort;
  modelAliases: Readonly<ModelAliases>;
  modelReasoningEfforts?: Record<string, ReasoningEffort>;
  apiKey: string;
  baseURL?: string;
  providerMap?: Record<string, { apiKey: string; baseURL?: string }>;
  maxTokens: number;
  temperature: number;
  historyBudget: number;
  sessionGapMs: number;
  enginePort: number;
  cosmo23BaseUrl: string;
}

export interface OnDemandBotRuntimeOptions {
  botsRootDirectory: string;
  bots: {
    getBotById(botId: string): Promise<BotDirectoryRecord | null>;
  };
  leases: CoordinationLeasePort;
  communications?: ResidentCommunicationPort;
  artifactPromotion?: (bot: BotDirectoryRecord) => ResidentArtifactPromotionPort;
  /** Canonical content-addressed store; paths never enter product Messages or model text. */
  inputAttachmentRoot?: string;
  loadModelConfiguration?: () => OnDemandBotModelConfiguration;
}

const MAX_RETURNED_ARTIFACTS = 10;
const MAX_RETURNED_ARTIFACT_CAPTION_BYTES = 2_048;
const INPUT_ATTACHMENT_CONTENT_TYPES = new Set<string>(RETURNED_ARTIFACT_CONTENT_TYPES);

function canonicalInputAttachmentRoot(configuredRoot: string): string {
  if (!isAbsolute(configuredRoot) || configuredRoot === "/" || configuredRoot.includes("\0")) {
    throw new Error("on-demand Bot attachment root is invalid");
  }
  try {
    const root = resolve(configuredRoot);
    const entry = lstatSync(root);
    const canonical = realpathSync(root);
    const allowedMacSystemAlias = root.startsWith("/var/") && canonical === `/private${root}`;
    if (
      !entry.isDirectory() || entry.isSymbolicLink() ||
      (canonical !== root && !allowedMacSystemAlias)
    ) {
      throw new Error("on-demand Bot attachment root is unsafe");
    }
    return canonical;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("on-demand Bot attachment")) throw error;
    throw new Error("on-demand Bot attachment root is unavailable");
  }
}

function exactOnDemandInputAttachments(
  value: readonly ResidentInputAttachment[],
  canonicalRoot: string,
  verifyBytes: boolean,
): readonly ResidentInputAttachment[] {
  if (!Array.isArray(value) || value.length > 10) {
    throw new Error("on-demand Bot attachments are invalid");
  }
  const seen = new Set<string>();
  return Object.freeze(value.map((attachment) => {
    try {
      try {
        assertCoordinationId("artifact", attachment.artifactId);
      } catch {
        throw new Error("on-demand Bot attachment identity is invalid");
      }
      if (
        seen.has(attachment.artifactId) ||
        typeof attachment.name !== "string" || attachment.name.length < 1 ||
        attachment.name.length > 255 || attachment.name.normalize("NFC") !== attachment.name ||
        attachment.name === "." || attachment.name === ".." ||
        /^[A-Za-z]:/u.test(attachment.name) || /[\0-\x1f\x7f/\\]/u.test(attachment.name) ||
        typeof attachment.contentType !== "string" ||
        !INPUT_ATTACHMENT_CONTENT_TYPES.has(attachment.contentType) ||
        !Number.isSafeInteger(attachment.byteCount) || attachment.byteCount < 0 ||
        attachment.byteCount > MAX_RETURNED_ARTIFACT_BYTES ||
        typeof attachment.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(attachment.sha256) ||
        typeof attachment.path !== "string" || !isAbsolute(attachment.path) ||
        attachment.path.length > 4_096 || attachment.path.includes("\0")
      ) {
        throw new Error("on-demand Bot attachment metadata is invalid");
      }
      const expectedPath = join(
        canonicalRoot,
        "objects",
        "sha256",
        attachment.sha256.slice(0, 2),
        attachment.sha256.slice(2, 4),
        attachment.sha256,
      );
      const entry = lstatSync(attachment.path);
      const canonicalPath = realpathSync(attachment.path);
      if (
        canonicalPath !== expectedPath || !entry.isFile() || entry.isSymbolicLink()
      ) {
        throw new Error("on-demand Bot attachment escaped canonical storage");
      }
      if (verifyBytes) {
        const fd = openSync(attachment.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        try {
          const before = fstatSync(fd);
          if (
            !before.isFile() || before.dev !== entry.dev || before.ino !== entry.ino ||
            before.size !== attachment.byteCount
          ) {
            throw new Error("on-demand Bot attachment file is invalid");
          }
          const bytes = readFileSync(fd);
          const after = fstatSync(fd);
          const pathAfter = lstatSync(attachment.path);
          const detectedType = bytes.length === 0
            ? "text/plain"
            : detectReturnedArtifactContentType(bytes);
          if (
            bytes.length !== before.size || after.dev !== before.dev || after.ino !== before.ino ||
            after.size !== before.size || pathAfter.isSymbolicLink() ||
            pathAfter.dev !== before.dev || pathAfter.ino !== before.ino ||
            detectedType !== attachment.contentType ||
            createHash("sha256").update(bytes).digest("hex") !== attachment.sha256
          ) {
            throw new Error("on-demand Bot attachment bytes differ from canonical metadata");
          }
        } finally {
          closeSync(fd);
        }
      }
      seen.add(attachment.artifactId);
      return Object.freeze({ ...attachment, path: canonicalPath });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("on-demand Bot attachment")) throw error;
      throw new Error("on-demand Bot attachment bytes are unavailable");
    }
  }));
}

function instructionWithInputAttachments(
  instruction: string,
  attachments: readonly ResidentInputAttachment[],
): string {
  if (attachments.length === 0) return instruction;
  const manifest = attachments.map((attachment, index) =>
    `${index + 1}. name=${JSON.stringify(attachment.name)} ` +
    `type=${attachment.contentType} bytes=${attachment.byteCount} sha256=${attachment.sha256}`
  ).join("\n");
  const prefix = instruction.trim().length > 0 ? `${instruction}\n\n` : "";
  return `${prefix}[Canonical user attachments]\n${manifest}\n` +
    "Images are attached as vision input. Other admitted files are represented by this verified manifest.";
}

function exactOnDemandReturnedArtifacts(
  value: unknown,
  returnedArtifactRoot: string,
): MediaAttachment[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("on-demand Bot returned artifact descriptors are invalid");
  const candidates: Record<string, unknown>[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("on-demand Bot returned artifact descriptor is invalid");
    }
    const candidate = raw as Record<string, unknown>;
    if (isReturnedArtifactGenerator(candidate.generatedBy)) candidates.push(candidate);
  }
  if (candidates.length > MAX_RETURNED_ARTIFACTS) {
    throw new Error("on-demand Bot returned artifact limit exceeded");
  }
  const seen = new Set<string>();
  return candidates.map((candidate) => {
    const generatedBy = candidate.generatedBy;
    if (!isReturnedArtifactGenerator(generatedBy)) {
      throw new Error("on-demand Bot returned artifact generator is invalid");
    }
    const path = candidate.path;
    if (typeof path !== "string" || !isAbsolute(path) || path.length > 4_096 || path.includes("\0")) {
      throw new Error("on-demand Bot returned artifact path is invalid");
    }
    const entry = lstatSync(path);
    const canonicalPath = realpathSync(path);
    if (
      !entry.isFile() || entry.isSymbolicLink() || dirname(canonicalPath) !== returnedArtifactRoot ||
      seen.has(canonicalPath)
    ) {
      throw new Error("on-demand Bot returned artifact escaped its private output directory");
    }
    const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const before = fstatSync(fd);
      if (
        !before.isFile() || before.dev !== entry.dev || before.ino !== entry.ino ||
        before.size < 1 || before.size > MAX_RETURNED_ARTIFACT_BYTES
      ) {
        throw new Error("on-demand Bot returned artifact file is invalid");
      }
      const bytes = readFileSync(fd);
      const after = fstatSync(fd);
      const pathAfter = lstatSync(path);
      if (
        bytes.length !== before.size || after.dev !== before.dev || after.ino !== before.ino ||
        after.size !== before.size || pathAfter.isSymbolicLink() || pathAfter.dev !== before.dev ||
        pathAfter.ino !== before.ino
      ) {
        throw new Error("on-demand Bot returned artifact changed while being verified");
      }
      const contentType = detectReturnedArtifactContentType(bytes);
      const mediaType = returnedArtifactMediaType(contentType, generatedBy);
      const declaredType = candidate.type === "media" ? candidate.mediaType : candidate.type;
      const fileName = candidate.fileName;
      const caption = candidate.caption;
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (
        declaredType !== mediaType || candidate.mimeType !== contentType ||
        candidate.byteCount !== bytes.length || candidate.sha256 !== sha256 ||
        typeof fileName !== "string" || fileName !== basename(canonicalPath) ||
        fileName.normalize("NFC") !== fileName || fileName === "." || fileName === ".." ||
        /^[A-Za-z]:/u.test(fileName) || /[\0-\x1f\x7f/\\]/u.test(fileName) ||
        (caption !== undefined && (
          typeof caption !== "string" || caption.includes("\0") ||
          Buffer.byteLength(caption, "utf8") > MAX_RETURNED_ARTIFACT_CAPTION_BYTES
        ))
      ) {
        throw new Error("on-demand Bot returned artifact metadata differs from its bytes");
      }
      seen.add(canonicalPath);
      return Object.freeze({
        type: mediaType,
        generatedBy,
        path: canonicalPath,
        mimeType: contentType,
        fileName,
        byteCount: bytes.length,
        sha256,
        ...(typeof caption === "string" ? { caption } : {}),
      });
    } finally {
      closeSync(fd);
    }
  });
}

function providerDefinition(
  providers: Record<string, unknown> | undefined,
  provider: string,
): { apiKey?: string; baseUrl?: string } {
  const value = providers?.[provider];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as { apiKey?: string; baseUrl?: string }
    : {};
}

function defaultModelConfiguration(): OnDemandBotModelConfiguration {
  const config = loadHomeConfig();
  const defaultModel = config.chat.defaultModel ?? config.chat.model;
  const defaultProvider = config.chat.defaultProvider ?? config.chat.provider;
  const providers = config.providers as Record<string, unknown> | undefined;
  const configured = providerDefinition(providers, defaultProvider);
  const apiKey = defaultProvider === "ollama-local"
    ? ""
    : resolveProviderKey(defaultProvider, configured.apiKey);
  const providerMap = Object.fromEntries([
    "anthropic", "minimax", "openai", "openai-codex", "xai", "ollama-cloud",
  ].map((provider) => {
    const value = providerDefinition(providers, provider);
    return [provider, {
      apiKey: resolveProviderKey(provider, value.apiKey),
      ...(value.baseUrl ? { baseURL: value.baseUrl } : {}),
    }];
  }));
  return Object.freeze({
    defaultModel,
    defaultProvider,
    defaultReasoningEffort: config.chat.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
    modelAliases: Object.freeze({ ...(config.models?.aliases ?? {}) }),
    ...(config.models?.reasoningEffort
      ? { modelReasoningEfforts: { ...config.models.reasoningEffort } }
      : {}),
    apiKey,
    ...(configured.baseUrl ? { baseURL: configured.baseUrl } : {}),
    providerMap,
    maxTokens: Math.min(config.chat.maxTokens ?? 8192, 16_384),
    temperature: config.chat.temperature,
    historyBudget: config.chat.historyBudget ?? 200_000,
    sessionGapMs: config.chat.sessionGapMs ?? 30 * 60 * 1000,
    enginePort: config.ports?.dashboard ?? 3300,
    cosmo23BaseUrl: `http://127.0.0.1:${config.ports?.engine ?? 43210}`,
  });
}

function exactOrigin(
  left: TurnEnvelope["coordination_origin"],
  right: Parameters<ResidentAgentPort["runWithTurn"]>[2]["coordinationOrigin"],
): boolean {
  return left?.kind === right.kind &&
    left.workId === right.workId &&
    left.attemptId === right.attemptId &&
    left.leaseId === right.leaseId &&
    left.holderPrincipalId === right.holderPrincipalId &&
    left.holderInstanceId === right.holderInstanceId &&
    left.authorityReference === right.authorityReference &&
    left.fencingToken === right.fencingToken &&
    left.channelId === right.channelId &&
    left.originMessageId === right.originMessageId &&
    left.roundId === right.roundId;
}

function terminalFrom(
  store: TurnStore,
  chatId: string,
  turnId: string,
  start: TurnEnvelope,
): ResidentDurableTerminal {
  const final = store.finalEnvelope(chatId, turnId);
  if (!final?.ended_at) throw new Error("on-demand Bot turn is not durably terminal");
  const lastSequence = store.eventsSince(chatId, turnId, -1).reduce(
    (maximum, event) => Math.max(maximum, event.seq),
    0,
  );
  return Object.freeze({
    status: final.status,
    lastSequence,
    endedAt: final.ended_at,
    errorCode: final.error_code ?? null,
    errorMessage: final.error_message ?? final.error ?? null,
    provider: start.provider ?? null,
    model: start.model ?? null,
    reasoningEffort: start.reasoning_effort ?? null,
  });
}

function selectionReceipt(
  requested: ResidentTurnSelectionRequest,
  source: { provider: string; model: string; reasoningEffort: ReasoningEffort },
  requestedModel: string | null,
): ResidentTurnSelectionReceipt {
  return Object.freeze({
    requestedProvider: null,
    requestedModelAlias: requested.modelAlias,
    requestedModel,
    requestedEffort: requested.reasoningEffort,
    resolvedProvider: source.provider,
    resolvedModel: source.model,
    resolvedEffort: source.reasoningEffort,
    actualProvider: source.provider,
    actualModel: source.model,
    actualEffort: source.reasoningEffort,
  });
}

function modelCatalog(
  config: OnDemandBotModelConfiguration,
  acceptsAttachments = false,
): ResidentModelCatalog {
  return Object.freeze({
    capabilities: acceptsAttachments
      ? ON_DEMAND_BOT_ATTACHMENT_CAPABILITIES
      : ON_DEMAND_BOT_MESSAGE_CAPABILITIES,
    models: Object.freeze(Object.entries(config.modelAliases)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([alias, value]) => Object.freeze({
        alias,
        provider: value.provider,
        model: value.model,
        reasoningEffort: value.reasoningEffort ?? null,
      }))),
    defaultModel: config.defaultModel,
    defaultProvider: config.defaultProvider,
    defaultReasoningEffort: config.defaultReasoningEffort,
    reasoningEfforts: REASONING_EFFORTS,
  });
}

class OnDemandBotAgentPort implements ResidentAgentPort {
  private readonly store: TurnStore;
  private readonly active = new Map<string, { chatId: string; turnId: string }>();

  constructor(
    private readonly bot: BotDirectoryRecord,
    private readonly agent: AgentLoop,
    private readonly history: ConversationHistory,
    private readonly config: OnDemandBotModelConfiguration,
    private readonly returnedArtifactRoot: string,
    private readonly inputAttachmentRoot: string | null,
  ) {
    this.store = new TurnStore(history);
  }

  async modelCatalog(): Promise<ResidentModelCatalog> {
    return modelCatalog(this.config, this.inputAttachmentRoot !== null);
  }

  private chatId(channelId: string): string {
    return `on-demand:${this.bot.id}:${channelId}`;
  }

  backfillCanonicalHistory(
    channelId: string,
    entries: readonly DirectMessageHistoryEntry[],
  ): void {
    const chatId = this.chatId(channelId);
    if (this.history.load(chatId).some((record) => "role" in record)) return;
    let priorSequence = 0;
    for (const entry of entries) {
      assertCoordinationId("message", entry.messageId);
      if (
        !Number.isSafeInteger(entry.sequence) || entry.sequence <= priorSequence ||
        (entry.role !== "user" && entry.role !== "assistant") ||
        typeof entry.text !== "string" || Number.isNaN(new Date(entry.createdAt).valueOf())
      ) {
        throw new Error("canonical Bot history backfill is invalid");
      }
      priorSequence = entry.sequence;
    }
    if (entries.length === 0) return;
    this.history.append(chatId, entries.map((entry) => ({
      role: entry.role,
      content: entry.text,
      ts: entry.createdAt,
    })));
  }

  private turnIds(chatId: string, workId: string): string[] {
    const base = `${TURN_PREFIX}${workId}`;
    const pattern = new RegExp(`^${base}(?:-recovery-[1-9][0-9]*)?$`);
    const ids = new Set<string>();
    for (const record of this.history.loadRaw(chatId)) {
      if (isTurnEnvelope(record) && pattern.test(record.turn_id)) ids.add(record.turn_id);
    }
    return [...ids].sort((left, right) => {
      if (left === base) return -1;
      if (right === base) return 1;
      return Number(left.slice(left.lastIndexOf("-") + 1)) -
        Number(right.slice(right.lastIndexOf("-") + 1));
    });
  }

  private completed(
    chatId: string,
    workId: string,
    origin: Parameters<ResidentAgentPort["runWithTurn"]>[2]["coordinationOrigin"],
  ): { turnId: string; start: TurnEnvelope; final: TurnEnvelope } | null {
    for (const turnId of this.turnIds(chatId, workId).reverse()) {
      const start = this.store.startEnvelope(chatId, turnId);
      const final = this.store.finalEnvelope(chatId, turnId);
      if (
        start && exactOrigin(start.coordination_origin, origin) &&
        final?.status === "complete" && typeof final.assistant_content === "string"
      ) {
        return { turnId, start, final };
      }
    }
    return null;
  }

  private returnedArtifacts(chatId: string, turnId: string): MediaAttachment[] {
    return exactOnDemandReturnedArtifacts(
      this.store.eventsSince(chatId, turnId, -1)
        .filter((event) => event.kind === "media")
        .map((event) => event.data),
      this.returnedArtifactRoot,
    );
  }

  private resolvedSelection(requested: ResidentTurnSelectionRequest): {
    source: { provider: string; model: string; reasoningEffort: ReasoningEffort };
    modelOverride?: { provider: string; model: string; reasoningEffort?: ReasoningEffort };
    receipt: ResidentTurnSelectionReceipt;
  } {
    const selectedModel = requested.modelAlias === null
      ? undefined
      : resolveModelOverride(requested.modelAlias, this.config.modelAliases) ?? undefined;
    if (requested.modelAlias !== null && !selectedModel) {
      throw new Error("requested on-demand Bot model is unavailable");
    }
    const modelOverride = selectedModel
      ? {
          model: selectedModel.model,
          provider: selectedModel.provider ?? this.config.defaultProvider,
          ...(selectedModel.reasoningEffort
            ? { reasoningEffort: selectedModel.reasoningEffort }
            : {}),
        }
      : undefined;
    const source = {
      provider: modelOverride?.provider ?? this.config.defaultProvider,
      model: modelOverride?.model ?? this.config.defaultModel,
      reasoningEffort: requested.reasoningEffort ?? modelOverride?.reasoningEffort ??
        this.config.modelReasoningEfforts?.[modelOverride?.model ?? this.config.defaultModel] ??
        this.config.defaultReasoningEffort,
    };
    return {
      source,
      ...(modelOverride ? { modelOverride } : {}),
      receipt: selectionReceipt(
        requested,
        source,
        requested.modelAlias === null ? null : modelOverride?.model ?? null,
      ),
    };
  }

  async runWithTurn(
    _chatId: string,
    userText: string,
    options: Parameters<ResidentAgentPort["runWithTurn"]>[2],
  ) {
    const origin = options.coordinationOrigin;
    const rawAttachments = options.attachments ?? [];
    if (rawAttachments.length > 0 && this.inputAttachmentRoot === null) {
      throw new Error("processless Bot attachments are unavailable");
    }
    const attachments = this.inputAttachmentRoot === null
      ? Object.freeze([])
      : exactOnDemandInputAttachments(rawAttachments, this.inputAttachmentRoot, true);
    const instruction = instructionWithInputAttachments(userText, attachments);
    const vision = attachments
      .filter((attachment) => attachment.contentType.startsWith("image/"))
      .map((attachment) => Object.freeze({
        type: "image" as const,
        path: attachment.path,
        mimeType: attachment.contentType,
        fileName: attachment.name,
      }));
    if (
      origin.authorityReference !== `bot:${this.bot.id}` ||
      origin.holderPrincipalId !== this.bot.principalId
    ) {
      throw new Error("on-demand Bot Work authority does not match its identity");
    }
    const chatId = this.chatId(origin.channelId);
    const requested = options.turnSelection ?? { modelAlias: null, reasoningEffort: null };
    const resolved = this.resolvedSelection(requested);
    const prior = this.completed(chatId, origin.workId, origin);
    if (prior) {
      await options.onDurableStart({
        turnId: prior.turnId,
        chatId,
        persistedAt: prior.start.started_at,
        selection: selectionReceipt(requested, {
          provider: prior.start.provider ?? resolved.source.provider,
          model: prior.start.model ?? resolved.source.model,
          reasoningEffort: prior.start.reasoning_effort ?? resolved.source.reasoningEffort,
        }, requested.modelAlias === null ? null : prior.start.model ?? resolved.source.model),
      });
      for (const event of this.store.eventsSince(chatId, prior.turnId, -1)) {
        options.onEvent(Object.freeze({
          turnId: prior.turnId,
          sequence: event.seq,
          occurredAt: event.ts,
          provider: prior.start.provider ?? null,
          model: prior.start.model ?? null,
          reasoningEffort: prior.start.reasoning_effort ?? null,
          event: Object.freeze({ ...(event.data as unknown as AgentEvent) }),
        }));
      }
      const media = this.returnedArtifacts(chatId, prior.turnId);
      const response: AgentResponse = Object.freeze({
        text: prior.final.assistant_content!,
        model: prior.start.model ?? "recovered",
        toolCallCount: 0,
        durationMs: 0,
        ...(media.length > 0 ? { media } : {}),
      });
      return Object.freeze({
        turnId: prior.turnId,
        response: Promise.resolve(response),
        terminal: Promise.resolve(terminalFrom(this.store, chatId, prior.turnId, prior.start)),
        selection: resolved.receipt,
      });
    }
    if (options.completedRecovery === true) {
      throw new Error("completed on-demand Bot recovery has no durable answer");
    }

    const priorTurnIds = this.turnIds(chatId, origin.workId);
    const turnId = priorTurnIds.length === 0
      ? `${TURN_PREFIX}${origin.workId}`
      : `${TURN_PREFIX}${origin.workId}-recovery-${priorTurnIds.length}`;
    let sequence = 0;
    const started = await this.agent.runWithTurn(
      chatId,
      instruction,
      {
        turnId,
        coordinationOrigin: origin,
        ...(vision.length > 0 ? { media: vision } : {}),
        ...(resolved.modelOverride ? { modelOverride: resolved.modelOverride } : {}),
        ...(requested.reasoningEffort ? { effort: requested.reasoningEffort } : {}),
        onDurableStart: async (start) => options.onDurableStart({
          ...start,
          persistedAt: this.store.startEnvelope(chatId, turnId)?.started_at ?? start.persistedAt,
          selection: resolved.receipt,
        }),
        onEvent: (event) => {
          const eventSequence = ++sequence;
          const durable = this.store.eventsSince(chatId, turnId, eventSequence - 1)
            .find((candidate) => candidate.seq === eventSequence);
          options.onEvent(Object.freeze({
            turnId,
            sequence: eventSequence,
            occurredAt: durable?.ts ?? new Date().toISOString(),
            provider: resolved.source.provider,
            model: resolved.source.model,
            reasoningEffort: resolved.source.reasoningEffort,
            event,
          } satisfies ResidentDurableEvent));
        },
      },
    );
    this.active.set(origin.workId, { chatId, turnId });
    const response = started.response.then((result) => {
      const media = exactOnDemandReturnedArtifacts(result.media, this.returnedArtifactRoot);
      const { media: _unverifiedMedia, ...safeResult } = result;
      return Object.freeze({
        ...safeResult,
        ...(media.length > 0 ? { media } : {}),
      });
    }).finally(() => this.active.delete(origin.workId));
    const terminal = response.then(
      () => terminalFrom(this.store, chatId, turnId,
        this.store.startEnvelope(chatId, turnId)!),
      () => terminalFrom(this.store, chatId, turnId,
        this.store.startEnvelope(chatId, turnId)!),
    );
    return Object.freeze({
      turnId,
      response,
      terminal,
      selection: resolved.receipt,
    });
  }

  stop(_chatId: string, turnId: string): { stopped: boolean } {
    const active = [...this.active.values()].find((candidate) => candidate.turnId === turnId);
    return active ? this.agent.stop(active.chatId, active.turnId) : { stopped: false };
  }
}

function ensureBotRoot(rootDirectory: string, botId: string): string {
  assertCoordinationId("bot", botId);
  if (!isAbsolute(rootDirectory) || rootDirectory === "/" || rootDirectory.includes("\0")) {
    throw new Error("on-demand Bot root must be an absolute dedicated directory");
  }
  mkdirSync(rootDirectory, { recursive: true, mode: 0o700 });
  const rootEntry = lstatSync(rootDirectory);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
    throw new Error("on-demand Bot root is not a real directory");
  }
  const canonicalRoot = realpathSync(rootDirectory);
  const botRoot = resolve(canonicalRoot, botId);
  if (!botRoot.startsWith(`${canonicalRoot}${sep}`)) {
    throw new Error("on-demand Bot root escaped its namespace");
  }
  if (!existsSync(botRoot)) mkdirSync(botRoot, { mode: 0o700 });
  const botEntry = lstatSync(botRoot);
  if (
    !botEntry.isDirectory() || botEntry.isSymbolicLink() ||
    realpathSync(botRoot) !== botRoot
  ) {
    throw new Error("on-demand Bot identity directory is unsafe");
  }
  return botRoot;
}

function ensurePrivateDirectory(parent: string, name: string): string {
  const directory = join(parent, name);
  if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
  const entry = lstatSync(directory);
  if (
    !entry.isDirectory() || entry.isSymbolicLink() ||
    realpathSync(directory) !== directory
  ) {
    throw new Error("on-demand Bot private directory is unsafe");
  }
  return directory;
}

function ensureIdentityFile(path: string, bot: BotDirectoryRecord): void {
  if (!existsSync(path)) {
    writeFileSync(path, identityDocument(bot), { flag: "wx", mode: 0o600 });
  }
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink() || realpathSync(path) !== path) {
    throw new Error("on-demand Bot identity file is unsafe");
  }
}

function identityDocument(bot: BotDirectoryRecord): string {
  return [
    "# Identity",
    "",
    `You are ${bot.name}, a deliberately created Home23 Bot.`,
    "You are not Jerry or Forrest and must never claim either house resident's identity or memory.",
    "Your durable conversation, workspace, history, and memory belong only to your own Bot ID.",
    "",
    "## Purpose",
    "",
    bot.purpose,
    "",
  ].join("\n");
}

function assertOnDemandBot(
  bot: BotDirectoryRecord | null,
  descriptor: DirectMessageTargetDescriptor,
): asserts bot is BotDirectoryRecord {
  if (
    !bot || bot.id !== descriptor.targetBotId ||
    bot.principalId !== descriptor.targetPrincipalId ||
    bot.residentBinding !== descriptor.residentBinding ||
    PERMANENT_RESIDENTS.has(bot.residentBinding) ||
    !bot.residentBinding.startsWith("bot-") ||
    bot.lifecycle !== "active" || !bot.continuingIdentity || !bot.durableMailbox ||
    bot.conversationId !== descriptor.conversationId ||
    !bot.requiredCapabilities.includes("messages") ||
    bot.activeInstanceId !== null || bot.activeKeyVersion !== null ||
    bot.residentProtocolVersion !== null || bot.residentRegisteredAt !== null ||
    bot.residentCapabilities.length !== 0
  ) {
    throw new Error("direct-message Bot is not an active processless identity");
  }
}

/** Core-owned lazy runtime. Construction has no process, timer, or workspace side effect. */
export function createOnDemandBotRuntime(options: OnDemandBotRuntimeOptions) {
  const targets = new Map<string, { version: number; target: DirectMessageExecutionTarget }>();
  const modelConfiguration = options.loadModelConfiguration ?? defaultModelConfiguration;
  const inputAttachmentsEnabled = options.artifactPromotion !== undefined &&
    options.inputAttachmentRoot !== undefined;
  let resolvedInputAttachmentRoot: string | null | undefined;
  const inputAttachmentRoot = () => {
    if (!inputAttachmentsEnabled) return null;
    resolvedInputAttachmentRoot ??= canonicalInputAttachmentRoot(options.inputAttachmentRoot!);
    return resolvedInputAttachmentRoot;
  };

  return Object.freeze({
    async resolve(descriptor: DirectMessageTargetDescriptor): Promise<DirectMessageExecutionTarget | undefined> {
      if (PERMANENT_RESIDENTS.has(descriptor.residentBinding)) return undefined;
      const bot = await options.bots.getBotById(descriptor.targetBotId);
      assertOnDemandBot(bot, descriptor);
      const cached = targets.get(bot.id);
      if (cached?.version === bot.version) return cached.target;

      const config = modelConfiguration();
      let executionRuntime: {
        adapter: ResidentCoordinationAdapter;
        port: OnDemandBotAgentPort;
      } | null = null;
      const requireExecutionRuntime = () => {
        if (executionRuntime) return executionRuntime;
        const botRoot = ensureBotRoot(options.botsRootDirectory, bot.id);
        const workspacePath = ensurePrivateDirectory(botRoot, "workspace");
        const statePath = ensurePrivateDirectory(botRoot, "state");
        const historyPath = ensurePrivateDirectory(statePath, "history");
        const tempDir = ensurePrivateDirectory(botRoot, "tmp");
        ensurePrivateDirectory(botRoot, "brain");
        ensurePrivateDirectory(botRoot, "substrate");
        const identityPath = join(workspacePath, "IDENTITY.md");
        ensureIdentityFile(identityPath, bot);

        const contextManager = new ContextManager({
          workspacePath,
          identityFiles: ["IDENTITY.md"],
          identityLayers: [{ basePath: workspacePath, files: ["IDENTITY.md"] }],
          heartbeatRefreshMs: 0,
          enginePort: config.enginePort,
        });
        const history = new ConversationHistory(historyPath, config.historyBudget, bot.id);
        const returnedArtifactRoot = canonicalReturnedArtifactDirectory(workspacePath);
        const registry = createSeededToolRegistry(options.artifactPromotion
          ? [generateImageTool, generateMusicTool, returnArtifactTool]
          : []);
        const brainOperations = {
          searchContext: async () => ({
            results: [],
            sourceEvidence: { sourceHealth: "healthy", matchOutcome: "no_match" },
          }),
        } as unknown as ToolContext["brainOperations"];
        const toolContext: ToolContext = {
          scheduler: null,
          ttsService: null,
          browser: null,
          projectRoot: botRoot,
          enginePort: config.enginePort,
          agentName: bot.id,
          cosmo23BaseUrl: config.cosmo23BaseUrl,
          brainRoute: null,
          workspacePath,
          tempDir,
          contextManager,
          subAgentTracker: { active: 0, maxConcurrent: 0, queue: [] },
          modelAliases: { ...config.modelAliases },
          restrictedToolSource: registry,
          chatId: "",
          telegramAdapter: null,
          runAgentLoop: null,
          brainOperations,
          turnRuntime: null,
        };
        const agent = new AgentLoop({
          apiKey: config.apiKey || "on-demand-local",
          ...(config.baseURL ? { baseURL: config.baseURL } : {}),
          model: config.defaultModel,
          provider: config.defaultProvider,
          reasoningEffort: config.defaultReasoningEffort,
          modelReasoningEfforts: config.modelReasoningEfforts,
          maxTokens: config.maxTokens,
          temperature: config.temperature,
          registry,
          contextManager,
          history,
          toolContext,
          workspacePath,
          sessionGapMs: config.sessionGapMs,
        });
        if (config.providerMap) agent.setProviderMap(config.providerMap);
        const port = new OnDemandBotAgentPort(
          bot,
          agent,
          history,
          config,
          returnedArtifactRoot,
          inputAttachmentRoot(),
        );
        const adapter = new ResidentCoordinationAdapter(
          port,
          createM11ResidentCoordinationPort(options.leases),
          undefined,
          options.communications,
          options.artifactPromotion?.(bot),
          BOT_TURN_EVIDENCE_TAXONOMY,
        );
        executionRuntime = { adapter, port };
        return executionRuntime;
      };
      const serial = new Map<string, Promise<void>>();
      const serialize = async (
        operation: "execute" | "continueAccepted" | "reattach" | "recoverCompleted",
        input: DirectMessageExecutionRequest,
      ): Promise<ResidentRun> => {
        const key = input.origin.channelId;
        const prior = serial.get(key) ?? Promise.resolve();
        const start = prior.catch(() => undefined).then(async () => {
          const runtime = requireExecutionRuntime();
          runtime.port.backfillCanonicalHistory(key, input.historyBackfill);
          return runtime.adapter[operation](input);
        });
        // Preserve the adapter's immediate-run contract for live progress while
        // keeping the next turn behind this turn's complete durable lifecycle.
        const tail = start.then(
          async (started) => {
            await Promise.allSettled([started.response, started.receipt]);
          },
          () => undefined,
        );
        serial.set(key, tail);
        void tail.then(() => {
          if (serial.get(key) === tail) serial.delete(key);
        });
        return start;
      };
      const holderInstanceId = `home23-core-on-demand:${bot.id}`;
      const target: DirectMessageExecutionTarget = Object.freeze({
        execution: Object.freeze({
          execute: (input: DirectMessageExecutionRequest) => serialize("execute", input),
          continueAccepted: (input: DirectMessageExecutionRequest) =>
            serialize("continueAccepted", input),
          reattach: (input: DirectMessageExecutionRequest) => serialize("reattach", input),
          recoverCompleted: (input: DirectMessageExecutionRequest) =>
            serialize("recoverCompleted", input),
        }),
        holderInstanceId,
        models: Object.freeze({
          modelCatalog: async () => modelCatalog(config, inputAttachmentRoot() !== null),
        }),
        context: (identity: {
          principalId: string;
          requestId: string;
          correlationId: string;
        }) => ({
          principalId: identity.principalId,
          requestId: identity.requestId,
          correlationId: identity.correlationId,
          identity: {
            kind: "on_demand_bot" as const,
            bot: { botId: bot.id, residentBinding: bot.residentBinding },
          },
        }),
        workKind: "bot_turn",
        authorityReference: `bot:${bot.id}`,
        actorKind: "specialist_bot",
        acceptsAttachments: (attachments: readonly ResidentInputAttachment[]) => {
          if (attachments.length === 0) return true;
          if (!inputAttachmentsEnabled) return false;
          try {
            exactOnDemandInputAttachments(attachments, inputAttachmentRoot()!, false);
            return true;
          } catch {
            return false;
          }
        },
      });
      targets.set(bot.id, { version: bot.version, target });
      return target;
    },
  });
}
