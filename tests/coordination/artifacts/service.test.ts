import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
  ArtifactError, createDurableAttachmentService, LocalArtifactStore, SqliteArtifactRepository,
} from "../../../src/coordination/artifacts/index.js";
import { openCoordinationDatabase } from "../../../src/coordination/db/index.js";
import { ownerContext } from "../messaging/test-fixture.js";

const artifactId = "art_0198d95f-6c00-7000-8000-000000001111";
const bytes = Buffer.from("durable attachment\n");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const boundary = "home23-test-boundary";

function body(name = "evidence.txt", content = bytes): Readable {
  const metadata = JSON.stringify({ artifactId, name, declaredContentType: "text/plain", expectedSha256: sha256 });
  return Readable.from([Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${metadata}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="content"; filename="${name}"\r\n` +
    `Content-Type: text/plain\r\n\r\n`, "utf8"), content, Buffer.from(`\r\n--${boundary}--\r\n`)]);
}

test("durable service exactly replays create across restart and rejects changed reuse", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "home23-attachment-service-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const databasePath = join(root, "coordination.sqlite3");
  const storePath = join(root, "artifacts");
  const directory = { resolveAlias: async () => null, getBotByResidentBinding: async () => null };
  const open = async () => {
    const database = openCoordinationDatabase({ path: databasePath });
    if (!database.readOne("SELECT 1 FROM principals WHERE id = 'user_owner'")) {
      database.mutateWithEvent((transaction) => {
        transaction.run("INSERT INTO principals (id, kind, created_at) VALUES ('user_owner', 'owner', ?)", "2026-08-25T16:00:00.000Z");
        return { value: undefined, event: { type: "principal.created", aggregateKind: "principal", aggregateId: "user_owner", aggregateVersion: 1, channelId: null, actorPrincipalId: "user_owner", requestId: "req_0198d95f-6c00-7000-8000-000000001110", correlationId: "cor_0198d95f-6c00-7000-8000-000000001110", payload: { principalId: "user_owner" }, createdAt: "2026-08-25T16:00:00.000Z" } };
      });
    }
    const repository = new SqliteArtifactRepository(database);
    const store = await LocalArtifactStore.open({ rootDirectory: storePath, repository });
    return { database, service: createDurableAttachmentService({ database, repository, store, participantDirectory: directory }) };
  };
  const firstRuntime = await open();
  const context = ownerContext(1111, ["attachment:write", "product:read"]);
  const first = await firstRuntime.service.create({ context, idempotencyKey: "attachment-key-1111", contentType: `multipart/form-data; boundary=${boundary}`, contentLength: null, body: body() });
  firstRuntime.database.close();

  const secondRuntime = await open();
  t.after(() => secondRuntime.database.close());
  const replay = await secondRuntime.service.create({ context, idempotencyKey: "attachment-key-1111", contentType: `multipart/form-data; boundary=${boundary}`, contentLength: null, body: body() });
  assert.deepEqual(replay, first);
  assert.deepEqual(await secondRuntime.service.getMetadata({ context, artifactId }), first);
  const download = await secondRuntime.service.openDownload({ context, artifactId, rangeHeader: "bytes=0-6" });
  const chunks: Buffer[] = [];
  for await (const chunk of download.content) chunks.push(Buffer.from(chunk));
  assert.deepEqual(Buffer.concat(chunks), bytes.subarray(0, 7));
  await assert.rejects(
    secondRuntime.service.create({ context, idempotencyKey: "attachment-key-1111", contentType: `multipart/form-data; boundary=${boundary}`, contentLength: null, body: body("changed.txt") }),
    (error: unknown) => error instanceof ArtifactError && error.code === "storage_conflict",
  );
  assert.equal(secondRuntime.database.readOne<{ count: number }>("SELECT count(*) AS count FROM artifacts")?.count, 1);
  assert.equal(secondRuntime.database.readOne<{ count: number }>("SELECT count(*) AS count FROM attachment_create_idempotency")?.count, 1);
});

test("service fails closed for incomplete dependencies and oversized declared requests", async () => {
  assert.throws(() => createDurableAttachmentService({} as never), /complete dependencies/u);
});
