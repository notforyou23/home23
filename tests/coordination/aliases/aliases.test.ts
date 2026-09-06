import assert from "node:assert/strict";
import test from "node:test";

import {
  digestLegacyAlias,
  planAliasBinding,
  resolveAlias,
  type AliasBinding,
} from "../../../src/coordination/aliases/index.js";

const ALIAS_ID = "alias_0198d95f-6c00-7000-8000-000000000094";
const MESSAGE_ID = "msg_0198d95f-6c00-7000-8000-000000000041";
const OTHER_MESSAGE_ID = "msg_0198d95f-6c00-7000-8000-000000000042";

function binding(overrides: Partial<AliasBinding> = {}): AliasBinding {
  return {
    id: ALIAS_ID,
    namespace: "legacy-session",
    aliasDigest: digestLegacyAlias("legacy-session", "session-42"),
    targetType: "message",
    targetId: MESSAGE_ID,
    active: true,
    createdAt: "2026-08-25T12:00:00.000Z",
    updatedAt: "2026-08-25T12:00:00.000Z",
    ...overrides,
  };
}

test("alias bindings persist only an exact namespace digest and canonical target", () => {
  const plan = planAliasBinding([], {
    id: ALIAS_ID,
    namespace: "legacy-session",
    legacyId: "session-42",
    targetType: "message",
    targetId: MESSAGE_ID,
    createdAt: "2026-08-25T12:00:00.000Z",
    updatedAt: "2026-08-25T12:00:00.000Z",
  });

  assert.equal(plan.decision, "create");
  assert.match(plan.binding?.aliasDigest ?? "", /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(plan).includes("session-42"), false);
  assert.equal(JSON.stringify(plan).includes("sourceId"), false);
  assert.equal(JSON.stringify(plan).includes("importKeyDigest"), false);
  assert.equal(plan.binding?.targetId, MESSAGE_ID);
  assert.equal(Object.isFrozen(plan.binding), true);
});

test("the same exact alias and target is idempotently already bound", () => {
  const existing = binding();
  const plan = planAliasBinding([existing], {
    id: "alias_0198d95f-6c00-7000-8000-000000000095",
    namespace: "legacy-session",
    legacyId: "session-42",
    targetType: "message",
    targetId: MESSAGE_ID,
    createdAt: "2026-08-25T12:00:00.000Z",
    updatedAt: "2026-08-25T12:00:00.000Z",
  });

  assert.equal(plan.decision, "already_bound");
  assert.deepEqual(plan.binding, existing);

  const exactReplay = planAliasBinding([existing], {
    id: ALIAS_ID,
    namespace: "legacy-session",
    legacyId: "session-42",
    targetType: "message",
    targetId: MESSAGE_ID,
    createdAt: "2026-08-25T12:00:00.000Z",
    updatedAt: "2026-08-25T12:00:00.000Z",
  });
  assert.equal(exactReplay.decision, "already_bound");
  assert.deepEqual(exactReplay.binding, existing);
});

test("an alias collision is denied rather than guessed or rebound", () => {
  const plan = planAliasBinding([binding()], {
    id: "alias_0198d95f-6c00-7000-8000-000000000095",
    namespace: "legacy-session",
    legacyId: "session-42",
    targetType: "message",
    targetId: OTHER_MESSAGE_ID,
    createdAt: "2026-08-25T12:00:00.000Z",
    updatedAt: "2026-08-25T12:00:00.000Z",
  });

  assert.deepEqual(plan, {
    decision: "denied",
    reason: "alias_collision",
    aliasDigest: digestLegacyAlias("legacy-session", "session-42"),
  });
});

test("resolution is exact and never applies case or whitespace heuristics", () => {
  const existing = [binding()];

  assert.equal(resolveAlias(existing, "legacy-session", "session-42").decision, "resolved");
  assert.deepEqual(resolveAlias(existing, "legacy-session", "Session-42"), {
    decision: "not_found",
    reason: "no_exact_alias",
  });
  assert.deepEqual(resolveAlias(existing, "legacy-session", "session-42 "), {
    decision: "not_found",
    reason: "no_exact_alias",
  });
  assert.deepEqual(resolveAlias(existing, "other-namespace", "session-42"), {
    decision: "not_found",
    reason: "no_exact_alias",
  });
});

test("inactive aliases stay reserved and stored collisions fail closed", () => {
  const inactive = binding({ active: false });
  const rebinding = planAliasBinding([inactive], {
    id: "alias_0198d95f-6c00-7000-8000-000000000095",
    namespace: "legacy-session",
    legacyId: "session-42",
    targetType: "message",
    targetId: MESSAGE_ID,
    createdAt: "2026-08-25T12:00:00.000Z",
    updatedAt: "2026-08-25T12:00:00.000Z",
  });
  assert.equal(rebinding.decision, "denied");
  assert.equal(rebinding.reason, "inactive_alias_reserved");

  const collided = resolveAlias(
    [binding(), binding({ id: "alias_0198d95f-6c00-7000-8000-000000000095", targetId: OTHER_MESSAGE_ID })],
    "legacy-session",
    "session-42",
  );
  assert.deepEqual(collided, { decision: "denied", reason: "stored_alias_collision" });

  const activeAndInactive = resolveAlias(
    [binding(), binding({ id: "alias_0198d95f-6c00-7000-8000-000000000096", active: false })],
    "legacy-session",
    "session-42",
  );
  assert.deepEqual(activeAndInactive, { decision: "denied", reason: "stored_alias_collision" });

  const inactiveCollision = resolveAlias(
    [inactive, binding({ id: "alias_0198d95f-6c00-7000-8000-000000000096", active: false })],
    "legacy-session",
    "session-42",
  );
  assert.deepEqual(inactiveCollision, { decision: "denied", reason: "stored_alias_collision" });
});

test("malformed stored aliases fail closed before resolution", () => {
  const malformedTarget = binding({ targetId: "not-a-message-id" });
  assert.deepEqual(
    resolveAlias([malformedTarget], "legacy-session", "session-42"),
    { decision: "denied", reason: "invalid_stored_alias" },
  );

  const malformedTimestamp = binding({ updatedAt: "not-a-timestamp" });
  assert.deepEqual(
    resolveAlias([malformedTimestamp], "legacy-session", "session-42"),
    { decision: "denied", reason: "invalid_stored_alias" },
  );

  const replanning = planAliasBinding([malformedTimestamp], {
    id: ALIAS_ID,
    namespace: "legacy-session",
    legacyId: "session-42",
    targetType: "message",
    targetId: MESSAGE_ID,
    createdAt: "2026-08-25T12:00:00.000Z",
    updatedAt: "2026-08-25T12:00:00.000Z",
  });
  assert.equal(replanning.decision, "denied");
  assert.equal(replanning.reason, "invalid_stored_alias");
});
