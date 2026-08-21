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
import { createRequire } from 'node:module';
import { shippableTurn } from '../src/conversation-turn.js';
import { onPi, unreachableWhy } from '../src/pi-host.js';
import { join } from 'node:path';

const ROOT = '/Users/jtr/_JTR23_/release/home23';
// The Pi's addresses now live in one place (src/pi-host.ts) and are TRIED,
// not assumed — see that file for why this constant no longer exists here.

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

export interface Pm2App { name: string; pm2_env?: { status?: string; restart_time?: number; pm_uptime?: number } }

/**
 * The organs an install is SUPPOSED to run, from the generated ecosystem —
 * the same authority `home23 start` uses. Without this the suite can only
 * grade organs pm2 still remembers, and an organ deleted from pm2 produces
 * no row at all: silence, which the suite prints as "all organs
 * FUNCTIONING". This probe suite was BORN from five silent organ deaths and
 * shipped unable to see a sixth (2026-08-13 audit).
 */
export function expectedOrgans(root: string = ROOT): string[] {
  try {
    const require = createRequire(import.meta.url);
    const path = join(root, 'ecosystem.config.cjs');
    delete require.cache[require.resolve(path)];
    const loaded = require(path) as { apps?: Array<{ name?: string; autostart?: boolean }> };
    // `autostart: false` is the file's own statement of intent — home23-watchdog
    // carries it ("disabled pending redesign"). A deliberately-stopped organ
    // reported as GONE is the flapping mistake again: an alarm that fires on
    // correct operator action trains people to ignore the alarm. The ecosystem
    // is loaded as a module so the intent is READ, never pattern-guessed.
    return [...new Set((loaded.apps ?? [])
      .filter((a) => typeof a.name === 'string' && a.name.startsWith('home23-') && a.autostart !== false)
      .map((a) => a.name as string))];
  } catch { return []; }
}

/** Pure judgment — proven against synthetic input; see the audit harness. */
export function judgePm2(apps: Pm2App[] | null, expected: string[]): ProbeResult[] {
  if (apps === null) return [{ organ: 'pm2', ok: false, why: 'pm2 unreadable — cannot confirm ANY organ is alive' }];
  const seen = new Map(apps.filter((x) => x.name.startsWith('home23-')).map((a) => [a.name, a]));
  const out: ProbeResult[] = [];
  for (const a of seen.values()) {
    const status = a.pm2_env?.status ?? '?';
    out.push({
      organ: `pm2:${a.name.replace('home23-', '')}`,
      ok: status === 'online',
      why: status === 'online' ? `online (↺${a.pm2_env?.restart_time ?? 0})` : status,
    });
  }
  // THE HOLE THIS CLOSES: an organ the ecosystem declares but pm2 has never
  // heard of is GONE, not absent-from-the-report.
  for (const name of expected) {
    if (seen.has(name)) continue;
    out.push({ organ: `pm2:${name.replace('home23-', '')}`, ok: false, why: 'DECLARED BY ECOSYSTEM BUT ABSENT FROM PM2 — organ is gone' });
  }
  if (out.length === 0) return [{ organ: 'pm2', ok: false, why: 'no home23 organs found at all' }];
  return out;
}

function probePm2(): ProbeResult[] {
  let apps: Pm2App[] | null = null;
  try { apps = JSON.parse(execFileSync('pm2', ['jlist'], { timeout: 8_000 }).toString()) as Pm2App[]; } catch { apps = null; }
  return judgePm2(apps, expectedOrgans());
}

// ── shipper flow: output follows input. If a real conversation file is newer
// than the stream's tail by more than the window, the life-feed is BEHIND.
const REAL_SESSION = /^[a-z0-9-]+__(ios_|dashboard-|-?\d+\.jsonl$)/;

/** Newest ts among records the SHIPPER would actually ship, across the real
 * session files. Byte-tails each file so this stays cheap in the 60s sentinel.
 * Uses the shipper's own predicate — one definition, no drift. */
