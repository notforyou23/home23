import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createHash,
  generateKeyPairSync,
  sign as signEd25519,
  type KeyObject,
} from "node:crypto";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { AgentLoop } from "../../../src/agent/loop.js";
import { ConversationHistory } from "../../../src/agent/history.js";
import { createAuthService, SqliteAuthRepository } from "../../../src/coordination/auth/index.js";
import { createBotDirectory, SqliteBotDirectoryRepository } from "../../../src/coordination/bots/index.js";
import { bootstrapJerry, executeM14AuthorityTransition } from "../../../src/coordination/operations/index.js";
import { runCoordinationProcess } from "../../../src/coordination/index.js";
import { openCoordinationDatabase } from "../../../src/coordination/db/index.js";
import { generateCoordinationId } from "../../../src/coordination/ids/index.js";
import { createCoordinationProcess, disabledCoordinationFeatureFlags } from "../../../src/coordination/app/index.js";
import { startResidentCoordinationHarness } from "../../../src/coordination-adapter/index.js";
import { createChannelService, SqliteBotConversationBindingAdapter, SqliteMessagingRepository } from "../../../src/coordination/channels/index.js";
import { M11MessageProvenanceAuthority } from "../../../src/coordination/work/index.js";
import {
  COORDINATION_ACTIVITY_WRITER,
  COORDINATION_ATTACHMENTS_WRITER,
  COORDINATION_MESSAGES_WRITER,
  authorityReceiptSigningPayload,
  type AuthorityEpoch,
  type AuthorityRolloutReceipt,
  type UnsignedAuthorityRolloutReceipt,
} from "../../../src/coordination/epochs/index.js";
import { FEATURE_FLAG_REGISTRY } from "../../../src/coordination/schema/contract-registry.js";

const authority = { approved: true, kind: "m14-bootstrap", operator: "user_owner", resident: "jerry", legacyWriterAuthoritative: true, coordinationFlagsAllFalse: true } as const;
const verticalArtifactId = "art_0198d95f-6c00-7000-8000-000000000992";
const verticalArtifactBytes = Buffer.from("real resident attachment reference\n", "utf8");
const verticalArtifactSha256 = createHash("sha256").update(verticalArtifactBytes).digest("hex");

function actualAgent(root: string, resident = "jerry") {
  const history = new ConversationHistory(join(root, `conversations-${resident}`), 400_000, resident);
  const workspacePath = join(root, `workspace-${resident}`);
  mkdirSync(workspacePath, { recursive: true });
  const agent = new AgentLoop({ apiKey: "test", model: "fixture-local-model", provider: "ollama-local",
    registry: { getAnthropicTools: () => [], getOpenAITools: () => [], get: () => undefined, execute: async () => ({ content: "" }) } as never,
    contextManager: { getSystemPrompt: () => "fixture", getPromptSourceInfo: () => ({ loadedFiles: [] }) } as never,
    history,
    toolContext: {
      brainOperations: {
        searchContext: async () => ({
          results: [],
          sourceEvidence: { sourceHealth: "healthy", matchOutcome: "no_match" },
        }),
      },
    } as never,
    workspacePath });
  return { agent, history };
}

async function startLocalModelFixture() {
  const requests: Array<{ messages?: Array<{ role?: string; content?: unknown }> }> = [];
  const server: Server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof requests[number];
      requests.push(requestBody);
      const userContent = String(requestBody.messages?.findLast((message) => message.role === "user")?.content ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: userContent.includes("Forrest")
          ? "Canonical Forrest response."
          : "Canonical Jerry response." } }],
      }));
    } catch {
      response.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return Object.freeze({
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    calls: () => requests.length,
    requests: () => Object.freeze([...requests]),
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  });
}

async function accessToken(path: string, key: string) {
  const db = openCoordinationDatabase({ path });
  const service = createAuthService({ repository: new SqliteAuthRepository(db), keyMaterial: createHash("sha256").update("home23-coordination-auth-v1\0").update(key).digest(),
    admissionVerifier: { verifyLocalOperator: () => ({ allowed: true, network: "loopback", rateLimitKey: "op" }), verifyClient: () => ({ allowed: true, network: "loopback", rateLimitKey: "client" }) } });
  const mutation = (idempotencyKey: string) => ({ idempotencyKey, requestId: generateCoordinationId("request"), correlationId: generateCoordinationId("correlation") });
  const issued = await service.issuePairing({ deviceName: "vertical", operator: "loopback", mutation: mutation("vertical-pairing-issue") });
  const paired = await service.redeemPairing({ pairingSessionId: issued.pairingSession.id, pairingCode: issued.pairingCode, network: "loopback",
    device: { platform: "macos", name: "vertical", appBuild: "test" }, mutation: mutation("vertical-pairing-redeem") });
  db.close();
  return paired.accessToken;
}

