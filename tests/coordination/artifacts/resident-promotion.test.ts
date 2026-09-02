import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createResidentArtifactPromotionPort,
  type ArtifactProjection,
  type ArtifactServiceDatabase,
  type LocalArtifactStore,
} from "../../../src/coordination/artifacts/index.js";
import type { ResidentLeaseBinding } from "../../../src/coordination-adapter/index.js";

const WORK_ID = "wrk_0198d95f-6c00-7000-8000-000000000a01";
const BOT_ID = "bot_0198d95f-6c00-7000-8000-000000000a02";
const CREATED_AT = "2026-08-28T12:00:00.000Z";

test("resident generate_image promotion is byte-checked, replay-stable, and discriminator-gated", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "home23-resident-promotion-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const path = join(root, "answer.png");
  await writeFile(path, bytes, { mode: 0o400 });
  let ready: (ArtifactProjection & { requestDigest: string; keyDigest: string }) | null = null;
  let ingestCount = 0;
  const database = {
    readOne<T>(sql: string, ...parameters: Array<string | number | bigint | Buffer | null>): T | undefined {
      if (sql.includes("FROM works")) {
        return { createdAt: CREATED_AT, targetPrincipalId: BOT_ID } as T;
      }
      if (sql.includes("attachment_create_idempotency") && ready && parameters[1] === ready.keyDigest) {
        return {
          ...ready,
          requestDigest: ready.requestDigest,
          ownerPrincipalId: ready.ownerPrincipalId,
          declaredContentType: ready.declaredContentType,
          detectedContentType: ready.detectedContentType,
          sequence: ready.throughEventSequence,
        } as T;
      }
      return undefined;
    },
  } satisfies ArtifactServiceDatabase;
  const store = {
    async ingest(input: any): Promise<ArtifactProjection> {
      ingestCount += 1;
      const chunks: Buffer[] = [];
      for await (const chunk of input.content) chunks.push(Buffer.from(chunk));
      assert.deepEqual(Buffer.concat(chunks), bytes);
      ready = Object.freeze({
        id: input.artifactId,
        ownerPrincipalId: BOT_ID,
        state: "ready" as const,
        name: input.originalName,
        declaredContentType: input.declaredContentType,
        detectedContentType: input.declaredContentType,
        byteCount: bytes.length,
        sha256,
        storage: "content_addressed" as const,
        createdAt: CREATED_AT,
        expiresAt: null,
        throughEventSequence: 2,
        requestDigest: input.idempotency.requestDigest,
        keyDigest: input.idempotency.keyDigest,
      });
      return ready;
    },
  } as unknown as LocalArtifactStore;
  const bot = {
    id: BOT_ID,
    principalId: BOT_ID,
    name: "Jerry",
    lifecycle: "active",
    residentBinding: "jerry",
    continuingIdentity: true,
    durableMailbox: true,
    requiredCapabilities: ["messages", "attachments"],
    activeInstanceId: "home23-jerry-harness",
    activeKeyVersion: 1,
    residentProtocolVersion: 1,
    residentCapabilities: ["messages", "attachments"],
    residentRegisteredAt: CREATED_AT,
  };
  const binding: ResidentLeaseBinding = {
    workId: WORK_ID,
    attemptId: "att_0198d95f-6c00-7000-8000-000000000a03",
    leaseId: "lea_0198d95f-6c00-7000-8000-000000000a04",
    holderPrincipalId: BOT_ID,
    holderInstanceId: "home23-jerry-harness",
    authorityReference: "resident:jerry",
    fencingToken: 1,
    requestId: "req_0198d95f-6c00-7000-8000-000000000a05",
    correlationId: "cor_0198d95f-6c00-7000-8000-000000000a06",
  };
  const promotion = createResidentArtifactPromotionPort({
    database,
    store: () => store,
    participantDirectory: {
      listVisibleBots: async () => [bot as never],
      resolveAlias: async (namespace, value) =>
        namespace === "resident" && value === "jerry" ? bot as never : null,
      getBotByResidentBinding: async (value) => value === "jerry" ? bot as never : null,
    },
    context: ({ requestId, correlationId }) => ({
      principalId: BOT_ID,
      requestId,
      correlationId,
      identity: { kind: "resident", resident: {
        requestId,
        correlationId,
        credential: {
          residentSlug: "jerry",
          role: "resident",
          instanceId: "home23-jerry-harness",
          keyVersion: 1,
        },
      } },
    }),
  });
  const descriptor = {
    type: "image" as const,
    generatedBy: "generate_image" as const,
    path,
    mimeType: "image/png",
    fileName: "answer.png",
    byteCount: bytes.length,
    sha256,
  };
  const first = await promotion.promote({ binding, media: [descriptor] });
  const replayed = await promotion.promote({ binding, media: [descriptor] });
  assert.deepEqual(replayed, first);
  assert.match(first[0]!, /^art_[0-9a-f-]+$/u);
  assert.equal(ingestCount, 1);

  await assert.rejects(promotion.promote({
    binding,
    media: [{ ...descriptor, generatedBy: undefined } as never],
  }));
  const symlinkPath = join(root, "linked.png");
  await symlink(path, symlinkPath);
  await assert.rejects(promotion.promote({
    binding: { ...binding, workId: "wrk_0198d95f-6c00-7000-8000-000000000b01" },
    media: [{ ...descriptor, path: symlinkPath, fileName: "linked.png" }],
  }));
});
