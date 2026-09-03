import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { ConversationHistory } from "../agent/history.js";
import type {
  AgentEvent,
  AgentResponse,
  CoordinationTurnDeliveryContext,
  CoordinationTurnOrigin,
} from "../agent/types.js";
import type { MediaAttachment } from "../types.js";
import type { CoordinationCompletionCommit } from "../work/receipt-delivery.js";
import {
  detectReturnedArtifactContentType,
  isReturnedArtifactContentType,
  isReturnedArtifactGenerator,
  returnedArtifactMediaType,
  type ReturnedArtifactContentType,
  type ReturnedArtifactGenerator,
} from "../returned-artifacts.js";
import { REASONING_EFFORTS, type ReasoningEffort } from "../agent/reasoning-effort.js";
import type { AgentLoop } from "../agent/loop.js";
import {
  resolveModelOverride,
  type ModelAliases,
} from "../agent/model-resolution.js";
import { TurnStore } from "../chat/turn-store.js";
import type { TurnEvent } from "../chat/turn-types.js";
import { ResidentProtocolError, type JsonValue, type ResidentCredential, type ResidentRequestFrame } from "../coordination/resident-protocol/index.js";
import { assertCoordinationId } from "../coordination/ids/index.js";
import { HOUSE_RESIDENT_CAPABILITIES } from "../coordination/house-resident-capabilities.js";
import { ResidentUdsClient, ResidentUdsServer } from "../coordination/transport/uds/index.js";
import type {
  ResidentAgentPort,
  ResidentDurableEvent,
  ResidentDurableTerminal,
  ResidentInputAttachment,
  ResidentModelCatalog,
  ResidentTurnSelectionReceipt,
  ResidentTurnSelectionRequest,
} from "./types.js";

const START = "/internal/v1/turns/start";
const COMPLETED_RECOVERY_START = "/internal/v1/turns/recover-completed";
const MODEL_CATALOG = "/internal/v1/models";
const COORDINATION_COMPLETION = "/internal/v1/coordination-completions";
const MAX_INSTRUCTION_BYTES = 262_144;
const RESULT_RETRY_MS = 100;
const MAX_REQUEST_DEADLINE_MS = 25_000;
const DEFAULT_START_TIMEOUT_MS = 60_000;
// AgentLoop's normal hard turn limit is eight hours. A result read is a
// renewable signed transport request, not the lifetime of the resident turn.
const DEFAULT_RESULT_TIMEOUT_MS = (8 * 60 * 60 * 1_000) + 60_000;
const EVENT_CHUNK_BYTES = 96 * 1024;
const EVENT_REPLAY_DELAY_MS = 20;
const MAX_RESIDENT_ATTACHMENTS = 10;
const MAX_RESIDENT_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const RESIDENT_ATTACHMENT_CONTENT_TYPES = new Set([
  "application/pdf",
  "audio/mpeg",
  "image/gif",
  "image/jpeg",
  "image/png",
  "text/plain",
]);
const MAX_RETURNED_ARTIFACT_CAPTION_BYTES = 2_048;

function exactHouseResidentCapabilities(value: unknown): boolean {
  return Array.isArray(value) && value.length === HOUSE_RESIDENT_CAPABILITIES.length &&
    HOUSE_RESIDENT_CAPABILITIES.every((capability) => value.includes(capability));
}

type ResidentReturnedArtifact = Readonly<{
  type: "image" | "voice" | "document";
  generatedBy: ReturnedArtifactGenerator;
  path: string;
  mimeType: ReturnedArtifactContentType;
  fileName: string;
  byteCount: number;
  sha256: string;
  caption?: string;
}>;

export function residentFence(origin: CoordinationTurnOrigin): string {
  return `${origin.workId}:${origin.attemptId}:${origin.leaseId}:${origin.fencingToken}`;
}

function object(value: JsonValue): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ResidentProtocolError("request_invalid", "resident turn payload must be an object");
  return value;
}
function string(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw new ResidentProtocolError("request_invalid", `${label} is invalid`);
  return value;
}
function text(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new ResidentProtocolError("request_invalid", `${label} is invalid`);
  }
  return value;
}
function origin(value: JsonValue | undefined): CoordinationTurnOrigin {
  const v=object(value as JsonValue);
  if(v.kind!=="coordination")throw new ResidentProtocolError("request_invalid","resident turn origin kind is invalid");
  const result={kind:"coordination" as const,workId:string(v.workId,"workId"),attemptId:string(v.attemptId,"attemptId"),leaseId:string(v.leaseId,"leaseId"),holderPrincipalId:string(v.holderPrincipalId,"holderPrincipalId"),holderInstanceId:string(v.holderInstanceId,"holderInstanceId"),authorityReference:string(v.authorityReference,"authorityReference"),fencingToken:v.fencingToken,channelId:string(v.channelId,"channelId"),originMessageId:v.originMessageId===null?null:string(v.originMessageId,"originMessageId"),roundId:v.roundId===null?null:string(v.roundId,"roundId")};
  if(!Number.isSafeInteger(result.fencingToken)||Number(result.fencingToken)<1)throw new ResidentProtocolError("fence_invalid","resident fence is invalid");
  return result as CoordinationTurnOrigin;
}
function jsonOrigin(value:CoordinationTurnOrigin):JsonValue{return{...value};}

function coordinationDelivery(value: JsonValue | undefined): CoordinationTurnDeliveryContext | undefined {
  if (value === undefined) return undefined;
  const v = object(value);
  return Object.freeze({
    conversationId: string(v.conversationId, "conversationId"),
    targetPrincipalId: string(v.targetPrincipalId, "targetPrincipalId"),
    targetDisplayName: string(v.targetDisplayName, "targetDisplayName"),
    targetKind: string(v.targetKind, "targetKind"),
  });
}

function jsonCoordinationDelivery(value: CoordinationTurnDeliveryContext | undefined): JsonValue | undefined {
  return value === undefined ? undefined : { ...value };
}

function assertCoordinationDelivery(
  delivery: CoordinationTurnDeliveryContext | undefined,
  provenance: CoordinationTurnOrigin,
): void {
  if (delivery === undefined) return;
  if (
    provenance.originMessageId === null ||
    delivery.targetPrincipalId !== provenance.holderPrincipalId
  ) {
    throw new ResidentProtocolError(
      "fence_invalid",
      "resident completion destination does not match its Work origin",
    );
  }
}

function exactOrigin(left: CoordinationTurnOrigin | undefined, right: CoordinationTurnOrigin): boolean {
  return left?.kind === right.kind && left.workId === right.workId &&
    left.attemptId === right.attemptId && left.leaseId === right.leaseId &&
    left.holderPrincipalId === right.holderPrincipalId &&
    left.holderInstanceId === right.holderInstanceId &&
    left.authorityReference === right.authorityReference &&
    left.fencingToken === right.fencingToken && left.channelId === right.channelId &&
    left.originMessageId === right.originMessageId && left.roundId === right.roundId;
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

function nonnegativeSafeInteger(value: JsonValue | undefined, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ResidentProtocolError("request_invalid", `${name} is invalid`);
  }
  return value;
}

