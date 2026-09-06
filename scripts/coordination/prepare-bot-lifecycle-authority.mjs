#!/usr/bin/env node

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  timingSafeEqual,
  verify,
} from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  writeSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const KEY_ID = "r6-operator-ed25519-1";
const FEATURE_OFF_WRITER = "feature-off-bot-lifecycle-disabled";
const CANONICAL_WRITER = "home23-coordination";
const RELEASE_ID_PATTERN = /^[a-f0-9]{40}$/;

function fail(message) {
  throw new Error(`Bot lifecycle authority evidence refused: ${message}`);
}

function parseArguments(argv) {
  const allowed = new Set(["--mode", "--operator-root", "--snapshot", "--out"]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(name) || !value || value.startsWith("--") || values.has(name)) {
      fail("usage: --mode shadow|canonical --operator-root <path> --snapshot <verified-backup.sqlite3> --out <new-path>");
    }
    values.set(name, value);
  }
  if (argv.length !== allowed.size * 2 || values.size !== allowed.size) {
    fail("usage: --mode shadow|canonical --operator-root <path> --snapshot <verified-backup.sqlite3> --out <new-path>");
  }
  const mode = values.get("--mode");
  if (mode !== "shadow" && mode !== "canonical") {
    fail("mode must be shadow or canonical");
  }
  return {
    mode,
    operatorRoot: values.get("--operator-root"),
    snapshot: values.get("--snapshot"),
    output: values.get("--out"),
  };
}

function canonicalDirectory(input, label, privateDirectory = false) {
  if (!isAbsolute(input) || input.includes("\0")) fail(`${label} must be absolute`);
  const path = resolve(input);
  const entry = lstatSync(path);
  if (!entry.isDirectory() || entry.isSymbolicLink() || realpathSync(path) !== path) {
    fail(`${label} must be a canonical nonsymlink directory`);
  }
  if (privateDirectory && (entry.mode & 0o077) !== 0) {
    fail(`${label} must not be accessible to group or other users`);
  }
  return path;
}

function canonicalPrivateFile(input, label, maximumBytes = null) {
  if (!isAbsolute(input) || input.includes("\0")) fail(`${label} must be absolute`);
  const path = resolve(input);
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink() || realpathSync(path) !== path) {
    fail(`${label} must be a canonical regular nonsymlink file`);
  }
  if ((entry.mode & 0o077) !== 0) {
    fail(`${label} must not be accessible to group or other users`);
  }
  if (maximumBytes !== null && entry.size > maximumBytes) {
    fail(`${label} exceeds its byte limit`);
  }
  return path;
}

function containedPath(root, input, label) {
  const inside = relative(root, input);
  if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    fail(`${label} must remain inside the coordination operator root`);
  }
}

function stableFileDigest(path) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) fail("snapshot is not a regular file");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let byteLength = 0;
    while (true) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      byteLength += bytesRead;
    }
    const after = fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || byteLength !== before.size) {
      fail("snapshot changed while its digest was computed");
    }
    return { sha256: hash.digest("hex"), byteLength };
  } finally {
    closeSync(descriptor);
  }
}

