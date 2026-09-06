import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { basename, join } from 'node:path';

export type ConnectedAgentsDeliveryState =
  'pending' | 'retryable' | 'delivered' | 'invalid' | 'failed';

export interface ConnectedAgentsDeliveryReceipt {
  message_id: string;
  device_id: string;
  bundle_id: string;
  state: ConnectedAgentsDeliveryState;
  attempts: number;
  updated_at: string;
  delivered_at: string | null;
  error_code: string | null;
}

export interface ConnectedAgentsDeliveryPosition {
  created_at: string;
  message_id: string;
}

interface ConnectedAgentsDeliveryCheckpoint {
  version: 1;
  through: ConnectedAgentsDeliveryPosition | null;
}

interface ConnectedAgentsDeliveryStoreOptions {
  now?: () => number | string | Date;
  maximumReceipts?: number;
}

const MESSAGE_ID_PATTERN = /^msg_[A-Za-z0-9_-]{16,160}$/;
const DEVICE_ID_PATTERN = /^dev_[A-Za-z0-9_-]{16,160}$/;
const ERROR_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/;
const RECEIPT_FILE_PATTERN = /^[a-f0-9]{64}\.json$/;
const TEMPORARY_FILE_PATTERN = /^\.[a-f0-9]{64}\.json\.\d+\.[a-f0-9]{16}\.tmp$/;
const CHECKPOINT_FILE_NAME = 'checkpoint.json';
const CHECKPOINT_TEMPORARY_FILE_PATTERN = /^\.checkpoint\.json\.\d+\.[a-f0-9]{16}\.tmp$/;
const MAXIMUM_RECEIPT_BYTES = 4 * 1024;
const DEFAULT_MAXIMUM_RECEIPTS = 4096;

function storageError(message: string, cause?: unknown): Error & { code: string } {
  const error = new Error(message, cause === undefined ? undefined : { cause }) as Error & {
    code: string;
  };
  error.code = message;
  return error;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && !Array.isArray(value) && typeof value === 'object';
}

function isCanonicalIso(value: unknown): value is string {
  return typeof value === 'string'
    && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value;
}

function validateReceipt(value: unknown): asserts value is ConnectedAgentsDeliveryReceipt {
  const keys = new Set([
    'message_id', 'device_id', 'bundle_id', 'state', 'attempts',
    'updated_at', 'delivered_at', 'error_code',
  ]);
  const states = new Set<ConnectedAgentsDeliveryState>([
    'pending', 'retryable', 'delivered', 'invalid', 'failed',
  ]);
  if (!isPlainObject(value)
      || Object.keys(value).length !== keys.size
      || Object.keys(value).some(key => !keys.has(key))
      || typeof value.message_id !== 'string' || !MESSAGE_ID_PATTERN.test(value.message_id)
      || typeof value.device_id !== 'string' || !DEVICE_ID_PATTERN.test(value.device_id)
      || typeof value.bundle_id !== 'string' || value.bundle_id.length < 1 || value.bundle_id.length > 255
      || !states.has(value.state as ConnectedAgentsDeliveryState)
      || !Number.isSafeInteger(value.attempts) || Number(value.attempts) < 1
      || !isCanonicalIso(value.updated_at)
      || (value.delivered_at !== null && !isCanonicalIso(value.delivered_at))
      || (value.error_code !== null
        && (typeof value.error_code !== 'string' || !ERROR_CODE_PATTERN.test(value.error_code)))) {
    throw storageError('connected_agents_delivery_store_corrupt');
  }
  if ((value.state === 'delivered') !== (value.delivered_at !== null)
      || ((value.state === 'pending' || value.state === 'delivered') && value.error_code !== null)
      || ((value.state === 'retryable' || value.state === 'invalid' || value.state === 'failed')
        && value.error_code === null)) {
    throw storageError('connected_agents_delivery_store_corrupt');
  }
}

