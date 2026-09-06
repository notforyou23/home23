import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ToolContext } from "../../../src/agent/types.js";
import {
  canonicalReturnedArtifactDirectory,
  returnArtifactTool,
} from "../../../src/agent/tools/return-artifact.js";
import {
  ArtifactError,
  createResidentArtifactPromotionPort,
  LocalArtifactStore,
  resolveArtifactActor,
  SqliteArtifactRepository,
} from "../../../src/coordination/artifacts/index.js";
import {
  SqliteBotConversationBindingAdapter,
  SqliteMessagingRepository,
} from "../../../src/coordination/channels/index.js";
import { createMessageService } from "../../../src/coordination/messages/index.js";
import { createWorkService } from "../../../src/coordination/work/index.js";
import { ARTIFACT_AUDIO_MPEG_MIGRATION_SQL } from "../../../src/coordination/migrations/0011-artifact-audio-mpeg.js";
import type { ResidentLeaseBinding } from "../../../src/coordination-adapter/index.js";
import {
  AT,
  BOT_ID,
  CHANNEL_ID,
  MESSAGE_ID,
  M11TestDatabase,
  OWNER_ID,
  createFixtureIdGenerator,
  fixtureId,
  manifestInput,
} from "../work/test-fixture.js";

const CONVERSATION_ID = "cnv_0198d95f-6c00-7000-8000-000000000a01";