function writeExclusive(path, value) {
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  const directory = openSync(dirname(path), constants.O_RDONLY);
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

const input = parseArguments(process.argv.slice(2));
const operatorRoot = canonicalDirectory(input.operatorRoot, "operator root", true);
const releasesRoot = realpathSync(join(operatorRoot, "releases"));
const scriptPath = realpathSync(fileURLToPath(import.meta.url));
const releaseRoot = realpathSync(resolve(dirname(scriptPath), "..", ".."));
const releaseId = basename(releaseRoot);
if (!RELEASE_ID_PATTERN.test(releaseId) || releaseRoot !== join(releasesRoot, releaseId)) {
  fail("script must run from one materialized immutable coordination release");
}

const liveDatabasePath = join(operatorRoot, "home23-coordination.sqlite3");
const snapshotPath = canonicalPrivateFile(input.snapshot, "verified snapshot");
containedPath(operatorRoot, snapshotPath, "verified snapshot");
if (snapshotPath === liveDatabasePath) fail("live coordination database is not an evidence snapshot");
const manifestPath = canonicalPrivateFile(`${snapshotPath}.manifest.json`, "snapshot manifest", 64 * 1024);
const outputPath = resolve(input.output);
if (!isAbsolute(input.output) || input.output.includes("\0")) fail("output path must be absolute");
const outputParent = canonicalDirectory(dirname(outputPath), "output parent", true);
containedPath(operatorRoot, outputPath, "output");
if (outputParent !== dirname(outputPath)) fail("output parent must be canonical");

const moduleAt = (path) => import(pathToFileURL(join(releaseRoot, path)).href);
const [
  appModule,
  authModule,
  databaseModule,
  epochModule,
  idModule,
  importModule,
  migrationModule,
  operationModule,
  registryModule,
] = await Promise.all([
  moduleAt("dist/coordination/app/index.js"),
  moduleAt("dist/coordination/auth/index.js"),
  moduleAt("dist/coordination/db/index.js"),
  moduleAt("dist/coordination/epochs/index.js"),
  moduleAt("dist/coordination/ids/index.js"),
  moduleAt("dist/coordination/import/canonical.js"),
  moduleAt("dist/coordination/migrations/index.js"),
  moduleAt("dist/coordination/operations/index.js"),
  moduleAt("dist/coordination/schema/contract-registry.js"),
]);
const {
  createCoordinationProcess,
  disabledCoordinationFeatureFlags,
} = appModule;
const { createAuthService, SqliteAuthRepository } = authModule;
const { openCoordinationDatabase } = databaseModule;
const {
  authorityReceiptSigningPayload,
  COORDINATION_BOT_LIFECYCLE_WRITER,
  COORDINATION_MESSAGES_WRITER,
  isCanonicalMessagesAuthority,
  validateAuthorityEpochTransition,
} = epochModule;
const { generateCoordinationId, validateCoordinationId } = idModule;
const { canonicalJson, sha256 } = importModule;
const {
  COORDINATION_MIGRATIONS,
  COORDINATION_SCHEMA_CHECKSUM,
  COORDINATION_SCHEMA_VERSION,
} = migrationModule;
const { bootstrapJerry } = operationModule;
const { API_OPERATION_REGISTRY, FEATURE_FLAG_REGISTRY } = registryModule;
const releaseRequire = createRequire(join(releaseRoot, "package.json"));
const Database = releaseRequire("better-sqlite3");

if (COORDINATION_BOT_LIFECYCLE_WRITER !== CANONICAL_WRITER || COORDINATION_MESSAGES_WRITER !== CANONICAL_WRITER) {
  fail("release canonical-writer contract changed");
}
if (API_OPERATION_REGISTRY.createBot?.method !== "POST" || API_OPERATION_REGISTRY.createBot?.path !== "/api/v1/bots") {
  fail("release createBot route contract changed");
}

function effectiveFlags() {
  const ecosystemPath = canonicalPrivateFile(join(operatorRoot, "ecosystem.config.cjs"), "coordination ecosystem", 1024 * 1024);
  const loaded = createRequire(ecosystemPath)(ecosystemPath);
  if (!Array.isArray(loaded?.apps) || loaded.apps.length !== 1 || loaded.apps[0]?.name !== "home23-coordination") {
    fail("coordination ecosystem shape is not exact");
  }
  const env = loaded.apps[0].env;
  const bindings = {
    "coordination.process.enabled": "HOME23_COORDINATION_ENABLED",
    "coordination.public_api.enabled": "HOME23_COORDINATION_PUBLIC_API_ENABLED",
    "coordination.resident.jerry.enabled": "HOME23_COORDINATION_RESIDENT_JERRY_ENABLED",
    "coordination.resident.forrest.enabled": "HOME23_COORDINATION_RESIDENT_FORREST_ENABLED",
    "coordination.channels.enabled": "HOME23_COORDINATION_CHANNELS_ENABLED",
    "coordination.import.shadow_enabled": "HOME23_COORDINATION_IMPORT_SHADOW_ENABLED",
    "coordination.search.canonical": "HOME23_COORDINATION_SEARCH_CANONICAL",
    "coordination.apple.mac_cutover": "HOME23_COORDINATION_APPLE_MAC_CUTOVER",
    "coordination.apple.iphone_cutover": "HOME23_COORDINATION_APPLE_IPHONE_CUTOVER",
    "coordination.bot_lifecycle.enabled": "HOME23_COORDINATION_BOT_LIFECYCLE_ENABLED",
    "coordination.compaction.enabled": "HOME23_COORDINATION_COMPACTION_ENABLED",
  };
  if (canonicalJson(Object.keys(bindings).sort()) !== canonicalJson(Object.keys(FEATURE_FLAG_REGISTRY).sort())) {
    fail("release feature-flag registry differs from the operator projection");
  }
  const flags = {};
  for (const [flag, variable] of Object.entries(bindings)) {
    if (env?.[variable] !== "true" && env?.[variable] !== "false") {
      fail(`${variable} must be exactly true or false`);
    }
    flags[flag] = env[variable] === "true";
  }
  for (const required of [
    "coordination.process.enabled",
    "coordination.public_api.enabled",
    "coordination.resident.jerry.enabled",
    "coordination.resident.forrest.enabled",
    "coordination.channels.enabled",
  ]) {
    if (flags[required] !== true) fail(`${required} must preserve the unified house experience`);
  }
  if (flags["coordination.bot_lifecycle.enabled"] !== false) {
    fail("Bot lifecycle must remain feature-off while authority evidence is built");
  }
  return Object.freeze(flags);
}

function exactBotLifecycleHistory(mode, history) {
  const baseline = Object.freeze({
    capability: "bot_lifecycle",
    epoch: 1,
    mode: "legacy",
    writer: FEATURE_OFF_WRITER,
    effectiveAtEventSequence: null,
    rollbackEpoch: null,
  });
  const shadow = Object.freeze({ ...baseline, epoch: 2, mode: "shadow" });
  if (canonicalJson(history[0]) !== canonicalJson(baseline)) {
    fail("Bot lifecycle epoch 1 is not the exact feature-off baseline");
  }
  if (mode === "shadow") {
    if (history.length !== 1) fail("shadow evidence requires only epoch 1");
    return { current: baseline, proposed: shadow };
  }
  if (history.length !== 2 || canonicalJson(history[1]) !== canonicalJson(shadow)) {
    fail("canonical evidence requires exact feature-off epochs 1 and 2");
  }
  return { current: shadow, proposed: null };
}

function inspectSnapshot() {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const digest = stableFileDigest(snapshotPath);
  if (
    manifest?.database?.sha256 !== digest.sha256 ||
    manifest?.database?.byteLength !== digest.byteLength ||
    manifest?.schema?.version !== COORDINATION_SCHEMA_VERSION ||
    manifest?.schema?.checksum !== COORDINATION_SCHEMA_CHECKSUM ||
    !Number.isSafeInteger(manifest?.eventSequence) || manifest.eventSequence < 0
  ) fail("snapshot does not match its current-release verified-backup manifest");

  const database = new Database(snapshotPath, { readonly: true, fileMustExist: true, timeout: 0 });
  try {
    database.pragma("trusted_schema = OFF");
    database.pragma("query_only = ON");
    database.exec("BEGIN");
    const quickCheck = database.pragma("quick_check");
    const foreignKeys = database.pragma("foreign_key_check");
    if (quickCheck.length !== 1 || quickCheck[0]?.quick_check !== "ok" || foreignKeys.length !== 0) {
      fail("snapshot integrity or foreign-key check failed");
    }
    const migrations = database.prepare(
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
    ).all();
    const expectedMigrations = COORDINATION_MIGRATIONS.map(({ version, name, checksum }) => ({ version, name, checksum }));
    if (canonicalJson(migrations) !== canonicalJson(expectedMigrations)) {
      fail("snapshot migration history differs from the exact release");
    }
    const eventSequence = database.prepare(
      "SELECT COALESCE(MAX(sequence), 0) AS value FROM events",
    ).get().value;
    if (!Number.isSafeInteger(eventSequence) || eventSequence !== manifest.eventSequence) {
      fail("snapshot event sequence differs from its manifest");
    }
    const history = database.prepare(`
      SELECT capability, epoch, mode, writer,
             effective_at_event_sequence AS effectiveAtEventSequence,
             rollback_epoch AS rollbackEpoch
      FROM authority_epochs WHERE capability = 'bot_lifecycle' ORDER BY epoch
    `).all();
    const transition = exactBotLifecycleHistory(input.mode, history);
    const messagesEpoch = database.prepare(`
      SELECT capability, epoch, mode, writer,
             effective_at_event_sequence AS effectiveAtEventSequence,
             rollback_epoch AS rollbackEpoch
      FROM authority_epochs WHERE capability = 'messages' ORDER BY epoch DESC LIMIT 1
    `).get();
    if (!isCanonicalMessagesAuthority(messagesEpoch)) {
      fail("canonical Messages authority must remain present before Bot lifecycle transfer");
    }
    const projection = {
      bots: database.prepare("SELECT * FROM bots ORDER BY id").all(),
      aliases: database.prepare("SELECT * FROM aliases ORDER BY id").all(),
      channels: database.prepare("SELECT * FROM channels ORDER BY id").all(),
      conversationHandles: database.prepare("SELECT * FROM conversation_handles ORDER BY id").all(),
      channelMembers: database.prepare("SELECT * FROM channel_members ORDER BY channel_id, principal_id").all(),
      membershipHistory: database.prepare("SELECT * FROM channel_membership_history ORDER BY channel_id, principal_id, joined_channel_version").all(),
      directPairs: database.prepare("SELECT * FROM direct_channel_pairs ORDER BY first_principal_id, second_principal_id").all(),
      lifecycleReceipts: database.prepare("SELECT * FROM bot_lifecycle_receipts ORDER BY request_key_digest").all(),
    };
    const messageCount = database.prepare("SELECT count(*) AS value FROM messages").get().value;
    if (!Number.isSafeInteger(messageCount) || messageCount < 0) fail("snapshot message count is invalid");
    database.exec("COMMIT");
    return Object.freeze({
      eventSequence,
      messageCount,
      orderedDigest: sha256(canonicalJson(projection)),
      snapshotDigest: sha256(canonicalJson({
        databaseSha256: digest.sha256,
        schemaVersion: COORDINATION_SCHEMA_VERSION,
        schemaChecksum: COORDINATION_SCHEMA_CHECKSUM,
        eventSequence,
        projection,
      })),
      history: Object.freeze(history),
      transition,
    });
  } catch (error) {
    if (database.inTransaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

function appendIsolatedEpoch(database, capability, epoch, mode, writer, rollbackEpoch) {
  const effectiveAtEventSequence = mode === "canonical"
    ? database.readOne("SELECT COALESCE(MAX(sequence), 0) AS value FROM events")?.value ?? 0
    : null;
  const createdAt = new Date(Date.now() + epoch).toISOString();
  database.mutateWithEvent((transaction) => {
    transaction.run(
      `INSERT INTO authority_epochs (
         capability, epoch, mode, writer, effective_at_event_sequence,
         rollback_epoch, receipt_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      capability,
      epoch,
      mode,
      writer,
      effectiveAtEventSequence,
      rollbackEpoch,
      JSON.stringify({ kind: "isolated-bot-lifecycle-authority-canary", epoch }),
      createdAt,
    );
    return {
      value: undefined,
      event: {
        type: "authority.epoch_changed",
        aggregateKind: "authorityEpoch",
        aggregateId: `authority:${capability}`,
        aggregateVersion: epoch,
        channelId: null,
        actorPrincipalId: "user_owner",
        requestId: generateCoordinationId("request"),
        correlationId: generateCoordinationId("correlation"),
        payload: { capability, epoch, mode, writer },
        createdAt,
      },
    };
  });
}

async function isolatedAccessToken(databasePath, capabilityToken) {
  const database = openCoordinationDatabase({ path: databasePath });
  const keyMaterial = createHash("sha256")
    .update("home23-coordination-auth-v1\0")
    .update(capabilityToken)
    .digest();
  try {
    const auth = createAuthService({
      repository: new SqliteAuthRepository(database),
      keyMaterial,
      admissionVerifier: {
        verifyLocalOperator: () => ({ allowed: true, network: "loopback", rateLimitKey: "operator:bot-lifecycle-canary" }),
        verifyClient: () => ({ allowed: true, network: "loopback", rateLimitKey: "client:bot-lifecycle-canary" }),
      },
    });
    const mutation = (idempotencyKey) => ({
      idempotencyKey,
      requestId: generateCoordinationId("request"),
      correlationId: generateCoordinationId("correlation"),
    });
    const issued = await auth.issuePairing({
      deviceName: "Bot lifecycle authority canary",
      operator: "loopback",
      mutation: mutation("bot-lifecycle-canary-pairing-issue"),
    });
    const redeemed = await auth.redeemPairing({
      pairingSessionId: issued.pairingSession.id,
      pairingCode: issued.pairingCode,
      network: "loopback",
      device: { platform: "macos", name: "Bot lifecycle authority canary", appBuild: `core-${releaseId.slice(0, 12)}` },
      mutation: mutation("bot-lifecycle-canary-pairing-redeem"),
    });
    return redeemed.accessToken;
  } finally {
    keyMaterial.fill(0);
    database.close();
  }
}

async function runIsolatedCanary() {
  const root = mkdtempSync(join(tmpdir(), `home23-bot-lifecycle-${releaseId.slice(0, 12)}-`));
  const databasePath = join(root, "coordination.sqlite3");
  const botRootDirectory = join(root, "bots");
  const capabilityToken = createHash("sha256").update(`isolated:${releaseId}`).digest("hex");
  let process = null;
  try {
    mkdirSync(botRootDirectory, { mode: 0o700 });
    await bootstrapJerry({
      databasePath,
      apply: true,
      authority: {
        approved: true,
        kind: "m14-bootstrap",
        operator: "user_owner",
        resident: "jerry",
        legacyWriterAuthoritative: true,
        coordinationFlagsAllFalse: true,
      },
      serverInstanceId: "home23-jerry-harness",
      keyVersion: 1,
    });
    let database = openCoordinationDatabase({ path: databasePath });
    try {
      const legacyMessages = database.readOne(
        "SELECT writer FROM authority_epochs WHERE capability = 'messages' AND epoch = 1",
      )?.writer;
      if (typeof legacyMessages !== "string" || legacyMessages.length === 0) {
        fail("isolated bootstrap did not establish legacy Messages authority");
      }
      appendIsolatedEpoch(database, "messages", 2, "shadow", legacyMessages, null);
      appendIsolatedEpoch(database, "messages", 3, "canonical", CANONICAL_WRITER, 1);
      appendIsolatedEpoch(database, "bot_lifecycle", 1, "legacy", FEATURE_OFF_WRITER, null);
      appendIsolatedEpoch(database, "bot_lifecycle", 2, "shadow", FEATURE_OFF_WRITER, null);
      appendIsolatedEpoch(database, "bot_lifecycle", 3, "canonical", CANONICAL_WRITER, 1);
    } finally {
      database.close();
    }
    const accessToken = await isolatedAccessToken(databasePath, capabilityToken);
    const flags = Object.freeze({
      ...disabledCoordinationFeatureFlags(),
      "coordination.process.enabled": true,
      "coordination.public_api.enabled": true,
      "coordination.bot_lifecycle.enabled": true,
    });
    process = createCoordinationProcess({
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      databasePath,
      botRootDirectory,
      socketPath: join(root, "coordination.sock"),
      capabilityToken,
      residents: {
        jerry: {
          enabled: false,
          socketPath: join(root, "jerry.sock"),
          serverInstanceId: "home23-jerry-harness",
          clientInstanceId: "home23-jerry-harness",
          keyVersion: 1,
          key: "",
        },
        forrest: {
          enabled: false,
          socketPath: join(root, "forrest.sock"),
          serverInstanceId: "home23-forrest-harness",
          clientInstanceId: "home23-forrest-harness",
          keyVersion: 1,
          key: "",
        },
      },
      flags,
    });
    const address = await process.start();
    if (process.capabilities().capabilities.botLifecycle !== true) {
      fail("isolated exact-release process did not advertise Bot lifecycle");
    }
    const route = API_OPERATION_REGISTRY.createBot.path;
    const requestBody = Object.freeze({
      name: "Authority Canary",
      purpose: "Prove the exact isolated processless Bot creation path.",
    });
    const idempotencyKey = `bot-lifecycle-canary-${releaseId.slice(0, 16)}`;
    const requestDigest = sha256(canonicalJson({
      method: "POST",
      route,
      idempotencyKey,
      body: requestBody,
    }));
    const response = await fetch(`${address.origin}${route}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
        "x-correlation-id": generateCoordinationId("correlation"),
      },
      body: JSON.stringify(requestBody),
    });
    const responseBody = await response.json();
    const receipt = responseBody?.receipt;
    const botId = receipt?.botId;
    const mailboxId = receipt?.mailboxId;
    const inventoryResponse = await fetch(`${address.origin}/api/v1/bots`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const inventory = await inventoryResponse.json();
    await process.drain();
    process = null;

    const readback = new Database(databasePath, { readonly: true, fileMustExist: true });
    let row;
    let persistedReceipt;
    try {
      readback.pragma("query_only = ON");
      row = readback.prepare(`
        SELECT bot.id, bot.name, bot.purpose, bot.lifecycle, bot.conversation_id AS conversationId,
               handle.id AS mailboxId, channel.lifecycle AS channelLifecycle,
               (SELECT count(*) FROM channel_members member WHERE member.channel_id = channel.id AND member.active = 1) AS activeMembers
        FROM bots bot
        LEFT JOIN conversation_handles handle ON handle.id = bot.conversation_id
        LEFT JOIN channels channel ON channel.id = handle.channel_id
        WHERE bot.id = ?
      `).get(botId);
      persistedReceipt = readback.prepare(
        "SELECT receipt_json AS receiptJson FROM bot_lifecycle_receipts WHERE operation = 'create'",
      ).get();
    } finally {
      readback.close();
    }
    const mismatches = [];
    if (response.status !== 201) mismatches.push("create_status");
    if (inventoryResponse.status !== 200) mismatches.push("inventory_status");
    if (!validateCoordinationId("bot", botId ?? "")) mismatches.push("bot_id");
    if (!validateCoordinationId("conversation", mailboxId ?? "")) mismatches.push("mailbox_id");
    if (receipt?.outcome !== "succeeded") mismatches.push("receipt_outcome");
    if (row?.id !== botId || row?.mailboxId !== mailboxId || row?.name !== requestBody.name || row?.purpose !== requestBody.purpose || row?.lifecycle !== "active" || row?.channelLifecycle !== "active" || row?.activeMembers !== 2) {
      mismatches.push("durable_mailbox_projection");
    }
    if (typeof persistedReceipt?.receiptJson !== "string" || !persistedReceipt.receiptJson.includes(botId)) {
      mismatches.push("durable_receipt");
    }
    if (!Array.isArray(inventory?.bots) || !inventory.bots.some((bot) => bot.id === botId && bot.lifecycle === "active")) {
      mismatches.push("inventory_projection");
    }
    if (mismatches.length > 0) fail(`isolated createBot canary drifted: ${mismatches.join(",")}`);
    const canary = Object.freeze({
      receiptVersion: 1,
      kind: "home23.connected-agents.isolated-create-bot.v1",
      evidenceMode: "isolated",
      releaseId,
      releaseRoot,
      productionStateTouched: false,
      route: { operationId: "createBot", method: "POST", path: route },
      request: { digest: requestDigest, byteCount: Buffer.byteLength(JSON.stringify(requestBody), "utf8") },
      response: { status: response.status, botId, mailboxId, outcome: receipt.outcome },
      persistence: { lifecycle: row.lifecycle, channelLifecycle: row.channelLifecycle, activeMembers: row.activeMembers },
      comparison: { compared: 8, mismatches: 0, verdict: "passed" },
      capturedAt: new Date().toISOString(),
    });
    return Object.freeze({
      ...canary,
      digest: sha256(canonicalJson(canary)),
      sourceId: generateCoordinationId("legacySource"),
      requestDigest,
    });
  } finally {
    if (process) await process.drain().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

function loadOperatorKeys() {
  const privatePath = canonicalPrivateFile(join(operatorRoot, "operator-authority-private.pem"), "operator private key", 64 * 1024);
  const publicPath = canonicalPrivateFile(join(operatorRoot, "operator-authority-public.pem"), "operator public key", 64 * 1024);
  const privatePem = readFileSync(privatePath);
  const publicPem = readFileSync(publicPath, "utf8");
  try {
    const privateKey = createPrivateKey(privatePem);
    const publicKey = createPublicKey(publicPem);
    if (privateKey.asymmetricKeyType !== "ed25519" || publicKey.asymmetricKeyType !== "ed25519") {
      fail("operator keys must both be Ed25519");
    }
    const derived = createPublicKey(privateKey).export({ type: "spki", format: "der" });
    const expected = publicKey.export({ type: "spki", format: "der" });
    if (derived.length !== expected.length || !timingSafeEqual(derived, expected)) {
      fail("operator private/public keys do not match");
    }
    return { privateKey, publicKey, publicPem };
  } finally {
    privatePem.fill(0);
  }
}

async function main() {
  const flags = effectiveFlags();
  const snapshot = inspectSnapshot();
  const canary = await runIsolatedCanary();
  const current = snapshot.transition.current;
  const proposed = input.mode === "shadow"
    ? snapshot.transition.proposed
    : Object.freeze({
        capability: "bot_lifecycle",
        epoch: 3,
        mode: "canonical",
        writer: CANONICAL_WRITER,
        effectiveAtEventSequence: snapshot.eventSequence,
        rollbackEpoch: 1,
      });
  const unsigned = Object.freeze({
    receiptVersion: 1,
    capability: "bot_lifecycle",
    fromEpoch: current.epoch,
    toEpoch: proposed.epoch,
    fromAuthority: { mode: current.mode, writer: current.writer },
    toAuthority: { mode: proposed.mode, writer: proposed.writer },
    sourceWatermark: {
      sourceId: canary.sourceId,
      segmentIdentity: `isolated-http:${releaseId}:${canary.digest}`,
      recordIndex: 1,
      byteOffset: canary.request.byteCount,
      tailDigest: canary.digest,
    },
    destinationWatermark: {
      eventSequence: snapshot.eventSequence,
      messageCount: snapshot.messageCount,
      orderedDigest: snapshot.orderedDigest,
    },
    samePathCanary: {
      operationId: "createBot",
      route: API_OPERATION_REGISTRY.createBot.path,
      requestDigest: canary.requestDigest,
      passed: true,
    },
    driftCount: canary.comparison.mismatches,
    activeFlags: flags,
    rollbackTarget: proposed.rollbackEpoch,
    operator: "user_owner",
    effectiveAtEventSequence: proposed.effectiveAtEventSequence,
    legacyWriterDisposition: input.mode === "shadow" ? "unchanged_authoritative" : "disabled",
    issuedAt: new Date().toISOString(),
  });
  const keys = loadOperatorKeys();
  const signatureValue = sign(
    null,
    Buffer.from(authorityReceiptSigningPayload(unsigned), "utf8"),
    keys.privateKey,
  ).toString("base64");
  const receipt = Object.freeze({
    ...unsigned,
    signature: { algorithm: "ed25519", keyId: KEY_ID, value: signatureValue },
  });
  const validation = validateAuthorityEpochTransition({
    current,
    proposed,
    history: snapshot.history,
    receipt,
    activeCanonicalWriters: [],
    verifySignature: (payload, signature) =>
      signature.algorithm === "ed25519" && signature.keyId === KEY_ID && verify(
        null,
        Buffer.from(payload, "utf8"),
        keys.publicKey,
        Buffer.from(signature.value, "base64"),
      ),
  });
  if (validation.decision !== "valid") {
    fail(`release validator denied ${input.mode}: ${validation.reason}`);
  }
  const evidence = Object.freeze({
    requestId: generateCoordinationId("request"),
    correlationId: generateCoordinationId("correlation"),
    receipt,
    publicKeyPem: keys.publicPem,
    activeCanonicalWriters: [],
    botLifecycleEnabled: false,
    evidence: {
      kind: "home23.connected-agents.bot-lifecycle-authority-evidence.v1",
      releaseId,
      productionStateTouched: false,
      snapshotDigest: snapshot.snapshotDigest,
      isolatedCanaryDigest: canary.digest,
      authorityReceiptDigest: validation.receiptDigest,
      transitionDigest: validation.transitionDigest,
    },
  });
  writeExclusive(outputPath, evidence);
  process.stdout.write(`${JSON.stringify({
    mode: input.mode,
    releaseId,
    output: outputPath,
    currentEpoch: current.epoch,
    proposedEpoch: proposed.epoch,
    snapshotDigest: snapshot.snapshotDigest,
    isolatedCanaryDigest: canary.digest,
    authorityReceiptDigest: validation.receiptDigest,
    transitionDigest: validation.transitionDigest,
    productionStateTouched: false,
  })}\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
