#!/usr/bin/env node
/**
 * shakedown-loop.mjs — the single deterministic Shakedown outcome loop.
 *
 * Replaces the prose proposal/approval-queue architecture (proposer cycle,
 * article-editorial-queue, approval-runner, Desk "approved" cards) as the
 * operating model. It does not read or write that queue. Instead it reads the
 * authoritative operational state and reports ONE receipt organized by real
 * outcomes, and — under --apply — advances only genuinely safe, idempotent,
 * deterministic steps by shelling the EXISTING commands. It authors nothing,
 * proposes nothing, and never fakes "selected/proposed/approved" success.
 *
 * Two flows it makes legible (jtr's directive):
 *   editorial:   discover/research -> draft -> validate -> publish/distribute -> measure -> improve
 *   collection:  discover missing shows -> verify -> acquire/build/promote -> verify
 *
 * True safety gates preserved — these are REPORTED as blockers, never auto-run:
 *   spend/money · credentials/external send · schema/DNS · destructive ·
 *   sensitive first-person claims · real ambiguity.
 * Ordinary public editorial publishing is pre-authorized; ad spend is never touched.
 *
 * Modes:
 *   (default)            dry-run: read everything, print the JSON receipt, list
 *                        the safe steps it WOULD run. Mutates nothing.
 *   --apply              run the safe idempotent refresh steps (SAFE_STEPS),
 *                        then re-read and print the receipt.
 *   --apply --promote-collection
 *                        additionally run the self-gated collection promotion
 *                        chain (shakedown-autopromote.mjs). Consequential (writes
 *                        the live catalog) so it is an explicit opt-in, never
 *                        part of the default refresh set.
 *   --text               human summary instead of JSON.
 *
 * The pure core (buildReceipt / deriveBlockers / SAFE_STEPS / COLLECTION_STEPS)
 * is exported and unit-tested with no IO. main() does the reads and the runs.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, basename } from "node:path";

const H23 = "/Users/jtr/_JTR23_/release/home23";
const SITE = "/Users/jtr/websites/shakedownshuffle.com";
const SITE_V2 = join(SITE, "shakedown-v2");
const OPS = join(SITE, "ops/jerry-collection");
const WS = join(H23, "instances/jerry/workspace");
const PROJECT = join(WS, "projects/shakedownshuffle");

// ---------------------------------------------------------------------------
// Step allowlists — the ONLY commands this loop may ever execute, mirroring the
// fail-closed discipline of shakedown-approval-runner.mjs. Every entry is an
// existing, independently-scheduled command. Nothing here sends mail, publishes
// to Substack/Facebook, deploys production, moves money, or touches ad spend.
// ---------------------------------------------------------------------------
const SAFE_STEPS = [
  {
    id: "publish-scan",
    cwd: SITE_V2,
    command: ["npm", "run", "pipeline:scan"],
    why: "Read-only refresh of publishing state (outputs/publishing-pipeline/runs/*-scan.json). Same command the shakedown-publish-scan cron runs.",
    timeoutSeconds: 600,
  },
  {
    id: "updates-feed",
    cwd: H23,
    command: ["node", "scripts/shakedown-updates-feed.mjs"],
    why: "Regenerate the public what's-new feed (html/updates.json) from the existing site-updates ledger. Idempotent; promotion-owned data file.",
    timeoutSeconds: 120,
  },
  {
    id: "status",
    cwd: H23,
    command: ["node", "scripts/shakedown-status.mjs"],
    why: "Rebuild the compact status digest Jerry reads each turn.",
    timeoutSeconds: 120,
  },
];

// Consequential-but-authorized collection advance. Self-gates money/credentials/
// schema/failures internally and is additive + snapshot-first. Explicit opt-in
// only (--promote-collection); the shakedown-collection-promote cron owns the
// routine cadence.
const COLLECTION_STEPS = [
  {
    id: "collection-promote",
    cwd: H23,
    command: ["node", "scripts/shakedown-autopromote.mjs"],
    why: "Run the self-gated acquire->build->promote chain when a candidate/gate is eligible. Additive, hash-bound, snapshot-first; gates money/credentials/schema/failures itself.",
    timeoutSeconds: 5400,
  },
];

// ---------------------------------------------------------------------------
// Pure core — deterministic transforms over already-read state.
// ---------------------------------------------------------------------------

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

/**
 * Real gates only. Each blocker names the outcome it belongs to, the gate class
 * that keeps it human (money/credentials/schema/destructive/sensitive-claims/
 * ambiguity/health), and the concrete next step. Sorted priority-zero first.
 */
