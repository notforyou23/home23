'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FORMAT_VERSION = 1;
const READ_CHUNK_BYTES = 1024 * 1024;
const MAX_RECORD_BYTES = 64 * 1024 * 1024;
const TRANSACTION_INTEGRITY_V1 = 'begin_and_items_sha256_v1';
const TRANSACTION_INTEGRITY_V2 = 'transaction_sha256_v2';
const RECORD_INTEGRITY_V1 = 'record_sha256_v1';
const RECORD_INTEGRITY_V2 = 'record_sha256_v2';

class DurableIngestionQueue {
  constructor({ runPath, logger = null }) {
    if (!path.isAbsolute(runPath)) throw new Error('ingestion_queue_run_path_must_be_absolute');
    assertNotSymlink(runPath);
    this.runPath = runPath;
    this.logger = logger;
    this.sourcePath = path.join(runPath, 'ingestion-pending.jsonl');
    this.queuePath = path.join(runPath, 'ingestion-queue');
    this.eventsPath = path.join(this.queuePath, 'events.jsonl');
    this.statePath = path.join(this.queuePath, 'state.json');
    this.stateTmpPath = `${this.statePath}.tmp`;
    this.migrationPath = path.join(this.queuePath, 'migration.json');
    this.corruptTailPath = path.join(this.queuePath, 'corrupt-tail.bin');
    this.deadLetterPath = path.join(this.queuePath, 'dead-letter.jsonl');
    this.statusPath = path.join(this.queuePath, 'status.json');
    this.statusTmpPath = `${this.statusPath}.tmp`;
    this._ackKey = crypto.randomBytes(32);

    assertNotSymlink(this.sourcePath, { allowMissing: true });
    assertNotSymlink(this.queuePath, { allowMissing: true });
    fs.mkdirSync(this.queuePath, { recursive: true, mode: 0o700 });
    for (const internalPath of [
      this.eventsPath, this.statePath, this.stateTmpPath, this.migrationPath,
      this.corruptTailPath, this.deadLetterPath, this.statusPath, this.statusTmpPath,
    ]) assertNotSymlink(internalPath, { allowMissing: true });
    if (!fs.existsSync(this.eventsPath)) durableCreateEmpty(this.eventsPath);
    this._recoverJournal();
    this._recoverDeadLetterTail();
    this.state = this._loadState();
    this._latest = new Map();
    this._committedGenerations = new Set();
    this._generationMetadata = new Map();
    this._committedRetryIds = new Set();
    this._retryMetadata = new Map();
    this._legacyMetadata = new Map();
    this._deadLetterIds = new Set();
    this._pendingByFile = new Map();
    this._scanJournalAuthority();
    this._loadDeadLetterIds();
    this._recountPending();
    this._saveStatus();
  }

  get pendingCount() {
    return this._pendingCount;
  }

  upsert(filePath, items, metadata = {}) {
    assertFilePath(filePath);
    if (!Array.isArray(items) || items.some((entry) => !entry || entry.filePath !== filePath)) {
      throw new Error('ingestion_queue_upsert_items_must_match_file_path');
    }
    const generation = crypto.randomUUID();
    const records = items.map((entry) => ({
      v: FORMAT_VERSION, type: 'item', filePath, generation, item: entry,
    }));
    appendDurableTransaction(this.eventsPath, {
      begin: {
        v: FORMAT_VERSION,
        type: 'replace_begin',
        filePath,
        generation,
        count: items.length,
        metadata: normalizeGenerationMetadata(metadata),
      },
      records,
      commit: { v: FORMAT_VERSION, type: 'replace_commit', filePath, generation },
    });
    const previous = this._pendingByFile.get(filePath) || 0;
    this._latest.set(filePath, { type: 'replace', generation });
    this._committedGenerations.add(generation);
    this._generationMetadata.set(generation, normalizeGenerationMetadata(metadata));
    this._pendingByFile.set(filePath, items.length);
    this._pendingCount += items.length - previous;
    this._saveStatus();
    return generation;
  }

  removeFile(filePath) {
    assertFilePath(filePath);
    const generation = crypto.randomUUID();
    appendDurableRecord(this.eventsPath, withRecordIntegrity({
      v: FORMAT_VERSION, type: 'remove', filePath, generation,
    }));
    const previous = this._pendingByFile.get(filePath) || 0;
    this._latest.set(filePath, { type: 'remove', generation });
    this._pendingByFile.delete(filePath);
    this._pendingCount -= previous;
    this._saveStatus();
  }

