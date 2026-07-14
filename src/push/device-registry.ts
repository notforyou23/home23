import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomBytes as cryptoRandomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import type {
  DeviceRegistration,
  DeviceRegistryFile,
  QueryCredentialRegistration,
  QueryNotificationDeliveryReceipt,
  QueryTerminalState,
} from './types.js';

interface DeviceRegistryOptions {
  now?: () => number | string | Date;
  randomBytes?: (size: number) => Buffer;
  maxDeliveryReceipts?: number;
  maxFileBytes?: number;
}

const DEFAULT_MAX_DELIVERY_RECEIPTS = 4096;
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_DELIVERY_RECEIPT_BYTES = 4 * 1024;

const INSTALLATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/;
const CREDENTIAL_ID_PATTERN = /^qncred_[A-Za-z0-9_-]{32}$/;
const OPERATION_ID_PATTERN = /^brop_[A-Za-z0-9_-]{32}$/;
const ROUTE_ID_PATTERN = /^qroute_[A-Za-z0-9_-]{32}$/;
const ERROR_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/;
const TERMINAL_STATES = new Set<QueryTerminalState>([
  'complete', 'partial', 'failed', 'cancelled', 'interrupted',
]);
const DELIVERY_STATES = new Set(['pending', 'failed', 'delivered']);
const CREDENTIAL_KEYS = new Set([
  'installation_id',
  'requester_agent',
  'credential_id',
  'credential_generation',
  'enrolled_at',
  'updated_at',
  'revoked_at',
]);

function registryError(message: string, cause?: unknown): Error & { code: string } {
  const error = new Error(message, cause === undefined ? undefined : { cause }) as Error & { code: string };
  error.code = 'device_registry_corrupt';
  return error;
}

