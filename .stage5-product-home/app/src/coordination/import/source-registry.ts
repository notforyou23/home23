import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";

import { AUTHORITY_EPOCH_REGISTRY, validateContractId } from "../schema/contract-registry.js";
import { canonicalJson, deepFreeze, sha256 } from "./canonical.js";
import type {
  DiscoveredLegacySource,
  ImportCohort,
  LegacySourceRegistration,
  LegacySourceRegistry,
  LegacySourceRegistryReceipt,
  LegacySourceType,
  PartialSegmentTail,
  SegmentFingerprint,
  SegmentRecordFingerprint,
} from "./types.js";

const SOURCE_TYPES = new Set<LegacySourceType>([
  "conversation_jsonl",
  "session_turn_jsonl",
  "workspace_session_jsonl",
  "upload_chat_manifest",
]);
const COHORTS = new Set<ImportCohort>(["H0", "H1", "H2", "H3", "H4", "H5"]);
const PRIVACY_CLASSES = new Set(["resident_private", "owner_private", "house_shared"]);
const APPEND_POLICIES = new Set(["disabled", "reviewed_safe"]);
const SEGMENT_STATES = new Set(["open", "closed"]);
const PATTERN_MARKER = /[*?[\]{}]/;
const physicalOwnersByRegistry = new WeakMap<LegacySourceRegistry, Map<string, string>>();

function validateRegistration(registration: LegacySourceRegistration): void {
  if (!validateContractId("legacySource", registration.sourceId)) {
    throw new Error(`invalid legacy source id: ${registration.sourceId}`);
  }
  if (registration.locator?.kind !== "exact_file") {
    throw new Error("legacy discovery accepts exact_file locators only; crawl roots are forbidden");
  }
  if (!isAbsolute(registration.locator.absolutePath)) {
    throw new Error("legacy source locator must be an absolute exact file path");
  }
  if (PATTERN_MARKER.test(registration.locator.absolutePath)) {
    throw new Error("legacy source locator patterns are forbidden");
  }
  if (!SOURCE_TYPES.has(registration.sourceType)) {
    if (String(registration.sourceType).includes("memory")) {
      throw new Error("resident memory is not an import source");
    }
    throw new Error(`unsupported legacy source type: ${String(registration.sourceType)}`);
  }
  if (!registration.owner?.residentId || !registration.owner.domain) {
    throw new Error("legacy source owner and domain are required");
  }
  if (!validateContractId("bot", registration.owner.residentBotId)) {
    throw new Error("legacy source owner residentBotId is invalid");
  }
  if (!validateContractId("principal", registration.reviewedBy)) {
    throw new Error("legacy source reviewer must be a canonical principal");
  }
  if (!registration.parserVersion || !registration.sourceVersion) {
    throw new Error("legacy source and parser versions are required");
  }
  if (!Number.isSafeInteger(registration.authority.epoch) || registration.authority.epoch < 1) {
    throw new Error("legacy source authority epoch must be a positive integer");
  }
  if (!registration.authority.writer) throw new Error("legacy source authority writer is required");
  if (!PRIVACY_CLASSES.has(registration.privacyClass)) {
    throw new Error("unsupported legacy source privacy class");
  }
  if (!AUTHORITY_EPOCH_REGISTRY.capabilities.includes(registration.authority.capability)) {
    throw new Error("invalid legacy source authority capability");
  }
  if (!AUTHORITY_EPOCH_REGISTRY.modes.includes(registration.authority.mode)) {
    throw new Error("invalid legacy source authority mode");
  }
  if (!APPEND_POLICIES.has(registration.appendOnlyTailing)) {
    throw new Error("legacy source append policy must be explicitly reviewed");
  }
  if (!SEGMENT_STATES.has(registration.segmentState ?? "open")) {
    throw new Error("invalid legacy source segment state");
  }
  if (
    !Number.isSafeInteger(registration.maxRecordBytes)
    || registration.maxRecordBytes < 1
    || registration.maxRecordBytes > 16 * 1_024 * 1_024
  ) {
    throw new Error("legacy source maxRecordBytes must be between 1 and 16777216");
  }
  if (registration.allowedCohorts.length === 0) throw new Error("allowed cohorts cannot be empty");
  if (new Set(registration.allowedCohorts).size !== registration.allowedCohorts.length) {
    throw new Error("allowed cohorts cannot contain duplicates");
  }
  for (const cohort of registration.allowedCohorts) {
    if (!COHORTS.has(cohort)) throw new Error(`unsupported import cohort: ${String(cohort)}`);
  }
}