function deriveBlockers(state) {
  const out = [];
  const f = state.funnel ?? {};
  const site = state.site ?? {};
  const editorial = state.editorial ?? {};

  if (num(f.pendingUnclaimedPaid) > 0) {
    out.push({
      outcome: "acquisitionFunnel",
      severity: "priority-zero",
      gate: "money",
      what: `${f.pendingUnclaimedPaid} paid subscription(s) awaiting account claim`,
      why: "Money moved, Stripe says active, entitlement is not on the profile. A real person paid and cannot stream.",
      next: "RUNBOOK 'Stranded paid subscriber' — confirm true exposure against Stripe, then stage one personal note (shakedown-stage-mail.mjs). jtr clicks Send. Refund is jtr's call.",
    });
  }

  if (String(site.operatorStatus).toLowerCase() === "fail") {
    out.push({
      outcome: "acquisitionFunnel",
      severity: "attention",
      gate: "health",
      what: "Operator check is failing",
      why: "Site/API/funnel health went red on purpose — usually a stranded-activation SLA breach or a meta.json/route regression.",
      next: "Read the newest operator-reports/shakedown-operator-check-*.json; fix the named failing check.",
    });
  }

  for (const [id, j] of Object.entries(state.jobs ?? {})) {
    if (j && j !== "not-registered" && num(j.consecutiveErrors) > 0) {
      out.push({
        outcome: "archiveCollection",
        severity: "attention",
        gate: "health",
        what: `Cron ${id} is failing (${j.consecutiveErrors} consecutive error(s))`,
        why: "An automation the loop depends on is erroring; downstream state will go stale.",
        next: `Diagnose ${id} before its next run; do not edit the live cron store to silence it.`,
      });
    }
  }

  const claimDrafts = editorial.experientialClaimDrafts ?? [];
  if (claimDrafts.length) {
    out.push({
      outcome: "editorialSupply",
      severity: "attention",
      gate: "sensitive-claims",
      what: `${claimDrafts.length} staged draft(s) contain unverified first-person experiential claims`,
      why: "First-person 'I was there' claims have shipped false before (issue-21). They are unverifiable by machine.",
      next: "jtr confirms each flagged claim is TRUE or cuts it before ship. See draft list in the editorialSupply outcome.",
    });
  }

  if (num(f.actionableLeads) > 0) {
    out.push({
      outcome: "acquisitionFunnel",
      severity: "attention",
      gate: "credentials",
      what: `${f.actionableLeads} unanswered listener lead(s)`,
      why: "People who raised their hand through the newsletter. A reply leaves the house, so it is a jtr Send.",
      next: "Draft an honest reply pointed at what they asked for (content/drafts/comms/), stage with shakedown-stage-mail.mjs; jtr sends.",
    });
  }

  const order = { "priority-zero": 0, attention: 1, info: 2 };
  return out.sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
}

