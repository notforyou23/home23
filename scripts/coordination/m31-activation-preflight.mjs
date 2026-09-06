#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const usage = "usage: m31-activation-preflight.mjs --fixture <path> [--out <new-path>]";
const args = process.argv.slice(2);
const allowed = new Set(["--fixture", "--out"]);
const optionNames = args.filter((arg) => arg.startsWith("--"));
const fixtureAt = args.indexOf("--fixture");
const outAt = args.indexOf("--out");
const invalid = optionNames.some((arg) => !allowed.has(arg))
  || fixtureAt < 0 || !args[fixtureAt + 1]
  || (outAt >= 0 && !args[outAt + 1]);

if (invalid) {
  console.error(`${usage}\nRefused: this runner has no live mode and cannot activate or advertise capabilities.`);
  process.exit(2);
}

const source = JSON.parse(await readFile(resolve(args[fixtureAt + 1]), "utf8"));
const moduleUrl = pathToFileURL(resolve("dist/coordination/rollout/index.js")).href;
const { runM31ActivationFixture } = await import(moduleUrl);
const receipt = runM31ActivationFixture(source);
const rendered = `${JSON.stringify(receipt, null, 2)}\n`;

if (outAt >= 0) {
  await writeFile(resolve(args[outAt + 1]), rendered, { flag: "wx", mode: 0o600 });
} else {
  process.stdout.write(rendered);
}