function registryCapacityError(): Error & { code: string } {
  const error = new Error('device_registry_capacity_exceeded') as Error & { code: string };
  error.code = 'device_registry_capacity_exceeded';
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

function validateLegacyDevice(value: unknown): asserts value is DeviceRegistration {
  if (!isPlainObject(value)
      || typeof value.device_token !== 'string'
      || !Array.isArray(value.chat_ids)
      || !value.chat_ids.every(chatId => typeof chatId === 'string')
      || !isCanonicalIso(value.registered_at)
      || !isCanonicalIso(value.last_seen_at)
      || typeof value.bundle_id !== 'string'
      || (value.env !== 'sandbox' && value.env !== 'production')
      || (value.installation_id !== undefined
        && (typeof value.installation_id !== 'string'
          || !INSTALLATION_ID_PATTERN.test(value.installation_id)))
      || (value.query_notifications !== undefined
        && typeof value.query_notifications !== 'boolean')
      || (value.query_notifications === true && value.installation_id === undefined)) {
    throw registryError('device_registry_corrupt');
  }
}

function validateCredential(value: unknown): asserts value is QueryCredentialRegistration {
  if (!isPlainObject(value)
      || Object.keys(value).length !== CREDENTIAL_KEYS.size
      || Object.keys(value).some(key => !CREDENTIAL_KEYS.has(key))
      || typeof value.installation_id !== 'string'
      || !INSTALLATION_ID_PATTERN.test(value.installation_id)
      || typeof value.requester_agent !== 'string'
      || !AGENT_ID_PATTERN.test(value.requester_agent)
      || typeof value.credential_id !== 'string'
      || !CREDENTIAL_ID_PATTERN.test(value.credential_id)
      || !Number.isSafeInteger(value.credential_generation)
      || Number(value.credential_generation) < 1
      || !isCanonicalIso(value.enrolled_at)
      || !isCanonicalIso(value.updated_at)
      || (value.revoked_at !== null && !isCanonicalIso(value.revoked_at))) {
    throw registryError('device_registry_corrupt');
  }
}

function validateDeliveryReceipt(value: unknown): asserts value is QueryNotificationDeliveryReceipt {
  const keys = new Set([
    'route_id', 'operation_id', 'device_id', 'generation', 'terminal_state',
    'state', 'attempts', 'updated_at', 'delivered_at', 'retryable', 'error_code',
  ]);
  if (!isPlainObject(value)
      || Object.keys(value).length !== keys.size
      || Object.keys(value).some(key => !keys.has(key))
      || typeof value.route_id !== 'string' || !ROUTE_ID_PATTERN.test(value.route_id)
      || typeof value.operation_id !== 'string' || !OPERATION_ID_PATTERN.test(value.operation_id)
      || typeof value.device_id !== 'string' || !INSTALLATION_ID_PATTERN.test(value.device_id)
      || !Number.isSafeInteger(value.generation) || Number(value.generation) < 1
      || !TERMINAL_STATES.has(value.terminal_state as QueryTerminalState)
      || !DELIVERY_STATES.has(value.state as string)
      || !Number.isSafeInteger(value.attempts) || Number(value.attempts) < 1
      || !isCanonicalIso(value.updated_at)
      || (value.delivered_at !== null && !isCanonicalIso(value.delivered_at))
      || typeof value.retryable !== 'boolean'
      || (value.error_code !== null
        && (typeof value.error_code !== 'string' || !ERROR_CODE_PATTERN.test(value.error_code)))) {
    throw registryError('device_registry_corrupt');
  }
  if ((value.state === 'delivered') !== (value.delivered_at !== null)
      || (value.state === 'delivered' && (value.retryable || value.error_code !== null))
      || (value.state === 'pending' && (!value.retryable || value.error_code !== null))) {
    throw registryError('device_registry_corrupt');
  }
}

function validateV2(value: unknown): asserts value is DeviceRegistryFile {
  if (!isPlainObject(value)
      || Object.keys(value).length !== 4
      || !Object.hasOwn(value, 'version')
      || !Object.hasOwn(value, 'devices')
      || !Object.hasOwn(value, 'query_credentials')
      || !Object.hasOwn(value, 'query_delivery_receipts')
      || value.version !== 2
      || !Array.isArray(value.devices)
      || !Array.isArray(value.query_credentials)
      || !Array.isArray(value.query_delivery_receipts)) {
    throw registryError('device_registry_corrupt');
  }
  value.devices.forEach(validateLegacyDevice);
  value.query_credentials.forEach(validateCredential);
  value.query_delivery_receipts.forEach(validateDeliveryReceipt);
  const keys = new Set<string>();
  const credentialIds = new Set<string>();
  for (const credential of value.query_credentials) {
    const key = `${credential.requester_agent}\0${credential.installation_id}`;
    if (keys.has(key) || credentialIds.has(credential.credential_id)) {
      throw registryError('device_registry_corrupt');
    }
    keys.add(key);
    credentialIds.add(credential.credential_id);
  }
  const routeKeys = value.query_delivery_receipts.map((receipt) => (
    `${receipt.route_id}\0${receipt.device_id}\0${receipt.generation}`
  ));
  if (new Set(routeKeys).size !== routeKeys.length) throw registryError('device_registry_corrupt');
}

function parseRegistry(raw: string): { file: DeviceRegistryFile; migrated: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw registryError('device_registry_corrupt', cause);
  }
  if (isPlainObject(parsed) && parsed.version === 1
      && Object.keys(parsed).length === 2 && Array.isArray(parsed.devices)) {
    parsed.devices.forEach(validateLegacyDevice);
    return {
      file: {
        version: 2, devices: parsed.devices, query_credentials: [], query_delivery_receipts: [],
      },
      migrated: true,
    };
  }
  if (isPlainObject(parsed) && parsed.version === 2
      && Object.keys(parsed).length === 3
      && Array.isArray(parsed.devices)
      && Array.isArray(parsed.query_credentials)
      && Object.hasOwn(parsed, 'version')
      && Object.hasOwn(parsed, 'devices')
      && Object.hasOwn(parsed, 'query_credentials')) {
    parsed.devices.forEach(validateLegacyDevice);
    parsed.query_credentials.forEach(validateCredential);
    return {
      file: {
        version: 2,
        devices: parsed.devices,
        query_credentials: parsed.query_credentials,
        query_delivery_receipts: [],
      },
      migrated: true,
    };
  }
  validateV2(parsed);
  return { file: parsed, migrated: false };
}

