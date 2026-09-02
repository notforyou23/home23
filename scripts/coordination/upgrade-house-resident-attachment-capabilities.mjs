#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  HOUSE_RESIDENT_ATTACHMENT_CAPABILITY_CONFIRMATION,
  upgradeHouseResidentAttachmentCapabilities,
} from "../../dist/coordination/operations/index.js";

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? null : args[index + 1] ?? null;
};
const allowed = new Set([
  "--apply",
  "--confirm",
  "--database",
  "--evidence",
]);
if (
  args.filter((argument) => argument.startsWith("--"))
    .some((argument) => !allowed.has(argument))
) {
  throw new Error("unknown options are refused");
}

const databasePath = value("--database");
if (!databasePath) throw new Error("--database is required");
const apply = args.includes("--apply");

let evidence = {};
if (apply) {
  const evidencePath = value("--evidence");
  if (!evidencePath) throw new Error("--apply requires --evidence");
  evidence = JSON.parse(readFileSync(resolve(evidencePath), "utf8"));
}

const receipt = upgradeHouseResidentAttachmentCapabilities({
  databasePath: resolve(databasePath),
  apply,
  authority: evidence.authority,
  expectedResidents: evidence.expectedResidents,
  requestId: evidence.requestId,
  correlationId: evidence.correlationId,
  confirmation: value("--confirm") ===
      HOUSE_RESIDENT_ATTACHMENT_CAPABILITY_CONFIRMATION
    ? HOUSE_RESIDENT_ATTACHMENT_CAPABILITY_CONFIRMATION
    : undefined,
});

process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
