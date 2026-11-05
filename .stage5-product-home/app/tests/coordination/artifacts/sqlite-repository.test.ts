import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
  createChannelService,
  resolveMessagingActor,
} from "../../../src/coordination/channels/index.js";
import {
  OWNER_ID,
  createMessagingFixture,
  fixtureId,
  ownerContext,
  residentContext,
} from "../messaging/test-fixture.js";

test("the M08 transaction port atomically commits or rolls back Message, links, and Message event", async (t) => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "home23-m10-sqlite-auth-"));
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));
  const fixture = await createMessagingFixture();
  t.after(fixture.close);
  const artifacts = await import("../../../src/coordination/artifacts/index.js").catch(
    (error: unknown) => assert.fail(`M10 SQLite repository is unavailable: ${String(error)}`),
  );
  fixture.database.raw.exec(artifacts.ARTIFACT_SCHEMA_DELTA_SQL);
  const repository = new artifacts.SqliteArtifactRepository(fixture.database);
  const store = await artifacts.LocalArtifactStore.open({
    rootDirectory,
    repository,
    now: () => fixture.clock.value,
    quarantineId: () => "quarantine-sqlite-auth",
  });
  const channels = createChannelService({
    repository: fixture.repository,
    participantDirectory: fixture.directory,
    cursorSigningKey: Buffer.alloc(32, 0x23),
    now: () => fixture.clock.value,
  });
  const direct = await channels.createDirectConversation({
    context: ownerContext(871),
    memberBotIds: [fixture.bots.jerry.id],
    pinned: false,
    idempotencyKey: "m10-direct-000871",
  });
  const messageId = fixtureId("message", 872);
  const messageIdempotencyDigest = "8".repeat(64);
  const messageOnlyResident = await resolveMessagingActor(
    residentContext(fixture.bots.jerry, "jerry", 869),
    fixture.directory,
    "product:read",
  );
  assert.deepEqual(repository.linkReadyArtifacts(null as never, {
    messageId,
    channelId: direct.channel.id,
    artifactIds: [],
    actor: messageOnlyResident,
    linkedAt: fixture.clock.value.toISOString(),
  }), []);
  const readOnlyOwner = await resolveMessagingActor(
    ownerContext(870, ["product:read"]),
    fixture.directory,
    "product:read",
  );
  await assert.rejects(
    store.ingest({
      artifactId: "art_0198d95f-6c00-7000-8000-000000000870",
      actor: readOnlyOwner,
      originalName: "denied.txt",
      declaredContentType: "text/plain",
      expectedSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      content: Readable.from([]),
    }),
    (error: unknown) =>
      error instanceof artifacts.ArtifactError && error.code === "scope_denied",
  );
  const owner = await artifacts.resolveArtifactActor(
    ownerContext(873, ["attachment:write"]),
    fixture.directory,
  );
  const uploaded = await store.ingest({
    artifactId: "art_0198d95f-6c00-7000-8000-000000000873",
    actor: owner,
    originalName: "evidence.txt",
    declaredContentType: "text/plain",
    expectedSha256: "b2a7d72c4486981563921cca03d7c72756f0c4d1bff2f07d2773dee696260fda",
    content: Readable.from([Buffer.from("M10 exact bytes\n")]),
  });

  const uploadEvents = fixture.database.readAll<{ payload: string; sequence: number }>(
    `SELECT payload_json AS payload, sequence FROM events
     WHERE type = 'attachment.updated' AND aggregate_id = ? ORDER BY sequence`,
    uploaded.id,
  );
  assert.deepEqual(uploadEvents.map((row) => JSON.parse(row.payload).state), ["staging", "ready"]);
  assert.equal(uploaded.throughEventSequence, uploadEvents.at(-1)?.sequence);
  assert.equal(uploadEvents.some((row) =>
    row.payload.includes(rootDirectory) || row.payload.includes("evidence.txt")
  ), false);

  const appendThroughHandoff = () => fixture.database.mutateWithEvent((transaction) => {
    const channel = transaction.readOne<{ nextSequence: number; version: number; conversationId: string }>(
      `SELECT channel.next_message_sequence AS nextSequence, channel.version,
              handle.id AS conversationId
       FROM channels channel
       JOIN conversation_handles handle ON handle.channel_id = channel.id
       WHERE channel.id = ?`,
      direct.channel.id,
    );
    assert.ok(channel);
    transaction.run(
      `UPDATE channels SET next_message_sequence = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND next_message_sequence = ?`,
      channel.nextSequence + 1,
      fixture.clock.value.toISOString(),
      direct.channel.id,
      channel.nextSequence,
    );
    transaction.run(
      `INSERT INTO messages (
        id, channel_id, channel_sequence, author_principal_id, author_kind,
        author_display_name, kind, body_text, stored_visibility, client_message_id,
        reply_to_message_id, tombstones_message_id, round_id, work_id, created_at
      ) VALUES (?, ?, ?, ?, 'owner', 'Owner', 'text', ?, 'visible', ?,
                NULL, NULL, NULL, NULL, ?)`,
      messageId,
      direct.channel.id,
      channel.nextSequence,
      OWNER_ID,
      "The attachment belongs to this immutable Message.",
      "m10-client-message-872",
      fixture.clock.value.toISOString(),
    );
    const summaries = repository.linkReadyArtifacts(transaction, {
      messageId,
      channelId: direct.channel.id,
      artifactIds: [uploaded.id],
      actor: owner,
      linkedAt: fixture.clock.value.toISOString(),
    });
    transaction.run(
      `INSERT INTO idempotency_records (
        principal_id, operation, idempotency_key_digest, request_digest,
        result_kind, result_ref_json, request_id, correlation_id, created_at
      ) VALUES (?, 'message.append', ?, ?, 'message', ?, ?, ?, ?)`,
      owner.principalId,
      messageIdempotencyDigest,
      "9".repeat(64),
      JSON.stringify({
        messageId,
        eventReference: {
          aggregateKind: "message",
          aggregateId: messageId,
          aggregateVersion: 1,
        },
      }),
      owner.requestId,
      owner.correlationId,
      fixture.clock.value.toISOString(),
    );
    return {
      value: summaries,
      event: {
        type: "message.appended",
        aggregateKind: "message",
        aggregateId: messageId,
        aggregateVersion: 1,
        channelId: direct.channel.id,
        actorPrincipalId: owner.principalId,
        requestId: owner.requestId,
        correlationId: owner.correlationId,
        payload: {
          messageId,
          channelId: direct.channel.id,
          conversationId: channel.conversationId,
          channelSequence: channel.nextSequence,
          channelVersion: channel.version + 1,
          messageVersion: 1,
          authorPrincipalId: owner.principalId,
          mentions: [],
          replyToMessageId: null,
          tombstonesMessageId: null,
          roundId: null,
          workId: null,
        },
        createdAt: fixture.clock.value.toISOString(),
      },
    };
  });
  fixture.database.raw.exec(`
    CREATE TEMP TRIGGER m10_inject_link_failure
    BEFORE INSERT ON message_artifacts
    BEGIN
      SELECT RAISE(ABORT, 'injected Message link failure');
    END;
  `);
  assert.throws(appendThroughHandoff, /injected Message link failure/);
  assert.equal(fixture.database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM messages WHERE id = ?",
    messageId,
  )?.count, 0);
  assert.equal(fixture.database.readOne<{ count: number }>(
    `SELECT count(*) AS count FROM idempotency_records
     WHERE operation = 'message.append' AND idempotency_key_digest = ?`,
    messageIdempotencyDigest,
  )?.count, 0);
  assert.equal(fixture.database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM message_artifacts WHERE artifact_id = ?",
    uploaded.id,
  )?.count, 0);
  assert.equal(await repository.countReadyReferencesByDigest(uploaded.sha256), 1);
  fixture.database.raw.exec("DROP TRIGGER m10_inject_link_failure");

  fixture.database.raw.exec(`
    CREATE TEMP TRIGGER m10_inject_message_event_failure
    BEFORE INSERT ON events
    WHEN NEW.type = 'message.appended' AND NEW.aggregate_id = '${messageId}'
    BEGIN
      SELECT RAISE(ABORT, 'injected Message event failure');
    END;
  `);
  assert.throws(appendThroughHandoff, /injected Message event failure/);
  assert.equal(fixture.database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM messages WHERE id = ?",
    messageId,
  )?.count, 0);
  assert.equal(fixture.database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM message_artifacts WHERE artifact_id = ?",
    uploaded.id,
  )?.count, 0);
  assert.equal(fixture.database.readOne<{ count: number }>(
    `SELECT count(*) AS count FROM idempotency_records
     WHERE operation = 'message.append' AND idempotency_key_digest = ?`,
    messageIdempotencyDigest,
  )?.count, 0);
  assert.equal(fixture.database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM events WHERE type = 'message.appended' AND aggregate_id = ?",
    messageId,
  )?.count, 0);
  fixture.database.raw.exec("DROP TRIGGER m10_inject_message_event_failure");

  const appended = appendThroughHandoff();
  assert.deepEqual(appended.value, [{
    id: uploaded.id,
    name: "evidence.txt",
    contentType: "text/plain",
    byteCount: 16,
    sha256: uploaded.sha256,
  }]);
  assert.equal(
    fixture.database.readOne<{ version: number }>(
      "SELECT version FROM artifacts WHERE id = ?",
      uploaded.id,
    )?.version,
    2,
  );
  assert.equal(fixture.database.readOne<{ count: number }>(
    `SELECT count(*) AS count FROM idempotency_records
     WHERE operation = 'message.append' AND idempotency_key_digest = ?`,
    messageIdempotencyDigest,
  )?.count, 1);

  const summaries = await repository.listMessageAttachments({
    messageId,
    actor: owner,
  });
  assert.deepEqual(summaries, [{
    id: uploaded.id,
    name: "evidence.txt",
    contentType: "text/plain",
    byteCount: 16,
    sha256: "b2a7d72c4486981563921cca03d7c72756f0c4d1bff2f07d2773dee696260fda",
  }]);

  fixture.database.raw.prepare(
    `UPDATE bots
     SET required_capabilities_json = ?, resident_capabilities_json = ?
     WHERE id IN (?, ?)`,
  ).run(
    JSON.stringify(["attachments", "messages"]),
    JSON.stringify(["attachments", "messages"]),
    fixture.bots.jerry.id,
    fixture.bots.records.id,
  );
  const jerry = await artifacts.resolveArtifactReader(
    residentContext(fixture.bots.jerry, "jerry", 874),
    fixture.directory,
  );
  const authorized = await store.openDownload({ artifactId: uploaded.id, actor: jerry });
  for await (const _chunk of authorized.content) {
    // Drain the authorized stream so its verified descriptor closes.
  }

  const records = await artifacts.resolveArtifactReader(
    residentContext(fixture.bots.records, "records-specialist", 875),
    fixture.directory,
  );
  const denied = await store.openDownload({
    artifactId: uploaded.id,
    actor: records,
  }).then(
    () => null,
    (error: unknown) => error,
  );
  const missing = await store.openDownload({
    artifactId: "art_0198d95f-6c00-7000-8000-000000000899",
    actor: records,
  }).then(
    () => null,
    (error: unknown) => error,
  );
  assert.ok(denied instanceof artifacts.ArtifactError);
  assert.ok(missing instanceof artifacts.ArtifactError);
  assert.deepEqual(
    { code: denied.code, status: denied.httpStatus, message: denied.message },
    { code: missing.code, status: missing.httpStatus, message: missing.message },
  );
  assert.deepEqual(
    { code: denied.code, status: denied.httpStatus, message: denied.message },
    { code: "not_found", status: 404, message: "not_found" },
  );
  assert.equal(JSON.stringify(denied).includes(rootDirectory), false);
});

