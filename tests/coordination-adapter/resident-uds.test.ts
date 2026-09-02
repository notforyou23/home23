import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ConversationHistory } from "../../src/agent/history.js";
import type { AgentLoop } from "../../src/agent/loop.js";
import { TurnStore } from "../../src/chat/turn-store.js";
import {
  residentFence,
  ResidentTurnUdsServer,
  ResidentUdsAgentPort,
} from "../../src/coordination-adapter/index.js";
import { createResidentCredential, ResidentProtocolError } from "../../src/coordination/resident-protocol/index.js";
import { ResidentUdsClient } from "../../src/coordination/transport/uds/index.js";

const REQUEST_ID = "req_0198d95f-6c00-7000-8000-0000000000c1";
const CORRELATION_ID = "cor_0198d95f-6c00-7000-8000-0000000000c2";
const RESUME_REQUEST_ID = "req_0198d95f-6c00-7000-8000-0000000000d1";
const RESUME_CORRELATION_ID = "cor_0198d95f-6c00-7000-8000-0000000000d2";

test("resident start renews transient connection attempts while the harness comes online", async () => {
  let startAttempts = 0;
  let eventAttempts = 0;
  const client = {
    async request(input: { path: string }) {
      if (input.path === "/internal/v1/turns/start") {
        startAttempts += 1;
        if (startAttempts < 3) {
          throw new ResidentProtocolError("connection_lost", "resident socket is not listening yet", { retryable: true });
        }
        return { payload: {
          turnId: "coord-wrk_0198d95f-6c00-7000-8000-0000000000e1",
          chatId: "coordination:test:startup",
          persistedAt: "2026-08-26T12:00:00.000Z",
        } };
      }
      if (input.path.endsWith("/events")) {
        eventAttempts += 1;
        if (eventAttempts === 1) {
          throw new ResidentProtocolError("request_rate_limited", "replay pacing window", { retryable: true });
        }
        return { payload: {
          turnId: "coord-wrk_0198d95f-6c00-7000-8000-0000000000e1",
          provider: "fixture",
          model: "fixture",
          reasoningEffort: null,
          event: null,
          terminal: {
            status: "complete",
            lastSeq: 0,
            endedAt: "2026-08-26T12:00:01.000Z",
            errorCode: null,
            errorMessage: null,
          },
        } };
      }
      return { payload: { text: "started after retry", model: "fixture", toolCallCount: 0, durationMs: 1 } };
    },
    async close() { return undefined; },
  } as unknown as ResidentUdsClient;
  const port = new ResidentUdsAgentPort({
    client,
    residentSlug: "jerry",
    deadlineMs: 25,
    startTimeoutMs: 1_000,
    retryDelayMs: 1,
  });
  const started = await port.runWithTurn("coordination:test:startup", "wait for the harness", {
    coordinationOrigin: {
      kind: "coordination",
      workId: "wrk_0198d95f-6c00-7000-8000-0000000000e1",
      attemptId: "att_0198d95f-6c00-7000-8000-0000000000e2",
      leaseId: "lea_0198d95f-6c00-7000-8000-0000000000e3",
      holderPrincipalId: "bot_0198d95f-6c00-7000-8000-0000000000e4",
      holderInstanceId: "home23-jerry-harness",
      authorityReference: "resident:jerry",
      fencingToken: 1,
      channelId: "chn_0198d95f-6c00-7000-8000-0000000000e5",
      originMessageId: "msg_0198d95f-6c00-7000-8000-0000000000e6",
      roundId: null,
    },
    coordinationRequest: {
      requestId: "req_0198d95f-6c00-7000-8000-0000000000e7",
      correlationId: "cor_0198d95f-6c00-7000-8000-0000000000e8",
    },
    turnSelection: { modelAlias: null, reasoningEffort: null },
    onDurableStart: () => undefined,
    onEvent: () => undefined,
  });

  assert.equal((await started.response).text, "started after retry");
  assert.equal(startAttempts, 3);
  assert.equal(eventAttempts, 2, "durable event replay must renew transient signed reads");
});

test("resident port rejects a Work bound to a different resident before transport", async () => {
  let requests = 0;
  const client = {
    async request() {
      requests += 1;
      throw new Error("transport must not be reached");
    },
    async close() { return undefined; },
  } as unknown as ResidentUdsClient;
  const port = new ResidentUdsAgentPort({ client, residentSlug: "jerry" });
  await assert.rejects(
    port.runWithTurn("coordination:test:wrong-resident", "do not route this", {
      coordinationOrigin: {
        kind: "coordination",
        workId: "wrk_0198d95f-6c00-7000-8000-0000000000a1",
        attemptId: "att_0198d95f-6c00-7000-8000-0000000000a2",
        leaseId: "lea_0198d95f-6c00-7000-8000-0000000000a3",
        holderPrincipalId: "bot_0198d95f-6c00-7000-8000-0000000000a4",
        holderInstanceId: "home23-forrest-harness",
        authorityReference: "resident:forrest",
        fencingToken: 1,
        channelId: "chn_0198d95f-6c00-7000-8000-0000000000a5",
        originMessageId: "msg_0198d95f-6c00-7000-8000-0000000000a6",
        roundId: null,
      },
      coordinationRequest: {
        requestId: "req_0198d95f-6c00-7000-8000-0000000000a7",
        correlationId: "cor_0198d95f-6c00-7000-8000-0000000000a8",
      },
      turnSelection: { modelAlias: null, reasoningEffort: null },
      onDurableStart: () => undefined,
      onEvent: () => undefined,
    }),
    /resident authority does not match/,
  );
  assert.equal(requests, 0);
});