/**
 * Per-agent device registry backed by a single JSON file.
 * Safe for single-process access (harness is one process per agent).
 */
export class DeviceRegistry {
  private readonly now: () => number | string | Date;
  private readonly randomBytes: (size: number) => Buffer;
  private readonly maxDeliveryReceipts: number;
  private readonly maxFileBytes: number;
  private deliveryReceiptCount: number | undefined;

  constructor(private filePath: string, options: DeviceRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.randomBytes = options.randomBytes ?? cryptoRandomBytes;
    this.maxDeliveryReceipts = options.maxDeliveryReceipts ?? DEFAULT_MAX_DELIVERY_RECEIPTS;
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    if (!Number.isSafeInteger(this.maxDeliveryReceipts)
        || this.maxDeliveryReceipts < 1
        || this.maxDeliveryReceipts > DEFAULT_MAX_DELIVERY_RECEIPTS
        || !Number.isSafeInteger(this.maxFileBytes)
        || this.maxFileBytes < 1024
        || this.maxFileBytes > DEFAULT_MAX_FILE_BYTES) {
      throw registryError('device_registry_corrupt');
    }
  }

  private load(): DeviceRegistryFile {
    if (!existsSync(this.filePath)) return {
      version: 2, devices: [], query_credentials: [], query_delivery_receipts: [],
    };
    let raw: string;
    try {
      const stat = lstatSync(this.filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > this.maxFileBytes) {
        throw registryError('device_registry_corrupt');
      }
      raw = readFileSync(this.filePath, 'utf8');
    } catch (cause) {
      throw registryError('device_registry_corrupt', cause);
    }
    const parsed = parseRegistry(raw);
    if (parsed.file.query_delivery_receipts.length > this.maxDeliveryReceipts) {
      throw registryError('device_registry_corrupt');
    }
    if (parsed.file.query_delivery_receipts.length > 0) {
      const newReceiptPaths = new Set(parsed.file.query_delivery_receipts.map((receipt) => (
        this.deliveryReceiptPath(receipt.route_id, receipt.device_id, receipt.generation)
      )));
      const additions = [...newReceiptPaths].filter(filePath => !existsSync(filePath)).length;
      if (this.countDeliveryReceipts() + additions > this.maxDeliveryReceipts) {
        throw registryError('device_registry_corrupt');
      }
      for (const receipt of parsed.file.query_delivery_receipts) {
        this.writeDeliveryReceipt(receipt);
      }
      parsed.file.query_delivery_receipts = [];
      this.save(parsed.file);
    } else if (parsed.migrated) {
      this.save(parsed.file);
    }
    return parsed.file;
  }

  private deliveryReceiptDirectory(): string {
    return `${this.filePath}.query-delivery-receipts`;
  }

  private deliveryReceiptPath(routeId: string, deviceId: string, generation: number): string {
    const key = createHash('sha256')
      .update(routeId).update('\0').update(deviceId).update('\0').update(String(generation))
      .digest('hex');
    return join(this.deliveryReceiptDirectory(), `${key}.json`);
  }

  private verifyDeliveryReceiptDirectory(create = false): boolean {
    const directory = this.deliveryReceiptDirectory();
    if (!existsSync(directory)) {
      if (!create) return false;
      mkdirSync(directory, { recursive: false, mode: 0o700 });
    }
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw registryError('device_registry_corrupt');
    return true;
  }

