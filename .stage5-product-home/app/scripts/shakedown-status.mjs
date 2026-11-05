#!/usr/bin/env node
// Shakedown status assembler — Task 6 of docs/superpowers/plans/2026-07-25-shakedown-jerry-proposer.md
//
// Read-only. Assembles one compact status surface from authoritative files:
//   collection state + receipts, enrichment state, publish scan, operator report
//   (which already embeds the aggregate-safe subscriber funnel), and the live
//   Home23 cron store. Touches no credentials and makes no network calls —
//   funnel numbers come from the newest operator report, labeled with its age.
//
// Writes:
//   instances/jerry/workspace/SHAKEDOWN_STATUS.md   (compact; loaded via chat.identityFiles)
//   instances/jerry/workspace/projects/shakedownshuffle/status/latest.json (full)

import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join, basename } from "node:path";

const SITE = "/Users/jtr/websites/shakedownshuffle.com";
const OPS = join(SITE, "ops/jerry-collection");
const H23 = "/Users/jtr/_JTR23_/release/home23";
const WS = join(H23, "instances/jerry/workspace");
const OUT_MD = join(WS, "SHAKEDOWN_STATUS.md");
const OUT_DIR = join(WS, "projects/shakedownshuffle/status");
const MD_CAP = 2200; // matches the NOW.md-class context budget

const readJson = (p) => JSON.parse(readFileSync(p, "utf-8"));
const newest = (dir, pattern) => {
  const hits = readdirSync(dir).filter((f) => pattern.test(f));
  if (hits.length === 0) return null;
  return join(dir, hits.map((f) => [f, statSync(join(dir, f)).mtimeMs]).sort((a, b) => b[1] - a[1])[0][0]);
};
const findKey = (obj, key, depth = 0) => {
  if (depth > 5 || obj === null || typeof obj !== "object") return undefined;
  if (key in obj && typeof obj[key] !== "object") return obj[key];
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") {
      const got = findKey(v, key, depth + 1);
      if (got !== undefined) return got;
    }
  }
  return undefined;
};
const ageHours = (iso) => iso ? ((Date.now() - Date.parse(iso)) / 3.6e6).toFixed(1) : "?";

const status = { schema: "shakedown.status.v1", generatedAt: new Date().toISOString(), sources: {}, warnings: [] };

// --- collection ---
try {
  const cursor = readJson(join(OPS, "runtime/state/cursor.json"));
  const recon = readJson(join(OPS, "runtime/state/latest-reconciliation.json"));
  const byStatus = {};
  for (const w of recon.wanted ?? []) byStatus[w.status] = (byStatus[w.status] ?? 0) + 1;
  const dailyPath = newest(join(OPS, "runtime/receipts/daily"), /^daily-collection-.*\.json$/);
  const daily = dailyPath ? readJson(dailyPath) : null;
  status.collection = {
    cursorNextIndex: cursor.nextIndex, passNumber: cursor.passNumber,
    wanted: byStatus,
    lastRun: daily ? { status: daily.status, completedAt: daily.completedAt,
      replayVerified: daily.discovery?.replayVerified ?? null,
      candidates: daily.discovery?.candidateCount ?? null, receipt: basename(dailyPath) } : null,
  };
  status.sources.collection = dailyPath;
} catch (e) { status.warnings.push(`collection: ${e.message}`); }

// --- enrichment ---
try {
  const es = readJson(join(OPS, "runtime/state/enrichment-state.json"));
  status.enrichment = { cursorNextIndex: es.cursor?.nextIndex, updatedAt: es.updatedAt, ageHours: ageHours(es.updatedAt) };
} catch (e) { status.warnings.push(`enrichment: ${e.message}`); }

// --- publish scan ---
try {
  const scanPath = newest(join(SITE, "shakedown-v2/outputs/publishing-pipeline/runs"), /-scan\.json$/);
  const scan = readJson(scanPath);
  status.publishing = {
    total: findKey(scan, "total"), readyOwnedBuild: findKey(scan, "readyOwnedBuild"),
    readySubstackDistribution: findKey(scan, "readySubstackDistribution"),
    readySubstackBacklinkRepair: findKey(scan, "readySubstackBacklinkRepair"),
    alreadyOwnedLive: findKey(scan, "alreadyOwnedLive"), alreadyDistributed: findKey(scan, "alreadyDistributed"),
    scanAt: basename(scanPath).replace(/-scan\.json$/, ""),
    pendingItems: (scan.queue?.items ?? [])
      .filter((i) => i.state && i.state !== "already-distributed" && i.state !== "already-owned-live")
      .map((i) => `${i.slug} [${i.state}] ${i.nextAction ?? ""}`.trim()),
  };
  status.sources.publishing = scanPath;
} catch (e) { status.warnings.push(`publishing: ${e.message}`); }