  requeue(items, deliveries) {
    if (!Array.isArray(items) || !Array.isArray(deliveries) || items.length !== deliveries.length) {
      throw new Error('ingestion_queue_retry_shape_invalid');
    }
    const retryId = crypto.createHash('sha256')
      .update(JSON.stringify(deliveries.map(({ source, start, end }) => [source, start, end])))
      .digest('hex');
    if (this._committedRetryIds.has(retryId)) return retryId;
    const files = {};
    const compactItems = items.map((entry) => {
      assertFilePath(entry?.filePath);
      if (!files[entry.filePath]) {
        const latest = this._latest.get(entry.filePath);
        files[entry.filePath] = {
          authorityGeneration: latest?.type === 'replace' ? latest.generation : null,
          relationships: Array.isArray(entry.relationships) ? entry.relationships : [],
        };
      }
      const compact = { ...entry };
      delete compact.relationships;
      return compact;
    });
    appendDurableTransaction(this.eventsPath, {
      begin: { v: FORMAT_VERSION, type: 'retry_begin', retryId, count: items.length, files },
      records: compactItems.map((entry) => ({
        v: FORMAT_VERSION, type: 'retry_item', retryId, filePath: entry.filePath, item: entry,
      })),
      commit: { v: FORMAT_VERSION, type: 'retry_commit', retryId },
    });
    this._committedRetryIds.add(retryId);
    this._retryMetadata.set(retryId, files);
    for (const entry of compactItems) {
      if (this._retryItemIsActive({ retryId, filePath: entry.filePath })) {
        increment(this._pendingByFile, entry.filePath);
        this._pendingCount += 1;
      }
    }
    this._saveStatus();
    return retryId;
  }

  deadLetter(items, reason = 'failed', deliveries = []) {
    if (!Array.isArray(items) || items.length === 0) return;
    if (!Array.isArray(deliveries) || (deliveries.length !== 0 && deliveries.length !== items.length)) {
      throw new Error('ingestion_queue_dead_letter_shape_invalid');
    }
    const pending = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const delivery = deliveries[index] || null;
      const deadLetterId = crypto.createHash('sha256')
        .update(JSON.stringify([reason, delivery, compactQueueItem(item)]))
        .digest('hex');
      if (!this._deadLetterIds.has(deadLetterId)) pending.push({ item, deadLetterId });
    }
    if (pending.length === 0) return;
    const created = !fs.existsSync(this.deadLetterPath);
    const fd = fs.openSync(this.deadLetterPath, 'a', 0o600);
    try {
      for (const { item, deadLetterId } of pending) {
        const compact = compactQueueItem(item);
        writeRecord(fd, {
          v: FORMAT_VERSION,
          type: 'dead_letter',
          deadLetterId,
          at: new Date().toISOString(),
          reason,
          filePath: item.filePath,
          item: compact,
        });
      }
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (created) fsyncDirectory(this.queuePath);
    for (const { deadLetterId } of pending) this._deadLetterIds.add(deadLetterId);
  }

  migrateLegacy({ maxRecords = 1000 } = {}) {
    if (!Number.isSafeInteger(maxRecords) || maxRecords <= 0) {
      throw new Error('ingestion_queue_migration_limit_invalid');
    }
    let migration = readSmallJson(this.migrationPath, { v: FORMAT_VERSION, offset: 0, complete: false });
    if (!fs.existsSync(this.sourcePath)) {
      return { complete: true, migratedRecords: 0, offset: migration.offset || 0 };
    }
    if (migration.sourceIdentity) {
      const currentIdentity = fileIdentity(this.sourcePath, { sha256: true });
      if (!sameFileIdentity(migration.sourceIdentity, currentIdentity)) {
        throw new Error('ingestion_queue_migration_source_changed');
      }
      if (migration.complete) {
        return { complete: true, migratedRecords: 0, offset: migration.offset || 0 };
      }
    }
    if (!migration.validated) {
      const inspection = inspectLegacySource(this.sourcePath, this.logger);
      assertMigrationHeadroom(this.queuePath, inspection.projectedJournalBytes);
      migration = {
        v: FORMAT_VERSION,
        offset: 0,
        complete: false,
        validated: true,
        sourceIdentity: inspection.sourceIdentity,
        projectedJournalBytes: inspection.projectedJournalBytes,
      };
      writeSmallJsonAtomic(this.migrationPath, migration);
    }

    let groupCount = 0;
    let groupFile = null;
    let groupRelationships = [];
    let groupStart = migration.offset;
    let groupEnd = migration.offset;
    let migratedRecords = 0;
    const flushGroup = () => {
      if (groupCount === 0) return true;
      if (migratedRecords > 0 && migratedRecords + groupCount > maxRecords) return false;
      const generation = legacyGeneration(groupFile, migration.sourceIdentity.sha256);
      appendDurableTransaction(this.eventsPath, {
        begin: {
          v: FORMAT_VERSION,
          type: 'legacy_begin',
          filePath: groupFile,
          generation,
          count: 0,
          sourceCount: groupCount,
          sourceStart: groupStart,
          sourceEnd: groupEnd,
          metadata: normalizeGenerationMetadata({ relationships: groupRelationships }),
        },
        records: [],
        commit: { v: FORMAT_VERSION, type: 'legacy_commit', filePath: groupFile, generation },
      });
      this._legacyMetadata.set(groupFile, {
        generation,
        count: groupCount,
        sourceStart: groupStart,
        sourceEnd: groupEnd,
        relationships: groupRelationships,
      });
      migratedRecords += groupCount;
      migration = { ...migration, offset: groupEnd, complete: false };
      writeSmallJsonAtomic(this.migrationPath, migration);
      groupCount = 0;
      groupRelationships = [];
      return true;
    };

    let reachedEnd = true;
    for (const record of readJsonLines(this.sourcePath, migration.offset, this.logger)) {
      const entry = record.value;
      if (!entry || typeof entry.filePath !== 'string') {
        migration = { ...migration, offset: record.end, complete: false };
        writeSmallJsonAtomic(this.migrationPath, migration);
        continue;
      }
      if (groupFile !== null && entry.filePath !== groupFile) {
        if (!flushGroup()) { reachedEnd = false; break; }
      }
      if (groupCount === 0) {
        groupFile = entry.filePath;
        groupRelationships = Array.isArray(entry.relationships) ? entry.relationships : [];
        groupStart = record.start;
      }
      groupCount += 1;
      groupEnd = record.end;
    }
    if (reachedEnd && groupCount > 0 && !flushGroup()) reachedEnd = false;
    if (reachedEnd) {
      migration = { ...migration, offset: fileSize(this.sourcePath), complete: true };
      writeSmallJsonAtomic(this.migrationPath, migration);
    }
    return { complete: reachedEnd, migratedRecords, offset: migration.offset };
  }

