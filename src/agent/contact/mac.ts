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

export interface MacRunner {
  jxa(script: string, args?: string[]): Promise<string>;
  spotlight?(query: string, onlyIn: string): Promise<string>;
  sqliteJson?(dbPath: string, sql: string): Promise<string>;
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

const NOTES_SCRIPT = `
function run(argv) {
  const query = String(argv[0] || '').toLowerCase();
  const Notes = Application('Notes');
  const notes = Notes.notes();
  const out = [];
  const limit = 20;
  for (let i = 0; i < notes.length && out.length < limit; i++) {
    const n = notes[i];
    const title = String(n.name());
    let body = '';
    try { body = String(n.plaintext()); } catch (e) { body = ''; }
    const hay = (title + ' ' + body).toLowerCase();
    if (query && hay.indexOf(query) === -1) continue;
    out.push({
      kind: 'artifact',
      id: String(n.id()),
      title,
      source: 'mac.notes',
      excerpt: body.slice(0, 280)
    });
  }
  return JSON.stringify(out);
}
`;

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

export function createOsascriptRunner(): MacRunner {
  return {
    async jxa(script: string, args: string[] = []): Promise<string> {
      const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', script, ...args], {
        timeout: 30_000,
        maxBuffer: 2_000_000,
        env: unprivilegedChildEnv(),
      });
      return stdout.trim();
    },
    async spotlight(query: string, onlyIn: string): Promise<string> {
      const { stdout } = await execFileAsync('mdfind', ['-onlyin', onlyIn, query], {
        timeout: 15_000,
        maxBuffer: 1_000_000,
        env: unprivilegedChildEnv(),
      });
      return stdout.trim();
    },
    async sqliteJson(dbPath: string, sql: string): Promise<string> {
      const absolutePath = resolve(dbPath);
      const uri = `file:${encodeURI(absolutePath).replace(/#/g, '%23')}?mode=ro`;
      const { stdout } = await execFileAsync('sqlite3', ['-json', uri, sql], {
        timeout: 15_000,
        maxBuffer: 2_000_000,
        env: unprivilegedChildEnv(),
      });
      return stdout.trim();
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

async function readMail(query: string, runner: MacRunner): Promise<AttentionItem[]> {
  if (!runner.sqliteJson) throw new Error('mac.mail unavailable: sqlite runner unavailable');
  try {
    const dbPath = await discoverMailEnvelopeIndex();
    const raw = await runner.sqliteJson(dbPath, mailIndexQuery(query));
    return parseMailIndexRows(raw);
  } catch (error) {
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
): Promise<AttentionItem[]> {
  if (surface === 'calendar') {
    return parseItems(await runner.jxa(CALENDAR_SCRIPT, [String(hoursAhead)]), 'mac.calendar');
  }
  if (surface === 'reminders') {
    return parseItems(await runner.jxa(REMINDERS_SCRIPT, ['false']), 'mac.reminders');
  }
  if (surface === 'notes') {
    return parseItems(await runner.jxa(NOTES_SCRIPT, [query]), 'mac.notes');
  }
  if (surface === 'mail') {
    return readMail(query, runner);
  }
  if (surface === 'finder') {
    const home = homedir();
    if (!query.trim()) throw new Error('finder search requires a query');
    if (!runner.spotlight) throw new Error('spotlight runner unavailable');
    const raw = await runner.spotlight(query, home);
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