// --- operator report (embeds the aggregate-safe funnel) ---
try {
  const opPath = newest(join(SITE, "operator-reports"), /^shakedown-operator-check-.*\.json$/);
  const op = readJson(opPath);
  const checks = op.checks ?? [];
  const funnel = op.receipts?.subscriberFunnel ?? {};
  const leads = op.receipts?.listenerLeads ?? {};
  const leak = funnel.identityLeakCheck?.containsEmails;
  if (leak === true) throw new Error("identityLeakCheck failed in operator report — refusing to surface funnel");
  status.site = {
    operatorStatus: op.status, checksPassed: checks.filter((c) => c.ok !== false && c.pass !== false).length,
    checksTotal: checks.length, reportAgeHours: ageHours(op.generatedAt ?? findKey(op, "generatedAt")),
  };
  status.funnel = {
    authUsers: funnel.supabase?.authUsers?.total ?? findKey(op, "userCount"),
    recentSignups7d: funnel.supabase?.authUsers?.recentSignupCount7d ?? findKey(op, "recentSignupCount7d"),
    emailSignups: findKey(op, "emailSignupPool"),
    activeStripeSubscriptions: funnel.conversion?.activeStripeSubscriptions ?? findKey(op, "activeStripeSubscriptions"),
    checkoutPaidRate: funnel.conversion?.checkoutPaidRate ?? findKey(op, "checkoutPaidRate"),
    actionableLeads: leads.actionableLeads ?? findKey(op, "actionableLeads"),
    pendingUnclaimed: funnel.supabase?.pendingSubscriptions?.byStatus?.active ?? findKey(op, "pendingSubscriptions") ?? 0,
    visitsToday: findKey(op, "visitsToday"),
    visits7d: findKey(op, "visits7d"),
    note: "from newest operator report; listener starts land once the SPA adapter deploys to production",
  };
  status.sources.operator = opPath;
} catch (e) { status.warnings.push(`operator/funnel: ${e.message}`); }

