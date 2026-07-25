#!/usr/bin/env node
// Autonomous collection promotion — jtr's 2026-07-25 directive: the system
// finds, judges, updates the live site, and reports; humans gate only money,
// credentials, schema, and failures.
//
// Chain (all existing, test-covered machinery; every step receipted):
//   ready candidate?            -> promote it (token = its own manifestSha256)
//   else complete phase-1 gate? -> acquire:dry -> acquire:local -> release:plan
//                                  -> release:build -> promote
// Verifies via jerry-api /health deltas, appends the public site-updates
// ledger, and prints a human note (cron delivery carries it to jtr).
// Any failure: stop, report loudly, change nothing further — rollback
// snapshots are taken by the promotion machinery itself.
//
// Idempotent by design: keyed off the publication pointer statuses, which the
// underlying scripts flip as each stage lands.

import { readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const OPS = "/Users/jtr/websites/shakedownshuffle.com/ops/jerry-collection";
const STATE = join(OPS, "runtime/state");
const LEDGER = join(OPS, "runtime/site-updates.jsonl");
const H23 = "/Users/jtr/_JTR23_/release/home23";

const readJson = (p) => JSON.parse(readFileSync(p, "utf-8"));
const run = (args, label) => {
  try {
    return execFileSync("npm", ["run", ...args], { cwd: OPS, encoding: "utf-8", maxBuffer: 32 * 1024 * 1024, timeout: 4_500_000 });
  } catch (e) {
    const tail = String(e.stdout || "").slice(-800) + String(e.stderr || "").slice(-400);
    throw new Error(`${label} failed: ${tail}`);
  }
};
const health = async () => {
  try { return await (await fetch("http://127.0.0.1:3005/health")).json(); }
  catch { try { return await (await fetch("https://api.shakedownshuffle.com/health")).json(); } catch { return null; } }
};

const note = (lines) => console.log(lines.join("\n"));
const before = await health();

// ---- Stage A: is a built candidate awaiting promotion?
const candPath = join(STATE, "release-candidate-publication.json");
let promoted = null;
const attemptPromote = () => {
  const cand = readJson(candPath);
  if (cand.status !== "candidate_ready_for_approval") return null;
  // already promoted? (stale pointer after an interrupted flow) — verify-once, not daily
  try {
    const rel = readJson(join(STATE, "release-publication.json"));
    if (rel.status === "promoted" && rel.manifestSha256 === cand.manifestSha256) return null;
  } catch {}
  run(["release:promote", "--", "--manifest", resolve(OPS, cand.manifestPath),
       "--approval-token", cand.manifestSha256], "release:promote");
  const pub = readJson(join(STATE, "release-publication.json"));
  return { manifestSha256: cand.manifestSha256, runId: cand.runId, receiptPath: pub.receiptPath, status: pub.status };
};
promoted = attemptPromote();

// ---- Stage B: no candidate — is acquisition eligible from a complete gate?
let acquired = null;
if (!promoted) {
  const gates = readdirSync(join(OPS, "runtime/receipts"))
    .filter((f) => f.includes("phase-1-gate") && f.endsWith(".json"))
    .map((f) => join(OPS, "runtime/receipts", f))
    .filter((p) => { try { return readJson(p).gateStatus === "complete"; } catch { return false; } })
    .sort();
  const gate = gates[gates.length - 1];
  if (gate) {
    const dry = run(["acquire:dry", "--", "--gate", gate], "acquire:dry");
    if (!/"plannedCount"\s*:\s*0[,}]/.test(dry)) {
      run(["acquire:local", "--", "--gate", gate], "acquire:local");
      acquired = { gate: gate.split("/").pop() };
      const acqPub = join(STATE, "acquisition-publication.json");
      run(["release:plan", "--", "--publication", acqPub], "release:plan");
      run(["release:build", "--", "--publication", acqPub], "release:build");
      promoted = attemptPromote();
    }
  }
}

// ---- Report
if (!promoted && !acquired) {
  note(["shakedown-autopromote: nothing eligible (no ready candidate, no complete gate with acquirable candidates). Normal state."]);
  process.exit(0);
}

const after = await health();
const filesDelta = before && after ? (after.database?.totalFiles ?? 0) - (before.database?.totalFiles ?? 0) : null;
const showsDelta = before && after ? (after.database?.totalShows ?? 0) - (before.database?.totalShows ?? 0) : null;

const entry = {
  at: new Date().toISOString(), type: "audio",
  acquired: acquired?.gate ?? null,
  promoted: promoted ? { runId: promoted.runId, manifestSha256: promoted.manifestSha256, receipt: promoted.receiptPath } : null,
  filesAdded: filesDelta, showsAdded: showsDelta,
};
appendFileSync(LEDGER, JSON.stringify(entry) + "\n");

// refresh the status surface so Jerry's next turn knows
try { execFileSync("node", [join(H23, "scripts/shakedown-status.mjs")], { cwd: H23 }); } catch {}

note([
  "SITE UPDATED — new audio promoted to the live collection.",
  promoted ? `  release: ${promoted.runId} (receipt: ${promoted.receiptPath})` : "",
  acquired ? `  acquisition gate: ${acquired.gate}` : "",
  filesDelta !== null ? `  audio files: +${filesDelta} (now ${after.database?.totalFiles}) · shows: +${showsDelta} (now ${after.database?.totalShows})` : "  (health readback unavailable — verify manually)",
  `  ledger: ${LEDGER}`,
  "  Listeners can hear it now. Rollback snapshots were taken pre-promotion.",
].filter(Boolean));
