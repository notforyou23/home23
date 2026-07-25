#!/usr/bin/env node
// Regenerate the public what's-new feed (html/updates.json) from the
// site-updates ledger. Called by promotion machinery after each append;
// safe to run any time. Atomic write; newest first; bounded to 100 entries.
//
// html/ content is otherwise deploy-gated — this one DATA file is
// promotion-owned by doctrine (like the existing data JSONs in the webroot).

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";

const LEDGER = "/Users/jtr/websites/shakedownshuffle.com/ops/jerry-collection/runtime/site-updates.jsonl";
const OUT = "/Users/jtr/websites/shakedownshuffle.com/html/updates.json";

const entries = existsSync(LEDGER)
  ? readFileSync(LEDGER, "utf-8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  : [];
const updates = entries
  .filter((e) => e.publish !== false)
  .sort((a, b) => String(b.at).localeCompare(String(a.at)))
  .slice(0, 100)
  .map((e) => ({ at: e.at, type: e.type ?? "default", shows: e.shows ?? [], summary: e.summary ?? null }));

const payload = JSON.stringify({ generatedAt: new Date().toISOString(), updates }, null, 2) + "\n";
const tmp = OUT + ".tmp";
writeFileSync(tmp, payload);
renameSync(tmp, OUT);
console.log(`updates.json: ${updates.length} entries published`);