  peekBatch(limit) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('ingestion_queue_batch_limit_invalid');
    const items = [];
    const deliveries = [];
    let baseOffset = this.state.baseOffset;
    let eventOffset = this.state.eventOffset;

    if (fs.existsSync(this.sourcePath)) {
      const result = this._readActive(this.sourcePath, baseOffset, limit, 'base', items, deliveries);
      baseOffset = result.offset;
    }
    if (items.length < limit && baseOffset >= fileSize(this.sourcePath)) {
      const result = this._readActive(this.eventsPath, eventOffset, limit - items.length, 'event', items, deliveries);
      eventOffset = result.offset;
    }

    const deliveriesFrozen = Object.freeze(deliveries.map((delivery) => Object.freeze({ ...delivery })));
    const tokenValue = {
        v: FORMAT_VERSION,
        startBaseOffset: this.state.baseOffset,
        startEventOffset: this.state.eventOffset,
        baseOffset,
        eventOffset,
        deliveries: deliveriesFrozen,
    };
    return {
      items,
      token: Object.freeze({ ...tokenValue, ackChecksum: sealAck(this._ackKey, tokenValue) }),
    };
  }

  commit(token) {
    if (!token || token.v !== FORMAT_VERSION
      || token.startBaseOffset !== this.state.baseOffset
      || token.startEventOffset !== this.state.eventOffset
      || !validOffsetRange(token.startBaseOffset, token.baseOffset, fileSize(this.sourcePath))
      || !validOffsetRange(token.startEventOffset, token.eventOffset, fileSize(this.eventsPath))
      || !Array.isArray(token.deliveries)
      || !safeEqual(token.ackChecksum, sealAck(this._ackKey, token))) {
      throw new Error('ingestion_queue_stale_or_invalid_ack');
    }
    const nextState = {
      v: FORMAT_VERSION,
      baseOffset: token.baseOffset,
      eventOffset: token.eventOffset,
    };
    this._saveState(nextState);
    for (const delivery of token.deliveries || []) {
      const current = this._pendingByFile.get(delivery.filePath) || 0;
      if (current > 1) this._pendingByFile.set(delivery.filePath, current - 1);
      else this._pendingByFile.delete(delivery.filePath);
      this._pendingCount -= 1;
    }
    this.state = nextState;
    this._saveStatus();
  }

  readAll() {
    const result = [];
    let token;
    let baseOffset = this.state.baseOffset;
    let eventOffset = this.state.eventOffset;
    do {
      const items = [];
      const deliveries = [];
      let scan = this._readActive(this.sourcePath, baseOffset, 1000, 'base', items, deliveries);
      baseOffset = scan.offset;
      if (items.length < 1000 && baseOffset >= fileSize(this.sourcePath)) {
        scan = this._readActive(this.eventsPath, eventOffset, 1000 - items.length, 'event', items, deliveries);
        eventOffset = scan.offset;
      }
      result.push(...items);
      token = items.length > 0;
    } while (token);
    return result;
  }

  _loadState() {
    let parsed = null;
    try { parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8')); } catch { /* new queue */ }
    const sourceBytes = fileSize(this.sourcePath);
    const eventBytes = fileSize(this.eventsPath);
    if (!parsed || parsed.v !== FORMAT_VERSION
      || !validOffset(parsed.baseOffset, sourceBytes)
      || !validOffset(parsed.eventOffset, eventBytes)
      || parsed.checksum !== stateChecksum(parsed.baseOffset, parsed.eventOffset)) {
      return { v: FORMAT_VERSION, baseOffset: 0, eventOffset: 0 };
    }
    return parsed;
  }

  _saveState(state = this.state) {
    const persisted = {
      ...state,
      checksum: stateChecksum(state.baseOffset, state.eventOffset),
    };
    const fd = fs.openSync(this.stateTmpPath, 'w', 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(persisted)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(this.stateTmpPath, this.statePath);
    fsyncDirectory(this.queuePath);
  }

  _saveStatus() {
    const value = { v: FORMAT_VERSION, pendingCount: this._pendingCount };
    writeSmallJsonAtomic(this.statusPath, {
      ...value,
      checksum: statusChecksum(value),
    });
  }

  _scanJournalAuthority() {
    const begins = new Map();
    const retryBegins = new Map();
    const legacyBegins = new Map();
    for (const record of readJsonLines(this.eventsPath, 0, this.logger)) {
      const value = record.value;
      if (value?.v !== FORMAT_VERSION) continue;
      if (value.type === 'replace_begin' && typeof value.generation === 'string') {
        if (typeof value.filePath !== 'string') continue;
        begins.set(value.generation, {
          filePath: value.filePath,
          count: value.count,
          metadata: normalizeGenerationMetadata(value.metadata),
        });
      } else if (value.type === 'replace_commit' && typeof value.generation === 'string') {
        if (typeof value.filePath !== 'string') continue;
        const begin = begins.get(value.generation);
        if (begin && begin.filePath === value.filePath && begin.count === value.count) {
          this._committedGenerations.add(value.generation);
          this._latest.set(value.filePath, { type: 'replace', generation: value.generation });
          this._generationMetadata.set(value.generation, begin.metadata);
        }
      } else if (value.type === 'remove' && typeof value.generation === 'string') {
        if (typeof value.filePath !== 'string') continue;
        this._latest.set(value.filePath, { type: 'remove', generation: value.generation });
      } else if (value.type === 'retry_begin' && typeof value.retryId === 'string') {
        retryBegins.set(value.retryId, { count: value.count, files: value.files || {} });
      } else if (value.type === 'retry_commit' && typeof value.retryId === 'string') {
        const begin = retryBegins.get(value.retryId);
        if (begin && begin.count === value.count) {
          this._committedRetryIds.add(value.retryId);
          this._retryMetadata.set(value.retryId, begin.files);
        }
      } else if (value.type === 'legacy_begin' && typeof value.generation === 'string') {
        legacyBegins.set(value.generation, {
          filePath: value.filePath,
          count: value.sourceCount,
          sourceStart: value.sourceStart,
          sourceEnd: value.sourceEnd,
          metadata: normalizeGenerationMetadata(value.metadata),
        });
      } else if (value.type === 'legacy_commit' && typeof value.generation === 'string') {
        const begin = legacyBegins.get(value.generation);
        if (begin && begin.filePath === value.filePath && value.count === 0) {
          this._legacyMetadata.set(value.filePath, {
            generation: value.generation,
            count: begin.count,
            sourceStart: begin.sourceStart,
            sourceEnd: begin.sourceEnd,
            relationships: begin.metadata.relationships,
          });
        }
      }
    }
  }

  _loadDeadLetterIds() {
    for (const record of readJsonLines(this.deadLetterPath, 0, this.logger)) {
      if (record.value?.type === 'dead_letter' && typeof record.value.deadLetterId === 'string') {
        this._deadLetterIds.add(record.value.deadLetterId);
      }
    }
  }

  _recountPending() {
    this._pendingByFile.clear();
    for (const record of readJsonLines(this.sourcePath, this.state.baseOffset, this.logger)) {
      const item = record.value;
      if (item && typeof item.filePath === 'string' && !this._latest.has(item.filePath)) {
        increment(this._pendingByFile, item.filePath);
      }
    }
    for (const record of readJsonLines(this.eventsPath, this.state.eventOffset, this.logger)) {
      const value = record.value;
      if (this._eventItemIsActive(value)) increment(this._pendingByFile, value.filePath);
    }
    this._pendingCount = [...this._pendingByFile.values()].reduce((sum, value) => sum + value, 0);
  }

  _readActive(filePath, offset, limit, source, items, deliveries) {
    let nextOffset = offset;
    for (const record of readJsonLines(filePath, offset, this.logger)) {
      nextOffset = record.end;
      const value = record.value;
      const item = source === 'base' ? value : value?.item;
      const active = source === 'base'
        ? item && typeof item.filePath === 'string' && !this._latest.has(item.filePath)
        : this._eventItemIsActive(value);
      if (!active) continue;
      if (source === 'event') {
        const metadata = value.type === 'retry_item'
          ? this._retryMetadata.get(value.retryId)?.[value.filePath]
          : this._generationMetadata.get(value.generation);
        items.push({
          ...item,
          ...(metadata?.relationships ? { relationships: metadata.relationships } : {}),
          _queueGeneration: value.type === 'retry_item'
            ? item._queueGeneration || `retry:${value.retryId}`
            : value.generation,
        });
      } else {
        const metadata = this._legacyMetadata.get(item.filePath);
        const compact = { ...item };
        delete compact.relationships;
        items.push({
          ...compact,
          relationships: metadata?.relationships || item.relationships || [],
          _queueGeneration: metadata?.generation || legacyGeneration(item.filePath, 'unmigrated'),
        });
      }
      deliveries.push({ filePath: item.filePath, source, start: record.start, end: record.end });
      if (items.length >= limit) break;
    }
    return { offset: nextOffset };
  }

  _eventItemIsActive(value) {
    if (!value || value.v !== FORMAT_VERSION || typeof value.filePath !== 'string' || !value.item) return false;
    if (value.type === 'retry_item') return this._retryItemIsActive(value);
    if (value.type !== 'item' || typeof value.generation !== 'string') return false;
    const latest = this._latest.get(value.filePath);
    return latest?.type === 'replace'
      && latest.generation === value.generation
      && this._committedGenerations.has(value.generation);
  }

  _retryItemIsActive(value) {
    if (!this._committedRetryIds.has(value.retryId)) return false;
    const metadata = this._retryMetadata.get(value.retryId)?.[value.filePath];
    if (!metadata) return false;
    const latest = this._latest.get(value.filePath);
    if (metadata.authorityGeneration === null) return latest === undefined;
    return latest?.type === 'replace' && latest.generation === metadata.authorityGeneration;
  }

  _recoverJournal() {
    this._recoverIncompleteByteTail();
    let open = null;
    let corruptStart = null;
    let v2JournalStarted = false;
    try {
      for (const record of readJsonLines(this.eventsPath, 0, this.logger, { strict: true })) {
        const value = record.value;
        const beginType = transactionBeginType(value?.type);
        const commitType = transactionCommitType(value?.type);
        if (beginType) {
          if (open) { corruptStart = open.start; break; }
          const integrityVersion = transactionIntegrityVersion(value);
          if (integrityVersion < 0 || (v2JournalStarted && integrityVersion < 2)) {
            corruptStart = record.start;
            break;
          }
          if (integrityVersion === 2) v2JournalStarted = true;
          const hash = crypto.createHash('sha256');
          if (integrityVersion >= 1) hash.update(encodeRecord(value));
          open = {
            type: beginType,
            id: transactionId(value),
            v: value.v,
            filePath: value.filePath,
            integrityVersion,
            start: record.start,
            expectedCount: value.count,
            seen: 0,
            hash,
          };
          continue;
        }
        if (isTransactionItem(value?.type)) {
          if (!open || open.type !== transactionItemType(value.type)
            || open.id !== transactionId(value)) {
            corruptStart = open?.start ?? record.start;
            break;
          }
          open.seen += 1;
          open.hash.update(encodeRecord(value));
          continue;
        }
        if (commitType) {
          let digest = null;
          if (open?.integrityVersion === 2 && value.integrity === TRANSACTION_INTEGRITY_V2) {
            const { checksum: _checksum, ...unsignedCommit } = value;
            digest = open.hash.copy().update(encodeRecord(unsignedCommit)).digest('hex');
          } else if (open && open.integrityVersion < 2 && value.integrity === undefined) {
            digest = open.hash.copy().digest('hex');
          }
          if (!open || open.type !== commitType || open.id !== transactionId(value)
            || open.v !== value.v || open.filePath !== value.filePath
            || !Number.isSafeInteger(open.expectedCount)
            || open.seen !== open.expectedCount
            || value.count !== open.seen
            || value.checksum !== digest) {
            corruptStart = open?.start ?? record.start;
            break;
          }
          open = null;
          continue;
        }
        const integrityVersion = standaloneRecordIntegrityVersion(value);
        if (value?.type !== 'remove' || open
          || integrityVersion < 0
          || (v2JournalStarted && integrityVersion < 2)) {
          corruptStart = open?.start ?? record.start;
          break;
        }
        if (integrityVersion === 2) v2JournalStarted = true;
      }
    } catch (error) {
      corruptStart = open?.start ?? error.offset ?? 0;
    }
    if (corruptStart === null && open) corruptStart = open.start;
    if (corruptStart !== null) this._quarantineJournalFrom(corruptStart);
  }

  _recoverIncompleteByteTail() {
    const size = fileSize(this.eventsPath);
    if (size === 0) return;
    const fd = fs.openSync(this.eventsPath, 'r+');
    try {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      if (last[0] === 0x0a) return;
      const boundary = findLastNewline(fd, size);
      const tailStart = boundary < 0 ? 0 : boundary + 1;
      const tailLength = size - tailStart;
      const tail = Buffer.alloc(tailLength);
      fs.readSync(fd, tail, 0, tailLength, tailStart);
      appendQuarantine(this.corruptTailPath, tail);
      fs.ftruncateSync(fd, tailStart);
      fs.fsyncSync(fd);
      this.logger?.error?.('Ingestion queue journal had an incomplete tail; quarantined it', {
        bytes: tailLength, file: this.corruptTailPath,
      });
    } finally {
      fs.closeSync(fd);
    }
  }

  _recoverDeadLetterTail() {
    const size = fileSize(this.deadLetterPath);
    if (size === 0) return;
    let corruptStart = null;
    const fd = fs.openSync(this.deadLetterPath, 'r');
    try {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) {
        const boundary = findLastNewline(fd, size);
        corruptStart = boundary < 0 ? 0 : boundary + 1;
      }
    } finally {
      fs.closeSync(fd);
    }
    if (corruptStart === null) {
      try {
        for (const _record of readJsonLines(this.deadLetterPath, 0, this.logger, { strict: true })) {
          // Parsing is the validation; records are indexed after recovery.
        }
      } catch (error) {
        corruptStart = error.offset ?? 0;
      }
    }
    if (corruptStart !== null) {
      quarantineFileSuffix(this.deadLetterPath, corruptStart, this.corruptTailPath, this.queuePath);
      this.logger?.error?.('Quarantined an invalid ingestion dead-letter suffix', {
        file: this.corruptTailPath,
      });
    }
  }

  _quarantineJournalFrom(start) {
    const bytes = fileSize(this.eventsPath) - start;
    quarantineFileSuffix(this.eventsPath, start, this.corruptTailPath, this.queuePath);
    this.logger?.error?.('Quarantined an invalid ingestion queue journal suffix', {
      bytes, file: this.corruptTailPath,
    });
  }
}