function buildReceipt(state, now, opts = {}) {
  const mode = opts.mode ?? "dry-run";
  const editorial = state.editorial ?? {};
  const pub = state.publishing ?? {};
  const coll = state.collection ?? {};
  const f = state.funnel ?? {};
  const site = state.site ?? {};

  const substackPending = (pub.substackActions ?? []).map((a) => ({
    slug: a.slug ?? a.id,
    substackState: a.substackState ?? "ready-substack-distribution",
    nextAction: a.nextAction ?? null,
    // The command is surfaced so a human/agent can run it deliberately — it is
    // NOT executed by this loop. Publishing/scheduling to Substack is external
    // and credentialed (a logged-in CDP browser session).
    gatedCommand: a.command ?? null,
  }));

  const scheduled = (pub.items ?? [])
    .filter((i) => i.scheduledAt)
    .map((i) => ({ slug: i.slug, scheduledAt: i.scheduledAt, scheduleState: i.scheduleState ?? null }));

  const outcomes = {
    editorialSupply: {
      distinctUnshippedTopics: num(editorial.distinctUnshippedTopics),
      viableDraftFiles: num(editorial.viableDraftFiles),
      stagedAwaitingDistribution: num(editorial.stagedAwaitingDistribution),
      heroPending: num(editorial.heroPending),
      experientialClaimDrafts: editorial.experientialClaimDrafts ?? [],
      topUnshipped: editorial.topUnshipped ?? [],
      source: editorial.source ?? null,
    },
    ownedSitePublication: {
      total: num(pub.total),
      alreadyOwnedLive: num(pub.alreadyOwnedLive),
      readyOwnedBuild: num(pub.readyOwnedBuild),
      // Building an owned page publishes to the live docroot immediately and is
      // gated on a hero render + editorial approval — reported, not auto-run.
      ownedBuilds: (pub.ownedBuilds ?? []).map((b) => ({ slug: b.slug ?? b.id, nextAction: b.nextAction ?? null, gatedCommand: b.command ?? null })),
      note: "Owned-page build/deploy publishes to the live docroot; gated on the mandatory hero render and editorial approval.",
      source: pub.source ?? null,
    },
    substackDistribution: {
      readySubstackDistribution: num(pub.readySubstackDistribution),
      alreadyDistributed: num(pub.alreadyDistributed),
      scheduled,
      pending: substackPending,
      unattendedReadiness: pub.unattendedReadiness ?? null,
      note: "Substack publish/schedule/email is external and credentialed (logged-in CDP session) — never auto-run by this loop; readback confirms trigger_at before claiming a schedule landed.",
      source: pub.source ?? null,
    },
    facebookDistribution: state.facebook ?? {
      available: false,
      note: "No authoritative Facebook distribution source is wired; suppressed until one exists rather than faked.",
    },
    archiveCollection: {
      cursorNextIndex: coll.cursorNextIndex ?? null,
      passNumber: coll.passNumber ?? null,
      wanted: coll.wanted ?? null,
      lastRun: coll.lastRun ?? null,
      gateReady: Boolean(coll.gateReady),
      candidateReady: Boolean(coll.candidateReady),
      enrichmentAgeHours: coll.enrichmentAgeHours ?? null,
      source: coll.source ?? null,
    },
    acquisitionFunnel: {
      activeStripeSubscriptions: num(f.activeStripeSubscriptions),
      pendingUnclaimedPaid: num(f.pendingUnclaimedPaid),
      accountsConfirmedPaid: num(f.activeStripeSubscriptions) + num(f.pendingUnclaimedPaid),
      checkoutPaidRate: f.checkoutPaidRate ?? null,
      authUsers: num(f.authUsers),
      recentSignups7d: num(f.recentSignups7d),
      emailSignups: num(f.emailSignups),
      actionableLeads: num(f.actionableLeads),
      visitsToday: f.visitsToday ?? null,
      visits7d: f.visits7d ?? null,
      operatorStatus: site.operatorStatus ?? null,
      operatorAgeHours: site.reportAgeHours ?? null,
      source: f.source ?? site.source ?? null,
    },
  };

  const available = SAFE_STEPS.map((s) => ({ id: s.id, command: s.command.join(" "), why: s.why }));
  if (opts.promoteCollection) {
    for (const s of COLLECTION_STEPS) available.push({ id: s.id, command: s.command.join(" "), why: s.why });
  }

  const receipt = {
    schema: "shakedown.loop.v1",
    generatedAt: now,
    mode,
    outcomes,
    blockers: deriveBlockers(state),
    safeSteps: { available },
    warnings: state.warnings ?? [],
  };
  return receipt;
}

export { buildReceipt, deriveBlockers, SAFE_STEPS, COLLECTION_STEPS };

// ---------------------------------------------------------------------------
// IO shell — reads authoritative files (defensive, one try/catch per source,
// reusing the extraction patterns proven in shakedown-status.mjs) and runs the
// allowlisted steps. Only executed when invoked as a script.
// ---------------------------------------------------------------------------

