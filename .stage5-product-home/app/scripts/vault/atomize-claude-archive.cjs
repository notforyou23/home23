'use strict';

const fs = require('node:fs');
const path = require('node:path');

function slugify(text) {
  return String(text || 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'untitled';
}

// The default name uses only the FIRST uuid segment (8 hex chars, 32 bits) to
// keep vault filenames short and human-scannable. That short suffix is not
// self-evidently unique: two conversations sharing a first segment, same day,
// same title collide -- as do two with no uuid and no created_at at all, which
// need no hash luck whatsoever and both land on `undated-untitled-noid.md`.
//
// A collision here is not a cosmetic naming problem: fs.writeFileSync would
// silently overwrite the earlier conversation and the run would still report
// success. This module exists precisely because jtr's Claude archive was
// silently lost once already, so the short suffix is never trusted blind --
// atomizeClaudeArchive resolves collisions up front (see planFilenames) and
// throws rather than guessing when even the full uuid cannot separate two
// items. Sibling module consolidate.cjs takes the same extend-then-throw
// stance on its digest suffixes; keep the two consistent.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// A filename is a PATH. Every component of the name below is derived from
// unvalidated archive JSON, so each one is a way for archive content to decide
// where this module writes.
//
// `created_at` was forwarded verbatim: '2024/08/27 10:00' silently created
// nested conversations/2024/08/27/ dirs; '../../../../etc/passwd' escaped
// outDir entirely; and ChatGPT's float `create_time` would yield
// '1712345678-...', which vault-paths.cjs routes to notes/ -- turning
// conversations/ into the 0-byte directory its tests exist to prevent.
//
// Refuse rather than guess. A wrong-but-plausible filename is unrecoverable
// and silent; a throw is a five-minute fix for whoever adds the next format.
// Same stance planFilenames takes on collisions.
function dateToken(convo) {
  const raw = convo.created_at;
  if (raw === undefined || raw === null || raw === '') return 'undated';
  const token = String(raw).slice(0, 10);
  if (token === 'undated' || ISO_DATE.test(token)) return token;
  throw new Error(
    `atomizeClaudeArchive: conversation ${convo.uuid || '(no uuid)'} has an unrecognised ` +
    `created_at: ${JSON.stringify(raw)}. Expected ISO-8601 (YYYY-MM-DD...). ` +
    `Convert it in the archive's own atomizer -- do not let it reach the filename.`
  );
}

// Defence in depth. dateToken validates the date and slugify strips separators
// out of `name`, but `shortId` comes straight from String(convo.uuid) and is
// unvalidated: a uuid of '../../../etc/passwd' produced
// '2026-01-01-hi-../../../etc/passwd.md' and escaped outDir. Rather than trust
// that every current and future component sanitises itself, assert the one
// property that actually matters about the finished name -- that it is a bare
// filename and cannot traverse anywhere.
function assertSafeBasename(name, convo) {
  const unsafe =
    name.includes('/') ||
    name.includes('\\') ||
    name === '.' ||
    name === '..' ||
    name.includes('\0');
  if (unsafe) {
    throw new Error(
      `atomizeClaudeArchive: conversation ${convo.uuid || '(no uuid)'} produced an unsafe ` +
      `filename ${JSON.stringify(name)}. A filename is a path: it must be a bare basename ` +
      `with no separators. Refusing to write outside the output directory.`
    );
  }
  return name;
}

function conversationFilename(convo, { fullUuid = false } = {}) {
  const date = dateToken(convo);
  const rawUuid = String(convo.uuid || '');
  const id = fullUuid ? rawUuid : rawUuid.split('-')[0];
  return assertSafeBasename(`${date}-${slugify(convo.name)}-${id || 'noid'}.md`, convo);
}

// Decides every filename BEFORE any write, so a collision is resolved by
// construction rather than discovered after a file is already clobbered.
//
// Two passes, because resolving on first-conflict would make a name depend on
// which conversation happened to be seen first: reorder the archive and the
// same conversation gets a different filename, breaking idempotency across
// exports. Instead, any short name claimed by more than one conversation
// promotes EVERY member of that group to its full uuid -- a function of the
// conversation alone, independent of array order.
function planFilenames(conversations) {
  const shortNameCounts = new Map();
  for (const convo of conversations) {
    const short = conversationFilename(convo);
    shortNameCounts.set(short, (shortNameCounts.get(short) || 0) + 1);
  }

  const plan = new Map();
  const claimed = new Map();
  for (const convo of conversations) {
    const short = conversationFilename(convo);
    const name = shortNameCounts.get(short) > 1
      ? conversationFilename(convo, { fullUuid: true })
      : short;

    // Even the full uuid failed to separate these two. Means a genuinely
    // duplicated uuid, or items carrying no uuid at all -- nothing left to
    // disambiguate with, and picking a winner would destroy a conversation.
    // Fail loudly, naming both, rather than silently keeping the last one.
    const key = name.toLowerCase();
    if (claimed.has(key)) {
      const other = claimed.get(key);
      throw new Error(
        `atomize: filename collision on ${name} -- conversations ` +
        `${JSON.stringify(other.uuid || '(no uuid)')} (${other.created_at || 'no created_at'}) and ` +
        `${JSON.stringify(convo.uuid || '(no uuid)')} (${convo.created_at || 'no created_at'}) ` +
        `both claim it and the full uuid does not separate them. Refusing to ` +
        `overwrite: one conversation would be silently lost.`
      );
    }
    claimed.set(key, convo);
    plan.set(convo, name);
  }
  return plan;
}

// Real Claude exports carry a top-level `text` convenience field on most
// messages, but it is EMPTY on ~5% of messages in the real archive -- those
// messages carry their content exclusively inside the `content` block array
// (tool_use, tool_result, thinking, text blocks). Falling back to
// `String(m.content)` on that array yields "[object Object]": a
// plausible-looking file with destroyed content, which is exactly the
// fabrication-by-omission bug this atomizer exists to prevent. Render every
// block type explicitly instead of dropping or stringifying it.
function renderContentBlock(block) {
  if (!block || typeof block !== 'object') return '';
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? block.text : '';
    case 'thinking':
      return typeof block.thinking === 'string' && block.thinking
        ? `_(thinking)_\n\n${block.thinking}`
        : '';
    case 'tool_use': {
      const name = block.name || 'unknown_tool';
      let input = '';
      try {
        input = JSON.stringify(block.input, null, 2);
      } catch {
        input = String(block.input);
      }
      return `_(tool_use: ${name})_\n\n\`\`\`json\n${input}\n\`\`\``;
    }
    case 'tool_result': {
      const name = block.name || 'unknown_tool';
      let inner = '';
      if (Array.isArray(block.content)) {
        inner = block.content.map(renderContentBlock).filter(Boolean).join('\n\n');
      } else if (typeof block.content === 'string') {
        inner = block.content;
      } else if (block.content != null) {
        try {
          inner = JSON.stringify(block.content, null, 2);
        } catch {
          inner = String(block.content);
        }
      }
      return `_(tool_result: ${name})_\n\n${inner}`;
    }
    case 'token_budget':
      // Pure metadata marker, no displayable content -- correctly empty, not lost.
      return '';
    default:
      // Unknown/future block type: surface it loudly rather than dropping it.
      return `_(unrendered block: ${block.type || 'unknown'})_`;
  }
}

