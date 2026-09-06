import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createCoordinationApplication,
  disabledCoordinationFeatureFlags,
} from "../../../src/coordination/app/index.js";
import { SqliteCommunicationEventRepository } from "../../../src/coordination/communications/index.js";
import { openCoordinationDatabase } from "../../../src/coordination/db/index.js";
import { createCoordinationHttpServer } from "../../../src/coordination/http/index.js";

const UUID = "0198d95f-6c00-7000-8000-000000000021";
const REQUEST_ID = `req_${UUID}`;
const CORRELATION_ID = `cor_${UUID}`;

test("authorized communication history exposes the canonical envelope and explicit cursor reset", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "home23-communication-http-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const database = openCoordinationDatabase({ path: join(directory, "coordination.sqlite3") });
  const communications = new SqliteCommunicationEventRepository(database);
  communications.append({
    requestId: REQUEST_ID,
    correlationId: CORRELATION_ID,
    event: {
      eventId: `cevt_${UUID}`,
      conversationId: `cnv_${UUID}`,
      channelId: `chn_${UUID}`,
      turnId: "turn_http_1",
      actor: {
        principalId: `bot_${UUID}`,
        displayName: "Jerry",
        kind: "resident_bot",
      },
      source: {
        system: "provider",
        provider: "openai-codex",
        model: "gpt-5.6",
        sourceEventType: "response.output_text.delta",
      },
      kind: "assistant_response_delta",
      occurredAt: "2026-08-27T12:00:00.000Z",
      payload: { text: "exact delta" },
      terminal: false,
      additionalFields: { futureEnvelope: { retained: true } },
    },
  });

  const application = createCoordinationApplication({
    flags: {
      ...disabledCoordinationFeatureFlags(),
      "coordination.process.enabled": true,
      "coordination.public_api.enabled": true,
    },
    services: {
      auth: {
        validateAccessToken: async () => ({
          principalId: "user_owner" as const,
          deviceId: `dev_${UUID}`,
          sessionId: `ses_${UUID}`,
          scopes: ["product:read", "message:send", "attachment:write"],
        }),
      },
      communications,
    },
  });
  assert.equal(application.capabilities().capabilities.communicationEvidence, true);
  const server = createCoordinationHttpServer({ application, port: 0 });
  t.after(async () => {
    await server.drain();
    database.close();
  });
  const address = await server.start();
  const headers = {
    authorization: "Bearer fixture",
    "x-correlation-id": CORRELATION_ID,
  };

  const response = await fetch(
    `${address.origin}/api/v1/communications/events?after=0&limit=10`,
    { headers },
  );
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.equal(body.kind, "events");
  assert.equal(body.events.length, 1);
  assert.equal(body.events[0].schemaVersion, 1);
  assert.equal(body.events[0].eventId, `cevt_${UUID}`);
  assert.equal(body.events[0].eventSequence, 1);
  assert.equal(body.events[0].payload.text, "exact delta");
  assert.deepEqual(body.events[0].futureEnvelope, { retained: true });
  assert.equal(body.events[0].additionalFields, undefined);

  const ahead = await fetch(
    `${address.origin}/api/v1/communications/events?after=2&limit=10`,
    { headers },
  );
  assert.equal(ahead.status, 409);
  const reset = await ahead.json() as any;
  assert.equal(reset.error.code, "cursor_expired");
  assert.equal(reset.error.details.bootstrapRequired, true);
  assert.equal(reset.error.details.reason, "cursor_ahead");
});
