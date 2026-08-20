/**
 * Quote-aware shell write detector for the resident source guard.
 *
 * This is not a sandbox. It only refuses commands whose extractable
 * destinations are tracked repo source. Read-only commands, git, and
 * writes to gitignored house state stay allowed.
 */

import path from 'node:path';
import { refuseResidentWrite } from './tracked-source-guard.js';

const WRITE_VERBS = new Set(['tee', 'cp', 'mv', 'rm', 'rmdir', 'touch', 'truncate', 'install']);
const INPLACE_VERBS = new Set(['sed', 'perl', 'ruby']);
const INTERPRETERS = new Set(['python', 'python3', 'node', 'nodejs']);
const WRITE_SCRIPT = /writeFileSync|\.write\s*\(|open\s*\([^)]*['"](?:w|a)/;
const PATHISH = /[\/.]/;

function isQuote(ch: string): ch is '"' | "'" {
  return ch === '"' || ch === "'";
}

function charAt(text: string, index: number): string {
  return text[index] ?? '';
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

function commandTargets(stage: string, cwd: string): string[] {
  const tokens = tokenize(stage);
  if (tokens.length === 0) return [];
  const verb = path.basename(tokens[0] ?? '');
  const rawPositionals = positionalArgs(tokens);
  const positionals = rawPositionals.map((raw) => resolveTarget(cwd, raw)).filter((p): p is string => Boolean(p));

  if (WRITE_VERBS.has(verb)) {
    if (verb === 'cp' || verb === 'mv' || verb === 'install') {
      return positionals.slice(-1);
    }
    return positionals;
  }

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
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const stage of splitStages(command)) {
    for (const target of [...redirectionTargets(stage, cwd), ...commandTargets(stage, cwd)]) {
      if (seen.has(target)) continue;
      seen.add(target);
      targets.push(target);
    }
  }
  return targets;
}

export function refuseShellWrite(command: string, cwd: string, projectRoot?: string) {
  for (const target of extractShellWriteTargets(command, cwd)) {
    const refused = refuseResidentWrite(target, projectRoot);
    if (refused) return refused;
  }
  return null;
}
