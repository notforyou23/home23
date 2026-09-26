import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
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
  /** AppleScript with arguments passed as argv, never interpolated into the script. */
  applescript?(script: string, args?: string[], opts?: MacRunOptions): Promise<string>;
}

export interface MacReadOptions {
  signal?: AbortSignal;
}

export interface MailReport {
  source: 'index' | 'applescript';
  degraded: Array<{ step: string; code: string }>;
  timings: Record<string, number>;
  skippedAccounts?: string[];
}

export interface MacReadReport {
  items: AttentionItem[];
  /** Mail only: which reader answered, what degraded and how long each step took. */
  mail?: MailReport;
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
    async applescript(script: string, args: string[] = [], opts?: MacRunOptions): Promise<string> {
      return runBounded('osascript', ['-e', script, ...args], { timeoutMs: 35_000, maxBuffer: 2_000_000 }, opts);
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

// Mail lives in the owner's macOS home. Under the Host, HOME is Home23's
// private runtime home (<home>/runtime/user), so it must not be used here.
// Resolved locally until the shared owner-home contract (HOME23_OWNER_HOME,
// shared/owner-home.cjs) lands; switch to that resolver then.
function ownerHomeDirectory(): string {
  const explicit = process.env.HOME23_OWNER_HOME?.trim();
  return explicit && isAbsolute(explicit) ? explicit : userInfo().homedir;
}

const MAIL_PERMISSION_HINT = 'Full Disk Access is required for the fast Mail index. Only the owner can grant it (System Settings > Privacy & Security > Full Disk Access > Home23 Host); Home23 never changes it.';

function mailError(code: string, detail: string): MacSurfaceError {
  return new MacSurfaceError(code, `mac.mail unavailable: ${code} - ${detail}`);
}

function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EPERM' || code === 'EACCES';
}

async function discoverMailEnvelopeIndex(): Promise<string> {
  const mailRoot = join(ownerHomeDirectory(), 'Library', 'Mail');
  let entries: string[];
  try {
    entries = await readdir(mailRoot);
  } catch (error) {
    if (isPermissionError(error)) throw mailError('mail_index_permission_denied', `cannot read ${mailRoot}. ${MAIL_PERMISSION_HINT}`);
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw mailError('mail_not_configured', `no Mail data under ${mailRoot}`);
    throw mailError('mail_index_unavailable', `Envelope Index discovery failed under ${mailRoot}: ${errorMessage(error)}`);
  }

  const versions = entries
    .map((name) => ({ name, version: /^V(\d+)$/.exec(name)?.[1] }))
    .filter((entry): entry is { name: string; version: string } => entry.version !== undefined)
    .sort((left, right) => Number(right.version) - Number(left.version));

  let denied = false;
  for (const version of versions) {
    const candidate = join(mailRoot, version.name, 'MailData', 'Envelope Index');
    try {
      const info = await stat(candidate);
      if (!info.isFile()) continue;
      await access(candidate, constants.R_OK);
      return candidate;
    } catch (error) {
      // Keep looking for the highest version with a readable index.
      denied ||= isPermissionError(error);
    }
  }

  if (denied) throw mailError('mail_index_permission_denied', `cannot read the Envelope Index under ${mailRoot}. ${MAIL_PERMISSION_HINT}`);
  throw mailError('mail_not_configured', `no readable Envelope Index found under ${mailRoot}/V*/MailData`);
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

// Bounded Apple Events fallback for when the index is not readable. It never
// launches Mail, reads one account's own INBOX at a time (never the combined
// inbox, never `every message` or `whose`), fetches each property for a
// range of messages in one event, and stops starting accounts at a deadline.
const MAIL_LIST_SCRIPT = `
on clean(v)
	if v is missing value then return ""
	return v as text
end clean

on run argv
	set wantAccount to item 1 of argv
	set wantMailbox to item 2 of argv
	set perAccount to (item 3 of argv) as integer
	set maxAccounts to (item 4 of argv) as integer
	set US to character id 31
	set RS to character id 30
	if application "Mail" is not running then return "E" & US & "mail_app_not_running"
	set deadline to (current date) + 12
	set out to {}
	tell application "Mail"
		try
			with timeout of 8 seconds
				set acctNames to name of every account
			end timeout
		on error errMsg number errNum
			return "E" & US & errNum
		end try
		set scanned to 0
		repeat with acctRef in acctNames
			set acctName to contents of acctRef
			if wantAccount is "" or acctName contains wantAccount then
				if scanned is greater than or equal to maxAccounts or (current date) > deadline then
					set end of out to "S" & US & acctName
				else
					set scanned to scanned + 1
					try
						with timeout of 8 seconds
							try
								set mb to mailbox wantMailbox of account acctName
							on error number -1728
								if wantMailbox is not "INBOX" then error number -1728
								set mb to mailbox "Inbox" of account acctName
							end try
							set msgTotal to count of messages of mb
						end timeout
						if msgTotal > 0 then
							set n to perAccount
							if n > msgTotal then set n to msgTotal
							with timeout of 8 seconds
								set firstDate to date received of message 1 of mb
								set lastDate to date received of message msgTotal of mb
							end timeout
							if lastDate > firstDate then
								set lo to msgTotal - n + 1
								set hi to msgTotal
							else
								set lo to 1
								set hi to n
							end if
							with timeout of 8 seconds
								set idList to id of messages lo thru hi of mb
								set subjectList to subject of messages lo thru hi of mb
								set senderList to sender of messages lo thru hi of mb
								set dateList to date received of messages lo thru hi of mb
								set readList to read status of messages lo thru hi of mb
							end timeout
							repeat with i from 1 to count of idList
								set d to item i of dateList
								set end of out to "M" & US & acctName & US & (item i of idList) & US & (year of d) & US & ((month of d) as integer) & US & (day of d) & US & (time of d) & US & (item i of readList) & US & my clean(item i of senderList) & US & my clean(item i of subjectList)
							end repeat
						end if
					on error errMsg number errNum
						set end of out to "D" & US & acctName & US & errNum
					end try
				end if
			end if
		end repeat
	end tell
	set AppleScript's text item delimiters to RS
	set joined to out as text
	set AppleScript's text item delimiters to ""
	return joined
end run
`;

export const MAIL_FALLBACK_MAX_ACCOUNTS = 6;
const MAIL_DEFAULT_LIMIT = 15;
const MAIL_QUERY_LIMIT = 25;

const APPLESCRIPT_ERROR_CODES: Record<string, string> = {
  '-600': 'mail_app_not_running',
  '-1712': 'timeout',
  '-1728': 'mailbox_not_found',
  '-1743': 'mail_automation_denied',
};

function appleScriptCode(value: string | undefined): string {
  const raw = String(value ?? '').trim();
  return APPLESCRIPT_ERROR_CODES[raw] ?? (/^-?\d+$/.test(raw) ? `applescript_error_${raw}` : raw || 'applescript_error');
}

function appleScriptFailure(error: unknown): MacSurfaceError {
  if (error instanceof MacSurfaceError) return error;
  const code = /\((-\d+)\)/.exec(errorMessage(error))?.[1];
  return mailError(code ? appleScriptCode(code) : 'applescript_error', errorMessage(error));
}

function throwMailScriptError(code: string): never {
  if (code === 'mail_app_not_running') {
    throw mailError(code, 'Mail is not running, and Home23 does not launch it. Ask the owner to open Mail.');
  }
  if (code === 'mail_automation_denied') {
    throw mailError(code, 'macOS denied Home23 Automation access to Mail. Only the owner can allow it (System Settings > Privacy & Security > Automation).');
  }
  throw mailError(code, 'Mail did not answer the bounded Apple Events read.');
}

function localDate(year: string, month: string, day: string, seconds: string): string | undefined {
  // AppleScript dates carry no zone; rebuild them in this process's local time.
  const date = new Date(Number(year), Number(month) - 1, Number(day), 0, 0, Number(seconds));
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function parseMailScriptOutput(raw: string): { items: AttentionItem[]; degraded: MailReport['degraded']; skipped: string[] } {
  const items: AttentionItem[] = [];
  const degraded: MailReport['degraded'] = [];
  const skipped: string[] = [];
  for (const record of raw.split('\u001e').filter(Boolean)) {
    const [kind, ...fields] = record.split('\u001f');
    if (kind === 'E') throwMailScriptError(appleScriptCode(fields[0]));
    if (kind === 'S') skipped.push(String(fields[0]));
    if (kind === 'D') degraded.push({ step: `account:${fields[0]}`, code: appleScriptCode(fields[1]) });
    if (kind !== 'M') continue;
    const [account, id, year, month, day, seconds, read, sender, ...subject] = fields;
    items.push({
      kind: 'message',
      id: `mac.mail:${id}`,
      title: subject.join('\u001f') || '(no subject)',
      who: sender || 'unknown',
      when: localDate(String(year), String(month), String(day), String(seconds)),
      needsOwner: read === 'false',
      source: 'mac.mail',
      excerpt: `Account: ${String(account).slice(0, 120)}`,
    });
  }
  return { items, degraded, skipped };
}

async function readMailViaAppleScript(
  query: string,
  runner: MacRunner,
  opts: MacRunOptions,
): Promise<{ items: AttentionItem[]; degraded: MailReport['degraded']; skipped: string[] }> {
  if (!runner.applescript) throw mailError('mail_index_permission_denied', MAIL_PERMISSION_HINT);
  const normalized = query.trim().toLowerCase();
  const limit = normalized ? MAIL_QUERY_LIMIT : MAIL_DEFAULT_LIMIT;
  let parsed: ReturnType<typeof parseMailScriptOutput>;
  try {
    parsed = parseMailScriptOutput(await runner.applescript(MAIL_LIST_SCRIPT, ['', 'INBOX', String(limit), String(MAIL_FALLBACK_MAX_ACCOUNTS)], opts));
  } catch (error) {
    const failure = appleScriptFailure(error);
    if (failure.code === 'timeout' || failure.code === 'aborted') throw failure;
    // The owner needs both halves: why the fallback failed and why it ran.
    throw new MacSurfaceError(failure.code, `${failure.message} ${MAIL_PERMISSION_HINT}`);
  }
  // Without the index there is no cheap search; match only the recent window.
  const matched = normalized
    ? parsed.items.filter((item) => `${item.title} ${item.who ?? ''}`.toLowerCase().includes(normalized))
    : parsed.items;
  if (normalized) parsed.degraded.push({ step: 'query', code: 'query_limited_to_recent' });
  const items = matched
    .sort((left, right) => Date.parse(right.when ?? '') - Date.parse(left.when ?? ''))
    .slice(0, limit);
  return { items, degraded: parsed.degraded, skipped: parsed.skipped };
}

function indexFailure(error: unknown): MacSurfaceError {
  if (error instanceof MacSurfaceError) return error;
  const message = errorMessage(error);
  if (/unable to open database|authori[sz]ation denied|not authori[sz]ed|operation not permitted/i.test(message)) {
    return mailError('mail_index_permission_denied', `${message.slice(0, 300)}. ${MAIL_PERMISSION_HINT}`);
  }
  return mailError('mail_index_unavailable', message);
}

async function readMail(query: string, runner: MacRunner, opts: MacRunOptions): Promise<{ items: AttentionItem[]; mail: MailReport }> {
  const timings: Record<string, number> = {};
  let started = Date.now();
  try {
    if (!runner.sqliteJson) throw mailError('mail_index_unavailable', 'sqlite runner unavailable');
    const dbPath = await discoverMailEnvelopeIndex();
    timings.discoverMs = Date.now() - started;
    started = Date.now();
    const items = parseMailIndexRows(await runner.sqliteJson(dbPath, mailIndexQuery(query), opts));
    timings.queryMs = Date.now() - started;
    return { items, mail: { source: 'index', degraded: [], timings } };
  } catch (error) {
    const failure = indexFailure(error);
    if (failure.code !== 'mail_index_permission_denied' || !runner.applescript) throw failure;
    timings.discoverMs ??= Date.now() - started;
    started = Date.now();
    const fallback = await readMailViaAppleScript(query, runner, opts);
    timings.applescriptMs = Date.now() - started;
    return {
      items: fallback.items,
      mail: {
        source: 'applescript',
        degraded: [{ step: 'index', code: failure.code }, ...fallback.degraded],
        timings,
        ...(fallback.skipped.length ? { skippedAccounts: fallback.skipped } : {}),
      },
    };
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
  return (await macReadReport(surface, query, runner, hoursAhead, options)).items;
}

export async function macReadReport(
  surface: MacReadSurface,
  query: string,
  runner: MacRunner,
  hoursAhead = 36,
  options: MacReadOptions = {},
): Promise<MacReadReport> {
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
): Promise<MacReadReport> {
  if (surface === 'calendar') {
    return { items: parseItems(await runner.jxa(CALENDAR_SCRIPT, [String(hoursAhead)], opts), 'mac.calendar') };
  }
  if (surface === 'reminders') {
    return { items: parseItems(await runner.jxa(REMINDERS_SCRIPT, ['false'], opts), 'mac.reminders') };
  }
  if (surface === 'notes') {
    return { items: parseItems(await runner.jxa(NOTES_SCRIPT, [query, String(NOTES_SCAN_CAP), String(NOTES_DEADLINE_MS)], opts), 'mac.notes') };
  }
  if (surface === 'mail') {
    return readMail(query, runner, opts);
  }
  if (surface === 'finder') {
    const home = homedir();
    if (!query.trim()) throw new Error('finder search requires a query');
    if (!runner.spotlight) throw new Error('spotlight runner unavailable');
    const raw = await runner.spotlight(query, home, opts);
    return { items: raw.split('\n').filter(Boolean).slice(0, 20).map((filePath, index) => ({
      kind: 'artifact' as const,
      id: `finder:${index}`,
      title: filePath.split('/').pop() || filePath,
      source: 'mac.finder',
      excerpt: filePath,
    })) };
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
