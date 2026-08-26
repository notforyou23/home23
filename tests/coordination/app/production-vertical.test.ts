import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
import { createResidentCredential } from "../../../src/coordination/resident-protocol/index.js";
import { ResidentTurnUdsServer, startResidentCoordinationHarness } from "../../../src/coordination-adapter/index.js";

const authority = { approved: true, kind: "m14-bootstrap", operator: "user_owner", resident: "jerry", legacyWriterAuthoritative: true, coordinationFlagsAllFalse: true } as const;

function actualAgent(root: string) {
  const history = new ConversationHistory(join(root, "conversations"), 400_000, "jerry");
  const agent = new AgentLoop({ apiKey: "test", model: "fixture-model", provider: "openai",
    registry: { getAnthropicTools: () => [], getOpenAITools: () => [], get: () => undefined, execute: async () => ({ content: "" }) } as never,
    contextManager: { getSystemPrompt: () => "fixture", getPromptSourceInfo: () => ({ loadedFiles: [] }) } as never,
    history, toolContext: {} as never, workspacePath: root });
  let calls = 0;
  (agent as unknown as { run: AgentLoop["run"] }).run = async () => {
    calls += 1;
    return { text: "Canonical Jerry response.", model: "fixture-model", toolCallCount: 0, durationMs: 1 };
  };
  return { agent, history, calls: () => calls };
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

test("production composition authenticates one direct Message through durable Work and the real AgentLoop boundary", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "home23-production-vertical-")); const runtime = join(root, "instances", ".house", "coordination"); mkdirSync(runtime, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const databasePath = join(runtime, "home23-coordination.sqlite3"), socketPath = join(root, "j.sock"), residentKey = "7".repeat(64), capabilityToken = "9".repeat(64);
  const seeded = await bootstrapJerry({ databasePath, apply: true, authority, serverInstanceId: "home23-jerry-harness", keyVersion: 1 });
  const replayedBootstrap = await bootstrapJerry({ databasePath, apply: true, authority, serverInstanceId: "home23-jerry-harness", keyVersion: 1 });
  assert.deepEqual({ botId: replayedBootstrap.botId, channelId: replayedBootstrap.channelId, conversationId: replayedBootstrap.conversationId }, { botId: seeded.botId, channelId: seeded.channelId, conversationId: seeded.conversationId });
  const token = await accessToken(databasePath, capabilityToken);
  const { agent, history, calls } = actualAgent(root); const rootKey = Buffer.from(residentKey, "hex");
  const credential = createResidentCredential({ residentSlug: "jerry", role: "resident", instanceId: "home23-jerry-harness", keyVersion: 1, rootKey }); rootKey.fill(0);
  let harness = new ResidentTurnUdsServer({ socketPath, serverInstanceId: "home23-jerry-harness", credential, residentSlug: "jerry", agent, history }); await harness.start(); t.after(() => harness.close());
  const flags = { ...disabledCoordinationFeatureFlags(), "coordination.process.enabled": true, "coordination.public_api.enabled": true, "coordination.resident.jerry.enabled": true };
  const config = () => ({ enabled: true, host: "127.0.0.1" as const, port: 0, databasePath, socketPath: join(runtime, "coord.sock"), capabilityToken, flags,
    residents: { jerry: { enabled: true, socketPath, serverInstanceId: "home23-jerry-harness", clientInstanceId: "home23-jerry-harness", keyVersion: 1, key: residentKey }, forrest: { enabled: false, socketPath: join(runtime, "resident-forrest.sock"), serverInstanceId: "home23-forrest-harness", clientInstanceId: "home23-forrest-harness", keyVersion: 1, key: "" } } });
  let process = createCoordinationProcess(config()); let address = await process.start();
  assert.equal((await fetch(`${address.origin}/api/v1/bootstrap`)).status, 401);
  const correlationId = generateCoordinationId("correlation"); const body = { messageId: generateCoordinationId("message"), clientMessageId: "m14-client-message", text: "Jerry, answer canonically.", attachmentIds: [], mentions: [], replyToMessageId: null };
  const send = () => fetch(`${address.origin}/api/v1/channels/${seeded.channelId}/messages`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": "m14-production-message-0001", "x-correlation-id": correlationId }, body: JSON.stringify(body) });
  const first = await send();
  if (first.status !== 202) {
    const failure = await first.text(); await process.drain(); const diagnostic = openCoordinationDatabase({ path: databasePath });
    const counts: Record<string, number | string> = {}; for (const table of ["messages", "works", "attempts", "leases"]) { try { counts[table] = diagnostic.readOne<{ count: number }>(`SELECT count(*) AS count FROM ${table}`)?.count ?? -1; } catch (error) { counts[table] = error instanceof Error ? error.message : String(error); } } diagnostic.close();
    assert.fail(`first send ${failure}; counts=${JSON.stringify(counts)}`);
  }
  for (let i = 0; i < 100 && calls() === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  if (calls() === 0) {
    await process.drain();
    const diagnostic = openCoordinationDatabase({ path: databasePath });
    const work = diagnostic.readOne<Record<string, unknown>>("SELECT * FROM works LIMIT 1");
    const attempt = diagnostic.readOne<Record<string, unknown>>("SELECT * FROM attempts LIMIT 1");
    const lease = diagnostic.readOne<Record<string, unknown>>("SELECT * FROM leases LIMIT 1");
    diagnostic.close();
    assert.fail(`resident was not invoked: ${JSON.stringify({ work, attempt, lease })}`);
  }
  for (let i = 0; i < 100; i += 1) { const events = await fetch(`${address.origin}/api/v1/events?after=0`, { headers: { authorization: `Bearer ${token}` } }); const text = await events.text(); if (text.includes("message.appended") && text.includes(correlationId)) break; await new Promise((resolve) => setTimeout(resolve, 20)); }
  await new Promise((resolve) => setTimeout(resolve, 500));
  const duplicate = await send(); assert.equal(duplicate.status, 202, `duplicate: ${await duplicate.text()}`); assert.equal(calls(), 1); await process.drain();
  const db = openCoordinationDatabase({ path: databasePath });
  for (const table of ["works", "attempts", "leases", "terminal_receipts"] as const) assert.equal(db.readOne<{ count: number }>(`SELECT count(*) AS count FROM ${table}`)?.count, 1);
  assert.equal(db.readOne<{ count: number }>("SELECT count(*) AS count FROM messages WHERE kind='result'")?.count, 1);
  assert.ok((db.readOne<{ count: number }>("SELECT count(*) AS count FROM events WHERE correlation_id=?", correlationId)?.count ?? 0) >= 3); db.close();
  await harness.close(); harness = new ResidentTurnUdsServer({ socketPath, serverInstanceId: "home23-jerry-harness", credential, residentSlug: "jerry", agent, history }); await harness.start();
  process = createCoordinationProcess(config()); address = await process.start(); assert.equal((await send()).status, 202); assert.equal(calls(), 1); await process.drain();
});

test("bootstrap apply refuses without explicit feature-off authority evidence", async () => {
  await assert.rejects(bootstrapJerry({ databasePath: "/tmp/must-not-open.sqlite3", apply: true, serverInstanceId: "home23-jerry-harness", keyVersion: 1 }), /explicit feature-off legacy-authority evidence/);
  const authorityApply = spawnSync(process.execPath, ["scripts/coordination/m14-authority.mjs", "--apply"], { cwd: process.cwd(), encoding: "utf8" });
  assert.notEqual(authorityApply.status, 0);
  assert.match(`${authorityApply.stderr}${authorityApply.stdout}`, /--database and --evidence are required/);
});
