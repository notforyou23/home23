import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { unprivilegedChildEnv } from '../../security/child-process-env.js';
import type { AttentionItem } from './types.js';

const execFileAsync = promisify(execFile);

export type MacReadSurface = 'calendar' | 'reminders' | 'notes' | 'mail' | 'finder';
export type MacWriteAction = 'create_reminder' | 'run_shortcut';

export interface MacRunner {
  jxa(script: string, args?: string[]): Promise<string>;
  spotlight?(query: string, onlyIn: string): Promise<string>;
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
function iso(date) {
  if (!date) return null;
  const js = date.js ? date.js : date;
  try { return new Date(js).toISOString(); } catch (e) { return String(js); }
}
function run(argv) {
  const includeCompleted = String(argv[0] || 'false') === 'true';
  const store = $.EKEventStore.alloc.init;
  const lists = store.calendarsForEntityType(1);
  const pred = store.predicateForRemindersInCalendars(lists);
  const out = [];
  const sem = $.NSCondition.alloc.init;
  let done = false;
  store.fetchRemindersMatchingPredicateCompletion(pred, reminders => {
    const arr = reminders || $.NSArray.array;
    for (let i = 0; i < arr.count; i++) {
      const r = arr.objectAtIndex(i);
      const completed = Boolean(r.completed);
      if (completed && !includeCompleted) continue;
      out.push({
        kind: 'commitment',
        id: String(r.calendarItemIdentifier.js),
        title: String(r.title.js),
        when: iso(r.dueDate),
        source: 'mac.reminders',
        needsOwner: !completed,
        excerpt: r.notes ? String(r.notes.js).slice(0, 240) : undefined
      });
    }
    done = true;
    sem.signal();
  });
  if (!done) sem.waitUntilDate($.NSDate.dateWithTimeIntervalSinceNow(8));
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

const MAIL_SCRIPT = `
function run(argv) {
  const query = String(argv[0] || '').toLowerCase();
  const Mail = Application('Mail');
  const inbox = Mail.inbox.messages;
  const count = Math.min(Number(inbox.count()), 40);
  const out = [];
  for (let i = 0; i < count && out.length < 15; i++) {
    const m = inbox[i];
    const subject = String(m.subject());
    const sender = String(m.sender());
    const hay = (subject + ' ' + sender).toLowerCase();
    if (query && hay.indexOf(query) === -1) continue;
    out.push({
      kind: 'message',
      id: String(m.id()),
      title: subject,
      who: sender,
      when: String(m.dateReceived()),
      source: 'mac.mail',
      needsOwner: Boolean(m.readStatus && m.readStatus() === false)
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
        timeout: 20_000,
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
  };
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
    return parseItems(await runner.jxa(MAIL_SCRIPT, [query]), 'mac.mail');
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
