import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { AgentLoop } from "../../../src/agent/loop.js";
import { ConversationHistory } from "../../../src/agent/history.js";
import { createAuthService, SqliteAuthRepository } from "../../../src/coordination/auth/index.js";
import { bootstrapJerry } from "../../../src/coordination/operations/index.js";
import { runCoordinationProcess } from "../../../src/coordination/index.js";
import { openCoordinationDatabase } from "../../../src/coordination/db/index.js";
import { generateCoordinationId } from "../../../src/coordination/ids/index.js";
import { createCoordinationProcess, disabledCoordinationFeatureFlags } from "../../../src/coordination/app/index.js";
import { startResidentCoordinationHarness } from "../../../src/coordination-adapter/index.js";

const authority = { approved: true, kind: "m14-bootstrap", operator: "user_owner", resident: "jerry", legacyWriterAuthoritative: true, coordinationFlagsAllFalse: true } as const;

function actualAgent(root: string) {
  const history = new ConversationHistory(join(root, "conversations"), 400_000, "jerry");
  const workspacePath = join(root, "workspace");
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
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof requests[number]);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "Canonical Jerry response." } }],
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
  const { agent, history } = actualAgent(root);
  const harnessEnvironment = {
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
    residents: { jerry: { enabled: true, socketPath, serverInstanceId: "home23-jerry-harness", clientInstanceId: "home23-jerry-harness", keyVersion: 1, key: residentKey }, forrest: { enabled: false, socketPath: join(runtime, "resident-forrest.sock"), serverInstanceId: "home23-forrest-harness", clientInstanceId: "home23-forrest-harness", keyVersion: 1, key: "" } } });
  let coordinationProcess = createCoordinationProcess(config()); let address = await coordinationProcess.start();
  const capabilities = await (await fetch(`${address.origin}/api/v1/capabilities`)).json() as any;
  assert.equal(capabilities.capabilities.messageSubmission, true);
  assert.equal(capabilities.capabilities.eventReplay, true);
  assert.equal((await fetch(`${address.origin}/api/v1/bootstrap`)).status, 401);
  const productHeaders = { authorization: `Bearer ${token}` };
  const authorityEpochs = await (await fetch(`${address.origin}/api/v1/authority-epochs`, { headers: productHeaders })).json() as any;
  assert.deepEqual(authorityEpochs.epochs, [{ capability: "messages", epoch: 1, mode: "legacy", writer: "legacy-conversation-writer", effectiveAtEventSequence: null, rollbackEpoch: null }]);
  assert.ok(Number.isSafeInteger(authorityEpochs.throughEventSequence));
  assert.match(authorityEpochs.requestId, /^req_/);
  assert.match(authorityEpochs.correlationId, /^cor_/);
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
  const correlationId = generateCoordinationId("correlation"); const body = { messageId: generateCoordinationId("message"), clientMessageId: "m14-client-message", text: "Jerry, answer canonically.", attachmentIds: [], mentions: [], replyToMessageId: null };
  const send = () => fetch(`${address.origin}/api/v1/channels/${seeded.channelId}/messages`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": "m14-production-message-0001", "x-correlation-id": correlationId }, body: JSON.stringify(body) });
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
  assert.match(String(modelUserMessage?.content), /Jerry, answer canonically\./);
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
  const transcript = await (await fetch(`${address.origin}/api/v1/channels/${seeded.channelId}/messages`, { headers: productHeaders })).json() as { messages: Array<{ kind: string; text: string; provenance: { workId: string | null } }> };
  assert.deepEqual(transcript.messages.map((message) => message.kind), ["text", "result"]);
  assert.equal(transcript.messages[1]?.text, "Canonical Jerry response.");
  assert.ok(transcript.messages[1]?.provenance.workId?.startsWith("wrk_"));
  const duplicate = await send(); assert.equal(duplicate.status, 202, `duplicate: ${await duplicate.text()}`); assert.equal(modelFixture.calls(), 1); await coordinationProcess.drain();
  const db = openCoordinationDatabase({ path: databasePath });
  for (const table of ["works", "attempts", "leases", "terminal_receipts"] as const) assert.equal(db.readOne<{ count: number }>(`SELECT count(*) AS count FROM ${table}`)?.count, 1);
  assert.equal(db.readOne<{ count: number }>("SELECT count(*) AS count FROM messages WHERE kind='result'")?.count, 1);
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
