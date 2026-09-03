import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";

import {
  API_OPERATION_REGISTRY,
  CONNECTED_AGENTS_CONTRACT_VERSION,
} from "../schema/contract-registry.js";

interface FixtureManifestEntry {
  name: string;
  file: string;
  schemaDefinition: string;
}

interface PackManifest {
  contractVersion: number;
  canonicalFiles: string[];
  fixtures: FixtureManifestEntry[];
}

type JsonObject = Record<string, unknown>;

const packRoot = fileURLToPath(new URL("./v1/", import.meta.url));

function readPackFile(relativePath: string): Buffer {
  return readFileSync(new URL(`./v1/${relativePath}`, import.meta.url));
}

function loadJson(relativePath: string): JsonObject {
  return JSON.parse(readPackFile(relativePath).toString("utf8")) as JsonObject;
}

const manifest = loadJson("pack-manifest.json") as unknown as PackManifest;
const schema = loadJson("schema.json");
const openApi = loadJson("openapi.json");

if (manifest.contractVersion !== CONNECTED_AGENTS_CONTRACT_VERSION) {
  throw new Error("contract pack manifest version drift");
}

const fixtureEntries = new Map(manifest.fixtures.map((entry) => [entry.name, entry]));
const ajv = new Ajv2020({
  allErrors: true,
  strict: false,
  allowUnionTypes: true,
  validateFormats: false,
});
ajv.addSchema(schema, String(schema.$id));

export { CONNECTED_AGENTS_CONTRACT_VERSION };

// Filled only after the canonical byte pack is complete. The test compares this
// reviewed literal with a fresh digest, so any later byte drift is visible.
export const CONNECTED_AGENTS_CONTRACT_PACK_SHA256 =
  "1a9e2e866dc97360b1d966d65e51a14872356feeb2818dbfd328c8019c8982aa";

export function canonicalContractFiles(): string[] {
  return [...manifest.canonicalFiles].sort();
}

export function computeContractPackDigest(): string {
  const hash = createHash("sha256");
  for (const relativePath of canonicalContractFiles()) {
    const pathBytes = Buffer.from(relativePath, "utf8");
    const content = readPackFile(relativePath);
    hash.update(`${pathBytes.length}:`);
    hash.update(pathBytes);
    hash.update("\n");
    hash.update(`${content.length}:`);
    hash.update(content);
    hash.update("\n");
  }
  return hash.digest("hex");
}

export function fixtureNames(): string[] {
  return [...fixtureEntries.keys()].sort();
}

export function loadCanonicalFixture(name: string): unknown {
  const entry = fixtureEntries.get(name);
  if (!entry) throw new Error(`unknown canonical fixture: ${name}`);
  return loadJson(entry.file);
}

export function validateCanonicalFixture(
  name: string,
  value: unknown = loadCanonicalFixture(name),
): { valid: boolean; errors: string[] } {
  const entry = fixtureEntries.get(name);
  if (!entry) throw new Error(`unknown canonical fixture: ${name}`);
  const schemaId = String(schema.$id);
  const reference = `${schemaId}#/$defs/${entry.schemaDefinition}`;
  const validate = ajv.getSchema(reference);
  if (!validate) throw new Error(`${name} references missing schema ${reference}`);
  const valid = validate(value);
  const errors = (validate.errors ?? []).map((error: ErrorObject) => {
    const at = error.instancePath || "/";
    return `${at} ${error.message ?? "is invalid"}`;
  });
  return { valid: Boolean(valid), errors };
}

export function openApiOperationIds(): string[] {
  const paths = openApi.paths as Record<string, Record<string, JsonObject>>;
  const ids: string[] = [];
  for (const pathItem of Object.values(paths)) {
    for (const operation of Object.values(pathItem)) {
      if (typeof operation.operationId === "string") ids.push(operation.operationId);
    }
  }
  return ids.sort();
}

