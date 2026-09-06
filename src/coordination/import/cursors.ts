import { deepFreeze, requireSha256, sha256 } from "./canonical.js";
import type { ImportCursor, SegmentFingerprint } from "./types.js";

export interface ImportResumePlan {
  readonly sourceId: string;
  readonly segmentIdentity: string;
  readonly startRecordIndex: number;
  readonly startByteOffset: number;
  readonly overlapRecords: number;
  readonly dedupeRequired: true;
}

export function createResumePlan(input: {
  readonly cursor: ImportCursor;
  readonly current: SegmentFingerprint;
  readonly overlapRecords: number;
}): ImportResumePlan {
  const { cursor, current, overlapRecords } = input;
  if (cursor.sourceId !== current.sourceId || cursor.segmentIdentity !== current.segmentIdentity) {
    throw new Error("crash cursor cannot resume across a source rotation");
  }
  if (!Number.isSafeInteger(overlapRecords) || overlapRecords < 0) {
    throw new Error("overlapRecords must be a non-negative integer");
  }
  if (cursor.nextRecordIndex < 0 || cursor.nextRecordIndex > current.recordCount) {
    throw new Error("crash cursor record index is outside the current segment");
  }
  requireSha256(cursor.committedTailDigest, "cursor committedTailDigest");
  const expectedByteOffset = cursor.nextRecordIndex === 0
    ? 0
    : current.records[cursor.nextRecordIndex - 1]?.nextByteOffset;
  if (cursor.nextByteOffset !== expectedByteOffset) {
    throw new Error("crash cursor byte offset does not match its committed record boundary");
  }
  if (cursor.nextRecordIndex > 0) {
    const committedRecord = current.records[cursor.nextRecordIndex - 1];
    if (!committedRecord || committedRecord.tailDigest !== cursor.committedTailDigest) {
      throw new Error("crash cursor historical watermark changed; quarantine is required");
    }
  } else if (cursor.committedTailDigest !== sha256(new Uint8Array())) {
    throw new Error("empty crash cursor must carry the empty source tail digest");
  }
  const startRecordIndex = Math.max(0, cursor.nextRecordIndex - overlapRecords);
  const startByteOffset = current.records[startRecordIndex]?.byteOffset ?? cursor.nextByteOffset;
  return deepFreeze({
    sourceId: cursor.sourceId,
    segmentIdentity: cursor.segmentIdentity,
    startRecordIndex,
    startByteOffset,
    overlapRecords: cursor.nextRecordIndex - startRecordIndex,
    dedupeRequired: true,
  });
}