  private readDeliveryReceipt(
    routeId: string,
    deviceId: string,
    generation: number,
  ): QueryNotificationDeliveryReceipt | null {
    if (!this.verifyDeliveryReceiptDirectory(false)) return null;
    const filePath = this.deliveryReceiptPath(routeId, deviceId, generation);
    if (!existsSync(filePath)) return null;
    try {
      const stat = lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_DELIVERY_RECEIPT_BYTES) {
        throw registryError('device_registry_corrupt');
      }
      const receipt = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
      validateDeliveryReceipt(receipt);
      return { ...receipt };
    } catch (cause) {
      if ((cause as { code?: string }).code === 'device_registry_corrupt') throw cause;
      throw registryError('device_registry_corrupt', cause);
    }
  }

  private loadDeliveryReceipts(): QueryNotificationDeliveryReceipt[] {
    const directory = this.deliveryReceiptDirectory();
    if (!existsSync(directory)) return [];
    try {
      this.countDeliveryReceipts();
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw registryError('device_registry_corrupt');
      const names = readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
      if (names.length > this.maxDeliveryReceipts) throw registryError('device_registry_corrupt');
      const receipts = names.map((name) => {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) throw registryError('device_registry_corrupt');
        const filePath = join(directory, name);
        const fileStat = lstatSync(filePath);
        if (!fileStat.isFile() || fileStat.isSymbolicLink()
            || fileStat.size > MAX_DELIVERY_RECEIPT_BYTES) {
          throw registryError('device_registry_corrupt');
        }
        const receipt = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
        validateDeliveryReceipt(receipt);
        if (this.deliveryReceiptPath(
          receipt.route_id, receipt.device_id, receipt.generation,
        ) !== filePath) throw registryError('device_registry_corrupt');
        return { ...receipt };
      });
      return receipts;
    } catch (cause) {
      if ((cause as { code?: string }).code === 'device_registry_corrupt') throw cause;
      throw registryError('device_registry_corrupt', cause);
    }
  }

  private countDeliveryReceipts(): number {
    if (this.deliveryReceiptCount !== undefined) return this.deliveryReceiptCount;
    const directory = this.deliveryReceiptDirectory();
    if (!existsSync(directory)) {
      this.deliveryReceiptCount = 0;
      return 0;
    }
    try {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw registryError('device_registry_corrupt');
      const names = readdirSync(directory);
      if (names.length > this.maxDeliveryReceipts * 2) throw registryError('device_registry_corrupt');
      let count = 0;
      for (const name of names) {
        if (/^[a-f0-9]{64}\.json$/.test(name)) {
          count += 1;
          continue;
        }
        if (/^\.[a-f0-9]{64}\.json\.\d+\.[a-f0-9]{16}\.tmp$/.test(name)) {
          const temporary = join(directory, name);
          const temporaryStat = lstatSync(temporary);
          if (!temporaryStat.isFile() || temporaryStat.isSymbolicLink()
              || temporaryStat.size > MAX_DELIVERY_RECEIPT_BYTES) {
            throw registryError('device_registry_corrupt');
          }
          unlinkSync(temporary);
          continue;
        }
        throw registryError('device_registry_corrupt');
      }
      if (count > this.maxDeliveryReceipts) throw registryError('device_registry_corrupt');
      this.deliveryReceiptCount = count;
      return count;
    } catch (cause) {
      if ((cause as { code?: string }).code === 'device_registry_corrupt') throw cause;
      throw registryError('device_registry_corrupt', cause);
    }
  }

  private writeDeliveryReceipt(receipt: QueryNotificationDeliveryReceipt): void {
    validateDeliveryReceipt(receipt);
    const directory = this.deliveryReceiptDirectory();
    this.verifyDeliveryReceiptDirectory(true);
    const filePath = this.deliveryReceiptPath(
      receipt.route_id, receipt.device_id, receipt.generation,
    );
    const existed = existsSync(filePath);
    const bytes = `${JSON.stringify(receipt)}\n`;
    if (Buffer.byteLength(bytes) > MAX_DELIVERY_RECEIPT_BYTES) throw registryCapacityError();
    const temporary = join(directory,
      `.${basename(filePath)}.${process.pid}.${cryptoRandomBytes(8).toString('hex')}.tmp`);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, 'wx', 0o600);
      writeFileSync(descriptor, bytes, 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, filePath);
      chmodSync(filePath, 0o600);
      if (!existed && this.deliveryReceiptCount !== undefined) this.deliveryReceiptCount += 1;
      const directoryDescriptor = openSync(directory, 'r');
      try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
    } catch (cause) {
      throw registryError('device_registry_corrupt', cause);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }

  private removeDeliveryReceipt(receipt: QueryNotificationDeliveryReceipt): void {
    if (!this.verifyDeliveryReceiptDirectory(false)) return;
    const filePath = this.deliveryReceiptPath(
      receipt.route_id, receipt.device_id, receipt.generation,
    );
    if (existsSync(filePath)) unlinkSync(filePath);
    if (this.deliveryReceiptCount !== undefined && this.deliveryReceiptCount > 0) {
      this.deliveryReceiptCount -= 1;
    }
    const directory = this.deliveryReceiptDirectory();
    if (existsSync(directory) && readdirSync(directory).length === 0) rmdirSync(directory);
  }

  private save(file: DeviceRegistryFile): void {
    validateV2(file);
    const directory = dirname(this.filePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const bytes = `${JSON.stringify(file, null, 2)}\n`;
    if (Buffer.byteLength(bytes, 'utf8') > this.maxFileBytes) {
      throw registryCapacityError();
    }
    let temporary = '';
    let descriptor: number | undefined;
    try {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        temporary = join(directory,
          `.${basename(this.filePath)}.${process.pid}.${cryptoRandomBytes(8).toString('hex')}.tmp`);
        try {
          descriptor = openSync(temporary, 'wx', 0o600);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
      if (descriptor === undefined) throw new Error('temporary registry path unavailable');
      writeFileSync(descriptor, bytes, 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      parseRegistry(readFileSync(temporary, 'utf8'));
      renameSync(temporary, this.filePath);
      temporary = '';
      chmodSync(this.filePath, 0o600);
      const directoryDescriptor = openSync(directory, 'r');
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
      const readback = parseRegistry(readFileSync(this.filePath, 'utf8'));
      if (readback.migrated) throw new Error('registry writeback did not persist v2');
    } catch (cause) {
      if (['device_registry_corrupt', 'device_registry_capacity_exceeded']
        .includes((cause as { code?: string }).code ?? '')) throw cause;
      throw registryError('device_registry_corrupt', cause);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (temporary && existsSync(temporary)) unlinkSync(temporary);
    }
  }

  private timestamp(): string {
    const raw = this.now();
    const milliseconds = raw instanceof Date ? raw.getTime()
      : typeof raw === 'string' ? Date.parse(raw) : raw;
    if (!Number.isFinite(milliseconds)) throw registryError('device_registry_corrupt');
    return new Date(Number(milliseconds)).toISOString();
  }

  private nextGeneration(current: number): number {
    const next = current + 1;
    if (!Number.isSafeInteger(next)) throw registryError('device_registry_corrupt');
    return next;
  }

  private validateEnrollmentInput(installationId: string, requesterAgent: string): void {
    if (!INSTALLATION_ID_PATTERN.test(installationId)
        || !AGENT_ID_PATTERN.test(requesterAgent)) {
      throw registryError('device_registry_corrupt');
    }
  }

  /** Register or update a device. Dedupes by (device_token, bundle_id). Adds any new chat_ids to the existing subscription. */
  register(input: {
    device_token: string;
    bundle_id: string;
    env: 'sandbox' | 'production';
    chat_ids: string[];
    agent_id?: string;
    platform?: string;
    app_build?: string | number;
    contract_version?: string;
    capabilities_hash?: string;
    installation_id?: string;
    query_notifications?: boolean;
  }): DeviceRegistration {
    if (input.installation_id !== undefined
        && !INSTALLATION_ID_PATTERN.test(input.installation_id)) {
      throw registryError('device_registry_corrupt');
    }
    if (input.query_notifications === true && input.installation_id === undefined) {
      throw registryError('device_registry_corrupt');
    }
    const file = this.load();
    const now = new Date().toISOString();
    const key = `${input.bundle_id}::${input.device_token}`;
    const idx = file.devices.findIndex(d => `${d.bundle_id}::${d.device_token}` === key);
    if (input.query_notifications === true && input.installation_id) {
      for (let position = 0; position < file.devices.length; position += 1) {
        if (position === idx) continue;
        const device = file.devices[position]!;
        if (device.agent_id === input.agent_id
            && device.installation_id === input.installation_id
            && device.query_notifications === true) {
          file.devices[position] = { ...device, query_notifications: false };
        }
      }
    }
    if (idx >= 0) {
      const existing = file.devices[idx]!;
      const mergedChats = Array.from(new Set([...existing.chat_ids, ...input.chat_ids]));
      const updated: DeviceRegistration = {
        ...existing,
        chat_ids: mergedChats,
        last_seen_at: now,
        env: input.env,
        agent_id: input.agent_id ?? existing.agent_id,
        platform: input.platform ?? existing.platform,
        app_build: input.app_build ?? existing.app_build,
        contract_version: input.contract_version ?? existing.contract_version,
        capabilities_hash: input.capabilities_hash ?? existing.capabilities_hash,
        installation_id: input.installation_id ?? existing.installation_id,
        query_notifications: input.query_notifications ?? existing.query_notifications,
      };
      file.devices[idx] = updated;
      this.save(file);
      return updated;
    }
    const fresh: DeviceRegistration = {
      device_token: input.device_token,
      chat_ids: input.chat_ids,
      registered_at: now,
      last_seen_at: now,
      bundle_id: input.bundle_id,
      env: input.env,
      agent_id: input.agent_id,
      platform: input.platform,
      app_build: input.app_build,
      contract_version: input.contract_version,
      capabilities_hash: input.capabilities_hash,
      installation_id: input.installation_id,
      query_notifications: input.query_notifications,
    };
    file.devices.push(fresh);
    this.save(file);
    return fresh;
  }

  /** Remove a device entirely (all chat_id subscriptions). */
  unregister(deviceToken: string, bundleId: string): boolean {
    const file = this.load();
    const before = file.devices.length;
    file.devices = file.devices.filter(d => !(d.device_token === deviceToken && d.bundle_id === bundleId));
    if (file.devices.length !== before) {
      this.save(file);
      return true;
    }
    return false;
  }

  /** Remove selected chat_id subscriptions. Removes the device if no subscriptions remain. */
  unregisterChats(deviceToken: string, bundleId: string, chatIds: string[]): {
    found: boolean;
    device_removed: boolean;
    removed_chat_ids: string[];
    remaining_chat_ids: string[];
    updated_at: string | null;
  } {
    const file = this.load();
    const key = `${bundleId}::${deviceToken}`;
    const idx = file.devices.findIndex(d => `${d.bundle_id}::${d.device_token}` === key);
    if (idx < 0) {
      return {
        found: false,
        device_removed: false,
        removed_chat_ids: [],
        remaining_chat_ids: [],
        updated_at: null,
      };
    }

    const existing = file.devices[idx]!;
    const removeSet = new Set(chatIds);
    const removed_chat_ids = existing.chat_ids.filter(chatId => removeSet.has(chatId));
    const remaining_chat_ids = existing.chat_ids.filter(chatId => !removeSet.has(chatId));
    const updated_at = new Date().toISOString();

    if (remaining_chat_ids.length === 0 && existing.query_notifications !== true) {
      file.devices.splice(idx, 1);
      this.save(file);
      return {
        found: true,
        device_removed: true,
        removed_chat_ids,
        remaining_chat_ids,
        updated_at,
      };
    }

    file.devices[idx] = {
      ...existing,
      chat_ids: remaining_chat_ids,
      last_seen_at: updated_at,
    };
    this.save(file);
    return {
      found: true,
      device_removed: false,
      removed_chat_ids,
      remaining_chat_ids,
      updated_at,
    };
  }

  /** Devices subscribed to a chat_id. */
  lookupByChatId(chatId: string): DeviceRegistration[] {
    return this.load().devices.filter(d => d.chat_ids.includes(chatId));
  }

  /** Exact capable APNs devices for explicitly subscribed installation IDs. */
  lookupQueryNotificationDevices(
    installationIds: string[],
    requesterAgent: string,
  ): DeviceRegistration[] {
    const accepted = new Set(installationIds);
    return this.load().devices.filter((device) => (
      device.query_notifications === true
      && typeof device.installation_id === 'string'
      && accepted.has(device.installation_id)
      && device.agent_id === requesterAgent
    ));
  }

  /** Mark a device token invalid — remove it (APNs 410 Gone response). */
  invalidate(deviceToken: string, bundleId: string): void {
    this.unregister(deviceToken, bundleId);
  }

  list(): DeviceRegistration[] {
    return this.load().devices;
  }

  enrollQueryCredential(input: {
    installationId: string;
    requesterAgent: string;
  }): QueryCredentialRegistration {
    this.validateEnrollmentInput(input.installationId, input.requesterAgent);
    const file = this.load();
    const existing = file.query_credentials.find(credential => (
      credential.installation_id === input.installationId
      && credential.requester_agent === input.requesterAgent
    ));
    const now = this.timestamp();
    if (existing) {
      existing.credential_generation = this.nextGeneration(existing.credential_generation);
      existing.updated_at = now;
      existing.revoked_at = null;
      this.save(file);
      return { ...existing };
    }
    const credential: QueryCredentialRegistration = {
      installation_id: input.installationId,
      requester_agent: input.requesterAgent,
      credential_id: `qncred_${this.randomBytes(24).toString('base64url')}`,
      credential_generation: 1,
      enrolled_at: now,
      updated_at: now,
      revoked_at: null,
    };
    validateCredential(credential);
    file.query_credentials.push(credential);
    this.save(file);
    return { ...credential };
  }

  revokeQueryCredential(
    installationId: string,
    requesterAgent?: string,
  ): QueryCredentialRegistration | null {
    const file = this.load();
    const existing = file.query_credentials.find(credential => (
      credential.installation_id === installationId
      && (requesterAgent === undefined || credential.requester_agent === requesterAgent)
    ));
    if (!existing) return null;
    const now = this.timestamp();
    existing.credential_generation = this.nextGeneration(existing.credential_generation);
    existing.updated_at = now;
    existing.revoked_at = now;
    this.save(file);
    return { ...existing };
  }

  getQueryCredential(
    installationId: string,
    requesterAgent?: string,
  ): QueryCredentialRegistration | null {
    const existing = this.load().query_credentials.find(credential => (
      credential.installation_id === installationId
      && (requesterAgent === undefined || credential.requester_agent === requesterAgent)
    ));
    return existing ? { ...existing } : null;
  }

  getQueryCredentialByCredentialId(
    credentialId: string,
    requesterAgent?: string,
  ): QueryCredentialRegistration | null {
    const existing = this.load().query_credentials.find(credential => (
      credential.credential_id === credentialId
      && (requesterAgent === undefined || credential.requester_agent === requesterAgent)
    ));
    return existing ? { ...existing } : null;
  }

  queryCredentialSnapshot(): QueryCredentialRegistration[] {
    return this.load().query_credentials.map(credential => ({ ...credential }));
  }

  beginQueryNotificationDelivery(input: {
    routeId: string;
    operationId: string;
    deviceId: string;
    generation: number;
    terminalState: QueryTerminalState;
  }): QueryNotificationDeliveryReceipt {
    if (!ROUTE_ID_PATTERN.test(input.routeId)
        || !OPERATION_ID_PATTERN.test(input.operationId)
        || !INSTALLATION_ID_PATTERN.test(input.deviceId)
        || !Number.isSafeInteger(input.generation) || input.generation < 1
        || !TERMINAL_STATES.has(input.terminalState)) {
      throw registryError('device_registry_corrupt');
    }
    this.load();
    const existing = this.readDeliveryReceipt(input.routeId, input.deviceId, input.generation);
    if (existing) {
      if (existing.operation_id !== input.operationId
          || existing.terminal_state !== input.terminalState) {
        throw registryError('device_registry_corrupt');
      }
      if (existing.state === 'delivered'
          || (existing.state === 'failed' && existing.retryable === false)) {
        return { ...existing };
      }
      existing.state = 'pending';
      existing.attempts = this.nextGeneration(existing.attempts);
      existing.updated_at = this.timestamp();
      existing.delivered_at = null;
      existing.retryable = true;
      existing.error_code = null;
      this.writeDeliveryReceipt(existing);
      return { ...existing };
    }
    if (this.countDeliveryReceipts() >= this.maxDeliveryReceipts) {
      const receipts = this.loadDeliveryReceipts();
      const removable = receipts
        .map((receipt, index) => ({ receipt, index }))
        .filter(({ receipt }) => receipt.state === 'delivered'
          || (receipt.state === 'failed' && receipt.retryable === false))
        .sort((left, right) => Date.parse(left.receipt.updated_at)
          - Date.parse(right.receipt.updated_at))[0];
      if (!removable) throw registryCapacityError();
      this.removeDeliveryReceipt(removable.receipt);
    }
    const receipt: QueryNotificationDeliveryReceipt = {
      route_id: input.routeId,
      operation_id: input.operationId,
      device_id: input.deviceId,
      generation: input.generation,
      terminal_state: input.terminalState,
      state: 'pending',
      attempts: 1,
      updated_at: this.timestamp(),
      delivered_at: null,
      retryable: true,
      error_code: null,
    };
    this.writeDeliveryReceipt(receipt);
    return { ...receipt };
  }

  finishQueryNotificationDelivery(input: {
    routeId: string;
    deviceId: string;
    generation: number;
    state: 'failed' | 'delivered';
    retryable?: boolean;
    errorCode?: string | null;
  }): QueryNotificationDeliveryReceipt {
    this.load();
    const receipt = this.readDeliveryReceipt(input.routeId, input.deviceId, input.generation);
    if (!receipt) throw registryError('device_registry_corrupt');
    if (receipt.state === 'delivered') return { ...receipt };
    const now = this.timestamp();
    receipt.state = input.state;
    receipt.updated_at = now;
    receipt.delivered_at = input.state === 'delivered' ? now : null;
    receipt.retryable = input.state === 'failed' ? input.retryable !== false : false;
    receipt.error_code = input.state === 'failed'
      ? (input.errorCode && ERROR_CODE_PATTERN.test(input.errorCode)
        ? input.errorCode : 'delivery_failed')
      : null;
    this.writeDeliveryReceipt(receipt);
    return { ...receipt };
  }

  queryNotificationReceiptSnapshot(): QueryNotificationDeliveryReceipt[] {
    this.load();
    return this.loadDeliveryReceipts()
      .sort((left, right) => left.route_id.localeCompare(right.route_id))
      .map((receipt) => ({ ...receipt }));
  }
}
