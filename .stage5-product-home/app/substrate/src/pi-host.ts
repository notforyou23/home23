/**
 * Where the Pi actually is — resolved, never assumed (2026-08-21).
 *
 * History of this file, which is the reason it exists:
 *   1. Everything addressed the Pi as `jtrpi.local`. Correct, until organs
 *      moved under the PM2 daemon, where macOS denies mDNS — the broker went
 *      dark for 11 hours (2026-08-11).
 *   2. The fix was to hardcode its IP, 192.168.4.63. Correct, until jtr
 *      plugged in ethernet: the Pi's WIRED NIC is a different interface with
 *      a different MAC and a different lease (192.168.4.94), so the hardcoded
 *      address was its now-idle Wi-Fi address and every organ reported the Pi
 *      "unreachable" while it sat there on the wire.
 *
 * Each fix replaced one single point of failure with another. A host has
 * several addresses and they change; the only durable answer is to TRY them
 * and use whichever answers, then SAY WHICH ONE DID. Anything that fails
 * reports what it attempted, so "cannot reach" is never mistaken for
 * "it is down" — that conflation is what told jtr his connected Pi was gone.
 */

import { execFileSync } from 'node:child_process';

/** Candidates in order. Override with PI_HOSTS (csv) — an install that moves
 * the Pi says so in one place instead of editing every organ. */
export function piCandidates(): string[] {
  const raw = process.env['PI_HOSTS'];
  if (raw !== undefined && raw.trim() !== '') {
    return raw.split(',').map((h) => h.trim()).filter((h) => h !== '');
  }
  return [
    '192.168.4.94',      // wired NIC (…8c:ed)
    '192.168.4.63',      // wireless NIC (…8c:ec)
    'jtrpi.local',       // mDNS — works from a login shell, not from daemons
    '100.100.43.119',    // tailnet — survives any LAN change, when it is up
  ];
}

/** The candidate that answered last, tried first next time. Not a cache of
 * REACHABILITY (that would mask a recovery or an outage) — only of order. */
let preferred: string | null = null;

export interface PiReach<T> {
  ok: true;
  host: string;
  out: T;
}
export interface PiUnreachable {
  ok: false;
  /** Every address attempted, with what each said — the honest failure. */
  tried: Array<{ host: string; error: string }>;
}

/**
 * Run one command on the Pi, trying each address until one answers.
 * Synchronous on purpose: every caller (probe suite, sentinel loop, broker)
 * is already synchronous around ssh, and an async ripple would reach the
 * 60s sentinel for no gain.
 */
export function onPi(command: string, opts?: { connectTimeoutSec?: number; timeoutMs?: number }): PiReach<string> | PiUnreachable {
  const connect = String(opts?.connectTimeoutSec ?? 4);
  const timeoutMs = opts?.timeoutMs ?? 15_000;
  const candidates = piCandidates();
  const ordered = preferred !== null && candidates.includes(preferred)
    ? [preferred, ...candidates.filter((h) => h !== preferred)]
    : candidates;
  const tried: Array<{ host: string; error: string }> = [];
  for (const host of ordered) {
    try {
      const out = execFileSync('ssh', ['-o', `ConnectTimeout=${connect}`, '-o', 'BatchMode=yes', host, command], { timeout: timeoutMs }).toString();
      preferred = host;
      return { ok: true, host, out };
    } catch (error) {
      const msg = (error as Error).message.replace(/\s+/g, ' ').slice(0, 70);
      tried.push({ host, error: msg });
    }
  }
  preferred = null;
  return { ok: false, tried };
}

/** One line naming every address attempted — for a probe's `why`. */
export function unreachableWhy(result: PiUnreachable): string {
  return `no address answered (${result.tried.map((t) => t.host).join(', ')}) — this machine cannot reach the Pi; that is not proof the Pi is down`;
}

/**
 * The address that currently answers, for callers that need the HOST STRING
 * itself (rsync targets, not just ssh commands). Caches the winner; pass
 * `force` after a failure so a moved Pi is followed rather than declared
 * dead. `first` (e.g. BROKER_SSH_HOST) is tried ahead of the defaults so an
 * operator's explicit choice still wins.
 */
export function resolvePiHost(opts?: { first?: string; force?: boolean; connectTimeoutSec?: number }): string | null {
  if (opts?.force === true) preferred = null;
  const connect = String(opts?.connectTimeoutSec ?? 4);
  const list = opts?.first !== undefined && opts.first !== ''
    ? [opts.first, ...piCandidates().filter((h) => h !== opts.first)]
    : piCandidates();
  const ordered = preferred !== null && list.includes(preferred)
    ? [preferred, ...list.filter((h) => h !== preferred)]
    : list;
  for (const host of ordered) {
    try {
      execFileSync('ssh', ['-o', `ConnectTimeout=${connect}`, '-o', 'BatchMode=yes', host, 'true'], { timeout: 12_000 });
      preferred = host;
      return host;
    } catch { /* try the next address */ }
  }
  preferred = null;
  return null;
}