test("resident UDS verifies canonical attachment bytes and gives AgentLoop image vision plus file path", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "home23-resident-attachment-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const attachmentRoot = join(root, "attachments");
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const path = join(
    attachmentRoot,
    "objects",
    "sha256",
    sha256.slice(0, 2),
    sha256.slice(2, 4),
    sha256,
  );
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, bytes, { mode: 0o400 });

  const history = new ConversationHistory(join(root, "conversations"), 400_000, "jerry");
  const store = new TurnStore(history);
  let capturedInstruction = "";
  let capturedMedia: Array<{ type: string; path: string; mimeType?: string; fileName?: string }> = [];
  let starts = 0;
  const agent: Pick<AgentLoop,
    "runWithTurn" | "stop" | "isRunning" | "getModel" | "getProvider" | "getReasoningEffort"> = {
    getModel: () => "fixture-model",
    getProvider: () => "fixture-provider",
    getReasoningEffort: () => "medium",
    async runWithTurn(chatId, instruction, options = {}) {
      starts += 1;
      capturedInstruction = instruction;
      capturedMedia = options.media ?? [];
      const turnId = options.turnId!;
      store.writeStart(chatId, turnId, "fixture-model", "fixture-provider", {
        coordination_origin: options.coordinationOrigin,
      });
      const response = new Promise<{
        text: string;
        model: string;
        toolCallCount: number;
        durationMs: number;
      }>((resolve) => {
        setTimeout(() => {
          history.append(chatId, [
            { role: "user", content: instruction },
            { role: "assistant", content: "saw canonical image" },
          ]);
          store.writeEnd(chatId, turnId, "complete", { last_seq: 0 });
          resolve({
            text: "saw canonical image",
            model: "fixture-model",
            toolCallCount: 0,
            durationMs: 1,
          });
        }, 10);
      });
      return {
        turnId,
        response,
      };
    },
    stop: () => ({ stopped: false, chatIds: [] }),
    isRunning: () => false,
  };
  const credential = createResidentCredential({
    rootKey: Buffer.alloc(32, 0x58),
    residentSlug: "jerry",
    role: "resident",
    instanceId: "home23-jerry-harness",
    keyVersion: 1,
  });
  const socketPath = join(root, "resident.sock");
  const server = new ResidentTurnUdsServer({
    socketPath,
    serverInstanceId: "home23-jerry-harness",
    credential,
    residentSlug: "jerry",
    agent,
    history,
    attachmentRoot,
  });
  await server.start();
  t.after(() => server.close());
  const client = new ResidentUdsClient({
    socketPath,
    serverInstanceId: "home23-jerry-harness",
    credential,
  });
  t.after(() => client.close());
  const port = new ResidentUdsAgentPort({ client, residentSlug: "jerry" });
  const origin = {
    kind: "coordination",
    workId: "wrk_0198d95f-6c00-7000-8000-0000000001a1",
    attemptId: "att_0198d95f-6c00-7000-8000-0000000001a2",
    leaseId: "lea_0198d95f-6c00-7000-8000-0000000001a3",
    holderPrincipalId: "bot_0198d95f-6c00-7000-8000-0000000001a4",
    holderInstanceId: "home23-jerry-harness",
    authorityReference: "resident:jerry",
    fencingToken: 1,
    channelId: "chn_0198d95f-6c00-7000-8000-0000000001a5",
    originMessageId: "msg_0198d95f-6c00-7000-8000-0000000001a6",
    roundId: null,
  } as const;
  const attachment = {
    artifactId: "art_0198d95f-6c00-7000-8000-0000000001a7",
    name: "photo.png",
    contentType: "image/png",
    byteCount: bytes.length,
    sha256,
    path,
  } as const;
  const run = await port.runWithTurn("coordination:test:attachment", "", {
    coordinationOrigin: origin,
    coordinationRequest: { requestId: REQUEST_ID, correlationId: CORRELATION_ID },
    turnSelection: { modelAlias: null, reasoningEffort: null },
    attachments: [attachment],
    onDurableStart: () => undefined,
    onEvent: () => undefined,
  });
  assert.equal((await run.response).text, "saw canonical image");
  assert.match(capturedInstruction, /\[Canonical user attachments\]/);
  assert.match(capturedInstruction, /photo\.png/);
  assert.match(capturedInstruction, new RegExp(sha256));
  assert.deepEqual(capturedMedia, [{
    type: "image",
    path: realpathSync(path),
    mimeType: "image/png",
    fileName: "photo.png",
  }]);
  assert.deepEqual(readFileSync(capturedMedia[0]!.path), bytes);
  assert.equal(starts, 1);

  const outsidePath = join(root, "outside.png");
  writeFileSync(outsidePath, bytes, { mode: 0o400 });
  await assert.rejects(
    port.runWithTurn("coordination:test:attachment-invalid", "inspect", {
      coordinationOrigin: {
        ...origin,
        workId: "wrk_0198d95f-6c00-7000-8000-0000000001b1",
        attemptId: "att_0198d95f-6c00-7000-8000-0000000001b2",
        leaseId: "lea_0198d95f-6c00-7000-8000-0000000001b3",
        originMessageId: "msg_0198d95f-6c00-7000-8000-0000000001b4",
      },
      coordinationRequest: { requestId: RESUME_REQUEST_ID, correlationId: RESUME_CORRELATION_ID },
      turnSelection: { modelAlias: null, reasoningEffort: null },
      attachments: [{ ...attachment, path: outsidePath }],
      onDurableStart: () => undefined,
      onEvent: () => undefined,
    }),
    (error: unknown) => error instanceof ResidentProtocolError && error.code === "request_invalid",
  );
  assert.equal(starts, 1, "invalid attachment paths must fail before AgentLoop starts");
});

