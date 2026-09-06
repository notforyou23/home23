import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createCoordinationProcess,
  disabledCoordinationFeatureFlags,
  type CoordinationRuntimeConfig,
} from "../../../src/coordination/app/index.js";
import {
  createAuthService,
  SqliteAuthRepository,
} from "../../../src/coordination/auth/index.js";
import { openCoordinationDatabase } from "../../../src/coordination/db/index.js";
import {
  COORDINATION_ATTACHMENTS_WRITER,
  type AuthorityEpoch,
} from "../../../src/coordination/epochs/index.js";
import { generateCoordinationId } from "../../../src/coordination/ids/index.js";
import { bootstrapJerry } from "../../../src/coordination/operations/index.js";

const BOOTSTRAP_AUTHORITY = Object.freeze({
  approved: true,
  kind: "m14-bootstrap",
  operator: "user_owner",
  resident: "jerry",
  legacyWriterAuthoritative: true,
  coordinationFlagsAllFalse: true,
} as const);

const ARTIFACT_ID = "art_0198d95f-6c00-7000-8000-000000000991";
const ARTIFACT_BYTES = Buffer.from(
  "Home23 production-process attachment restart evidence.\n",
  "utf8",
);
const ARTIFACT_SHA256 = createHash("sha256")
  .update(ARTIFACT_BYTES)
  .digest("hex");
const BOUNDARY = "home23-production-attachment-boundary";
const IDEMPOTENCY_KEY = "production-attachment-key-0001";

async function issueAccessToken(databasePath: string, capabilityToken: string) {
  const database = openCoordinationDatabase({ path: databasePath });
  try {
    const keyMaterial = createHash("sha256")
      .update("home23-coordination-auth-v1\0")
      .update(capabilityToken)
      .digest();
    const auth = createAuthService({
      repository: new SqliteAuthRepository(database),
      keyMaterial,
      admissionVerifier: {
        verifyLocalOperator: () => ({
          allowed: true,
          network: "loopback",
          rateLimitKey: "operator:attachment-production-test",
        }),
        verifyClient: () => ({
          allowed: true,
          network: "loopback",
          rateLimitKey: "client:attachment-production-test",
        }),
      },
    });
    keyMaterial.fill(0);
    const mutation = (idempotencyKey: string) => ({
      idempotencyKey,
      requestId: generateCoordinationId("request"),
      correlationId: generateCoordinationId("correlation"),
    });
    const issued = await auth.issuePairing({
      deviceName: "production-attachment-test",
      operator: "loopback",
      mutation: mutation("production-attachment-issue"),
    });
    const paired = await auth.redeemPairing({
      pairingSessionId: issued.pairingSession.id,
      pairingCode: issued.pairingCode,
      network: "loopback",
      device: {
        platform: "ios",
        name: "Home23 Canary fixture",
        appBuild: "test",
      },
      mutation: mutation("production-attachment-redeem"),
    });
    return paired.accessToken;
  } finally {
    database.close();
  }
}

/**
 * Isolated test-fixture authority writer. Production authority is never
 * touched; every fixture epoch and its event are appended atomically.
 */
