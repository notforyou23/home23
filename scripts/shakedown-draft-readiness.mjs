#!/usr/bin/env node
// Shakedown draft-readiness auditor.
//
// jtr's question (2026-07-30): "if there is a proposal for a newsletter, and
// I approve — shouldn't that then be sourced and drafted?"
//
// Reality found: the approval-runner (shakedown-approval-runner.mjs) is
// fail-closed by design and only ever executes deterministic Lane 1 scripts
// with an explicit machineAction contract. Real editorial work (source +
// draft prose) is NOT a Lane 1 action — it needs an agent to write. Several
// [approved] queue cards *claim* a draft already exists ("Lane 1
// finalize-issue-md — jtr editorial pass on the draft") but the claim was
// never re-verified against the filesystem. This script is that verifier:
// for every [approved] card, extract every backtick-quoted path that looks
// like a source/draft file, check it actually exists on disk right now, and
// classify the card so "approved" means something concrete:
//
//   ready-for-edit   — at least one referenced draft file exists on disk now.
//                       jtr can open it and do the edit pass today.
//   needs-drafting   — card is about writing new content but references NO
//                       existing draft file (or explicitly says "no draft yet").
//                       This is the actual sourcing/drafting gap — nothing
//                       will produce this file unless an agent is told to.
//   non-content      — card's action is a Lane 1 script, ops/hygiene, or a
//                       decision that isn't "go write prose" (collection
//                       promotion, updates-feed, retire cards, etc).
//   stale-reference   — card claims a path exists but it does not. This is
//                       worse than needs-drafting: it's an approved card
//                       actively lying about its own readiness.
//
// Usage: node scripts/shakedown-draft-readiness.mjs [--json]

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const H23 = "/Users/jtr/_JTR23_/release/home23";
const PROJECT = join(H23, "instances/jerry/workspace/projects/shakedownshuffle");
const QUEUE = join(PROJECT, "content/article-editorial-queue.md");
// Roots a bare `content/...` or `issues/...` or `newsletter/...` path might be
// relative to — checked in order, first hit wins.
const SEARCH_ROOTS = [
  PROJECT,
  join(H23, "instances/jerry/workspace"),
  join(H23, "instances/jerry/workspace/jtr/jerry-garcia-deep-dive"),
  "/Users/jtr/websites/shakedownshuffle.com/shakedown-v2",
];

const NON_CONTENT_MARKERS = [
  /Lane 1 (collection-promote|updates-feed|build-newsletter|run-publish-scan)/i,
  /no script — jtr's pen/i,
  /queue hygiene/i,
  /send path is jtr's manual/i,
  /SPA code change/i,
  /in the SPA source/i,
];

function parseQueue(src) {
  const out = [];
  const re = /^### \[(proposed|approved|done|rejected|failed|blocked|retired)\] (.+)$/gm;
  let m;
  while ((m = re.exec(src)) !== null) {
    const start = m.index + m[0].length;
    const next = src.slice(start).search(/^### \[/m);
    const bodyEnd = next === -1 ? src.length : start + next;
    out.push({ state: m[1], title: m[2].trim(), body: src.slice(start, bodyEnd).trim() });
  }
  return out;
}

function extractPaths(body) {
  // Backtick-quoted tokens that look like a file path with a plausible ext.
  const re = /`([^`]+\.(?:md|json|mjs|ts|tsx))`/g;
  const paths = new Set();
  let m;
  while ((m = re.exec(body)) !== null) {
    const p = m[1].split(/[*]/)[0].trim(); // drop glob-ish `issue-27-*.md` tails
    if (p.includes("*")) continue;
    paths.add(p);
  }
  return [...paths];
}

function resolveExists(p) {
  if (p.startsWith("/")) return existsSync(p) ? p : null;
  for (const root of SEARCH_ROOTS) {
    const candidate = join(root, p);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function classify(entry) {
  if (entry.state !== "approved") return null;
  const isNonContent = NON_CONTENT_MARKERS.some((re) => re.test(entry.body));
  const paths = extractPaths(entry.body);
  const resolved = paths.map((p) => ({ ref: p, hit: resolveExists(p) }));
  const anyHit = resolved.some((r) => r.hit);
  const anyMiss = resolved.some((r) => !r.hit);
  const claimsNoDraft = /no draft ye|has no draft|flag, do not propose/i.test(entry.body);

  if (isNonContent && !claimsNoDraft) {
    return { title: entry.title, classification: "non-content", paths: resolved };
  }
  if (claimsNoDraft && !anyHit) {
    return { title: entry.title, classification: "needs-drafting", paths: resolved };
  }
  if (paths.length === 0) {
    return { title: entry.title, classification: isNonContent ? "non-content" : "needs-drafting", paths: [] };
  }
  if (anyHit) {
    return { title: entry.title, classification: anyMiss ? "ready-for-edit-partial-stale" : "ready-for-edit", paths: resolved };
  }
  return { title: entry.title, classification: "stale-reference", paths: resolved };
}

function main() {
  const src = readFileSync(QUEUE, "utf-8");
  const entries = parseQueue(src);
  const results = entries.map(classify).filter(Boolean);

  const buckets = { "ready-for-edit": [], "ready-for-edit-partial-stale": [], "needs-drafting": [], "stale-reference": [], "non-content": [] };
  for (const r of results) buckets[r.classification].push(r);

  const asJson = process.argv.includes("--json");
  if (asJson) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), counts: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])), buckets }, null, 2));
    return;
  }

  console.log(`Draft readiness audit — ${entries.filter((e) => e.state === "approved").length} approved cards, generated ${new Date().toISOString()}\n`);
  for (const [bucket, items] of Object.entries(buckets)) {
    console.log(`\n## ${bucket} (${items.length})`);
    for (const it of items) {
      console.log(`- ${it.title}`);
      for (const p of it.paths) console.log(`    ${p.hit ? "OK  " : "MISS"} ${p.ref}${p.hit ? " -> " + p.hit : ""}`);
    }
  }
}

main();
