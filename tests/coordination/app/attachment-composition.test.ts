import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AuthError } from "../../../src/coordination/auth/index.js";
import {
  createCoordinationRuntimeComposition,
  disabledCoordinationFeatureFlags,
} from "../../../src/coordination/app/index.js";
import { openCoordinationDatabase } from "../../../src/coordination/db/index.js";
import { createCoordinationHttpServer } from "../../../src/coordination/http/index.js";

const enabledFlags = Object.freeze({
  ...disabledCoordinationFeatureFlags(),
  "coordination.process.enabled": true,
  "coordination.public_api.enabled": true,
});
const directory = {
  getBotByResidentBinding: async () => null,
  resolveAlias: async () => null,
  listVisibleBots: async () => [],
};
const auth = {
  validateAccessToken: async (input: { accessToken: string; requiredScopes: readonly string[] }) => {
    if (input.accessToken === "read-token" && input.requiredScopes.includes("attachment:write")) {
      throw new AuthError("access_scope_denied");
    }
    return {
      principalId: "user_owner" as const,
      deviceId: "dev_0198d95f-6c00-7000-8000-000000000902",
      sessionId: "ses_0198d95f-6c00-7000-8000-000000000902",
      scopes: input.requiredScopes,
    };
  },
};

async function absent(path: string): Promise<boolean> {
  try { await access(path); return false; } catch { return true; }
}

test("raw store alone and incomplete attachment dependencies cannot activate or open paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "home23-composition-incomplete-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const databasePath = join(root, "must-not-open.sqlite3");
  const rootDirectory = join(root, "must-not-open-artifacts");

  for (const attachments of [
    { enabled: true, store: {} },
    { enabled: true, databasePath, rootDirectory },
  ]) {
    const composition = await createCoordinationRuntimeComposition({
      flags: enabledFlags,
      services: { auth },
      attachments: attachments as never,
    });
    assert.equal(composition.application.capabilities().capabilities.attachments, false);
  }
  const smuggled = await createCoordinationRuntimeComposition({
    flags: enabledFlags,
    services: { auth, attachments: { create() {}, getMetadata() {}, openDownload() {} } } as never,
  });
  assert.equal(smuggled.application.capabilities().capabilities.attachments, false);
  assert.equal(await absent(databasePath), true);
  assert.equal(await absent(rootDirectory), true);
});

test("explicit complete feature-off remains unavailable and does not open durable paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "home23-composition-off-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const databasePath = join(root, "must-not-open.sqlite3");
  const rootDirectory = join(root, "must-not-open-artifacts");
  const composition = await createCoordinationRuntimeComposition({
    flags: enabledFlags,
    services: { auth },
    attachments: { enabled: false, databasePath, rootDirectory, participantDirectory: directory },
  });
  assert.equal(composition.application.capabilities().capabilities.attachments, false);
  assert.equal(await absent(databasePath), true);
  assert.equal(await absent(rootDirectory), true);
});

test("explicit complete feature-on advertises and routes only behind auth and scope", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "home23-composition-on-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const databasePath = join(root, "coordination.sqlite3");
  const composition = await createCoordinationRuntimeComposition({
    flags: enabledFlags,
    services: { auth },
    attachments: {
      enabled: true,
      databasePath,
      rootDirectory: join(root, "artifacts"),
      participantDirectory: directory,
    },
  });
  assert.equal(composition.application.capabilities().capabilities.attachments, true);
  const server = createCoordinationHttpServer({
    application: composition.application,
    lifecycle: composition.lifecycle,
    port: 0,
  });
  t.after(() => server.drain());
  const address = await server.start();
  const artifactId = "art_0198d95f-6c00-7000-8000-000000000902";

  const unauthenticated = await fetch(`${address.origin}/api/v1/attachments/${artifactId}`);
  assert.equal(unauthenticated.status, 401);
  const authorized = await fetch(`${address.origin}/api/v1/attachments/${artifactId}`, {
    headers: { authorization: "Bearer read-token" },
  });
  assert.equal(authorized.status, 404);
  assert.equal((await authorized.json() as any).error.code, "not_found");
  const writeWithReadScope = await fetch(`${address.origin}/api/v1/attachments`, {
    method: "POST",
    headers: {
      authorization: "Bearer read-token",
      "idempotency-key": "attachment-key-0002",
      "content-type": "multipart/form-data; boundary=x",
    },
    body: "--x--\r\n",
  });
  assert.equal(writeWithReadScope.status, 403);
  assert.equal((await writeWithReadScope.json() as any).error.code, "access_scope_denied");
});

test("startup failure closes the SQLite resource already owned by composition", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "home23-composition-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const databasePath = join(root, "coordination.sqlite3");
  const missingParent = join(root, "missing-parent");
  await assert.rejects(createCoordinationRuntimeComposition({
    flags: enabledFlags,
    services: { auth },
    attachments: {
      enabled: true,
      databasePath,
      rootDirectory: join(missingParent, "artifacts"),
      participantDirectory: directory,
    },
  }));

  await mkdir(missingParent);
  const reopened = openCoordinationDatabase({ path: databasePath });
  reopened.close();
});