function newestShippableTurnTs(convDir: string, entries: string[]): number | null {
  let newest: number | null = null;
  for (const name of entries) {
    if (!name.endsWith('.jsonl') || !REAL_SESSION.test(name)) continue;
    let raw: string;
    try { raw = tailBytes(join(convDir, name), 256 * 1024); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      let rec: Record<string, unknown>;
      try { rec = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      const turn = shippableTurn(rec);
      if (turn === null) continue;
      const t = Date.parse(turn.ts);
      if (Number.isFinite(t) && (newest === null || t > newest)) newest = t;
    }
  }
  return newest;
}
export function probeShipperFlow(agent: string, root: string = ROOT): ProbeResult {
  const organ = `${agent}-shipper-flow`;
  try {
    const convDir = join(root, 'instances', agent, 'conversations');
    const entries = readdirSync(convDir);
    let newestInput = 0;
    let matched = 0;
    for (const name of entries) {
      if (!name.endsWith('.jsonl') || !REAL_SESSION.test(name)) continue;
      matched++;
      const m = statSync(join(convDir, name)).mtimeMs;
      if (m > newestInput) newestInput = m;
    }
    // Audit 2026-08-13: this branch used to return GREEN. An empty
    // conversations dir — or REAL_SESSION drifting out of match after a
    // naming change — meant the life-feed probe reported health while
    // measuring nothing. A shipper with no input to follow is unproven,
    // not proven-good.
    if (matched === 0) {
      return {
        organ, ok: false,
        why: entries.length === 0
          ? 'conversations dir EMPTY — no input to prove the feed against'
          : `${entries.length} file(s) present but NONE match the session pattern — probe is measuring nothing`,
      };
    }
    const streamPath = join(root, 'instances', agent, 'substrate', 'conversation-stream.jsonl');
    const lines = tailLines(streamPath, 1);
    const tailTs = lines.length > 0 ? Date.parse((JSON.parse(lines[0] as string) as { ts?: string }).ts ?? '') : NaN;

    // Compare LIKE WITH LIKE (2026-08-13). This used to measure the newest
    // conversation file's MTIME against the stream's last content timestamp —
    // different quantities. Conversation files carry stream events and
    // turn-completion markers that bump mtime without producing a shippable
    // turn, so a perfectly healthy shipper read as "61min behind" with nothing
    // actually unshipped. Now: newest SHIPPABLE TURN vs newest shipped turn,
    // using the shipper's own exported predicate so the two cannot drift.
    const newestTurnTs = newestShippableTurnTs(convDir, entries);
    if (newestTurnTs === null) {
      return { organ, ok: true, why: `no shippable turn in window (input ${ageMin(newestInput)}min old)` };
    }
    if (Number.isNaN(tailTs)) return { organ, ok: false, why: 'stream has no readable tail — the life-feed is not writing' };
    const lagMin = Math.round((newestTurnTs - tailTs) / 60_000);
    if (lagMin > 10) return { organ, ok: false, why: `${lagMin}min of real turns unshipped` };
    return { organ, ok: true, why: `stream current (newest turn ${ageMin(newestTurnTs)}min old)` };
  } catch (e) { return { organ, ok: false, why: (e as Error).message.slice(0, 80) }; }
}

// ── bobby's mirror: the broker mirrors every ~10min while the exchange runs.
export function probeBobbyMirror(root: string = ROOT): ProbeResult {
  const age = fileAgeMin(join(root, 'instances', 'bobby', 'seed-01-mirror', 'seed-ledger.jsonl'));
  if (age === null) return { organ: 'bobby-mirror', ok: false, why: 'mirror missing' };
  return { organ: 'bobby-mirror', ok: age <= 15, why: `${age}min old${age > 15 ? ' — broker mirror stalled' : ''}` };
}

/**
 * Chain advance — IS THIS INDIVIDUAL STILL LIVING AT ALL?
 *
 * The hole this closes (found 2026-08-21): clay's chain carries a clean
 * `stop` at 2026-08-15T00:47:52Z and its next record at 2026-08-20T23:43:11Z
 * — 142.9 hours in which the self-formation experiment simply did not
 * happen. Nothing caught it. He was the one individual outside PM2, and
 * every probe here was written around the three who are not him: shipper
 * flow, bobby's mirror, seed-thought. clay has no lobe, so a thought probe
 * cannot speak for him; what every individual has is a chain that advances.
 *
 * Threshold from the live distributions, not invented: over the last 3 days
 * the inter-record gap runs p99 13.4min (jerry), 14.9min (forrest), 6.3min
 * (clay), with an observed non-outage max of 39.9min. 60min is ~1.5x the
 * worst ordinary gap and would have shown clay's hole within the hour.
 *
 * Deliberately NOT clever about a chain that stops for a good reason: an
 * individual deliberately stopped still reads RED here, because the sentinel
 * has ORGAN_SENTINEL_IGNORE for a chosen silence. Silence chosen, not blind.
 */
const CHAIN_SILENCE_MIN = 60;

export function probeSeedChain(name: string, stateDir: string, root: string = ROOT): ProbeResult {
  const organ = `${name}-chain`;
  const chain = stateDir.startsWith('/') ? join(stateDir, 'seed-ledger.jsonl') : join(root, stateDir, 'seed-ledger.jsonl');
  let raw: string;
  try {
    raw = tailBytes(chain, 64 * 1024);
  } catch (e) {
    return { organ, ok: false, why: `chain unreadable: ${(e as Error).message.slice(0, 60)}` };
  }
  let newest = NaN;
  let lastCategory = '';
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const r = JSON.parse(line) as { issuedAt?: string; category?: string };
      const at = Date.parse(r.issuedAt ?? '');
      if (!Number.isNaN(at)) { newest = at; lastCategory = r.category ?? ''; }
    } catch { /* partial first line from the byte-tail cut — skip */ }
  }
  // Cannot see is not health — the rule this suite was rewritten around.
  if (Number.isNaN(newest)) return { organ, ok: false, why: 'no readable record in the chain tail — cannot confirm this individual is living' };
  const silentMin = ageMin(newest);
  if (silentMin > CHAIN_SILENCE_MIN) {
    // A closing `stop` receipt names WHY the life ended, which is the whole
    // difference between "crashed" and "nobody started him again".
    const how = lastCategory === 'stop' ? ' after a clean stop — NOBODY RESTARTED HIM' : '';
    return { organ, ok: false, why: `chain has not advanced in ${silentMin}min${how}` };
  }
  return { organ, ok: true, why: `advancing (last record ${silentMin}min ago)` };
}