// --- editorial pipeline supply (three-role artifacts) ---
// Replaces the retired proposal/approval surface. Owned-site publish no longer
// waits on a jtr decision or an approval runner (both retired 2026-08-08). The
// operational signal is now: ready dossiers not yet consumed, and complete
// drafts ready for the publisher's two checks. Spine: scripts/shakedown-editorial.mjs;
// see RUNBOOK "The editorial pipeline". article-editorial-queue.md is historical.
try {
  const dossiersDir = join(WS, "projects/shakedownshuffle/content/dossiers");
  const draftsDir = join(WS, "projects/shakedownshuffle/content/drafts");
  const readDir = (d) => { try { return readdirSync(d); } catch { return []; } };
  const dossierFiles = readDir(dossiersDir);
  const readyDossiers = dossierFiles
    .filter((f) => f.endsWith(".md") && f !== ".gitkeep")
    .filter((f) => !dossierFiles.includes(`${f.replace(/\.md$/, "")}.consumed.json`))
    .filter((f) => { try { return /(^|\n)state:\s*ready\b/i.test(readFileSync(join(dossiersDir, f), "utf-8")); } catch { return false; } });
  const completeDrafts = readDir(draftsDir)
    .filter((f) => f.endsWith(".md") && !/^proposals?-|^proposer-/.test(f))
    .filter((f) => { try {
      const md = readFileSync(join(draftsDir, f), "utf-8");
      return (/^##\s+SET\s+I\b/im.test(md) && /^##\s+ENCORE\b/im.test(md) && /sources/i.test(md)) || /(^|\n)state:\s*complete\b/i.test(md);
    } catch { return false; } });
  status.editorialPipeline = {
    readyDossiers: readyDossiers.map((f) => f.replace(/\.md$/, "")),
    completeDrafts: completeDrafts.map((f) => f.replace(/\.md$/, "")),
  };
  status.sources.editorialPipeline = { dossiersDir, draftsDir };
} catch (e) { status.warnings.push(`editorialPipeline: ${e.message}`); }

// --- Home23 cron jobs ---
try {
  const store = readJson(join(H23, "instances/jerry/conversations/cron-jobs.json"));
  const jobs = Array.isArray(store) ? store : store.jobs ?? [];
  status.jobs = {};
  for (const id of ["shakedown-collection-daily", "shakedown-editorial-leads", "shakedown-operator-check", "shakedown-publish-scan", "shakedown-proposer-cycle", "shakedown-collection-promote", "shakedown-approval-runner"]) {
    const j = jobs.find((x) => x.id === id);
    status.jobs[id] = j ? { enabled: j.enabled, lastStatus: j.state?.lastStatus ?? null,
      nextRunAt: j.state?.nextRunAtMs ? new Date(j.state.nextRunAtMs).toISOString() : null,
      consecutiveErrors: j.state?.consecutiveErrors ?? 0 } : "not-registered";
  }
} catch (e) { status.warnings.push(`jobs: ${e.message}`); }

// --- write outputs ---
mkdirSync(OUT_DIR, { recursive: true });
const jsonTmp = join(OUT_DIR, "latest.json.tmp");
writeFileSync(jsonTmp, JSON.stringify(status, null, 2) + "\n");
renameSync(jsonTmp, join(OUT_DIR, "latest.json"));

const c = status.collection, f = status.funnel, p = status.publishing, s = status.site, j = status.jobs ?? {};
const jobLine = (id) => {
  const x = j[id];
  if (!x || x === "not-registered") return `${id}: not registered`;
  return `${id}: ${x.lastStatus ?? "no-run-yet"}, next ${x.nextRunAt ?? "?"}${x.consecutiveErrors ? `, ERRORS=${x.consecutiveErrors}` : ""}`;
};
let md = `# Shakedown Status
Generated ${status.generatedAt} by scripts/shakedown-status.mjs. Read the files in
sources (projects/shakedownshuffle/status/latest.json) before acting; this is a digest.
YOU OWN SHAKEDOWN OPERATIONS — runbook: projects/shakedownshuffle/RUNBOOK.md · Desk: http://127.0.0.1:7788
Editorial source corpus: jtr/jerry-garcia-deep-dive/MINING-INDEX.md (on disk, NOT the brain
catalog). 🔒 cosmo-content/_private/ is never read by anything unattended.

${(() => {
  const lines = [];
  if (p?.pendingItems?.length) {
    lines.push(`${p.pendingItems.length} publishing item(s) pending:`);
    lines.push(...p.pendingItems.map((t) => `  - ${t}`));
  }
  return lines.length ? `NEEDS YOU: ${lines.join("\n")}\n` : "NEEDS YOU: nothing pending";
})()}${(() => {
  const ep = status.editorialPipeline;
  if (!ep) return "";
  const bits = [`${ep.readyDossiers?.length ?? 0} ready dossier(s)`, `${ep.completeDrafts?.length ?? 0} complete draft(s) for the publisher's two checks`];
  return `\nEDITORIAL PIPELINE (researcher→writer→publisher, spine scripts/shakedown-editorial.mjs; owned-site publish is authorized, no jtr gate): ${bits.join(" | ")}\n`;
})()}
Collection: cursor ${c?.cursorNextIndex ?? "?"} pass ${c?.passNumber ?? "?"} | wanted ${c?.wanted?.wanted ?? "?"} / have_audio ${c?.wanted?.have_audio ?? "?"} / discovered ${c?.wanted?.discovered ?? "?"}
Last run: ${c?.lastRun ? `${c.lastRun.status} at ${c.lastRun.completedAt} (replayVerified=${c.lastRun.replayVerified}, candidates=${c.lastRun.candidates})` : "none"}
Enrichment: cursor ${status.enrichment?.cursorNextIndex ?? "?"}, updated ${status.enrichment?.ageHours ?? "?"}h ago
Publishing: total ${p?.total ?? "?"} | ownedLive ${p?.alreadyOwnedLive ?? "?"} | distributed ${p?.alreadyDistributed ?? "?"} | readyBuild ${p?.readyOwnedBuild ?? "?"} | readySubstack ${p?.readySubstackDistribution ?? "?"} | backlinkRepair ${p?.readySubstackBacklinkRepair ?? "?"}
Site: operator ${s?.operatorStatus ?? "?"} (${s?.checksPassed ?? "?"}/${s?.checksTotal ?? "?"} checks, report ${s?.reportAgeHours ?? "?"}h old)
${Number(f?.pendingUnclaimed) ? `ATTENTION: ${f.pendingUnclaimed} PAID subscription(s) awaiting account claim — priority zero until resolved\n` : ""}Money path: ${f?.authUsers ?? "?"} auth users (+${f?.recentSignups7d ?? "?"} 7d) | ${f?.emailSignups ?? "?"} email signups | ${f?.activeStripeSubscriptions ?? "?"} active subs | paid-rate ${f?.checkoutPaidRate ?? "?"} | ${f?.actionableLeads ?? "?"} actionable leads
Traffic: ${f?.visitsToday ?? "?"} visits today | ${f?.visits7d ?? "?"} last 7d (Matomo reporting live)
Listener starts: SPA adapter LIVE in production (deployed 2026-07-25) — events accruing

Cron: ${jobLine("shakedown-collection-daily")}
      ${jobLine("shakedown-publish-scan")}
      ${jobLine("shakedown-operator-check")}
      ${jobLine("shakedown-editorial-leads")}
      ${jobLine("shakedown-collection-promote")}
${status.warnings.length ? `\nWARNINGS: ${status.warnings.join(" | ")}\n` : ""}`;
if (md.length > MD_CAP) md = md.slice(0, MD_CAP - 25) + "\n[truncated at cap]\n";
const mdTmp = OUT_MD + ".tmp";
writeFileSync(mdTmp, md);
renameSync(mdTmp, OUT_MD);

console.log(JSON.stringify({ ok: status.warnings.length === 0, warnings: status.warnings,
  mdBytes: md.length, json: join(OUT_DIR, "latest.json") }));