test("resident UDS verifies generated images and completed recovery never reruns missing turns", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "home23-resident-generated-image-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspacePath = join(root, "workspace");
  let residentWorkspacePath = workspacePath;
  const generatedImagesRoot = join(workspacePath, "media", "generated-images");
  mkdirSync(generatedImagesRoot, { recursive: true });
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const imagePath = join(generatedImagesRoot, "answer.png");
  writeFileSync(imagePath, bytes, { mode: 0o400 });
  const browserScreenshotPath = join(root, "turn-temp", "web-screenshot.png");
  mkdirSync(join(root, "turn-temp"), { recursive: true });
  writeFileSync(browserScreenshotPath, bytes, { mode: 0o400 });

  const history = new ConversationHistory(join(root, "conversations"), 400_000, "jerry");
  const store = new TurnStore(history);
  let starts = 0;
  const agent: Pick<AgentLoop,
    "runWithTurn" | "stop" | "isRunning" | "getModel" | "getProvider" | "getReasoningEffort"> & {
      getWorkspacePath(): string;
    } = {
    getModel: () => "fixture-model",
    getProvider: () => "fixture-provider",
    getReasoningEffort: () => "medium",
    getWorkspacePath: () => residentWorkspacePath,
    async runWithTurn(chatId, instruction, options = {}) {
      starts += 1;
      const turnId = options.turnId!;
      store.writeStart(chatId, turnId, "fixture-model", "fixture-provider", {
        coordination_origin: options.coordinationOrigin,
      });
      const response = new Promise<{
        text: string;
        model: string;
        toolCallCount: number;
        durationMs: number;
        media: Array<{
          type: "image";
          path: string;
          caption: string;
          generatedBy?: "generate_image";
        }>;
      }>((resolve) => {
        setTimeout(() => {
          store.writeEvent(chatId, {
            type: "event",
            turn_id: turnId,
            seq: 1,
            ts: "2026-08-26T12:00:00.100Z",
            kind: "media",
            data: {
              type: "media",
              mediaType: "image",
              generatedBy: "generate_image",
              path: imagePath,
              mimeType: "image/png",
              fileName: "answer.png",
              byteCount: bytes.length,
              sha256,
              caption: "a generated answer",
              sourceEventType: "runtime.tool_media",
            },
          });
          store.writeEvent(chatId, {
            type: "event",
            turn_id: turnId,
            seq: 2,
            ts: "2026-08-26T12:00:00.110Z",
            kind: "media",
            data: {
              type: "media",
              mediaType: "image",
              path: browserScreenshotPath,
              mimeType: "image/png",
              fileName: "web-screenshot.png",
              byteCount: bytes.length,
              sha256,
              caption: "browser screenshot",
              sourceEventType: "runtime.tool_media",
            },
          });
          history.append(chatId, [
            { role: "user", content: instruction },
            { role: "assistant", content: "generated image ready" },
          ]);
          store.writeEnd(chatId, turnId, "complete", { last_seq: 2 });
          resolve({
            text: "generated image ready",
            model: "fixture-model",
            toolCallCount: 1,
            durationMs: 20,
            // Exercise the resident-side basename, MIME, size, and hash reconstruction
            // used when an older generator returns only its durable path.
            media: [
              {
                type: "image",
                generatedBy: "generate_image",
                path: imagePath,
                caption: "a generated answer",
              },
              {
                type: "image",
                path: browserScreenshotPath,
                caption: "browser screenshot",
              },
            ],
          });
        }, 20);
      });
      return { turnId, response };
    },
    stop: () => ({ stopped: false, chatIds: [] }),
    isRunning: () => false,
  };
  const credential = createResidentCredential({
    rootKey: Buffer.alloc(32, 0x59),
    residentSlug: "jerry",
    role: "resident",
    instanceId: "home23-jerry-harness",
    keyVersion: 1,
  });
  const socketPath = join(root, "resident.sock");
  const origin = {
    kind: "coordination",
    workId: "wrk_0198d95f-6c00-7000-8000-0000000002a1",
    attemptId: "att_0198d95f-6c00-7000-8000-0000000002a2",
    leaseId: "lea_0198d95f-6c00-7000-8000-0000000002a3",
    holderPrincipalId: "bot_0198d95f-6c00-7000-8000-0000000002a4",
    holderInstanceId: "home23-jerry-harness",
    authorityReference: "resident:jerry",
    fencingToken: 1,
    channelId: "chn_0198d95f-6c00-7000-8000-0000000002a5",
    originMessageId: "msg_0198d95f-6c00-7000-8000-0000000002a6",
    roundId: null,
  } as const;
  const expectedMedia = [{
    type: "image",
    generatedBy: "generate_image",
    path: realpathSync(imagePath),
    mimeType: "image/png",
    fileName: "answer.png",
    byteCount: bytes.length,
    sha256,
    caption: "a generated answer",
  }];

  const startServer = async () => {
    const server = new ResidentTurnUdsServer({
      socketPath,
      serverInstanceId: "home23-jerry-harness",
      credential,
      residentSlug: "jerry",
      agent,
      history,
    });
    await server.start();
    const client = new ResidentUdsClient({
      socketPath,
      serverInstanceId: "home23-jerry-harness",
      credential,
    });
    return { server, client, port: new ResidentUdsAgentPort({ client, residentSlug: "jerry" }) };
  };

  const first = await startServer();
  const live = await first.port.runWithTurn("coordination:test:generated-image", "make an image", {
    coordinationOrigin: origin,
    coordinationRequest: { requestId: REQUEST_ID, correlationId: CORRELATION_ID },
    turnSelection: { modelAlias: null, reasoningEffort: null },
    onDurableStart: () => undefined,
    onEvent: () => undefined,
  });
  assert.deepEqual((await live.response).media, expectedMedia);
  await first.client.close();
  await first.server.close();

  const restarted = await startServer();
  t.after(() => restarted.client.close());
  t.after(() => restarted.server.close());
  const recovered = await restarted.port.runWithTurn("coordination:test:generated-image", "make an image", {
    coordinationOrigin: origin,
    coordinationRequest: { requestId: RESUME_REQUEST_ID, correlationId: RESUME_CORRELATION_ID },
    turnSelection: { modelAlias: null, reasoningEffort: null },
    onDurableStart: () => undefined,
    onEvent: () => undefined,
  });
  assert.deepEqual((await recovered.response).media, expectedMedia);
  assert.equal(starts, 1, "post-restart recovery must not rerun the resident turn");

  const outsidePath = join(root, "outside.png");
  writeFileSync(outsidePath, bytes, { mode: 0o400 });
  const symlinkPath = join(generatedImagesRoot, "linked.png");
  symlinkSync(imagePath, symlinkPath);
  const escapedGeneratedRoot = join(root, "escaped-generated-images");
  mkdirSync(escapedGeneratedRoot, { recursive: true });
  const escapedImagePath = join(escapedGeneratedRoot, "escaped.png");
  writeFileSync(escapedImagePath, bytes, { mode: 0o400 });
  const symlinkedWorkspacePath = join(root, "symlinked-workspace");
  mkdirSync(join(symlinkedWorkspacePath, "media"), { recursive: true });
  symlinkSync(escapedGeneratedRoot, join(symlinkedWorkspacePath, "media", "generated-images"));
  const rejectedCases = [
    { suffix: "b", path: outsidePath, workspace: workspacePath },
    { suffix: "c", path: symlinkPath, workspace: workspacePath },
    { suffix: "d", path: escapedImagePath, workspace: symlinkedWorkspacePath },
  ] as const;
  for (const { suffix, path: rejectedPath, workspace } of rejectedCases) {
    residentWorkspacePath = workspace;
    const rejectedOrigin = {
      ...origin,
      workId: `wrk_0198d95f-6c00-7000-8000-0000000002${suffix}1`,
      attemptId: `att_0198d95f-6c00-7000-8000-0000000002${suffix}2`,
      leaseId: `lea_0198d95f-6c00-7000-8000-0000000002${suffix}3`,
      originMessageId: `msg_0198d95f-6c00-7000-8000-0000000002${suffix}4`,
    } as const;
    const rejectedTurnId = `coord-${rejectedOrigin.workId}`;
    const rejectedChatId = `coordination:test:generated-image-${suffix}`;
    store.writeStart(rejectedChatId, rejectedTurnId, "fixture-model", "fixture-provider", {
      coordination_origin: rejectedOrigin,
    });
    store.writeEvent(rejectedChatId, {
      type: "event",
      turn_id: rejectedTurnId,
      seq: 1,
      ts: "2026-08-26T12:00:00.100Z",
      kind: "media",
      data: {
        type: "media",
        mediaType: "image",
        generatedBy: "generate_image",
        path: rejectedPath,
      },
    });
    history.append(rejectedChatId, [{ role: "assistant", content: "must not escape" }]);
    store.writeEnd(rejectedChatId, rejectedTurnId, "complete", { last_seq: 1 });
    const rejected = await restarted.port.runWithTurn(rejectedChatId, "recover", {
      coordinationOrigin: rejectedOrigin,
      coordinationRequest: {
        requestId: `req_0198d95f-6c00-7000-8000-0000000002${suffix}5`,
        correlationId: `cor_0198d95f-6c00-7000-8000-0000000002${suffix}6`,
      },
      turnSelection: { modelAlias: null, reasoningEffort: null },
      onDurableStart: () => undefined,
      onEvent: () => undefined,
    });
    await assert.rejects(
      rejected.response,
      (error: unknown) => error instanceof ResidentProtocolError && error.code === "request_invalid",
    );
  }
  residentWorkspacePath = workspacePath;

  const assertIncompleteRecoveryIsReadOnly = async (
    suffix: "e" | "f",
    durableStart: boolean,
  ) => {
    const incompleteOrigin = {
      ...origin,
      workId: `wrk_0198d95f-6c00-7000-8000-0000000002${suffix}1`,
      attemptId: `att_0198d95f-6c00-7000-8000-0000000002${suffix}2`,
      leaseId: `lea_0198d95f-6c00-7000-8000-0000000002${suffix}3`,
      originMessageId: `msg_0198d95f-6c00-7000-8000-0000000002${suffix}4`,
    } as const;
    const incompleteChatId = `coordination:test:completed-recovery-${suffix}`;
    if (durableStart) {
      store.writeStart(
        incompleteChatId,
        `coord-${incompleteOrigin.workId}`,
        "fixture-model",
        "fixture-provider",
        { coordination_origin: incompleteOrigin },
      );
    }
    let durableStartCallbacks = 0;
    await assert.rejects(
      restarted.port.runWithTurn(incompleteChatId, "must not execute", {
        coordinationOrigin: incompleteOrigin,
        coordinationRequest: {
          requestId: `req_0198d95f-6c00-7000-8000-0000000002${suffix}5`,
          correlationId: `cor_0198d95f-6c00-7000-8000-0000000002${suffix}6`,
        },
        turnSelection: { modelAlias: null, reasoningEffort: null },
        completedRecovery: true,
        onDurableStart: () => { durableStartCallbacks += 1; },
        onEvent: () => undefined,
      }),
      (error: unknown) => error instanceof ResidentProtocolError && error.code === "request_invalid",
    );
    assert.equal(durableStartCallbacks, 0, "refused completed recovery must not announce a durable start");
    assert.equal(starts, 1, "refused completed recovery must not invoke AgentLoop");
  };
  await assertIncompleteRecoveryIsReadOnly("e", false);
  await assertIncompleteRecoveryIsReadOnly("f", true);

  rmSync(imagePath);
  const receiptRecovery = await restarted.port.runWithTurn(
    "coordination:test:generated-image",
    "make an image",
    {
      coordinationOrigin: origin,
      coordinationRequest: {
        requestId: "req_0198d95f-6c00-7000-8000-0000000002a7",
        correlationId: "cor_0198d95f-6c00-7000-8000-0000000002a8",
      },
      turnSelection: { modelAlias: null, reasoningEffort: null },
      completedRecovery: true,
      onDurableStart: () => undefined,
      onEvent: () => undefined,
    },
  );
  const recoveredWithoutStaging = await receiptRecovery.response;
  assert.equal(recoveredWithoutStaging.text, "generated image ready");
  assert.equal(recoveredWithoutStaging.media, undefined);
  assert.equal(starts, 1, "completed recovery must use the existing resident turn");
});