/**
 * The house-stream shipper's OUTPUT, not its process.
 *
 * Found wedged 2026-08-21: pm2 online, an rsync child hung 1h51m, and no log
 * line since the previous day — bobby's work.house diet starved for 21 hours
 * behind a green process light. The loop appends `HH:MM:SS rc=N` every 30s,
 * so its own log is the receipt: stale log = wedged, nonzero rc = failing.
 */
export function probeHouseStream(logPath: string): ProbeResult {
  const organ = 'bobby-house-shipper-flow';
  const age = fileAgeMin(logPath);
  if (age === null) return { organ, ok: false, why: 'shipper log missing — no evidence the feed runs at all' };
  if (age > 5) return { organ, ok: false, why: `no cycle logged in ${age}min (loop is 30s) — shipper WEDGED` };
  const last = tailLines(logPath, 20).reverse().find((l) => /rc=\d+/.test(l));
  if (last === undefined) return { organ, ok: false, why: 'log has no rc= line — cannot confirm a cycle ever completed' };
  const rc = Number((last.match(/rc=(\d+)/) ?? [])[1]);
  if (rc !== 0) return { organ, ok: false, why: `last cycle failed rc=${rc}` };
  return { organ, ok: true, why: `shipping (last cycle ${age}min ago, rc=0)` };
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
    // A host has several addresses and they change (the Pi's wired NIC took a
    // new lease the day ethernet went in, and every organ then called a live
    // Pi "unreachable"). Try them all; report which one answered.
    const reached = onPi(script, { connectTimeoutSec: 4 });
    if (!reached.ok) return [{ organ: 'pi', ok: false, why: unreachableWhy(reached) }];
    return judgePi(reached.out).map((r) => (r.organ === 'bobby-runner' ? { ...r, why: `${r.why} · via ${reached.host}` } : r));
  } catch (e) {
    return [{ organ: 'pi', ok: false, why: `probe failed: ${(e as Error).message.slice(0, 60)}` }];
  }
}

/** Pure judgment. Audit 2026-08-13: `Number('?')` is NaN and `!(NaN > 0)` is
 * TRUE, so malformed or truncated ssh output graded bobby-exchange GREEN. An
 * unparseable answer is not a healthy answer. */
export function judgePi(out: string | null): ProbeResult[] {
  if (out === null) return [{ organ: 'pi', ok: false, why: 'no response — cannot confirm any Pi organ' }];
  const get = (k: string): string => (out.match(new RegExp(`${k}=(\\S+)`)) ?? [])[1] ?? '?';
  const raw = get('stale_requests');
  const staleReq = Number(raw);
  const parsed = raw !== '?' && Number.isFinite(staleReq);
  return [
    { organ: 'bobby-runner', ok: get('runner') === 'ok', why: get('runner') === '?' ? 'no answer for runner — output malformed' : get('runner') },
    { organ: 'bobby-sense', ok: get('sense') === 'ok', why: get('sense') === '?' ? 'no answer for sense — output malformed' : get('sense') },
    { organ: 'bobby-journal', ok: get('journal') === 'ok', why: get('journal') === '?' ? 'no answer for journal — output malformed' : get('journal') },
    parsed
      ? { organ: 'bobby-exchange', ok: staleReq === 0, why: staleReq > 0 ? `${staleReq} request(s) unanswered >10min — broker service dead` : 'serviced' }
      : { organ: 'bobby-exchange', ok: false, why: 'exchange depth unparseable — cannot confirm the broker is servicing' },
  ];
}