function receiptFor(registration: LegacySourceRegistration): LegacySourceRegistryReceipt {
  return deepFreeze({
    sourceId: registration.sourceId,
    owner: { ...registration.owner },
    locatorDigest: sha256(canonicalJson({
      kind: registration.locator.kind,
      absolutePath: registration.locator.absolutePath,
    })),
    sourceType: registration.sourceType,
    sourceVersion: registration.sourceVersion,
    parserVersion: registration.parserVersion,
    privacyClass: registration.privacyClass,
    allowedCohorts: [...registration.allowedCohorts],
    reviewedBy: registration.reviewedBy,
    authority: { ...registration.authority },
    appendOnlyTailing: registration.appendOnlyTailing,
    segmentState: registration.segmentState ?? "open",
    maxRecordBytes: registration.maxRecordBytes,
  });
}

export function createLegacySourceRegistry(
  registrations: readonly LegacySourceRegistration[],
): LegacySourceRegistry {
  const byId = new Map<string, LegacySourceRegistration>();
  const locatorDigests = new Set<string>();
  const receipts: LegacySourceRegistryReceipt[] = [];
  for (const candidate of registrations) {
    validateRegistration(candidate);
    if (byId.has(candidate.sourceId)) throw new Error(`duplicate legacy source id: ${candidate.sourceId}`);
    const immutable = deepFreeze({
      ...candidate,
      owner: { ...candidate.owner },
      locator: { ...candidate.locator },
      allowedCohorts: [...candidate.allowedCohorts],
      authority: { ...candidate.authority },
      segmentState: candidate.segmentState ?? "open",
    });
    const receipt = receiptFor(immutable);
    if (locatorDigests.has(receipt.locatorDigest)) {
      throw new Error("the same exact legacy source file cannot be registered twice");
    }
    locatorDigests.add(receipt.locatorDigest);
    byId.set(candidate.sourceId, immutable);
    receipts.push(receipt);
  }
  receipts.sort((left, right) => (
    left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0
  ));
  const immutableReceipts = deepFreeze(receipts);
  const registry = Object.freeze({
    receipts: () => immutableReceipts,
    registration: (sourceId: string) => byId.get(sourceId),
  });
  physicalOwnersByRegistry.set(registry, new Map());
  return registry;
}

export function computeSourceRegistryDigest(registry: LegacySourceRegistry): string {
  return sha256(canonicalJson(registry.receipts()));
}

function fingerprintDescriptor(
  descriptor: number,
  maxRecordBytes: number,
  closed: boolean,
): {
  records: SegmentRecordFingerprint[];
  partialTail: PartialSegmentTail | null;
  byteLength: number;
  fileDigest: string;
} {
  const records: SegmentRecordFingerprint[] = [];
  const fileHasher = createHash("sha256");
  let recordHasher = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1_024);
  let byteOffset = 0;
  let recordStart = 0;
  let recordBytes = 0;

  while (true) {
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    let cursor = 0;
    while (cursor < bytesRead) {
      const newline = buffer.indexOf(0x0a, cursor);
      const end = newline === -1 || newline >= bytesRead ? bytesRead : newline;
      const content = buffer.subarray(cursor, end);
      fileHasher.update(content);
      recordHasher.update(content);
      recordBytes += content.length;
      byteOffset += content.length;
      if (recordBytes > maxRecordBytes) {
        throw new Error("legacy source record exceeds its maximum reviewed record size");
      }
      if (newline === -1 || newline >= bytesRead) {
        cursor = bytesRead;
        continue;
      }
      fileHasher.update("\n", "utf8");
      byteOffset += 1;
      records.push({
        recordIndex: records.length,
        byteOffset: recordStart,
        nextByteOffset: byteOffset,
        digest: recordHasher.digest("hex"),
        tailDigest: fileHasher.copy().digest("hex"),
        terminated: true,
      });
      recordHasher = createHash("sha256");
      recordStart = byteOffset;
      recordBytes = 0;
      cursor = newline + 1;
    }
  }

  let partialTail: PartialSegmentTail | null = null;
  if (recordBytes > 0) {
    const digest = recordHasher.digest("hex");
    if (closed) {
      records.push({
        recordIndex: records.length,
        byteOffset: recordStart,
        nextByteOffset: byteOffset,
        digest,
        tailDigest: fileHasher.copy().digest("hex"),
        terminated: false,
      });
    } else {
      partialTail = { byteOffset: recordStart, byteLength: recordBytes, digest };
    }
  }
  return {
    records,
    partialTail,
    byteLength: byteOffset,
    fileDigest: fileHasher.digest("hex"),
  };
}

