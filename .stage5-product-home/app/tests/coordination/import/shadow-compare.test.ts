import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createChannelService } from "../../../src/coordination/channels/index.js";
import {
  compareShadowRead,
  type SegmentFingerprint,
  type ShadowComparableRecord,
} from "../../../src/coordination/import/index.js";
import { createMessageService } from "../../../src/coordination/messages/index.js";
import {
  CANONICAL_SEARCH_SCHEMA_DELTA_SQL,
  SqliteCanonicalSearchRepository,
  createCanonicalSearchService,
} from "../../../src/coordination/search/index.js";
import {
  OWNER_ID,
  createMessagingFixture,
  fixtureId,
  ownerContext,
} from "../messaging/test-fixture.js";

const SOURCE_ID = "legacy_0198d95f-6c00-7000-8000-000000000091";

function fingerprint(
  recordDigests = ["a".repeat(64), "b".repeat(64)],
  tailDigest = "2".repeat(64),
): SegmentFingerprint {
  return {
    sourceId: SOURCE_ID,
    segmentIdentity: "d".repeat(64),
    physicalIdentityDigest: "f".repeat(64),
    byteLength: recordDigests.length * 10,
    modifiedAt: "2026-08-25T12:00:00.000Z",
    recordCount: recordDigests.length,
    firstRecordDigest: recordDigests[0] ?? null,
    lastRecordDigest: recordDigests.at(-1) ?? null,
    tailDigest,
    fullDigest: null,
    records: recordDigests.map((digest, recordIndex) => ({
      recordIndex,
      byteOffset: recordIndex * 10,
      nextByteOffset: (recordIndex + 1) * 10,
      digest,
      tailDigest: recordIndex === recordDigests.length - 1
        ? tailDigest
        : String(recordIndex + 1).repeat(64),
      terminated: true,
    })),
    partialTail: null,
    closed: false,
  };
}

const sourceRecords: readonly ShadowComparableRecord[] = [
  { stableKey: "one", sourceRecordIndex: 0, sourceRecordDigest: "a".repeat(64), speakerKey: "owner", normalizedDigest: "1".repeat(64), attachmentCount: 0, availableAttachmentCount: 0 },
  { stableKey: "two", sourceRecordIndex: 1, sourceRecordDigest: "b".repeat(64), speakerKey: "bot:jerry", normalizedDigest: "2".repeat(64), attachmentCount: 1, availableAttachmentCount: 1 },
];

const comparable = {
  sourceId: SOURCE_ID,
  capability: "messages" as const,
  authority: { mode: "shadow" as const, epoch: 2, writer: "legacy-jsonl" },
  range: { startRecordIndex: 0, endRecordIndexExclusive: 2 },
  sourceFingerprintBefore: fingerprint(),
  sourceFingerprintAfter: fingerprint(),
  sourceWatermarkBefore: { recordIndex: 2, byteOffset: 20, tailDigest: "2".repeat(64) },
  sourceWatermarkAfter: { recordIndex: 2, byteOffset: 20, tailDigest: "2".repeat(64) },
  canonicalWatermark: { eventSequence: 8, messageCount: 2, projectedSourceRecordIndex: 2 },
  includedClasses: ["owner", "bot"] as const,
  excludedClasses: ["tool", "system"] as const,
  privacyFilters: ["resident-private-reviewed-cohort"] as const,
  aliasMappingVersion: "aliases-v1",
  aliasAmbiguities: [] as readonly string[],
  collisions: [] as readonly string[],
  quarantines: [] as readonly string[],
  sourceRecords,
  canonicalRecords: sourceRecords,
};

test("shadow comparison emits a validated body-free matched receipt", () => {
  const receipt = compareShadowRead(comparable);

  assert.equal(receipt.verdict, "match");
  assert.equal(receipt.driftCount, 0);
  assert.equal(receipt.lagRecords, 0);
  assert.equal(receipt.orderedMessageCount.source, 2);
  assert.equal(receipt.orderedMessageCount.canonical, 2);
  assert.equal(receipt.attachments.source.available, 1);
  assert.equal(receipt.mismatches.length, 0);
  assert.equal(JSON.stringify(receipt).includes("visibleBody"), false);
});