function seedCanonicalProjectionAuthority(
  databasePath: string,
  capability: "attachments" | "activity",
  canonicalWriter: string,
) {
  const epochs: readonly AuthorityEpoch[] = [
    { capability, epoch: 1, mode: "legacy", writer: `legacy-${capability}-writer`, effectiveAtEventSequence: null, rollbackEpoch: null },
    { capability, epoch: 2, mode: "shadow", writer: `legacy-${capability}-writer`, effectiveAtEventSequence: null, rollbackEpoch: null },
    { capability, epoch: 3, mode: "canonical", writer: canonicalWriter, effectiveAtEventSequence: 0, rollbackEpoch: 1 },
  ];
  const database = openCoordinationDatabase({ path: databasePath });
  try {
    for (const epoch of epochs) {
      const currentSequence = database.readOne<{ sequence: number }>(
        "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events",
      )?.sequence ?? 0;
      const effectiveAtEventSequence = epoch.mode === "canonical"
        ? currentSequence
        : epoch.effectiveAtEventSequence;
      const createdAt = new Date(Date.UTC(2026, 7, 27, 19, 0, epoch.epoch)).toISOString();
      database.mutateWithEvent((transaction) => {
        transaction.run(
          `INSERT INTO authority_epochs (
             capability, epoch, mode, writer, effective_at_event_sequence,
             rollback_epoch, receipt_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          epoch.capability,
          epoch.epoch,
          epoch.mode,
          epoch.writer,
          effectiveAtEventSequence,
          epoch.rollbackEpoch,
          JSON.stringify({ kind: "isolated-production-vertical-fixture", epoch: epoch.epoch }),
          createdAt,
        );
        return {
          value: undefined,
          event: {
            type: "authority.epoch_changed",
            aggregateKind: "authorityEpoch",
            aggregateId: `authority:${capability}`,
            aggregateVersion: epoch.epoch,
            channelId: null,
            actorPrincipalId: "user_owner",
            requestId: generateCoordinationId("request"),
            correlationId: generateCoordinationId("correlation"),
            payload: {
              capability,
              epoch: epoch.epoch,
              writer: epoch.writer,
              mode: epoch.mode,
            },
            createdAt,
          },
        };
      });
    }
  } finally {
    database.close();
  }
}

function authoritySnapshot(databasePath: string) {
  const database = openCoordinationDatabase({ path: databasePath });
  try {
    return {
      eventSequence: database.readOne<{ sequence: number }>(
        "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events",
      )?.sequence ?? 0,
      messageCount: database.readOne<{ count: number }>(
        "SELECT count(*) AS count FROM messages",
      )?.count ?? 0,
    };
  } finally {
    database.close();
  }
}

function rolloutFlags(canonical: boolean): Record<string, boolean> {
  const flags = Object.fromEntries(
    Object.keys(FEATURE_FLAG_REGISTRY).map((name) => [name, false]),
  ) as Record<string, boolean>;
  if (canonical) {
    flags["coordination.process.enabled"] = true;
    flags["coordination.public_api.enabled"] = true;
    flags["coordination.resident.jerry.enabled"] = true;
  }
  return flags;
}

function signedAuthorityReceipt(input: {
  from: AuthorityEpoch;
  to: AuthorityEpoch;
  channelId: string;
  snapshot: { eventSequence: number; messageCount: number };
  privateKey: KeyObject;
  issuedAt: string;
}): AuthorityRolloutReceipt {
  const unsigned: UnsignedAuthorityRolloutReceipt = {
    receiptVersion: 1,
    capability: "messages",
    fromEpoch: input.from.epoch,
    toEpoch: input.to.epoch,
    fromAuthority: { mode: input.from.mode, writer: input.from.writer },
    toAuthority: { mode: input.to.mode, writer: input.to.writer },
    sourceWatermark: {
      sourceId: "legacy_0198d95f-6c00-7000-8000-000000000091",
      segmentIdentity: "isolated-production-vertical",
      recordIndex: input.snapshot.messageCount,
      byteOffset: 0,
      tailDigest: "1".repeat(64),
    },
    destinationWatermark: {
      eventSequence: input.snapshot.eventSequence,
      messageCount: input.snapshot.messageCount,
      orderedDigest: "2".repeat(64),
    },
    samePathCanary: {
      operationId: "listChannelMessages",
      route: `/api/v1/channels/${input.channelId}/messages`,
      requestDigest: "3".repeat(64),
      passed: true,
    },
    driftCount: 0,
    activeFlags: rolloutFlags(input.to.mode === "canonical"),
    rollbackTarget: input.to.rollbackEpoch,
    operator: "user_owner",
    effectiveAtEventSequence: input.to.effectiveAtEventSequence,
    legacyWriterDisposition: input.to.mode === "canonical"
      ? "disabled"
      : input.to.mode === "shadow"
        ? "unchanged_authoritative"
        : "restored_authoritative",
    issuedAt: input.issuedAt,
  };
  return {
    ...unsigned,
    signature: {
      algorithm: "ed25519",
      keyId: "isolated-m14-operator",
      value: signEd25519(
        null,
        Buffer.from(authorityReceiptSigningPayload(unsigned), "utf8"),
        input.privateKey,
      ).toString("base64"),
    },
  };
}

function applyAuthorityTransition(input: {
  databasePath: string;
  receipt: AuthorityRolloutReceipt;
  publicKey: KeyObject;
}) {
  return executeM14AuthorityTransition({
    databasePath: input.databasePath,
    receipt: input.receipt,
    publicKeyPem: input.publicKey.export({ format: "pem", type: "spki" }).toString(),
    activeCanonicalWriters: [],
    requestId: generateCoordinationId("request"),
    correlationId: generateCoordinationId("correlation"),
    apply: true,
    liveAuthorized: true,
  });
}

async function bootstrapForrestFixture(input: {
  databasePath: string;
  serverInstanceId: string;
  keyVersion: number;
}) {
  const database = openCoordinationDatabase({ path: input.databasePath });
  try {
    const repository = new SqliteBotDirectoryRepository(database);
    const directory = createBotDirectory({
      repository,
      availabilityPolicy: { degradedAfterMs: 30_000, offlineAfterMs: 120_000 },
    });
    const requestId = generateCoordinationId("request");
    const correlationId = generateCoordinationId("correlation");
    const bot = await directory.ensurePersistentBinding({
      residentBinding: "forrest",
      name: "Forrest",
      purpose: "Persistent Home23 resident",
      continuingIdentity: true,
      durableMailbox: true,
      requiredCapabilities: ["messages"],
      aliases: [{ namespace: "name", value: "Forrest" }],
    }, { principalId: "user_owner", requestId, correlationId });
    await directory.registerResident({
      context: {
        requestId,
        correlationId,
        credential: {
          residentSlug: "forrest",
          role: "resident",
          instanceId: input.serverInstanceId,
          keyVersion: input.keyVersion,
        },
      },
      botBinding: "forrest",
      protocolVersion: 1,
      capabilities: ["messages"],
    });
    const participantDirectory = Object.freeze({
      listVisibleBots: directory.listVisibleBots,
      resolveAlias: directory.resolveAlias,
      getBotByResidentBinding: (binding: string) => repository.getBotByResidentBinding(binding),
    });
    const messaging = new SqliteMessagingRepository(database, {
      botConversationBinding: new SqliteBotConversationBindingAdapter(),
      messageProvenanceAuthorization: new M11MessageProvenanceAuthority(),
    });
    const channels = createChannelService({
      repository: messaging,
      participantDirectory,
      cursorSigningKey: Buffer.alloc(32, 2),
    });
    const direct = await channels.createDirectConversation({
      context: {
        principalId: "user_owner",
        requestId,
        correlationId,
        identity: {
          kind: "owner",
          auth: {
            principalId: "user_owner",
            deviceId: generateCoordinationId("device"),
            sessionId: generateCoordinationId("clientSession"),
            scopes: ["product:read", "message:send"],
          },
        },
      },
      memberBotIds: [bot.id],
      pinned: true,
      idempotencyKey: "home23-m15-forrest-direct-bootstrap-v1",
    });
    return Object.freeze({
      botId: bot.id,
      channelId: direct.channel.id,
      conversationId: direct.channel.conversationId,
    });
  } finally {
    database.close();
  }
}

test("feature-off resident harness returns without creating its socket", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "home23-resident-off-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const { agent, history } = actualAgent(root); const socket = join(root, "resident.sock");
  assert.equal(await startResidentCoordinationHarness({ agent, history, environment: { HOME23_COORDINATION_RESIDENT_ENABLED: "false", HOME23_COORDINATION_RESIDENT_SOCKET_PATH: socket } }), null);
  assert.equal(existsSync(socket), false);
});

test("feature-off coordination opens no database, socket, or listener", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "home23-process-off-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = join(root, "instances", ".house", "coordination");
  const databasePath = join(runtime, "coordination.sqlite3"), socketPath = join(runtime, "coordination.sock");
  assert.equal(await runCoordinationProcess({ HOME23_ROOT: root, HOME23_COORDINATION_ENABLED: "false", HOME23_COORDINATION_DB_PATH: databasePath, HOME23_COORDINATION_SOCKET_PATH: socketPath }), "disabled");
  assert.equal(existsSync(runtime), false);
  assert.equal(existsSync(databasePath), false);
  assert.equal(existsSync(socketPath), false);
});

test("production composition dispatches Jerry and Forrest to distinct resident sockets", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "home23-production-dual-resident-"));
  const runtime = join(root, "instances", ".house", "coordination");
  mkdirSync(runtime, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const jerryModel = await startLocalModelFixture();
  const forrestModel = await startLocalModelFixture();
  t.after(() => Promise.all([jerryModel.close(), forrestModel.close()]));
  const priorEnvironment = {
    HOME23_ROOT: process.env.HOME23_ROOT,
    HOME23_AGENT: process.env.HOME23_AGENT,
    LOCAL_LLM_BASE_URL: process.env.LOCAL_LLM_BASE_URL,
  };
  process.env.HOME23_ROOT = root;
  t.after(() => {
    for (const [name, value] of Object.entries(priorEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const databasePath = join(runtime, "home23-coordination.sqlite3");
  const jerrySocketPath = join(root, "j.sock");
  const forrestSocketPath = join(root, "f.sock");
  const jerryKey = "7".repeat(64);
  const forrestKey = "8".repeat(64);
  const capabilityToken = "9".repeat(64);
  const jerry = await bootstrapJerry({
    databasePath,
    apply: true,
    authority,
    serverInstanceId: "home23-jerry-harness",
    keyVersion: 1,
  });
  const forrest = await bootstrapForrestFixture({
    databasePath,
    serverInstanceId: "home23-forrest-harness",
    keyVersion: 1,
  });
  const token = await accessToken(databasePath, capabilityToken);
  const operatorKeys = generateKeyPairSync("ed25519");
  const legacy: AuthorityEpoch = {
    capability: "messages",
    epoch: 1,
    mode: "legacy",
    writer: "legacy-conversation-writer",
    effectiveAtEventSequence: null,
    rollbackEpoch: null,
  };
  const shadow: AuthorityEpoch = { ...legacy, epoch: 2, mode: "shadow" };
  const shadowSnapshot = authoritySnapshot(databasePath);
  applyAuthorityTransition({
    databasePath,
    publicKey: operatorKeys.publicKey,
    receipt: signedAuthorityReceipt({
      from: legacy,
      to: shadow,
      channelId: jerry.channelId!,
      snapshot: shadowSnapshot,
      privateKey: operatorKeys.privateKey,
      issuedAt: "2026-08-26T12:10:00.000Z",
    }),
  });
  seedCanonicalProjectionAuthority(
    databasePath,
    "activity",
    COORDINATION_ACTIVITY_WRITER,
  );
  const canonicalSnapshot = authoritySnapshot(databasePath);
  const canonical: AuthorityEpoch = {
    capability: "messages",
    epoch: 3,
    mode: "canonical",
    writer: COORDINATION_MESSAGES_WRITER,
    effectiveAtEventSequence: canonicalSnapshot.eventSequence,
    rollbackEpoch: 1,
  };
  applyAuthorityTransition({
    databasePath,
    publicKey: operatorKeys.publicKey,
    receipt: signedAuthorityReceipt({
      from: shadow,
      to: canonical,
      channelId: jerry.channelId!,
      snapshot: canonicalSnapshot,
      privateKey: operatorKeys.privateKey,
      issuedAt: "2026-08-26T12:11:00.000Z",
    }),
  });

  process.env.HOME23_AGENT = "jerry";
  process.env.LOCAL_LLM_BASE_URL = jerryModel.baseUrl;
  const jerryRuntime = actualAgent(root, "jerry");
  process.env.HOME23_AGENT = "forrest";
  process.env.LOCAL_LLM_BASE_URL = forrestModel.baseUrl;
  const forrestRuntime = actualAgent(root, "forrest");
  const residentInvocations = { jerry: 0, forrest: 0 };
  const observedAgent = (
    resident: "jerry" | "forrest",
    agent: typeof jerryRuntime.agent,
  ) => ({
    runWithTurn: (...args: Parameters<typeof agent.runWithTurn>) => {
      residentInvocations[resident] += 1;
      return agent.runWithTurn(...args);
    },
    stop: (...args: Parameters<typeof agent.stop>) => agent.stop(...args),
    isRunning: (...args: Parameters<typeof agent.isRunning>) => agent.isRunning(...args),
  });
  const residentEnvironment = (
    slug: "jerry" | "forrest",
    socketPath: string,
    key: string,
  ) => ({
    HOME23_COORDINATION_RESIDENT_ENABLED: "true",
    HOME23_AGENT: slug,
    HOME23_COORDINATION_RESIDENT_SOCKET_PATH: socketPath,
    HOME23_COORDINATION_RESIDENT_SERVER_INSTANCE_ID: `home23-${slug}-harness`,
    HOME23_COORDINATION_RESIDENT_CLIENT_INSTANCE_ID: `home23-${slug}-harness`,
    HOME23_COORDINATION_RESIDENT_KEY_VERSION: "1",
    HOME23_COORDINATION_RESIDENT_KEY: key,
  });
  const jerryHarness = await startResidentCoordinationHarness({
    agent: observedAgent("jerry", jerryRuntime.agent),
    history: jerryRuntime.history,
    environment: residentEnvironment("jerry", jerrySocketPath, jerryKey),
  });
  const forrestHarness = await startResidentCoordinationHarness({
    agent: observedAgent("forrest", forrestRuntime.agent),
    history: forrestRuntime.history,
    environment: residentEnvironment("forrest", forrestSocketPath, forrestKey),
  });
  assert.ok(jerryHarness);
  assert.ok(forrestHarness);
  t.after(() => Promise.all([jerryHarness!.close(), forrestHarness!.close()]));

  const flags = {
    ...disabledCoordinationFeatureFlags(),
    "coordination.process.enabled": true,
    "coordination.public_api.enabled": true,
    "coordination.channels.enabled": true,
    "coordination.resident.jerry.enabled": true,
    "coordination.resident.forrest.enabled": true,
  };
  const coordinationProcess = createCoordinationProcess({
    enabled: true,
    host: "127.0.0.1",
    port: 0,
    databasePath,
    socketPath: join(runtime, "coord.sock"),
    capabilityToken,
    activity: { enabled: true },
    flags,
    residents: {
      jerry: {
        enabled: true,
        socketPath: jerrySocketPath,
        serverInstanceId: "home23-jerry-harness",
        clientInstanceId: "home23-jerry-harness",
        keyVersion: 1,
        key: jerryKey,
      },
      forrest: {
        enabled: true,
        socketPath: forrestSocketPath,
        serverInstanceId: "home23-forrest-harness",
        clientInstanceId: "home23-forrest-harness",
        keyVersion: 1,
        key: forrestKey,
      },
    },
  });
  t.after(() => coordinationProcess.drain());
  const address = await coordinationProcess.start();
  const headers = { authorization: `Bearer ${token}` };
  const capabilities = await (await fetch(`${address.origin}/api/v1/capabilities`)).json() as any;
  assert.equal(capabilities.capabilities.messageSubmission, true);
  assert.equal(capabilities.capabilities.channelMutation, true);

  const submit = async (channelId: string, resident: "Jerry" | "Forrest") => {
    const response = await fetch(`${address.origin}/api/v1/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        "idempotency-key": `dual-resident-${resident.toLowerCase()}-message`,
      },
      body: JSON.stringify({
        messageId: generateCoordinationId("message"),
        clientMessageId: `dual-resident-${resident.toLowerCase()}`,
        text: `${resident}, answer canonically.`,
        attachmentIds: [],
        mentions: [],
        replyToMessageId: null,
      }),
    });
    assert.equal(response.status, 202, `${resident} send: ${await response.text()}`);
  };
  await submit(jerry.channelId!, "Jerry");
  await submit(forrest.channelId, "Forrest");

  const requireResult = async (channelId: string, expected: string) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const response = await fetch(`${address.origin}/api/v1/channels/${channelId}/messages`, { headers });
      const body = await response.json() as { messages: Array<{ kind: string; text: string }> };
      const result = body.messages.find((message) => message.kind === "result");
      if (result) {
        assert.equal(result.text, expected);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail(`missing result for ${channelId}`);
  };
  await Promise.all([
    requireResult(jerry.channelId!, "Canonical Jerry response."),
    requireResult(forrest.channelId, "Canonical Forrest response."),
  ]);
  assert.deepEqual(residentInvocations, { jerry: 1, forrest: 1 },
    "each direct conversation must traverse only its own resident socket");
  assert.equal(jerryModel.calls() + forrestModel.calls(), 2);

  const groupResponse = await fetch(`${address.origin}/api/v1/channels`, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
      "idempotency-key": "dual-resident-group-create-0001",
    },
    body: JSON.stringify({
      kind: "group",
      memberBotIds: [jerry.botId, forrest.botId],
      title: "Jerry and Forrest",
      purpose: "Canonical multi-resident coordination.",
      pinned: false,
      responderPolicy: {
        mode: "mention_or_coordinator",
        coordinatorBotId: jerry.botId,
        responseOrder: "parallel",
        maxBotTurns: 4,
      },
    }),
  });
  const groupResponseBody = await groupResponse.text();
  assert.equal(groupResponse.status, 201, `group create: ${groupResponseBody}`);
  const group = JSON.parse(groupResponseBody) as { channel: { id: string } };
  const groupMessageId = generateCoordinationId("message");
  const groupSend = await fetch(
    `${address.origin}/api/v1/channels/${group.channel.id}/messages`,
    {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        "idempotency-key": "dual-resident-group-message-0001",
      },
      body: JSON.stringify({
        messageId: groupMessageId,
        clientMessageId: "dual-resident-group-client-0001",
        text: "@Jerry and @Forrest, each answer through your own resident.",
        attachmentIds: [],
        mentions: [jerry.botId, forrest.botId],
        replyToMessageId: null,
      }),
    },
  );
  const groupAccepted = await groupSend.json() as {
    round?: { id?: string };
    works?: Array<{ id: string; roundId: string; targetPrincipalId: string }>;
  };
  assert.equal(groupSend.status, 202, `group send: ${JSON.stringify(groupAccepted)}`);
  assert.match(groupAccepted.round?.id ?? "", /^rnd_/);
  assert.equal(groupAccepted.works?.length, 2);
  assert.deepEqual(
    groupAccepted.works?.map((work) => work.targetPrincipalId).sort(),
    [jerry.botId, forrest.botId].sort(),
  );
  let groupResults: Array<{
    author: { principalId: string };
    kind: string;
    replyToMessageId: string | null;
    provenance: { roundId: string | null; workId: string | null };
  }> = [];
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await fetch(
      `${address.origin}/api/v1/channels/${group.channel.id}/messages`,
      { headers },
    );
    const body = await response.json() as { messages: typeof groupResults };
    groupResults = body.messages.filter((message) => message.kind === "result");
    if (groupResults.length === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(groupResults.length, 2);
  assert.deepEqual(
    groupResults.map((message) => message.author.principalId).sort(),
    [jerry.botId, forrest.botId].sort(),
  );
  for (const result of groupResults) {
    assert.equal(result.replyToMessageId, groupMessageId);
    assert.equal(result.provenance.roundId, groupAccepted.round?.id);
    assert.match(result.provenance.workId ?? "", /^wrk_/);
  }
  assert.deepEqual(residentInvocations, { jerry: 2, forrest: 2 });
  assert.equal(jerryModel.calls() + forrestModel.calls(), 4);

  const terminalReplay = await fetch(
    `${address.origin}/api/v1/channels/${group.channel.id}/messages`,
    {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        "idempotency-key": "dual-resident-group-message-0001",
      },
      body: JSON.stringify({
        messageId: groupMessageId,
        clientMessageId: "dual-resident-group-client-0001",
        text: "@Jerry and @Forrest, each answer through your own resident.",
        attachmentIds: [],
        mentions: [jerry.botId, forrest.botId],
        replyToMessageId: null,
      }),
    },
  );
  const terminalReplayBody = await terminalReplay.json() as {
    round?: { id?: string };
    works?: Array<{ id: string }>;
    replayed?: boolean;
  };
  assert.equal(terminalReplay.status, 202, `terminal replay: ${JSON.stringify(terminalReplayBody)}`);
  assert.equal(terminalReplayBody.round?.id, groupAccepted.round?.id);
  assert.deepEqual(
    terminalReplayBody.works?.map((work) => work.id).sort(),
    groupAccepted.works?.map((work) => work.id).sort(),
  );
  assert.equal(terminalReplayBody.replayed, true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(residentInvocations, { jerry: 2, forrest: 2 },
    "lost-response replay must not execute either resident twice");
  const replayedMessages = await (await fetch(
    `${address.origin}/api/v1/channels/${group.channel.id}/messages`,
    { headers },
  )).json() as { messages: Array<{ id: string; replyToMessageId: string | null }> };
  assert.equal(replayedMessages.messages.filter((message) => message.id === groupMessageId).length, 1);
  assert.equal(replayedMessages.messages.filter(
    (message) => message.replyToMessageId === groupMessageId,
  ).length, 2);

  const coordinatorMessageId = generateCoordinationId("message");
  const coordinatorSend = await fetch(
    `${address.origin}/api/v1/channels/${group.channel.id}/messages`,
    {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        "idempotency-key": "dual-resident-coordinator-message-0001",
      },
      body: JSON.stringify({
        messageId: coordinatorMessageId,
        clientMessageId: "dual-resident-coordinator-client-0001",
        text: "Coordinator, answer this unmentioned group turn.",
        attachmentIds: [],
        mentions: [],
        replyToMessageId: null,
      }),
    },
  );
  const coordinatorAccepted = await coordinatorSend.json() as {
    works?: Array<{ targetPrincipalId: string }>;
  };
  assert.equal(
    coordinatorSend.status,
    202,
    `coordinator send: ${JSON.stringify(coordinatorAccepted)}`,
  );
  assert.deepEqual(
    coordinatorAccepted.works?.map((work) => work.targetPrincipalId),
    [jerry.botId],
  );
  let coordinatorResult = false;
  for (let attempt = 0; attempt < 200 && !coordinatorResult; attempt += 1) {
    const response = await fetch(
      `${address.origin}/api/v1/channels/${group.channel.id}/messages`,
      { headers },
    );
    const body = await response.json() as {
      messages: Array<{ kind: string; replyToMessageId: string | null }>;
    };
    coordinatorResult = body.messages.some(
      (candidate) => candidate.kind === "result" &&
        candidate.replyToMessageId === coordinatorMessageId,
    );
    if (!coordinatorResult) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(coordinatorResult, true);
  assert.deepEqual(residentInvocations, { jerry: 3, forrest: 2 });
  assert.equal(jerryModel.calls() + forrestModel.calls(), 5);

  const quietGroupResponse = await fetch(`${address.origin}/api/v1/channels`, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
      "idempotency-key": "dual-resident-quiet-group-create-0001",
    },
    body: JSON.stringify({
      kind: "group",
      memberBotIds: [jerry.botId, forrest.botId],
      title: "Mentions only",
      purpose: "Only explicitly mentioned Bots respond.",
      pinned: false,
      responderPolicy: {
        mode: "mentions_only",
        coordinatorBotId: null,
        responseOrder: "sequential",
        maxBotTurns: 2,
      },
    }),
  });
  const quietGroupBody = await quietGroupResponse.text();
  assert.equal(quietGroupResponse.status, 201, `quiet group create: ${quietGroupBody}`);
  const quietGroup = JSON.parse(quietGroupBody) as { channel: { id: string } };
  const quietSend = await fetch(
    `${address.origin}/api/v1/channels/${quietGroup.channel.id}/messages`,
    {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        "idempotency-key": "dual-resident-quiet-message-0001",
      },
      body: JSON.stringify({
        messageId: generateCoordinationId("message"),
        clientMessageId: "dual-resident-quiet-client-0001",
        text: "This group post intentionally mentions nobody.",
        attachmentIds: [],
        mentions: [],
        replyToMessageId: null,
      }),
    },
  );
  const quietAccepted = await quietSend.json() as {
    round?: unknown;
    works?: unknown[];
  };
  assert.equal(quietSend.status, 202, `quiet send: ${JSON.stringify(quietAccepted)}`);
  assert.equal(quietAccepted.round, null);
  assert.deepEqual(quietAccepted.works, []);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(residentInvocations, { jerry: 3, forrest: 2 });
  assert.equal(jerryModel.calls() + forrestModel.calls(), 5);

  const quietMentionMessageId = generateCoordinationId("message");
  const quietMentionSend = await fetch(
    `${address.origin}/api/v1/channels/${quietGroup.channel.id}/messages`,
    {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        "idempotency-key": "dual-resident-quiet-mention-message-0001",
      },
      body: JSON.stringify({
        messageId: quietMentionMessageId,
        clientMessageId: "dual-resident-quiet-mention-client-0001",
        text: "@Forrest, answer this mentions-only turn.",
        attachmentIds: [],
        mentions: [forrest.botId],
        replyToMessageId: null,
      }),
    },
  );
  const quietMentionAccepted = await quietMentionSend.json() as {
    round?: { coordinatorBotId?: string };
    works?: Array<{ targetPrincipalId: string }>;
  };
  assert.equal(
    quietMentionSend.status,
    202,
    `quiet mention send: ${JSON.stringify(quietMentionAccepted)}`,
  );
  assert.equal(quietMentionAccepted.round?.coordinatorBotId, forrest.botId);
  assert.deepEqual(
    quietMentionAccepted.works?.map((work) => work.targetPrincipalId),
    [forrest.botId],
  );
  let quietMentionResult = false;
  for (let attempt = 0; attempt < 200 && !quietMentionResult; attempt += 1) {
    const response = await fetch(
      `${address.origin}/api/v1/channels/${quietGroup.channel.id}/messages`,
      { headers },
    );
    const body = await response.json() as {
      messages: Array<{ kind: string; replyToMessageId: string | null }>;
    };
    quietMentionResult = body.messages.some(
      (candidate) => candidate.kind === "result" &&
        candidate.replyToMessageId === quietMentionMessageId,
    );
    if (!quietMentionResult) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(quietMentionResult, true);
  assert.deepEqual(residentInvocations, { jerry: 3, forrest: 3 });
  assert.equal(jerryModel.calls() + forrestModel.calls(), 6);

  const sequentialCreate = await fetch(`${address.origin}/api/v1/channels`, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
      "idempotency-key": "dual-resident-sequential-group-create-0001",
    },
    body: JSON.stringify({
      kind: "group",
      memberBotIds: [jerry.botId, forrest.botId],
      title: "Sequential residents",
      purpose: "Each later Bot receives the preceding committed result.",
      pinned: false,
      responderPolicy: {
        mode: "mentions_only",
        coordinatorBotId: null,
        responseOrder: "sequential",
        maxBotTurns: 2,
      },
    }),
  });
  const sequentialCreateBody = await sequentialCreate.text();
  assert.equal(sequentialCreate.status, 201, `sequential create: ${sequentialCreateBody}`);
  const sequentialChannel = JSON.parse(sequentialCreateBody) as { channel: { id: string } };
  const sequentialMessageId = generateCoordinationId("message");
  const sequentialSend = await fetch(
    `${address.origin}/api/v1/channels/${sequentialChannel.channel.id}/messages`,
    {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        "idempotency-key": "dual-resident-sequential-message-0001",
      },
      body: JSON.stringify({
        messageId: sequentialMessageId,
        clientMessageId: "dual-resident-sequential-client-0001",
        text: "Give one compact response, then let the next member continue.",
        attachmentIds: [],
        mentions: [jerry.botId, forrest.botId],
        replyToMessageId: null,
      }),
    },
  );
  const sequentialAccepted = await sequentialSend.json() as {
    round?: { id: string };
    works?: Array<{ id: string; targetPrincipalId: string }>;
  };
  assert.equal(sequentialSend.status, 202, `sequential send: ${JSON.stringify(sequentialAccepted)}`);
  assert.equal(sequentialAccepted.works?.length, 1,
    "only the first sequential Work may be admitted against the initial manifest");
  let sequentialResults: Array<{
    id: string;
    text: string | null;
    author: { principalId: string };
    provenance: { workId: string | null };
  }> = [];
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await fetch(
      `${address.origin}/api/v1/channels/${sequentialChannel.channel.id}/messages`,
      { headers },
    );
    const body = await response.json() as { messages: typeof sequentialResults };
    sequentialResults = body.messages.filter((message) => message.provenance.workId !== null);
    if (sequentialResults.length === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(sequentialResults.length, 2);
  const firstSequentialWorkId = sequentialAccepted.works?.[0]?.id;
  const firstSequentialResult = sequentialResults.find(
    (message) => message.provenance.workId === firstSequentialWorkId,
  );
  assert.ok(firstSequentialResult?.text);
  const secondTarget = firstSequentialResult.author.principalId === jerry.botId
    ? "forrest"
    : "jerry";
  const secondRequests = secondTarget === "jerry" ? jerryModel.requests() : forrestModel.requests();
  assert.match(
    JSON.stringify(secondRequests.at(-1)),
    new RegExp(firstSequentialResult.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "the later resident request must contain the preceding canonical result",
  );
  const activityResponse = await fetch(
    `${address.origin}/api/v1/activity?limit=100`,
    { headers },
  );
  const activityBody = await activityResponse.text();
  assert.equal(activityResponse.status, 200, `activity: ${activityBody}`);
  const activity = JSON.parse(activityBody) as {
    entries: Array<{
      category: string;
      channelId: string | null;
      actor: { principalId: string };
      workId: string | null;
      source: { kind: string; authorityId: string | null };
    }>;
    throughEventSequence: number;
  };
  assert.ok(activity.throughEventSequence > 0);
  assert.ok(activity.entries.some((entry) =>
    entry.channelId === group.channel.id &&
    entry.actor.principalId === jerry.botId &&
    entry.workId !== null
  ));
  assert.ok(activity.entries.some((entry) =>
    entry.channelId === group.channel.id &&
    entry.actor.principalId === forrest.botId &&
    entry.workId !== null
  ));
  assert.equal(
    activity.entries.some((entry) => entry.source.kind === "work_observation" &&
      entry.source.authorityId === null),
    false,
  );

  await coordinationProcess.drain();
  const sequentialDatabase = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const workManifests = sequentialDatabase.prepare(
      `SELECT w.id AS workId, manifest.message_refs_json AS messageRefsJson
       FROM works w JOIN context_manifests manifest ON manifest.id = w.context_manifest_id
       WHERE w.round_id = ? ORDER BY w.created_at, w.id`,
    ).all(sequentialAccepted.round!.id) as Array<{
      workId: string;
      messageRefsJson: string;
    }>;
    assert.equal(workManifests.length, 2);
    const secondManifest = workManifests.find((entry) => entry.workId !== firstSequentialWorkId);
    assert.ok(secondManifest);
    assert.ok(
      (JSON.parse(secondManifest.messageRefsJson) as string[]).includes(firstSequentialResult.id),
      "the later Work must durably bind the preceding result in its immutable manifest",
    );
  } finally {
    sequentialDatabase.close();
  }
});

