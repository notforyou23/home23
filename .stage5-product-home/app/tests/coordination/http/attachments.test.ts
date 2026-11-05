import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { ArtifactError, type ArtifactProjection } from "../../../src/coordination/artifacts/index.js";
import {
  createCoordinationApplication,
  disabledCoordinationFeatureFlags,
  type CoordinationAttachmentPort,
} from "../../../src/coordination/app/index.js";
import { createCoordinationHttpServer } from "../../../src/coordination/http/index.js";

const ARTIFACT_ID = "art_0198d95f-6c00-7000-8000-000000000901";
const CORRELATION_ID = "cor_0198d95f-6c00-7000-8000-000000000901";
const bytes = Buffer.from("attachment bytes\n", "utf8");
const attachment = Object.freeze({
  id: ARTIFACT_ID,
  ownerPrincipalId: "user_owner",
  state: "ready",
  name: "evidence.txt",
  declaredContentType: "text/plain",
  detectedContentType: "text/plain",
  byteCount: bytes.length,
  sha256: "7".repeat(64),
  storage: "content_addressed",
  createdAt: "2026-08-25T16:00:00.000Z",
  expiresAt: null,
  throughEventSequence: 42,
} satisfies ArtifactProjection);

const flags = Object.freeze({
  ...disabledCoordinationFeatureFlags(),
  "coordination.process.enabled": true,
  "coordination.public_api.enabled": true,
});

const attachmentEpoch = Object.freeze({
  capability: "attachments" as const,
  epoch: 3,
  mode: "canonical" as const,
  writer: "home23-coordination",
  effectiveAtEventSequence: 1,
  rollbackEpoch: 1,
});

function authorityEpochs() {
  return {
    current: (capability: string) => capability === "attachments" ? attachmentEpoch : null,
    listCurrent: async () => ({ epochs: [attachmentEpoch], throughEventSequence: 1 }),
  };
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: "Bearer fixture-token",
    "x-correlation-id": CORRELATION_ID,
    ...extra,
  };
}

function auth() {
  return {
    validateAccessToken: async ({ requiredScopes }: { requiredScopes: readonly string[] }) => ({
      principalId: "user_owner" as const,
      deviceId: "dev_0198d95f-6c00-7000-8000-000000000901",
      sessionId: "ses_0198d95f-6c00-7000-8000-000000000901",
      scopes: requiredScopes,
    }),
  };
}

test("attachment capability and routes stay absent without the complete dependency", async (t) => {
  const application = createCoordinationApplication({ flags, services: { auth: auth() } });
  const server = createCoordinationHttpServer({ application, port: 0 });
  t.after(() => server.drain());
  const address = await server.start();

  assert.equal(application.capabilities().capabilities.attachments, false);
  const response = await fetch(`${address.origin}/api/v1/attachments/${ARTIFACT_ID}`, {
    headers: headers(),
  });
  assert.equal(response.status, 404);
  assert.equal((await response.json() as any).error.code, "route_not_found");
});

test("complete dependency exposes authenticated metadata, multipart upload, and exact ranges", async (t) => {
  const calls: string[] = [];
  const service: CoordinationAttachmentPort = {
    create: async (input) => {
      calls.push(`create:${input.idempotencyKey}:${input.contentType}`);
      const chunks: Buffer[] = [];
      for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
      assert.match(Buffer.concat(chunks).toString("utf8"), /attachment bytes/);
      return attachment;
    },
    getMetadata: async (input) => {
      calls.push(`metadata:${input.artifactId}`);
      return attachment;
    },
    openDownload: async (input) => {
      calls.push(`download:${input.rangeHeader}`);
      return {
        status: 206,
        contentType: "text/plain",
        contentLength: 6,
        byteCount: bytes.length,
        sha256: attachment.sha256,
        range: { start: 0, end: 5, total: bytes.length },
        content: Readable.from([bytes.subarray(0, 6)]),
      };
    },
  };
  const application = createCoordinationApplication({
    flags,
    services: { auth: auth(), attachments: service, authorityEpochs: authorityEpochs() },
  });
  const server = createCoordinationHttpServer({ application, port: 0 });
  t.after(() => server.drain());
  const address = await server.start();

  assert.equal(application.capabilities().capabilities.attachments, true);
  const metadata = await fetch(`${address.origin}/api/v1/attachments/${ARTIFACT_ID}`, {
    headers: headers(),
  });
  assert.equal(metadata.status, 200);
  const metadataBody = await metadata.json() as any;
  assert.deepEqual(metadataBody.attachment, attachment);
  assert.equal(metadataBody.throughEventSequence, 42);
  assert.equal(metadataBody.correlationId, CORRELATION_ID);

  const form = new FormData();
  form.set("metadata", JSON.stringify({
    artifactId: ARTIFACT_ID,
    name: "evidence.txt",
    declaredContentType: "text/plain",
    expectedSha256: attachment.sha256,
  }));
  form.set("content", new Blob([bytes], { type: "text/plain" }), "evidence.txt");
  const uploaded = await fetch(`${address.origin}/api/v1/attachments`, {
    method: "POST",
    headers: headers({ "idempotency-key": "attachment-key-0001" }),
    body: form,
  });
  assert.equal(uploaded.status, 201);
  assert.deepEqual((await uploaded.json() as any).attachment, attachment);

  const ranged = await fetch(`${address.origin}/api/v1/attachments/${ARTIFACT_ID}/content`, {
    headers: headers({ range: "bytes=0-5" }),
  });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get("accept-ranges"), "bytes");
  assert.equal(ranged.headers.get("content-range"), `bytes 0-5/${bytes.length}`);
  assert.equal(ranged.headers.get("etag"), `"sha256:${attachment.sha256}"`);
  assert.equal(ranged.headers.get("content-disposition"), "attachment");
  assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), bytes.subarray(0, 6));
  assert.equal(calls.length, 3);
});

test("upload admission and M10 failures remain structured and do not invoke partial work", async (t) => {
  let creates = 0;
  const service: CoordinationAttachmentPort = {
    create: async () => { creates += 1; throw new ArtifactError("digest_mismatch"); },
    getMetadata: async () => { throw new ArtifactError("scope_denied"); },
    openDownload: async () => { throw new ArtifactError("range_invalid"); },
  };
  const application = createCoordinationApplication({
    flags,
    services: { auth: auth(), attachments: service, authorityEpochs: authorityEpochs() },
  });
  const server = createCoordinationHttpServer({ application, port: 0 });
  t.after(() => server.drain());
  const address = await server.start();

  const missingKey = await fetch(`${address.origin}/api/v1/attachments`, {
    method: "POST",
    headers: headers({ "content-type": "multipart/form-data; boundary=x" }),
    body: "--x--\r\n",
  });
  assert.equal(missingKey.status, 400);
  assert.equal((await missingKey.json() as any).error.code, "idempotency_key_required");
  assert.equal(creates, 0);

  const denied = await fetch(`${address.origin}/api/v1/attachments/${ARTIFACT_ID}`, {
    headers: headers(),
  });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json() as any).error.code, "scope_denied");

  const invalidRange = await fetch(
    `${address.origin}/api/v1/attachments/${ARTIFACT_ID}/content`,
    { headers: headers({ range: "bytes=99-100" }) },
  );
  assert.equal(invalidRange.status, 416);
  assert.equal((await invalidRange.json() as any).error.code, "range_invalid");
});
