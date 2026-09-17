/**
 * Quote-aware shell write detector for the resident source guard.
 *
 * This is not a sandbox. It only refuses commands whose extractable
 * destinations are tracked repo source. Read-only commands, git, and
 * writes to gitignored house state stay allowed.
 *
 * Known, accepted gaps (statically undecidable without actually running the
 * shell): eval, indirection through a variable ($VAR as a redirect target
 * or command argument), and a nested script (bash foo.sh, npm run x, make)
 * whose own writes are opaque from the caller's command line. Detecting
 * those would mean interpreting the shell instead of scanning its text.
 */

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { refuseResidentWrite } from './tracked-source-guard.js';

const WRITE_VERBS = new Set(['tee', 'cp', 'mv', 'rm', 'rmdir', 'touch', 'truncate', 'install']);
// Verbs whose last positional argument is the write destination, same shape
// as cp/mv/install, but only once there are enough positionals to be sure
// which one is the destination (split with a single positional is reading
// that file, not writing it — its generated PREFIX* output isn't statically
// nameable and is intentionally left uncovered).
const LAST_POSITIONAL_WRITE_VERBS = new Set(['cp', 'mv', 'install', 'ln', 'split']);
const INPLACE_VERBS = new Set(['sed', 'perl', 'ruby']);
const INTERPRETERS = new Set(['python', 'python3', 'node', 'nodejs']);
const WRITE_SCRIPT = /writeFileSync|\.write\s*\(|open\s*\([^)]*['"](?:w|a)/;
const PATHISH = /[\/.]/;

// verb -> flag spellings whose value is a write destination (space- or
// `=`-separated). `dd`'s of=/if= form doesn't fit this shape and is handled
// separately.
const FLAG_VALUE_WRITE_TARGETS: Record<string, string[]> = {
  curl: ['-o', '--output'],
  wget: ['-O', '--output-document'],
  sort: ['-o', '--output'],
  unzip: ['-d'],
};

function isQuote(ch: string): ch is '"' | "'" {
  return ch === '"' || ch === "'";
}

function charAt(text: string, index: number): string {
  return text[index] ?? '';
}

/**
 * Drop heredoc bodies (`<<TAG ... TAG`, `<<-TAG ... TAG`, `<<'TAG' ... TAG`)
 * before any other parsing sees them. A heredoc body is arbitrary payload
 * text, not shell syntax — without this, sample commands or documentation
 * embedded in a heredoc (e.g. a probe script whose payload contains the
 * literal text `> src/agent/loop.ts`) get scanned as if they were real
 * redirects.
 */
function stripHeredocBodies(command: string): string {
  const startRe = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/;
  let out = '';
  let cursor = 0;
  while (cursor < command.length) {
    const rest = command.slice(cursor);
    const match = startRe.exec(rest);
    if (!match) {
      out += rest;
      break;
    }
    const matchStart = cursor + (match.index ?? 0);
    const tag = match[2]!;
    const dashed = match[0].startsWith('<<-');
    const lineEnd = command.indexOf('\n', matchStart);
    if (lineEnd === -1) {
      out += command.slice(cursor);
      cursor = command.length;
      break;
    }
    // Keep the whole line the heredoc marker is on — it can carry its own
    // redirect (`cat <<EOF > out.txt`) after the marker. Only the body,
    // starting on the next line, is dropped.
    out += command.slice(cursor, lineEnd + 1);
    const bodyStart = lineEnd + 1;
    const terminatorRe = dashed
      ? new RegExp(`^[ \\t]*${tag}[ \\t]*$`, 'm')
      : new RegExp(`^${tag}[ \\t]*$`, 'm');
    const termMatch = terminatorRe.exec(command.slice(bodyStart));
    if (!termMatch) {
      // No terminator found — rather than scan an unterminated body as
      // shell syntax, drop the remainder of the command.
      cursor = command.length;
      break;
    }
    const termEnd = bodyStart + (termMatch.index ?? 0) + termMatch[0].length;
    cursor = command[termEnd] === '\n' ? termEnd + 1 : termEnd;
  }
  return out;
}

function splitStages(command: string): string[] {
  const stages: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = charAt(command, i);
    const next = charAt(command, i + 1);
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (isQuote(ch)) {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '\\') {
      current += ch + (next ?? '');
      i += 1;
      continue;
    }
    if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) {
      if (current.trim()) stages.push(current.trim());
      current = '';
      i += 1;
      continue;
    }
    if (ch === ';' || ch === '|') {
      if (current.trim()) stages.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) stages.push(current.trim());
  return stages;
}

function tokenize(stage: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < stage.length; i++) {
    const ch = charAt(stage, i);
    const next = charAt(stage, i + 1);
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (isQuote(ch)) {
      quote = ch;
      continue;
    }
    if (ch === '\\') {
      current += next ?? '';
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function resolveTarget(cwd: string, raw: string): string | null {
  if (!raw || raw === '/dev/null' || raw.startsWith('/dev/fd/') || raw.startsWith('&')) return null;
  if (raw.startsWith('~')) return raw;
  return path.resolve(cwd, raw);
}

function redirectionTargets(stage: string, cwd: string): string[] {
  const targets: string[] = [];
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < stage.length; i++) {
    const ch = charAt(stage, i);
    const next = charAt(stage, i + 1);
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (isQuote(ch)) {
      quote = ch;
      continue;
    }
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch !== '>') continue;
    let cursor = i + 1;
    if (next === '>' || next === '|') cursor += 1;
    while (cursor < stage.length && /\s/.test(charAt(stage, cursor))) cursor += 1;
    if (cursor >= stage.length) break;
    const start = cursor;
    const q = charAt(stage, cursor);
    if (isQuote(q)) {
      cursor += 1;
      while (cursor < stage.length && charAt(stage, cursor) !== q) cursor += 1;
      const dest = resolveTarget(cwd, stage.slice(start + 1, cursor));
      if (dest) targets.push(dest);
      i = cursor;
      continue;
    }
    while (cursor < stage.length && !/[\s;|&]/.test(charAt(stage, cursor))) cursor += 1;
    const dest = resolveTarget(cwd, stage.slice(start, cursor));
    if (dest) targets.push(dest);
    i = cursor - 1;
  }
  return targets;
}

/** First `< file` (or `<'file'`/`<"file"`) input redirect in a stage, used
 * only for patch/git-apply, whose actual write targets live inside that
 * file rather than on the command line. `<<` (heredoc) is not a match here
 * — heredoc bodies are already stripped before this runs. */
function firstInputRedirectionTarget(stage: string, cwd: string): string | null {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < stage.length; i++) {
    const ch = charAt(stage, i);
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (isQuote(ch)) {
      quote = ch;
      continue;
    }
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch !== '<') continue;
    if (charAt(stage, i + 1) === '<') return null;
    let cursor = i + 1;
    while (cursor < stage.length && /\s/.test(charAt(stage, cursor))) cursor += 1;
    if (cursor >= stage.length) return null;
    const start = cursor;
    const q = charAt(stage, cursor);
    if (isQuote(q)) {
      cursor += 1;
      while (cursor < stage.length && charAt(stage, cursor) !== q) cursor += 1;
      return resolveTarget(cwd, stage.slice(start + 1, cursor));
    }
    while (cursor < stage.length && !/[\s;|&]/.test(charAt(stage, cursor))) cursor += 1;
    return resolveTarget(cwd, stage.slice(start, cursor));
  }
  return null;
}