test("a durable stopped turn with a legacy terminal sequence completes recovery", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "home23-resident-stopped-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const history = new ConversationHistory(join(root, "conversations"), 400_000, "jerry");
  const store = new TurnStore(history);
  const chatId = "coordination:test:stopped";
  const origin = {
    kind: "coordination",
    workId: "wrk_0198d95f-6c00-7000-8000-000000000101",
    attemptId: "att_0198d95f-6c00-7000-8000-000000000102",
    leaseId: "lea_0198d95f-6c00-7000-8000-000000000103",
    holderPrincipalId: "bot_0198d95f-6c00-7000-8000-000000000104",
    holderInstanceId: "home23-jerry-harness",
    authorityReference: "resident:jerry",
    fencingToken: 1,
    channelId: "chn_0198d95f-6c00-7000-8000-000000000105",
    originMessageId: "msg_0198d95f-6c00-7000-8000-000000000106",
    roundId: "rnd_0198d95f-6c00-7000-8000-000000000107",
  } as const;
  const turnId = `coord-${origin.workId}`;
  const agent: Pick<AgentLoop,
    "runWithTurn" | "stop" | "isRunning" | "getModel" | "getProvider" | "getReasoningEffort"> = {
    getModel: () => "fixture-model",
    getProvider: () => "fixture-provider",
    getReasoningEffort: () => "medium",
    async runWithTurn(startChatId, _instruction, options = {}) {
      store.writeStart(startChatId, options.turnId ?? turnId, "fixture-model", "fixture-provider", {
        coordination_origin: options.coordinationOrigin,
      });
      return {
        turnId: options.turnId ?? turnId,
        response: new Promise(() => undefined),
      };
    },
    stop: () => ({ stopped: false, chatIds: [] }),
    isRunning: () => true,
  };
  const credential = createResidentCredential({
    rootKey: Buffer.alloc(32, 0x57),
    residentSlug: "jerry",
    role: "resident",
    instanceId: "home23-jerry-harness",
    keyVersion: 1,
  });
  const socketPath = join(root, "resident.sock");
  const server = new ResidentTurnUdsServer({
    socketPath,
    serverInstanceId: "home23-jerry-harness",
    credential,
    residentSlug: "jerry",
    agent,
    history,
  });
  await server.start();
  t.after(() => server.close());
  const client = new ResidentUdsClient({
    socketPath,
    serverInstanceId: "home23-jerry-harness",
    credential,
  });
  t.after(() => client.close());
  await client.request({
    method: "POST",
    path: "/internal/v1/turns/start",
    payload: {
      chatId,
      instruction: "this response remains unresolved in memory",
      turnId,
      origin,
      correlationId: CORRELATION_ID,
      turnSelection: { modelAlias: null, reasoningEffort: null },
    },
    deadlineAtMs: Date.now() + 1_000,
    fence: residentFence(origin),
    correlationId: CORRELATION_ID,
  });
  store.writeEvent(chatId, {
    type: "event",
    turn_id: turnId,
    seq: 1,
    ts: "2026-08-26T12:00:00.100Z",
    kind: "status",
    data: { type: "status", status: "working", sourceEventType: "runtime.status" },
  });
  store.writeEnd(chatId, turnId, "stopped", {
    // Legacy stopped journals could omit last_seq; the old protocol fallback
    // exposed that as zero even when durable events existed.
    last_seq: 0,
    stop_reason: "owner_stop",
  });

  await assert.rejects(
    client.request({
      method: "GET",
      path: `/internal/v1/turns/${encodeURIComponent(turnId)}/result`,
      payload: { chatId, origin, correlationId: CORRELATION_ID },
      deadlineAtMs: Date.now() + 1_000,
      fence: residentFence(origin),
      correlationId: CORRELATION_ID,
    }),
    (error: unknown) =>
      error instanceof ResidentProtocolError &&
      error.code === "internal_error" &&
      error.retryable === false &&
      /ended stopped/.test(error.message),
  );

  const port = new ResidentUdsAgentPort({
    client,
    residentSlug: "jerry",
    deadlineMs: 100,
    resultTimeoutMs: 1_000,
    retryDelayMs: 1,
  });
  const replayedEvents: number[] = [];
  const recovered = await port.runWithTurn(chatId, "recover the stopped turn", {
    coordinationOrigin: origin,
    coordinationRequest: {
      requestId: RESUME_REQUEST_ID,
      correlationId: RESUME_CORRELATION_ID,
    },
    turnSelection: { modelAlias: null, reasoningEffort: null },
    onDurableStart: () => undefined,
    onEvent: (event) => { replayedEvents.push(event.sequence); },
  });
  await assert.rejects(
    recovered.response,
    (error: unknown) =>
      error instanceof ResidentProtocolError &&
      error.code === "internal_error" &&
      error.retryable === false &&
      /ended stopped/.test(error.message),
  );
  assert.deepEqual(replayedEvents, [1]);
  assert.deepEqual(await recovered.terminal, {
    status: "stopped",
    lastSequence: 1,
    endedAt: store.finalEnvelope(chatId, turnId)?.ended_at,
    errorCode: null,
    errorMessage: null,
    provider: "fixture-provider",
    model: "fixture-model",
    reasoningEffort: null,
  });
});