const readJson = (p) => JSON.parse(readFileSync(p, "utf-8"));
const newest = (dir, pattern) => {
  const hits = readdirSync(dir).filter((x) => pattern.test(x));
  if (!hits.length) return null;
  return join(dir, hits.map((x) => [x, statSync(join(dir, x)).mtimeMs]).sort((a, b) => b[1] - a[1])[0][0]);
};
const findKey = (obj, key, depth = 0) => {
  if (depth > 6 || obj === null || typeof obj !== "object") return undefined;
  if (key in obj && typeof obj[key] !== "object") return obj[key];
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") {
      const got = findKey(v, key, depth + 1);
      if (got !== undefined) return got;
    }
  }
  return undefined;
};
const ageHours = (iso) => (iso ? ((Date.now() - Date.parse(iso)) / 3.6e6).toFixed(1) : null);

function readState() {
  const warnings = [];
  const state = { warnings, facebook: { available: false, note: "No authoritative Facebook distribution source is wired; suppressed until one exists rather than faked." } };

  // --- editorial supply: read-only supply scan ---
  try {
    const out = execFileSync(process.execPath, [join(H23, "scripts/shakedown-supply-scan.mjs"), "--json"], { encoding: "utf-8", timeout: 60_000 });
    const supply = JSON.parse(out);
    const claimDrafts = [];
    for (const t of supply.unshippedTopics ?? []) {
      const c = t.primary?.experientialClaims?.length ?? 0;
      if (c) claimDrafts.push({ file: t.primary.file, count: c });
    }
    state.editorial = {
      distinctUnshippedTopics: supply.supply?.distinctUnshippedTopics ?? 0,
      viableDraftFiles: supply.supply?.viableDraftFiles ?? 0,
      stagedAwaitingDistribution: supply.supply?.stagedAwaitingDistribution ?? 0,
      heroPending: supply.supply?.heroPending ?? 0,
      experientialClaimDrafts: claimDrafts,
      topUnshipped: (supply.unshippedTopics ?? []).slice(0, 3).map((t) => ({ topic: t.topic, words: t.primary?.words ?? null, path: t.primary?.path ?? null })),
      source: `shakedown-supply-scan.mjs @ ${supply.generatedAt ?? "?"}`,
    };
  } catch (e) { warnings.push(`editorial: ${e.message}`); }

  // --- publishing: newest publish scan ---
  try {
    const scanPath = newest(join(SITE_V2, "outputs/publishing-pipeline/runs"), /-scan\.json$/);
    const scan = readJson(scanPath);
    const items = scan.queue?.items ?? [];
    const oaq = scan.operatorActionQueue ?? {};
    state.publishing = {
      total: findKey(scan, "total") ?? items.length,
      alreadyOwnedLive: findKey(scan, "alreadyOwnedLive") ?? items.filter((i) => i.ownedState === "already-owned-live").length,
      readyOwnedBuild: findKey(scan, "readyOwnedBuild") ?? items.filter((i) => i.ownedState === "ready-owned-build").length,
      readySubstackDistribution: findKey(scan, "readySubstackDistribution") ?? items.filter((i) => i.substackState === "ready-substack-distribution").length,
      alreadyDistributed: findKey(scan, "alreadyDistributed") ?? items.filter((i) => i.substackState === "already-distributed").length,
      items: items.map((i) => ({ slug: i.slug, type: i.type, ownedState: i.ownedState, substackState: i.substackState, scheduleState: i.scheduleState, scheduledAt: i.scheduledAt, nextAction: i.nextAction })),
      ownedBuilds: oaq.ownedBuilds ?? [],
      substackActions: (oaq.substackDistributions ?? []).map((a) => ({ id: a.id, slug: a.slug, substackState: a.substackState, nextAction: a.nextAction, command: a.command })),
      unattendedReadiness: scan.unattendedReadiness ? { status: scan.unattendedReadiness.status, preparationBlockers: scan.unattendedReadiness.preparationBlockers ?? [] } : null,
      source: scanPath ? basename(scanPath) : null,
    };
  } catch (e) { warnings.push(`publishing: ${e.message}`); }

  // --- archive/collection ---
  try {
    const cursor = readJson(join(OPS, "runtime/state/cursor.json"));
    const recon = readJson(join(OPS, "runtime/state/latest-reconciliation.json"));
    const byStatus = {};
    for (const w of recon.wanted ?? []) byStatus[w.status] = (byStatus[w.status] ?? 0) + 1;
    const dailyPath = newest(join(OPS, "runtime/receipts/daily"), /^daily-collection-.*\.json$/);
    const daily = dailyPath ? readJson(dailyPath) : null;
    // Read-only eligibility signals for the promotion chain (same pointers
    // shakedown-autopromote.mjs keys off — we only read them, never mutate).
    let candidateReady = false;
    try { candidateReady = readJson(join(OPS, "runtime/state/release-candidate-publication.json")).status === "candidate_ready_for_approval"; } catch { /* none */ }
    let gateReady = false;
    try {
      gateReady = readdirSync(join(OPS, "runtime/receipts"))
        .filter((x) => x.includes("phase-1-gate") && x.endsWith(".json"))
        .some((x) => { try { return readJson(join(OPS, "runtime/receipts", x)).gateStatus === "complete"; } catch { return false; } });
    } catch { /* none */ }
    let enrichmentAgeHours = null;
    try { enrichmentAgeHours = ageHours(readJson(join(OPS, "runtime/state/enrichment-state.json")).updatedAt); } catch { /* none */ }
    state.collection = {
      cursorNextIndex: cursor.nextIndex, passNumber: cursor.passNumber,
      wanted: byStatus,
      lastRun: daily ? { status: daily.status, completedAt: daily.completedAt, replayVerified: daily.discovery?.replayVerified ?? null, candidates: daily.discovery?.candidateCount ?? null } : null,
      gateReady, candidateReady, enrichmentAgeHours,
      source: dailyPath ? basename(dailyPath) : null,
    };
  } catch (e) { warnings.push(`collection: ${e.message}`); }

  // --- funnel + site (aggregate-safe, from newest operator report) ---
  try {
    const opPath = newest(join(SITE, "operator-reports"), /^shakedown-operator-check-.*\.json$/);
    const op = readJson(opPath);
    const funnel = op.receipts?.subscriberFunnel ?? {};
    const leads = op.receipts?.listenerLeads ?? {};
    if (funnel.identityLeakCheck?.containsEmails === true) throw new Error("identityLeakCheck failed in operator report — refusing to surface funnel");
    const checks = op.checks ?? [];
    state.site = {
      operatorStatus: op.status,
      checksPassed: checks.filter((c) => c.ok !== false && c.pass !== false).length,
      checksTotal: checks.length,
      reportAgeHours: ageHours(op.generatedAt ?? findKey(op, "generatedAt")),
      source: basename(opPath),
    };
    state.funnel = {
      activeStripeSubscriptions: funnel.conversion?.activeStripeSubscriptions ?? findKey(op, "activeStripeSubscriptions") ?? 0,
      pendingUnclaimedPaid: funnel.supabase?.pendingSubscriptions?.byStatus?.active ?? findKey(op, "pendingSubscriptions") ?? 0,
      checkoutPaidRate: funnel.conversion?.checkoutPaidRate ?? findKey(op, "checkoutPaidRate") ?? null,
      authUsers: funnel.supabase?.authUsers?.total ?? findKey(op, "userCount") ?? 0,
      recentSignups7d: funnel.supabase?.authUsers?.recentSignupCount7d ?? findKey(op, "recentSignupCount7d") ?? 0,
      emailSignups: findKey(op, "emailSignupPool") ?? 0,
      actionableLeads: leads.actionableLeads ?? findKey(op, "actionableLeads") ?? 0,
      visitsToday: findKey(op, "visitsToday") ?? null,
      visits7d: findKey(op, "visits7d") ?? null,
      source: basename(opPath),
    };
  } catch (e) { warnings.push(`funnel/operator: ${e.message}`); }

  // --- cron jobs (read-only) ---
  try {
    const store = readJson(join(H23, "instances/jerry/conversations/cron-jobs.json"));
    const jobs = Array.isArray(store) ? store : store.jobs ?? [];
    state.jobs = {};
    for (const id of ["shakedown-collection-daily", "shakedown-editorial-leads", "shakedown-operator-check", "shakedown-publish-scan", "shakedown-collection-promote", "shakedown-status-refresh"]) {
      const j = jobs.find((x) => x.id === id);
      state.jobs[id] = j ? { enabled: j.enabled, lastStatus: j.state?.lastStatus ?? null, consecutiveErrors: j.state?.consecutiveErrors ?? 0, nextRunAt: j.state?.nextRunAtMs ? new Date(j.state.nextRunAtMs).toISOString() : null } : "not-registered";
    }
  } catch (e) { warnings.push(`jobs: ${e.message}`); }

  return state;
}

