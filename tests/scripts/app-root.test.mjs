// Unit tests for scripts/lib/app-root.mjs — the root resolver product scripts
// share so that none of them carries a developer machine path (release 186
// defect D10). scripts/ ships hash-verified, so a baked-in default cannot be
// edited by an owner and is wrong on every other machine.
//
// Run directly: node --test tests/scripts/app-root.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveAppRoot, resolveShakedownSiteRoot } from "../../scripts/lib/app-root.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function withTempRoot(fn) {
  const root = mkdtempSync(path.join(os.tmpdir(), "home23-app-root-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("resolveAppRoot honours HOME23_ROOT when it is set", () => {
  withTempRoot((root) => {
    const scriptUrl = pathToFileURL(path.join(REPO_ROOT, "scripts", "anything.mjs")).href;
    assert.equal(resolveAppRoot(scriptUrl, { HOME23_ROOT: root }), path.resolve(root));
  });
});

test("resolveAppRoot falls back to the parent of the calling script's scripts/ directory", () => {
  withTempRoot((root) => {
    mkdirSync(path.join(root, "scripts"));
    const scriptUrl = pathToFileURL(path.join(root, "scripts", "some-script.mjs")).href;
    assert.equal(resolveAppRoot(scriptUrl, {}), root);
    // An empty HOME23_ROOT counts as unset, the same as src/config.ts.
    assert.equal(resolveAppRoot(scriptUrl, { HOME23_ROOT: "" }), root);
  });
});

test("resolveAppRoot resolves this repository's own scripts to the repository root", () => {
  const scriptUrl = pathToFileURL(path.join(REPO_ROOT, "scripts", "shakedown-desk.mjs")).href;
  assert.equal(resolveAppRoot(scriptUrl, {}), REPO_ROOT);
});

test("resolveAppRoot rejects a relative or filesystem-root HOME23_ROOT", () => {
  const scriptUrl = pathToFileURL(path.join(REPO_ROOT, "scripts", "anything.mjs")).href;
  assert.throws(() => resolveAppRoot(scriptUrl, { HOME23_ROOT: "relative/home23" }), /absolute dedicated Home23 directory/);
  assert.throws(() => resolveAppRoot(scriptUrl, { HOME23_ROOT: "/" }), /absolute dedicated Home23 directory/);
});

test("resolveShakedownSiteRoot honours SHAKEDOWN_SITE_ROOT, else the current user's home", () => {
  withTempRoot((root) => {
    assert.equal(resolveShakedownSiteRoot({ SHAKEDOWN_SITE_ROOT: root }), path.resolve(root));
  });
  assert.equal(resolveShakedownSiteRoot({}), path.join(os.homedir(), "websites", "shakedownshuffle.com"));
  assert.equal(resolveShakedownSiteRoot({ SHAKEDOWN_SITE_ROOT: "" }), path.join(os.homedir(), "websites", "shakedownshuffle.com"));
});

// scripts/home23-disk-maintenance.sh applies the same rule in bash. It only
// prunes generated backups under <root>/instances/*/brain/backups when the data
// mount is short on space, so against an empty temp root it can never touch
// anything real; its log file shows which root it resolved.
test("home23-disk-maintenance.sh resolves its root from HOME23_ROOT or its own location", () => {
  const source = path.join(REPO_ROOT, "scripts", "home23-disk-maintenance.sh");
  withTempRoot((base) => {
    const configured = path.join(base, "configured");
    const located = path.join(base, "located");
    mkdirSync(path.join(located, "scripts"), { recursive: true });
    mkdirSync(configured, { recursive: true });
    copyFileSync(source, path.join(located, "scripts", "home23-disk-maintenance.sh"));
    const env = { ...process.env };
    delete env.HOME23_ROOT;

    const viaEnv = spawnSync("bash", [source], { env: { ...env, HOME23_ROOT: configured }, encoding: "utf8" });
    assert.equal(viaEnv.status, 0, viaEnv.stderr);
    assert.ok(existsSync(path.join(configured, "logs", "disk-maintenance.log")), "log written under HOME23_ROOT");

    const viaLocation = spawnSync("bash", [path.join(located, "scripts", "home23-disk-maintenance.sh")], { env, encoding: "utf8" });
    assert.equal(viaLocation.status, 0, viaLocation.stderr);
    assert.ok(existsSync(path.join(located, "logs", "disk-maintenance.log")), "log written under the script's own root");
  });
});
