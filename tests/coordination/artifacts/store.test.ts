import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
  resolveArtifactActor,
  type ArtifactActor,
  type ArtifactProjection,
} from "../../../src/coordination/artifacts/index.js";

let OWNER: ArtifactActor;
test.before(async () => {
  OWNER = await resolveArtifactActor({
    principalId: "user_owner",
    requestId: "req_0198d95f-6c00-7000-8000-000000000801",
    correlationId: "cor_0198d95f-6c00-7000-8000-000000000801",
    identity: {
      kind: "owner",
      auth: {
        principalId: "user_owner",
        deviceId: "dev_0198d95f-6c00-7000-8000-000000000801",
        sessionId: "ses_0198d95f-6c00-7000-8000-000000000801",
        scopes: ["attachment:write"],
      },
    },
  }, {
    async listVisibleBots() { return []; },
    async resolveAlias() { return null; },
    async getBotByResidentBinding() { return null; },
  });
});

class MemoryArtifactRepository {
  private readonly records = new Map<string, Record<string, unknown>>();

  async beginStaging(input: { artifact: Record<string, unknown> }): Promise<void> {
    this.records.set(String(input.artifact.id), { ...input.artifact });
  }

  async commitReady(input: { artifact: Record<string, unknown> }): Promise<ArtifactProjection> {
    this.records.set(String(input.artifact.id), { ...input.artifact });
    return Object.freeze({ ...input.artifact, throughEventSequence: 2 }) as ArtifactProjection;
  }

  async markFailed(input: { artifactId: string }): Promise<void> {
    const current = this.records.get(input.artifactId);
    if (current) this.records.set(input.artifactId, { ...current, state: "failed" });
  }

  async findAuthorized(input: { artifactId: string; actor: typeof OWNER; observedAt?: string }) {
    const record = this.records.get(input.artifactId);
    const unexpired = record?.expiresAt === null ||
      (typeof record?.expiresAt === "string" &&
        (!input.observedAt || record.expiresAt > input.observedAt));
    return record?.state === "ready" && record.ownerPrincipalId === input.actor.principalId && unexpired
      ? Object.freeze({ ...record })
      : null;
  }

  async expireDueDrafts(input: { observedAt: string; limit: number }): Promise<{
    observedAt: string;
    expiredArtifactIds: readonly string[];
  }> {
    const expiredArtifactIds = [...this.records.entries()]
      .filter(([, record]) =>
        record.state === "ready" &&
        typeof record.expiresAt === "string" &&
        record.expiresAt <= input.observedAt
      )
      .slice(0, input.limit)
      .map(([artifactId, record]) => {
        this.records.set(artifactId, { ...record, state: "expired" });
        return artifactId;
      });
    return Object.freeze({
      observedAt: input.observedAt,
      expiredArtifactIds: Object.freeze(expiredArtifactIds),
    });
  }

  async recoverAbandonedStaging(input: {
    observedAt: string;
    createdBefore: string;
    limit: number;
    dryRun: boolean;
  }): Promise<{
    dryRun: boolean;
    observedAt: string;
    abandonedArtifactIds: readonly string[];
  }> {
    const abandonedArtifactIds = [...this.records.entries()]
      .filter(([, record]) =>
        record.state === "staging" &&
        typeof record.createdAt === "string" &&
        record.createdAt <= input.createdBefore
      )
      .slice(0, input.limit)
      .map(([artifactId, record]) => {
        if (!input.dryRun) this.records.set(artifactId, { ...record, state: "failed" });
        return artifactId;
      });
    return Object.freeze({
      dryRun: input.dryRun,
      observedAt: input.observedAt,
      abandonedArtifactIds: Object.freeze(abandonedArtifactIds),
    });
  }

  async countReadyReferencesByDigest(sha256: string): Promise<number> {
    return [...this.records.values()].filter(
      (record) => record.state === "ready" && record.sha256 === sha256,
    ).length;
  }

  async listActiveDigests(): Promise<readonly string[]> {
    return [...new Set([...this.records.values()]
      .filter((record) => record.state === "ready")
      .map((record) => String(record.sha256)))];
  }

  record(artifactId: string): Record<string, unknown> | undefined {
    return this.records.get(artifactId);
  }

  get size(): number {
    return this.records.size;
  }

  forget(artifactId: string): void {
    this.records.delete(artifactId);
  }
}

