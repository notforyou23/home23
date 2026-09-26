// Repo hygiene: every home-directory read in shipped code is classified.
//
// Under the Home23 Host, HOME is Home23's private runtime home
// (<home>/runtime/user), not the owner's, so os.homedir(), $HOME and
// Path.home() name Home23's own state there. Owner data resolves through the
// one owner-home rule instead (shared/owner-home.cjs; cli/lib uses
// product-environment.js ownerAccountHome, the same passwd rule). See
// docs/reference/OWNER-HOME.md. A home read that is not classified below
// fails, so each new one is an explicit review decision:
//   rule     applies or implements the owner-home contract;
//   private  Home23's own state or a guard, on the runtime HOME by design,
//            marked "product-private:" on the line or just above it;
//   pending  deliberately unchanged until the named decision is made.
//
// Excluded on purpose: tests, documentation, dist and node_modules. Comment
// lines are not reads.
//
// Run directly: node --test tests/scripts/repo-hygiene-owner-home.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCAN_ROOTS = ["engine/src", "src", "shared", "scripts", "cli", "workspace/skills"];
const SKIP_DIRECTORIES = new Set(["node_modules", ".cache", "dist", "tests", "__tests__", "results", "__pycache__"]);
const CODE_EXTENSIONS = new Set([".js", ".cjs", ".mjs", ".ts", ".py", ".sh", ".bash", ".zsh", ".command"]);
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const HOME_READS = [
  /\bhomedir\s*\(/, /\buserInfo\s*\(\s*\)\s*\.\s*homedir\b/, /\.HOME(?![A-Za-z0-9_])/, /\[\s*['"]HOME['"]\s*\]/,
  /\bPath\.home\s*\(/, /\bexpanduser\s*\(/, /\bpw_dir\b/, /\b(?:getenv|environ\.get)\s*\(\s*['"]HOME['"]/,
  /\$HOME(?![A-Za-z0-9_])/, /\$\{HOME(?![A-Za-z0-9_])/, /(?:^|[\s{,(])HOME\s*:/,
];
const COMMENT = /^\s*(\/\/|\/\*|\*|#(?!!))/;
const MARKER = "product-private:";
const CREDENTIALS = "pending: credential-bearing owner paths are not decided";

const CLASSIFIED = new Map([
  ["cli/lib/agent-create.js", [
    ["return homedir()", "pending", "setup '~' folders reach home.yaml shell.roots through createHome, where an owner path blocks updates"],
    ["join(homedir(), raw.slice(2))", "pending", "as above"],
  ]],
  ["cli/lib/evobrew-config.js", [
    ["'.evobrew', 'config.json'", "private", "retired Evobrew store"],
    ["'.cosmo2.3', 'config.json'", "private", "provider store"],
  ]],
  ["cli/lib/product-device-connection.js", [["HOME: userInfo().homedir", "rule", "the Tailscale client runs as the owner account"]]],
  ["cli/lib/product-embedder.js", [["cache === process.env.HOME", "private", "cache guard"]]],
  ["cli/lib/product-environment.js", [
    ["userInfo().homedir", "rule", "ownerAccountHome: the passwd rule"],
    ["HOME: userHome", "rule", "HOME is Home23's runtime home"],
    ["cache === env.HOME", "private", "cache guard"],
  ]],
  ["cli/lib/product-foreign-bindings.js", [["absolute(environment.HOME)", "rule", "HOME counts only outside the home"]]],
  ["engine/src/live-problems/verifiers.js", [["path.join(os.homedir(), p.slice(1))", "pending", "reading the owner's Codex CLI store for the lineage rival check is not decided"]]],
  ["scripts/backfill-ecowitt-pressure.py", [["pwd.getpwuid(os.getuid()).pw_dir", "rule", "HOME23_OWNER_HOME, else passwd"]]],
  ["scripts/chrome-cdp.sh", [["${CDP_USER_DATA_DIR:-$HOME/.home23/chrome-cdp}", "private", "managed Chrome profile; the Host pins CDP_USER_DATA_DIR"]]],
  ["scripts/embedder/artifacts.mjs", [["cacheDir === process.env.HOME", "private", "cache guard; also refuses the owner home"]]],
  ["scripts/log-health-from-forrest.py", [["pwd.getpwuid(os.getuid()).pw_dir", "rule", "HOME23_OWNER_HOME, else passwd"]]],
  ["scripts/log-health.sh", [
    ["${HOME23_OWNER_HOME:-$HOME}/.health_log.jsonl", "rule", "owner cron keeps HOME"],
    ["${HOME23_OWNER_HOME:-$HOME}/.health_log.status.json", "rule", "owner cron keeps HOME"],
  ]],
  ["scripts/log-pressure.sh", [
    ["${HOME23_OWNER_HOME:-$HOME}/.pressure_log.jsonl", "rule", "owner cron keeps HOME"],
    ["${HOME23_OWNER_HOME:-$HOME}/.ssh/id_ed25519_pi", "rule", "owner cron keeps HOME"],
  ]],
  ["scripts/log-workouts.sh", [["${HOME23_OWNER_HOME:-$HOME}/.workouts_log.jsonl", "rule", "owner cron keeps HOME"]]],
  ["scripts/product/package.mjs", [["HOME: process.env.HOME", "private", "publisher build environment"]]],
  ["scripts/product/verify-install.mjs", [["HOME: outputPath", "private", "verification Host environment"]]],
  ["scripts/x-timeline-fetch.sh", [["${HOME23_OWNER_HOME:-$HOME}/.openclaw", "rule", "owner cron keeps HOME"]]],
  ["shared/child-process-env.cjs", [["HOME: ownerHome(base)", "rule", "ownerChildEnv"]]],
  ["shared/home23-oauth.cjs", [["options.userHome) || os.homedir()", "pending", CREDENTIALS]]],
  ["shared/owner-home.cjs", [
    ["os.userInfo().homedir", "rule", "the rule itself"],
    ["absolute(env?.HOME))", "rule", "the rule itself"],
    ["absolute(env?.HOME) || os.homedir()", "rule", "runtimeHome"],
  ]],
  ["shared/research-runtime/lib/config-loader-sync.js", [
    ["path.join(os.homedir(), '.cosmo2.3')", "private", "provider store"],
    ["path.join(os.homedir(), CONFIG_DIR_NAME)", "private", "provider store"],
  ]],
  ["shared/research-runtime/server/services/anthropic-oauth.js", [
    ["'.cosmo2.3', 'config.json'", "private", "provider store"],
    ["'.cosmo2.3', 'database.db'", "private", "provider store"],
    ["'.claude', '.credentials.json'", "pending", CREDENTIALS],
    ["'.claude', 'auth.json'", "pending", CREDENTIALS],
  ]],
  ["src/acp/backends.ts", [
    ["path.join(os.homedir(), '.local', 'bin')]", "pending", CREDENTIALS],
    ["path.join(os.homedir(), '.local', 'bin', name)", "pending", CREDENTIALS],
  ]],
  ["src/agent/tools/shell-fs-authority.ts", [["resolve(process.env.HOME || ''", "pending", "the resident shell's HOME moves with the shell and file tools"]]],
  ["src/browser/cdp.ts", [["env.HOME?.trim() || homedir()", "private", "mirrors scripts/chrome-cdp.sh"]]],
  ["workspace/skills/substack/index.js", [["os.homedir(), \".codex\", \"browser-profiles\"", "pending", CREDENTIALS]]],
  ["workspace/skills/x-research/index.js", [["process.env.HOME || \"\", \".config\"", "pending", CREDENTIALS]]],
]);

function* walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) yield* walk(full);
      continue;
    }
    if (!entry.isFile() || TEST_FILE.test(entry.name)) continue;
    const extension = path.extname(entry.name);
    if (CODE_EXTENSIONS.has(extension) || (extension === "" && readFileSync(full, "utf8").startsWith("#!"))) yield full;
  }
}

export function findHomeReads(repoRoot = REPO_ROOT) {
  const reads = new Map();
  for (const scanRoot of SCAN_ROOTS) {
    for (const file of walk(path.join(repoRoot, scanRoot))) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (COMMENT.test(line) || !HOME_READS.some((pattern) => pattern.test(line))) return;
        const relative = path.relative(repoRoot, file);
        if (!reads.has(relative)) reads.set(relative, []);
        // The marker may sit on the line or in the few lines above it.
        reads.get(relative).push({ line: index + 1, text: line.trim(), marked: lines.slice(Math.max(0, index - 3), index + 1).some((near) => near.includes(MARKER)) });
      });
    }
  }
  return reads;
}

test("every home-directory read in shipped code is classified as owner rule, product-private or pending", () => {
  const reads = findHomeReads();
  const problems = [];
  for (const [file, found] of reads) {
    const expected = CLASSIFIED.get(file) ?? [];
    if (found.length !== expected.length) {
      problems.push(`${file}: ${found.length} home read(s), ${expected.length} classified:\n    ${found.map((read) => `${read.line}: ${read.text}`).join("\n    ")}`);
      continue;
    }
    found.forEach((read, index) => {
      const [signature, kind] = expected[index];
      if (!read.text.includes(signature)) problems.push(`${file}:${read.line} is not the classified read "${signature}": ${read.text}`);
      else if (kind === "private" && !read.marked) problems.push(`${file}:${read.line} is product-private but carries no "${MARKER}" marker`);
    });
  }
  for (const file of CLASSIFIED.keys()) if (!reads.has(file)) problems.push(`${file} is classified but no longer reads a home directory; drop its entry`);
  assert.deepEqual(problems, [], `unclassified or changed home reads; owner data uses shared/owner-home.cjs, Home23's own state is marked "${MARKER}":\n  ${problems.join("\n  ")}`);
});

test("the scan finds each form of home read and skips comments and HOME23_ variables", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "home23-owner-home-scan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = {
    "src/a.ts": ["// os.homedir() in a comment", "const h = os.homedir();", "const e = process.env.HOME;", "const env = { HOME: x };", "const o = process.env.HOME23_OWNER_HOME;"],
    "scripts/b.sh": ["#!/bin/bash", "# $HOME in a comment", "LOG=\"$HOME/x\"", "Y=\"${HOME}/y\"", "Z=\"${HOME23_ROOT}/z\""],
    "scripts/c.py": ["p = Path.home()", "q = os.path.expanduser('~')", "r = os.environ.get('HOME')"],
    "cli/d.js": ["const a = userInfo().homedir;"],
    "shared/e.test.js": ["const skipped = os.homedir();"],
  };
  for (const scanRoot of SCAN_ROOTS) mkdirSync(path.join(root, scanRoot), { recursive: true });
  for (const [file, lines] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), lines.join("\n"));
  }
  const reads = [...findHomeReads(root)].map(([file, found]) => [file, found.map((read) => read.line)]);
  assert.deepEqual(reads, [["src/a.ts", [2, 3, 4]], ["scripts/b.sh", [3, 4]], ["scripts/c.py", [1, 2, 3]], ["cli/d.js", [1]]]);
});
