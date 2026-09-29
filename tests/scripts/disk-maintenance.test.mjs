// Tests for scripts/home23-disk-maintenance.sh — the disk guard that prunes
// generated brain backups under disk pressure.
//
// 2026-09-29: the guard claimed "newest backup is protected" but removed every
// manifest-bearing backup older than 24 h. It was only harmless because both
// residents' backups folders are symlinks to an external volume, which its
// find did not follow. Forrest's only full backup lives there.
//
// Run directly: node --test tests/scripts/disk-maintenance.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "home23-disk-maintenance.sh");
const THREE_DAYS_AGO = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

function withTempRoot(fn) {
  const root = mkdtempSync(path.join(os.tmpdir(), "home23-disk-guard-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function makeBackup(backupsDir, name, { manifest = true, old = true } = {}) {
  const dir = path.join(backupsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "memory.jsonl"), "{}\n");
  if (manifest) writeFileSync(path.join(dir, "backup-manifest.json"), "{}\n");
  if (old) utimesSync(dir, THREE_DAYS_AGO, THREE_DAYS_AGO);
  return dir;
}

function backupsDirFor(root, resident) {
  const dir = path.join(root, "instances", resident, "brain", "backups");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Pressure is forced with a threshold no disk can meet; the data mount defaults
// to the temporary root so the backups sit on the pressured volume.
function runGuard(root, { dataMount = root, thresholdGib = "1000000" } = {}) {
  const result = spawnSync("/bin/bash", [SCRIPT], {
    env: {
      PATH: process.env.PATH,
      HOME23_ROOT: root,
      HOME23_DATA_MOUNT: dataMount,
      HOME23_DISK_GUARD_THRESHOLD_GIB: thresholdGib,
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `guard exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

test("keeps a brain's only backup under disk pressure", () => {
  withTempRoot((root) => {
    const only = makeBackup(backupsDirFor(root, "forrest"), "backup-2026-09-01T05-07-26.982Z");
    runGuard(root);
    assert.ok(existsSync(only), "the only backup was removed");
  });
});

test("keeps the newest two backups and removes older ones", () => {
  withTempRoot((root) => {
    const backups = backupsDirFor(root, "jerry");
    const oldest = makeBackup(backups, "backup-2026-09-01T00-00-00.000Z");
    const middle = makeBackup(backups, "backup-2026-09-02T00-00-00.000Z");
    const newest = makeBackup(backups, "backup-2026-09-03T00-00-00.000Z");
    runGuard(root);
    assert.equal(existsSync(oldest), false, "the oldest backup should be pruned");
    assert.ok(existsSync(middle), "the second-newest backup must be kept");
    assert.ok(existsSync(newest), "the newest backup must be kept");
  });
});

test("leaves backups on another volume alone, since removing them frees nothing", (t) => {
  withTempRoot((root) => {
    // /dev is its own filesystem on macOS and Linux; skip where it is not.
    if (statSync("/dev").dev === statSync(root).dev) {
      t.skip("/dev shares a device with the temporary directory here");
      return;
    }
    const backups = backupsDirFor(root, "jerry");
    const dirs = ["01", "02", "03"].map((day) => makeBackup(backups, `backup-2026-09-${day}T00-00-00.000Z`));
    const output = runGuard(root, { dataMount: "/dev" });
    for (const dir of dirs) assert.ok(existsSync(dir), `${path.basename(dir)} on another volume was removed`);
    assert.match(output, /SKIP .*other-volume/);
  });
});

test("follows a symlinked backups folder that is on the pressured volume", () => {
  withTempRoot((root) => {
    const relocated = path.join(root, "relocated", "jerry-brain-backups");
    mkdirSync(relocated, { recursive: true });
    const brain = path.join(root, "instances", "jerry", "brain");
    mkdirSync(brain, { recursive: true });
    symlinkSync(relocated, path.join(brain, "backups"));
    const oldest = makeBackup(relocated, "backup-2026-09-01T00-00-00.000Z");
    const middle = makeBackup(relocated, "backup-2026-09-02T00-00-00.000Z");
    const newest = makeBackup(relocated, "backup-2026-09-03T00-00-00.000Z");
    runGuard(root);
    assert.equal(existsSync(oldest), false, "the oldest backup behind the symlink should be pruned");
    assert.ok(existsSync(middle));
    assert.ok(existsSync(newest));
  });
});

test("never removes backups newer than 24 hours or without a manifest", () => {
  withTempRoot((root) => {
    const backups = backupsDirFor(root, "jerry");
    const unfinished = makeBackup(backups, "backup-2026-08-30T00-00-00.000Z", { manifest: false });
    const recent = ["01", "02", "03"].map((day) =>
      makeBackup(backups, `backup-2026-09-${day}T00-00-00.000Z`, { old: false }));
    runGuard(root);
    assert.ok(existsSync(unfinished), "a backup without a manifest was removed");
    for (const dir of recent) assert.ok(existsSync(dir), `${path.basename(dir)} is under 24 hours old`);
  });
});

test("does nothing while free space is above the threshold", () => {
  withTempRoot((root) => {
    const backups = backupsDirFor(root, "jerry");
    const dirs = ["01", "02", "03"].map((day) => makeBackup(backups, `backup-2026-09-${day}T00-00-00.000Z`));
    const output = runGuard(root, { thresholdGib: "0" });
    assert.match(output, /OK free=/);
    for (const dir of dirs) assert.ok(existsSync(dir));
  });
});