test("shadow comparison derives source, lag, alias, and content drift from evidence", () => {
  const changedFingerprint = fingerprint(["a".repeat(64), "9".repeat(64)], "9".repeat(64));
  const cases = [
    {
      input: {
        ...comparable,
        sourceFingerprintAfter: changedFingerprint,
        sourceWatermarkAfter: { recordIndex: 2, byteOffset: 20, tailDigest: "9".repeat(64) },
      },
      classification: "source_changed",
    },
    {
      input: {
        ...comparable,
        canonicalWatermark: { ...comparable.canonicalWatermark, projectedSourceRecordIndex: 1 },
      },
      classification: "projection_lag",
    },
    {
      input: { ...comparable, aliasAmbiguities: ["legacy-message-two"] },
      classification: "alias_ambiguity",
    },
    {
      input: {
        ...comparable,
        canonicalRecords: [
          comparable.canonicalRecords[0]!,
          { ...comparable.canonicalRecords[1]!, normalizedDigest: "9".repeat(64) },
        ],
      },
      classification: "content_mismatch",
    },
  ] as const;

  for (const item of cases) {
    const receipt = compareShadowRead(item.input);
    assert.equal(receipt.verdict, "blocked", item.classification);
    assert.equal(
      receipt.mismatches.some((mismatch) => mismatch.classification === item.classification),
      true,
      item.classification,
    );
  }
});

test("declared middle exclusions align by stable key without cascading drift", () => {
  const threeSourceRecords: readonly ShadowComparableRecord[] = [
    sourceRecords[0]!,
    { stableKey: "excluded", sourceRecordIndex: 1, sourceRecordDigest: "e".repeat(64), speakerKey: "tool", normalizedDigest: "e".repeat(64), attachmentCount: 0, availableAttachmentCount: 0 },
    { stableKey: "three", sourceRecordIndex: 2, sourceRecordDigest: "c".repeat(64), speakerKey: "bot:jerry", normalizedDigest: "3".repeat(64), attachmentCount: 0, availableAttachmentCount: 0 },
  ];
  const receipt = compareShadowRead({
    ...comparable,
    range: { startRecordIndex: 0, endRecordIndexExclusive: 3 },
    sourceFingerprintBefore: fingerprint(["a".repeat(64), "e".repeat(64), "c".repeat(64)], "3".repeat(64)),
    sourceFingerprintAfter: fingerprint(["a".repeat(64), "e".repeat(64), "c".repeat(64)], "3".repeat(64)),
    sourceWatermarkBefore: { recordIndex: 3, byteOffset: 30, tailDigest: "3".repeat(64) },
    sourceWatermarkAfter: { recordIndex: 3, byteOffset: 30, tailDigest: "3".repeat(64) },
    canonicalWatermark: { eventSequence: 9, messageCount: 2, projectedSourceRecordIndex: 3 },
    excludedStableKeys: ["excluded"],
    sourceRecords: threeSourceRecords,
    canonicalRecords: [threeSourceRecords[0]!, threeSourceRecords[2]!],
  });

  assert.equal(receipt.verdict, "match");
  assert.equal(receipt.driftCount, 0);
  assert.deepEqual(receipt.expectedExclusions, ["excluded"]);
});

test("malformed evidence cannot emit a match receipt", () => {
  assert.throws(() => compareShadowRead({ ...comparable, sourceId: "not-a-source" }), /source id/);
  assert.throws(
    () => compareShadowRead({
      ...comparable,
      range: { startRecordIndex: 2, endRecordIndexExclusive: 1 },
    }),
    /comparable range/,
  );
  assert.throws(
    () => compareShadowRead({
      ...comparable,
      canonicalWatermark: { ...comparable.canonicalWatermark, messageCount: 99 },
    }),
    /canonical message count/,
  );
  assert.throws(
    () => compareShadowRead({
      ...comparable,
      sourceFingerprintBefore: {
        ...comparable.sourceFingerprintBefore,
        records: comparable.sourceFingerprintBefore.records.map((record, index) => (
          index === 1 ? { ...record, byteOffset: 19 } : record
        )),
      },
    }),
    /record boundary/,
  );
  assert.throws(
    () => compareShadowRead({
      ...comparable,
      sourceRecords: [
        { ...sourceRecords[0]!, sourceRecordDigest: "9".repeat(64) },
        sourceRecords[1]!,
      ],
    }),
    /does not match the source fingerprint/,
  );
});