function validatePosition(value: unknown): asserts value is ConnectedAgentsDeliveryPosition {
  if (!isPlainObject(value)
      || Object.keys(value).sort().join(',') !== 'created_at,message_id'
      || !isCanonicalIso(value.created_at)
      || typeof value.message_id !== 'string'
      || !MESSAGE_ID_PATTERN.test(value.message_id)) {
    throw storageError('connected_agents_delivery_store_corrupt');
  }
}

function validateCheckpoint(value: unknown): asserts value is ConnectedAgentsDeliveryCheckpoint {
  if (!isPlainObject(value)
      || Object.keys(value).sort().join(',') !== 'through,version'
      || value.version !== 1
      || (value.through !== null && !isPlainObject(value.through))) {
    throw storageError('connected_agents_delivery_store_corrupt');
  }
  if (value.through !== null) validatePosition(value.through);
}

function comparePositions(
  left: ConnectedAgentsDeliveryPosition,
  right: ConnectedAgentsDeliveryPosition,
): number {
  return left.created_at.localeCompare(right.created_at)
    || left.message_id.localeCompare(right.message_id);
}

/** Durable per-canonical-Message/per-device APNs delivery state. */
export class ConnectedAgentsDeliveryStore {
  private readonly now: () => number | string | Date;
  private readonly maximumReceipts: number;

  constructor(
    private readonly directory: string,
    options: ConnectedAgentsDeliveryStoreOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.maximumReceipts = options.maximumReceipts ?? DEFAULT_MAXIMUM_RECEIPTS;
    if (!Number.isSafeInteger(this.maximumReceipts)
        || this.maximumReceipts < 1
        || this.maximumReceipts > DEFAULT_MAXIMUM_RECEIPTS) {
      throw storageError('connected_agents_delivery_store_invalid');
    }
  }

  private timestamp(): string {
    const raw = this.now();
    const milliseconds = raw instanceof Date ? raw.getTime()
      : typeof raw === 'string' ? Date.parse(raw) : raw;
    if (!Number.isFinite(milliseconds)) {
      throw storageError('connected_agents_delivery_store_corrupt');
    }
    return new Date(Number(milliseconds)).toISOString();
  }

