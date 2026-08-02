#!/usr/bin/env node
// Shakedown approval executor — Task 9 of docs/superpowers/plans/2026-07-25-shakedown-jerry-proposer.md
//
// Closes the missing link between Lane 3 (jtr approval in the markdown queue) and
// Lane 1 (deterministic scripts). Spec: docs/superpowers/specs/2026-07-25-shakedown-jerry-proposer-design.md
//
// FAIL CLOSED BY DESIGN. This runner never shells arbitrary queue prose. A queue
// entry is executable ONLY if its body carries an explicit, structured contract:
//
//   - opportunityId: <stable id>
//   - machineAction: <name from the allowlist below>
//   - args: <single-line JSON object>   (optional; {} if omitted)
//
// As of 2026-07-30, a full read of article-editorial-queue.md found ZERO `[approved]`
// entries carrying this contract — every one is prose written for a human ("action:
// Lane 1 finalize-issue-md" as free text, no opportunityId, no args). That is not a
// bug in this runner; it is the actual state of the queue. Until the proposer (or a
// human editing an entry) writes the structured block, every approved card reports
// as `needs-structuring` and nothing executes. This file's dry-run output is the
// honest inventory of that gap.
//
// State machine per opportunityId, recorded in the ledger (never in the queue markdown
// beyond the existing [approved]/[done]/[failed]/[blocked] markers this script itself
// writes):
//   approved -> running -> done      (script exited 0; queue marker -> [done])
//   approved -> running -> failed    (script exited nonzero; queue marker -> [failed], reason recorded, no auto-retry)
//   approved -> blocked              (no structured contract, or machineAction not allowlisted; queue marker untouched)
//
// Exactly-once: the ledger is keyed by opportunityId. Any opportunityId already in a
// terminal state (done/failed/blocked) is skipped on every subsequent run. No blind
// retries — a failed or blocked entry must be re-approved with a fixed contract (a new
// opportunityId, or a manual ledger edit) to run again.
//
// Modes:
//   --dry-run   Parse + classify every entry. Print inventory. Mutate nothing.
//   (default)   Execute exactly the machine-ready, non-terminal entries, once each.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";

const H23 = "/Users/jtr/_JTR23_/release/home23";
const PROJECT = join(H23, "instances/jerry/workspace/projects/shakedownshuffle");
const QUEUE = join(PROJECT, "content/article-editorial-queue.md");
const LEDGER_DIR = join(H23, "instances/workers/shakedown-jerry/workspace/state");
const LEDGER = join(LEDGER_DIR, "approval-runner-ledger.json");

// --- Lane 1 allowlist ------------------------------------------------------
// Exactly what may ever be executed by this runner. Every entry is an existing
// Lane 1 script named in the spec/plan — nothing invented, nothing free-text.
// Add entries here deliberately, one at a time, reviewed, when a real structured
// card needs a real script. Empty/unmatched machineAction values are ALWAYS blocked.
const ALLOWLIST = {
  // Read-only publish scan. Exactly the command already run daily by the
  // independent `shakedown-publish-scan` cron job (see RUNBOOK.md and
  // docs/superpowers/specs/2026-07-25-shakedown-jerry-proposer-design.md,
  // Lane 1 table). Writes only to shakedown-v2/outputs/publishing-pipeline/runs/
  // — no production write, no deploy, no external send, no money. Verified by
  // hand 2026-07-30: exit 0, idempotent, ~90s. Safe to allowlist.
  "run-publish-scan": {
    cwd: "/Users/jtr/websites/shakedownshuffle.com/shakedown-v2",
    command: ["npm", "run", "pipeline:scan"],
    timeoutSeconds: 180,
  },
  // Deliberately NOT allowlisted: build-newsletter, pipeline:build-owned(:deploy),
  // any pipeline:distribute-substack:*, any outreach/send action. Those write to
  // production (html/ is the live docroot) or leave the house (Substack, email).
  // Both are hard-gated to jtr per docs/superpowers/specs/2026-07-25-shakedown-
  // jerry-proposer-design.md ("Substack stays manual... never cron-registered")
  // and this agent's own agency charter (broad_production_changes,
  // public_publication_or_posting require approval). That gate is correct
  // doctrine, not an unfinished stub — do not add those here without jtr
  // explicitly reviewing the exact command first.
};