function extractMessageText(msg) {
  if (typeof msg.text === 'string' && msg.text.length > 0) return msg.text;
  if (Array.isArray(msg.content)) {
    const rendered = msg.content.map(renderContentBlock).filter((s) => s && s.length > 0);
    if (rendered.length > 0) return rendered.join('\n\n');
  }
  return '';
}

// Real archive finding (not anticipated by the original spec): 509 of 4722
// messages (10.8%) carry a top-level `attachments` array -- pasted files
// (csv/txt/log/etc.) with a full `extracted_content` string. This is
// EXTRA content, not duplicated anywhere in `text`/`content`. Ignoring it
// silently drops ~10.9M characters of jtr's pasted material across the
// archive. `files` entries (553 messages) carry only a `file_name` with no
// inline content (uploaded PDFs/images processed out-of-band) -- per the
// project's catalog rule, the file's existence is still knowledge even
// when its content isn't inline, so it gets a reference line, not silence.
function renderAttachments(msg) {
  const parts = [];
  if (Array.isArray(msg.attachments)) {
    for (const a of msg.attachments) {
      if (!a) continue;
      const label = `_(attached: ${a.file_name || 'unnamed'}, ${a.file_size ?? '?'} bytes, ${a.file_type || 'unknown type'})_`;
      if (typeof a.extracted_content === 'string' && a.extracted_content.length > 0) {
        parts.push(`${label}\n\n\`\`\`\n${a.extracted_content}\n\`\`\``);
      } else {
        parts.push(`${label} -- no extracted content in archive`);
      }
    }
  }
  if (Array.isArray(msg.files)) {
    for (const f of msg.files) {
      if (!f) continue;
      parts.push(`_(file referenced, no inline content in archive: ${f.file_name || 'unnamed'})_`);
    }
  }
  return parts.join('\n\n');
}