  private verifyDirectory(create: boolean): boolean {
    if (!existsSync(this.directory)) {
      if (!create) return false;
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    }
    const stat = lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw storageError('connected_agents_delivery_store_corrupt');
    }
    return true;
  }

  private checkpointPath(): string {
    return join(this.directory, CHECKPOINT_FILE_NAME);
  }

  private path(messageId: string, deviceId: string, bundleId: string): string {
    const digest = createHash('sha256')
      .update(messageId).update('\0').update(deviceId).update('\0').update(bundleId)
      .digest('hex');
    return join(this.directory, `${digest}.json`);
  }

  private read(
    messageId: string,
    deviceId: string,
    bundleId: string,
  ): ConnectedAgentsDeliveryReceipt | null {
    if (!this.verifyDirectory(false)) return null;
    const filePath = this.path(messageId, deviceId, bundleId);
    if (!existsSync(filePath)) return null;
    try {
      const stat = lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAXIMUM_RECEIPT_BYTES) {
        throw storageError('connected_agents_delivery_store_corrupt');
      }
      const receipt = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
      validateReceipt(receipt);
      if (receipt.message_id !== messageId
          || receipt.device_id !== deviceId
          || receipt.bundle_id !== bundleId) {
        throw storageError('connected_agents_delivery_store_corrupt');
      }
      return { ...receipt };
    } catch (cause) {
      if ((cause as { code?: string }).code === 'connected_agents_delivery_store_corrupt') {
        throw cause;
      }
      throw storageError('connected_agents_delivery_store_corrupt', cause);
    }
  }

  private receipts(): ConnectedAgentsDeliveryReceipt[] {
    if (!this.verifyDirectory(false)) return [];
    try {
      const names = readdirSync(this.directory);
      if (names.length > this.maximumReceipts * 2 + 2
          || names.some(name =>
            name !== CHECKPOINT_FILE_NAME
            && !RECEIPT_FILE_PATTERN.test(name)
            && !TEMPORARY_FILE_PATTERN.test(name)
            && !CHECKPOINT_TEMPORARY_FILE_PATTERN.test(name))) {
        throw storageError('connected_agents_delivery_store_corrupt');
      }
      for (const name of names.filter(name =>
        TEMPORARY_FILE_PATTERN.test(name) || CHECKPOINT_TEMPORARY_FILE_PATTERN.test(name))) {
        const temporary = join(this.directory, name);
        const stat = lstatSync(temporary);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAXIMUM_RECEIPT_BYTES) {
          throw storageError('connected_agents_delivery_store_corrupt');
        }
        unlinkSync(temporary);
      }
      return names.filter(name => RECEIPT_FILE_PATTERN.test(name)).map((name) => {
        const filePath = join(this.directory, name);
        const stat = lstatSync(filePath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAXIMUM_RECEIPT_BYTES) {
          throw storageError('connected_agents_delivery_store_corrupt');
        }
        const receipt = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
        validateReceipt(receipt);
        if (this.path(receipt.message_id, receipt.device_id, receipt.bundle_id) !== filePath) {
          throw storageError('connected_agents_delivery_store_corrupt');
        }
        return { ...receipt };
      });
    } catch (cause) {
      if ((cause as { code?: string }).code === 'connected_agents_delivery_store_corrupt') {
        throw cause;
      }
      throw storageError('connected_agents_delivery_store_corrupt', cause);
    }
  }

  private writeFile(filePath: string, bytes: string): void {
    if (Buffer.byteLength(bytes, 'utf8') > MAXIMUM_RECEIPT_BYTES) {
      throw storageError('connected_agents_delivery_store_capacity_exceeded');
    }
    this.verifyDirectory(true);
    const temporary = join(
      this.directory,
      `.${basename(filePath)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
    );
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, 'wx', 0o600);
      writeFileSync(descriptor, bytes, 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, filePath);
      const directoryDescriptor = openSync(this.directory, 'r');
      try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
    } catch (cause) {
      throw storageError('connected_agents_delivery_store_corrupt', cause);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }

  private write(receipt: ConnectedAgentsDeliveryReceipt): void {
    validateReceipt(receipt);
    const filePath = this.path(receipt.message_id, receipt.device_id, receipt.bundle_id);
    const bytes = `${JSON.stringify(receipt)}\n`;
    this.writeFile(filePath, bytes);
  }

  checkpoint(): ConnectedAgentsDeliveryPosition | null | undefined {
    if (!this.verifyDirectory(false)) return undefined;
    const filePath = this.checkpointPath();
    if (!existsSync(filePath)) return undefined;
    try {
      const stat = lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAXIMUM_RECEIPT_BYTES) {
        throw storageError('connected_agents_delivery_store_corrupt');
      }
      const checkpoint = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
      validateCheckpoint(checkpoint);
      return checkpoint.through === null ? null : { ...checkpoint.through };
    } catch (cause) {
      if ((cause as { code?: string }).code === 'connected_agents_delivery_store_corrupt') {
        throw cause;
      }
      throw storageError('connected_agents_delivery_store_corrupt', cause);
    }
  }

  initializeCheckpoint(
    through: ConnectedAgentsDeliveryPosition | null,
  ): ConnectedAgentsDeliveryPosition | null {
    const existing = this.checkpoint();
    if (existing !== undefined) return existing;
    if (through !== null) validatePosition(through);
    this.writeFile(this.checkpointPath(), `${JSON.stringify({ version: 1, through })}\n`);
    return through === null ? null : { ...through };
  }

  advanceCheckpoint(position: ConnectedAgentsDeliveryPosition): void {
    validatePosition(position);
    const current = this.checkpoint();
    if (current !== undefined && current !== null && comparePositions(position, current) <= 0) {
      return;
    }
    this.writeFile(
      this.checkpointPath(),
      `${JSON.stringify({ version: 1, through: position })}\n`,
    );
  }

  isAfterCheckpoint(position: ConnectedAgentsDeliveryPosition): boolean {
    validatePosition(position);
    const current = this.checkpoint();
    return current === undefined || current === null || comparePositions(position, current) > 0;
  }

  private makeRoom(): void {
    const receipts = this.receipts();
    if (receipts.length < this.maximumReceipts) return;
    const removable = receipts
      .filter(receipt => receipt.state === 'delivered'
        || receipt.state === 'invalid' || receipt.state === 'failed')
      .sort((left, right) => Date.parse(left.updated_at) - Date.parse(right.updated_at))[0];
    if (!removable) throw storageError('connected_agents_delivery_store_capacity_exceeded');
    unlinkSync(this.path(removable.message_id, removable.device_id, removable.bundle_id));
  }

  begin(input: {
    messageId: string;
    deviceId: string;
    bundleId: string;
    maximumAttempts: number;
  }): ConnectedAgentsDeliveryReceipt {
    if (!MESSAGE_ID_PATTERN.test(input.messageId)
        || !DEVICE_ID_PATTERN.test(input.deviceId)
        || input.bundleId.length < 1 || input.bundleId.length > 255
        || !Number.isSafeInteger(input.maximumAttempts) || input.maximumAttempts < 1) {
      throw storageError('connected_agents_delivery_store_invalid');
    }
    const existing = this.read(input.messageId, input.deviceId, input.bundleId);
    if (existing) {
      if (existing.state === 'delivered'
          || existing.state === 'invalid'
          || existing.state === 'failed') return existing;
      if (existing.attempts >= input.maximumAttempts) {
        const exhausted: ConnectedAgentsDeliveryReceipt = {
          ...existing,
          state: 'failed',
          updated_at: this.timestamp(),
          error_code: 'retry_exhausted',
        };
        this.write(exhausted);
        return exhausted;
      }
      const resumed: ConnectedAgentsDeliveryReceipt = {
        ...existing,
        state: 'pending',
        attempts: existing.attempts + 1,
        updated_at: this.timestamp(),
        delivered_at: null,
        error_code: null,
      };
      this.write(resumed);
      return resumed;
    }
    this.makeRoom();
    const receipt: ConnectedAgentsDeliveryReceipt = {
      message_id: input.messageId,
      device_id: input.deviceId,
      bundle_id: input.bundleId,
      state: 'pending',
      attempts: 1,
      updated_at: this.timestamp(),
      delivered_at: null,
      error_code: null,
    };
    this.write(receipt);
    return receipt;
  }

  finish(input: {
    messageId: string;
    deviceId: string;
    bundleId: string;
    state: 'retryable' | 'delivered' | 'invalid' | 'failed';
    errorCode?: string;
  }): ConnectedAgentsDeliveryReceipt {
    const receipt = this.read(input.messageId, input.deviceId, input.bundleId);
    if (!receipt) throw storageError('connected_agents_delivery_store_corrupt');
    if (receipt.state === 'delivered' || receipt.state === 'invalid') return receipt;
    const now = this.timestamp();
    const completed: ConnectedAgentsDeliveryReceipt = {
      ...receipt,
      state: input.state,
      updated_at: now,
      delivered_at: input.state === 'delivered' ? now : null,
      error_code: input.state === 'delivered'
        ? null
        : input.state === 'invalid'
          ? 'device_invalid'
          : input.errorCode && ERROR_CODE_PATTERN.test(input.errorCode)
            ? input.errorCode
            : 'delivery_failed',
    };
    this.write(completed);
    return completed;
  }

  snapshot(): ConnectedAgentsDeliveryReceipt[] {
    return this.receipts()
      .sort((left, right) => left.message_id.localeCompare(right.message_id)
        || left.device_id.localeCompare(right.device_id))
      .map(receipt => ({ ...receipt }));
  }
}
