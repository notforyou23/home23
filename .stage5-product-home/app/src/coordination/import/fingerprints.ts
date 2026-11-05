import { deepFreeze } from "./canonical.js";
import type {
  QuarantineRange,
  SegmentChangeClassification,
  SegmentFingerprint,
} from "./types.js";

function changedRanges(
  previous: SegmentFingerprint,
  current: SegmentFingerprint,
): QuarantineRange[] {
  const ranges: QuarantineRange[] = [];
  const common = Math.min(previous.records.length, current.records.length);
  let rangeStart: number | null = null;
  for (let index = 0; index < common; index += 1) {
    const before = previous.records[index];
    const after = current.records[index];
    const changed = before?.digest !== after?.digest
      || before?.byteOffset !== after?.byteOffset
      || before?.nextByteOffset !== after?.nextByteOffset
      || before?.terminated !== after?.terminated;
    if (changed && rangeStart === null) rangeStart = index;
    if (!changed && rangeStart !== null) {
      ranges.push({
        startRecordIndex: rangeStart,
        endRecordIndexExclusive: index,
        reason: previous.closed ? "closed_segment_changed" : "historical_record_digest_changed",
      });
      rangeStart = null;
    }
  }
  if (rangeStart !== null) {
    ranges.push({
      startRecordIndex: rangeStart,
      endRecordIndexExclusive: common,
      reason: previous.closed ? "closed_segment_changed" : "historical_record_digest_changed",
    });
  }
  return ranges;
}

export function classifySegmentChange(
  previous: SegmentFingerprint,
  current: SegmentFingerprint,
): SegmentChangeClassification {
  if (previous.sourceId !== current.sourceId) {
    throw new Error("segment comparison requires the same registered source");
  }
  if (previous.segmentIdentity !== current.segmentIdentity) {
    return deepFreeze({
      kind: "rotation",
      quarantine: [],
      previousSegmentIdentity: previous.segmentIdentity,
      nextSegmentIdentity: current.segmentIdentity,
    });
  }

  const edits = changedRanges(previous, current);
  if (current.records.length < previous.records.length || current.byteLength < previous.byteLength) {
    const quarantine = [...edits, {
      startRecordIndex: current.records.length,
      endRecordIndexExclusive: previous.records.length,
      reason: "historical_records_truncated" as const,
    }].filter((range) => range.startRecordIndex < range.endRecordIndexExclusive);
    return deepFreeze({ kind: "truncation", quarantine });
  }
  if (edits.length > 0) return deepFreeze({ kind: "historical_edit", quarantine: edits });

  const grew = current.records.length > previous.records.length || current.byteLength > previous.byteLength;
  if (grew && previous.closed) {
    return deepFreeze({
      kind: "historical_edit",
      quarantine: [{
        startRecordIndex: previous.records.length,
        endRecordIndexExclusive: current.records.length,
        reason: "closed_segment_changed",
      }],
    });
  }
  if (grew) {
    return deepFreeze({
      kind: "append",
      quarantine: [],
      appendedRecordRange: {
        start: previous.records.length,
        endExclusive: current.records.length,
      },
    });
  }
  return deepFreeze({ kind: "unchanged", quarantine: [] });
}