export function validatePackInventory(): string[] {
  const problems: string[] = [];
  const sorted = [...manifest.canonicalFiles].sort();
  if (new Set(sorted).size !== sorted.length) problems.push("canonicalFiles contains duplicates");
  if (JSON.stringify(sorted) !== JSON.stringify(manifest.canonicalFiles)) {
    problems.push("canonicalFiles is not lexically sorted");
  }
  if (!sorted.includes("pack-manifest.json")) problems.push("manifest does not hash itself");
  const collectJsonFiles = (relativeDirectory = ""): string[] => {
    const files: string[] = [];
    for (const entry of readdirSync(join(packRoot, relativeDirectory), { withFileTypes: true })) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      if (entry.isDirectory()) files.push(...collectJsonFiles(relativePath));
      else if (entry.isFile() && entry.name.endsWith(".json")) files.push(relativePath);
    }
    return files;
  };
  const actualJsonFiles = collectJsonFiles().sort();
  if (JSON.stringify(actualJsonFiles) !== JSON.stringify(sorted)) {
    problems.push("canonicalFiles does not exactly cover every v1 JSON file");
  }
  for (const relativePath of sorted) {
    try {
      const content = readPackFile(relativePath).toString("utf8");
      if (/\/(?:Users|home)\//.test(content) || /file:\/\//.test(content)) {
        problems.push(`${relativePath} contains an absolute path`);
      }
      if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:ghp_|sk-)[A-Za-z0-9_-]{16,}/.test(content)) {
        problems.push(`${relativePath} contains credential-shaped content`);
      }
    } catch {
      problems.push(`missing canonical file ${relativePath}`);
    }
  }
  for (const entry of manifest.fixtures) {
    if (!sorted.includes(entry.file)) problems.push(`${entry.name} fixture is outside digest`);
    if (!(schema.$defs as JsonObject)[entry.schemaDefinition]) {
      problems.push(`${entry.name} schema definition is missing`);
    }
  }
  const registryIds = new Set(Object.keys(API_OPERATION_REGISTRY));
  const openApiIds = new Set(openApiOperationIds());
  for (const id of registryIds) if (!openApiIds.has(id)) problems.push(`OpenAPI missing ${id}`);
  for (const id of openApiIds) if (!registryIds.has(id)) problems.push(`registry missing ${id}`);
  const paths = openApi.paths as Record<string, Record<string, JsonObject>>;
  for (const [operationId, rule] of Object.entries(API_OPERATION_REGISTRY)) {
    const operation = paths[rule.path]?.[rule.method.toLowerCase()];
    if (operation?.operationId !== operationId) {
      problems.push(`${operationId} method/path differs between registry and OpenAPI`);
    }
  }

  const referencedFixtures = new Set<string>();
  const inspectOpenApiNode = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(inspectOpenApiNode);
      return;
    }
    if (!value || typeof value !== "object") return;
    const object = value as JsonObject;
    const fixtureName = object["x-canonical-fixture"];
    if (typeof fixtureName === "string") {
      referencedFixtures.add(fixtureName);
      const entry = fixtureEntries.get(fixtureName);
      if (!entry) {
        problems.push(`OpenAPI references unknown fixture ${fixtureName}`);
      } else {
        const reference = (object.schema as JsonObject | undefined)?.$ref;
        if (reference !== `./schema.json#/$defs/${entry.schemaDefinition}`) {
          problems.push(`OpenAPI schema differs from ${fixtureName} manifest definition`);
        }
      }
    }
    Object.values(object).forEach(inspectOpenApiNode);
  };
  inspectOpenApiNode(openApi);
  if (!referencedFixtures.has("bootstrap") || !referencedFixtures.has("event-cursor-reset")) {
    problems.push("OpenAPI does not bind bootstrap and reset fixtures");
  }

  const idDefinitionNames: Record<string, string> = {
    home: "homeId",
    principal: "principalId",
    bot: "botId",
    channel: "channelId",
    conversation: "conversationId",
    message: "messageId",
    artifact: "artifactId",
    event: "eventId",
    device: "deviceId",
    clientSession: "sessionId",
    pairingSession: "pairingSessionId",
    round: "roundId",
    work: "workId",
    attempt: "attemptId",
    lease: "leaseId",
    contextManifest: "contextManifestId",
    delivery: "deliveryId",
    outbox: "outboxId",
    legacySource: "legacySourceId",
    importCohort: "importCohortId",
    importItem: "importItemId",
    alias: "aliasId",
    workObservation: "observationId",
    request: "requestId",
    correlation: "correlationId",
  };
  const registry = loadJson("registry.json");
  const registryIdRules = registry.ids as Record<string, JsonObject>;
  const definitions = schema.$defs as Record<string, JsonObject>;
  for (const [idKind, definitionName] of Object.entries(idDefinitionNames)) {
    if (registryIdRules[idKind]?.pattern !== definitions[definitionName]?.pattern) {
      problems.push(`${idKind} pattern differs between registry and schema`);
    }
  }

  const enumForMachine: Record<string, string> = {
    botLifecycle: "botLifecycle",
    botAvailability: "botAvailability",
    channel: "channelLifecycle",
    attachment: "attachmentStatus",
    round: "roundStatus",
    work: "workStatus",
    attempt: "attemptStatus",
    lease: "leaseStatus",
    messageVisibility: "messageVisibility",
    delivery: "deliveryStatus",
    outbox: "outboxStatus",
    clientSession: "clientSessionStatus",
    pairingSession: "pairingSessionStatus",
    importItem: "importItemStatus",
    activity: "activityStatus",
    authorityEpoch: "authorityMode",
  };
  const machines = registry.stateMachines as Record<string, JsonObject>;
  const enums = registry.publicEnums as Record<string, JsonObject>;
  for (const [machineName, enumName] of Object.entries(enumForMachine)) {
    if (JSON.stringify(machines[machineName]?.states) !== JSON.stringify(enums[enumName]?.values)) {
      problems.push(`${machineName} states differ from ${enumName} values`);
    }
  }
  for (const [machineName, machine] of Object.entries(machines)) {
    const states = machine.states as string[];
    const terminal = machine.terminal as string[];
    const transitions = machine.transitions as [string, string][];
    if (new Set(states).size !== states.length) problems.push(`${machineName} has duplicate states`);
    for (const [from, to] of transitions) {
      if (!states.includes(from) || !states.includes(to)) {
        problems.push(`${machineName} transition ${from}->${to} references an unknown state`);
      }
      if (terminal.includes(from)) {
        problems.push(`${machineName} terminal state ${from} has an outgoing transition`);
      }
    }
  }
  for (const [enumName, rule] of Object.entries(enums)) {
    if (!["preserve", "reject", "ignore_and_advance_cursor"].includes(String(rule.unknownPolicy))) {
      problems.push(`${enumName} does not declare a supported unknown policy`);
    }
  }

  for (const forbidden of ["project", "task", "run", "schedule", "grant", "approval", "node", "environment", "vm"]) {
    if (registryIdRules[forbidden] || machines[forbidden]) {
      problems.push(`excluded generic noun ${forbidden} was reintroduced`);
    }
  }
  return problems;
}

