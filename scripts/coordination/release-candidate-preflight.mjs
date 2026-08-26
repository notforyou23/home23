#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const usage = "usage: release-candidate-preflight.mjs --manifest <path>";
const args = process.argv.slice(2);
const manifestAt = args.indexOf("--manifest");
if (manifestAt < 0 || !args[manifestAt + 1] || args.some((arg) => ["--live", "--apply", "--activate", "--deploy", "--install", "--sign"].includes(arg))) {
  console.error(`${usage}\nThis command is read-only, feature-off, and refuses live/apply/activate/deploy/install/sign modes.`);
  process.exit(2);
}
const input = JSON.parse(await readFile(resolve(args[manifestAt + 1]), "utf8"));
const moduleUrl = pathToFileURL(resolve("dist/coordination/release/index.js")).href;
const { validateReleaseCandidate } = await import(moduleUrl);
const report = validateReleaseCandidate(input);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.releaseReady ? 0 : 1;