function runStep(step) {
  const start = Date.now();
  try {
    const stdout = execFileSync(step.command[0], step.command.slice(1), { cwd: step.cwd, timeout: (step.timeoutSeconds ?? 300) * 1000, encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 });
    return { id: step.id, ok: true, ms: Date.now() - start, summary: stdout.trim().split("\n").slice(-3).join(" ").slice(0, 400) };
  } catch (e) {
    return { id: step.id, ok: false, ms: Date.now() - start, error: String(e.stderr || e.message || e).slice(0, 600) };
  }
}

function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const promoteCollection = argv.includes("--promote-collection");
  const asText = argv.includes("--text");

  let ran;
  if (apply) {
    // Run the safe idempotent refreshers, then (opt-in) the self-gated
    // collection promotion, before the final read so the receipt reflects them.
    ran = [];
    const steps = [...SAFE_STEPS, ...(promoteCollection ? COLLECTION_STEPS : [])];
    for (const step of steps) ran.push(runStep(step));
  }

  const state = readState();
  const receipt = buildReceipt(state, new Date().toISOString(), {
    mode: apply ? "apply" : "dry-run",
    promoteCollection,
  });
  if (ran) receipt.safeSteps.ran = ran;

  if (asText) {
    const o = receipt.outcomes;
    const lines = [
      `Shakedown loop — ${receipt.generatedAt} [${receipt.mode}]`,
      `Editorial supply: ${o.editorialSupply.stagedAwaitingDistribution} staged / ${o.editorialSupply.distinctUnshippedTopics} unshipped topics / heroPending ${o.editorialSupply.heroPending}`,
      `Owned site: ${o.ownedSitePublication.alreadyOwnedLive}/${o.ownedSitePublication.total} live, ${o.ownedSitePublication.readyOwnedBuild} ready to build`,
      `Substack: ${o.substackDistribution.alreadyDistributed} distributed, ${o.substackDistribution.readySubstackDistribution} ready (external send — jtr/agent gated)`,
      `Facebook: ${o.facebookDistribution.available ? "available" : "no source wired"}`,
      `Archive: pass ${o.archiveCollection.passNumber}, have_audio ${o.archiveCollection.wanted?.have_audio ?? "?"}, gateReady=${o.archiveCollection.gateReady} candidateReady=${o.archiveCollection.candidateReady}`,
      `Funnel: ${o.acquisitionFunnel.accountsConfirmedPaid} accounts confirmed paid (${o.acquisitionFunnel.activeStripeSubscriptions} active + ${o.acquisitionFunnel.pendingUnclaimedPaid} unclaimed), operator ${o.acquisitionFunnel.operatorStatus}`,
      "",
      receipt.blockers.length ? "BLOCKERS (need jtr):" : "No blockers need jtr.",
      ...receipt.blockers.map((b) => `  [${b.severity}/${b.gate}] ${b.what} — ${b.next}`),
    ];
    if (receipt.safeSteps.ran) lines.push("", "Ran:", ...receipt.safeSteps.ran.map((r) => `  ${r.ok ? "ok" : "FAIL"} ${r.id} (${r.ms}ms)${r.ok ? "" : " — " + r.error}`));
    console.log(lines.join("\n"));
  } else {
    console.log(JSON.stringify(receipt, null, 2));
  }

  // Exit nonzero if an applied step failed or a priority-zero blocker exists, so
  // cron delivery escalates instead of filing under "summary".
  const stepFailed = receipt.safeSteps.ran?.some((r) => !r.ok);
  const priorityZero = receipt.blockers.some((b) => b.severity === "priority-zero");
  if (stepFailed || priorityZero) process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].endsWith("shakedown-loop.mjs")) {
  main();
}
