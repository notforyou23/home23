#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const usage = "usage: deployment-preflight.mjs --fixture <path> [--out <new-path>]";
const args = process.argv.slice(2);
const allowed = new Set(["--fixture", "--out"]);
const fixtureAt = args.indexOf("--fixture");
const outAt = args.indexOf("--out");
const invalid = args.filter((arg) => arg.startsWith("--")).some((arg) => !allowed.has(arg))
  || fixtureAt < 0 || !args[fixtureAt + 1] || (outAt >= 0 && !args[outAt + 1]);
if (invalid) {
  console.error(`${usage}\nRefused: fixture-only; --live and unknown options are not supported.`);
  process.exit(2);
}
const source = JSON.parse(await readFile(resolve(args[fixtureAt + 1]), "utf8"));
const moduleUrl = pathToFileURL(resolve("dist/coordination/rollout/index.js")).href;
const { runDeploymentPreflightFixture } = await import(moduleUrl);
const rendered = `${JSON.stringify(runDeploymentPreflightFixture(source), null, 2)}\n`;
if (outAt >= 0) await writeFile(resolve(args[outAt + 1]), rendered, { flag: "wx", mode: 0o600 });
else process.stdout.write(rendered);
