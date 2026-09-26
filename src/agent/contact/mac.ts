import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { unprivilegedChildEnv } from '../../security/child-process-env.js';
import type { AttentionItem } from './types.js';

const execFileAsync = promisify(execFile);

export type MacReadSurface = 'calendar' | 'reminders' | 'notes' | 'mail' | 'finder';
export type MacWriteAction = 'create_reminder' | 'run_shortcut';

/** Per-call bounds: the caller's cancellation plus an optional tighter timeout. */
export interface MacRunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface MacRunner {
  jxa(script: string, args?: string[], opts?: MacRunOptions): Promise<string>;
  spotlight?(query: string, onlyIn: string, opts?: MacRunOptions): Promise<string>;
  sqliteJson?(dbPath: string, sql: string, opts?: MacRunOptions): Promise<string>;
}

export interface MacReadOptions {
  signal?: AbortSignal;
}

/** A typed Mac surface failure. `code` (timeout, aborted, ...) also appears in the message the resident sees. */
export class MacSurfaceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'MacSurfaceError';
    this.code = code;
  }
}

function abortCode(signal: AbortSignal): 'timeout' | 'aborted' {
  // combineRequestSignals/AbortSignal.timeout abort with a TimeoutError reason.
  return (signal.reason as { name?: string } | undefined)?.name === 'TimeoutError' ? 'timeout' : 'aborted';
}

function abortedError(signal: AbortSignal, what: string): MacSurfaceError {
  const code = abortCode(signal);
  return new MacSurfaceError(code, `${code}: ${what} ${code === 'timeout' ? 'exceeded its time budget' : 'was cancelled'}`);
}