test("a ready metadata event failure rolls back SQLite and removes the newly published canonical object", async (t) => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "home23-m10-db-failure-"));
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));
  const fixture = await createMessagingFixture();
  t.after(fixture.close);
  const artifacts = await import("../../../src/coordination/artifacts/index.js");
  fixture.database.raw.exec(artifacts.ARTIFACT_SCHEMA_DELTA_SQL);
  fixture.database.raw.exec(`
    CREATE TEMP TRIGGER m10_inject_ready_event_failure
    BEFORE INSERT ON events
    WHEN NEW.type = 'attachment.updated'
      AND json_extract(NEW.payload_json, '$.state') = 'ready'
    BEGIN
      SELECT RAISE(ABORT, 'injected ready event failure');
    END;
  `);
  const repository = new artifacts.SqliteArtifactRepository(fixture.database);
  const store = await artifacts.LocalArtifactStore.open({
    rootDirectory,
    repository,
    now: () => fixture.clock.value,
    quarantineId: () => "quarantine-db-failure",
  });
  const owner = await artifacts.resolveArtifactActor(
    ownerContext(881, ["attachment:write"]),
    fixture.directory,
  );
  const sha256 = "b2a7d72c4486981563921cca03d7c72756f0c4d1bff2f07d2773dee696260fda";

  await assert.rejects(
    store.ingest({
      artifactId: "art_0198d95f-6c00-7000-8000-000000000881",
      actor: owner,
      originalName: "rollback.txt",
      declaredContentType: "text/plain",
      expectedSha256: sha256,
      content: Readable.from([Buffer.from("M10 exact bytes\n")]),
    }),
    (error: unknown) =>
      error instanceof artifacts.ArtifactError && error.code === "storage_conflict",
  );

  assert.deepEqual(
    fixture.database.readOne<{ state: string; sha256: string | null }>(
      "SELECT state, sha256 FROM artifacts WHERE id = ?",
      "art_0198d95f-6c00-7000-8000-000000000881",
    ),
    { state: "failed", sha256: null },
  );
  assert.equal(
    fixture.database.readOne<{ count: number }>(
      "SELECT count(*) AS count FROM events WHERE type = 'attachment.updated' AND json_extract(payload_json, '$.state') = 'ready'",
    )?.count,
    0,
  );
  assert.deepEqual(await readdir(join(rootDirectory, "quarantine")), []);
  const objectEntries = await readdir(join(rootDirectory, "objects"), { recursive: true });
  assert.equal(objectEntries.some((entry) => entry.endsWith(sha256)), false);
  assert.deepEqual(await repository.listActiveDigests(), []);
});