/** tokenize() has no notion of redirection operators — `<`/`>` become
 * ordinary tokens like any other. That's harmless for redirectionTargets
 * (which scans the untokenized stage separately), but positionalArgs()
 * would otherwise treat a redirect operator and its filename as if they
 * were real command arguments. Drop both. */
function withoutRedirectionTokens(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === '<' || token === '<<' || token === '>' || token === '>>') {
      i += 1;
      continue;
    }
    out.push(token);
  }
  return out;
}

function positionalArgs(tokens: string[]): string[] {
  const out: string[] = [];
  let seenDoubleDash = false;
  for (const token of tokens.slice(1)) {
    if (!seenDoubleDash && token === '--') {
      seenDoubleDash = true;
      continue;
    }
    if (!seenDoubleDash && token.startsWith('-')) continue;
    out.push(token);
  }
  return out;
}

function looksLikeInplaceScript(arg: string): boolean {
  return /^[sy](.)(?:.*\1){2}/.test(arg);
}

function hasInplaceFlag(tokens: string[]): boolean {
  return tokens.slice(1).some((token) => token === '--in-place' || token === '-i' || token.startsWith('-i'));
}

function flagValueTargets(tokens: string[], cwd: string, flags: string[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    for (const flag of flags) {
      if (token === flag && tokens[i + 1] !== undefined) {
        const dest = resolveTarget(cwd, tokens[i + 1]!);
        if (dest) out.push(dest);
      } else if (flag.startsWith('--') && token.startsWith(`${flag}=`)) {
        const dest = resolveTarget(cwd, token.slice(flag.length + 1));
        if (dest) out.push(dest);
      }
    }
  }
  return out;
}

function ddTargets(tokens: string[], cwd: string): string[] {
  const out: string[] = [];
  for (const token of tokens.slice(1)) {
    if (token.startsWith('of=')) {
      const dest = resolveTarget(cwd, token.slice(3));
      if (dest) out.push(dest);
    }
  }
  return out;
}

/** tar only writes to -C/--directory in extract mode; in create mode that
 * same flag is just a read-side base directory. Only the unambiguous `-x`
 * spellings and the classic bare-letter-cluster first argument (`tar xzf`)
 * are treated as extract mode; anything else is left unflagged rather than
 * guessed. */
function looksLikeTarExtract(tokens: string[]): boolean {
  if (tokens.slice(1).some((t) => t === '--extract' || /^-[a-zA-Z]*x[a-zA-Z]*$/.test(t))) return true;
  const first = tokens[1];
  return Boolean(first && !first.startsWith('-') && /^[a-zA-Z]{1,6}$/.test(first) && first.includes('x'));
}