test("resident result retrieval outlives individual signed request windows", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "home23-resident-result-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const history = new ConversationHistory(join(root, "conversations"), 400_000, "jerry");
  const store = new TurnStore(history);
  let running = false;
  let agentStarts = 0;
  let selectedRuntime: unknown;
  const largeExactResult = `exact-large-result:${"x".repeat(300_000)}`;
  const agent: Pick<AgentLoop,
    "runWithTurn" | "stop" | "isRunning" | "getModel" | "getProvider" | "getReasoningEffort"> & {
      toolContext: { modelAliases: Record<string, { provider: string; model: string; reasoningEffort: "high" }> };
    } = {
    toolContext: {
      modelAliases: {
        sol: { provider: "openai-codex", model: "gpt-5.6-sol", reasoningEffort: "high" },
      },
    },
    getModel: () => "gpt-5.6-terra",
    getProvider: () => "openai-codex",
    getReasoningEffort: () => "medium",
    async runWithTurn(chatId, userText, options = {}) {
      agentStarts += 1;
      selectedRuntime = {
        modelOverride: options.modelOverride,
        effort: options.effort,
      };
      const turnId = options.turnId ?? "turn-delayed";
      store.writeStart(
        chatId,
        turnId,
        options.modelOverride?.model ?? "gpt-5.6-terra",
        options.modelOverride?.provider ?? "openai-codex",
        {
        reasoning_effort: options.effort ?? "medium",
        coordination_origin: options.coordinationOrigin,
      });
      running = true;
      const response = new Promise<{ text: string; model: string; toolCallCount: number; durationMs: number }>((resolve) => {
        setTimeout(() => {
          store.writeEvent(chatId, {
            type: "event",
            turn_id: turnId,
            seq: 1,
            ts: "2026-08-26T12:00:00.100Z",
            kind: "status",
            data: { type: "status", status: "working", sourceEventType: "runtime.status" },
          });
          store.writeEvent(chatId, {
            type: "event",
            turn_id: turnId,
            seq: 2,
            ts: "2026-08-26T12:00:00.200Z",
            kind: "tool_result",
            data: {
              type: "tool_result",
              tool: "fixture_tool",
              toolCallId: "call-large-1",
              result: "exact-large-result preview",
              exactResult: largeExactResult,
              success: true,
              sourceEventType: "runtime.tool_result",
            },
          });
          history.append(chatId, [
            { role: "user", content: userText },
            { role: "assistant", content: "delayed resident result" },
          ]);
          store.writeEnd(chatId, turnId, "complete", { last_seq: 2 });
          running = false;
          resolve({ text: "delayed resident result", model: "fixture-model", toolCallCount: 0, durationMs: 350 });
        }, 350);
      });
      return { turnId, response };
    },
    stop() { return { stopped: false, chatIds: [] }; },
    isRunning() { return running; },
  };
  const credential = createResidentCredential({
    rootKey: Buffer.alloc(32, 0x55),
    residentSlug: "jerry",
    role: "resident",
    instanceId: "home23-jerry-harness",
    keyVersion: 1,
  });
  const socketPath = join(root, "resident.sock");
  const server = new ResidentTurnUdsServer({
    socketPath,
    serverInstanceId: "home23-jerry-harness",
    credential,
    residentSlug: "jerry",
    agent,
    history,
  });
  await server.start();
  t.after(() => server.close());
  const client = new ResidentUdsClient({
    socketPath,
    serverInstanceId: "home23-jerry-harness",
    credential,
  });
  t.after(() => client.close());
  const port = new ResidentUdsAgentPort({ client, residentSlug: "jerry", deadlineMs: 25 });
  assert.deepEqual(await port.modelCatalog({ requestId: REQUEST_ID, correlationId: CORRELATION_ID }), {
    capabilities: ["attachments", "messages"],
    models: [{ alias: "sol", provider: "openai-codex", model: "gpt-5.6-sol", reasoningEffort: "high" }],
    defaultModel: "gpt-5.6-terra",
    defaultProvider: "openai-codex",
    defaultReasoningEffort: "medium",
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
  });
  let durableStart = false;
  const coordinationOrigin = {
      kind: "coordination",
      workId: "wrk_0198d95f-6c00-7000-8000-0000000000c3",
      attemptId: "att_0198d95f-6c00-7000-8000-0000000000c4",
      leaseId: "lea_0198d95f-6c00-7000-8000-0000000000c5",
      holderPrincipalId: "bot_0198d95f-6c00-7000-8000-0000000000c6",
      holderInstanceId: "home23-jerry-harness",
      authorityReference: "resident:jerry",
      fencingToken: 1,
      channelId: "chn_0198d95f-6c00-7000-8000-0000000000c7",
      originMessageId: "msg_0198d95f-6c00-7000-8000-0000000000c8",
      roundId: null,
  } as const;
  const wrongResidentOrigin = {
    ...coordinationOrigin,
    workId: "wrk_0198d95f-6c00-7000-8000-0000000000b1",
    attemptId: "att_0198d95f-6c00-7000-8000-0000000000b2",
    leaseId: "lea_0198d95f-6c00-7000-8000-0000000000b3",
    holderInstanceId: "home23-forrest-harness",
    authorityReference: "resident:forrest",
  } as const;
  const wrongResidentCorrelationId = "cor_0198d95f-6c00-7000-8000-0000000000b4";
  await assert.rejects(
    client.request({
      method: "POST",
      path: "/internal/v1/turns/start",
      payload: {
        chatId: "coordination:test:wrong-harness",
        instruction: "do not route this",
        turnId: `coord-${wrongResidentOrigin.workId}`,
        origin: wrongResidentOrigin,
        correlationId: wrongResidentCorrelationId,
      },
      deadlineAtMs: Date.now() + 1_000,
      fence: residentFence(wrongResidentOrigin),
      correlationId: wrongResidentCorrelationId,
    }),
    (error: unknown) => error instanceof ResidentProtocolError && error.code === "fence_invalid",
  );
  assert.equal(agentStarts, 0, "the resident harness must reject a different resident binding");
  const unavailableOrigin = {
    ...coordinationOrigin,
    workId: "wrk_0198d95f-6c00-7000-8000-0000000000d3",
    attemptId: "att_0198d95f-6c00-7000-8000-0000000000d4",
    leaseId: "lea_0198d95f-6c00-7000-8000-0000000000d5",
  } as const;
  await assert.rejects(
    port.runWithTurn("coordination:test:unavailable-model", "reject before running", {
      coordinationOrigin: unavailableOrigin,
      coordinationRequest: {
        requestId: "req_0198d95f-6c00-7000-8000-0000000000d6",
        correlationId: "cor_0198d95f-6c00-7000-8000-0000000000d7",
      },
      turnSelection: { modelAlias: "missing-alias", reasoningEffort: "high" },
      onDurableStart: () => assert.fail("an unavailable model cannot start durably"),
      onEvent: () => undefined,
    }),
    (error: unknown) => error instanceof ResidentProtocolError && error.code === "request_invalid",
  );
  assert.equal(agentStarts, 0, "an unavailable selection must not enter AgentLoop");
  const firstEvents: Array<Parameters<NonNullable<Parameters<typeof port.runWithTurn>[2]["onEvent"]>>[0]> = [];
  const started = await port.runWithTurn("coordination:test:work", "answer after a normal model delay", {
    coordinationOrigin,
    coordinationRequest: { requestId: REQUEST_ID, correlationId: CORRELATION_ID },
    turnSelection: { modelAlias: "sol", reasoningEffort: "xhigh" },
    onDurableStart: () => { durableStart = true; },
    onEvent: (event) => { firstEvents.push(event); },
  });

  assert.equal(durableStart, true);
  const resumedClient = new ResidentUdsClient({
    socketPath,
    serverInstanceId: "home23-jerry-harness",
    credential,
  });
  t.after(() => resumedClient.close());
  const resumedPort = new ResidentUdsAgentPort({
    client: resumedClient,
    residentSlug: "jerry",
    deadlineMs: 25,
  });
  let resumedDurableStart = false;
  const resumedEvents: typeof firstEvents = [];
  const resumed = await resumedPort.runWithTurn(
    "coordination:test:work",
    "answer after a normal model delay",
    {
      coordinationOrigin,
      coordinationRequest: { requestId: RESUME_REQUEST_ID, correlationId: RESUME_CORRELATION_ID },
      turnSelection: { modelAlias: "sol", reasoningEffort: "xhigh" },
      onDurableStart: () => { resumedDurableStart = true; },
      onEvent: (event) => { resumedEvents.push(event); },
    },
  );

  const alteredOrigin = {
    ...coordinationOrigin,
    attemptId: "att_0198d95f-6c00-7000-8000-0000000000ff",
  } as const;
  const alteredCorrelationId = "cor_0198d95f-6c00-7000-8000-0000000000fe";
  const rejectsAlteredOrigin = (error: unknown) =>
    error instanceof ResidentProtocolError && error.code === "fence_invalid";
  await assert.rejects(
    resumedClient.request({
      method: "POST",
      path: "/internal/v1/turns/start",
      payload: {
        chatId: "coordination:test:work",
        instruction: "answer after a normal model delay",
        turnId: `coord-${coordinationOrigin.workId}`,
        origin: alteredOrigin,
        correlationId: alteredCorrelationId,
      },
      deadlineAtMs: Date.now() + 1_000,
      fence: residentFence(alteredOrigin),
      correlationId: alteredCorrelationId,
    }),
    rejectsAlteredOrigin,
  );
  await assert.rejects(
    resumedClient.request({
      method: "POST",
      path: "/internal/v1/turns/start",
      payload: {
        chatId: "coordination:test:work",
        instruction: "answer after a normal model delay",
        turnId: "coord-wrk_0198d95f-6c00-7000-8000-000000000000",
        origin: coordinationOrigin,
        correlationId: alteredCorrelationId,
      },
      deadlineAtMs: Date.now() + 1_000,
      fence: residentFence(coordinationOrigin),
      correlationId: alteredCorrelationId,
    }),
    rejectsAlteredOrigin,
  );
  await assert.rejects(
    resumedClient.request({
      method: "GET",
      path: `/internal/v1/turns/${encodeURIComponent(`coord-${coordinationOrigin.workId}`)}/result`,
      payload: {
        chatId: "coordination:test:work",
        origin: alteredOrigin,
        correlationId: alteredCorrelationId,
      },
      deadlineAtMs: Date.now() + 1_000,
      fence: residentFence(alteredOrigin),
      correlationId: alteredCorrelationId,
    }),
    rejectsAlteredOrigin,
  );

  const [firstResult, resumedResult] = await Promise.all([started.response, resumed.response]);
  assert.equal(resumedDurableStart, true);
  assert.equal(firstResult.text, "delayed resident result");
  assert.equal(resumedResult.text, "delayed resident result");
  const exactSelection = {
    requestedProvider: null,
    requestedModelAlias: "sol",
    requestedModel: null,
    requestedEffort: "xhigh",
    resolvedProvider: "openai-codex",
    resolvedModel: "gpt-5.6-sol",
    resolvedEffort: "xhigh",
    actualProvider: "openai-codex",
    actualModel: "gpt-5.6-sol",
    actualEffort: "xhigh",
  };
  assert.deepEqual(started.selection, exactSelection);
  assert.deepEqual(resumed.selection, exactSelection);
  assert.deepEqual(selectedRuntime, {
    modelOverride: { provider: "openai-codex", model: "gpt-5.6-sol", reasoningEffort: "high" },
    effort: "xhigh",
  });
  assert.equal(agentStarts, 1, "coordinator reattachment must not start a second resident turn");
  assert.deepEqual(firstEvents, resumedEvents, "reattachment must replay the same durable evidence");
  assert.deepEqual(firstEvents.map((event) => event.sequence), [1, 2]);
  assert.equal(firstEvents[0]?.event.type, "status");
  assert.equal(firstEvents[1]?.event.type, "tool_result");
  if (firstEvents[1]?.event.type !== "tool_result") assert.fail("large tool result required");
  assert.equal(firstEvents[1].event.toolCallId, "call-large-1");
  assert.equal(firstEvents[1].event.exactResult, largeExactResult,
    "a record larger than the UDS frame limit must survive chunk replay exactly");
  const firstTerminal = await started.terminal;
  const resumedTerminal = await resumed.terminal;
  assert.ok(firstTerminal);
  assert.deepEqual(firstTerminal, resumedTerminal,
    "reattachment must preserve the resident-owned terminal timestamp and identity");
  assert.equal(firstTerminal?.lastSequence, 2);
  assert.equal(firstTerminal?.status, "complete");

  const completedClient = new ResidentUdsClient({
    socketPath,
    serverInstanceId: "home23-jerry-harness",
    credential,
  });
  t.after(() => completedClient.close());
  const completedPort = new ResidentUdsAgentPort({
    client: completedClient,
    residentSlug: "jerry",
    deadlineMs: 25,
  });
  const completed = await completedPort.runWithTurn(
    "coordination:test:work",
    "answer after a normal model delay",
    {
      coordinationOrigin,
      coordinationRequest: {
        requestId: "req_0198d95f-6c00-7000-8000-0000000000f1",
        correlationId: "cor_0198d95f-6c00-7000-8000-0000000000f2",
      },
      turnSelection: { modelAlias: "sol", reasoningEffort: "xhigh" },
      onDurableStart: () => undefined,
      onEvent: () => undefined,
    },
  );
  assert.equal((await completed.response).text, "delayed resident result");
  assert.deepEqual(completed.selection, exactSelection,
    "a post-terminal resident reattachment must recover the exact selection proof");
  assert.equal(agentStarts, 1);
});