test("isolated production composition traverses the generated harness and unmodified AgentLoop", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "home23-production-vertical-")); const runtime = join(root, "instances", ".house", "coordination"); mkdirSync(runtime, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const modelFixture = await startLocalModelFixture();
  t.after(() => modelFixture.close());
  const priorEnvironment = {
    HOME23_ROOT: process.env.HOME23_ROOT,
    HOME23_AGENT: process.env.HOME23_AGENT,
    LOCAL_LLM_BASE_URL: process.env.LOCAL_LLM_BASE_URL,
  };
  process.env.HOME23_ROOT = root;
  process.env.HOME23_AGENT = "jerry";
  process.env.LOCAL_LLM_BASE_URL = modelFixture.baseUrl;
  t.after(() => {
    for (const [name, value] of Object.entries(priorEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const databasePath = join(runtime, "home23-coordination.sqlite3"), socketPath = join(root, "j.sock"), residentKey = "7".repeat(64), capabilityToken = "9".repeat(64);
  const seeded = await bootstrapJerry({ databasePath, apply: true, authority, serverInstanceId: "home23-jerry-harness", keyVersion: 1 });
  const replayedBootstrap = await bootstrapJerry({ databasePath, apply: true, authority, serverInstanceId: "home23-jerry-harness", keyVersion: 1 });
  assert.deepEqual({ botId: replayedBootstrap.botId, channelId: replayedBootstrap.channelId, conversationId: replayedBootstrap.conversationId }, { botId: seeded.botId, channelId: seeded.channelId, conversationId: seeded.conversationId });
  const token = await accessToken(databasePath, capabilityToken);
  seedCanonicalProjectionAuthority(
    databasePath,
    "attachments",
    COORDINATION_ATTACHMENTS_WRITER,
  );
  const { agent, history } = actualAgent(root);
  const harnessEnvironment = {
    HOME23_ROOT: root,
    HOME23_COORDINATION_RESIDENT_ENABLED: "true",
    HOME23_AGENT: "jerry",
    HOME23_COORDINATION_RESIDENT_SOCKET_PATH: socketPath,
    HOME23_COORDINATION_RESIDENT_SERVER_INSTANCE_ID: "home23-jerry-harness",
    HOME23_COORDINATION_RESIDENT_CLIENT_INSTANCE_ID: "home23-jerry-harness",
    HOME23_COORDINATION_RESIDENT_KEY_VERSION: "1",
    HOME23_COORDINATION_RESIDENT_KEY: residentKey,
  };
  let harness = await startResidentCoordinationHarness({ agent, history, environment: harnessEnvironment });
  assert.ok(harness);
  t.after(() => harness?.close());
  const flags = { ...disabledCoordinationFeatureFlags(), "coordination.process.enabled": true, "coordination.public_api.enabled": true, "coordination.resident.jerry.enabled": true };
  const config = () => ({ enabled: true, host: "127.0.0.1" as const, port: 0, databasePath, socketPath: join(runtime, "coord.sock"), capabilityToken, flags,
    attachments: { enabled: true, rootDirectory: join(runtime, "attachments"), maximumBytes: 25 * 1024 * 1024, maximumCountPerMessage: 10 },
    residents: { jerry: { enabled: true, socketPath, serverInstanceId: "home23-jerry-harness", clientInstanceId: "home23-jerry-harness", keyVersion: 1, key: residentKey }, forrest: { enabled: false, socketPath: join(runtime, "resident-forrest.sock"), serverInstanceId: "home23-forrest-harness", clientInstanceId: "home23-forrest-harness", keyVersion: 1, key: "" } } });
  let coordinationProcess = createCoordinationProcess(config()); let address = await coordinationProcess.start();
  const capabilities = await (await fetch(`${address.origin}/api/v1/capabilities`)).json() as any;
  assert.equal(capabilities.capabilities.messageSubmission, false);
  assert.equal(capabilities.capabilities.attachments, true);
  assert.equal(capabilities.capabilities.eventReplay, true);
  assert.equal((await fetch(`${address.origin}/api/v1/bootstrap`)).status, 401);
  const productHeaders = { authorization: `Bearer ${token}` };
  const legacyAuthorityEpochs = await (await fetch(`${address.origin}/api/v1/authority-epochs`, { headers: productHeaders })).json() as any;
  assert.deepEqual(legacyAuthorityEpochs.epochs.find((epoch: AuthorityEpoch) => epoch.capability === "messages"), { capability: "messages", epoch: 1, mode: "legacy", writer: "legacy-conversation-writer", effectiveAtEventSequence: null, rollbackEpoch: null });
  const attachmentAuthority = legacyAuthorityEpochs.epochs.find((epoch: AuthorityEpoch) => epoch.capability === "attachments") as AuthorityEpoch;
  assert.deepEqual({ capability: attachmentAuthority.capability, epoch: attachmentAuthority.epoch, mode: attachmentAuthority.mode, writer: attachmentAuthority.writer, rollbackEpoch: attachmentAuthority.rollbackEpoch }, { capability: "attachments", epoch: 3, mode: "canonical", writer: COORDINATION_ATTACHMENTS_WRITER, rollbackEpoch: 1 });
  assert.ok(Number.isSafeInteger(attachmentAuthority.effectiveAtEventSequence));
  assert.ok(Number.isSafeInteger(legacyAuthorityEpochs.throughEventSequence));
  assert.match(legacyAuthorityEpochs.requestId, /^req_/);
  assert.match(legacyAuthorityEpochs.correlationId, /^cor_/);
  const bots = await (await fetch(`${address.origin}/api/v1/bots`, { headers: productHeaders })).json() as { bots: Array<{ id: string }> };
  assert.deepEqual(bots.bots.map((bot) => bot.id), [seeded.botId]);
  const details = await (await fetch(`${address.origin}/api/v1/bots/${seeded.botId}/details`, { headers: productHeaders })).json() as any;
  assert.deepEqual(details.executionBoundary, { kind: "local_mac", label: "This Mac", attested: true, isolation: { status: "unavailable", blocker: { code: "isolated_execution_not_attested", capability: "isolated_execution", retryable: false } } });
  assert.equal(details.routineSummary.blocker.code, "canonical_scheduler_adapter_unavailable");
  assert.equal(details.consequentialApproval.blocker.code, "consequential_action_consumer_unavailable");
  const channels = await (await fetch(`${address.origin}/api/v1/channels`, { headers: productHeaders })).json() as { channels: Array<{ id: string }> };
  assert.deepEqual(channels.channels.map((channel) => channel.id), [seeded.channelId]);
  const inbox = await (await fetch(`${address.origin}/api/v1/inbox`, { headers: productHeaders })).json() as { conversations: Array<{ channelId: string }> };
  assert.deepEqual(inbox.conversations.map((conversation) => conversation.channelId), [seeded.channelId]);
  const form = new FormData();
  form.set("metadata", JSON.stringify({ artifactId: verticalArtifactId, name: "resident-evidence.txt", declaredContentType: "text/plain", expectedSha256: verticalArtifactSha256 }));
  form.set("content", new Blob([verticalArtifactBytes], { type: "text/plain" }), "resident-evidence.txt");
  const uploaded = await fetch(`${address.origin}/api/v1/attachments`, { method: "POST", headers: { authorization: `Bearer ${token}`, "idempotency-key": "production-vertical-attachment-0001" }, body: form });
  assert.equal(uploaded.status, 201, `attachment upload: ${await uploaded.text()}`);
  const correlationId = generateCoordinationId("correlation"); const body = { messageId: generateCoordinationId("message"), clientMessageId: "m14-client-message", text: null, attachmentIds: [verticalArtifactId], mentions: [], replyToMessageId: null };
  const send = () => fetch(`${address.origin}/api/v1/channels/${seeded.channelId}/messages`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": "m14-production-message-0001", "x-correlation-id": correlationId }, body: JSON.stringify(body) });
  assert.equal((await send()).status, 503);
  assert.equal(modelFixture.calls(), 0);
  await coordinationProcess.drain();

  const legacy: AuthorityEpoch = {
    capability: "messages", epoch: 1, mode: "legacy",
    writer: "legacy-conversation-writer",
    effectiveAtEventSequence: null, rollbackEpoch: null,
  };
  const shadow: AuthorityEpoch = {
    ...legacy, epoch: 2, mode: "shadow",
  };
  const operatorKeys = generateKeyPairSync("ed25519");
  applyAuthorityTransition({
    databasePath,
    publicKey: operatorKeys.publicKey,
    receipt: signedAuthorityReceipt({
      from: legacy, to: shadow, channelId: seeded.channelId!,
      snapshot: authoritySnapshot(databasePath),
      privateKey: operatorKeys.privateKey,
      issuedAt: "2026-08-26T12:00:00.000Z",
    }),
  });
  coordinationProcess = createCoordinationProcess(config());
  address = await coordinationProcess.start();
  assert.equal((await (await fetch(`${address.origin}/api/v1/capabilities`)).json() as any).capabilities.messageSubmission, false);
  assert.equal((await send()).status, 503);
  assert.equal(modelFixture.calls(), 0);
  await coordinationProcess.drain();

  const canonicalSnapshot = authoritySnapshot(databasePath);
  const canonical: AuthorityEpoch = {
    capability: "messages", epoch: 3, mode: "canonical",
    writer: COORDINATION_MESSAGES_WRITER,
    effectiveAtEventSequence: canonicalSnapshot.eventSequence,
    rollbackEpoch: 1,
  };
  const mislabeledCanonical: AuthorityEpoch = {
    ...canonical,
    writer: "label-only-writer",
  };
  assert.throws(() => applyAuthorityTransition({
    databasePath,
    publicKey: operatorKeys.publicKey,
    receipt: signedAuthorityReceipt({
      from: shadow, to: mislabeledCanonical, channelId: seeded.channelId!,
      snapshot: canonicalSnapshot,
      privateKey: operatorKeys.privateKey,
      issuedAt: "2026-08-26T12:00:30.000Z",
    }),
  }), /canonical writer must be exactly home23-coordination/);
  applyAuthorityTransition({
    databasePath,
    publicKey: operatorKeys.publicKey,
    receipt: signedAuthorityReceipt({
      from: shadow, to: canonical, channelId: seeded.channelId!,
      snapshot: canonicalSnapshot,
      privateKey: operatorKeys.privateKey,
      issuedAt: "2026-08-26T12:01:00.000Z",
    }),
  });
  coordinationProcess = createCoordinationProcess(config());
  address = await coordinationProcess.start();
  const canonicalCapabilities = await (await fetch(`${address.origin}/api/v1/capabilities`)).json() as any;
  assert.equal(canonicalCapabilities.capabilities.messageSubmission, true);
  const canonicalAuthorityEpochs = await (await fetch(`${address.origin}/api/v1/authority-epochs`, { headers: productHeaders })).json() as any;
  assert.deepEqual(canonicalAuthorityEpochs.epochs.find((epoch: AuthorityEpoch) => epoch.capability === "messages"), canonical);
  assert.deepEqual(canonicalAuthorityEpochs.epochs.find((epoch: AuthorityEpoch) => epoch.capability === "attachments"), attachmentAuthority);
  const first = await send();
  if (first.status !== 202) {
    const failure = await first.text(); await coordinationProcess.drain(); const diagnostic = openCoordinationDatabase({ path: databasePath });
    const counts: Record<string, number | string> = {}; for (const table of ["messages", "works", "attempts", "leases"]) { try { counts[table] = diagnostic.readOne<{ count: number }>(`SELECT count(*) AS count FROM ${table}`)?.count ?? -1; } catch (error) { counts[table] = error instanceof Error ? error.message : String(error); } } diagnostic.close();
    assert.fail(`first send ${failure}; counts=${JSON.stringify(counts)}`);
  }
  for (let i = 0; i < 100 && modelFixture.calls() === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  if (modelFixture.calls() === 0) {
    await coordinationProcess.drain();
    const diagnostic = openCoordinationDatabase({ path: databasePath });
    const work = diagnostic.readOne<Record<string, unknown>>("SELECT * FROM works LIMIT 1");
    const attempt = diagnostic.readOne<Record<string, unknown>>("SELECT * FROM attempts LIMIT 1");
    const lease = diagnostic.readOne<Record<string, unknown>>("SELECT * FROM leases LIMIT 1");
    diagnostic.close();
    assert.fail(`resident was not invoked: ${JSON.stringify({ work, attempt, lease })}`);
  }
  const modelUserMessage = modelFixture.requests()[0]?.messages?.findLast((message) => message.role === "user");
  const residentAttachmentInstruction = String(modelUserMessage?.content);
  assert.match(residentAttachmentInstruction, /\[Canonical user attachments\]/);
  assert.match(residentAttachmentInstruction, /resident-evidence\.txt/);
  assert.match(residentAttachmentInstruction, new RegExp(verticalArtifactSha256));
  assert.match(
    residentAttachmentInstruction,
    /instances\/\.house\/coordination\/attachments\/objects\/sha256\//,
    "the resident must receive the verified local object path, not only an artifact ID",
  );
  const eventAbort = new AbortController();
  const events = await fetch(`${address.origin}/api/v1/events?after=0`, {
    headers: { authorization: `Bearer ${token}` }, signal: eventAbort.signal,
  });
  const reader = events.body!.getReader();
  const decoder = new TextDecoder();
  let eventText = "";
  for (let i = 0; i < 100 && !eventText.includes("message.appended"); i += 1) {
    const chunk = await reader.read();
    if (chunk.done) break;
    eventText += decoder.decode(chunk.value, { stream: true });
  }
  eventAbort.abort();
  assert.match(eventText, /message\.appended/);
  assert.ok(eventText.includes(correlationId));
  await new Promise((resolve) => setTimeout(resolve, 500));
  const transcript = await (await fetch(`${address.origin}/api/v1/channels/${seeded.channelId}/messages`, { headers: productHeaders })).json() as { messages: Array<{ kind: string; text: string | null; attachments: Array<{ id: string; name: string; contentType: string; byteCount: number; sha256: string }>; provenance: { workId: string | null } }> };
  assert.deepEqual(transcript.messages.map((message) => message.kind), ["text", "result"]);
  assert.equal(transcript.messages[0]?.text, null);
  assert.deepEqual(transcript.messages[0]?.attachments, [{
    id: verticalArtifactId,
    name: "resident-evidence.txt",
    contentType: "text/plain",
    byteCount: verticalArtifactBytes.length,
    sha256: verticalArtifactSha256,
  }]);
  assert.deepEqual(transcript.messages[1]?.attachments, []);
  assert.equal(transcript.messages[1]?.text, "Canonical Jerry response.");
  assert.ok(transcript.messages[1]?.provenance.workId?.startsWith("wrk_"));
  const duplicate = await send(); assert.equal(duplicate.status, 202, `duplicate: ${await duplicate.text()}`); assert.equal(modelFixture.calls(), 1); await coordinationProcess.drain();
  const db = openCoordinationDatabase({ path: databasePath });
  for (const table of ["works", "attempts", "leases", "terminal_receipts"] as const) assert.equal(db.readOne<{ count: number }>(`SELECT count(*) AS count FROM ${table}`)?.count, 1);
  assert.equal(db.readOne<{ count: number }>("SELECT count(*) AS count FROM messages WHERE kind='result'")?.count, 1);
  assert.equal(db.readOne<{ count: number }>("SELECT count(*) AS count FROM message_artifacts")?.count, 1);
  const manifestAttachment = db.readOne<{ artifactRefsJson: string; artifactCount: number }>("SELECT artifact_refs_json AS artifactRefsJson, artifact_count AS artifactCount FROM context_manifests LIMIT 1");
  assert.deepEqual(manifestAttachment, { artifactRefsJson: JSON.stringify([verticalArtifactId]), artifactCount: 1 });
  assert.ok((db.readOne<{ count: number }>("SELECT count(*) AS count FROM events WHERE correlation_id=?", correlationId)?.count ?? 0) >= 3); db.close();
  await harness.close(); harness = await startResidentCoordinationHarness({ agent, history, environment: harnessEnvironment }); assert.ok(harness);
  coordinationProcess = createCoordinationProcess(config()); address = await coordinationProcess.start();
  const restartedCapabilities = await (await fetch(`${address.origin}/api/v1/capabilities`)).json() as any;
  assert.equal(restartedCapabilities.capabilities.messageSubmission, true);
  assert.equal((await send()).status, 202); assert.equal(modelFixture.calls(), 1); await coordinationProcess.drain();
});

test("bootstrap apply refuses without explicit feature-off authority evidence", async () => {
  await assert.rejects(bootstrapJerry({ databasePath: "/tmp/must-not-open.sqlite3", apply: true, serverInstanceId: "home23-jerry-harness", keyVersion: 1 }), /explicit feature-off legacy-authority evidence/);
  const authorityApply = spawnSync(process.execPath, ["scripts/coordination/m14-authority.mjs", "--apply"], { cwd: process.cwd(), encoding: "utf8" });
  assert.notEqual(authorityApply.status, 0);
  assert.match(`${authorityApply.stderr}${authorityApply.stdout}`, /--database and --evidence are required/);
});
