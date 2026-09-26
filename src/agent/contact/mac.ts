import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { unprivilegedChildEnv } from '../../security/child-process-env.js';
import type { AttentionItem } from './types.js';

const execFileAsync = promisify(execFile);

export type MacReadSurface = 'calendar' | 'reminders' | 'notes' | 'mail' | 'mail_accounts' | 'mail_message' | 'finder';
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

export interface MailReadOptions {
  /** Index reads: part of the account in the mailbox URL (its UUID). Fallback: the account name or id. */
  account?: string;
  /** Mailbox path; default INBOX, including its sub-mailboxes. */
  mailbox?: string;
  limit?: number;
  /** Paging: an ISO time, or a previous `nextBefore` cursor; only older messages. */
  before?: string;
  sinceHours?: number;
  unreadOnly?: boolean;
  /** mail_message: the item id (mac.mail:<n>). */
  id?: string;
  maxChars?: number;
}

export interface MacReadOptions {
  signal?: AbortSignal;
  mail?: MailReadOptions;
}

export interface MailReport {
  source: 'index' | 'applescript';
  degraded: Array<{ step: string; code: string }>;
  timings: Record<string, number>;
  skippedAccounts?: string[];
  /** Index reads: `<ISO time>#<rowid>` of the last item; pass as `before` for the next page. */
  nextBefore?: string;
}

export interface MailAccount {
  account: string;
  name?: string;
  inboxMessages?: number;
  unread?: number;
}

/** One message body. It is returned to the turn only; callers must never persist `body`. */
export interface MailMessage {
  id: string;
  subject: string;
  sender: string;
  when?: string;
  chars: number;
  truncated: boolean;
  body: string;
}