async function residentAttachments(
  value: JsonValue | undefined,
  configuredRoot: string | undefined,
): Promise<readonly ResidentInputAttachment[]> {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > MAX_RESIDENT_ATTACHMENTS) {
    throw new ResidentProtocolError("request_invalid", "resident attachments are invalid");
  }
  if (value.length === 0) return Object.freeze([]);
  if (!configuredRoot || !isAbsolute(configuredRoot) || configuredRoot.includes("\0")) {
    throw new ResidentProtocolError("request_invalid", "resident attachment root is unavailable");
  }
  const root = resolve(configuredRoot);
  let canonicalRoot: string;
  try {
    const rootEntry = await lstat(root);
    canonicalRoot = await realpath(root);
    const allowedMacSystemAlias = root.startsWith("/var/") && canonicalRoot === `/private${root}`;
    if (
      !rootEntry.isDirectory() ||
      rootEntry.isSymbolicLink() ||
      (canonicalRoot !== root && !allowedMacSystemAlias)
    ) {
      throw new Error("invalid root");
    }
  } catch {
    throw new ResidentProtocolError("request_invalid", "resident attachment root is unavailable");
  }

  const seen = new Set<string>();
  const result: ResidentInputAttachment[] = [];
  for (const raw of value) {
    const attachment = object(raw);
    const artifactId = string(attachment.artifactId, "attachment artifactId");
    const name = string(attachment.name, "attachment name");
    const contentType = string(attachment.contentType, "attachment contentType");
    const byteCount = nonnegativeSafeInteger(attachment.byteCount, "attachment byteCount");
    const sha256 = string(attachment.sha256, "attachment sha256");
    const path = string(attachment.path, "attachment path");
    try {
      assertCoordinationId("artifact", artifactId);
    } catch {
      throw new ResidentProtocolError("request_invalid", "resident attachment metadata is invalid");
    }
    if (
      seen.has(artifactId) ||
      name.length > 255 ||
      name.normalize("NFC") !== name ||
      name === "." ||
      name === ".." ||
      /^[A-Za-z]:/u.test(name) ||
      /[\0-\x1f\x7f/\\]/u.test(name) ||
      !RESIDENT_ATTACHMENT_CONTENT_TYPES.has(contentType) ||
      byteCount > MAX_RESIDENT_ATTACHMENT_BYTES ||
      !/^[a-f0-9]{64}$/u.test(sha256) ||
      !isAbsolute(path)
    ) {
      throw new ResidentProtocolError("request_invalid", "resident attachment metadata is invalid");
    }
    const expectedPath = join(
      canonicalRoot,
      "objects",
      "sha256",
      sha256.slice(0, 2),
      sha256.slice(2, 4),
      sha256,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let canonicalPath: string;
    try {
      const [entry, resolvedPath] = await Promise.all([lstat(path), realpath(path)]);
      canonicalPath = resolvedPath;
      if (
        canonicalPath !== expectedPath ||
        !entry.isFile() ||
        entry.isSymbolicLink()
      ) {
        throw new Error("invalid attachment path");
      }
      handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== byteCount) throw new Error("invalid attachment size");
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let offset = 0;
      while (offset < stat.size) {
        const read = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, stat.size - offset),
          offset,
        );
        if (read.bytesRead === 0) break;
        hash.update(buffer.subarray(0, read.bytesRead));
        offset += read.bytesRead;
      }
      if (offset !== stat.size || hash.digest("hex") !== sha256) {
        throw new Error("invalid attachment digest");
      }
    } catch {
      throw new ResidentProtocolError("request_invalid", "resident attachment bytes are invalid");
    } finally {
      await handle?.close().catch(() => undefined);
    }
    seen.add(artifactId);
    result.push(Object.freeze({
      artifactId,
      name,
      contentType,
      byteCount,
      sha256,
      path: canonicalPath,
    }));
  }
  return Object.freeze(result);
}

function safeReturnedArtifactFileName(value: unknown, fallback: string): string {
  const fileName = value === undefined ? fallback : value;
  if (
    typeof fileName !== "string" ||
    fileName.length === 0 ||
    fileName.length > 255 ||
    fileName.normalize("NFC") !== fileName ||
    fileName === "." ||
    fileName === ".." ||
    /^[A-Za-z]:/u.test(fileName) ||
    /[\0-\x1f\x7f/\\]/u.test(fileName)
  ) {
    throw new ResidentProtocolError("request_invalid", "resident returned artifact filename is invalid");
  }
  return fileName;
}

function returnedArtifactCandidates(value: unknown): Record<string, unknown>[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ResidentProtocolError("request_invalid", "resident returned artifact descriptors are invalid");
  }
  const artifacts: Record<string, unknown>[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ResidentProtocolError("request_invalid", "resident returned artifact descriptor is invalid");
    }
    const descriptor = raw as Record<string, unknown>;
    if (!isReturnedArtifactGenerator(descriptor.generatedBy)) continue;
    artifacts.push(descriptor);
  }
  if (artifacts.length > MAX_RESIDENT_ATTACHMENTS) {
    throw new ResidentProtocolError("request_invalid", "resident returned artifact limit exceeded");
  }
  return artifacts;
}

