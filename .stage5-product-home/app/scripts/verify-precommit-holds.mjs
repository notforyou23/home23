#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

const VALID_STATUSES = new Set(['held', 'pending', 'commit-ready', 'committed', 'cancelled']);
const COMMIT_REF = /^[0-9a-f]{7,64}$/i;

function fail(message) {
  const error = new Error(message);
  error.code = 'precommit_hold_failed';
  throw error;
}

export function validatePreCommitHolds(manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.kind !== 'home23-precommit-holds') {
    fail('invalid pre-commit hold manifest');
  }
  if (manifest.enforced !== true) fail('pre-commit hold manifest is not enforced');
  if (!Array.isArray(manifest.holds) || manifest.holds.length === 0) fail('pre-commit hold manifest has no holds');

  const ids = new Set();
  const violations = [];
  for (const hold of manifest.holds) {
    if (!hold || typeof hold.id !== 'string' || !hold.id.trim()) {
      fail('hold is missing id');
    }
    if (ids.has(hold.id)) fail(`duplicate hold id: ${hold.id}`);
    ids.add(hold.id);
    if (!VALID_STATUSES.has(hold.status)) fail(`invalid hold status for ${hold.id}`);

    if (hold.status !== 'commit-ready') continue;
    const refs = Array.isArray(hold.blockerVerifiedEditCommitRefs)
      ? hold.blockerVerifiedEditCommitRefs
      : [];
    const validRefs = refs.filter((ref) => ref
      && typeof ref.commit === 'string'
      && COMMIT_REF.test(ref.commit)
      && typeof ref.verifiedAt === 'string'
      && !Number.isNaN(Date.parse(ref.verifiedAt)));
    if (validRefs.length === 0) {
      violations.push(`${hold.id}: commit-ready without a blocker-verified edit commit reference`);
    }
  }

  if (violations.length > 0) fail(violations.join('; '));
  return { ok: true, holds: manifest.holds.length };
}

export async function verifyPreCommitHolds(manifestPath) {
  if (!manifestPath) fail('manifest path is required');
  const resolved = path.resolve(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(resolved, 'utf8'));
  } catch (error) {
    fail(`cannot read manifest ${resolved}: ${error.message}`);
  }
  return { ...validatePreCommitHolds(manifest), manifestPath: resolved };
}

async function main() {
  const index = process.argv.indexOf('--manifest');
  const manifestPath = index >= 0 ? process.argv[index + 1] : process.env.DEP_HOLD_MANIFEST;
  const result = await verifyPreCommitHolds(manifestPath);
  process.stdout.write(`pre-commit hold check passed (${result.holds} holds)\n`);
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    process.stderr.write(`pre-commit hold check failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
