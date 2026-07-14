import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes as cryptoRandomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import type {
  DeviceRegistration,
  DeviceRegistryFile,
  QueryCredentialRegistration,
} from './types.js';

interface DeviceRegistryOptions {
  now?: () => number | string | Date;
  randomBytes?: (size: number) => Buffer;
}

const INSTALLATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/;
const CREDENTIAL_ID_PATTERN = /^qncred_[A-Za-z0-9_-]{32}$/;
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
      || (value.env !== 'sandbox' && value.env !== 'production')) {
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

function validateV2(value: unknown): asserts value is DeviceRegistryFile {
  if (!isPlainObject(value)
      || Object.keys(value).length !== 3
      || !Object.hasOwn(value, 'version')
      || !Object.hasOwn(value, 'devices')
      || !Object.hasOwn(value, 'query_credentials')
      || value.version !== 2
      || !Array.isArray(value.devices)
      || !Array.isArray(value.query_credentials)) {
    throw registryError('device_registry_corrupt');
  }
  value.devices.forEach(validateLegacyDevice);
  value.query_credentials.forEach(validateCredential);
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
      file: { version: 2, devices: parsed.devices, query_credentials: [] },
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

  constructor(private filePath: string, options: DeviceRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.randomBytes = options.randomBytes ?? cryptoRandomBytes;
  }

  private load(): DeviceRegistryFile {
    if (!existsSync(this.filePath)) return { version: 2, devices: [], query_credentials: [] };
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch (cause) {
      throw registryError('device_registry_corrupt', cause);
    }
    const parsed = parseRegistry(raw);
    if (parsed.migrated) {
      this.save(parsed.file);
    }
    return parsed.file;
  }

  private save(file: DeviceRegistryFile): void {
    validateV2(file);
    const directory = dirname(this.filePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const bytes = `${JSON.stringify(file, null, 2)}\n`;
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
      if ((cause as { code?: string }).code === 'device_registry_corrupt') throw cause;
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
  }): DeviceRegistration {
    const file = this.load();
    const now = new Date().toISOString();
    const key = `${input.bundle_id}::${input.device_token}`;
    const idx = file.devices.findIndex(d => `${d.bundle_id}::${d.device_token}` === key);
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

    if (remaining_chat_ids.length === 0) {
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
}