/** Settle as soon as the signal aborts, even if the work ignores it. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined, what: string): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(abortedError(signal, what));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortedError(signal, what));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

const CALENDAR_SCRIPT = `
ObjC.import('EventKit');
function iso(date) {
  if (!date) return null;
  const js = date.js ? date.js : date;
  try { return new Date(js).toISOString(); } catch (e) { return String(js); }
}
function run(argv) {
  const hours = Number(argv[0] || 36);
  const store = $.EKEventStore.alloc.init;
  let authDone = false, granted = false;
  store.requestAccessToEntityTypeCompletion(0, (g) => { granted = g; authDone = true; });
  const t0 = $.NSDate.date;
  while (!authDone && $.NSDate.date.timeIntervalSinceDate(t0) < 10) {
    $.NSRunLoop.currentRunLoop.runModeBeforeDate($.NSDefaultRunLoopMode, $.NSDate.dateWithTimeIntervalSinceNow(0.05));
  }
  if (!granted) throw new Error('calendar access denied');
  const start = $.NSDate.date;
  const end = start.dateByAddingTimeInterval(hours * 3600);
  const cals = store.calendarsForEntityType(0);
  const pred = store.predicateForEventsWithStartDateEndDateCalendars(start, end, cals);
  const events = store.eventsMatchingPredicate(pred);
  const out = [];
  for (let i = 0; i < events.count; i++) {
    const e = events.objectAtIndex(i);
    out.push({
      kind: 'event',
      id: String(e.eventIdentifier.js),
      title: String(e.title.js),
      when: iso(e.startDate),
      end: iso(e.endDate),
      who: e.organizer && e.organizer.name ? String(e.organizer.name.js) : undefined,
      source: 'mac.calendar',
      excerpt: e.notes ? String(e.notes.js).slice(0, 240) : undefined
    });
  }
  return JSON.stringify(out);
}
`;

const REMINDERS_SCRIPT = `
ObjC.import('EventKit');
function run(argv) {
  const includeCompleted = String(argv[0] || 'false') === 'true';
  const store = $.EKEventStore.alloc.init;
  let authDone = false, granted = false;
  store.requestAccessToEntityTypeCompletion(1, (g) => { granted = g; authDone = true; });
  const t0 = $.NSDate.date;
  while (!authDone && $.NSDate.date.timeIntervalSinceDate(t0) < 10) {
    $.NSRunLoop.currentRunLoop.runModeBeforeDate($.NSDefaultRunLoopMode, $.NSDate.dateWithTimeIntervalSinceNow(0.05));
  }
  if (!granted) throw new Error('reminders access denied');
  const cals = store.calendarsForEntityType(1);
  const pred = store.predicateForRemindersInCalendars(cals);
  let fetched = false; const out = [];
  store.fetchRemindersMatchingPredicateCompletion(pred, (rems) => {
    const n = Number(rems.count);
    for (let i = 0; i < n; i++) {
      const r = rems.objectAtIndex(i);
      const completed = r.completed;
      if (completed && !includeCompleted) continue;
      let due = null;
      const dd = r.dueDateComponents;
      if (!dd.isNil()) { const d = $.NSCalendar.currentCalendar.dateFromComponents(dd); if (!d.isNil()) due = new Date(d.js).toISOString(); }
      out.push({ kind: 'commitment', id: String(r.calendarItemIdentifier.js), title: String(r.title.js), when: due, who: String(r.calendar.title.js), source: 'mac.reminders', needsOwner: !completed, excerpt: r.notes.isNil() ? undefined : String(r.notes.js).slice(0, 240) });
    }
    fetched = true;
  });
  const t1 = $.NSDate.date;
  while (!fetched && $.NSDate.date.timeIntervalSinceDate(t1) < 15) {
    $.NSRunLoop.currentRunLoop.runModeBeforeDate($.NSDefaultRunLoopMode, $.NSDate.dateWithTimeIntervalSinceNow(0.05));
  }
  if (!fetched) throw new Error('reminders fetch timed out');
  return JSON.stringify(out);
}
`;

// Bulk property reads are one Apple Event each for the whole library; per-note
// plaintext reads are capped (most recently modified first) and stop at a
// script-side deadline. The old loop made one event per note until 20 matched.
const NOTES_SCRIPT = `
function run(argv) {
  const query = String(argv[0] || '').toLowerCase();
  const scanCap = Math.max(1, Number(argv[1]) || 300);
  const deadline = Date.now() + (Number(argv[2]) || 8000);
  const Notes = Application('Notes');
  const ids = Notes.notes.id();
  const names = Notes.notes.name();
  const modified = Notes.notes.modificationDate();
  const order = ids.map(function (_, i) { return i; })
    .sort(function (a, b) { return (modified[b] || 0) - (modified[a] || 0); })
    .slice(0, scanCap);
  const limit = 20;
  const out = [];
  const taken = {};
  function plain(i) { try { return String(Notes.notes[i].plaintext()); } catch (e) { return ''; } }
  function take(i, body) {
    taken[i] = true;
    out.push({ kind: 'artifact', id: String(ids[i]), title: String(names[i]), source: 'mac.notes', excerpt: body.slice(0, 280) });
  }
  if (query) {
    for (let k = 0; k < order.length && out.length < limit && Date.now() < deadline; k++) {
      if (String(names[order[k]]).toLowerCase().indexOf(query) !== -1) take(order[k], plain(order[k]));
    }
  }
  for (let k = 0; k < order.length && out.length < limit && Date.now() < deadline; k++) {
    const i = order[k];
    if (taken[i]) continue;
    const body = plain(i);
    if (query && body.toLowerCase().indexOf(query) === -1) continue;
    take(i, body);
  }
  return JSON.stringify(out);
}
`;

export const NOTES_SCAN_CAP = 300;
const NOTES_DEADLINE_MS = 8_000;

const CREATE_REMINDER_SCRIPT = `
function run(argv) {
  const title = String(argv[0] || '');
  const notes = String(argv[1] || '');
  if (!title) throw new Error('title required');
  const Reminders = Application('Reminders');
  const list = Reminders.defaultList();
  const reminder = Reminders.Reminder({ name: title, body: notes || null });
  list.reminders.push(reminder);
  return JSON.stringify({ ok: true, title: title, source: 'mac.reminders' });
}
`;

const RUN_SHORTCUT_SCRIPT = `
function run(argv) {
  const name = String(argv[0] || '');
  if (!name) throw new Error('shortcut name required');
  const Shortcuts = Application('Shortcuts Events');
  Shortcuts.runShortcut(name);
  return JSON.stringify({ ok: true, shortcut: name });
}
`;

async function runBounded(
  file: string,
  args: string[],
  defaults: { timeoutMs: number; maxBuffer: number },
  opts: MacRunOptions = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? defaults.timeoutMs;
  if (opts.signal?.aborted) throw abortedError(opts.signal, file);
  try {
    const { stdout } = await execFileAsync(file, args, {
      timeout: timeoutMs,
      maxBuffer: defaults.maxBuffer,
      env: unprivilegedChildEnv(),
      signal: opts.signal,
    });
    return stdout.trim();
  } catch (error) {
    if (opts.signal?.aborted) throw abortedError(opts.signal, file);
    const failure = error as { killed?: boolean; signal?: string; code?: unknown; stderr?: string };
    if (failure.killed && failure.signal === 'SIGTERM') {
      throw new MacSurfaceError('timeout', `timeout: ${file} exceeded ${timeoutMs} ms`);
    }
    // execFile's own message repeats the whole script; keep the child's stderr instead.
    const detail = String(failure.stderr ?? '').trim().slice(0, 500) || errorMessage(error);
    throw new Error(`${file} failed${typeof failure.code === 'number' ? ` (exit ${failure.code})` : ''}: ${detail}`);
  }
}

export function createOsascriptRunner(): MacRunner {
  return {
    async jxa(script: string, args: string[] = [], opts?: MacRunOptions): Promise<string> {
      return runBounded('osascript', ['-l', 'JavaScript', '-e', script, ...args], { timeoutMs: 30_000, maxBuffer: 2_000_000 }, opts);
    },
    async spotlight(query: string, onlyIn: string, opts?: MacRunOptions): Promise<string> {
      return runBounded('mdfind', ['-onlyin', onlyIn, query], { timeoutMs: 15_000, maxBuffer: 1_000_000 }, opts);
    },
    async sqliteJson(dbPath: string, sql: string, opts?: MacRunOptions): Promise<string> {
      const absolutePath = resolve(dbPath);
      const uri = `file:${encodeURI(absolutePath).replace(/#/g, '%23')}?mode=ro`;
      return runBounded('sqlite3', ['-json', uri, sql], { timeoutMs: 15_000, maxBuffer: 2_000_000 }, opts);
    },
  };
}

interface MailIndexRow {
  rowid: string | number;
  subject: string | null;
  addr: string | null;
  name: string | null;
  ts: string | number;
  read: number;
  mailbox: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function discoverMailEnvelopeIndex(): Promise<string> {
  const mailRoot = resolve(process.env.HOME?.trim() || homedir(), 'Library', 'Mail');
  let entries: string[];
  try {
    entries = await readdir(mailRoot);
  } catch (error) {
    throw new Error(`Envelope Index discovery failed under ${mailRoot}: ${errorMessage(error)}`);
  }

  const versions = entries
    .map((name) => ({ name, version: /^V(\d+)$/.exec(name)?.[1] }))
    .filter((entry): entry is { name: string; version: string } => entry.version !== undefined)
    .sort((left, right) => Number(right.version) - Number(left.version));

  for (const version of versions) {
    const candidate = join(mailRoot, version.name, 'MailData', 'Envelope Index');
    try {
      const info = await stat(candidate);
      if (!info.isFile()) continue;
      await access(candidate, constants.R_OK);
      return candidate;
    } catch {
      // Keep looking for the highest version with a readable index.
    }
  }

  throw new Error(`no readable Envelope Index found under ${mailRoot}/V*/MailData`);
}

function escapeSqlLike(value: string): string {
  return value
    .replace(/!/g, '!!')
    .replace(/'/g, "''")
    .replace(/%/g, '!%')
    .replace(/_/g, '!_');
}

function mailIndexQuery(query: string): string {
  const normalized = query.trim();
  const filter = normalized
    ? `\n and (lower(coalesce(s.subject,'')) like lower('%${escapeSqlLike(normalized)}%') escape '!'\n  or lower(coalesce(a.address,'')) like lower('%${escapeSqlLike(normalized)}%') escape '!'\n  or lower(coalesce(a.comment,'')) like lower('%${escapeSqlLike(normalized)}%') escape '!')`
    : '';
  const limit = normalized ? 25 : 15;
  return `select m.ROWID as rowid, s.subject as subject, a.address as addr, a.comment as name, m.date_received as ts, m.read as read, mb.url as mailbox
