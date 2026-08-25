import assert from "node:assert/strict";
import {
  appendFileSync,
  linkSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  classifySegmentChange,
  createLegacySourceRegistry,
  discoverRegisteredSource,
  type LegacySourceRegistration,
} from "../../../src/coordination/import/index.js";

const SOURCE_ID = "legacy_0198d95f-6c00-7000-8000-000000000091";

function temporarySource(t: test.TestContext, contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), "home23-m17-source-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "conversation.jsonl");
  writeFileSync(path, contents);
  return path;
}

function registration(path: string): LegacySourceRegistration {
  return {
    sourceId: SOURCE_ID,
    owner: {
      residentId: "resident-jerry",
      residentBotId: "bot_0198d95f-6c00-7000-8000-000000000011",
      domain: "direct-conversation",
    },
    locator: { kind: "exact_file", absolutePath: path },
    sourceType: "conversation_jsonl",
    sourceVersion: "legacy-v1",
    parserVersion: "jsonl-v1",
    privacyClass: "resident_private",
    allowedCohorts: ["H0", "H1", "H2", "H4", "H5"],
    reviewedBy: "user_owner",
    authority: {
      capability: "messages",
      mode: "legacy",
      epoch: 1,
      writer: "legacy-jsonl",
    },
    appendOnlyTailing: "reviewed_safe",
    maxRecordBytes: 1_024,
  };
}

test("discovery reads only an exact allowlisted file and receipts redact its path", (t) => {
  const path = temporarySource(t, '{"id":"one"}\n{"id":"two"}\n');
  const registry = createLegacySourceRegistry([registration(path)]);

  const receipt = registry.receipts()[0];
  assert.equal(receipt?.sourceId, SOURCE_ID);
  assert.match(receipt?.locatorDigest ?? "", /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(receipt).includes(path), false);
  assert.equal(receipt?.segmentState, "open");
  assert.equal(receipt?.maxRecordBytes, 1_024);

  const discovered = discoverRegisteredSource(registry, SOURCE_ID);
  assert.equal(discovered.fingerprint.recordCount, 2);
  assert.equal(discovered.fingerprint.byteLength, 26);
  assert.equal(discovered.watermark.recordIndex, 2);
  assert.equal(discovered.watermark.byteOffset, 26);
  assert.equal(Object.isFrozen(discovered.fingerprint), true);
  assert.equal(Object.isFrozen(discovered.fingerprint.records), true);
});

test("behavior-changing source policy fields are validated and bound into receipts", (t) => {
  const path = temporarySource(t, "{}\n");
  const invalid = [
    { ...registration(path), privacyClass: "public" },
    { ...registration(path), authority: { ...registration(path).authority, capability: "widgets" } },
    { ...registration(path), authority: { ...registration(path).authority, mode: "dual" } },
    { ...registration(path), appendOnlyTailing: "assumed_safe" },
    { ...registration(path), segmentState: "rotating" },
    {
      ...registration(path),
      owner: { ...registration(path).owner, residentBotId: "not-a-bot" },
    },
  ];

  for (const candidate of invalid) {
    assert.throws(
      () => createLegacySourceRegistry([candidate as never]),
      /invalid|unsupported|must|reviewed/,
      JSON.stringify(candidate),
    );
  }
});

test("open discovery does not commit an unterminated tail record", (t) => {
  const path = temporarySource(t, "partial");
  const registry = createLegacySourceRegistry([registration(path)]);
  const before = discoverRegisteredSource(registry, SOURCE_ID).fingerprint;
  assert.equal(before.recordCount, 0);
  assert.deepEqual(before.partialTail, {
    byteOffset: 0,
    byteLength: 7,
    digest: "9834a14ab9bcaa0f6a8da71073617eac8f004e596a3fa11d807b84631b825d9d",
  });

  appendFileSync(path, "\n");
  const completed = discoverRegisteredSource(registry, SOURCE_ID).fingerprint;
  assert.equal(completed.recordCount, 1);
  assert.deepEqual(classifySegmentChange(before, completed), {
    kind: "append",
    quarantine: [],
    appendedRecordRange: { start: 0, endExclusive: 1 },
  });

  const closedRegistry = createLegacySourceRegistry([
    { ...registration(path), segmentState: "closed" },
  ]);
  const closed = discoverRegisteredSource(closedRegistry, SOURCE_ID).fingerprint;
  assert.match(closed.fullDigest ?? "", /^[a-f0-9]{64}$/);
});