async function residentReturnedArtifacts(
  value: unknown,
  configuredRoots: readonly { path: string; generatedImageOnly: boolean }[],
): Promise<readonly ResidentReturnedArtifact[]> {
  const candidates = returnedArtifactCandidates(value);
  if (candidates.length === 0) return Object.freeze([]);
  const roots: Array<{ path: string; generatedImageOnly: boolean }> = [];
  for (const configured of configuredRoots) {
    if (!isAbsolute(configured.path) || configured.path.includes("\0")) continue;
    const root = resolve(configured.path);
    try {
      const rootEntry = await lstat(root);
      const canonicalRoot = await realpath(root);
      const allowedMacSystemAlias = root.startsWith("/var/") && canonicalRoot === `/private${root}`;
      if (
        !rootEntry.isDirectory() || rootEntry.isSymbolicLink() ||
        (canonicalRoot !== root && !allowedMacSystemAlias)
      ) continue;
      roots.push({ path: canonicalRoot, generatedImageOnly: configured.generatedImageOnly });
    } catch { /* absent roots are simply not eligible */ }
  }
  if (roots.length === 0) {
    throw new ResidentProtocolError("request_invalid", "resident returned artifact root is unavailable");
  }

  const seen = new Set<string>();
  const artifacts: ResidentReturnedArtifact[] = [];
  for (const candidate of candidates) {
    const path = candidate.path;
    if (typeof path !== "string" || path.length === 0 || path.length > 4_096 || path.includes("\0") || !isAbsolute(path)) {
      throw new ResidentProtocolError("request_invalid", "resident returned artifact path is invalid");
    }

    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const [entry, canonicalPath] = await Promise.all([lstat(path), realpath(path)]);
      const generatedBy = candidate.generatedBy;
      if (!isReturnedArtifactGenerator(generatedBy)) throw new Error("returned artifact generator is invalid");
      const eligibleRoot = roots.find((root) =>
        dirname(canonicalPath) === root.path &&
        (!root.generatedImageOnly || generatedBy === "generate_image")
      );
      if (
        !eligibleRoot ||
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        seen.has(canonicalPath)
      ) {
        throw new Error("invalid returned artifact path");
      }
      handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const before = await handle.stat();
      if (
        !before.isFile() ||
        before.dev !== entry.dev ||
        before.ino !== entry.ino ||
        before.size < 1 ||
        before.size > MAX_RESIDENT_ATTACHMENT_BYTES
      ) {
        throw new Error("invalid returned artifact file");
      }

      if (candidate.byteCount !== undefined && (
        typeof candidate.byteCount !== "number" ||
        !Number.isSafeInteger(candidate.byteCount) ||
        candidate.byteCount !== before.size
      )) {
        throw new Error("returned artifact size differs");
      }

      const bytes = await handle.readFile();
      const after = await handle.stat();
      const pathAfter = await lstat(canonicalPath);
      if (
        bytes.length !== before.size ||
        after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
        pathAfter.isSymbolicLink() || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino
      ) {
        throw new Error("returned artifact changed");
      }
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (candidate.sha256 !== undefined && candidate.sha256 !== sha256) {
        throw new Error("returned artifact digest differs");
      }
      const mimeType = detectReturnedArtifactContentType(bytes);
      const mediaType = returnedArtifactMediaType(mimeType, generatedBy);
      const declaredMediaType = candidate.type === "media" ? candidate.mediaType : (candidate.type ?? candidate.mediaType);
      if (declaredMediaType !== mediaType || (candidate.mimeType !== undefined && candidate.mimeType !== mimeType)) {
        throw new Error("returned artifact MIME differs");
      }
      const fileName = safeReturnedArtifactFileName(candidate.fileName, basename(canonicalPath));
      if (fileName !== basename(canonicalPath)) {
        throw new Error("returned artifact filename differs");
      }
      const caption = candidate.caption;
      if (caption !== undefined && (
        typeof caption !== "string" ||
        caption.includes("\0") ||
        Buffer.byteLength(caption, "utf8") > MAX_RETURNED_ARTIFACT_CAPTION_BYTES
      )) {
        throw new Error("returned artifact caption is invalid");
      }
      seen.add(canonicalPath);
      artifacts.push(Object.freeze({
        type: mediaType,
        generatedBy,
        path: canonicalPath,
        mimeType,
        fileName,
        byteCount: before.size,
        sha256,
        ...(typeof caption === "string" ? { caption } : {}),
      }));
    } catch (error) {
      if (error instanceof ResidentProtocolError) throw error;
      throw new ResidentProtocolError("request_invalid", "resident returned artifact bytes are invalid");
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  return Object.freeze(artifacts);
}

function returnedArtifactsJson(artifacts: readonly ResidentReturnedArtifact[]): JsonValue {
  return artifacts.map((artifact) => ({
    type: artifact.type,
    generatedBy: artifact.generatedBy,
    path: artifact.path,
    mimeType: artifact.mimeType,
    fileName: artifact.fileName,
    byteCount: artifact.byteCount,
    sha256: artifact.sha256,
    ...(artifact.caption === undefined ? {} : { caption: artifact.caption }),
  }));
}

function parseResidentReturnedArtifacts(value: JsonValue | undefined): MediaAttachment[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_RESIDENT_ATTACHMENTS) {
    throw new ResidentProtocolError("request_invalid", "resident returned artifact response is invalid");
  }
  return value.map((raw) => {
    const artifact = object(raw);
    const generatedBy = artifact.generatedBy;
    const mimeType = string(artifact.mimeType, "returned artifact MIME");
    if (
      !isReturnedArtifactGenerator(generatedBy) ||
      !isReturnedArtifactContentType(mimeType) ||
      artifact.type !== returnedArtifactMediaType(mimeType, generatedBy)
    ) {
      throw new ResidentProtocolError("request_invalid", "resident returned artifact type is invalid");
    }
    const path = string(artifact.path, "returned artifact path");
    const fileName = safeReturnedArtifactFileName(artifact.fileName, basename(path));
    const byteCount = nonnegativeSafeInteger(artifact.byteCount, "returned artifact byteCount");
    const sha256 = string(artifact.sha256, "returned artifact sha256");
    const caption = artifact.caption;
    if (
      !isAbsolute(path) ||
      path.length > 4_096 ||
      basename(path) !== fileName ||
      byteCount < 1 ||
      byteCount > MAX_RESIDENT_ATTACHMENT_BYTES ||
      !/^[a-f0-9]{64}$/u.test(sha256) ||
      (caption !== undefined && (
        typeof caption !== "string" ||
        caption.includes("\0") ||
        Buffer.byteLength(caption, "utf8") > MAX_RETURNED_ARTIFACT_CAPTION_BYTES
      ))
    ) {
      throw new ResidentProtocolError("request_invalid", "resident returned artifact response is invalid");
    }
    return Object.freeze({
      type: returnedArtifactMediaType(mimeType, generatedBy),
      generatedBy,
      path,
      mimeType,
      fileName,
      byteCount,
      sha256,
      ...(typeof caption === "string" ? { caption } : {}),
    });
  });
}

function instructionWithAttachments(
  instruction: string,
  attachments: readonly ResidentInputAttachment[],
): string {
  if (attachments.length === 0) return instruction;
  const manifest = attachments.map((attachment, index) =>
    `${index + 1}. name=${JSON.stringify(attachment.name)} ` +
    `type=${attachment.contentType} bytes=${attachment.byteCount} ` +
    `sha256=${attachment.sha256} path=${JSON.stringify(attachment.path)}`
  ).join("\n");
  const prefix = instruction.trim().length > 0 ? `${instruction}\n\n` : "";
  return `${prefix}[Canonical user attachments]\n${manifest}\n` +
    "Inspect these exact local files when the request depends on them. Image bytes are also attached for vision.";
}

function nullableString(value: JsonValue | undefined, label: string): string | null {
  if (value === null) return null;
  return string(value, label);
}

function reasoningEffort(value: JsonValue | undefined): ReasoningEffort | null {
  const effort=nullableString(value,"reasoningEffort");
  if(effort!==null&&!REASONING_EFFORTS.includes(effort as ReasoningEffort)){
    throw new ResidentProtocolError("request_invalid","resident reasoning effort is invalid");
  }
  return effort as ReasoningEffort|null;
}

function turnSelection(value: JsonValue | undefined): ResidentTurnSelectionRequest {
  if (value === undefined || value === null) {
    return Object.freeze({ modelAlias: null, reasoningEffort: null });
  }
  const selection=object(value as JsonValue);
  const modelAlias=nullableString(selection.modelAlias,"modelAlias");
  if(modelAlias!==null&&(modelAlias.length>256||/[\0\r\n]/u.test(modelAlias))){
    throw new ResidentProtocolError("request_invalid","resident model alias is invalid");
  }
  return Object.freeze({modelAlias,reasoningEffort:reasoningEffort(selection.reasoningEffort)});
}

function selectionReceipt(
  value: JsonValue | undefined,
  requested: ResidentTurnSelectionRequest,
):ResidentTurnSelectionReceipt{
  if (value === undefined || value === null) {
    return Object.freeze({
      requestedProvider: null,
      requestedModelAlias: requested.modelAlias,
      requestedModel: null,
      requestedEffort: requested.reasoningEffort,
      resolvedProvider: null,
      resolvedModel: null,
      resolvedEffort: null,
      actualProvider: null,
      actualModel: null,
      actualEffort: null,
    });
  }
  const selection=object(value as JsonValue);
  return Object.freeze({
    requestedProvider:nullableString(selection.requestedProvider,"requestedProvider"),
    requestedModelAlias:nullableString(selection.requestedModelAlias,"requestedModelAlias"),
    requestedModel:nullableString(selection.requestedModel,"requestedModel"),
    requestedEffort:reasoningEffort(selection.requestedEffort),
    resolvedProvider:nullableString(selection.resolvedProvider,"resolvedProvider"),
    resolvedModel:nullableString(selection.resolvedModel,"resolvedModel"),
    resolvedEffort:reasoningEffort(selection.resolvedEffort),
    actualProvider:nullableString(selection.actualProvider,"actualProvider"),
    actualModel:nullableString(selection.actualModel,"actualModel"),
    actualEffort:reasoningEffort(selection.actualEffort),
  });
}

