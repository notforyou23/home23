// The substack skill ships as hash-verified product payload under
// workspace/skills/, so its source-receipts directory must derive from the
// resolved app root (runtime projectRoot, HOME23_ROOT, or the skill's own
// location) — never from a baked-in developer machine path (release 186 D10).
//
// Run directly: node --test tests/skills/substack-paths.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProjectRoot, resolveReceiptsDir } from "../../workspace/skills/substack/index.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RECEIPTS_RELATIVE = "instances/jerry/workspace/projects/shakedownshuffle/content/newsletter/source-receipts";

function withHome23Root(value, fn) {
  const saved = process.env.HOME23_ROOT;
  if (value === undefined) delete process.env.HOME23_ROOT;
  else process.env.HOME23_ROOT = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.HOME23_ROOT;
    else process.env.HOME23_ROOT = saved;
  }
}

test("the runtime's projectRoot wins over everything else", () => {
  withHome23Root("/somewhere/else", () => {
    assert.equal(resolveProjectRoot({ projectRoot: "/runtime/root" }), "/runtime/root");
    assert.equal(resolveReceiptsDir({ projectRoot: "/runtime/root" }), path.join("/runtime/root", RECEIPTS_RELATIVE));
  });
});

test("HOME23_ROOT is honoured when the runtime passes no projectRoot", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "home23-substack-"));
  try {
    withHome23Root(root, () => {
      assert.equal(resolveProjectRoot({}), path.resolve(root));
      assert.equal(resolveReceiptsDir(), path.join(path.resolve(root), RECEIPTS_RELATIVE));
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("without either, the root is the skill's own location (workspace/skills/substack -> app root)", () => {
  withHome23Root(undefined, () => {
    assert.equal(resolveProjectRoot(), REPO_ROOT);
    assert.equal(resolveReceiptsDir(), path.join(REPO_ROOT, RECEIPTS_RELATIVE));
  });
});
