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
// Health must be read from ONE origin across the whole run. The old version let
// `before` come from localhost and `after` fall back to the public API (or vice
// versa), which produced a delta between two different databases and reported it
// to jtr as fact. Pick a source once, then stay on it or report nothing.
let healthOrigin = null;
const HEALTH_ORIGINS = ["http://127.0.0.1:3005", "https://api.shakedownshuffle.com"];
const health = async () => {
  const origins = healthOrigin ? [healthOrigin] : HEALTH_ORIGINS;
  for (const origin of origins) {
    try {
      const json = await (await fetch(`${origin}/health`)).json();
      healthOrigin = origin;
      return json;
    } catch { /* try the next origin only while unpinned */ }
  }
  return null;
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

// resolve promoted shows to human metadata for the public feed
let shows = [];
if (promoted?.receiptPath) {
  try {
    const receipt = readJson(promoted.receiptPath);
    const ids = (receipt.shows ?? []).map((s) => s.showId ?? s.show_id).filter(Boolean);
    for (const id of ids.slice(0, 20)) {
      try {
        const r = await (await fetch(`https://api.shakedownshuffle.com/api/v1/shows/${id}`)).json();
        const s = r.data ?? r;
        shows.push({ show_id: id, date: s.date ?? null, venue: s.venue ?? null,
          band_name: s.band_name ?? s.band ?? null,
          fileCount: Array.isArray(s.audio_files ?? s.files) ? (s.audio_files ?? s.files).length : null });
      } catch { shows.push({ show_id: id }); }
    }
  } catch {}
}

const entry = {
  at: new Date().toISOString(), type: "audio", shows,
  summary: shows.length ? null : "Collection release promoted.",
  acquired: acquired?.gate ?? null,
  promoted: promoted ? { runId: promoted.runId, manifestSha256: promoted.manifestSha256, receipt: promoted.receiptPath } : null,
  filesAdded: filesDelta, showsAdded: showsDelta,
};
appendFileSync(LEDGER, JSON.stringify(entry) + "\n");

// These two publish the change to the world and to Jerry's next turn. They used
// to be `try {} catch {}` — swallowed whole — while the run still reported
// "SITE UPDATED / Listeners can hear it now". A silent failure here means the
// public feed never regenerated and nobody was told. Collect and report instead.
const postFailures = [];
const step = (label, fn) => {
  try { fn(); } catch (e) { postFailures.push(`${label}: ${String(e.message || e).slice(0, 300)}`); }
};
step("public updates feed (shakedown-updates-feed.mjs)", () =>
  execFileSync("node", [join(H23, "scripts/shakedown-updates-feed.mjs")]));
step("status surface refresh (shakedown-status.mjs)", () =>
  execFileSync("node", [join(H23, "scripts/shakedown-status.mjs")], { cwd: H23 }));

// Only claim listeners can hear it when the numbers actually moved. A promotion
// that added zero files is not a site update, and saying "+0" as if it were one
// is the kind of fake progress that makes the whole report untrustworthy.
const movedForward = filesDelta !== null && (filesDelta > 0 || showsDelta > 0);
const headline = postFailures.length
  ? "PROMOTION LANDED BUT PUBLISH STEPS FAILED — needs a look."
  : movedForward
    ? "SITE UPDATED — new audio promoted to the live collection."
    : filesDelta === null
      ? "PROMOTION RAN — health readback unavailable, NOT verified."
      : "PROMOTION RAN — but the collection counts did not move. Verify before claiming an update.";

note([
  headline,
  promoted ? `  release: ${promoted.runId} (receipt: ${promoted.receiptPath})` : "",
  acquired ? `  acquisition gate: ${acquired.gate}` : "",
  filesDelta !== null
    ? `  audio files: ${filesDelta >= 0 ? "+" : ""}${filesDelta} (now ${after.database?.totalFiles}) · shows: ${showsDelta >= 0 ? "+" : ""}${showsDelta} (now ${after.database?.totalShows}) · source ${healthOrigin}`
    : "  (health readback unavailable — verify manually)",
  `  ledger: ${LEDGER}`,
  ...postFailures.map((f) => `  POST-PROMOTION STEP FAILED — ${f}`),
  postFailures.length
    ? "  The release is promoted, but the public feed and/or status surface may be stale."
    : movedForward
      ? "  Listeners can hear it now. Rollback snapshots were taken pre-promotion."
      : "  Rollback snapshots were taken pre-promotion.",
].filter(Boolean));

// Exit nonzero so cron delivery escalates instead of filing this under "summary".
if (postFailures.length) process.exit(1);