// ── engine health. Flapping is restart-count CHURN OVER TIME, not "recently
// restarted": the first version flagged uptime<10min with restarts>0, which
// is precisely what a deliberate restart looks like — so a correct deploy
// reported two engines NOT FUNCTIONING and would have paged jtr for doing the
// right thing (2026-08-12). Real flapping is the count rising between
// observations, so remember the last count and compare.
const lastRestartCounts = new Map<string, { count: number; seenAt: number }>();

/** Pure judgment. Two holes closed in the 2026-08-13 audit: `catch { return [] }`
 * meant a pm2 failure reported NOTHING rather than red, and a missing engine
 * was `continue`d silently — both of which the suite prints as full health. */
export function judgeEngines(apps: Pm2App[] | null, names: string[] = ['home23-jerry', 'home23-forrest']): ProbeResult[] {
  if (apps === null) {
    return names.map((name) => ({ organ: `engine:${name.replace('home23-', '')}`, ok: false, why: 'pm2 unreadable — cannot confirm the engine is alive' }));
  }
  {
    const out: ProbeResult[] = [];
    for (const name of names) {
      const a = apps.find((x) => x.name === name);
      if (a === undefined) {
        out.push({ organ: `engine:${name.replace('home23-', '')}`, ok: false, why: 'ABSENT FROM PM2 — the engine is gone' });
        continue;
      }
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
  }
}

function probeEngines(): ProbeResult[] {
  let apps: Pm2App[] | null = null;
  try { apps = JSON.parse(execFileSync('pm2', ['jlist'], { timeout: 8_000 }).toString()) as Pm2App[]; } catch { apps = null; }
  return judgeEngines(apps);
}

/**
 * The individuals this install runs, DERIVED from the generated ecosystem —
 * the observatory's own roster, so the probes and jtr's board can never
 * disagree about who exists. Hand-listing is what left clay unwatched.
 * A mirror's freshness belongs to its own probe (bobby-mirror), not here.
 */
export function expectedIndividuals(root: string = ROOT): Array<{ name: string; stateDir: string }> {
  try {
    const require = createRequire(import.meta.url);
    const path = join(root, 'ecosystem.config.cjs');
    delete require.cache[require.resolve(path)];
    const loaded = require(path) as { apps?: Array<{ name?: string; env?: Record<string, string> }> };
    const obs = (loaded.apps ?? []).find((a) => a.name === 'home23-seed-observatory');
    const raw = obs?.env?.['OBSERVATORY_INDIVIDUALS'];
    if (typeof raw !== 'string') return [];
    return (JSON.parse(raw) as Array<{ name?: string; stateDir?: string }>)
      .filter((i): i is { name: string; stateDir: string } => typeof i.name === 'string' && typeof i.stateDir === 'string')
      .filter((i) => !i.stateDir.includes('-mirror'));
  } catch { return []; }
}

/** The declared house-stream shipper's log, by the convention the script
 * itself follows: the loop logs beside its own source, <script>.log. */
function houseStreamLog(root: string = ROOT): string | null {
  try {
    const require = createRequire(import.meta.url);
    const path = join(root, 'ecosystem.config.cjs');
    delete require.cache[require.resolve(path)];
    const loaded = require(path) as { apps?: Array<{ name?: string; script?: string }> };
    const app = (loaded.apps ?? []).find((a) => a.name === 'home23-bobby-house-shipper');
    if (typeof app?.script !== 'string' || !app.script.endsWith('.sh')) return null;
    return app.script.replace(/\.sh$/, '.log');
  } catch { return null; }
}

export function probeAll(): ProbeResult[] {
  const houseLog = houseStreamLog();
  return [
    ...probePm2(),
    probeShipperFlow('jerry'),
    probeShipperFlow('forrest'),
    probeBobbyMirror(),
    ...(houseLog !== null ? [probeHouseStream(houseLog)] : []),
    ...expectedIndividuals().map((i) => probeSeedChain(i.name, i.stateDir)),
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
