#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  executeM31AttachmentAuthorityTransition,
  initializeM31AttachmentAuthority,
} from "../../dist/coordination/operations/index.js";

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? null : args[index + 1] ?? null;
};
const allowed = new Set([
  "--database",
  "--evidence",
  "--initialize",
  "--apply",
  "--confirm",
]);
const invalidOption = args
  .filter((argument) => argument.startsWith("--"))
  .some((argument) => !allowed.has(argument));
const database = value("--database");
const evidencePath = value("--evidence");
if (invalidOption || !database || !evidencePath) {
  throw new Error(
    "--database and --evidence are required; unknown options are refused",
  );
}

const input = JSON.parse(readFileSync(resolve(evidencePath), "utf8"));
const apply = args.includes("--apply");
const initialize = args.includes("--initialize");
const requiredConfirmation = initialize
  ? "APPLY_FEATURE_OFF_M31_ATTACHMENTS_BASELINE"
  : "APPLY_SIGNED_M31_ATTACHMENTS_AUTHORITY";
const liveAuthorized = apply && value("--confirm") === requiredConfirmation;
const common = {
  databasePath: resolve(database),
  requestId: input.requestId,
  correlationId: input.correlationId,
  apply,
  liveAuthorized,
};
const result = initialize
  ? initializeM31AttachmentAuthority({
      ...common,
      evidence: input.evidence,
    })
  : executeM31AttachmentAuthorityTransition({
      ...common,
      receipt: input.receipt,
      publicKeyPem: input.publicKeyPem,
      activeCanonicalWriters: input.activeCanonicalWriters,
      attachmentAdmissionEnabled: input.attachmentAdmissionEnabled,
    });

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
