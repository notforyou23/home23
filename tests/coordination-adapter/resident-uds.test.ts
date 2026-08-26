import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
    onDurableStart: () => undefined,
    onEvent: () => undefined,
  });

  assert.equal((await started.response).text, "started after retry");
  assert.equal(startAttempts, 3);
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
      onDurableStart: () => undefined,
      onEvent: () => undefined,
    }),
    /resident authority does not match/,
  );
  assert.equal(requests, 0);
});

test("resident result retrieval outlives individual signed request windows", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "home23-resident-result-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const history = new ConversationHistory(join(root, "conversations"), 400_000, "jerry");
  const store = new TurnStore(history);
  let running = false;
  let agentStarts = 0;
  const agent: Pick<AgentLoop, "runWithTurn" | "stop" | "isRunning"> = {
    async runWithTurn(chatId, userText, options = {}) {
      agentStarts += 1;
      const turnId = options.turnId ?? "turn-delayed";
      store.writeStart(chatId, turnId, "fixture-model", "fixture", {
        coordination_origin: options.coordinationOrigin,
      });
      running = true;
      const response = new Promise<{ text: string; model: string; toolCallCount: number; durationMs: number }>((resolve) => {
        setTimeout(() => {
          history.append(chatId, [
            { role: "user", content: userText },
            { role: "assistant", content: "delayed resident result" },
          ]);
          store.writeEnd(chatId, turnId, "complete", { last_seq: 0 });
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
  const started = await port.runWithTurn("coordination:test:work", "answer after a normal model delay", {
    coordinationOrigin,
    coordinationRequest: { requestId: REQUEST_ID, correlationId: CORRELATION_ID },
    onDurableStart: () => { durableStart = true; },
    onEvent: () => undefined,
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
  const resumed = await resumedPort.runWithTurn(
    "coordination:test:work",
    "answer after a normal model delay",
    {
      coordinationOrigin,
      coordinationRequest: { requestId: RESUME_REQUEST_ID, correlationId: RESUME_CORRELATION_ID },
      onDurableStart: () => { resumedDurableStart = true; },
      onEvent: () => undefined,
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
  assert.equal(agentStarts, 1, "coordinator reattachment must not start a second resident turn");
});