function* readJsonLines(filePath, startOffset = 0, logger = null, { strict = false } = {}) {
  if (!fs.existsSync(filePath)) return;
  const fd = fs.openSync(filePath, 'r');
  let position = startOffset;
  let carry = Buffer.alloc(0);
  let carryStart = startOffset;
  try {
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    while (true) {
      const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const data = carry.length === 0
        ? Buffer.from(chunk.subarray(0, bytesRead))
        : Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
      if (data.length > MAX_RECORD_BYTES && data.indexOf(0x0a) < 0) {
        throw new Error(`ingestion_queue_record_exceeds_${MAX_RECORD_BYTES}_bytes`);
      }
      let lineStart = 0;
      while (true) {
        const newline = data.indexOf(0x0a, lineStart);
        if (newline < 0) break;
        const absoluteStart = carryStart + lineStart;
        const absoluteEnd = carryStart + newline + 1;
        const line = data.subarray(lineStart, newline);
        if (line.length > 0) {
          try {
            yield { value: JSON.parse(line.toString('utf8')), start: absoluteStart, end: absoluteEnd };
          } catch (error) {
            if (strict) {
              const failure = new Error(`ingestion_queue_invalid_json_at_${absoluteStart}`, { cause: error });
              failure.offset = absoluteStart;
              throw failure;
            }
            logger?.error?.('Ingestion queue contains an unreadable record; preserved and skipped', {
              file: filePath, offset: absoluteStart, bytes: line.length, error: error.message,
            });
          }
        }
        lineStart = newline + 1;
      }
      carry = Buffer.from(data.subarray(lineStart));
      carryStart += lineStart;
      if (carry.length > MAX_RECORD_BYTES) throw new Error(`ingestion_queue_record_exceeds_${MAX_RECORD_BYTES}_bytes`);
    }
    if (carry.length > 0) {
      try {
        yield { value: JSON.parse(carry.toString('utf8')), start: carryStart, end: position };
      } catch (error) {
        if (strict) {
          const failure = new Error(`ingestion_queue_invalid_json_at_${carryStart}`, { cause: error });
          failure.offset = carryStart;
          throw failure;
        }
        logger?.error?.('Ingestion queue source has an unreadable tail; preserved and skipped', {
          file: filePath, offset: carryStart, bytes: carry.length, error: error.message,
        });
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

function writeRecord(fd, record) {
  const encoded = encodeRecord(record);
  if (encoded.length > MAX_RECORD_BYTES) throw new Error(`ingestion_queue_record_exceeds_${MAX_RECORD_BYTES}_bytes`);
  writeFullSync(fd, encoded);
  return encoded;
}

function appendDurableRecord(filePath, record) {
  const fd = fs.openSync(filePath, 'a', 0o600);
  try { writeRecord(fd, record); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function appendDurableTransaction(filePath, { begin, records, commit }) {
  const start = fileSize(filePath);
  let fd = fs.openSync(filePath, 'a', 0o600);
  try {
    const protectedBegin = { ...begin, integrity: TRANSACTION_INTEGRITY_V2 };
    const encodedBegin = writeRecord(fd, protectedBegin);
    const hash = crypto.createHash('sha256');
    hash.update(encodedBegin);
    let count = 0;
    for (const record of records) {
      hash.update(writeRecord(fd, record));
      count += 1;
    }
    const protectedCommit = { ...commit, count, integrity: TRANSACTION_INTEGRITY_V2 };
    hash.update(encodeRecord(protectedCommit));
    writeRecord(fd, { ...protectedCommit, checksum: hash.digest('hex') });
    fs.fsyncSync(fd);
  } catch (error) {
    try { fs.closeSync(fd); } finally { fd = null; }
    try {
      const rollbackFd = fs.openSync(filePath, 'r+');
      try { fs.ftruncateSync(rollbackFd, start); fs.fsyncSync(rollbackFd); } finally { fs.closeSync(rollbackFd); }
    } catch (rollbackError) {
      error.rollbackError = rollbackError;
      error.message = `${error.message}; ingestion_queue_rollback_failed: ${rollbackError.message}`;
    }
    throw error;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function encodeRecord(record) {
  return Buffer.from(`${JSON.stringify(record)}\n`);
}

function withRecordIntegrity(record) {
  const protectedRecord = { ...record, integrity: RECORD_INTEGRITY_V2 };
  return { ...protectedRecord, checksum: checksumRecord(protectedRecord) };
}

function transactionIntegrityVersion(record) {
  if (record.integrity === undefined) return 0;
  if (record.integrity === TRANSACTION_INTEGRITY_V1) return 1;
  if (record.integrity === TRANSACTION_INTEGRITY_V2) return 2;
  return -1;
}

function standaloneRecordIntegrityVersion(record) {
  if (!record || typeof record !== 'object') return -1;
  const hasIntegrity = Object.hasOwn(record, 'integrity');
  const hasChecksum = Object.hasOwn(record, 'checksum');
  if (!hasIntegrity && !hasChecksum) return 0;
  if (typeof record.checksum !== 'string' || !safeEqual(record.checksum, checksumRecord(record))) return -1;
  if (record.integrity === RECORD_INTEGRITY_V1) return 1;
  if (record.integrity === RECORD_INTEGRITY_V2) return 2;
  return -1;
}

function checksumRecord(record) {
  const { checksum: _checksum, ...unsigned } = record;
  return crypto.createHash('sha256').update(encodeRecord(unsigned)).digest('hex');
}

function writeFullSync(fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const written = fs.writeSync(fd, buffer, offset, buffer.length - offset);
    if (!Number.isSafeInteger(written) || written <= 0) {
      throw new Error('ingestion_queue_short_write_no_progress');
    }
    offset += written;
  }
}

function appendQuarantine(filePath, buffer) {
  const created = !fs.existsSync(filePath);
  const fd = fs.openSync(filePath, 'a', 0o600);
  try { writeFullSync(fd, buffer); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (created) fsyncDirectory(path.dirname(filePath));
}

function quarantineFileSuffix(sourcePath, start, corruptPath, queuePath) {
  const size = fileSize(sourcePath);
  const sourceFd = fs.openSync(sourcePath, 'r+');
  try {
    const created = !fs.existsSync(corruptPath);
    const corruptFd = fs.openSync(corruptPath, 'a', 0o600);
    const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, Math.max(1, size - start)));
    try {
      let position = start;
      while (position < size) {
        const bytesRead = fs.readSync(sourceFd, chunk, 0, Math.min(chunk.length, size - position), position);
        if (bytesRead === 0) break;
        writeFullSync(corruptFd, chunk.subarray(0, bytesRead));
        position += bytesRead;
      }
      fs.fsyncSync(corruptFd);
    } finally {
      fs.closeSync(corruptFd);
    }
    if (created) fsyncDirectory(queuePath);
    fs.ftruncateSync(sourceFd, start);
    fs.fsyncSync(sourceFd);
  } finally {
    fs.closeSync(sourceFd);
  }
}

function durableCreateEmpty(filePath) {
  const fd = fs.openSync(filePath, 'wx', 0o600);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fsyncDirectory(path.dirname(filePath));
}

function fsyncDirectory(dirPath) {
  const fd = fs.openSync(dirPath, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function findLastNewline(fd, size) {
  const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, size));
  let end = size;
  while (end > 0) {
    const start = Math.max(0, end - chunk.length);
    const length = end - start;
    fs.readSync(fd, chunk, 0, length, start);
    const index = chunk.lastIndexOf(0x0a, length - 1);
    if (index >= 0) return start + index;
    end = start;
  }
  return -1;
}

function validOffset(value, max) {
  return Number.isSafeInteger(value) && value >= 0 && value <= max;
}

function validOffsetRange(start, end, max) {
  return validOffset(start, max) && validOffset(end, max) && end >= start;
}

function stateChecksum(baseOffset, eventOffset) {
  return crypto.createHash('sha256')
    .update(`${FORMAT_VERSION}:${baseOffset}:${eventOffset}`)
    .digest('hex');
}

function fileSize(filePath) {
  try { return fs.statSync(filePath).size; } catch { return 0; }
}

function fileIdentity(filePath, { sha256 = false } = {}) {
  const stat = fs.statSync(filePath);
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ...(sha256 ? { sha256: sha256File(filePath) } : {}),
  };
}

function sameFileIdentity(left, right) {
  return left && right
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && (!left.sha256 || left.sha256 === right.sha256);
}

function inspectLegacySource(filePath, logger) {
  const closed = new Set();
  let current = null;
  let relationships = [];
  let projectedJournalBytes = 0;
  for (const record of readJsonLines(filePath, 0, logger, { strict: true })) {
    const filePathValue = record.value?.filePath;
    if (typeof filePathValue !== 'string' || !filePathValue) {
      throw new Error(`ingestion_queue_migration_invalid_item_at_${record.start}`);
    }
    if (filePathValue !== current) {
      if (current !== null) {
        closed.add(current);
        projectedJournalBytes += Buffer.byteLength(JSON.stringify(relationships)) + 2048;
      }
      if (closed.has(filePathValue)) {
        throw new Error(`ingestion_queue_migration_noncontiguous_file_generation:${filePathValue}`);
      }
      current = filePathValue;
      relationships = Array.isArray(record.value.relationships) ? record.value.relationships : [];
    }
  }
  if (current !== null) projectedJournalBytes += Buffer.byteLength(JSON.stringify(relationships)) + 2048;
  return {
    sourceIdentity: fileIdentity(filePath, { sha256: true }),
    projectedJournalBytes,
  };
}

function assertMigrationHeadroom(queuePath, projectedJournalBytes) {
  const stat = fs.statfsSync(queuePath);
  const availableBytes = Number(stat.bavail) * Number(stat.bsize);
  const requiredBytes = projectedJournalBytes + 64 * 1024 * 1024;
  if (!Number.isFinite(availableBytes) || availableBytes < requiredBytes) {
    throw new Error(`ingestion_queue_migration_insufficient_headroom:${requiredBytes}:${availableBytes}`);
  }
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let position = 0;
    while (true) {
      const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      hash.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function legacyGeneration(filePath, sourceHash) {
  return `legacy:${crypto.createHash('sha256').update(`${sourceHash}\0${filePath}`).digest('hex')}`;
}

function compactQueueItem(item) {
  const compact = { ...item };
  delete compact.relationships;
  return compact;
}

function transactionBeginType(type) {
  if (type === 'replace_begin') return 'replace';
  if (type === 'retry_begin') return 'retry';
  if (type === 'legacy_begin') return 'legacy';
  return null;
}

function transactionCommitType(type) {
  if (type === 'replace_commit') return 'replace';
  if (type === 'retry_commit') return 'retry';
  if (type === 'legacy_commit') return 'legacy';
  return null;
}

function transactionItemType(type) {
  if (type === 'item') return 'replace';
  if (type === 'retry_item') return 'retry';
  return null;
}

function isTransactionItem(type) {
  return transactionItemType(type) !== null;
}

function transactionId(value) {
  return value?.retryId || value?.generation || null;
}

function sealAck(key, token) {
  const payload = {
    v: token.v,
    startBaseOffset: token.startBaseOffset,
    startEventOffset: token.startEventOffset,
    baseOffset: token.baseOffset,
    eventOffset: token.eventOffset,
    deliveries: token.deliveries,
  };
  return crypto.createHmac('sha256', key).update(JSON.stringify(payload)).digest('hex');
}

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function statusChecksum(value) {
  return crypto.createHash('sha256').update(`${value.v}:${value.pendingCount}`).digest('hex');
}

function readDurableIngestionQueueStats(runPath) {
  if (!path.isAbsolute(runPath)) throw new Error('ingestion_queue_run_path_must_be_absolute');
  const value = readSmallJson(path.join(runPath, 'ingestion-queue', 'status.json'), null);
  if (!value || value.v !== FORMAT_VERSION || !Number.isSafeInteger(value.pendingCount)
    || value.pendingCount < 0 || value.checksum !== statusChecksum(value)) {
    throw new Error('ingestion_queue_status_unavailable_or_invalid');
  }
  return { pendingCount: value.pendingCount, v: value.v };
}

function increment(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function assertFilePath(filePath) {
  if (typeof filePath !== 'string' || !filePath) throw new Error('ingestion_queue_file_path_required');
}

function assertNotSymlink(filePath, { allowMissing = false } = {}) {
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) {
      throw new Error(`ingestion_queue_symlink_forbidden:${filePath}`);
    }
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return;
    throw error;
  }
}

const INTERNAL_NAMES = new Set([
  'ingestion-queue', 'events.jsonl', 'state.json', 'state.json.tmp', 'migration.json',
  'migration.json.tmp', 'corrupt-tail.bin',
  'dead-letter.jsonl', 'status.json', 'status.json.tmp',
]);

function isIngestionQueueInternalFile(name) {
  return INTERNAL_NAMES.has(name) || name.startsWith('ingestion-queue.');
}

function normalizeGenerationMetadata(value) {
  const relationships = Array.isArray(value?.relationships) ? value.relationships : [];
  return { relationships };
}

function readSmallJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; }
}

function writeSmallJsonAtomic(filePath, value) {
  const tmpPath = `${filePath}.tmp`;
  const fd = fs.openSync(tmpPath, 'w', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(value)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmpPath, filePath);
  fsyncDirectory(path.dirname(filePath));
}

module.exports = {
  DurableIngestionQueue,
  isIngestionQueueInternalFile,
  readDurableIngestionQueueStats,
  sha256File,
};