function appendAttachmentEpoch(
  databasePath: string,
  epoch: Omit<AuthorityEpoch, "capability">,
): void {
  const database = openCoordinationDatabase({ path: databasePath });
  try {
    const createdAt = new Date(
      Date.UTC(2026, 7, 27, 18, 0, epoch.epoch),
    ).toISOString();
    database.mutateWithEvent((transaction) => {
      transaction.run(
        `INSERT INTO authority_epochs (
           capability, epoch, mode, writer, effective_at_event_sequence,
           rollback_epoch, receipt_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        "attachments",
        epoch.epoch,
        epoch.mode,
        epoch.writer,
        epoch.effectiveAtEventSequence,
        epoch.rollbackEpoch,
        JSON.stringify({
          kind: "isolated-attachment-authority-fixture",
          capability: "attachments",
          epoch: epoch.epoch,
        }),
        createdAt,
      );
      return {
        value: undefined,
        event: {
          type: "authority.epoch_changed",
          aggregateKind: "authorityEpoch",
          aggregateId: "authority:attachments",
          aggregateVersion: epoch.epoch,
          channelId: null,
          actorPrincipalId: "user_owner",
          requestId: generateCoordinationId("request"),
          correlationId: generateCoordinationId("correlation"),
          payload: {
            capability: "attachments",
            epoch: epoch.epoch,
            writer: epoch.writer,
            mode: epoch.mode,
          },
          createdAt,
        },
      };
    });
  } finally {
    database.close();
  }
}

function eventSequence(databasePath: string): number {
  const database = openCoordinationDatabase({ path: databasePath });
  try {
    return database.readOne<{ sequence: number }>(
      "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events",
    )?.sequence ?? 0;
  } finally {
    database.close();
  }
}

function multipart(content = ARTIFACT_BYTES): Buffer {
  const metadata = JSON.stringify({
    artifactId: ARTIFACT_ID,
    name: "restart-evidence.txt",
    declaredContentType: "text/plain",
    expectedSha256: ARTIFACT_SHA256,
  });
  return Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\n` +
      "Content-Disposition: form-data; name=\"metadata\"\r\n\r\n" +
      `${metadata}\r\n` +
      `--${BOUNDARY}\r\n` +
      "Content-Disposition: form-data; name=\"content\"; " +
      "filename=\"restart-evidence.txt\"\r\n" +
      "Content-Type: text/plain\r\n\r\n",
      "utf8",
    ),
    content,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`, "utf8"),
  ]);
}

test("production process preserves exact attachments across restart and independent rollback", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "home23-production-attachments-"));
  const runtime = join(root, "instances", ".house", "coordination");
  const attachmentRoot = join(runtime, "attachments");
  const databasePath = join(runtime, "coordination.sqlite3");
  const capabilityToken = "9".repeat(64);
  mkdirSync(runtime, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  await bootstrapJerry({
    databasePath,
    apply: true,
    authority: BOOTSTRAP_AUTHORITY,
    serverInstanceId: "home23-jerry-harness",
    keyVersion: 1,
  });
  const accessToken = await issueAccessToken(databasePath, capabilityToken);
  appendAttachmentEpoch(databasePath, {
    epoch: 1,
    mode: "legacy",
    writer: "legacy-attachment-writer",
    effectiveAtEventSequence: null,
    rollbackEpoch: null,
  });
  appendAttachmentEpoch(databasePath, {
    epoch: 2,
    mode: "shadow",
    writer: "legacy-attachment-writer",
    effectiveAtEventSequence: null,
    rollbackEpoch: null,
  });
  appendAttachmentEpoch(databasePath, {
    epoch: 3,
    mode: "canonical",
    writer: COORDINATION_ATTACHMENTS_WRITER,
    effectiveAtEventSequence: eventSequence(databasePath),
    rollbackEpoch: 1,
  });

  const flags = Object.freeze({
    ...disabledCoordinationFeatureFlags(),
    "coordination.process.enabled": true,
    "coordination.public_api.enabled": true,
  });
  const config = (attachmentsEnabled: boolean): CoordinationRuntimeConfig => ({
    enabled: true,
    host: "127.0.0.1",
    port: 0,
    databasePath,
    socketPath: join(runtime, "coordination.sock"),
    capabilityToken,
    attachments: {
      enabled: attachmentsEnabled,
      rootDirectory: attachmentRoot,
      maximumBytes: 25 * 1024 * 1024,
      maximumCountPerMessage: 10,
    },
    residents: {
      jerry: {
        enabled: false,
        socketPath: join(runtime, "resident-jerry.sock"),
        serverInstanceId: "home23-jerry-harness",
        clientInstanceId: "home23-jerry-harness",
        keyVersion: 1,
        key: "",
      },
      forrest: {
        enabled: false,
        socketPath: join(runtime, "resident-forrest.sock"),
        serverInstanceId: "home23-forrest-harness",
        clientInstanceId: "home23-forrest-harness",
        keyVersion: 1,
        key: "",
      },
    },
    flags,
  });
  const authHeaders = { authorization: `Bearer ${accessToken}` };
  const upload = (origin: string, content = ARTIFACT_BYTES) => {
    const body = multipart(content);
    return fetch(`${origin}/api/v1/attachments`, {
      method: "POST",
      headers: {
        ...authHeaders,
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
        "content-length": String(body.length),
        "idempotency-key": IDEMPOTENCY_KEY,
      },
      body,
    });
  };

  let running: ReturnType<typeof createCoordinationProcess> | null = null;
  t.after(async () => running?.drain());
  const start = async (attachmentsEnabled: boolean) => {
    assert.equal(running, null, "prior process must be drained before restart");
    running = createCoordinationProcess(config(attachmentsEnabled));
    return running.start();
  };
  const drain = async () => {
    assert.ok(running);
    await running.drain();
    running = null;
  };

  let address = await start(true);
  let capabilities = await (
    await fetch(`${address.origin}/api/v1/capabilities`)
  ).json() as any;
  assert.equal(capabilities.capabilities.attachments, true);
  assert.equal(capabilities.capabilities.messageSubmission, false);
  let bootstrap = await (
    await fetch(`${address.origin}/api/v1/bootstrap`, { headers: authHeaders })
  ).json() as any;
  assert.equal(bootstrap.capabilities.attachments, true);
  assert.equal(bootstrap.limits.attachmentBytes, 25 * 1024 * 1024);
  assert.equal(bootstrap.limits.attachmentCountPerMessage, 10);

  const createdResponse = await upload(address.origin);
  const createdText = await createdResponse.text();
  assert.equal(createdResponse.status, 201, createdText);
  const created = JSON.parse(createdText) as any;
  assert.equal(created.attachment.id, ARTIFACT_ID);
  assert.equal(created.attachment.sha256, ARTIFACT_SHA256);
  assert.equal(created.attachment.byteCount, ARTIFACT_BYTES.length);
  assert.equal(created.attachment.storage, "content_addressed");
  await drain();

  address = await start(true);
  const replayResponse = await upload(address.origin);
  const replayText = await replayResponse.text();
  assert.equal(replayResponse.status, 201, replayText);
  const replayed = JSON.parse(replayText) as any;
  assert.deepEqual(replayed.attachment, created.attachment);
  const changedReplay = await upload(
    address.origin,
    Buffer.from("changed replay bytes\n", "utf8"),
  );
  assert.equal(changedReplay.status, 409);
  assert.equal((await changedReplay.json() as any).error.code, "storage_conflict");

  const metadataResponse = await fetch(
    `${address.origin}/api/v1/attachments/${ARTIFACT_ID}`,
    { headers: authHeaders },
  );
  assert.equal(metadataResponse.status, 200);
  assert.deepEqual((await metadataResponse.json() as any).attachment, created.attachment);
  const fullDownload = await fetch(
    `${address.origin}/api/v1/attachments/${ARTIFACT_ID}/content`,
    { headers: authHeaders },
  );
  assert.equal(fullDownload.status, 200);
  assert.equal(fullDownload.headers.get("etag"), `"sha256:${ARTIFACT_SHA256}"`);
  assert.deepEqual(Buffer.from(await fullDownload.arrayBuffer()), ARTIFACT_BYTES);
  const rangeDownload = await fetch(
    `${address.origin}/api/v1/attachments/${ARTIFACT_ID}/content`,
    { headers: { ...authHeaders, range: "bytes=7-16" } },
  );
  assert.equal(rangeDownload.status, 206);
  assert.equal(
    rangeDownload.headers.get("content-range"),
    `bytes 7-16/${ARTIFACT_BYTES.length}`,
  );
  assert.deepEqual(
    Buffer.from(await rangeDownload.arrayBuffer()),
    ARTIFACT_BYTES.subarray(7, 17),
  );

  const objectPath = join(
    attachmentRoot,
    "objects",
    "sha256",
    ARTIFACT_SHA256.slice(0, 2),
    ARTIFACT_SHA256.slice(2, 4),
    ARTIFACT_SHA256,
  );
  assert.deepEqual(readFileSync(objectPath), ARTIFACT_BYTES);
  assert.equal(statSync(objectPath).mode & 0o777, 0o400);
  // Authority changes use the product writer lock only after bounded drain;
  // a second SQLite writer must not bypass the running canonical process.
  await drain();
  const database = openCoordinationDatabase({ path: databasePath });
  try {
    assert.equal(
      database.readOne<{ count: number }>(
        "SELECT count(*) AS count FROM artifacts",
      )?.count,
      1,
    );
    assert.equal(
      database.readOne<{ count: number }>(
        "SELECT count(*) AS count FROM attachment_create_idempotency",
      )?.count,
      1,
    );
    const artifactRow = database.readOne<Record<string, unknown>>(
      "SELECT * FROM artifacts WHERE id = ?",
      ARTIFACT_ID,
    );
    assert.ok(artifactRow);
    assert.equal(
      Object.keys(artifactRow).some((name) => /(?:path|blob)/iu.test(name)),
      false,
    );
    assert.equal(
      database.readOne<{ count: number }>(
        "SELECT count(*) AS count FROM events WHERE instr(payload_json, ?) > 0",
        root,
      )?.count,
      0,
    );
  } finally {
    database.close();
  }

  appendAttachmentEpoch(databasePath, {
    epoch: 4,
    mode: "legacy",
    writer: "legacy-attachment-writer",
    effectiveAtEventSequence: eventSequence(databasePath),
    rollbackEpoch: 1,
  });
  address = await start(true);
  capabilities = await (
    await fetch(`${address.origin}/api/v1/capabilities`)
  ).json() as any;
  assert.equal(capabilities.capabilities.attachments, false);
  bootstrap = await (
    await fetch(`${address.origin}/api/v1/bootstrap`, { headers: authHeaders })
  ).json() as any;
  assert.equal(bootstrap.capabilities.attachments, false);
  assert.equal(bootstrap.limits.attachmentBytes, 0);
  assert.equal(bootstrap.limits.attachmentCountPerMessage, 0);
  assert.equal(
    (await fetch(
      `${address.origin}/api/v1/attachments/${ARTIFACT_ID}`,
      { headers: authHeaders },
    )).status,
    404,
  );
  assert.deepEqual(readFileSync(objectPath), ARTIFACT_BYTES);
  await drain();

  appendAttachmentEpoch(databasePath, {
    epoch: 5,
    mode: "shadow",
    writer: "legacy-attachment-writer",
    effectiveAtEventSequence: null,
    rollbackEpoch: null,
  });
  appendAttachmentEpoch(databasePath, {
    epoch: 6,
    mode: "canonical",
    writer: COORDINATION_ATTACHMENTS_WRITER,
    effectiveAtEventSequence: eventSequence(databasePath),
    rollbackEpoch: 4,
  });

  address = await start(false);
  assert.equal(
    (await (await fetch(`${address.origin}/api/v1/capabilities`)).json() as any)
      .capabilities.attachments,
    false,
  );
  assert.deepEqual(readFileSync(objectPath), ARTIFACT_BYTES);
  await drain();

  address = await start(true);
  assert.equal(
    (await (await fetch(`${address.origin}/api/v1/capabilities`)).json() as any)
      .capabilities.attachments,
    true,
  );
  const restored = await fetch(
    `${address.origin}/api/v1/attachments/${ARTIFACT_ID}/content`,
    { headers: authHeaders },
  );
  assert.equal(restored.status, 200);
  assert.deepEqual(Buffer.from(await restored.arrayBuffer()), ARTIFACT_BYTES);
  await drain();
});