test("resident artifacts are private, exact, replay-stable, and linked to a canonical Message", async (t) => {
  const migrationDatabase = M11TestDatabase.temporaryBeforeArtifactAudioMigration();
  t.after(() => migrationDatabase.close());
  const legacyArtifactId = "art_legacy_returned_image";
  const legacyMessageId = fixtureId("message", 490);
  const legacySha256 = createHash("sha256").update("legacy-image", "utf8").digest("hex");
  migrationDatabase.raw.prepare(
    `INSERT INTO messages (
      id, channel_id, channel_sequence, author_principal_id, author_kind,
      author_display_name, kind, body_text, stored_visibility,
      client_message_id, reply_to_message_id, tombstones_message_id,
      round_id, work_id, created_at
    ) VALUES (?, ?, 2, ?, 'bot', 'Jerry', 'result', NULL, 'visible',
              NULL, ?, NULL, NULL, NULL, ?)`,
  ).run(legacyMessageId, CHANNEL_ID, BOT_ID, MESSAGE_ID, AT);
  migrationDatabase.raw.prepare(
    `INSERT INTO artifacts (
      id, owner_principal_id, state, original_name, declared_content_type,
      detected_content_type, byte_count, sha256, storage_kind, created_at,
      expires_at, failed_at, deleted_at, version
    ) VALUES (?, ?, 'ready', 'legacy.png', 'image/png', 'image/png', 12, ?,
              'content_addressed', ?, NULL, NULL, NULL, 2)`,
  ).run(legacyArtifactId, BOT_ID, legacySha256, AT);
  migrationDatabase.raw.prepare(
    `INSERT INTO attachment_create_idempotency (
      principal_id, key_digest, request_digest, artifact_id, created_at
    ) VALUES (?, ?, ?, ?, ?)`,
  ).run(BOT_ID, "a".repeat(64), "b".repeat(64), legacyArtifactId, AT);
  migrationDatabase.raw.prepare(
    `INSERT INTO message_artifacts (message_id, channel_id, artifact_id, ordinal, linked_at)
     VALUES (?, ?, ?, 0, ?)`,
  ).run(legacyMessageId, CHANNEL_ID, legacyArtifactId, AT);
  migrationDatabase.raw.prepare(
    `INSERT INTO events (
      id, schema_version, type, durability, aggregate_kind, aggregate_id,
      aggregate_version, channel_id, actor_principal_id, request_id,
      correlation_id, payload_json, payload_digest, created_at
    ) VALUES (?, 1, 'message.appended', 'durable', 'message', ?, 1, ?, ?, ?, ?, '{}', ?, ?)`,
  ).run(
    fixtureId("event", 490), legacyMessageId, CHANNEL_ID, BOT_ID,
    fixtureId("request", 490), fixtureId("correlation", 490),
    createHash("sha256").update("{}", "utf8").digest("hex"), AT,
  );
  const legacyRows = {
    artifact: migrationDatabase.readAll("SELECT * FROM artifacts WHERE id = ?", legacyArtifactId),
    link: migrationDatabase.readAll("SELECT * FROM message_artifacts WHERE artifact_id = ?", legacyArtifactId),
    receipt: migrationDatabase.readAll(
      "SELECT * FROM attachment_create_idempotency WHERE artifact_id = ?",
      legacyArtifactId,
    ),
  };
  migrationDatabase.raw.transaction(() =>
    migrationDatabase.raw.exec(ARTIFACT_AUDIO_MPEG_MIGRATION_SQL)
  )();
  assert.deepEqual(
    migrationDatabase.readAll("SELECT * FROM artifacts WHERE id = ?", legacyArtifactId),
    legacyRows.artifact,
  );
  assert.deepEqual(
    migrationDatabase.readAll("SELECT * FROM message_artifacts WHERE artifact_id = ?", legacyArtifactId),
    legacyRows.link,
  );
  assert.deepEqual(
    migrationDatabase.readAll("SELECT * FROM attachment_create_idempotency WHERE artifact_id = ?", legacyArtifactId),
    legacyRows.receipt,
  );
  assert.deepEqual(migrationDatabase.readAll("PRAGMA foreign_key_check"), []);

  const root = await mkdtemp(join(tmpdir(), "home23-resident-artifact-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const output = canonicalReturnedArtifactDirectory(workspace);
  const bytes = Buffer.alloc(834);
  Buffer.from([0xff, 0xfb, 0x90, 0x64]).copy(bytes, 0);
  Buffer.from([0xff, 0xfb, 0x90, 0x64]).copy(bytes, 417);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const sourcePath = join(output, "answer.mp3");
  await writeFile(sourcePath, bytes, { mode: 0o600 });
  const toolContext = { workspacePath: workspace } as ToolContext;

  const returned = await returnArtifactTool.execute(
    { path: "media/returned-artifacts/answer.mp3" },
    toolContext,
  );
  assert.equal(returned.is_error, undefined);
  assert.equal(returned.media?.length, 1);
  assert.deepEqual(returned.media?.[0], {
    type: "document",
    path: sourcePath,
    generatedBy: "return_artifact",
    mimeType: "audio/mpeg",
    fileName: "answer.mp3",
    byteCount: bytes.length,
    sha256,
  });
  assert.match(returned.content, new RegExp(sha256));
  assert.equal(returned.content.includes(root), false, "tool output must not expose local paths");

  const outsidePath = join(root, "outside.mp3");
  await writeFile(outsidePath, bytes, { mode: 0o600 });
  assert.equal((await returnArtifactTool.execute({ path: outsidePath }, toolContext)).is_error, true);
  const malformedPath = join(output, "malformed.mp3");
  await writeFile(malformedPath, Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(124)]));
  assert.equal((await returnArtifactTool.execute({ path: malformedPath }, toolContext)).is_error, true);
  const symlinkPath = join(output, "linked.mp3");
  await symlink(sourcePath, symlinkPath);
  assert.equal((await returnArtifactTool.execute({ path: symlinkPath }, toolContext)).is_error, true);

  const database = M11TestDatabase.temporary();
  t.after(() => database.close());
  database.raw.prepare("INSERT INTO conversation_handles (id, channel_id, created_at) VALUES (?, ?, ?)")
    .run(CONVERSATION_ID, CHANNEL_ID, AT);
  database.raw.prepare(
    `UPDATE bots SET conversation_id = ?, required_capabilities_json = ?,
                     resident_capabilities_json = ? WHERE id = ?`,
  ).run(CONVERSATION_ID, '["attachments","messages"]', '["attachments","messages"]', BOT_ID);

  const bot = Object.freeze({
    id: BOT_ID, principalId: BOT_ID, name: "Jerry", purpose: "Persistent resident",
    lifecycle: "active" as const, conversationId: CONVERSATION_ID, residentBinding: "jerry",
    continuingIdentity: true, durableMailbox: true,
    requiredCapabilities: Object.freeze(["attachments", "messages"]),
    activeInstanceId: "resident-1", activeKeyVersion: 1, residentProtocolVersion: 1,
    residentCapabilities: Object.freeze(["attachments", "messages"]), residentRegisteredAt: AT,
    lastHeartbeatAt: AT, reportedAvailability: "available" as const,
    availability: "available" as const, version: 1, createdAt: AT, updatedAt: AT,
  });
  const directory = {
    listVisibleBots: async () => [bot],
    resolveAlias: async (namespace: string, value: string) =>
      namespace === "resident" && value === "jerry" ? bot : null,
    getBotByResidentBinding: async (value: string) => value === "jerry" ? bot : null,
  };
  const residentContext = (suffix: number) => {
    const requestId = fixtureId("request", suffix);
    const correlationId = fixtureId("correlation", suffix);
    return {
      principalId: BOT_ID,
      requestId,
      correlationId,
      identity: { kind: "resident" as const, resident: {
        requestId,
        correlationId,
        credential: {
          residentSlug: "jerry", role: "resident" as const,
          instanceId: "resident-1", keyVersion: 1,
        },
      } },
    };
  };
  const generateId = createFixtureIdGenerator(41_000);
  const workService = createWorkService({ database, generateId, now: () => new Date(AT) });
  const createWork = (suffix: number) => workService.create({
    principalId: OWNER_ID,
    targetPrincipalId: BOT_ID,
    channelId: CHANNEL_ID,
    originMessageId: MESSAGE_ID,
    roundId: null,
    kind: "resident_turn",
    idempotencyKey: `returned-artifact-${suffix}`,
    manifest: manifestInput(),
    maxAutomaticOffers: 1,
    requestId: fixtureId("request", suffix),
    correlationId: fixtureId("correlation", suffix),
  }).work;
  const work = createWork(501);
  const binding = (workId: string, suffix: number): ResidentLeaseBinding => ({
    workId,
    attemptId: fixtureId("attempt", suffix),
    leaseId: fixtureId("lease", suffix),
    holderPrincipalId: BOT_ID,
    holderInstanceId: "resident-1",
    authorityReference: "resident:jerry",
    fencingToken: 1,
    requestId: fixtureId("request", suffix),
    correlationId: fixtureId("correlation", suffix),
  });
  const artifactRepository = new SqliteArtifactRepository(database);
  const store = await LocalArtifactStore.open({
    rootDirectory: join(root, "artifact-store"),
    repository: artifactRepository,
    now: () => new Date(AT),
    quarantineId: () => "returned-artifact-ingest",
  });
  const promotion = createResidentArtifactPromotionPort({
    database,
    store: () => store,
    participantDirectory: directory,
    context: () => residentContext(502),
  });
  const descriptor = returned.media![0]!;
  const first = await promotion.promote({ binding: binding(work.id, 503), media: [descriptor] });
  const replay = await promotion.promote({ binding: binding(work.id, 504), media: [descriptor] });
  assert.deepEqual(replay, first);
  assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM artifacts")?.count, 1);
  const actor = await resolveArtifactActor(residentContext(505), directory);
  const download = await store.openDownload({ artifactId: first[0]!, actor });
  const chunks: Buffer[] = [];
  for await (const chunk of download.content) chunks.push(Buffer.from(chunk));
  assert.deepEqual(Buffer.concat(chunks), bytes);

  const mismatchWork = createWork(506);
  await assert.rejects(
    promotion.promote({
      binding: binding(mismatchWork.id, 507),
      media: [{ ...descriptor, type: "document", mimeType: "application/pdf" }],
    }),
    (error: unknown) => error instanceof ArtifactError && error.code === "invalid_content_type",
  );
  const linkedWork = createWork(508);
  await assert.rejects(promotion.promote({
    binding: binding(linkedWork.id, 509),
    media: [{ ...descriptor, path: symlinkPath, fileName: "linked.mp3" }],
  }));

  const messages = createMessageService({
    repository: new SqliteMessagingRepository(database, {
      botConversationBinding: new SqliteBotConversationBindingAdapter(),
      messageProvenanceAuthorization: { assertAuthorized: () => undefined },
      artifactMessageLink: artifactRepository,
    }),
    participantDirectory: directory,
    resolveAttachmentActor: (context) => resolveArtifactActor(context, directory),
    now: () => new Date(AT),
  });
  const sent = await messages.sendMessage({
    context: residentContext(510),
    channelId: CHANNEL_ID,
    messageId: fixtureId("message", 510),
    authorPrincipalId: BOT_ID,
    idempotencyKey: "returned-artifact-terminal-message",
    kind: "result",
    text: null,
    mentions: [],
    attachmentIds: first,
    clientMessageId: null,
    replyToMessageId: MESSAGE_ID,
    tombstonesMessageId: null,
    provenance: { roundId: null, workId: work.id },
  });
  assert.deepEqual(sent.message.attachments.map((attachment) => attachment.id), first);
  assert.equal(JSON.stringify(sent.message).includes(root), false, "Message summaries must not expose paths");
  assert.equal(database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM message_artifacts WHERE message_id = ? AND artifact_id = ?",
    sent.message.id,
    first[0]!,
  )?.count, 1);
  assert.deepEqual(database.readAll("PRAGMA foreign_key_check"), []);
  assert.equal(database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM message_artifacts WHERE message_id = ? AND artifact_id = ?",
    sent.message.id,
    first[0]!,
  )?.count, 1);
  assert.equal(database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM attachment_create_idempotency WHERE artifact_id = ?",
    first[0]!,
  )?.count, 1);
});
