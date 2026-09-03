import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CONNECTED_AGENTS_CONTRACT_PACK_SHA256,
  CONNECTED_AGENTS_CONTRACT_VERSION,
  computeContractPackDigest,
  fixtureNames,
  loadCanonicalFixture,
  openApiOperationIds,
  renderAppleCanonicalFixtures,
  validateCanonicalFixture,
  validatePackInventory,
} from "../../../src/coordination/contracts/contract-pack.js";
import {
  API_OPERATION_REGISTRY,
  AUTHORITY_EPOCH_REGISTRY,
  FEATURE_FLAG_REGISTRY,
  ID_REGISTRY,
  PROTOCOL_REGISTRY,
  PUBLIC_ENUM_REGISTRY,
  STATE_MACHINE_REGISTRY,
  decodePublicEnum,
  isLegalTransition,
  validateContractId,
} from "../../../src/coordination/schema/contract-registry.js";

const EXPECTED_FIXTURES = [
  "attachment",
  "bootstrap",
  "bots",
  "channel-direct",
  "channel-group",
  "conversations",
  "error",
  "event-cursor-reset",
  "event-message-appended",
  "import-provenance",
  "messages-mentions",
  "pairing-session",
  "resident-presence-admission-while-work",
  "resident-presence-cursor-reconnect",
  "resident-presence-one-result",
  "resident-presence-projections",
  "search",
  "unread-read-cursor",
  "work-attempt-lease-activity",
] as const;

const EXPECTED_ID_KINDS = [
  "alias",
  "artifact",
  "attempt",
  "bot",
  "channel",
  "clientSession",
  "contextManifest",
  "conversation",
  "correlation",
  "delivery",
  "device",
  "event",
  "home",
  "importCohort",
  "importItem",
  "lease",
  "legacySource",
  "message",
  "outbox",
  "pairingSession",
  "principal",
  "request",
  "round",
  "work",
  "workObservation",
] as const;

const EXPECTED_FLAGS = [
  "coordination.apple.iphone_cutover",
  "coordination.apple.mac_cutover",
  "coordination.bot_lifecycle.enabled",
  "coordination.channels.enabled",
  "coordination.compaction.enabled",
  "coordination.import.shadow_enabled",
  "coordination.process.enabled",
  "coordination.public_api.enabled",
  "coordination.resident.forrest.enabled",
  "coordination.resident.jerry.enabled",
  "coordination.search.canonical",
] as const;

const CAPABILITY_KEYS = [
  "bootstrap",
  "channelsRead",
  "channelMutation",
  "conversationsRead",
  "messagesRead",
  "unreadRead",
  "messageSubmission",
  "readCursorMutation",
  "search",
  "eventReplay",
  "attachments",
  "work",
  "workMutation",
  "activity",
  "botLifecycle",
  "importShadow",
] as const;

test("canonical fixtures validate and the pack digest is deterministic", () => {
  assert.equal(CONNECTED_AGENTS_CONTRACT_VERSION, 1);
  assert.match(CONNECTED_AGENTS_CONTRACT_PACK_SHA256, /^[a-f0-9]{64}$/);
  assert.equal(computeContractPackDigest(), CONNECTED_AGENTS_CONTRACT_PACK_SHA256);
  assert.deepEqual(validatePackInventory(), []);
  assert.deepEqual(fixtureNames(), [...EXPECTED_FIXTURES]);

  for (const name of EXPECTED_FIXTURES) {
    const result = validateCanonicalFixture(name);
    assert.equal(result.valid, true, `${name}: ${result.errors.join("\n")}`);
  }
});

test("capability OpenAPI locks every composition truth consumed by clients", () => {
  const openApi = JSON.parse(readFileSync(
    new URL("../../../src/coordination/contracts/v1/openapi.json", import.meta.url),
    "utf8",
  )) as any;
  const schema = openApi.paths["/api/v1/capabilities"].get
    .responses["200"].content["application/json"].schema;

  assert.deepEqual(schema.required, [
    "contractVersion",
    "apiBase",
    "pairingAvailable",
    "limits",
    "capabilities",
  ]);
  assert.deepEqual(schema.properties.limits.required, [
    "jsonBodyBytes",
    "idempotencyKeyMinimum",
    "idempotencyKeyMaximum",
  ]);
  assert.deepEqual(schema.properties.capabilities.required, CAPABILITY_KEYS);
  for (const key of CAPABILITY_KEYS) {
    assert.equal(schema.properties.capabilities.properties[key].type, "boolean");
  }
  assert.equal(schema.properties.capabilities.additionalProperties, true);
});