export interface MacReadReport {
  items: AttentionItem[];
  /** Mail only: which reader answered, what degraded and how long each step took. */
  mail?: MailReport;
  accounts?: MailAccount[];
  message?: MailMessage;
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

// osascript keeps parsing options after -e, so a resident-supplied argument
// such as "-e<statement>" would be compiled into the script. "--" ends option
// parsing: every argument after it reaches the script as argv data.
function osascriptArgs(language: string[], script: string, args: string[]): string[] {
  return [...language, '-e', script, '--', ...args];
}

export function createOsascriptRunner(): MacRunner {
  return {
    async jxa(script: string, args: string[] = [], opts?: MacRunOptions): Promise<string> {
      return runBounded('osascript', osascriptArgs(['-l', 'JavaScript'], script, args), { timeoutMs: 30_000, maxBuffer: 2_000_000 }, opts);
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
      return runBounded('osascript', osascriptArgs([], script, args), { timeoutMs: 35_000, maxBuffer: 2_000_000 }, opts);
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

const MAIL_DEFAULT_LIMIT = 15;
const MAIL_QUERY_LIMIT = 25;
const MAIL_MAX_LIMIT = 50;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The account is the mailbox URL's authority: the account UUID in V10
// (imap://<UUID>/INBOX), user@host in older layouts.
const MAILBOX_ACCOUNT_SQL = "substr(mb.url, instr(mb.url, '://') + 3, instr(substr(mb.url, instr(mb.url, '://') + 3) || '/', '/') - 1)";

function mailboxFilterSql(mailbox: string): string {
  // Mailbox URLs percent-encode each path segment ("[Gmail]/All Mail").
  const path = escapeSqlLike(mailbox.split('/').filter(Boolean).map((segment) => encodeURIComponent(segment)).join('/'));
  return `(mb.url like '%/${path}' escape '!' or mb.url like '%/${path}/%' escape '!')`;
}

function clampCount(value: number | undefined, fallback: number, max: number): number {
  const requested = Number(value);
  if (!Number.isFinite(requested) || requested < 1) return fallback;
  return Math.min(Math.floor(requested), max);
}

function mailLimit(query: string, mail: MailReadOptions): number {
  return clampCount(mail.limit, query.trim() ? MAIL_QUERY_LIMIT : MAIL_DEFAULT_LIMIT, MAIL_MAX_LIMIT);
}

// date_received has one-second resolution, so a time-only cursor would skip
// the messages that share the last item's second but missed the page. The
// nextBefore cursor carries that item's rowid to break the tie.
interface MailCursor {
  seconds: number;
  rowid?: number;
}

function mailCursor(before: string | undefined): MailCursor | undefined {
  const raw = before?.trim();
  if (!raw) return undefined;
  const match = /^(.*?)(?:#(\d{1,15}))?$/.exec(raw);
  const ms = Date.parse(match?.[1] ?? '');
  if (!Number.isFinite(ms)) throw new MacSurfaceError('invalid_before', `invalid_before: ${raw.slice(0, 80)} is not an ISO time or a nextBefore cursor`);
  return { seconds: Math.floor(ms / 1000), ...(match?.[2] ? { rowid: Number(match[2]) } : {}) };
}

function mailRowid(item: AttentionItem): number {
  return Number(/(\d+)$/.exec(item.id)?.[1] ?? 0);
}

function mailIndexQuery(query: string, mail: MailReadOptions = {}): string {
  const normalized = query.trim();
  const filters = [mailboxFilterSql(mail.mailbox?.trim() || 'INBOX')];
  if (normalized) {
    filters.push(`(lower(coalesce(s.subject,'')) like lower('%${escapeSqlLike(normalized)}%') escape '!'\n  or lower(coalesce(a.address,'')) like lower('%${escapeSqlLike(normalized)}%') escape '!'\n  or lower(coalesce(a.comment,'')) like lower('%${escapeSqlLike(normalized)}%') escape '!')`);
  }
  const account = mail.account?.trim();
  if (account) filters.push(`lower(${MAILBOX_ACCOUNT_SQL}) like lower('%${escapeSqlLike(account)}%') escape '!'`);
  const cursor = mailCursor(mail.before);
  if (cursor?.rowid !== undefined) filters.push(`(m.date_received < ${cursor.seconds} or (m.date_received = ${cursor.seconds} and m.ROWID < ${cursor.rowid}))`);
  else if (cursor) filters.push(`m.date_received < ${cursor.seconds}`);
  if (Number(mail.sinceHours) > 0) filters.push(`m.date_received >= ${Math.floor(Date.now() / 1000 - Number(mail.sinceHours) * 3600)}`);
  if (mail.unreadOnly) filters.push('m.read = 0');
  return `select m.ROWID as rowid, s.subject as subject, a.address as addr, a.comment as name, m.date_received as ts, m.read as read, mb.url as mailbox
from messages m
 join mailboxes mb on mb.ROWID = m.mailbox
 left join subjects s on s.ROWID = m.subject
 left join addresses a on a.ROWID = m.sender
where m.deleted = 0
 and ${filters.join('\n and ')}
order by m.date_received desc, m.ROWID desc limit ${mailLimit(normalized, mail)};`;
}

const MAIL_ACCOUNTS_SQL = `select ${MAILBOX_ACCOUNT_SQL} as account, count(m.ROWID) as messages, coalesce(sum(case when m.read = 0 then 1 else 0 end), 0) as unread
from mailboxes mb
 left join messages m on m.mailbox = mb.ROWID and m.deleted = 0
where ${mailboxFilterSql('INBOX')}
group by account
order by messages desc limit 50;`;

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// The account is '' for a local:/// ("On My Mac") mailbox.
function mailboxLocation(url: string): { account: string; mailbox: string } | undefined {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/]*)\/(.+)$/i.exec(url);
  if (!match) return undefined;
  return {
    account: decodeSegment(String(match[1])),
    mailbox: String(match[2]).split('/').filter(Boolean).map(decodeSegment).join('/'),
  };
}

function mailboxExcerpt(mailbox: string | null): string | undefined {
  const segment = mailbox?.split('/').filter(Boolean).at(-1);
  if (!segment) return undefined;
  const account = mailbox ? mailboxLocation(mailbox)?.account : undefined;
  return `Mailbox: ${decodeSegment(segment).slice(0, 120)}${account ? ` | Account: ${account.slice(0, 120)}` : ''}`;
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
				set acctIds to id of every account
			end timeout
		on error errMsg number errNum
			return "E" & US & errNum
		end try
		set scanned to 0
		repeat with k from 1 to count of acctNames
			set acctName to item k of acctNames
			if wantAccount is "" or acctName contains wantAccount or (item k of acctIds) is wantAccount then
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

const MAIL_ACCOUNTS_SCRIPT = `
on run argv
	set US to character id 31
	set RS to character id 30
	if application "Mail" is not running then return "E" & US & "mail_app_not_running"
	tell application "Mail"
		try
			with timeout of 5 seconds
				set idList to id of every account
				set nameList to name of every account
			end timeout
		on error errMsg number errNum
			return "E" & US & errNum
		end try
	end tell
	set out to {}
	repeat with i from 1 to count of idList
		set end of out to "A" & US & (item i of idList) & US & (item i of nameList)
	end repeat
	set AppleScript's text item delimiters to RS
	set joined to out as text
	set AppleScript's text item delimiters to ""
	return joined
end run
`;

// One message by id inside one account's mailbox: no enumeration. Mail's
// dictionary also has a "message id" property (the RFC header), so the
// by-id specifier is written with the raw class code. The body is truncated
// in the script, so an oversized message never crosses the pipe. With no
// account id or name the mailbox is an "On My Mac" one (local:/// in the
// index), which Mail keeps at the application level. INBOX retries as
// "Inbox" (Exchange's name), as the list fallback does.
const MAIL_MESSAGE_SCRIPT = `
on clean(v)
	if v is missing value then return ""
	return v as text
end clean

on run argv
	set msgId to (item 1 of argv) as integer
	set mbPath to item 2 of argv
	set acctId to item 3 of argv
	set acctName to item 4 of argv
	set maxChars to (item 5 of argv) as integer
	set US to character id 31
	set RS to character id 30
	if application "Mail" is not running then return "E" & US & "mail_app_not_running"
	tell application "Mail"
		try
			with timeout of 10 seconds
				if acctId is "" and acctName is "" then
					set mb to mailbox mbPath
				else
					if acctId is not "" then
						set acct to account id acctId
					else
						set acct to account acctName
					end if
					try
						set mb to mailbox mbPath of acct
					on error number -1728
						if mbPath is not "INBOX" then error number -1728
						set mb to mailbox "Inbox" of acct
					end try
				end if
				set msg to «class mssg» id msgId of mb
				set bodyText to my clean(content of msg)
				set subj to my clean(subject of msg)
				set sndr to my clean(sender of msg)
				set d to date received of msg
				set stamp to "" & (year of d) & US & ((month of d) as integer) & US & (day of d) & US & (time of d)
			end timeout
		on error errMsg number errNum
			return "E" & US & errNum
		end try
	end tell
	set fullLength to length of bodyText
	if fullLength > maxChars then set bodyText to text 1 thru maxChars of bodyText
	return "B" & US & fullLength & US & stamp & US & sndr & US & subj & RS & bodyText
end run
`;

export const MAIL_BODY_DEFAULT_CHARS = 4_000;
const MAIL_BODY_MAX_CHARS = 20_000;

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
  const number = /\((-\d+)\)/.exec(errorMessage(error))?.[1];
  const known = number ? APPLESCRIPT_ERROR_CODES[number] : undefined;
  if (known) return mailScriptError(known);
  return mailError(number ? appleScriptCode(number) : 'applescript_error', errorMessage(error).slice(0, 300));
}

function mailScriptError(code: string): MacSurfaceError {
  if (code === 'mail_message_not_found') {
    return mailError(code, 'Mail has no such message in that mailbox; it may have moved or been deleted.');
  }
  if (code === 'mail_body_timeout') {
    return mailError(code, 'Mail did not return the message body in time (a remote IMAP fetch can be slow).');
  }
  if (code === 'mail_app_not_running') {
    return mailError(code, 'Mail is not running, and Home23 does not launch it. Ask the owner to open Mail.');
  }
  if (code === 'mail_automation_denied') {
    return mailError(code, 'macOS denied Home23 Automation access to Mail. Only the owner can allow it (System Settings > Privacy & Security > Automation).');
  }
  return mailError(code, 'Mail did not answer the bounded Apple Events read.');
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
    if (kind === 'E') throw mailScriptError(appleScriptCode(fields[0]));
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
  mail: MailReadOptions,
): Promise<{ items: AttentionItem[]; degraded: MailReport['degraded']; skipped: string[] }> {
  if (!runner.applescript) throw mailError('mail_index_permission_denied', MAIL_PERMISSION_HINT);
  const normalized = query.trim().toLowerCase();
  const limit = mailLimit(normalized, mail);
  const args = [mail.account?.trim() ?? '', mail.mailbox?.trim() || 'INBOX', String(limit), String(MAIL_FALLBACK_MAX_ACCOUNTS)];
  let parsed: ReturnType<typeof parseMailScriptOutput>;
  try {
    parsed = parseMailScriptOutput(await runner.applescript(MAIL_LIST_SCRIPT, args, opts));
  } catch (error) {
    const failure = appleScriptFailure(error);
    if (failure.code === 'timeout' || failure.code === 'aborted') throw failure;
    // The owner needs both halves: why the fallback failed and why it ran.
    throw new MacSurfaceError(failure.code, `${failure.message} ${MAIL_PERMISSION_HINT}`);
  }
  // Without the index there is no cheap search or paging; filter the recent window.
  const cursor = mailCursor(mail.before);
  const since = Number(mail.sinceHours) > 0 ? Date.now() - Number(mail.sinceHours) * 3_600_000 : undefined;
  const matched = parsed.items.filter((item) => {
    const when = Date.parse(item.when ?? '');
    if (normalized && !`${item.title} ${item.who ?? ''}`.toLowerCase().includes(normalized)) return false;
    if (mail.unreadOnly && !item.needsOwner) return false;
    if (cursor && !(when < cursor.seconds * 1000
      || (cursor.rowid !== undefined && when === cursor.seconds * 1000 && mailRowid(item) < cursor.rowid))) return false;
    return since === undefined || when >= since;
  });
  if (normalized) parsed.degraded.push({ step: 'query', code: 'query_limited_to_recent' });
  if (cursor) parsed.degraded.push({ step: 'before', code: 'paging_limited_to_recent' });
  const items = matched
    .sort((left, right) => Date.parse(right.when ?? '') - Date.parse(left.when ?? '') || mailRowid(right) - mailRowid(left))
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

async function readMail(query: string, runner: MacRunner, opts: MacRunOptions, mail: MailReadOptions): Promise<MacReadReport> {
  const timings: Record<string, number> = {};
  const sql = mailIndexQuery(query, mail);
  let started = Date.now();
  try {
    if (!runner.sqliteJson) throw mailError('mail_index_unavailable', 'sqlite runner unavailable');
    const dbPath = await discoverMailEnvelopeIndex();
    timings.discoverMs = Date.now() - started;
    started = Date.now();
    const items = parseMailIndexRows(await runner.sqliteJson(dbPath, sql, opts));
    timings.queryMs = Date.now() - started;
    const last = items.length === mailLimit(query, mail) ? items.at(-1) : undefined;
    const nextBefore = last?.when ? `${last.when}#${mailRowid(last)}` : undefined;
    return { items, mail: { source: 'index', degraded: [], timings, ...(nextBefore ? { nextBefore } : {}) } };
  } catch (error) {
    const failure = indexFailure(error);
    if (failure.code !== 'mail_index_permission_denied' || !runner.applescript) throw failure;
    timings.discoverMs ??= Date.now() - started;
    started = Date.now();
    const fallback = await readMailViaAppleScript(query, runner, opts, mail);
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

async function mailAccountNames(runner: MacRunner, opts: MacRunOptions): Promise<{ names: Map<string, string>; code?: string }> {
  const names = new Map<string, string>();
  if (!runner.applescript) return { names, code: 'applescript_unavailable' };
  try {
    const raw = await runner.applescript(MAIL_ACCOUNTS_SCRIPT, [], { signal: opts.signal, timeoutMs: 8_000 });
    for (const record of raw.split('\u001e').filter(Boolean)) {
      const [kind, id, ...name] = record.split('\u001f');
      if (kind === 'E') return { names, code: appleScriptCode(id) };
      if (kind === 'A' && id) names.set(id, name.join('\u001f'));
    }
    return { names };
  } catch (error) {
    const failure = appleScriptFailure(error);
    if (failure.code === 'aborted') throw failure;
    return { names, code: failure.code };
  }
}

async function readMailAccounts(runner: MacRunner, opts: MacRunOptions): Promise<MacReadReport> {
  const timings: Record<string, number> = {};
  let started = Date.now();
  try {
    if (!runner.sqliteJson) throw mailError('mail_index_unavailable', 'sqlite runner unavailable');
    const dbPath = await discoverMailEnvelopeIndex();
    timings.discoverMs = Date.now() - started;
    started = Date.now();
    const rows = JSON.parse(await runner.sqliteJson(dbPath, MAIL_ACCOUNTS_SQL, opts) || '[]') as Array<{ account: string; messages: number; unread: number }>;
    timings.queryMs = Date.now() - started;
    // Names are a best-effort decoration from Mail itself; counts come from the index.
    started = Date.now();
    const { names, code } = await mailAccountNames(runner, opts);
    timings.namesMs = Date.now() - started;
    const accounts = rows.map((row) => {
      const name = names.get(String(row.account));
      return { account: String(row.account), ...(name ? { name } : {}), inboxMessages: Number(row.messages), unread: Number(row.unread) };
    });
    return { items: [], accounts, mail: { source: 'index', degraded: code ? [{ step: 'names', code }] : [], timings } };
  } catch (error) {
    const failure = indexFailure(error);
    if (failure.code !== 'mail_index_permission_denied' || !runner.applescript) throw failure;
    timings.discoverMs ??= Date.now() - started;
    started = Date.now();
    const { names, code } = await mailAccountNames(runner, opts);
    timings.applescriptMs = Date.now() - started;
    if (code) throw new MacSurfaceError(code, `${mailScriptError(code).message} ${MAIL_PERMISSION_HINT}`);
    const accounts = [...names].map(([account, name]) => ({ account, name }));
    return { items: [], accounts, mail: { source: 'applescript', degraded: [{ step: 'index', code: failure.code }], timings } };
  }
}

const MAIL_MESSAGE_ERROR_CODES: Record<string, string> = {
  '-1712': 'mail_body_timeout',
  '-1719': 'mail_message_not_found',
  '-1728': 'mail_message_not_found',
};

function parseMailMessage(raw: string, rowid: string, maxChars: number): MailMessage {
  const split = raw.indexOf('\u001e');
  const header = (split === -1 ? raw : raw.slice(0, split)).split('\u001f');
  if (header[0] === 'E') throw mailScriptError(MAIL_MESSAGE_ERROR_CODES[String(header[1])] ?? appleScriptCode(header[1]));
  if (header[0] !== 'B') throw mailError('mail_body_unavailable', 'Mail returned an unexpected answer');
  const [, chars, year, month, day, seconds, sender, ...subject] = header;
  const body = split === -1 ? '' : raw.slice(split + 1);
  const total = Number(chars);
  return {
    id: `mac.mail:${rowid}`,
    subject: subject.join('\u001f'),
    sender: String(sender ?? ''),
    when: localDate(String(year), String(month), String(day), String(seconds)),
    chars: Number.isFinite(total) ? total : body.length,
    truncated: Number.isFinite(total) ? total > maxChars : false,
    body,
  };
}

async function readMailMessage(runner: MacRunner, opts: MacRunOptions, mail: MailReadOptions): Promise<MacReadReport> {
  const rowid = /^(?:mac\.mail:)?(\d+)$/.exec(String(mail.id ?? '').trim())?.[1];
  if (!rowid) throw new MacSurfaceError('invalid_message_id', 'invalid_message_id: pass the id of a mail item (mac.mail:<n>)');
  const maxChars = clampCount(mail.maxChars, MAIL_BODY_DEFAULT_CHARS, MAIL_BODY_MAX_CHARS);
  const timings: Record<string, number> = {};
  const degraded: MailReport['degraded'] = [];
  let source: MailReport['source'] = 'index';
  let location: { accountId: string; accountName: string; mailbox: string; local?: boolean };
  const named = (account: string, mailbox: string) => (UUID_PATTERN.test(account)
    ? { accountId: account, accountName: '', mailbox }
    : { accountId: '', accountName: account, mailbox });
  let started = Date.now();
  try {
    if (!runner.sqliteJson) throw mailError('mail_index_unavailable', 'sqlite runner unavailable');
    const dbPath = await discoverMailEnvelopeIndex();
    const sql = `select mb.url as mailbox from messages m join mailboxes mb on mb.ROWID = m.mailbox where m.ROWID = ${rowid} and m.deleted = 0 limit 1;`;
    const rows = JSON.parse(await runner.sqliteJson(dbPath, sql, opts) || '[]') as Array<{ mailbox?: string }>;
    timings.lookupMs = Date.now() - started;
    const found = rows[0]?.mailbox ? mailboxLocation(String(rows[0].mailbox)) : undefined;
    if (!found) throw mailError('mail_message_not_found', `no message ${rowid} in the Mail index`);
    // A pre-V10 authority (user@host) is not an account id; the caller's account name must name it.
    if (!found.account) location = { accountId: '', accountName: '', mailbox: found.mailbox, local: true };
    else location = UUID_PATTERN.test(found.account) ? named(found.account, found.mailbox) : named(mail.account?.trim() ?? '', found.mailbox);
  } catch (error) {
    const failure = indexFailure(error);
    if (failure.code !== 'mail_index_permission_denied') throw failure;
    source = 'applescript';
    degraded.push({ step: 'index', code: failure.code });
    location = named(mail.account?.trim() ?? '', mail.mailbox?.trim() || 'INBOX');
  }
  if (!location.local && !location.accountId && !location.accountName) {
    throw mailError('mail_message_account_required', 'name the account (the Account value from the mail item, or from mail_accounts) so the message can be found without enumerating mailboxes.');
  }
  if (!runner.applescript) throw mailError('mail_body_unavailable', 'the Apple Events runner is unavailable');
  started = Date.now();
  let raw: string;
  try {
    raw = await runner.applescript(
      MAIL_MESSAGE_SCRIPT,
      [rowid, location.mailbox, location.accountId, location.accountName, String(maxChars)],
      { signal: opts.signal, timeoutMs: 15_000 },
    );
  } catch (error) {
    const failure = appleScriptFailure(error);
    if (failure.code === 'timeout') throw mailScriptError('mail_body_timeout');
    throw failure;
  }
  timings.bodyMs = Date.now() - started;
  return { items: [], message: parseMailMessage(raw, rowid, maxChars), mail: { source, degraded, timings } };
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
    return await untilAborted(readSurface(surface, query, runner, hoursAhead, { signal }, options.mail ?? {}), signal, `mac.${surface} read`);
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
  mail: MailReadOptions,
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
    return readMail(query, runner, opts, mail);
  }
  if (surface === 'mail_accounts') {
    return readMailAccounts(runner, opts);
  }
  if (surface === 'mail_message') {
    return readMailMessage(runner, opts, mail);
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