const isDryRun = process.argv.includes("--dry-run") || process.argv.includes("--validate");

function loadLedger() {
  if (!existsSync(LEDGER)) return { schema: "shakedown.approval-runner.ledger.v1", entries: {} };
  try {
    return JSON.parse(readFileSync(LEDGER, "utf-8"));
  } catch (e) {
    throw new Error(`ledger unreadable, refusing to run (fix or remove ${LEDGER}): ${e.message}`);
  }
}

function saveLedger(ledger) {
  mkdirSync(LEDGER_DIR, { recursive: true });
  const tmp = LEDGER + ".tmp";
  writeFileSync(tmp, JSON.stringify(ledger, null, 2) + "\n");
  renameSync(tmp, LEDGER);
}

// Parse `### [state] Title` blocks the same way shakedown-desk.mjs does, but also
// pull the structured contract fields out of the body if present.
function parseQueue(src) {
  const out = [];
  const re = /^### \[(proposed|approved|done|rejected|failed|blocked)\] (.+)$/gm;
  let m;
  while ((m = re.exec(src)) !== null) {
    const start = m.index + m[0].length;
    const next = src.slice(start).search(/^### \[/m);
    const bodyEnd = next === -1 ? src.length : start + next;
    const body = src.slice(start, bodyEnd).trim();
    out.push({
      state: m[1],
      title: m[2].trim(),
      headerStart: m.index,
      headerText: m[0],
      bodyStart: start,
      bodyEnd,
      body,
    });
  }
  return out;
}

function extractContract(body) {
  const idMatch = body.match(/^-\s*opportunityId:\s*(\S.*)$/m);
  const actionMatch = body.match(/^-\s*machineAction:\s*(\S.*)$/m);
  const argsMatch = body.match(/^-\s*args:\s*(\{.*\})\s*$/m);
  if (!idMatch || !actionMatch) return null;
  let args = {};
  if (argsMatch) {
    try {
      args = JSON.parse(argsMatch[1]);
    } catch {
      return { opportunityId: idMatch[1].trim(), machineAction: actionMatch[1].trim(), argsError: "args present but not valid JSON" };
    }
  }
  return { opportunityId: idMatch[1].trim(), machineAction: actionMatch[1].trim(), args };
}

function classify(entry, ledger) {
  if (entry.state !== "approved") return { ...entry, classification: `not-approved(${entry.state})` };
  const contract = extractContract(entry.body);
  if (!contract) return { ...entry, classification: "needs-structuring", reason: "no opportunityId + machineAction block in card body" };
  if (contract.argsError) return { ...entry, classification: "blocked", contract, reason: contract.argsError };
  const ledgerEntry = ledger.entries[contract.opportunityId];
  if (ledgerEntry && ["done", "failed", "blocked"].includes(ledgerEntry.status)) {
    return { ...entry, classification: `already-${ledgerEntry.status}`, contract, ledgerEntry };
  }
  if (!ALLOWLIST[contract.machineAction]) {
    return { ...entry, classification: "blocked", contract, reason: `machineAction "${contract.machineAction}" not in allowlist` };
  }
  // Args were parsed and validated, then never used: runOne executes the
  // allowlisted spec.command verbatim. An operator who wrote args into an
  // approved card would reasonably believe they took effect. Passing them
  // through is not the fix either — the allowlist exists to run EXACT
  // pre-reviewed commands, and letting a card append arguments would defeat
  // that. So an approval carrying args is blocked and told why.
  if (contract.args !== undefined
      && !(contract.args && typeof contract.args === 'object' && Object.keys(contract.args).length === 0)) {
    return {
      ...entry,
      classification: "blocked",
      contract,
      reason: `machineAction "${contract.machineAction}" runs a fixed allowlisted command and accepts no args; `
        + `remove the args block or add an argument-aware entry to the allowlist after review`,
    };
  }
  return { ...entry, classification: "machine-ready", contract };
}

function runOne(item, ledger, queueSrcRef) {
  const { contract } = item;
  const spec = ALLOWLIST[contract.machineAction];
  ledger.entries[contract.opportunityId] = {
    status: "running",
    machineAction: contract.machineAction,
    startedAt: new Date().toISOString(),
    title: item.title,
  };
  saveLedger(ledger);

  let outcome;
  try {
    const stdout = execFileSync(spec.command[0], spec.command.slice(1), {
      cwd: spec.cwd,
      timeout: (spec.timeoutSeconds ?? 300) * 1000,
      encoding: "utf-8",
    });
    outcome = { status: "done", stdout: stdout.slice(0, 4000) };
  } catch (e) {
    outcome = { status: "failed", error: String(e.message ?? e).slice(0, 2000) };
  }

  ledger.entries[contract.opportunityId] = {
    ...ledger.entries[contract.opportunityId],
    status: outcome.status,
    finishedAt: new Date().toISOString(),
    ...(outcome.status === "done" ? { stdout: outcome.stdout } : { error: outcome.error }),
  };
  saveLedger(ledger);

  // Rewrite the queue marker for this exact card, atomically, once.
  let src = readFileSync(QUEUE, "utf-8");
  const fromHeader = `### [approved] ${item.title}`;
  if (!src.includes(fromHeader)) {
    // Card moved/edited since we read it — do not guess, leave ledger as source of truth.
    return outcome;
  }
  const stamp = new Date().toISOString();
  const toHeader =
    outcome.status === "done"
      ? `### [done] ${item.title}\n- executed ${stamp} by shakedown-approval-runner, opportunityId=${contract.opportunityId}, machineAction=${contract.machineAction}`
      : `### [failed] ${item.title}\n- failed ${stamp} by shakedown-approval-runner, opportunityId=${contract.opportunityId}: ${outcome.error}`;
  src = src.replace(fromHeader, toHeader);
  const tmp = QUEUE + ".tmp";
  writeFileSync(tmp, src);
  renameSync(tmp, QUEUE);
  return outcome;
}

export { parseQueue, extractContract, classify, ALLOWLIST };

function main() {
  if (!existsSync(QUEUE)) {
    console.log(JSON.stringify({ ok: false, error: `queue not found: ${QUEUE}` }));
    process.exitCode = 1;
    return;
  }
  const src = readFileSync(QUEUE, "utf-8");
  const entries = parseQueue(src);
  const ledger = loadLedger();
  const approved = entries.filter((e) => e.state === "approved");
  const classified = approved.map((e) => classify(e, ledger));

  const counts = classified.reduce((acc, c) => {
    acc[c.classification] = (acc[c.classification] ?? 0) + 1;
    return acc;
  }, {});

  if (isDryRun) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: "dry-run",
          approvedTotal: approved.length,
          counts,
          allowlistSize: Object.keys(ALLOWLIST).length,
          needsStructuring: classified.filter((c) => c.classification === "needs-structuring").map((c) => c.title),
          machineReady: classified.filter((c) => c.classification === "machine-ready").map((c) => ({ title: c.title, opportunityId: c.contract.opportunityId, machineAction: c.contract.machineAction })),
          blocked: classified.filter((c) => c.classification === "blocked").map((c) => ({ title: c.title, reason: c.reason })),
        },
        null,
        2
      )
    );
    return;
  }

  const ready = classified.filter((c) => c.classification === "machine-ready");
  const results = [];
  for (const item of ready) {
    results.push({ title: item.title, opportunityId: item.contract.opportunityId, outcome: runOne(item, ledger, src) });
  }
  // Mark newly-discovered blocked/needs-structuring entries in the ledger too, so
  // repeat runs don't re-derive the same "blocked" reasoning every 30 minutes —
  // but only for entries that actually have a parseable opportunityId; prose-only
  // cards stay untouched in both queue and ledger until structured.
  for (const c of classified) {
    if (c.classification === "blocked" && c.contract?.opportunityId && !ledger.entries[c.contract.opportunityId]) {
      ledger.entries[c.contract.opportunityId] = {
        status: "blocked",
        machineAction: c.contract.machineAction ?? null,
        reason: c.reason,
        recordedAt: new Date().toISOString(),
        title: c.title,
      };
    }
  }
  saveLedger(ledger);

  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: "execute",
        approvedTotal: approved.length,
        counts,
        executed: results.length,
        results,
      },
      null,
      2
    )
  );
}

if (process.argv[1] && process.argv[1].endsWith("shakedown-approval-runner.mjs")) {
  main();
}
