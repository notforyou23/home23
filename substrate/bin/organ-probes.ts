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

import { readFileSync, readdirSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
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

/**
 * Seed thought-health — CAN THIS INDIVIDUAL STILL FORM A THOUGHT?
 *
 * Rewritten 2026-08-13 after this probe read GREEN through a 43% lifetime
 * thought-failure rate on jerry and 33% on forrest, including 10-of-10
 * blackout windows on both and a 21-hour silence. Three holes, each proven
 * against synthetic input before this rewrite:
 *
 *   1. It examined the LAST TWO recruitments and required BOTH to fail. An
 *      80%-failure interleave (fail,fail,ok,fail,fail,ok…) never presents two
 *      failures at the tail, so chronic degradation read as perfect health.
 *   2. No recruitments found -> `ok: true, 'no recruitments in window'`. An
 *      individual that had STOPPED THINKING ENTIRELY read green. Absence of
 *      evidence returned as evidence of health — the cardinal sin, and the
 *      house's own standing rule broken in the instrument that enforces it.
 *   3. It read a 400-line tail of seed-out.log. Logs rotate; the chain does
 *      not. A rotated log read green.
 *
 * Now: reads the CHAIN (authoritative, append-only), scores a RATE over a
 * window rather than a pair, treats SILENCE as a failure mode in its own
 * right, and returns RED — never green — when it cannot see.
 *
 * Thresholds are taken from the live distributions, not invented: gaps
 * between recruitments run median 36-43min, p99 59-65min, so a 180min
 * silence is ~3x p99 and cannot be ordinary throttling. Failure rate is
 * scored over 10 recruitments because the observed cadence (~33/day) makes
 * that roughly a third of a day of thinking.
 */
const THOUGHT_WINDOW = 10;          // recruitments scored
const THOUGHT_FAIL_RED = 0.5;       // >= half the window failing = the mind is failing
const THOUGHT_SILENCE_MIN = 180;    // ~3x the p99 inter-recruitment gap

/** Byte-tail a large append-only file without reading all of it. */
function tailBytes(path: string, bytes: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = statSync(path).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(Math.min(bytes, size));
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf-8');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** `root` is injectable ONLY so this can be proven against synthetic chains.
 * The first version of this probe shipped untested because it was untestable,
 * and it then read green through a 43% thought-failure rate. */
export function probeSeedThought(agent: string, root: string = ROOT): ProbeResult {
  const organ = `${agent}-seed-thought`;
  const chain = join(root, 'instances', agent, 'substrate', 'seed-01', 'seed-ledger.jsonl');
  let raw: string;
  try {
    raw = tailBytes(chain, 512 * 1024);
  } catch (e) {
    // Cannot see is NOT healthy. This is the branch the old probe got wrong.
    return { organ, ok: false, why: `chain unreadable: ${(e as Error).message.slice(0, 60)}` };
  }

  const outcomes: Array<{ at: number; failed: boolean; error?: string }> = [];
  for (const line of raw.split('\n')) {
    if (!line.includes('"category":"lobe"')) continue;
    try {
      const r = JSON.parse(line) as { issuedAt?: string; payload?: { error?: string } };
      const at = Date.parse(r.issuedAt ?? '');
      if (Number.isNaN(at)) continue;
      const error = r.payload?.error;
      outcomes.push({ at, failed: typeof error === 'string' && error.length > 0, ...(error !== undefined ? { error } : {}) });
    } catch { /* partial first line from the byte-tail cut — skip */ }
  }

  if (outcomes.length === 0) {
    return { organ, ok: false, why: 'NO THOUGHT ON RECORD in the chain window — cannot confirm this individual thinks' };
  }

  const last = outcomes[outcomes.length - 1] as { at: number; failed: boolean; error?: string };
  const silentMin = Math.round((Date.now() - last.at) / 60_000);
  if (silentMin > THOUGHT_SILENCE_MIN) {
    return { organ, ok: false, why: `HAS NOT THOUGHT in ${silentMin}min (p99 gap is ~65min) — recruitment has stopped` };
  }

  const window = outcomes.slice(-THOUGHT_WINDOW);
  const failed = window.filter((o) => o.failed).length;
  const rate = failed / window.length;
  const detail = window.filter((o) => o.failed).pop()?.error?.slice(0, 50) ?? '';
  if (rate >= THOUGHT_FAIL_RED) {
    return { organ, ok: false, why: `${failed}/${window.length} recent thoughts FAILED (${Math.round(rate * 100)}%): ${detail}` };
  }
  return {
    organ,
    ok: true,
    why: `${window.length - failed}/${window.length} thoughts ok, last ${silentMin}min ago${failed > 0 ? ` (${failed} failed — watch)` : ''}`,
  };
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

// ── engine health. Flapping is restart-count CHURN OVER TIME, not "recently
// restarted": the first version flagged uptime<10min with restarts>0, which
// is precisely what a deliberate restart looks like — so a correct deploy
// reported two engines NOT FUNCTIONING and would have paged jtr for doing the
// right thing (2026-08-12). Real flapping is the count rising between
// observations, so remember the last count and compare.
const lastRestartCounts = new Map<string, { count: number; seenAt: number }>();

function probeEngines(): ProbeResult[] {
  try {
    const apps = JSON.parse(execFileSync('pm2', ['jlist'], { timeout: 8_000 }).toString()) as
      Array<{ name: string; pm2_env?: { status?: string; restart_time?: number; pm_uptime?: number } }>;
    const out: ProbeResult[] = [];
    for (const name of ['home23-jerry', 'home23-forrest']) {
      const a = apps.find((x) => x.name === name);
      if (a === undefined) continue;
      const upMin = a.pm2_env?.pm_uptime !== undefined ? ageMin(a.pm2_env.pm_uptime) : null;
      const count = a.pm2_env?.restart_time ?? 0;
      const prior = lastRestartCounts.get(name);
      const now = Date.now();
      // Churn: restarts climbing since the previous observation. A single
      // deliberate restart never trips this; a crash loop trips it every pass.
      const churn = prior !== undefined && count > prior.count;
      const perMin = churn ? (count - prior.count) / Math.max(1, (now - prior.seenAt) / 60_000) : 0;
      lastRestartCounts.set(name, { count, seenAt: now });
      out.push({
        organ: `engine:${name.replace('home23-', '')}`,
        ok: a.pm2_env?.status === 'online' && !churn,
        why: `${a.pm2_env?.status} up ${upMin ?? '?'}min ↺${count}${churn ? ` — RESTARTING (${perMin.toFixed(1)}/min)` : ''}`,
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
