import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createBotDirectory,
  type GeneratedBotDirectoryIdKind,
} from "../../../src/coordination/bots/index.js";
import {
  createResidentCredential,
  type JsonValue,
} from "../../../src/coordination/resident-protocol/index.js";
import {
  ResidentUdsClient,
  ResidentUdsServer,
} from "../../../src/coordination/transport/uds/index.js";

import { TestBotDirectoryRepository } from "./test-repository.js";

const REQUEST_ID = "req_0198d95f-6c00-7000-8000-000000000071";
const CORRELATION_ID = "cor_0198d95f-6c00-7000-8000-000000000072";

test("an M05-authenticated UDS context preserves resident identity and event correlation", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "home23-m07-"));
  const socketPath = join(root, "resident.sock");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = new TestBotDirectoryRepository();
  const ids: Record<GeneratedBotDirectoryIdKind, string> = {
    bot: "bot_0198d95f-6c00-7000-8000-000000000073",
    alias: "alias_0198d95f-6c00-7000-8000-000000000074",
  };
  const directory = createBotDirectory({
    repository,
    idGenerator: (kind) => ids[kind],
    now: () => new Date("2026-08-25T18:00:00.000Z"),
    availabilityPolicy: { degradedAfterMs: 30_000, offlineAfterMs: 90_000 },
  });
  await directory.ensurePersistentBinding({
    residentBinding: "jerry",
    name: "Jerry",
    purpose: "Primary persistent household assistant.",
    continuingIdentity: true,
    durableMailbox: true,
    requiredCapabilities: ["messages"],
    aliases: [],
  }, {
    principalId: "user_owner",
    requestId: "req_0198d95f-6c00-7000-8000-000000000075",
    correlationId: "cor_0198d95f-6c00-7000-8000-000000000076",
  });

  const credential = createResidentCredential({
    rootKey: Buffer.alloc(32, 0x57),
    residentSlug: "jerry",
    role: "resident",
    instanceId: "resident-jerry-uds-1",
    keyVersion: 1,
  });
  const server = new ResidentUdsServer({
    socketPath,
    serverInstanceId: "coordination-kernel-m07-test",
    credentials: [credential],
    handleRequest: async (request, context) => {
      assert.equal(request.path, "/internal/v1/residents/register");
      const payload = request.payload as Record<string, JsonValue>;
      const result = await directory.registerResident({
        context,
        botBinding: String(payload.botBinding),
        protocolVersion: Number(payload.protocolVersion),
        capabilities: (payload.capabilities as string[]) ?? [],
      });
      return result as unknown as JsonValue;
    },
  });
  const client = new ResidentUdsClient({
    socketPath,
    serverInstanceId: "coordination-kernel-m07-test",
    credential,
  });
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.start();

  const response = await client.request({
    method: "POST",
    path: "/internal/v1/residents/register",
    payload: {
      botBinding: "jerry",
      protocolVersion: 1,
      capabilities: ["messages"],
    },
    requestId: REQUEST_ID,
    correlationId: CORRELATION_ID,
    deadlineAtMs: Date.now() + 2_000,
  });

  assert.equal((response.payload as Record<string, JsonValue>).botId, ids.bot);
  assert.deepEqual(repository.committedMutations.at(-1), {
    kind: "registration",
    requestId: REQUEST_ID,
    correlationId: CORRELATION_ID,
  });
  assert.equal(repository.bots.get(ids.bot)?.activeKeyVersion, 1);
});
