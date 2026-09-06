import assert from "node:assert/strict";
import test from "node:test";

import {
  UuidV7Generator,
  assertCoordinationId,
  generateCoordinationId,
  isUuidV7,
  validateCoordinationId,
} from "../../../src/coordination/ids/index.js";

const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("UUIDv7 generation stays unique and lexically monotonic within one millisecond", () => {
  const generator = new UuidV7Generator({
    now: () => 1_700_000_000_000,
    randomBytes: (size) => Buffer.alloc(size, 0x23),
  });

  const ids = Array.from({ length: 1_000 }, () => generator.generate());

  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual([...ids].sort(), ids);
  for (const id of ids) {
    assert.match(id, UUID_V7_PATTERN);
    assert.equal(isUuidV7(id), true);
  }
});

test("UUIDv7 generation remains monotonic when the wall clock moves backward", () => {
  const times = [1_700_000_000_002, 1_700_000_000_001, 1_700_000_000_000];
  const generator = new UuidV7Generator({
    now: () => times.shift() ?? 1_700_000_000_000,
    randomBytes: (size) => Buffer.alloc(size, 0x42),
  });

  const ids = [generator.generate(), generator.generate(), generator.generate()];

  assert.deepEqual([...ids].sort(), ids);
  assert.equal(new Set(ids).size, ids.length);
});

test("coordination IDs use the exact M02 prefixes and UUIDv7 validation", () => {
  const expectedPrefixes = {
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
    request: "req_",
    round: "rnd_",
    work: "wrk_",
    workObservation: "obs_",
  } as const;
  const generator = new UuidV7Generator({
    now: () => 1_700_000_000_000,
    randomBytes: (size) => Buffer.alloc(size, 0x55),
  });

  for (const [kind, prefix] of Object.entries(expectedPrefixes)) {
    const id = generateCoordinationId(
      kind as keyof typeof expectedPrefixes,
      generator,
    );
    assert.equal(id.startsWith(prefix), true, `${kind} must use ${prefix}`);
    assert.equal(validateCoordinationId(kind as keyof typeof expectedPrefixes, id), true);
    assert.doesNotThrow(() =>
      assertCoordinationId(kind as keyof typeof expectedPrefixes, id),
    );
  }

  assert.equal(validateCoordinationId("principal", "user_owner"), true);
  const botId = generateCoordinationId("bot", generator);
  assert.equal(validateCoordinationId("principal", botId), true);
});

test("coordination ID validation rejects wrong prefixes and noncanonical UUIDs", () => {
  const canonical = "0198d95f-6c00-7000-8000-000000000021";

  assert.equal(validateCoordinationId("channel", `channel_${canonical}`), false);
  assert.equal(validateCoordinationId("channel", `chn_${canonical.toUpperCase()}`), false);
  assert.equal(
    validateCoordinationId("channel", "chn_0198d95f-6c00-4000-8000-000000000021"),
    false,
  );
  assert.equal(isUuidV7("0198d95f-6c00-4000-8000-000000000021"), false);
  assert.throws(
    () => assertCoordinationId("channel", `msg_${canonical}`),
    /invalid channel ID/,
  );
});