export function discoverRegisteredSource(
  registry: LegacySourceRegistry,
  sourceId: string,
): DiscoveredLegacySource {
  const registration = registry.registration(sourceId);
  if (!registration) throw new Error(`legacy source is not allowlisted: ${sourceId}`);
  const path = registration.locator.absolutePath;
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error("legacy discovery refuses symlinks and non-regular files");
  }
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(path, constants.O_RDONLY | noFollow);
  let stats: ReturnType<typeof fstatSync>;
  let afterRead: ReturnType<typeof fstatSync>;
  let streamed: ReturnType<typeof fingerprintDescriptor>;
  try {
    stats = fstatSync(descriptor);
    streamed = fingerprintDescriptor(
      descriptor,
      registration.maxRecordBytes,
      registration.segmentState === "closed",
    );
    afterRead = fstatSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  if (!stats.isFile()) throw new Error("legacy discovery source changed away from a regular file");
  if (
    before.dev !== stats.dev
    || before.ino !== stats.ino
    || stats.dev !== afterRead.dev
    || stats.ino !== afterRead.ino
    || stats.size !== afterRead.size
    || stats.mtimeMs !== afterRead.mtimeMs
    || stats.ctimeMs !== afterRead.ctimeMs
    || stats.size !== streamed.byteLength
  ) {
    throw new Error("legacy source changed during fixed-watermark discovery");
  }

  const physicalIdentityDigest = sha256(canonicalJson({
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
    birthtimeMs: stats.birthtimeMs,
  }));
  const physicalOwners = physicalOwnersByRegistry.get(registry);
  if (!physicalOwners) throw new Error("legacy source registry was not created by the reviewed registry factory");
  const existingPhysicalOwner = physicalOwners.get(physicalIdentityDigest);
  if (existingPhysicalOwner && existingPhysicalOwner !== sourceId) {
    throw new Error("physical legacy source is already registered under another source id");
  }
  physicalOwners.set(physicalIdentityDigest, sourceId);
  const segmentIdentity = sha256(canonicalJson({
    kind: "legacy-segment-v1",
    physicalIdentityDigest,
  }));
  const records = streamed.records;
  const closed = registration.segmentState === "closed";
  const fingerprint: SegmentFingerprint = deepFreeze({
    sourceId,
    segmentIdentity,
    physicalIdentityDigest,
    byteLength: streamed.byteLength,
    modifiedAt: new Date(stats.mtimeMs).toISOString(),
    recordCount: records.length,
    firstRecordDigest: records[0]?.digest ?? null,
    lastRecordDigest: records.at(-1)?.digest ?? null,
    tailDigest: streamed.fileDigest,
    fullDigest: closed ? streamed.fileDigest : null,
    records,
    partialTail: streamed.partialTail,
    closed,
  });
  const receipt = registry.receipts().find((candidate) => candidate.sourceId === sourceId);
  if (!receipt) throw new Error(`legacy source registry receipt is missing: ${sourceId}`);
  return deepFreeze({
    source: receipt,
    fingerprint,
    watermark: {
      recordIndex: records.length,
      byteOffset: streamed.byteLength,
      tailDigest: streamed.fileDigest,
    },
  });
}