async function observeCanonicalSearch(t: test.TestContext) {
  const fixture = await createMessagingFixture();
  t.after(fixture.close);
  fixture.database.raw.exec(CANONICAL_SEARCH_SCHEMA_DELTA_SQL);
  const channels = createChannelService({
    repository: fixture.repository,
    participantDirectory: fixture.directory,
    cursorSigningKey: Buffer.alloc(32, 0x23),
    now: () => fixture.clock.value,
  });
  const messages = createMessageService({
    repository: fixture.repository,
    participantDirectory: fixture.directory,
    now: () => fixture.clock.value,
  });
  const direct = await channels.createDirectConversation({
    context: ownerContext(801),
    memberBotIds: [fixture.bots.jerry.id],
    pinned: false,
    idempotencyKey: "m17-shadow-search-channel-000801",
  });
  async function send(suffix: number, text: string) {
    return messages.sendMessage({
      context: ownerContext(suffix),
      channelId: direct.channel.id,
      messageId: fixtureId("message", suffix),
      authorPrincipalId: OWNER_ID,
      idempotencyKey: `m17-shadow-search-message-${suffix}`,
      kind: "text",
      text,
      mentions: [],
      clientMessageId: null,
      replyToMessageId: null,
      tombstonesMessageId: null,
      provenance: { roundId: null, workId: null },
    });
  }
  const canary = await send(802, "M17 cobalt canary crosses the canonical search route.");
  await send(803, "The bluebird source receipt is visible through M09.");
  const service = createCanonicalSearchService({
    repository: new SqliteCanonicalSearchRepository(fixture.database),
    participantDirectory: fixture.directory,
    cursorSigningKey: Buffer.alloc(32, 0x42),
    resolveCanary: () => ({
      id: "m17-import-search-canary",
      messageId: canary.message.id,
      channelId: direct.channel.id,
      query: "cobalt canary",
    }),
    now: () => new Date("2026-08-25T12:10:00.000Z"),
  });
  return service.search({
    context: ownerContext(804, ["product:read"]),
    query: "bluebird source receipt",
    scope: { kind: "all" },
    cursor: null,
    limit: 10,
  });
}

test("search shadow receipts bind an actual same-path M09 response", async (t) => {
  assert.throws(
    () => compareShadowRead({ ...comparable, capability: "search" }),
    /same-path canary/,
  );

  const searchResponse = await observeCanonicalSearch(t);
  const queryDigest = createHash("sha256")
    .update(searchResponse.query, "utf8")
    .digest("hex");
  const samePathCanary = {
    operationId: "search",
    route: "/api/v1/search",
    queryDigest,
    passed: true,
  } as const;
  assert.throws(
    () => compareShadowRead({
      ...comparable,
      capability: "search",
      samePathCanary,
    }),
    /search response evidence/,
  );

  const receipt = compareShadowRead({
    ...comparable,
    capability: "search",
    canonicalWatermark: {
      ...comparable.canonicalWatermark,
      eventSequence: searchResponse.completeness.sourceEventSequence,
    },
    samePathCanary,
    searchResponse,
  });
  assert.equal(receipt.samePathCanary?.passed, true);
  assert.deepEqual(receipt.searchVisibility, searchResponse.completeness);
  assert.deepEqual(receipt.searchObservation, {
    requestId: searchResponse.requestId,
    correlationId: searchResponse.correlationId,
    queryDigest,
    scope: "all",
    throughEventSequence: searchResponse.throughEventSequence,
  });
  assert.equal(JSON.stringify(receipt).includes(searchResponse.query), false);
  assert.equal(JSON.stringify(receipt).includes(searchResponse.results[0]!.excerpt), false);

  const blind = compareShadowRead({
    ...comparable,
    capability: "search",
    canonicalWatermark: {
      ...comparable.canonicalWatermark,
      eventSequence: searchResponse.completeness.sourceEventSequence,
    },
    samePathCanary,
    searchResponse: {
      ...searchResponse,
      completeness: {
        ...searchResponse.completeness,
        status: "partial",
        indexedThroughEventSequence:
          searchResponse.completeness.indexedThroughEventSequence - 1,
        verdict: "route_blind",
        reason: "Index watermark is behind canonical Messages.",
      },
    },
  });
  assert.equal(blind.verdict, "blocked");
  assert.equal(
    blind.mismatches.some((mismatch) => mismatch.classification === "search_route_blind"),
    true,
  );

  assert.throws(
    () => compareShadowRead({
      ...comparable,
      capability: "search",
      searchResponse,
      samePathCanary: {
        operationId: "search",
        route: "/invented",
        queryDigest,
        passed: true,
      },
    }),
    /registered same-path route/,
  );
});