function selectionJson(
  requested:ResidentTurnSelectionRequest,
  source:{provider:string|null;model:string|null;reasoningEffort:ReasoningEffort|null},
):JsonValue{
  return {
    requestedProvider:null,
    requestedModelAlias:requested.modelAlias,
    requestedModel:null,
    requestedEffort:requested.reasoningEffort,
    resolvedProvider:source.provider,
    resolvedModel:source.model,
    resolvedEffort:source.reasoningEffort,
    actualProvider:source.provider,
    actualModel:source.model,
    actualEffort:source.reasoningEffort,
  };
}

function exactTimestamp(value: unknown, label: string): string {
  if(typeof value!=="string")throw new ResidentProtocolError("request_invalid",`${label} is invalid`);
  const parsed=new Date(value);
  if(Number.isNaN(parsed.valueOf())||parsed.toISOString()!==value){
    throw new ResidentProtocolError("request_invalid",`${label} is invalid`);
  }
  return value;
}

const TURN_EVENT_KINDS=new Set([
  "thinking","tool_start","tool_result","response_chunk","media",
  "subagent_start","subagent_result","cache","status",
]);

function decodeTurnEvent(encoded:Buffer,turnId:string,sequence:number):TurnEvent{
  let value:unknown;
  try{value=JSON.parse(encoded.toString("utf8"));}
  catch{throw new ResidentProtocolError("request_invalid","resident event record is malformed");}
  if(!value||typeof value!=="object"||Array.isArray(value))throw new ResidentProtocolError("request_invalid","resident event record is invalid");
  const record=value as Record<string,unknown>;
  const data=record.data;
  if(record.type!=="event"||record.turn_id!==turnId||record.seq!==sequence||
      typeof record.kind!=="string"||!TURN_EVENT_KINDS.has(record.kind)||
      !data||typeof data!=="object"||Array.isArray(data)||
      (data as Record<string,unknown>).type!==record.kind){
    throw new ResidentProtocolError("request_invalid","resident event identity is invalid");
  }
  exactTimestamp(record.ts,"resident event timestamp");
  return record as unknown as TurnEvent;
}

function durableTerminal(
  value:JsonValue|undefined,
  source:{provider:string|null;model:string|null;reasoningEffort:ReasoningEffort|null},
):ResidentDurableTerminal|null{
  if(value===null)return null;
  const terminal=object(value as JsonValue);
  return Object.freeze({
    status:string(terminal.status,"terminal status"),
    lastSequence:nonnegativeSafeInteger(terminal.lastSeq,"terminal lastSeq"),
    endedAt:exactTimestamp(terminal.endedAt,"resident terminal timestamp"),
    errorCode:nullableString(terminal.errorCode,"terminal errorCode"),
    errorMessage:nullableString(terminal.errorMessage,"terminal errorMessage"),
    provider:source.provider,
    model:source.model,
    reasoningEffort:source.reasoningEffort,
  });
}

function terminalPayload(store: TurnStore, chatId: string, turnId: string): JsonValue {
  const terminal = store.finalEnvelope(chatId, turnId);
  if (!terminal) return null;
  const lastSequence = store.eventsSince(chatId, turnId, -1).reduce(
    (maximum, event) => Math.max(maximum, event.seq),
    0,
  );
  return {
    status: terminal.status,
    // Older resident journals can contain a terminal envelope without
    // last_seq (or with its historical zero fallback). The durable event
    // journal is the authority for the replay boundary; reporting the stale
    // envelope value would leave a recovered coordinator waiting forever.
    lastSeq: lastSequence,
    endedAt: terminal.ended_at ?? null,
    errorCode: terminal.error_code ?? null,
    errorMessage: terminal.error_message ?? terminal.error ?? null,
  };
}

function retryableTransportWait(error: unknown): boolean {
  if (!(error instanceof ResidentProtocolError)) return false;
  return error.code === "deadline_exceeded" ||
    (error.retryable && (
      error.code === "connection_lost" ||
      error.code === "server_busy" ||
      error.code === "request_rate_limited" ||
      error.code === "internal_error"
    ));
}

function assertResidentBinding(
  provenance: CoordinationTurnOrigin,
  residentSlug: string,
  serverInstanceId: string,
): void {
  if (
    provenance.authorityReference !== `resident:${residentSlug}` ||
    provenance.holderInstanceId !== serverInstanceId
  ) {
    throw new ResidentProtocolError("fence_invalid", "resident turn is bound to a different harness");
  }
}

export interface ResidentTurnUdsServerOptions {
  socketPath:string;serverInstanceId:string;credential:ResidentCredential;
  residentSlug:string;agent:Pick<AgentLoop,"runWithTurn"|"stop"|"isRunning"|"getModel"|"getProvider"|"getReasoningEffort"> & { getWorkspacePath?: () => string };history:ConversationHistory;
  modelAliases?:ModelAliases;
  attachmentRoot?:string;
  /** Reverse, resident-authenticated connection to the canonical coordinator. */
  coordinationCompletionClient?:ResidentUdsClient;
  now?:()=>number;
}

function residentModelAliases(
  explicit: ModelAliases | undefined,
  agent: ResidentTurnUdsServerOptions["agent"],
): Readonly<ModelAliases> {
  // The immutable coordination package can be loaded by the pre-existing
  // production harness bridge, whose narrow call site predates the explicit
  // modelAliases argument. AgentLoop retains the same configured aliases in
  // its ToolContext. Project only the public routing fields so this
  // compatibility path cannot expose credentials or arbitrary config data.
  const candidate = explicit ?? (
    agent as unknown as { toolContext?: { modelAliases?: unknown } }
  ).toolContext?.modelAliases;
  if (candidate === undefined) return Object.freeze({});
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError("resident model aliases must be an object");
  }
  const aliases: ModelAliases = {};
  for (const [alias, raw] of Object.entries(candidate)) {
    if (!alias || alias.length > 256 || /[\0\r\n]/u.test(alias)) {
      throw new TypeError("resident model alias is invalid");
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new TypeError(`resident model alias ${alias} is invalid`);
    }
    const value = raw as Record<string, unknown>;
    if (
      typeof value.provider !== "string" || value.provider.length === 0 ||
      typeof value.model !== "string" || value.model.length === 0 ||
      /[\0\r\n]/u.test(value.provider) || /[\0\r\n]/u.test(value.model) ||
      (value.reasoningEffort !== undefined &&
        (typeof value.reasoningEffort !== "string" ||
          !REASONING_EFFORTS.includes(value.reasoningEffort as ReasoningEffort)))
    ) {
      throw new TypeError(`resident model alias ${alias} is invalid`);
    }
    aliases[alias] = Object.freeze({
      provider: value.provider,
      model: value.model,
      ...(value.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: value.reasoningEffort as ReasoningEffort }),
    });
  }
  return Object.freeze(aliases);
}