function swiftStringLiteral(value: string): string {
  return JSON.stringify(value);
}

export function renderAppleCanonicalFixtures(): string {
  const entries = fixtureNames().map((name) => {
    const entry = fixtureEntries.get(name)!;
    const json = readPackFile(entry.file).toString("utf8").trimEnd();
    return `        ${swiftStringLiteral(name)}: #\"\"\"\n${json}\n\"\"\"#,`;
  });
  const names = fixtureNames().map((name) => `        ${swiftStringLiteral(name)},`);
  return `// Generated by Core src/coordination/contracts/generate-apple-fixtures.ts.\n// Do not hand-edit: regenerate from the reviewed canonical JSON pack.\n\nimport Foundation\n\npublic enum ConnectedAgentsCanonicalFixtures {\n    public static let contractVersion: Int = ${CONNECTED_AGENTS_CONTRACT_VERSION}\n    public static let packSHA256 = ${swiftStringLiteral(CONNECTED_AGENTS_CONTRACT_PACK_SHA256)}\n\n    public static let names: [String] = [\n${names.join("\n")}\n    ]\n\n    private static let jsonByName: [String: String] = [\n${entries.join("\n")}\n    ]\n\n    public static func data(named name: String) -> Data? {\n        jsonByName[name].map { Data($0.utf8) }\n    }\n}\n`;
}

export const CONNECTED_AGENTS_PACK_ROOT = packRoot;