function tarTargets(tokens: string[], cwd: string): string[] {
  if (!looksLikeTarExtract(tokens)) return [];
  return flagValueTargets(tokens, cwd, ['-C', '--directory']);
}

/** Best-effort: a unified diff names its own destinations on `+++` lines.
 * Bounded read; anything that doesn't parse as a diff yields no targets
 * rather than throwing. */
function diffDestinationTargets(filePath: string, cwd: string): string[] {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile() || stat.size > 200_000) return [];
    const text = readFileSync(filePath, 'utf-8');
    const out: string[] = [];
    for (const match of text.matchAll(/^\+\+\+ (?:b\/)?(.+?)\s*$/gm)) {
      const raw = match[1]!;
      if (raw === '/dev/null') continue;
      const dest = resolveTarget(cwd, raw);
      if (dest) out.push(dest);
    }
    return out;
  } catch {
    return [];
  }
}

function patchTargets(tokens: string[], stage: string, cwd: string): string[] {
  const positionals = positionalArgs(tokens);
  const out: string[] = [];
  if (positionals[0]) {
    const dest = resolveTarget(cwd, positionals[0]);
    if (dest) out.push(dest);
  }
  const patchFileArg = positionals[1];
  if (patchFileArg) {
    const resolved = resolveTarget(cwd, patchFileArg);
    if (resolved) out.push(...diffDestinationTargets(resolved, cwd));
  } else {
    const stdinPatch = firstInputRedirectionTarget(stage, cwd);
    if (stdinPatch) out.push(...diffDestinationTargets(stdinPatch, cwd));
  }
  return out;
}

function gitApplyTargets(tokens: string[], stage: string, cwd: string): string[] {
  const positionals = positionalArgs(['git-apply', ...tokens.slice(2)]);
  const out: string[] = [];
  for (const candidate of positionals) {
    const resolved = resolveTarget(cwd, candidate);
    if (resolved) out.push(...diffDestinationTargets(resolved, cwd));
  }
  if (positionals.length === 0) {
    const stdinPatch = firstInputRedirectionTarget(stage, cwd);
    if (stdinPatch) out.push(...diffDestinationTargets(stdinPatch, cwd));
  }
  return out;
}

function commandTargets(stage: string, cwd: string): string[] {
  const tokens = withoutRedirectionTokens(tokenize(stage));
  if (tokens.length === 0) return [];
  const verb = path.basename(tokens[0] ?? '');
  const rawPositionals = positionalArgs(tokens);
  const positionals = rawPositionals.map((raw) => resolveTarget(cwd, raw)).filter((p): p is string => Boolean(p));

  if (LAST_POSITIONAL_WRITE_VERBS.has(verb)) {
    return positionals.length >= 2 ? positionals.slice(-1) : [];
  }
  if (WRITE_VERBS.has(verb)) {
    return positionals;
  }

  if (verb === 'dd') return ddTargets(tokens, cwd);
  if (verb === 'tar') return tarTargets(tokens, cwd);
  if (verb === 'patch') return patchTargets(tokens, stage, cwd);
  if (verb === 'git' && tokens[1] === 'apply') return gitApplyTargets(tokens, stage, cwd);
  if (FLAG_VALUE_WRITE_TARGETS[verb]) return flagValueTargets(tokens, cwd, FLAG_VALUE_WRITE_TARGETS[verb]!);

  if (INPLACE_VERBS.has(verb) && hasInplaceFlag(tokens)) {
    return rawPositionals
      .filter((raw) => !looksLikeInplaceScript(raw))
      .map((raw) => resolveTarget(cwd, raw))
      .filter((p): p is string => Boolean(p));
  }

  if (INTERPRETERS.has(verb)) {
    const cIdx = tokens.indexOf('-c');
    const script = cIdx === -1 ? undefined : tokens[cIdx + 1];
    if (!script || !WRITE_SCRIPT.test(script)) return [];
    const literals = [...script.matchAll(/(['"])([^'"]+)\1/g)].map((m) => m[2] ?? '');
    return literals
      .filter((lit) => Boolean(lit) && PATHISH.test(lit) && !['w', 'a', 'r', 'x'].includes(lit))
      .map((lit) => resolveTarget(cwd, lit))
      .filter((p): p is string => Boolean(p));
  }

  return [];
}

export function extractShellWriteTargets(command: string, cwd: string): string[] {
  const stripped = stripHeredocBodies(command);
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const stage of splitStages(stripped)) {
    for (const target of [...redirectionTargets(stage, cwd), ...commandTargets(stage, cwd)]) {
      if (seen.has(target)) continue;
      seen.add(target);
      targets.push(target);
    }
  }
  return targets;
}

export function refuseShellWrite(command: string, cwd: string, projectRoot?: string, instanceDir?: string) {
  for (const target of extractShellWriteTargets(command, cwd)) {
    const refused = refuseResidentWrite(target, projectRoot, instanceDir);
    if (refused) return refused;
  }
  return null;
}