// Frontmatter carries MEANING (tags) and PROVENANCE (uuid, date, source).
// Folders carry type only.
function conversationToMarkdown(convo) {
  const messages = Array.isArray(convo.chat_messages) ? convo.chat_messages : [];
  const front = [
    '---',
    `uuid: ${convo.uuid || ''}`,
    `title: ${JSON.stringify(String(convo.name || 'Untitled'))}`,
    `created_at: ${convo.created_at ? `'${convo.created_at}'` : 'null'}`,
    // NOT `updated_at || created_at`. Substituting creation time for a missing
    // update time launders a guess into a field labelled updated_at, where
    // nothing downstream could ever distinguish it from a real one -- the same
    // reason the filename says `undated` rather than borrowing updated_at.
    // `null` is the truthful claim: the archive did not say. No date_source
    // marker is needed precisely because nothing is substituted; a marker only
    // earns its place when a value's provenance is otherwise ambiguous.
    `updated_at: ${convo.updated_at ? `'${convo.updated_at}'` : 'null'}`,
    'source: claude-archive',
    'type: conversation',
    `message_count: ${messages.length}`,
    'tags: []',
    '---',
    '',
  ].join('\n');

  const body = [`# ${convo.name || 'Untitled'}`, ''];
  if (convo.summary) body.push(convo.summary, '');
  for (const m of messages) {
    const who = m.sender || m.role || 'unknown';
    const text = extractMessageText(m);
    body.push(`**${who}:**`, '', text, '');
    const attachments = renderAttachments(m);
    if (attachments) body.push(attachments, '');
  }
  return `${front}${body.join('\n')}`;
}

// Emits files ONLY. Never compiles, never calls an LLM.
//
// Error handling: a per-item exception is NOT caught and swallowed. It
// propagates and aborts the whole run. This is intentional -- a try/catch
// that logs-and-continues on a per-item error would let N conversations
// silently vanish from the vault while returning a "successful" result to
// the caller. Loud failure (crash the run, nothing written past the bad
// item) beats a plausible-looking partial result.
function atomizeClaudeArchive({ archivePath, outDir }) {
  const raw = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
  if (!Array.isArray(raw)) {
    throw new Error(`claude archive must be a JSON array, got ${typeof raw}`);
  }
  fs.mkdirSync(outDir, { recursive: true });

  const skipped = [];
  const emitting = [];
  for (const convo of raw) {
    const messages = Array.isArray(convo.chat_messages) ? convo.chat_messages : [];
    if (messages.length === 0) {
      skipped.push({
        uuid: convo.uuid || null,
        name: convo.name || null,
        created_at: convo.created_at || null,
        reason: 'no chat_messages',
      });
      continue;
    }
    emitting.push(convo);
  }

  // Names are resolved for the whole batch before the first byte is written,
  // so an unresolvable collision aborts having clobbered nothing.
  const plan = planFilenames(emitting);

  // `written` is derived from the names actually emitted, not counted
  // alongside the writes. A separate counter records intent and drifts from
  // disk the moment two items share a name -- which is exactly how this
  // module once reported written:3 with a single file on disk.
  const emitted = new Set();
  for (const convo of emitting) {
    const name = plan.get(convo);
    fs.writeFileSync(path.join(outDir, name), conversationToMarkdown(convo), 'utf8');
    emitted.add(name.toLowerCase());
  }

  const written = emitted.size;
  // planFilenames should make this unreachable; assert it rather than trust
  // it, since the failure it guards is silent by nature.
  if (written !== emitting.length) {
    throw new Error(
      `atomize: internal invariant violated -- planned ${emitting.length} ` +
      `conversations but emitted ${written} distinct filenames. Refusing to ` +
      `report success while conversations are missing from disk.`
    );
  }

  return { written, skippedEmpty: skipped.length, skipped, total: raw.length };
}

module.exports = {
  atomizeClaudeArchive,
  conversationToMarkdown,
  conversationFilename,
  planFilenames,
  extractMessageText,
  renderAttachments,
};