async function readAll(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function minimalPdf(): Buffer {
  const header = "%PDF-1.7\n";
  const objectOffset = Buffer.byteLength(header);
  const object = "1 0 obj\n<< /Type /Catalog >>\nendobj\n";
  const xrefOffset = objectOffset + Buffer.byteLength(object);
  const xref = `xref\n0 2\n0000000000 65535 f \n${String(objectOffset).padStart(10, "0")} 00000 n \n`;
  const trailer = `trailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(header + object + xref + trailer);
}

const TEST_CRC32_TABLE = Array.from({ length: 256 }, (_unused, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const crcInput = Buffer.concat([typeBytes, data]);
  let crc = 0xffffffff;
  for (const byte of crcInput) crc = TEST_CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  typeBytes.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length);
  return result;
}

function shellPng(width = 1, height = 1): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", Buffer.from([0])),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

test("streamed ingest and authorized download preserve the exact bytes and hash without exposing a path", async (t) => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "home23-m10-round-trip-"));
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));

  const artifacts = await import("../../../src/coordination/artifacts/index.js").catch(
    (error: unknown) => assert.fail(`M10 artifact module is unavailable: ${String(error)}`),
  );
  const repository = new MemoryArtifactRepository();
  const store = await artifacts.LocalArtifactStore.open({
    rootDirectory,
    repository,
    now: () => new Date("2026-08-25T15:00:00.000Z"),
    quarantineId: () => "quarantine-0001",
  });
  const expectedBytes = Buffer.from("M10 exact bytes\n", "utf8");
  const expectedSha256 =
    "b2a7d72c4486981563921cca03d7c72756f0c4d1bff2f07d2773dee696260fda";

  const uploaded = await store.ingest({
    artifactId: "art_0198d95f-6c00-7000-8000-000000000801",
    actor: OWNER,
    originalName: "evidence.txt",
    declaredContentType: "text/plain",
    expectedSha256,
    content: Readable.from([
      expectedBytes.subarray(0, 4),
      expectedBytes.subarray(4, 10),
      expectedBytes.subarray(10),
    ]),
  });

  assert.equal(uploaded.sha256, expectedSha256);
  assert.equal(uploaded.byteCount, expectedBytes.length);
  assert.equal(uploaded.detectedContentType, "text/plain");
  assert.equal(uploaded.state, "ready");
  assert.equal(uploaded.throughEventSequence, 2);
  assert.equal(JSON.stringify(uploaded).includes(rootDirectory), false);

  const download = await store.openDownload({
    artifactId: uploaded.id,
    actor: OWNER,
  });
  assert.equal(download.status, 200);
  assert.equal(download.sha256, expectedSha256);
  assert.equal(download.contentLength, expectedBytes.length);
  assert.equal("path" in download.content, false);
  assert.deepEqual(await readAll(download.content), expectedBytes);
  assert.equal(JSON.stringify({ ...download, content: "<stream>" }).includes(rootDirectory), false);
  const canonicalObject = join(
    rootDirectory,
    "objects",
    "sha256",
    expectedSha256.slice(0, 2),
    expectedSha256.slice(2, 4),
    expectedSha256,
  );
  assert.equal((await stat(rootDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(rootDirectory, "quarantine"))).mode & 0o777, 0o700);
  assert.equal((await stat(canonicalObject)).mode & 0o777, 0o400);
});

test("store policy cannot be configured above the accepted 25 MiB contract ceiling", async (t) => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "home23-m10-policy-ceiling-"));
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));
  const artifacts = await import("../../../src/coordination/artifacts/index.js");
  await assert.rejects(
    artifacts.LocalArtifactStore.open({
      rootDirectory,
      repository: new MemoryArtifactRepository(),
      maximumBytes: artifacts.DEFAULT_MAXIMUM_ARTIFACT_BYTES + 1,
    }),
    /at most 26214400/,
  );
});

test("draft retention can narrow but cannot exceed the accepted 24-hour ceiling", async (t) => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "home23-m10-retention-ceiling-"));
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));
  const artifacts = await import("../../../src/coordination/artifacts/index.js");
  for (const draftLifetimeMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 86_400_001]) {
    await assert.rejects(
      artifacts.LocalArtifactStore.open({
        rootDirectory,
        repository: new MemoryArtifactRepository(),
        draftLifetimeMs,
      }),
      /positive safe integer at most 86400000/,
    );
  }
  await assert.rejects(
    artifacts.LocalArtifactStore.open({
      rootDirectory,
      repository: new MemoryArtifactRepository(),
      maximumConcurrentUploads: 9,
    }),
    /safe integer from 1 through 8/,
  );
});

test("the quarantine writer retries legal short writes and fails closed on zero progress", async () => {
  const { writeArtifactBytesFully } = await import(
    "../../../src/coordination/artifacts/store.js"
  );
  const source = Buffer.from("short writes remain exact");
  const persisted: Buffer[] = [];
  let calls = 0;
  await writeArtifactBytesFully({
    async write(buffer, offset, length) {
      calls += 1;
      const bytesWritten = Math.min(3, length);
      persisted.push(Buffer.from(buffer.subarray(offset, offset + bytesWritten)));
      return { bytesWritten };
    },
  }, source);
  assert.ok(calls > 1);
  assert.deepEqual(Buffer.concat(persisted), source);

  await assert.rejects(
    writeArtifactBytesFully({
      async write() {
        return { bytesWritten: 0 };
      },
    }, source),
    (error: unknown) =>
      error instanceof Error && error.message === "storage_integrity",
  );
});

test("store bootstrap rejects a symlinked objects ancestor before any out-of-root mutation", async (t) => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "home23-m10-root-link-"));
  const outsideDirectory = await mkdtemp(join(tmpdir(), "home23-m10-root-link-outside-"));
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));
  t.after(() => rm(outsideDirectory, { recursive: true, force: true }));
  await symlink(outsideDirectory, join(rootDirectory, "objects"));
  const artifacts = await import("../../../src/coordination/artifacts/index.js");

  await assert.rejects(
    artifacts.LocalArtifactStore.open({
      rootDirectory,
      repository: new MemoryArtifactRepository(),
    }),
    (error: unknown) =>
      error instanceof artifacts.ArtifactError && error.code === "storage_integrity",
  );
  await assert.rejects(access(join(outsideDirectory, "sha256")), { code: "ENOENT" });
});

test("store bootstrap refuses an unmarked shared directory without changing its permissions", async (t) => {
  const sharedDirectory = await mkdtemp(join(tmpdir(), "home23-m10-shared-root-"));
  t.after(() => rm(sharedDirectory, { recursive: true, force: true }));
  await writeFile(join(sharedDirectory, "belongs-to-operator.txt"), "keep");
  await chmod(sharedDirectory, 0o755);
  const artifacts = await import("../../../src/coordination/artifacts/index.js");

  await assert.rejects(
    artifacts.LocalArtifactStore.open({
      rootDirectory: sharedDirectory,
      repository: new MemoryArtifactRepository(),
    }),
    (error: unknown) =>
      error instanceof artifacts.ArtifactError && error.code === "storage_integrity",
  );
  assert.equal((await stat(sharedDirectory)).mode & 0o777, 0o755);
  assert.equal(await readFile(join(sharedDirectory, "belongs-to-operator.txt"), "utf8"), "keep");
});

test("an empty plain-text artifact round trips as zero bytes without an invalid file range", async (t) => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "home23-m10-empty-"));
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));
  const { LocalArtifactStore } = await import("../../../src/coordination/artifacts/index.js");
  const repository = new MemoryArtifactRepository();
  const store = await LocalArtifactStore.open({
    rootDirectory,
    repository,
    quarantineId: () => "quarantine-empty",
  });
  const uploaded = await store.ingest({
    artifactId: "art_0198d95f-6c00-7000-8000-000000000804",
    actor: OWNER,
    originalName: "empty.txt",
    declaredContentType: "text/plain",
    expectedSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    content: Readable.from([]),
  });

  const download = await store.openDownload({ artifactId: uploaded.id, actor: OWNER });
  assert.equal(download.status, 200);
  assert.equal(download.contentLength, 0);
  assert.deepEqual(await readAll(download.content), Buffer.alloc(0));
});

test("an authorized single byte range returns only the requested inclusive bytes", async (t) => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "home23-m10-range-"));
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));
  const { LocalArtifactStore } = await import("../../../src/coordination/artifacts/index.js");
  const repository = new MemoryArtifactRepository();
  const store = await LocalArtifactStore.open({
    rootDirectory,
    repository,
    quarantineId: () => "quarantine-range",
  });
  const bytes = Buffer.from("M10 exact bytes\n", "utf8");
  const artifact = await store.ingest({
    artifactId: "art_0198d95f-6c00-7000-8000-000000000805",
    actor: OWNER,
    originalName: "range.txt",
    declaredContentType: "text/plain",
    expectedSha256: "b2a7d72c4486981563921cca03d7c72756f0c4d1bff2f07d2773dee696260fda",
    content: Readable.from([bytes]),
  });

  const download = await store.openDownload({
    artifactId: artifact.id,
    actor: OWNER,
    rangeHeader: "bytes=4-8",
  });
  assert.equal(download.status, 206);
  assert.deepEqual(download.range, { start: 4, end: 8, total: 16 });
  assert.equal(download.contentLength, 5);
  assert.deepEqual(await readAll(download.content), Buffer.from("exact"));
});

test("download verification cache invalidates on canonical inode metadata change", async (t) => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "home23-m10-download-integrity-"));
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));
  const artifacts = await import("../../../src/coordination/artifacts/index.js");
  const store = await artifacts.LocalArtifactStore.open({
    rootDirectory,
    repository: new MemoryArtifactRepository(),
    quarantineId: () => "quarantine-download-integrity",
  });
  const artifactId = "art_0198d95f-6c00-7000-8000-000000000806";
  const sha256 = "b2a7d72c4486981563921cca03d7c72756f0c4d1bff2f07d2773dee696260fda";
  await store.ingest({
    artifactId,
    actor: OWNER,
    originalName: "integrity.txt",
    declaredContentType: "text/plain",
    expectedSha256: sha256,
    content: Readable.from([Buffer.from("M10 exact bytes\n")]),
  });
  const canonicalObject = join(
    rootDirectory,
    "objects",
    "sha256",
    sha256.slice(0, 2),
    sha256.slice(2, 4),
    sha256,
  );
  await chmod(canonicalObject, 0o600);
  await writeFile(canonicalObject, "M10 altered byt\n");
  await chmod(canonicalObject, 0o400);

  await assert.rejects(
    store.openDownload({ artifactId, actor: OWNER, rangeHeader: "bytes=0-0" }),
    (error: unknown) =>
      error instanceof artifacts.ArtifactError && error.code === "storage_integrity",
  );
});

test("multiple, empty, reversed, and unsatisfied byte ranges fail with one redacted result", async () => {
  const { ArtifactError, parseSingleByteRange } = await import(
    "../../../src/coordination/artifacts/index.js"
  );
  for (const header of ["bytes=0-1,4-5", "bytes=-0", "bytes=8-4", "bytes=16-"]) {
    assert.throws(
      () => parseSingleByteRange(header, 16),
      (error: unknown) =>
        error instanceof ArtifactError &&
        error.code === "range_invalid" &&
        error.httpStatus === 416 &&
        error.message === "range_invalid",
      header,
    );
  }
});

test("two artifact records with exact matching bytes share one canonical object", async (t) => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "home23-m10-dedupe-"));
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));
  const artifacts = await import("../../../src/coordination/artifacts/index.js");
  const repository = new MemoryArtifactRepository();
  let quarantine = 0;
  const store = await artifacts.LocalArtifactStore.open({
    rootDirectory,
    repository,
    quarantineId: () => `quarantine-${++quarantine}`,
  });
  const content = Buffer.from("M10 exact bytes\n", "utf8");
  const sha256 = "b2a7d72c4486981563921cca03d7c72756f0c4d1bff2f07d2773dee696260fda";

  for (const artifactId of [
    "art_0198d95f-6c00-7000-8000-000000000811",
    "art_0198d95f-6c00-7000-8000-000000000812",
  ]) {
    await store.ingest({
      artifactId,
      actor: OWNER,
      originalName: "same.txt",
      declaredContentType: "text/plain",
      expectedSha256: sha256,
      content: Readable.from([content]),
    });
  }

  const storedEntries = await readdir(join(rootDirectory, "objects"), { recursive: true });
  assert.equal(storedEntries.filter((entry) => entry.endsWith(sha256)).length, 1);
  for (const artifactId of [
    "art_0198d95f-6c00-7000-8000-000000000811",
    "art_0198d95f-6c00-7000-8000-000000000812",
  ]) {
    const download = await store.openDownload({ artifactId, actor: OWNER });
    assert.deepEqual(await readAll(download.content), content);
  }
});

test("the byte ceiling stops the source incrementally and cleans quarantine before publish", async (t) => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "home23-m10-limit-"));
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));
  const { ArtifactError, LocalArtifactStore } = await import(
    "../../../src/coordination/artifacts/index.js"
  );
  const artifactId = "art_0198d95f-6c00-7000-8000-000000000821";
  const repository = new MemoryArtifactRepository();
  const store = await LocalArtifactStore.open({
    rootDirectory,
    repository,
    maximumBytes: 8,
    quarantineId: () => "quarantine-limit",
  });
  let chunksPulled = 0;
  async function* content() {
    chunksPulled += 1;
    yield Buffer.from("abcdef");
    chunksPulled += 1;
    yield Buffer.from("abcdef");
    chunksPulled += 1;
    yield Buffer.from("must-not-be-read");
  }

  await assert.rejects(
    store.ingest({
      artifactId,
      actor: OWNER,
      originalName: "bounded.txt",
      declaredContentType: "text/plain",
      expectedSha256: "d4c1fbf464f5b33943de95dc68d7028134196d66ee756a9d2ac64c9d5dfcddfe",
      content: content(),
    }),
    (error: unknown) => error instanceof ArtifactError && error.code === "size_limit_exceeded",
  );
  assert.equal(chunksPulled, 2);
  assert.equal(repository.record(artifactId)?.state, "failed");
  assert.deepEqual(await readdir(join(rootDirectory, "quarantine")), []);
  assert.deepEqual(await readdir(join(rootDirectory, "objects"), { recursive: true }), ["sha256"]);
});

test("a slow bounded upload does not hold the root mutation queue", async (t) => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "home23-m10-stream-concurrency-"));
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));
  const { LocalArtifactStore } = await import("../../../src/coordination/artifacts/index.js");
  const store = await LocalArtifactStore.open({
    rootDirectory,
    repository: new MemoryArtifactRepository(),
    quarantineId: () => "quarantine-stream-concurrency",
  });
  let releaseStream!: () => void;
  const streamGate = new Promise<void>((resolveGate) => { releaseStream = resolveGate; });
  let signalStarted!: () => void;
  const started = new Promise<void>((resolveStarted) => { signalStarted = resolveStarted; });
  const content = (async function* slowContent() {
    yield Buffer.from("M10 ");
    signalStarted();
    await streamGate;
    yield Buffer.from("exact bytes\n");
  })();
  const upload = store.ingest({
    artifactId: "art_0198d95f-6c00-7000-8000-000000000831",
    actor: OWNER,
    originalName: "slow.txt",
    declaredContentType: "text/plain",
    expectedSha256: "b2a7d72c4486981563921cca03d7c72756f0c4d1bff2f07d2773dee696260fda",
    content,
  });
  await started;

  const gc = await store.collectGarbage({ dryRun: true });
  assert.equal(gc.candidateCount, 0);
  assert.equal(gc.deferredRecentQuarantineCount, 1);

  releaseStream();
  const uploaded = await upload;
  assert.equal(uploaded.sha256, "b2a7d72c4486981563921cca03d7c72756f0c4d1bff2f07d2773dee696260fda");
});

test("upload admission bounds concurrent streams and queued wait time", async (t) => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "home23-m10-upload-admission-"));
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));
  const artifacts = await import("../../../src/coordination/artifacts/index.js");
  let quarantine = 0;
  const store = await artifacts.LocalArtifactStore.open({
    rootDirectory,
    repository: new MemoryArtifactRepository(),
    maximumConcurrentUploads: 1,
    uploadAdmissionTimeoutMs: 20,
    quarantineId: () => `quarantine-admission-${++quarantine}`,
  });
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolveGate) => { releaseFirst = resolveGate; });
  let signalStarted!: () => void;
  const started = new Promise<void>((resolveStarted) => { signalStarted = resolveStarted; });
  const first = store.ingest({
    artifactId: "art_0198d95f-6c00-7000-8000-000000000832",
    actor: OWNER,
    originalName: "first.txt",
    declaredContentType: "text/plain",
    expectedSha256: "b2a7d72c4486981563921cca03d7c72756f0c4d1bff2f07d2773dee696260fda",
    content: (async function* firstContent() {
      signalStarted();
      await firstGate;
      yield Buffer.from("M10 exact bytes\n");
    })(),
  });
  await started;

  await assert.rejects(
    store.ingest({
      artifactId: "art_0198d95f-6c00-7000-8000-000000000833",
      actor: OWNER,
      originalName: "second.txt",
      declaredContentType: "text/plain",
      expectedSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      content: Readable.from([]),
    }),
    (error: unknown) =>
      error instanceof artifacts.ArtifactError && error.code === "storage_unavailable",
  );
  releaseFirst();
  await first;
});

test("active text is rejected before canonical publication", async (t) => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "home23-m10-active-"));
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));
  const { ArtifactError, LocalArtifactStore } = await import(
    "../../../src/coordination/artifacts/index.js"
  );
  const repository = new MemoryArtifactRepository();
  const store = await LocalArtifactStore.open({
    rootDirectory,
    repository,
    quarantineId: () => "quarantine-active",
  });

  await assert.rejects(
    store.ingest({
      artifactId: "art_0198d95f-6c00-7000-8000-000000000831",
      actor: OWNER,
      originalName: "active.txt",
      declaredContentType: null,
      expectedSha256: "5c140d35dcb46a622e2cedf5ef5cc3638cdffd1c118c9331f8c84669f0b74783",
      content: Readable.from([Buffer.from("<script>alert(1)</script>")]),
    }),
    (error: unknown) => error instanceof ArtifactError && error.code === "invalid_content_type",
  );

  assert.equal(repository.size, 1);
  assert.equal(repository.record("art_0198d95f-6c00-7000-8000-000000000831")?.state, "failed");
  assert.deepEqual(await readdir(join(rootDirectory, "quarantine")), []);
  assert.deepEqual(await readdir(join(rootDirectory, "objects"), { recursive: true }), ["sha256"]);
});

test("a binary NUL after the sniff prefix cannot be misclassified as plain text", async (t) => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "home23-m10-binary-text-"));
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));
  const { ArtifactError, LocalArtifactStore } = await import(
    "../../../src/coordination/artifacts/index.js"
  );
  const repository = new MemoryArtifactRepository();
  const store = await LocalArtifactStore.open({
    rootDirectory,
    repository,
    quarantineId: () => "quarantine-binary-text",
  });

  await assert.rejects(
    store.ingest({
      artifactId: "art_0198d95f-6c00-7000-8000-000000000849",
      actor: OWNER,
      originalName: "binary.txt",
      declaredContentType: "text/plain",
      expectedSha256: "3d062dc1607efa84a62622cd3a73253674158f734112d1bded7edbb742484798",
      content: Readable.from([Buffer.alloc(4096, 0x61), Buffer.from([0])]),
    }),
    (error: unknown) => error instanceof ArtifactError && error.code === "invalid_content_type",
  );
});

test("the bounded allowlist accepts each documented structural profile with its exact declared type", async (t) => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "home23-m10-types-"));
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));
  const { LocalArtifactStore, SUPPORTED_ARTIFACT_CONTENT_TYPES } = await import(
    "../../../src/coordination/artifacts/index.js"
  );
  assert.equal(new Set<string>(SUPPORTED_ARTIFACT_CONTENT_TYPES).has("image/webp"), false);
  const repository = new MemoryArtifactRepository();
  let quarantine = 0;
  const store = await LocalArtifactStore.open({
    rootDirectory,
    repository,
    quarantineId: () => `quarantine-types-${++quarantine}`,
  });
  const cases = [
    {
      name: "image.png",
      type: "image/png",
      bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
    },
    {
      name: "image.jpg",
      type: "image/jpeg",
      bytes: Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==", "base64"),
    },
    {
      name: "image.gif",
      type: "image/gif",
      bytes: Buffer.from("R0lGODlhAQABAPAAAP///wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==", "base64"),
    },
    {
      name: "document.pdf",
      type: "application/pdf",
      bytes: minimalPdf(),
    },
  ] as const;

  for (const [index, item] of cases.entries()) {
    const uploaded = await store.ingest({
      artifactId: `art_0198d95f-6c00-7000-8000-${String(850 + index).padStart(12, "0")}`,
      actor: OWNER,
      originalName: item.name,
      declaredContentType: item.type,
      expectedSha256: createHash("sha256").update(item.bytes).digest("hex"),
      content: Readable.from([item.bytes]),
    }).catch((error: unknown) =>
      assert.fail(`${item.name} profile was rejected: ${String(error)}`)
    );
    assert.equal(uploaded.detectedContentType, item.type, item.name);
  }
});

test("magic prefixes without a complete supported file structure are rejected", async (t) => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "home23-m10-truncated-types-"));
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));
  const artifacts = await import("../../../src/coordination/artifacts/index.js");
  const repository = new MemoryArtifactRepository();
  let quarantine = 0;
  const store = await artifacts.LocalArtifactStore.open({
    rootDirectory,
    repository,
    quarantineId: () => `quarantine-truncated-${++quarantine}`,
  });
  const cases = [
    ["image/png", "89504e470d0a1a0a0000000d49484452"],
    ["image/jpeg", "ffd8ffe000104a4649460001"],
    ["image/webp", "52494646080000005745425056503820"],
    ["image/gif", "47494638396101000100"],
    ["application/pdf", "255044462d312e370a"],
  ] as const;
  for (const [index, [contentType, hex]] of cases.entries()) {
    const bytes = Buffer.from(hex, "hex");
    await assert.rejects(
      store.ingest({
        artifactId: `art_0198d95f-6c00-7000-8000-${String(855 + index).padStart(12, "0")}`,
        actor: OWNER,
        originalName: `truncated-${index}`,
        declaredContentType: contentType,
        expectedSha256: createHash("sha256").update(bytes).digest("hex"),
        content: Readable.from([bytes]),
      }),
      (error: unknown) =>
        error instanceof artifacts.ArtifactError && error.code === "invalid_content_type",
    );
  }
});

test("token-shaped media shells and oversized raster declarations are rejected", async (t) => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "home23-m10-malformed-media-"));
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));
  const artifacts = await import("../../../src/coordination/artifacts/index.js");
  const store = await artifacts.LocalArtifactStore.open({
    rootDirectory,
    repository: new MemoryArtifactRepository(),
  });
  const jpegShell = Buffer.from(
    "ffd8ffc0000b080001000101011100ffda0008010100003f0000ffd9",
    "hex",
  );
  const pdfShell = Buffer.from(
    "%PDF-1.7\n1 0 obj\n<<>>\nendobj\nxref\n0 2\n0000000000 65535 f \n0000000009 00000 n \ntrailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n35\n%%EOF\n",
  );
  const cases = [
    ["image/png", shellPng()],
    ["image/png", shellPng(65_535, 65_535)],
    ["image/jpeg", jpegShell],
    ["image/webp", Buffer.from("UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAgA0JaQAA3AA/vuUAAA=", "base64")],
    ["application/pdf", pdfShell],
  ] as const;

  for (const [index, [contentType, bytes]] of cases.entries()) {
    await assert.rejects(
      store.ingest({
        artifactId: `art_0198d95f-6c00-7000-8000-${String(865 + index).padStart(12, "0")}`,
        actor: OWNER,
        originalName: `malformed-${index}`,
        declaredContentType: contentType,
        expectedSha256: createHash("sha256").update(bytes).digest("hex"),
        content: Readable.from([bytes]),
      }),
      (error: unknown) =>
        error instanceof artifacts.ArtifactError && error.code === "invalid_content_type",
      contentType,
    );
  }
});

test("declared and detected content types must match", async (t) => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "home23-m10-type-mismatch-"));
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));
  const { ArtifactError, LocalArtifactStore } = await import(
    "../../../src/coordination/artifacts/index.js"
  );
  const artifactId = "art_0198d95f-6c00-7000-8000-000000000861";
  const repository = new MemoryArtifactRepository();
  const store = await LocalArtifactStore.open({
    rootDirectory,
    repository,
    quarantineId: () => "quarantine-type-mismatch",
  });

  await assert.rejects(
    store.ingest({
      artifactId,
      actor: OWNER,
      originalName: "not-a-jpeg.jpg",
      declaredContentType: "image/jpeg",
      expectedSha256: "02a3e298f1533f62558c58e4c70edcab9af5a50d62d925fd5390942020fb0fb8",
      content: Readable.from([Buffer.from("89504e470d0a1a0a0000000d49484452", "hex")]),
    }),
    (error: unknown) => error instanceof ArtifactError && error.code === "invalid_content_type",
  );
  assert.equal(repository.record(artifactId)?.state, "failed");
  assert.deepEqual(await readdir(join(rootDirectory, "quarantine")), []);
  assert.deepEqual(await readdir(join(rootDirectory, "objects"), { recursive: true }), ["sha256"]);
});

test("path-shaped filenames are rejected before staging", async (t) => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "home23-m10-filename-"));
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));
  const { ArtifactError, LocalArtifactStore } = await import(
    "../../../src/coordination/artifacts/index.js"
  );
  const repository = new MemoryArtifactRepository();
  const store = await LocalArtifactStore.open({
    rootDirectory,
    repository,
    quarantineId: () => "unused-quarantine-name",
  });

  const pathNames = ["../secret.txt", "folder/secret.txt", "folder\\secret.txt", "C:secret.txt"];
  for (const [index, originalName] of pathNames.entries()) {
    await assert.rejects(
      store.ingest({
        artifactId: `art_0198d95f-6c00-7000-8000-${String(832 + index).padStart(12, "0")}`,
        actor: OWNER,
        originalName,
        declaredContentType: "text/plain",
        expectedSha256: "b2a7d72c4486981563921cca03d7c72756f0c4d1bff2f07d2773dee696260fda",
        content: Readable.from([Buffer.from("M10 exact bytes\n")]),
      }),
      (error: unknown) => error instanceof ArtifactError && error.code === "invalid_filename",
      originalName,
    );
  }
  assert.equal(repository.size, 0);
});

test("a digest-path symlink is rejected without reading or publishing through it", async (t) => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "home23-m10-symlink-root-"));
  const outsideDirectory = await mkdtemp(join(tmpdir(), "home23-m10-symlink-outside-"));
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));
  t.after(() => rm(outsideDirectory, { recursive: true, force: true }));
  const { ArtifactError, LocalArtifactStore } = await import(
    "../../../src/coordination/artifacts/index.js"
  );
  const repository = new MemoryArtifactRepository();
  const store = await LocalArtifactStore.open({
    rootDirectory,
    repository,
    quarantineId: () => "quarantine-symlink",
  });
  const artifactId = "art_0198d95f-6c00-7000-8000-000000000871";
  const sha256 = "b2a7d72c4486981563921cca03d7c72756f0c4d1bff2f07d2773dee696260fda";
  const outsideFile = join(outsideDirectory, "private.txt");
  const canonicalParent = join(
    rootDirectory,
    "objects",
    "sha256",
    sha256.slice(0, 2),
    sha256.slice(2, 4),
  );
  await writeFile(outsideFile, "M10 exact bytes\n", { mode: 0o600 });
  await mkdir(canonicalParent, { recursive: true, mode: 0o700 });
  await symlink(outsideFile, join(canonicalParent, sha256));

  await assert.rejects(
    store.ingest({
      artifactId,
      actor: OWNER,
      originalName: "symlink.txt",
      declaredContentType: "text/plain",
      expectedSha256: sha256,
      content: Readable.from([Buffer.from("M10 exact bytes\n")]),
    }),
    (error: unknown) => error instanceof ArtifactError && error.code === "storage_integrity",
  );
  assert.equal(repository.record(artifactId)?.state, "failed");
  assert.equal(await readFile(outsideFile, "utf8"), "M10 exact bytes\n");
});

test("a caller digest mismatch fails closed and leaves no canonical bytes", async (t) => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "home23-m10-digest-"));
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));
  const { ArtifactError, LocalArtifactStore } = await import(
    "../../../src/coordination/artifacts/index.js"
  );
  const artifactId = "art_0198d95f-6c00-7000-8000-000000000841";
  const repository = new MemoryArtifactRepository();
  const store = await LocalArtifactStore.open({
    rootDirectory,
    repository,
    quarantineId: () => "quarantine-digest",
  });

  await assert.rejects(
    store.ingest({
      artifactId,
      actor: OWNER,
      originalName: "digest.txt",
      declaredContentType: "text/plain",
      expectedSha256: "0".repeat(64),
      content: Readable.from([Buffer.from("digest mismatch")]),
    }),
    (error: unknown) => error instanceof ArtifactError && error.code === "digest_mismatch",
  );
  assert.equal(repository.record(artifactId)?.state, "failed");
  assert.deepEqual(await readdir(join(rootDirectory, "quarantine")), []);
  assert.deepEqual(await readdir(join(rootDirectory, "objects"), { recursive: true }), ["sha256"]);
});

test("an unlinked draft fails closed at its deadline and expires through an event-capable retention port", async (t) => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "home23-m10-expiry-"));
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));
  const artifacts = await import("../../../src/coordination/artifacts/index.js");
  const repository = new MemoryArtifactRepository();
  let observedAt = new Date("2026-08-25T15:00:00.000Z");
  const store = await artifacts.LocalArtifactStore.open({
    rootDirectory,
    repository,
    now: () => observedAt,
    quarantineId: () => "quarantine-expiry",
  });
  const bytes = Buffer.from("expires exactly once\n");
  const sha256 = "93f9d9b992d949fd371f1ccfc350fa4e1a7162700bb49470161c5b3a5c41718b";
  const artifactId = "art_0198d95f-6c00-7000-8000-000000000890";
  await store.ingest({
    artifactId,
    actor: OWNER,
    originalName: "draft.txt",
    declaredContentType: "text/plain",
    expectedSha256: sha256,
    content: Readable.from([bytes]),
  });

  observedAt = new Date("2026-08-26T15:00:00.000Z");
  await assert.rejects(
    store.openDownload({ artifactId, actor: OWNER }),
    (error: unknown) =>
      error instanceof artifacts.ArtifactError && error.code === "not_found",
  );
  const report = await store.expireDueDrafts({ actor: OWNER, limit: 10 });
  assert.deepEqual(report, {
    observedAt: observedAt.toISOString(),
    expiredArtifactIds: [artifactId],
  });
  assert.equal(repository.record(artifactId)?.state, "expired");

  const gc = await store.collectGarbage({ dryRun: true });
  assert.deepEqual(gc.candidates.map((candidate) => candidate.digest), [sha256]);
});

test("orphan garbage-collection dry run reports the digest without deleting or quarantining bytes", async (t) => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "home23-m10-gc-dry-run-"));
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));
  const { LocalArtifactStore } = await import("../../../src/coordination/artifacts/index.js");
  const artifactId = "art_0198d95f-6c00-7000-8000-000000000891";
  const sha256 = "b2a7d72c4486981563921cca03d7c72756f0c4d1bff2f07d2773dee696260fda";
  const repository = new MemoryArtifactRepository();
  const store = await LocalArtifactStore.open({
    rootDirectory,
    repository,
    quarantineId: () => "quarantine-gc",
  });
  await store.ingest({
    artifactId,
    actor: OWNER,
    originalName: "orphan.txt",
    declaredContentType: "text/plain",
    expectedSha256: sha256,
    content: Readable.from([Buffer.from("M10 exact bytes\n")]),
  });
  repository.forget(artifactId);
  const canonicalObject = join(
    rootDirectory,
    "objects",
    "sha256",
    sha256.slice(0, 2),
    sha256.slice(2, 4),
    sha256,
  );

  const report = await store.collectGarbage({ dryRun: true });

  assert.deepEqual(report, {
    dryRun: true,
    planSha256: report.planSha256,
    mutated: false,
    candidateCount: 1,
    candidateBytes: 16,
    deferredRecentQuarantineCount: 0,
    deferredRecentQuarantineBytes: 0,
    candidates: [{
      kind: "canonical_orphan",
      digest: sha256,
      byteCount: 16,
      action: "would_quarantine",
    }],
  });
  assert.match(report.planSha256, /^[a-f0-9]{64}$/);
  await access(canonicalObject);
  assert.deepEqual(await readdir(join(rootDirectory, "quarantine")), []);
});

test("garbage-collection dry run inventories a crash-left quarantine stream without mutating it", async (t) => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "home23-m10-gc-upload-crash-"));
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));
  const { LocalArtifactStore } = await import("../../../src/coordination/artifacts/index.js");
  const store = await LocalArtifactStore.open({
    rootDirectory,
    repository: new MemoryArtifactRepository(),
    quarantineId: () => "quarantine-gc-crash",
  });
  const bytes = Buffer.from("partially streamed private bytes");
  const crashPath = join(
    rootDirectory,
    "quarantine",
    "art_0198d95f-6c00-7000-8000-000000000894.crashed.upload",
  );
  await writeFile(crashPath, bytes, { mode: 0o600 });
  const recent = await store.collectGarbage({ dryRun: true });
  assert.deepEqual({
    candidateCount: recent.candidateCount,
    deferredRecentQuarantineCount: recent.deferredRecentQuarantineCount,
    deferredRecentQuarantineBytes: recent.deferredRecentQuarantineBytes,
  }, {
    candidateCount: 0,
    deferredRecentQuarantineCount: 1,
    deferredRecentQuarantineBytes: bytes.length,
  });
  await utimes(crashPath, new Date(0), new Date(0));

  const report = await store.collectGarbage({ dryRun: true });

  assert.deepEqual(report.candidates, [{
    kind: "quarantine_orphan",
    digest: createHash("sha256").update(bytes).digest("hex"),
    byteCount: bytes.length,
    action: "would_quarantine",
  }]);
  assert.deepEqual(await readFile(crashPath), bytes);
  assert.deepEqual(await readdir(join(rootDirectory, "quarantine")), [
    "art_0198d95f-6c00-7000-8000-000000000894.crashed.upload",
  ]);
});

test("garbage collection accounts for one physical blob across crash-left hardlinks", async (t) => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "home23-m10-gc-hardlink-"));
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));
  const { LocalArtifactStore } = await import("../../../src/coordination/artifacts/index.js");
  const artifactId = "art_0198d95f-6c00-7000-8000-000000000895";
  const sha256 = "b2a7d72c4486981563921cca03d7c72756f0c4d1bff2f07d2773dee696260fda";
  const repository = new MemoryArtifactRepository();
  const store = await LocalArtifactStore.open({
    rootDirectory,
    repository,
    quarantineId: () => "gc-hardlink-destination",
  });
  await store.ingest({
    artifactId,
    actor: OWNER,
    originalName: "orphan.txt",
    declaredContentType: "text/plain",
    expectedSha256: sha256,
    content: Readable.from([Buffer.from("M10 exact bytes\n")]),
  });
  repository.forget(artifactId);
  const canonicalObject = join(
    rootDirectory,
    "objects",
    "sha256",
    sha256.slice(0, 2),
    sha256.slice(2, 4),
    sha256,
  );
  const crashPath = join(rootDirectory, "quarantine", `${artifactId}.crashed.upload`);
  await link(canonicalObject, crashPath);

  const dryRun = await store.collectGarbage({ dryRun: true });
  assert.equal(dryRun.candidateCount, 1);
  assert.equal(dryRun.candidateBytes, 16);

  const applied = await store.collectGarbage({
    dryRun: false,
    expectedPlanSha256: dryRun.planSha256,
  });
  assert.equal(applied.candidateCount, 1);
  await assert.rejects(access(canonicalObject), { code: "ENOENT" });
  await assert.rejects(access(crashPath), { code: "ENOENT" });
  assert.equal((await readdir(join(rootDirectory, "quarantine", "orphans"))).length, 1);
});

test("orphan collection quarantines an unreferenced object before any later deletion", async (t) => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "home23-m10-gc-quarantine-"));
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));
  const { LocalArtifactStore } = await import("../../../src/coordination/artifacts/index.js");
  const artifactId = "art_0198d95f-6c00-7000-8000-000000000892";
  const sha256 = "b2a7d72c4486981563921cca03d7c72756f0c4d1bff2f07d2773dee696260fda";
  const bytes = Buffer.from("M10 exact bytes\n");
  const repository = new MemoryArtifactRepository();
  let quarantineId = 0;
  const store = await LocalArtifactStore.open({
    rootDirectory,
    repository,
    quarantineId: () => `quarantine-gc-${++quarantineId}`,
  });
  await store.ingest({
    artifactId,
    actor: OWNER,
    originalName: "orphan.txt",
    declaredContentType: "text/plain",
    expectedSha256: sha256,
    content: Readable.from([bytes]),
  });
  repository.forget(artifactId);
  const canonicalObject = join(
    rootDirectory,
    "objects",
    "sha256",
    sha256.slice(0, 2),
    sha256.slice(2, 4),
    sha256,
  );

  await assert.rejects(
    store.collectGarbage({} as { dryRun: true }),
    (error: unknown) => error instanceof Error && error.message === "storage_conflict",
  );
  const dryRun = await store.collectGarbage({ dryRun: true });
  const report = await store.collectGarbage({
    dryRun: false,
    expectedPlanSha256: dryRun.planSha256,
  });

  assert.deepEqual(report, {
    dryRun: false,
    planSha256: dryRun.planSha256,
    mutated: true,
    candidateCount: 1,
    candidateBytes: 16,
    deferredRecentQuarantineCount: 0,
    deferredRecentQuarantineBytes: 0,
    candidates: [{
      kind: "canonical_orphan",
      digest: sha256,
      byteCount: 16,
      action: "quarantined",
    }],
  });
  await assert.rejects(access(canonicalObject), { code: "ENOENT" });
  const quarantined = await readdir(join(rootDirectory, "quarantine", "orphans"));
  assert.equal(quarantined.length, 1);
  assert.match(quarantined[0]!, new RegExp(`^${sha256}\\.`));
  assert.deepEqual(
    await readFile(join(rootDirectory, "quarantine", "orphans", quarantined[0]!)),
    bytes,
  );
});