/** Resident-owned endpoint. It can access the AgentLoop and TurnStore, but no coordination DB. */
export class ResidentTurnUdsServer {
  readonly #store:TurnStore; readonly #responses=new Map<string,Promise<AgentResponse>>(); readonly #server:ResidentUdsServer;
  readonly #modelAliases:Readonly<ModelAliases>;
  readonly #returnedArtifactRoots:readonly {path:string;generatedImageOnly:boolean}[];
  readonly #completionAbort=new AbortController();
  constructor(private readonly options:ResidentTurnUdsServerOptions){
    this.#store=new TurnStore(options.history);
    this.#modelAliases=residentModelAliases(options.modelAliases,options.agent);
    const workspacePath=options.agent.getWorkspacePath?.();
    this.#returnedArtifactRoots=typeof workspacePath==="string"&&isAbsolute(workspacePath)&&!workspacePath.includes("\0")
      ? Object.freeze([
          {path:join(resolve(workspacePath),"media","returned-artifacts"),generatedImageOnly:false},
          {path:join(resolve(workspacePath),"media","generated-images"),generatedImageOnly:true},
        ])
      : Object.freeze([]);
    if(options.credential.residentSlug!==options.residentSlug)throw new TypeError("resident credential slug does not match harness");
    this.#server=new ResidentUdsServer({socketPath:options.socketPath,serverInstanceId:options.serverInstanceId,credentials:[options.credential],now:options.now,validateFence:(fence,request)=>request.method==="POST"&&(request.path===START||request.path===COMPLETED_RECOVERY_START)?typeof fence==="string"&&fence.length<512:true,handleRequest:(request,context)=>this.#handle(request,context.signal)});
  }
  start(){return this.#server.start();}
  async close(){
    this.#completionAbort.abort(new ResidentProtocolError("request_cancelled","resident harness is closing"));
    const results=await Promise.allSettled([
      this.#server.close(),
      this.options.coordinationCompletionClient?.close()??Promise.resolve(),
    ]);
    const failed=results.find((result):result is PromiseRejectedResult=>result.status==="rejected");
    if(failed)throw failed.reason;
  }
  /** Awaited by the durable async-work pipeline before it stamps deliveredAt. */
  async commitCoordinationCompletion(input:CoordinationCompletionCommit):Promise<void>{
    const client=this.options.coordinationCompletionClient;
    if(!client)throw new ResidentProtocolError("connection_lost","coordination completion transport is unavailable",{retryable:true});
    if(input.residentBinding!==this.options.residentSlug||input.residentInstanceId!==this.options.serverInstanceId){
      throw new ResidentProtocolError("fence_invalid","coordination completion belongs to a different resident");
    }
    const artifacts=await residentReturnedArtifacts(input.artifacts,this.#returnedArtifactRoots);
    const payload:JsonValue={
      parentWorkId:input.parentWorkId,childWorkId:input.childWorkId,childKind:input.childKind,
      childResultHandle:{...input.childResultHandle},status:input.status,finishedAt:input.finishedAt,
      channelId:input.channelId,conversationId:input.conversationId,
      originMessageId:input.originMessageId,targetPrincipalId:input.targetPrincipalId,
      residentBinding:input.residentBinding,residentInstanceId:input.residentInstanceId,
      authorityReference:input.authorityReference,terminalText:input.terminalText,
      artifacts:returnedArtifactsJson(artifacts),
    };
    let retryDelayMs=100;
    for(;;){
      this.#completionAbort.signal.throwIfAborted();
      try{
        const now=this.options.now?.()??Date.now();
        const response=await client.request({
          method:"POST",path:COORDINATION_COMPLETION,payload,
          deadlineAtMs:now+MAX_REQUEST_DEADLINE_MS,
          signal:this.#completionAbort.signal,
        });
        const acknowledgement=object(response.payload);
        if(acknowledgement.accepted!==true||acknowledgement.childWorkId!==input.childWorkId){
          throw new ResidentProtocolError("request_invalid","coordination completion acknowledgement differs");
        }
        return;
      }catch(error){
        const retryable=error instanceof ResidentProtocolError&&(
          error.retryable||error.code==="connection_lost"||error.code==="deadline_exceeded"||
          error.code==="server_busy"||error.code==="request_rate_limited"
        );
        if(!retryable||this.#completionAbort.signal.aborted)throw error;
        await new Promise<void>((resolve,reject)=>{
          const onAbort=()=>{
            clearTimeout(timer);reject(this.#completionAbort.signal.reason);
          };
          const timer=setTimeout(()=>{
            this.#completionAbort.signal.removeEventListener("abort",onAbort);
            resolve();
          },retryDelayMs);timer.unref();
          this.#completionAbort.signal.addEventListener("abort",onAbort,{once:true});
        });
        retryDelayMs=Math.min(retryDelayMs*2,5_000);
      }
    }
  }
  async #handle(request:ResidentRequestFrame,signal:AbortSignal):Promise<JsonValue>{
    if(request.method==="GET"&&request.path===MODEL_CATALOG){
      const aliases=this.#modelAliases;
      return {
        capabilities:[...HOUSE_RESIDENT_CAPABILITIES],
        models:Object.entries(aliases).sort(([left],[right])=>left.localeCompare(right)).map(([alias,value])=>({
          alias,provider:value.provider,model:value.model,reasoningEffort:value.reasoningEffort??null,
        })),
        defaultModel:this.options.agent.getModel(),
        defaultProvider:this.options.agent.getProvider(),
        defaultReasoningEffort:this.options.agent.getReasoningEffort(),
        reasoningEfforts:[...REASONING_EFFORTS],
      };
    }
    if(request.method==="POST"&&request.path===COMPLETED_RECOVERY_START){
      const p=object(request.payload);const chatId=string(p.chatId,"chatId");const turnId=string(p.turnId,"turnId");const provenance=origin(p.origin);const delivery=coordinationDelivery(p.coordinationDelivery);
      assertResidentBinding(provenance,this.options.residentSlug,this.options.serverInstanceId);
      assertCoordinationDelivery(delivery,provenance);
      const requested=turnSelection(p.turnSelection);
      if(turnId!==`coord-${provenance.workId}`)throw new ResidentProtocolError("fence_invalid","resident turn ID does not match its Work origin");
      if(request.fence!==residentFence(provenance)||request.correlationId!==string(p.correlationId,"correlationId"))throw new ResidentProtocolError("fence_invalid","resident turn fence or correlation does not match");
      const started=this.#store.startEnvelope(chatId,turnId);
      if(!started){
        throw new ResidentProtocolError("request_invalid","completed recovery requires an exact durable resident start");
      }
      if(started.chat_id!==chatId||!exactOrigin(started.coordination_origin,provenance)){
        throw new ResidentProtocolError("fence_invalid","resident turn origin does not match durable start");
      }
      const final=this.#store.finalEnvelope(chatId,turnId);
      if(!final||final.chat_id!==chatId||final.status!=="complete"||typeof final.assistant_content!=="string"){
        throw new ResidentProtocolError("request_invalid","completed recovery requires an exact complete resident turn");
      }
      if(signal.aborted)throw new ResidentProtocolError("request_cancelled","resident completed recovery was cancelled");
      return{
        turnId,chatId,persistedAt:exactTimestamp(final.ended_at??started.started_at,"resident completed recovery timestamp"),
        recovered:true,completedRecovery:true,
        selection:selectionJson(requested,{provider:started.provider??null,model:started.model??null,reasoningEffort:started.reasoning_effort??null}),
      };
    }
    if(request.method==="POST"&&request.path===START){
      const p=object(request.payload);const chatId=string(p.chatId,"chatId");const rawInstruction=text(p.instruction,"instruction");const attachments=await residentAttachments(p.attachments,this.options.attachmentRoot);const instruction=instructionWithAttachments(rawInstruction,attachments);if(!instruction.trim())throw new ResidentProtocolError("request_invalid","resident instruction or attachment is required");const turnId=string(p.turnId,"turnId");const provenance=origin(p.origin);const delivery=coordinationDelivery(p.coordinationDelivery);
      assertResidentBinding(provenance,this.options.residentSlug,this.options.serverInstanceId);
      assertCoordinationDelivery(delivery,provenance);
      const requested=turnSelection(p.turnSelection);
      if(Buffer.byteLength(instruction,"utf8")>MAX_INSTRUCTION_BYTES)throw new ResidentProtocolError("request_invalid","resident instruction is too large");
      if(turnId!==`coord-${provenance.workId}`)throw new ResidentProtocolError("fence_invalid","resident turn ID does not match its Work origin");
      if(request.fence!==residentFence(provenance)||request.correlationId!==string(p.correlationId,"correlationId"))throw new ResidentProtocolError("fence_invalid","resident turn fence or correlation does not match");
      const started=this.#store.startEnvelope(chatId,turnId);if(started&&!exactOrigin(started.coordination_origin,provenance))throw new ResidentProtocolError("fence_invalid","resident turn origin does not match durable start");
      const final=this.#store.finalEnvelope(chatId,turnId);if(final)return{
        turnId,chatId,persistedAt:final.ended_at??final.started_at,recovered:true,
        selection:selectionJson(requested,{provider:started?.provider??null,model:started?.model??null,reasoningEffort:started?.reasoning_effort??null}),
      };
      if(started&&!this.options.agent.isRunning(chatId))throw new ResidentProtocolError("connection_lost","persisted resident turn requires coordinator recovery",{retryable:true});
      if(!started){
        const modelOverride=requested.modelAlias===null?undefined:resolveModelOverride(requested.modelAlias,this.#modelAliases);
        if(requested.modelAlias!==null&&!modelOverride){
          throw new ResidentProtocolError("request_invalid","requested resident model is unavailable");
        }
        const media=attachments.filter((attachment)=>attachment.contentType.startsWith("image/")).map((attachment)=>({type:"image" as const,path:attachment.path,mimeType:attachment.contentType,fileName:attachment.name}));const run=await this.options.agent.runWithTurn(chatId,instruction,{turnId,coordinationOrigin:provenance,...(delivery?{coordinationDelivery:delivery}:{}),onDurableStart:async()=>undefined,onEvent:()=>undefined,...(media.length>0?{media}:{}),...(modelOverride?{modelOverride}:{}),...(requested.reasoningEffort?{effort:requested.reasoningEffort}:{})});this.#responses.set(turnId,run.response);void run.response.finally(()=>setTimeout(()=>this.#responses.delete(turnId),60_000).unref()).catch(()=>undefined);
      }
      const durable=this.#store.startEnvelope(chatId,turnId);if(!durable)throw new Error("AgentLoop returned before durable turn start");
      if(signal.aborted)throw new ResidentProtocolError("request_cancelled","resident start was cancelled");
      return{turnId,chatId,persistedAt:durable.started_at,recovered:Boolean(started),selection:selectionJson(requested,{provider:durable.provider??null,model:durable.model??null,reasoningEffort:durable.reasoning_effort??null})};
    }
    const match=/^\/internal\/v1\/turns\/([^/]+)\/(result|stop|events)$/.exec(request.path);
    if(!match)throw new ResidentProtocolError("request_invalid","unknown resident turn operation");
    const turnId=decodeURIComponent(match[1]!);const p=object(request.payload);const chatId=string(p.chatId,"chatId");const provenance=origin(p.origin);if(request.fence!==residentFence(provenance)||request.correlationId!==string(p.correlationId,"correlationId"))throw new ResidentProtocolError("fence_invalid","resident turn fence or correlation does not match");
    assertResidentBinding(provenance,this.options.residentSlug,this.options.serverInstanceId);
    if(turnId!==`coord-${provenance.workId}`)throw new ResidentProtocolError("fence_invalid","resident turn ID does not match its Work origin");
    const durableStart=this.#store.startEnvelope(chatId,turnId);if(!durableStart||!exactOrigin(durableStart.coordination_origin,provenance))throw new ResidentProtocolError("fence_invalid","resident turn origin does not match durable start");
    if(match[2]==="stop"){return{stopped:this.options.agent.stop(chatId,turnId).stopped};}
    if(match[2]==="events"){
      const afterSequence=nonnegativeSafeInteger(p.afterSequence,"afterSequence");
      const eventSequence=nonnegativeSafeInteger(p.eventSequence,"eventSequence");
      const chunkOffset=nonnegativeSafeInteger(p.chunkOffset,"chunkOffset");
      if(eventSequence===0&&chunkOffset!==0)throw new ResidentProtocolError("request_invalid","event chunk offset requires an event sequence");
      const candidates=this.#store.eventsSince(chatId,turnId,eventSequence>0?eventSequence-1:afterSequence);
      const record=eventSequence>0?candidates.find(event=>event.seq===eventSequence):candidates[0];
      if(!record){
        if(eventSequence>0)throw new ResidentProtocolError("request_invalid","resident event chunk sequence is unavailable");
        return{
          turnId,provider:durableStart.provider??null,model:durableStart.model??null,
          reasoningEffort:durableStart.reasoning_effort??null,event:null,
          terminal:terminalPayload(this.#store,chatId,turnId),
        };
      }
      const encoded=Buffer.from(JSON.stringify(record),"utf8");
      if(chunkOffset>encoded.length)throw new ResidentProtocolError("request_invalid","resident event chunk offset is beyond the event");
      const nextOffset=Math.min(encoded.length,chunkOffset+EVENT_CHUNK_BYTES);
      return{
        turnId,provider:durableStart.provider??null,model:durableStart.model??null,
        reasoningEffort:durableStart.reasoning_effort??null,
        event:{
          sequence:record.seq,offset:chunkOffset,nextOffset,totalBytes:encoded.length,
          digest:createHash("sha256").update(encoded).digest("hex"),
          chunkBase64:encoded.subarray(chunkOffset,nextOffset).toString("base64"),
        },
        terminal:terminalPayload(this.#store,chatId,turnId),
      };
    }
    if(p.completedRecovery!==undefined&&p.completedRecovery!==true){
      throw new ResidentProtocolError("request_invalid","completed recovery mode is invalid");
    }
    const final=this.#store.finalEnvelope(chatId,turnId);
    if(final){
      if(final.status!=="complete"||typeof final.assistant_content!=="string")throw new ResidentProtocolError("internal_error",final.error_message??final.error??`resident turn ended ${final.status}`);
      if(p.completedRecovery===true){
        return{text:final.assistant_content,model:final.model??"recovered",toolCallCount:0,durationMs:0,recovered:true};
      }
      const media=await residentReturnedArtifacts(
        this.#store.eventsSince(chatId,turnId,-1)
          .filter((event)=>event.kind==="media")
          .map((event)=>event.data),
        this.#returnedArtifactRoots,
      );
      return{text:final.assistant_content,model:final.model??"recovered",toolCallCount:0,durationMs:0,recovered:true,...(media.length>0?{media:returnedArtifactsJson(media)}:{})};
    }
    if(p.completedRecovery!==undefined){
      throw new ResidentProtocolError("request_invalid","completed recovery requires a terminal resident turn");
    }
    const active=this.#responses.get(turnId);if(active){
      try {
        const response=await active;
        const media=await residentReturnedArtifacts(response.media,this.#returnedArtifactRoots);
        return{text:response.text,model:response.model,toolCallCount:response.toolCallCount,durationMs:response.durationMs,...(media.length>0?{media:returnedArtifactsJson(media)}:{})};
      } catch (error) {
        const terminal=this.#store.finalEnvelope(chatId,turnId);
        if(terminal&&terminal.status!=="complete")throw new ResidentProtocolError("internal_error",terminal.error_message??terminal.error??`resident turn ended ${terminal.status}`);
        throw error;
      }
    }
    throw new ResidentProtocolError("connection_lost","resident result is not terminal",{retryable:true});
  }
}

export interface ResidentUdsAgentPortOptions {
  client:ResidentUdsClient;
  residentSlug:string;
  /** Per-request signed transport window. It does not bound the resident turn. */
  deadlineMs?:number;
  /** Overall startup/reattachment window while the resident harness comes online. */
  startTimeoutMs?:number;
  /** Overall wait for a terminal resident result. Defaults just beyond AgentLoop's hard limit. */
  resultTimeoutMs?:number;
  retryDelayMs?:number;
  now?:()=>number;
}

/** Coordinator-owned Agent port. Only privacy-safe turn data crosses UDS. */
export class ResidentUdsAgentPort implements ResidentAgentPort {
  readonly #active=new Map<string,{chatId:string;origin:CoordinationTurnOrigin;correlationId:string}>();
  readonly #requestDeadlineMs:number;
  readonly #startTimeoutMs:number;
  readonly #resultTimeoutMs:number;
  readonly #retryDelayMs:number;
  constructor(private readonly options:ResidentUdsAgentPortOptions){
    this.#requestDeadlineMs=Math.min(positiveSafeInteger(options.deadlineMs??MAX_REQUEST_DEADLINE_MS,"resident request deadline"),MAX_REQUEST_DEADLINE_MS);
    this.#startTimeoutMs=positiveSafeInteger(options.startTimeoutMs??DEFAULT_START_TIMEOUT_MS,"resident start timeout");
    this.#resultTimeoutMs=positiveSafeInteger(options.resultTimeoutMs??DEFAULT_RESULT_TIMEOUT_MS,"resident result timeout");
    this.#retryDelayMs=positiveSafeInteger(options.retryDelayMs??RESULT_RETRY_MS,"resident result retry delay");
  }
  async modelCatalog(input:{requestId:string;correlationId:string}):Promise<ResidentModelCatalog>{
    const now=()=>this.options.now?.()??Date.now();
    const response=await this.options.client.request({
      method:"GET",path:MODEL_CATALOG,payload:{},deadlineAtMs:now()+this.#requestDeadlineMs,
      requestId:input.requestId,correlationId:input.correlationId,
    });
    const payload=object(response.payload);
    if(!Array.isArray(payload.models)||!Array.isArray(payload.reasoningEfforts)||
      !exactHouseResidentCapabilities(payload.capabilities)){
      throw new ResidentProtocolError("request_invalid","resident model catalog is invalid");
    }
    const models=payload.models.map((raw)=>{
      const value=object(raw);
      return Object.freeze({
        alias:string(value.alias,"model alias"),provider:string(value.provider,"model provider"),
        model:string(value.model,"model"),reasoningEffort:reasoningEffort(value.reasoningEffort),
      });
    });
    const efforts=payload.reasoningEfforts.map((raw)=>{
      if(typeof raw!=="string"||!REASONING_EFFORTS.includes(raw as ReasoningEffort)){
        throw new ResidentProtocolError("request_invalid","resident reasoning effort catalog is invalid");
      }
      return raw as ReasoningEffort;
    });
    const defaultReasoningEffort=reasoningEffort(payload.defaultReasoningEffort);
    if(defaultReasoningEffort===null){
      throw new ResidentProtocolError("request_invalid","resident default reasoning effort is invalid");
    }
    return Object.freeze({
      capabilities:HOUSE_RESIDENT_CAPABILITIES,
      models:Object.freeze(models),defaultModel:string(payload.defaultModel,"defaultModel"),
      defaultProvider:string(payload.defaultProvider,"defaultProvider"),
      defaultReasoningEffort,
      reasoningEfforts:Object.freeze(efforts),
    });
  }
  async #replayEvents(input:{
    chatId:string;turnId:string;origin:CoordinationTurnOrigin;correlationId:string;
    onEvent(event:ResidentDurableEvent):void;now():number;
  }):Promise<ResidentDurableTerminal>{
    let afterSequence=0;
    let eventSequence=0;
    let chunkOffset=0;
    let totalBytes=0;
    let expectedDigest="";
    const chunks:Buffer[]=[];
    for(;;){
      let response;
      for(;;){
        try{
          response=await this.options.client.request({
            method:"GET",
            path:`/internal/v1/turns/${encodeURIComponent(input.turnId)}/events`,
            payload:{
              chatId:input.chatId,origin:jsonOrigin(input.origin),correlationId:input.correlationId,
              afterSequence,eventSequence,chunkOffset,
            },
            deadlineAtMs:input.now()+this.#requestDeadlineMs,
            fence:residentFence(input.origin),
            correlationId:input.correlationId,
          });
          break;
        }catch(caught){
          if(!retryableTransportWait(caught))throw caught;
          await new Promise(resolve=>setTimeout(resolve,this.#retryDelayMs));
        }
      }
      const payload=object(response.payload);
      if(string(payload.turnId,"turnId")!==input.turnId){
        throw new ResidentProtocolError("request_invalid","resident event turn does not match");
      }
      const provider=nullableString(payload.provider,"provider");
      const model=nullableString(payload.model,"model");
      const effort=reasoningEffort(payload.reasoningEffort);
      const terminal=durableTerminal(payload.terminal,{provider,model,reasoningEffort:effort});
      if(payload.event===null){
        if(eventSequence!==0||chunkOffset!==0||chunks.length!==0){
          throw new ResidentProtocolError("request_invalid","resident event ended during chunk replay");
        }
        if(terminal!==null){
          if(afterSequence!==terminal.lastSequence){
            throw new ResidentProtocolError("request_invalid","resident terminal event sequence is not contiguous");
          }
          return terminal;
        }
        await new Promise(resolve=>setTimeout(resolve,EVENT_REPLAY_DELAY_MS));
        continue;
      }
      const chunk=object(payload.event as JsonValue);
      const sequence=nonnegativeSafeInteger(chunk.sequence,"event sequence");
      const offset=nonnegativeSafeInteger(chunk.offset,"event chunk offset");
      const nextOffset=nonnegativeSafeInteger(chunk.nextOffset,"event next chunk offset");
      const eventTotalBytes=nonnegativeSafeInteger(chunk.totalBytes,"event total bytes");
      const digest=string(chunk.digest,"event digest");
      const chunkBase64=string(chunk.chunkBase64,"event chunk");
      const bytes=Buffer.from(chunkBase64,"base64");
      if(bytes.toString("base64")!==chunkBase64||nextOffset!==offset+bytes.length||
          nextOffset>eventTotalBytes||!/^[0-9a-f]{64}$/.test(digest)){
        throw new ResidentProtocolError("payload_digest_mismatch","resident event chunk is invalid");
      }
      if(eventSequence===0){
        if(sequence!==afterSequence+1||offset!==0){
          throw new ResidentProtocolError("request_invalid","resident event replay is not contiguous");
        }
        eventSequence=sequence;
        totalBytes=eventTotalBytes;
        expectedDigest=digest;
      }else if(sequence!==eventSequence||offset!==chunkOffset||
          eventTotalBytes!==totalBytes||digest!==expectedDigest){
        throw new ResidentProtocolError("request_invalid","resident event chunk identity changed");
      }
      chunks.push(bytes);
      chunkOffset=nextOffset;
      if(chunkOffset<totalBytes)continue;
      const encoded=Buffer.concat(chunks);
      if(encoded.length!==totalBytes||createHash("sha256").update(encoded).digest("hex")!==expectedDigest){
        throw new ResidentProtocolError("payload_digest_mismatch","resident event digest differs");
      }
      const record=decodeTurnEvent(encoded,input.turnId,eventSequence);
      input.onEvent(Object.freeze({
        turnId:input.turnId,
        sequence:record.seq,
        occurredAt:record.ts,
        provider,
        model,
        reasoningEffort:effort,
        event:Object.freeze({...(record.data as unknown as AgentEvent)}),
      }));
      afterSequence=eventSequence;
      eventSequence=0;
      chunkOffset=0;
      totalBytes=0;
      expectedDigest="";
      chunks.length=0;
      if(terminal!==null&&afterSequence===terminal.lastSequence)return terminal;
      await new Promise(resolve=>setTimeout(resolve,EVENT_REPLAY_DELAY_MS));
    }
  }
  async runWithTurn(chatId:string,userText:string,options:{coordinationOrigin:CoordinationTurnOrigin;coordinationDelivery?:CoordinationTurnDeliveryContext;coordinationRequest?:{requestId:string;correlationId:string};turnSelection:ResidentTurnSelectionRequest;attachments?:readonly ResidentInputAttachment[];completedRecovery?:true;onDurableStart(start:{turnId:string;chatId:string;persistedAt:string;selection?:ResidentTurnSelectionReceipt}):void|Promise<void>;onEvent(event:ResidentDurableEvent):void}){
    if(options.coordinationOrigin.authorityReference!==`resident:${this.options.residentSlug}`)throw new TypeError("resident authority does not match the configured port");
    const request=options.coordinationRequest;if(!request)throw new Error("resident coordination request identity is required");const turnId=`coord-${options.coordinationOrigin.workId}`;const fence=residentFence(options.coordinationOrigin);const now=()=>this.options.now?.()??Date.now();
    const requested=options.turnSelection??Object.freeze({modelAlias:null,reasoningEffort:null});
    const completedRecovery=options.completedRecovery===true;
    const attachments=(options.attachments??[]).map((attachment)=>({...attachment}));
    const delivery=jsonCoordinationDelivery(options.coordinationDelivery);
    const payload=(completedRecovery
      ? {chatId,turnId,origin:jsonOrigin(options.coordinationOrigin),...(delivery?{coordinationDelivery:delivery}:{}),correlationId:request.correlationId,turnSelection:{...requested}}
      : {chatId,instruction:userText,attachments,turnId,origin:jsonOrigin(options.coordinationOrigin),...(delivery?{coordinationDelivery:delivery}:{}),correlationId:request.correlationId,turnSelection:{...requested}}) as JsonValue;
    const startPath=completedRecovery?COMPLETED_RECOVERY_START:START;
    const startDeadlineAt=now()+this.#startTimeoutMs;let started;let firstStartRequest=true;
    for(;;){
      const remaining=startDeadlineAt-now();
      if(remaining<1)throw new ResidentProtocolError("deadline_exceeded","resident turn did not durably start before its overall deadline");
      try{
        started=await this.options.client.request({method:"POST",path:startPath,payload,deadlineAtMs:now()+Math.min(this.#requestDeadlineMs,remaining),fence,correlationId:request.correlationId,...(firstStartRequest?{requestId:request.requestId}:{})});
        break;
      }catch(caught){
        if(!retryableTransportWait(caught))throw caught;
        firstStartRequest=false;
        const retryRemaining=startDeadlineAt-now();
        if(retryRemaining<1)throw new ResidentProtocolError("deadline_exceeded","resident turn did not durably start before its overall deadline");
        await new Promise(resolve=>setTimeout(resolve,Math.min(this.#retryDelayMs,retryRemaining)));
      }
    }
    const s=object(started.payload);const selection=selectionReceipt(s.selection,requested);const startedTurnId=string(s.turnId,"turnId");const startedChatId=string(s.chatId,"chatId");
    if(completedRecovery&&(startedTurnId!==turnId||startedChatId!==chatId||s.recovered!==true||s.completedRecovery!==true)){
      throw new ResidentProtocolError("request_invalid","resident completed recovery acknowledgement does not match");
    }
    await options.onDurableStart({turnId:startedTurnId,chatId:startedChatId,persistedAt:string(s.persistedAt,"persistedAt"),selection});this.#active.set(turnId,{chatId,origin:options.coordinationOrigin,correlationId:request.correlationId});
    const result=(async()=>{
      const resultDeadlineAt=now()+this.#resultTimeoutMs;
      for(;;){
        const remaining=resultDeadlineAt-now();
        if(remaining<1)throw new ResidentProtocolError("deadline_exceeded","resident result did not become terminal before its overall deadline");
        try{
          const result=await this.options.client.request({method:"GET",path:`/internal/v1/turns/${encodeURIComponent(turnId)}/result`,payload:{chatId,origin:jsonOrigin(options.coordinationOrigin),correlationId:request.correlationId,...(completedRecovery?{completedRecovery:true}:{})},deadlineAtMs:now()+Math.min(this.#requestDeadlineMs,remaining),fence,correlationId:request.correlationId});const value=object(result.payload);const media=parseResidentReturnedArtifacts(value.media);return{text:string(value.text,"text"),model:string(value.model,"model"),toolCallCount:nonnegativeSafeInteger(value.toolCallCount,"toolCallCount"),durationMs:nonnegativeSafeInteger(value.durationMs,"durationMs"),...(media.length>0?{media}:{})};
        }catch(caught){
          if(!retryableTransportWait(caught))throw caught;
          const retryRemaining=resultDeadlineAt-now();
          if(retryRemaining<1)throw new ResidentProtocolError("deadline_exceeded","resident result did not become terminal before its overall deadline");
          await new Promise(resolve=>setTimeout(resolve,Math.min(this.#retryDelayMs,retryRemaining)));
        }
      }
    })();
    const eventReplay=this.#replayEvents({
      chatId,turnId,origin:options.coordinationOrigin,correlationId:request.correlationId,
      onEvent:options.onEvent,now,
    });
    const response=Promise.all([result,eventReplay]).then(([value])=>value).catch((error)=>{
      void this.stop(chatId,turnId).catch(()=>undefined);
      throw error;
    }).finally(()=>{this.#active.delete(turnId);});
    return{turnId,response,terminal:eventReplay,selection};
  }
  async stop(chatId:string,turnId:string){
    const active=this.#active.get(turnId);if(!active||active.chatId!==chatId)return{stopped:false};const result=await this.options.client.request({method:"POST",path:`/internal/v1/turns/${encodeURIComponent(turnId)}/stop`,payload:{chatId,origin:jsonOrigin(active.origin),correlationId:active.correlationId},deadlineAtMs:(this.options.now?.()??Date.now())+5_000,fence:residentFence(active.origin),correlationId:active.correlationId});return{stopped:object(result.payload).stopped===true};
  }
  async close(){await this.options.client.close();}
}