test("due unlinked drafts deny reads, transition once with an event, and become GC candidates", async (t) => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "home23-m10-sqlite-expiry-"));
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));
  const fixture = await createMessagingFixture();
  t.after(fixture.close);
  const artifacts = await import("../../../src/coordination/artifacts/index.js");
  fixture.database.raw.exec(artifacts.ARTIFACT_SCHEMA_DELTA_SQL);
  const repository = new artifacts.SqliteArtifactRepository(fixture.database);
  const store = await artifacts.LocalArtifactStore.open({
    rootDirectory,
    repository,
    now: () => fixture.clock.value,
    quarantineId: () => "quarantine-sqlite-expiry",
  });
  const owner = await artifacts.resolveArtifactActor(
    ownerContext(895, ["attachment:write"]),
    fixture.directory,
  );
  const artifactId = "art_0198d95f-6c00-7000-8000-000000000895";
  const sha256 = "b2a7d72c4486981563921cca03d7c72756f0c4d1bff2f07d2773dee696260fda";
  await store.ingest({
    artifactId,
    actor: owner,
    originalName: "retention.txt",
    declaredContentType: "text/plain",
    expectedSha256: sha256,
    content: Readable.from([Buffer.from("M10 exact bytes\n")]),
  });

  fixture.clock.value = new Date("2026-08-26T12:00:00.000Z");
  await assert.rejects(
    store.openDownload({ artifactId, actor: owner }),
    (error: unknown) =>
      error instanceof artifacts.ArtifactError && error.code === "not_found",
  );
  const expiration = await store.expireDueDrafts({ actor: owner, limit: 10 });
  assert.deepEqual(expiration.expiredArtifactIds, [artifactId]);
  assert.equal(
    fixture.database.readOne<{ state: string }>(
      "SELECT state FROM artifacts WHERE id = ?",
      artifactId,
    )?.state,
    "expired",
  );
  const states = fixture.database.readAll<{ state: string }>(
    `SELECT json_extract(payload_json, '$.state') AS state FROM events
     WHERE type = 'attachment.updated' AND aggregate_id = ? ORDER BY sequence`,
    artifactId,
  ).map((row) => row.state);
  assert.deepEqual(states, ["staging", "ready", "expired"]);
  assert.deepEqual((await store.collectGarbage({ dryRun: true })).candidates, [{
    kind: "canonical_orphan",
    digest: sha256,
    byteCount: 16,
    action: "would_quarantine",
  }]);
});