from messages m
 join mailboxes mb on mb.ROWID = m.mailbox
 left join subjects s on s.ROWID = m.subject
 left join addresses a on a.ROWID = m.sender
where m.deleted = 0 and (mb.url like '%/INBOX' or mb.url like '%/INBOX/%')${filter}
order by m.date_received desc limit ${limit};`;
}

function mailboxExcerpt(mailbox: string | null): string | undefined {
  const segment = mailbox?.split('/').filter(Boolean).at(-1);
  if (!segment) return undefined;
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // Preserve a malformed but still useful mailbox hint.
  }
  return `Mailbox: ${decoded.slice(0, 120)}`;
}

function parseMailIndexRows(raw: string): AttentionItem[] {
  const parsed = JSON.parse(raw || '[]');
  if (!Array.isArray(parsed)) throw new Error('sqlite output was not a JSON array');
  return (parsed as MailIndexRow[]).map((row) => {
    const name = row.name ? String(row.name) : '';
    const address = row.addr ? String(row.addr) : '';
    return {
      kind: 'message' as const,
      id: `mac.mail:${row.rowid}`,
      title: row.subject ? String(row.subject) : '(no subject)',
      who: name ? `${name} <${address}>` : (address || 'unknown'),
      when: new Date(Number(row.ts) * 1000).toISOString(),
      needsOwner: row.read === 0,
      source: 'mac.mail',
      excerpt: mailboxExcerpt(row.mailbox),
    };
  });
}

async function readMail(query: string, runner: MacRunner, opts: MacRunOptions): Promise<AttentionItem[]> {
  if (!runner.sqliteJson) throw new Error('mac.mail unavailable: sqlite runner unavailable');
  try {
    const dbPath = await discoverMailEnvelopeIndex();
    const raw = await runner.sqliteJson(dbPath, mailIndexQuery(query), opts);
    return parseMailIndexRows(raw);
  } catch (error) {
    if (error instanceof MacSurfaceError) throw error;
    if (error instanceof Error && error.message.startsWith('mac.mail unavailable:')) throw error;
    throw new Error(`mac.mail unavailable: ${errorMessage(error)}`);
  }
}

function parseItems(raw: string, fallbackSource: string): AttentionItem[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item, index) => ({
      kind: item.kind ?? 'artifact',
      id: String(item.id ?? `${fallbackSource}:${index}`),
      title: String(item.title ?? '(untitled)'),
      when: item.when ? String(item.when) : undefined,
      who: item.who ? String(item.who) : undefined,
      source: String(item.source ?? fallbackSource),
      needsOwner: Boolean(item.needsOwner),
      waitingOn: item.waitingOn ? String(item.waitingOn) : undefined,
      excerpt: item.excerpt ? String(item.excerpt) : undefined,
    }));
  } catch (error) {
    throw new Error(`mac parse failed (${fallbackSource}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function macRead(
  surface: MacReadSurface,
  query: string,
  runner: MacRunner,
  hoursAhead = 36,
  options: MacReadOptions = {},
): Promise<AttentionItem[]> {
  const { signal } = options;
  if (signal?.aborted) throw abortedError(signal, `mac.${surface} read`);
  try {
    return await untilAborted(readSurface(surface, query, runner, hoursAhead, { signal }), signal, `mac.${surface} read`);
  } catch (error) {
    // A runner that ignored the signal still reports the caller's typed reason.
    if (signal?.aborted && !(error instanceof MacSurfaceError)) throw abortedError(signal, `mac.${surface} read`);
    throw error;
  }
}

async function readSurface(
  surface: MacReadSurface,
  query: string,
  runner: MacRunner,
  hoursAhead: number,
  opts: MacRunOptions,
): Promise<AttentionItem[]> {
  if (surface === 'calendar') {
    return parseItems(await runner.jxa(CALENDAR_SCRIPT, [String(hoursAhead)], opts), 'mac.calendar');
  }
  if (surface === 'reminders') {
    return parseItems(await runner.jxa(REMINDERS_SCRIPT, ['false'], opts), 'mac.reminders');
  }
  if (surface === 'notes') {
    return parseItems(await runner.jxa(NOTES_SCRIPT, [query, String(NOTES_SCAN_CAP), String(NOTES_DEADLINE_MS)], opts), 'mac.notes');
  }
  if (surface === 'mail') {
    return readMail(query, runner, opts);
  }
  if (surface === 'finder') {
    const home = homedir();
    if (!query.trim()) throw new Error('finder search requires a query');
    if (!runner.spotlight) throw new Error('spotlight runner unavailable');
    const raw = await runner.spotlight(query, home, opts);
    return raw.split('\n').filter(Boolean).slice(0, 20).map((filePath, index) => ({
      kind: 'artifact' as const,
      id: `finder:${index}`,
      title: filePath.split('/').pop() || filePath,
      source: 'mac.finder',
      excerpt: filePath,
    }));
  }
  throw new Error(`unknown mac surface: ${surface}`);
}

export async function macWrite(
  action: MacWriteAction,
  input: { title?: string; notes?: string; shortcut?: string; dryRun?: boolean },
  runner: MacRunner,
): Promise<{ dryRun: boolean; result: unknown }> {
  if (action === 'create_reminder') {
    const title = String(input.title ?? '').trim();
    if (!title) throw new Error('title required');
    if (input.dryRun) return { dryRun: true, result: { wouldCreate: title, notes: input.notes ?? '' } };
    const raw = await runner.jxa(CREATE_REMINDER_SCRIPT, [title, String(input.notes ?? '')]);
    return { dryRun: false, result: JSON.parse(raw) };
  }
  if (action === 'run_shortcut') {
    const name = String(input.shortcut ?? '').trim();
    if (!name) throw new Error('shortcut name required');
    if (input.dryRun) return { dryRun: true, result: { wouldRun: name } };
    const raw = await runner.jxa(RUN_SHORTCUT_SCRIPT, [name]);
    return { dryRun: false, result: JSON.parse(raw) };
  }
  throw new Error(`unknown mac write action: ${action}`);
}
