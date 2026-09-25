// Repo hygiene: the product payload must not carry a developer machine path.
//
// scripts/, cli/, workspace/skills/ and src/ ship hash-verified, so an owner
// cannot edit a baked-in "/Users/<developer>/..." default and on every other
// machine that default is wrong (release 186 defect D10). Roots must come from
// HOME23_ROOT or the file's own location; other operational locations from an
// environment variable or the current user's home directory.
//
// Excluded on purpose: tests, documentation (*.md) and recorded experiment
// evidence under results/ (a record of where an experiment ran, not code).
//
// Run directly: node --test tests/scripts/repo-hygiene-owner-paths.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCAN_ROOTS = ["scripts", "cli", "workspace/skills", "src"];
const OWNER_PATH_MARKER = "/Users/jtr";
const SKIP_DIRECTORIES = new Set(["node_modules", ".cache", "dist", "tests", "__tests__", "results"]);
const SKIP_EXTENSIONS = new Set([".md"]);
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

function* walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) yield* walk(full);
      continue;
    }
    if (!entry.isFile()) continue;
    if (SKIP_EXTENSIONS.has(path.extname(entry.name)) || TEST_FILE.test(entry.name)) continue;
    yield full;
  }
}

export function findOwnerPathReferences(repoRoot = REPO_ROOT) {
  const hits = [];
  for (const scanRoot of SCAN_ROOTS) {
    for (const file of walk(path.join(repoRoot, scanRoot))) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (line.includes(OWNER_PATH_MARKER)) hits.push(`${path.relative(repoRoot, file)}:${index + 1}`);
      });
    }
  }
  return hits;
}

test("product source under scripts/, cli/, workspace/skills/ and src/ carries no developer machine path", () => {
  const hits = findOwnerPathReferences();
  assert.deepEqual(
    hits,
    [],
    `developer path ${OWNER_PATH_MARKER} found in product source; resolve roots from HOME23_ROOT or the file's location:\n  ${hits.join("\n  ")}`,
  );
});