test("operator recovery dry-runs then terminalizes crash-left staging rows while GC inventories quarantine", async (t) => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "home23-m10-sqlite-recovery-"));
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));
  const fixture = await createMessagingFixture();
  t.after(fixture.close);
  const artifacts = await import("../../../src/coordination/artifacts/index.js");
  fixture.database.raw.exec(artifacts.ARTIFACT_SCHEMA_DELTA_SQL);
  const repository = new artifacts.SqliteArtifactRepository(fixture.database);
  const store = await artifacts.LocalArtifactStore.open({
    rootDirectory,
    repository,
    now: () => fixture.clock.value,
    quarantineId: () => "recovery",
  });
  const owner = await artifacts.resolveArtifactActor(
    ownerContext(896, ["attachment:write"]),
    fixture.directory,
  );
  const artifactId = "art_0198d95f-6c00-7000-8000-000000000896";
  const createdAt = fixture.clock.value.toISOString();
  await repository.beginStaging({
    actor: owner,
    artifact: {
      id: artifactId,
      ownerPrincipalId: owner.principalId,
      state: "staging",
      name: "crashed.txt",
      declaredContentType: "text/plain",
      detectedContentType: null,
      byteCount: 0,
      sha256: null,
      storage: "content_addressed",
      createdAt,
      expiresAt: new Date(fixture.clock.value.getTime() + 86_400_000).toISOString(),
    },
  });
  const crashBytes = Buffer.from("private partial upload");
  const crashPath = join(rootDirectory, "quarantine", `${artifactId}.recovery.upload`);
  await writeFile(
    crashPath,
    crashBytes,
    { mode: 0o600 },
  );
  await utimes(crashPath, new Date(createdAt), new Date(createdAt));
  fixture.clock.value = new Date("2026-08-25T14:00:00.000Z");

  const dryRun = await store.recoverAbandonedUploads({
    actor: owner,
    dryRun: true,
    olderThanMs: 60 * 60 * 1000,
  });
  assert.deepEqual(dryRun.abandonedArtifactIds, [artifactId]);
  assert.equal(
    fixture.database.readOne<{ state: string }>(
      "SELECT state FROM artifacts WHERE id = ?",
      artifactId,
    )?.state,
    "staging",
  );
  const applied = await store.recoverAbandonedUploads({
    actor: owner,
    dryRun: false,
    olderThanMs: 60 * 60 * 1000,
  });
  assert.deepEqual(applied.abandonedArtifactIds, [artifactId]);
  assert.equal(
    fixture.database.readOne<{ state: string }>(
      "SELECT state FROM artifacts WHERE id = ?",
      artifactId,
    )?.state,
    "failed",
  );
  assert.deepEqual(
    fixture.database.readAll<{ state: string }>(
      `SELECT json_extract(payload_json, '$.state') AS state FROM events
       WHERE type = 'attachment.updated' AND aggregate_id = ? ORDER BY sequence`,
      artifactId,
    ).map((row) => row.state),
    ["staging", "failed"],
  );
  assert.deepEqual((await store.collectGarbage({ dryRun: true })).candidates, [{
    kind: "quarantine_orphan",
    digest: createHash("sha256").update(crashBytes).digest("hex"),
    byteCount: crashBytes.length,
    action: "would_quarantine",
  }]);
});
