'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const lockfile = require('proper-lockfile');

/** Append a source witness once. Retry scans are bounded-memory and exact.
 * Fresh UUID writers may use newUnique only before their first attempt;
 * durable-intent writers must mark that attempt before calling, so a crash
 * retry uses the normal identity scan. This is not a second source store. */
function appendSeedProjectionOnce(eventsPath, event, options = {}) {
  if (!event || typeof event !== 'object' || typeof event.event_id !== 'string'
      || !event.event_id.trim() || event.event_id.length > 512
      || typeof event.event_type !== 'string' || !event.event_type.trim()
      || typeof event.ts !== 'string' || !Number.isFinite(Date.parse(event.ts))
      || !event.payload || typeof event.payload !== 'object'
      || Buffer.byteLength(JSON.stringify(event), 'utf8') > 1024 * 1024) {
    throw new Error('Invalid pending Seed source projection; retained without appending');
  }
  const release = lockfile.lockSync(eventsPath, { realpath: false, stale: 30_000, update: 5_000 });
  try { appendUnlocked(eventsPath, event, options.newUnique === true); }
  finally { release(); }
}

function appendUnlocked(eventsPath, event, newUnique) {
  let found = false;
  if (fs.existsSync(eventsPath)) {
    const fd = fs.openSync(eventsPath, 'r');
    try {
      if (newUnique) {
        // Normal first attempts do constant work, independent of source age.
        // Even a fresh UUID may not append through an interrupted prior line.
        const size = fs.fstatSync(fd).size;
        if (size) {
          const tail = Buffer.alloc(1);
          if (fs.readSync(fd, tail, 0, 1, size - 1) !== 1 || tail[0] !== 10) {
            throw new Error('Seed source projection has an incomplete tail; retained for recovery');
          }
        }
      } else {
        const buffer = Buffer.alloc(64 * 1024);
        const decoder = new StringDecoder('utf8');
        let rest = '';
        for (;;) {
          const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
          if (!bytes) break;
          rest += decoder.write(buffer.subarray(0, bytes));
          let newline;
          while ((newline = rest.indexOf('\n')) >= 0) {
            const line = rest.slice(0, newline); rest = rest.slice(newline + 1);
            if (!line.trim()) continue;
            let parsed;
            try { parsed = JSON.parse(line); }
            catch { throw new Error('Seed source projection contains an invalid historical line'); }
            if (parsed.event_id === event.event_id) {
              if (line !== JSON.stringify(event)) throw new Error('Seed source projection identity conflicts with recorded content');
              found = true;
            }
          }
          if (rest.length > 1024 * 1024) throw new Error('Seed source projection line exceeds 1 MiB');
        }
        rest += decoder.end();
        if (rest) throw new Error('Seed source projection has an incomplete tail; retained for recovery');
      }
    } finally { fs.closeSync(fd); }
  }
  // A crash may have left the complete line before its fsync. An identity
  // match still needs a durability barrier before acknowledging the retry.
  const fd = fs.openSync(eventsPath, found ? 'r' : 'a');
  try { if (!found) fs.appendFileSync(fd, `${JSON.stringify(event)}\n`); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  const directory = fs.openSync(path.dirname(eventsPath), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

module.exports = { appendSeedProjectionOnce };
