import assert from "node:assert/strict";
import test from "node:test";

import {
  createMessagingFixture,
  ownerContext,
  residentContext,
} from "../messaging/test-fixture.js";

test("artifact admission requires attachment:write and an attachment-capable resident binding", async (t) => {
  const fixture = await createMessagingFixture();
  t.after(fixture.close);
  const artifacts = await import("../../../src/coordination/artifacts/index.js").catch(
    (error: unknown) => assert.fail(`M10 artifact admission is unavailable: ${String(error)}`),
  );

  await assert.rejects(
    artifacts.resolveArtifactActor(
      ownerContext(891, ["product:read"]),
      fixture.directory,
    ),
    (error: unknown) =>
      error instanceof artifacts.ArtifactError && error.code === "scope_denied",
  );
  const owner = await artifacts.resolveArtifactActor(
    ownerContext(892, ["attachment:write"]),
    fixture.directory,
  );
  assert.deepEqual(
    { principalId: owner.principalId, kind: owner.kind, residentCredential: owner.residentCredential },
    { principalId: "user_owner", kind: "owner", residentCredential: null },
  );

  const jerryContext = residentContext(fixture.bots.jerry, "jerry", 893);
  await assert.rejects(
    artifacts.resolveArtifactActor(jerryContext, fixture.directory),
    (error: unknown) =>
      error instanceof artifacts.ArtifactError && error.code === "scope_denied",
  );
  fixture.database.raw.prepare(
    `UPDATE bots
     SET required_capabilities_json = ?, resident_capabilities_json = ?
     WHERE id = ?`,
  ).run(
    JSON.stringify(["attachments", "messages"]),
    JSON.stringify(["attachments", "messages"]),
    fixture.bots.jerry.id,
  );
  const jerry = await artifacts.resolveArtifactActor(jerryContext, fixture.directory);
  assert.deepEqual(
    {
      principalId: jerry.principalId,
      kind: jerry.kind,
      residentBinding: jerry.residentCredential?.residentBinding,
    },
    {
      principalId: fixture.bots.jerry.principalId,
      kind: "bot",
      residentBinding: "jerry",
    },
  );
});

test("artifact reads accept attachment-only residents without borrowing the Message capability", async (t) => {
  const fixture = await createMessagingFixture();
  t.after(fixture.close);
  const artifacts = await import("../../../src/coordination/artifacts/index.js");
  const ownerReader = await artifacts.resolveArtifactReader(
    ownerContext(895, ["product:read"]),
    fixture.directory,
  );
  assert.equal(ownerReader.principalId, "user_owner");
  fixture.database.raw.prepare(
    `UPDATE bots
     SET required_capabilities_json = ?, resident_capabilities_json = ?
     WHERE id = ?`,
  ).run(
    JSON.stringify(["attachments"]),
    JSON.stringify(["attachments"]),
    fixture.bots.jerry.id,
  );

  const reader = await artifacts.resolveArtifactReader(
    residentContext(fixture.bots.jerry, "jerry", 894),
    fixture.directory,
  );

  assert.deepEqual(
    {
      principalId: reader.principalId,
      kind: reader.kind,
      residentBinding: reader.residentCredential?.residentBinding,
    },
    {
      principalId: fixture.bots.jerry.principalId,
      kind: "bot",
      residentBinding: "jerry",
    },
  );
});
