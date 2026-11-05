import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentLoop } from "../../../src/agent/loop.js";
import { ConversationHistory } from "../../../src/agent/history.js";
import { startResidentCoordinationHarness } from "../../../src/coordination-adapter/index.js";
import { createCoordinationProcess, disabledCoordinationFeatureFlags } from "../../../src/coordination/app/index.js";
import { provisionFreshHouse } from "../../../src/coordination/operations/index.js";
import { generateCoordinationId } from "../../../src/coordination/ids/index.js";

// A local model fixture exercises the real durable AgentLoop/UDS/HTTP path
// without consuming a provider account or contacting an installed home.
test("fresh arbitrary resident pairs, answers through canonical Work, and retains its home across restart", async t => {
  const root = mkdtempSync(join(tmpdir(), "h23-fresh-runtime-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = join(root, "coordination");
  const workspacePath = join(root, "workspace");
  mkdirSync(runtime); mkdirSync(workspacePath);
  let calls = 0;
  const model = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain model request */ }
    calls++;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Milo remembers this home." } }] }));
  });
  await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => model.close(() => resolve())));
  const prior = { HOME23_ROOT: process.env.HOME23_ROOT, HOME23_AGENT: process.env.HOME23_AGENT, LOCAL_LLM_BASE_URL: process.env.LOCAL_LLM_BASE_URL };
  process.env.HOME23_ROOT = root; process.env.HOME23_AGENT = "milo";
  process.env.LOCAL_LLM_BASE_URL = `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`;
  t.after(() => { for (const [name, value] of Object.entries(prior)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  const databasePath = join(runtime, "house.sqlite3");
  const input = { databasePath, home: { id: "home_0198d95f-6c00-7000-8000-000000000001", name: "River Home" }, resident: { slug: "milo", name: "Milo", purpose: "Help River think and build." } };
  const birth = await provisionFreshHouse(input);
  const history = new ConversationHistory(join(root, "conversations"), 400_000, "milo");
  const agent = new AgentLoop({ apiKey: "test", model: "fixture-local-model", provider: "ollama-local",
    registry: { getAnthropicTools: () => [], getOpenAITools: () => [], get: () => undefined, execute: async () => ({ content: "" }) } as never,
    contextManager: { getSystemPrompt: () => "You are Milo.", getPromptSourceInfo: () => ({ loadedFiles: [] }) } as never,
    history, toolContext: { brainOperations: { searchContext: async () => ({ results: [], sourceEvidence: { sourceHealth: "healthy", matchOutcome: "no_match" } }) } } as never, workspacePath });
  const key = "b".repeat(64), capabilityToken = "c".repeat(64);
  const residentSocket = join(root, "m.sock");
  const harness = await startResidentCoordinationHarness({ agent, history, environment: {
    HOME23_ROOT: root, HOME23_AGENT: "milo", HOME23_COORDINATION_RESIDENT_ENABLED: "true", HOME23_COORDINATION_RESIDENT_SOCKET_PATH: residentSocket,
    HOME23_COORDINATION_RESIDENT_SERVER_INSTANCE_ID: "home23-milo-harness", HOME23_COORDINATION_RESIDENT_CLIENT_INSTANCE_ID: "home23-milo-harness",
    HOME23_COORDINATION_RESIDENT_KEY_VERSION: "1", HOME23_COORDINATION_RESIDENT_KEY: key,
  } });
  assert.ok(harness);
  t.after(() => harness.close());
  const config = {
    enabled: true, host: "127.0.0.1" as const, port: 0, databasePath, socketPath: join(runtime, "coord.sock"),
    botRootDirectory: join(root, "bots"), capabilityToken,
    home: { ...input.home, primaryResident: "milo" }, activity: { enabled: true },
    attachments: { enabled: true, rootDirectory: join(runtime, "attachments"), maximumBytes: 1024 * 1024, maximumCountPerMessage: 10 },
    flags: { ...disabledCoordinationFeatureFlags(), "coordination.process.enabled": true, "coordination.public_api.enabled": true,
      "coordination.channels.enabled": true, "coordination.search.canonical": true, "coordination.bot_lifecycle.enabled": true },
    residents: { milo: { enabled: true, socketPath: residentSocket, serverInstanceId: "home23-milo-harness", clientInstanceId: "home23-milo-harness", keyVersion: 1, key } },
  };
  let core = createCoordinationProcess(config);
  t.after(() => core.drain());
  let address = await core.start();
  const post = async (path: string, body: unknown, key: string, token?: string) => {
    const response = await fetch(`${address.origin}${path}`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    const value = await response.json();
    assert.ok(response.ok, `${response.status}: ${JSON.stringify(value)}`);
    return value as any;
  };
  const pairing = await post("/api/v1/pairing/sessions", { deviceName: "River phone" }, "fresh-runtime-pairing");
  const paired = await post(`/api/v1/pairing/sessions/${pairing.pairingSession.id}/redeem`, { pairingCode: pairing.pairingCode, device: { name: "River phone", platform: "ios", appBuild: "135" } }, "fresh-runtime-redeem");
  const headers = { authorization: `Bearer ${paired.accessToken}` };
  const read = async (path: string) => {
    const response = await fetch(`${address.origin}${path}`, { headers });
    assert.equal(response.status, 200);
    return response.json() as Promise<any>;
  };
  const bootstrap = await read("/api/v1/bootstrap");
  assert.deepEqual(bootstrap.home, { ...input.home, primaryBotId: birth.botId });
  assert.equal(bootstrap.snapshot.bots.length, 1);
  assert.equal(bootstrap.snapshot.bots[0].name, "Milo");
  assert.equal(bootstrap.snapshot.bots[0].availability, "available");
  assert.equal(bootstrap.capabilities.channels, true);
  assert.equal(bootstrap.capabilities.attachments, true);
  assert.equal(bootstrap.capabilities.botLifecycle, true);
  assert.equal(bootstrap.capabilities.search, true);
  const capabilities = await read("/api/v1/capabilities");
  assert.equal(capabilities.capabilities.messageSubmission, true);
  assert.equal(capabilities.capabilities.activity, true);
  await post(`/api/v1/channels/${birth.channelId}/messages`, { messageId: generateCoordinationId("message"), clientMessageId: "milo-first-message", text: "Milo, remember this home.", attachmentIds: [], mentions: [], replyToMessageId: null }, "fresh-runtime-first-message", paired.accessToken);
  let results: any[] = [];
  for (let i = 0; i < 150; i++) {
    results = (await read(`/api/v1/channels/${birth.channelId}/messages`)).messages.filter((message: any) => message.kind === "result");
    if (results.length) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(results[0]?.text, "Milo remembers this home.");
  assert.equal(calls, 1);
  await core.drain();
  assert.equal((await provisionFreshHouse(input)).botId, birth.botId);
  core = createCoordinationProcess(config); address = await core.start();
  const restarted = await read("/api/v1/bootstrap");
  assert.deepEqual(restarted.home, bootstrap.home);
  assert.equal(restarted.snapshot.bots.length, 1);
  assert.equal((await read(`/api/v1/channels/${birth.channelId}/messages`)).messages.some((message: any) => message.text === "Milo remembers this home."), true);
});
