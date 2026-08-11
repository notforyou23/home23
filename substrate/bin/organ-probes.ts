/**
 * Organ probes — FUNCTION-level health, from receipts (2026-08-11).
 *
 * The disease this cures: PM2 "online" proves a process EXISTS, not that it
 * WORKS. Every zombie this house has suffered (broker online but ssh-dead
 * 11h; seeds online but 401 on every thought; shippers gone with a day of
 * life unshipped) was fully visible in receipts nobody was reading
 * continuously. Each probe below defines what WORKING MEANS for an organ —
 * output follows input, mirrors advance, thoughts succeed — and reads the
 * evidence that already exists. No new claims; just eyes that never blink.
 *
 * Used two ways: the CLI (`node --import tsx substrate/bin/organ-probes.ts`)
 * — EVERY deploy ends with it — and the observatory's sentinel loop, which
 * escalates persistent reds to jtr's phone via the bridge notify path.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = '/Users/jtr/_JTR23_/release/home23';
const PI = '192.168.4.63';

export interface ProbeResult {
  organ: string;
  ok: boolean;
  why: string;
}

function ageMin(mtimeMs: number): number {
  return Math.round((Date.now() - mtimeMs) / 60_000);
}

function fileAgeMin(path: string): number | null {
  try { return ageMin(statSync(path).mtimeMs); } catch { return null; }
}

function tailLines(path: string, n: number): string[] {
  try {
    const raw = readFileSync(path, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim() !== '');
    return lines.slice(-n);
  } catch { return []; }
}

// ── pm2: every home23-* app online (existence — necessary, never sufficient)
function probePm2(): ProbeResult[] {
  try {
    const apps = JSON.parse(execFileSync('pm2', ['jlist'], { timeout: 8_000 }).toString()) as
      Array<{ name: string; pm2_env?: { status?: string; restart_time?: number } }>;
    const out: ProbeResult[] = [];
    for (const a of apps.filter((x) => x.name.startsWith('home23-'))) {
      const status = a.pm2_env?.status ?? '?';
      out.push({
        organ: `pm2:${a.name.replace('home23-', '')}`,
        ok: status === 'online',
        why: status === 'online' ? `online (↺${a.pm2_env?.restart_time ?? 0})` : status,
      });
    }
    return out;
  } catch (e) {
    return [{ organ: 'pm2', ok: false, why: `pm2 unreadable: ${(e as Error).message.slice(0, 60)}` }];
  }
}

// ── shipper flow: output follows input. If a real conversation file is newer
// than the stream's tail by more than the window, the life-feed is BEHIND.
const REAL_SESSION = /^[a-z0-9-]+__(ios_|dashboard-|-?\d+\.jsonl$)/;
function probeShipperFlow(agent: string): ProbeResult {
  const organ = `${agent}-shipper-flow`;
  try {
    const convDir = join(ROOT, 'instances', agent, 'conversations');
    let newestInput = 0;
    for (const name of readdirSync(convDir)) {
      if (!name.endsWith('.jsonl') || !REAL_SESSION.test(name)) continue;
      const m = statSync(join(convDir, name)).mtimeMs;
      if (m > newestInput) newestInput = m;
    }
    if (newestInput === 0) return { organ, ok: true, why: 'no conversation files' };
    const streamPath = join(ROOT, 'instances', agent, 'substrate', 'conversation-stream.jsonl');
    const lines = tailLines(streamPath, 1);
    const tailTs = lines.length > 0 ? Date.parse((JSON.parse(lines[0] as string) as { ts?: string }).ts ?? '') : NaN;
    const inputAge = ageMin(newestInput);
    const lagMin = Number.isNaN(tailTs) ? Infinity : Math.round((newestInput - tailTs) / 60_000);
    if (lagMin > 10) return { organ, ok: false, why: `stream ${lagMin}min behind newest conversation (input ${inputAge}min old)` };
    return { organ, ok: true, why: `stream current (input ${inputAge}min old)` };
  } catch (e) { return { organ, ok: false, why: (e as Error).message.slice(0, 80) }; }
}

// ── bobby's mirror: the broker mirrors every ~10min while the exchange runs.
function probeBobbyMirror(): ProbeResult {
  const age = fileAgeMin(join(ROOT, 'instances', 'bobby', 'seed-01-mirror', 'seed-ledger.jsonl'));
  if (age === null) return { organ: 'bobby-mirror', ok: false, why: 'mirror missing' };
  return { organ: 'bobby-mirror', ok: age <= 15, why: `${age}min old${age > 15 ? ' — broker mirror stalled' : ''}` };
}

// ── seed thought-health: the last lobe outcomes in the runner log. Two
// consecutive errors = the mind is failing (the 401 class, seen in receipts).
function probeSeedThought(agent: string): ProbeResult {
  const organ = `${agent}-seed-thought`;
  const lines = tailLines(join(ROOT, 'instances', agent, 'logs', 'seed-out.log'), 400)
    .filter((l) => / lobe .*applied=/.test(l));
  if (lines.length === 0) return { organ, ok: true, why: 'no recruitments in window' };
  const recent = lines.slice(-2);
  const errors = recent.filter((l) => l.includes('error='));
  if (errors.length === recent.length && recent.length >= 2) {
    const detail = (errors[errors.length - 1] ?? '').split('error=')[1]?.slice(0, 60) ?? 'unknown';
    return { organ, ok: false, why: `last ${recent.length} recruitments failed: ${detail}` };
  }
  return { organ, ok: true, why: `last recruitment ok (${lines.length} in window)` };
}

// ── Pi organs, one ssh round-trip: runner lock alive, sense + journal
// running, exchange not backed up (a request older than 10min with no
// result = the broker's service half is dead even if mirrors work).
function probePi(): ProbeResult[] {
  try {
    const script = [
      'L=$(cat /home/jtr/bobby/seed-01/.runner.lock 2>/dev/null); if [ -n "$L" ] && kill -0 "$L" 2>/dev/null; then echo runner=ok; else echo runner=dead; fi',
      'pgrep -f bobby-sense.cjs >/dev/null && echo sense=ok || echo sense=dead',
      'pgrep -f seed-journal.cjs >/dev/null && echo journal=ok || echo journal=dead',
      'OLD=$(find /home/jtr/bobby/lobe-exchange/requests -name "*.json" -mmin +10 2>/dev/null | wc -l); echo stale_requests=$OLD',
    ].join('; ');
    const out = execFileSync('ssh', ['-o', 'ConnectTimeout=6', PI, script], { timeout: 15_000 }).toString();
    const get = (k: string): string => (out.match(new RegExp(`${k}=(\\S+)`)) ?? [])[1] ?? '?';
    const staleReq = Number(get('stale_requests'));
    return [
      { organ: 'bobby-runner', ok: get('runner') === 'ok', why: get('runner') },
      { organ: 'bobby-sense', ok: get('sense') === 'ok', why: get('sense') },
      { organ: 'bobby-journal', ok: get('journal') === 'ok', why: get('journal') },
      { organ: 'bobby-exchange', ok: !(staleReq > 0), why: staleReq > 0 ? `${staleReq} request(s) unanswered >10min — broker service dead` : 'serviced' },
    ];
  } catch (e) {
    return [{ organ: 'pi', ok: false, why: `unreachable: ${(e as Error).message.slice(0, 60)}` }];
  }
}

// ── engine health: crash-loop velocity is visible as restart-count churn;
// the sentinel diffs counts over time. The CLI reports uptime as the hint.
function probeEngines(): ProbeResult[] {
  try {
    const apps = JSON.parse(execFileSync('pm2', ['jlist'], { timeout: 8_000 }).toString()) as
      Array<{ name: string; pm2_env?: { status?: string; restart_time?: number; pm_uptime?: number } }>;
    const out: ProbeResult[] = [];
    for (const name of ['home23-jerry', 'home23-forrest']) {
      const a = apps.find((x) => x.name === name);
      if (a === undefined) continue;
      const upMin = a.pm2_env?.pm_uptime !== undefined ? ageMin(a.pm2_env.pm_uptime) : null;
      const flapping = upMin !== null && upMin < 10 && (a.pm2_env?.restart_time ?? 0) > 0;
      out.push({
        organ: `engine:${name.replace('home23-', '')}`,
        ok: a.pm2_env?.status === 'online' && !flapping,
        why: `${a.pm2_env?.status} up ${upMin ?? '?'}min ↺${a.pm2_env?.restart_time ?? 0}${flapping ? ' — FLAPPING' : ''}`,
      });
    }
    return out;
  } catch { return []; }
}

export function probeAll(): ProbeResult[] {
  return [
    ...probePm2(),
    probeShipperFlow('jerry'),
    probeShipperFlow('forrest'),
    probeBobbyMirror(),
    probeSeedThought('jerry'),
    probeSeedThought('forrest'),
    ...probeEngines(),
    ...probePi(),
  ];
}

// ── CLI: every deploy ends with this. Exit 1 on any red.
const invokedDirectly = process.argv[1]?.endsWith('organ-probes.ts') === true;
if (invokedDirectly) {
  const results = probeAll();
  let reds = 0;
  for (const r of results) {
    if (!r.ok) reds++;
    console.log(`${r.ok ? '●' : '✖'} ${r.organ.padEnd(28)} ${r.why}`);
  }
  console.log(reds === 0 ? '\nall organs FUNCTIONING' : `\n${reds} organ(s) NOT functioning`);
  process.exit(reds === 0 ? 0 : 1);
}
