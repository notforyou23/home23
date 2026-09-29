// Tests for scripts/home23-disk-maintenance.sh — the disk guard that prunes
// generated brain backups under disk pressure.
//
// Run directly: node --test tests/scripts/disk-maintenance.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "home23-disk-maintenance.sh");
const THREE_DAYS_AGO = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
const backupName = (day) => `backup-2026-09-${day}T00-00-00.000Z-123-11111111-1111-4111-8111-111111111111`;

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
    const only = makeBackup(backupsDirFor(root, "forrest"), backupName("01"));
    runGuard(root);
    assert.ok(existsSync(only), "the only backup was removed");
  });
});

test("keeps the newest two backups and removes older ones", () => {
  withTempRoot((root) => {
    const backups = backupsDirFor(root, "jerry");
    const oldest = makeBackup(backups, backupName("01"));
    const middle = makeBackup(backups, backupName("02"));
    const newest = makeBackup(backups, backupName("03"));
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
    const dirs = ["01", "02", "03"].map((day) => makeBackup(backups, backupName(day)));
    const output = runGuard(root, { dataMount: "/dev" });
    for (const dir of dirs) assert.ok(existsSync(dir), `${path.basename(dir)} on another volume was removed`);
    assert.match(output, /SKIP .*other-volume/);
  });
});

test("never follows a symlinked backups folder even on the pressured volume", () => {
  withTempRoot((root) => {
    const relocated = path.join(root, "relocated", "jerry-brain-backups");
    mkdirSync(relocated, { recursive: true });
    const brain = path.join(root, "instances", "jerry", "brain");
    mkdirSync(brain, { recursive: true });
    symlinkSync(relocated, path.join(brain, "backups"));
    const oldest = makeBackup(relocated, backupName("01"));
    const middle = makeBackup(relocated, backupName("02"));
    const newest = makeBackup(relocated, backupName("03"));
    runGuard(root);
    assert.ok(existsSync(oldest), "the backup behind the symlink must remain");
    assert.ok(existsSync(middle));
    assert.ok(existsSync(newest));
  });
});

test("never removes backups newer than 24 hours or without a manifest", () => {
  withTempRoot((root) => {
    const backups = backupsDirFor(root, "jerry");
    const unfinished = makeBackup(backups, backupName("01"), { manifest: false });
    const recent = ["02", "03", "04"].map((day) =>
      makeBackup(backups, backupName(day), { old: false }));
    runGuard(root);
    assert.ok(existsSync(unfinished), "a backup without a manifest was removed");
    for (const dir of recent) assert.ok(existsSync(dir), `${path.basename(dir)} is under 24 hours old`);
  });
});

test("does nothing while free space is above the threshold", () => {
  withTempRoot((root) => {
    const backups = backupsDirFor(root, "jerry");
    const dirs = ["01", "02", "03"].map((day) => makeBackup(backups, backupName(day)));
    const output = runGuard(root, { thresholdGib: "0" });
    assert.match(output, /OK free=/);
    for (const dir of dirs) assert.ok(existsSync(dir));
  });
});

test("selects retained backups before age filtering and honors the global removal bound", () => {
  withTempRoot((root) => {
    const jerry = backupsDirFor(root, "jerry");
    const oldest = ["01", "02"].map((day) => makeBackup(jerry, backupName(day)));
    const retainedOld = makeBackup(jerry, backupName("03"));
    const retainedNew = makeBackup(jerry, backupName("04"), { old: false });
    const forrest = backupsDirFor(root, "forrest");
    const untouched = ["01", "02", "03"].map((day) => makeBackup(forrest, backupName(day)));
    const output = runGuard(root);
    for (const dir of oldest) assert.equal(existsSync(dir), false);
    for (const dir of [retainedOld, retainedNew, ...untouched]) assert.ok(existsSync(dir));
    assert.match(output, /DONE removed=2/);
  });
});

test("keeps manual, incomplete and linked candidates and their targets", () => {
  withTempRoot((root) => {
    const backups = backupsDirFor(root, "jerry");
    const preserved = [
      makeBackup(backups, "manual-snapshot"),
      makeBackup(backups, "backup-manual"),
      makeBackup(backups, `${backupName("01")}.tmp`),
      makeBackup(backups, backupName("02"), { manifest: false }),
    ];
    const linkedManifest = makeBackup(backups, backupName("03"), { manifest: false });
    const manifestTarget = path.join(root, "manual-manifest.json");
    writeFileSync(manifestTarget, "{}\n");
    symlinkSync(manifestTarget, path.join(linkedManifest, "backup-manifest.json"));
    utimesSync(linkedManifest, THREE_DAYS_AGO, THREE_DAYS_AGO);
    preserved.push(linkedManifest, manifestTarget);
    const target = makeBackup(path.join(root, "external"), backupName("04"));
    const linkedCandidate = path.join(backups, backupName("04"));
    symlinkSync(target, linkedCandidate);
    preserved.push(target, linkedCandidate);
    const eligible = makeBackup(backups, backupName("05"));
    preserved.push(makeBackup(backups, backupName("06")), makeBackup(backups, backupName("07")));
    runGuard(root);
    assert.equal(existsSync(eligible), false);
    for (const dir of preserved) assert.ok(existsSync(dir), `${dir} must remain`);
    assert.ok(lstatSync(linkedCandidate).isSymbolicLink());
  });
});

test("never traverses symlinked brain or resident directories", () => {
  withTempRoot((root) => {
    const externalBrain = path.join(root, "external-brain");
    const brainBackups = path.join(externalBrain, "backups");
    const externalResident = path.join(root, "external-resident");
    const residentBackups = path.join(externalResident, "brain", "backups");
    const preserved = [brainBackups, residentBackups].flatMap((dir) =>
      ["01", "02", "03"].map((day) => makeBackup(dir, backupName(day))));
    mkdirSync(path.join(root, "instances", "jerry"), { recursive: true });
    symlinkSync(externalBrain, path.join(root, "instances", "jerry", "brain"));
    symlinkSync(externalResident, path.join(root, "instances", "forrest"));
    runGuard(root);
    for (const dir of preserved) assert.ok(existsSync(dir));
  });
});
