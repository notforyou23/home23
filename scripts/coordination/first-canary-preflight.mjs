#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const usage = "usage: first-canary-preflight.mjs --fixture <path> [--out <path>]";
const args = process.argv.slice(2);
const fixtureAt = args.indexOf("--fixture");
const outAt = args.indexOf("--out");
if (fixtureAt < 0 || !args[fixtureAt + 1] || args.includes("--live")) {
  console.error(`${usage}\nThis runner is fixture-only and refuses --live.`);
  process.exit(2);
}
const source = JSON.parse(await readFile(resolve(args[fixtureAt + 1]), "utf8"));
const moduleUrl = pathToFileURL(resolve("dist/coordination/rollout/index.js")).href;
const { runFirstCanaryFixture } = await import(moduleUrl);
const receipt = runFirstCanaryFixture(source);
const rendered = `${JSON.stringify(receipt, null, 2)}\n`;
if (outAt >= 0) {
  if (!args[outAt + 1]) throw new Error("--out requires a path");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(resolve(args[outAt + 1]), rendered, { flag: "wx", mode: 0o600 });
} else {
  process.stdout.write(rendered);
}