test("discovery enforces the reviewed maximum record size", (t) => {
  const path = temporarySource(t, `${"x".repeat(64)}\n`);
  const registry = createLegacySourceRegistry([
    { ...registration(path), maxRecordBytes: 32 },
  ]);
  assert.throws(
    () => discoverRegisteredSource(registry, SOURCE_ID),
    /maximum reviewed record size/,
  );
});

test("the registry rejects crawl roots, patterns, and resident-memory sources", (t) => {
  const path = temporarySource(t, "{}\n");

  assert.throws(
    () => createLegacySourceRegistry([
      { ...registration(path), locator: { kind: "directory", absolutePath: path } } as never,
    ]),
    /exact_file/,
  );
  assert.throws(
    () => createLegacySourceRegistry([
      registration(path.replace("conversation.jsonl", "*.jsonl")),
    ]),
    /patterns are forbidden/,
  );
  assert.throws(
    () => createLegacySourceRegistry([
      { ...registration(path), sourceType: "resident_memory" } as never,
    ]),
    /resident memory/,
  );
});

test("discovery rejects one physical file registered through two hard-link paths", (t) => {
  const path = temporarySource(t, "{}\n");
  const aliasPath = `${path}.hard-link`;
  linkSync(path, aliasPath);
  const otherSourceId = "legacy_0198d95f-6c00-7000-8000-000000000092";
  const registry = createLegacySourceRegistry([
    registration(path),
    { ...registration(aliasPath), sourceId: otherSourceId },
  ]);

  discoverRegisteredSource(registry, SOURCE_ID);
  assert.throws(
    () => discoverRegisteredSource(registry, otherSourceId),
    /physical legacy source is already registered under another source id/,
  );
});

test("append and rotation produce distinct non-destructive classifications", (t) => {
  const path = temporarySource(t, "one\ntwo\n");
  const registry = createLegacySourceRegistry([registration(path)]);
  const initial = discoverRegisteredSource(registry, SOURCE_ID).fingerprint;

  appendFileSync(path, "three\n");
  const appended = discoverRegisteredSource(registry, SOURCE_ID).fingerprint;
  assert.deepEqual(classifySegmentChange(initial, appended), {
    kind: "append",
    quarantine: [],
    appendedRecordRange: { start: 2, endExclusive: 3 },
  });

  renameSync(path, `${path}.sealed`);
  writeFileSync(path, "replacement\n");
  const rotated = discoverRegisteredSource(registry, SOURCE_ID).fingerprint;
  const classification = classifySegmentChange(appended, rotated);
  assert.equal(classification.kind, "rotation");
  assert.deepEqual(classification.quarantine, []);
  assert.equal(classification.previousSegmentIdentity, appended.segmentIdentity);
  assert.equal(classification.nextSegmentIdentity, rotated.segmentIdentity);
});

test("a changed historical line quarantines only the affected range", (t) => {
  const path = temporarySource(t, "one\ntwo\nthree\n");
  const registry = createLegacySourceRegistry([registration(path)]);
  const initial = discoverRegisteredSource(registry, SOURCE_ID).fingerprint;

  writeFileSync(path, "one\nTWO\nthree\n");
  const edited = discoverRegisteredSource(registry, SOURCE_ID).fingerprint;
  assert.deepEqual(classifySegmentChange(initial, edited), {
    kind: "historical_edit",
    quarantine: [
      {
        startRecordIndex: 1,
        endRecordIndexExclusive: 2,
        reason: "historical_record_digest_changed",
      },
    ],
  });
});

test("changing a closed segment's record terminator is a historical edit", (t) => {
  const path = temporarySource(t, "one");
  const registry = createLegacySourceRegistry([
    { ...registration(path), segmentState: "closed" },
  ]);
  const initial = discoverRegisteredSource(registry, SOURCE_ID).fingerprint;
  assert.equal(initial.records[0]?.terminated, false);

  appendFileSync(path, "\n");
  const edited = discoverRegisteredSource(registry, SOURCE_ID).fingerprint;
  assert.equal(edited.records[0]?.terminated, true);
  assert.deepEqual(classifySegmentChange(initial, edited), {
    kind: "historical_edit",
    quarantine: [{
      startRecordIndex: 0,
      endRecordIndexExclusive: 1,
      reason: "closed_segment_changed",
    }],
  });
});