test("registry locks IDs, flags, authority epochs, and API operations", () => {
  assert.deepEqual(Object.keys(ID_REGISTRY).sort(), [...EXPECTED_ID_KINDS]);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(ID_REGISTRY)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([kind, rule]) => [kind, rule.prefix]),
    ),
    {
      alias: "alias_",
      artifact: "art_",
      attempt: "att_",
      bot: "bot_",
      channel: "chn_",
      clientSession: "ses_",
      contextManifest: "ctx_",
      conversation: "cnv_",
      correlation: "cor_",
      delivery: "dlv_",
      device: "dev_",
      event: "evt_",
      home: "home_",
      importCohort: "imp_",
      importItem: "imi_",
      lease: "lse_",
      legacySource: "legacy_",
      message: "msg_",
      outbox: "obx_",
      pairingSession: "pair_",
      principal: null,
      request: "req_",
      round: "rnd_",
      work: "wrk_",
      workObservation: "obs_",
    },
  );
  assert.deepEqual(Object.keys(FEATURE_FLAG_REGISTRY).sort(), [...EXPECTED_FLAGS]);
  assert.ok(Object.values(FEATURE_FLAG_REGISTRY).every((flag) => flag.default === false));
  assert.deepEqual(AUTHORITY_EPOCH_REGISTRY.capabilities, [
    "messages",
    "roster",
    "unread",
    "search",
    "attachments",
    "activity",
    "bot_lifecycle",
  ]);
  assert.deepEqual(AUTHORITY_EPOCH_REGISTRY.modes, ["legacy", "shadow", "canonical"]);
  assert.equal(AUTHORITY_EPOCH_REGISTRY.mutationPolicy, "append_new_epoch");

  const protocol = PROTOCOL_REGISTRY as {
    errorEnvelope: { required: string[]; safeDetailsOnly: boolean };
    idempotency: {
      length: { minimum: number; maximum: number };
      sameDigest: string;
      differentDigest: string;
      allMutations: boolean;
    };
    events: {
      durableSequence: string;
      resume: string;
      gap: string;
      malformedEnvelope: string;
    };
  };
  assert.deepEqual(protocol.errorEnvelope.required, [
    "code",
    "message",
    "retryable",
    "requestId",
    "details",
  ]);
  assert.equal(protocol.errorEnvelope.safeDetailsOnly, true);
  assert.deepEqual(protocol.idempotency.length, { minimum: 16, maximum: 128 });
  assert.equal(protocol.idempotency.sameDigest, "return original committed response");
  assert.equal(protocol.idempotency.differentDigest, "409 idempotency_conflict");
  assert.equal(protocol.idempotency.allMutations, true);
  assert.equal(protocol.events.durableSequence, "integer global sequence");
  assert.equal(protocol.events.resume, "strictly_after");
  assert.equal(protocol.events.gap, "409 cursor_expired with bootstrapRequired");
  assert.equal(protocol.events.malformedEnvelope, "reject without advancing cursor");

  assert.equal(validateContractId("principal", "user_owner"), true);
  assert.equal(
    validateContractId("channel", "chn_0198d95f-6c00-7000-8000-000000000021"),
    true,
  );
  assert.equal(
    validateContractId("channel", "channel_0198d95f-6c00-7000-8000-000000000021"),
    false,
  );
  assert.equal(validateContractId("artifact", "att_not-an-artifact"), false);

  const registryOperations = new Set(Object.keys(API_OPERATION_REGISTRY));
  assert.deepEqual(new Set(openApiOperationIds()), registryOperations);
});

test("terminal policies and legal transitions reject lifecycle corruption", () => {
  assert.equal(isLegalTransition("work", "queued", "leased"), true);
  assert.equal(isLegalTransition("work", "succeeded", "running"), false);
  assert.equal(isLegalTransition("attempt", "accepted", "running"), true);
  assert.equal(isLegalTransition("attempt", "offered", "running"), false);
  assert.equal(isLegalTransition("lease", "active", "expired"), true);
  assert.equal(isLegalTransition("messageVisibility", "tombstoned", "visible"), false);

  assert.deepEqual(STATE_MACHINE_REGISTRY.work.terminal, [
    "succeeded",
    "failed",
    "cancelled",
  ]);
  assert.equal(STATE_MACHINE_REGISTRY.work.terminalPolicy, "immutable");
  assert.equal(STATE_MACHINE_REGISTRY.authorityEpoch.terminalPolicy, "records_are_immutable");
});

test("unknown fields are additive while enum behavior is deliberate", () => {
  const bootstrap = loadCanonicalFixture("bootstrap") as Record<string, unknown>;
  const additive = {
    ...bootstrap,
    futureServerField: { nested: true },
  };
  assert.equal(validateCanonicalFixture("bootstrap", additive).valid, true);

  assert.equal(PUBLIC_ENUM_REGISTRY.botAvailability.unknownPolicy, "preserve");
  assert.deepEqual(decodePublicEnum("botAvailability", "future_available"), {
    kind: "unknown",
    rawValue: "future_available",
    action: "diagnostic_attention",
  });

  assert.equal(PUBLIC_ENUM_REGISTRY.channelKind.unknownPolicy, "reject");
  assert.throws(
    () => decodePublicEnum("channelKind", "external"),
    /unknown channelKind value/,
  );

  assert.equal(PUBLIC_ENUM_REGISTRY.eventType.unknownPolicy, "ignore_and_advance_cursor");
  assert.deepEqual(decodePublicEnum("eventType", "future.event"), {
    kind: "unknown",
    rawValue: "future.event",
    action: "ignore_and_advance_cursor",
  });
});

test("canonical error and event fixtures preserve their exact wire envelopes", () => {
  for (const name of EXPECTED_FIXTURES) {
    const fixture = loadCanonicalFixture(name) as Record<string, unknown>;
    assert.equal("fixtureKind" in fixture, false, `${name} leaked fixture metadata`);
  }

  const error = loadCanonicalFixture("error") as Record<string, unknown>;
  assert.deepEqual(Object.keys(error), ["error"]);

  const event = loadCanonicalFixture("event-message-appended") as Record<string, unknown>;
  assert.equal("event" in event, false);
  assert.equal(event.type, "message.appended");
  assert.equal(event.sequence, 128);
});

test("generated Apple source carries the exact Core version, digest, and fixtures", () => {
  const swift = renderAppleCanonicalFixtures();
  assert.match(swift, /contractVersion: Int = 1/);
  assert.match(swift, new RegExp(CONNECTED_AGENTS_CONTRACT_PACK_SHA256));
  for (const name of EXPECTED_FIXTURES) {
    assert.match(swift, new RegExp(`\\"${name}\\"`));
  }
});
