#!/usr/bin/env node
/**
 * Reap old files from a resident's scratch directory (instances/<agent>/scratch/).
 *
 * Scratch is throwaway shell/exec output — stdout captures, probe scripts,
 * intermediate files. Nothing there is ever cited by a receipt, so nothing
 * there needs to survive. Without a reaper, "scratch" is just slow-motion
 * disk pressure with an unmarked pin.
 *
 * Usage: node scripts/reap-scratch.mjs <scratchDir> [--max-age-days N]
 *
 * Deletes regular files older than max-age-days (default 7, by mtime), then
 * removes any directories left empty. Missing scratchDir is a no-op, not an
 * error — nothing has run there yet. Refuses to run against a path whose
 * final segment isn't literally "scratch", as a guard against a wrong
 * argument reaping something that matters.
 */
import { readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';

const DEFAULT_MAX_AGE_DAYS = 7;

function parseArgs(argv) {
  const positionals = [];
  let maxAgeDays = DEFAULT_MAX_AGE_DAYS;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--max-age-days') {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value <= 0) throw new Error('--max-age-days must be a positive number');
      maxAgeDays = value;
    } else {
      positionals.push(argv[i]);
    }
  }
  if (positionals.length !== 1) throw new Error('Usage: reap-scratch.mjs <scratchDir> [--max-age-days N]');
  return { scratchDir: positionals[0], maxAgeDays };
}

function walk(dir, cutoffMs, summary) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, cutoffMs, summary);
      continue;
    }
    if (!entry.isFile()) continue; // leave symlinks/sockets/etc alone
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.mtimeMs >= cutoffMs) continue;
    try {
      rmSync(full, { force: true });
      summary.filesRemoved += 1;
      summary.bytesFreed += stat.size;
    } catch (error) {
      summary.errors.push(`${full}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function removeEmptyDirs(dir, root, summary) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) removeEmptyDirs(join(dir, entry.name), root, summary);
  }
  if (dir === root) return; // never remove the scratch root itself
  try {
    if (readdirSync(dir).length === 0) {
      rmSync(dir, { recursive: true, force: true });
      summary.dirsRemoved += 1;
    }
  } catch (error) {
    summary.errors.push(`${dir}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function reapScratch(scratchDir, maxAgeDays = DEFAULT_MAX_AGE_DAYS) {
  if (basename(scratchDir) !== 'scratch') {
    throw new Error(`refusing to reap a path not named "scratch": ${scratchDir}`);
  }
  const summary = { scratchDir, maxAgeDays, filesRemoved: 0, dirsRemoved: 0, bytesFreed: 0, errors: [] };
  if (!existsSync(scratchDir)) return summary;
  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  walk(scratchDir, cutoffMs, summary);
  removeEmptyDirs(scratchDir, scratchDir, summary);
  return summary;
}

function isMain() {
  return process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
}

if (isMain()) {
  try {
    const { scratchDir, maxAgeDays } = parseArgs(process.argv.slice(2));
    const summary = reapScratch(scratchDir, maxAgeDays);
    console.log(JSON.stringify(summary));
    if (summary.errors.length) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
