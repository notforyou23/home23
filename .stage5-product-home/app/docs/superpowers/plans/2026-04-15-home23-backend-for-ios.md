# Home23 Backend for iOS App — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the four backend pieces Home23 needs before the iOS app can function — history endpoint, device registry + register/unregister endpoints, APNs pusher, and a turn-completion hook that fires push notifications.

**Architecture:** Device tokens stored as JSON per-agent in `instances/<agent>/brain/device-registry.json`. APNs provider uses the account-level `.p8` key + JWT auth, HTTP/2 direct to Apple. Turn-completion hook wraps the existing `runWithTurn` final envelope write — fire-and-forget push with first 100 chars of the assistant response. All additions are in the Node/TS bridge process; no changes to the cognitive engine.

**Tech Stack:** TypeScript, Node 20, Express (existing), `http2` (Node built-in), `jsonwebtoken` (for APNs JWT). No new runtime deps if we use Node's built-in `http2`.

**Codebase context for the engineer:**
- `src/routes/chat-turn.ts` — added in the resumable-chat plan; where new HTTP handlers live.
- `src/agent/loop.ts` — `AgentLoop.runWithTurn(chatId, message, opts?)` returns `{ turnId, response }`. The `response` promise resolves when the turn completes; its resolution site is where push fires.
- `src/home.ts` — where bridge routes get registered (around lines 642-660).
- `src/agent/history.ts` — `ConversationHistory` with `loadRaw(chatId)` method.
- `config/secrets.yaml` — gitignored; APNs keys go here.
- No unit test runner; verification = `npm run build` (tsc) + PM2 restart + curl + real device token captured from iOS Xcode console.
- PM2 process: `home23-<agent>-harness` runs the bridge.

---

## File Structure

**Create:**
- `src/push/device-registry.ts` — JSON-backed per-agent device registry. Load, register, unregister, lookupByChatId.
- `src/push/apns-client.ts` — APNs JWT provider token cache + HTTP/2 send. Pure transport.
- `src/push/apns-pusher.ts` — high-level: "send reply notification for this turn." Composes payload, pulls tokens from registry, calls client.
- `src/push/types.ts` — `DeviceRegistration`, `ApnsConfig`, `PushPayload`.
- `src/routes/device.ts` — HTTP handlers: `POST/DELETE /api/device/register`.
- `src/routes/chat-history.ts` — HTTP handler: `GET /api/chat/history`.

**Modify:**
- `src/agent/loop.ts` — inside `runWithTurn`, after the `complete` envelope write, invoke the APNs pusher (fire-and-forget).
- `src/home.ts` — register device + history routes. Load APNs config from secrets.
- `src/types.ts` (or wherever config types live) — add `apns` block to config type.
- `config/secrets.yaml` — document APNs keys (the example entry, gitignored content).
- `package.json` — add `jsonwebtoken` (+ its types) as a dependency.

**Leave untouched:**
- `engine/` — no changes. Push is a harness concern, not a cognitive-loop concern.
- Existing chat endpoints. History is additive, not a replacement.

---

## Task 1: Install jsonwebtoken dependency

**Files:**
- Modify: `package.json`, `package-lock.json`

- [ ] **Step 1: Install the dep**

```bash
npm install jsonwebtoken
npm install --save-dev @types/jsonwebtoken
```

- [ ] **Step 2: Typecheck**

```bash
npm run build
```
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add jsonwebtoken for APNs JWT auth"
```

---

## Task 2: Types for APNs + device registry

**Files:**
- Create: `src/push/types.ts`

- [ ] **Step 1: Write the types**

```typescript
/** Per-device APNs registration. One row per (agent, device_token) pair. */
export interface DeviceRegistration {
  device_token: string;      // APNs hex token from UIApplication.registerForRemoteNotifications
  chat_ids: string[];        // conversations this device is subscribed to
  registered_at: string;     // ISO8601
  last_seen_at: string;      // ISO8601, updated on any register call
  bundle_id: string;         // com.regina6.home23 — allows multiple apps later
  env: 'sandbox' | 'production';  // APNs environment
}

/** In-memory + on-disk registry shape. */
export interface DeviceRegistryFile {
  version: 1;
  devices: DeviceRegistration[];
}

/** APNs auth + routing config, loaded from home23 secrets. */
export interface ApnsConfig {
  team_id: string;           // 10-char Apple Team ID
  key_id: string;            // 10-char .p8 key ID
  key_path: string;          // absolute path to AuthKey_XXXXXXXXXX.p8
  bundle_id: string;         // e.g. com.regina6.home23
  default_env: 'sandbox' | 'production';
}

/** What gets sent to api.push.apple.com. */
export interface PushPayload {
  aps: {
    alert: { title: string; body: string };
    'mutable-content': 1;
    sound: 'default';
  };
  chatId: string;
  turnId: string;
  agent: string;
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run build
```
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/push/types.ts
git commit -m "feat(push): types for device registry + APNs"
```

---

## Task 3: DeviceRegistry — JSON-backed store

**Files:**
- Create: `src/push/device-registry.ts`

- [ ] **Step 1: Write the registry**

```typescript
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DeviceRegistration, DeviceRegistryFile } from './types.js';

/**
 * Per-agent device registry backed by a single JSON file.
 * Safe for single-process access (harness is one process per agent).
 */
export class DeviceRegistry {
  constructor(private filePath: string) {}

  private load(): DeviceRegistryFile {
    if (!existsSync(this.filePath)) return { version: 1, devices: [] };
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed.version !== 1 || !Array.isArray(parsed.devices)) {
        return { version: 1, devices: [] };
      }
      return parsed;
    } catch {
      return { version: 1, devices: [] };
    }
  }

  private save(file: DeviceRegistryFile): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(file, null, 2));
  }

  /** Register or update a device. Dedupes by (device_token, bundle_id). Adds any new chat_ids to the existing subscription. */
  register(input: {
    device_token: string;
    bundle_id: string;
    env: 'sandbox' | 'production';
    chat_ids: string[];
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
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run build
```
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/push/device-registry.ts
git commit -m "feat(push): DeviceRegistry — JSON-backed per-agent store"
```

---

## Task 4: APNs JWT provider token + HTTP/2 client

**Files:**
- Create: `src/push/apns-client.ts`

- [ ] **Step 1: Write the client**

```typescript
import { readFileSync } from 'node:fs';
import { connect, ClientHttp2Session } from 'node:http2';
import jwt from 'jsonwebtoken';
import type { ApnsConfig, PushPayload } from './types.js';

/**
 * Minimal APNs HTTP/2 client. Manages a single HTTP/2 session (reused across sends)
 * and a cached JWT provider token (refreshed every 50 minutes — Apple allows 60 max).
 */
export class ApnsClient {
  private session: ClientHttp2Session | null = null;
  private currentHost: string | null = null;
  private cachedToken: { value: string; issuedAt: number } | null = null;
  private keyPem: string;

  constructor(private config: ApnsConfig) {
    this.keyPem = readFileSync(config.key_path, 'utf8');
  }

  private getProviderToken(): string {
    const now = Math.floor(Date.now() / 1000);
    if (this.cachedToken && (now - this.cachedToken.issuedAt) < 50 * 60) {
      return this.cachedToken.value;
    }
    const token = jwt.sign({ iss: this.config.team_id, iat: now }, this.keyPem, {
      algorithm: 'ES256',
      header: { alg: 'ES256', kid: this.config.key_id } as jwt.JwtHeader,
    });
    this.cachedToken = { value: token, issuedAt: now };
    return token;
  }

  private hostFor(env: 'sandbox' | 'production'): string {
    return env === 'production' ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';
  }

  private async ensureSession(host: string): Promise<ClientHttp2Session> {
    if (this.session && this.currentHost === host && !this.session.closed && !this.session.destroyed) {
      return this.session;
    }
    if (this.session) { try { this.session.close(); } catch {} this.session = null; }
    const s = connect(host);
    this.session = s;
    this.currentHost = host;
    s.on('error', () => { this.session = null; });
    s.on('close', () => { this.session = null; });
    return s;
  }

  /**
   * Send a push. Resolves to the APNs response status.
   * On 410 Gone, caller should invalidate the device token.
   */
  async send(deviceToken: string, payload: PushPayload, env?: 'sandbox' | 'production'): Promise<{ status: number; apnsId?: string; reason?: string }> {
    const targetEnv = env ?? this.config.default_env;
    const host = this.hostFor(targetEnv);
    const session = await this.ensureSession(host);

    return new Promise((resolve, reject) => {
      const body = Buffer.from(JSON.stringify(payload));
      const req = session.request({
        ':method': 'POST',
        ':scheme': 'https',
        ':path': `/3/device/${deviceToken}`,
        ':authority': new URL(host).host,
        'authorization': `bearer ${this.getProviderToken()}`,
        'apns-topic': this.config.bundle_id,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'content-type': 'application/json',
        'content-length': body.length.toString(),
      });

      let status = 0;
      let apnsId: string | undefined;
      const chunks: Buffer[] = [];

      req.on('response', (headers) => {
        status = Number(headers[':status'] ?? 0);
        apnsId = headers['apns-id'] as string | undefined;
      });
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        let reason: string | undefined;
        if (status >= 400 && chunks.length) {
          try { reason = JSON.parse(Buffer.concat(chunks).toString()).reason; } catch {}
        }
        resolve({ status, apnsId, reason });
      });
      req.on('error', reject);

      req.write(body);
      req.end();
    });
  }

  close(): void {
    if (this.session) { try { this.session.close(); } catch {} this.session = null; }
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run build
```
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/push/apns-client.ts
git commit -m "feat(push): ApnsClient — JWT provider token + HTTP/2 send"
```

---

## Task 5: Pusher — high-level push orchestration

**Files:**
- Create: `src/push/apns-pusher.ts`

- [ ] **Step 1: Write the pusher**

```typescript
import type { ApnsClient } from './apns-client.js';
import type { DeviceRegistry } from './device-registry.js';
import type { PushPayload } from './types.js';

export class ApnsPusher {
  constructor(private client: ApnsClient, private registry: DeviceRegistry, private agentName: string) {}

  private preview(text: string): string {
    const stripped = text.replace(/\s+/g, ' ').trim();
    if (stripped.length <= 100) return stripped;
    return stripped.slice(0, 99) + '…';
  }

  /**
   * Fire pushes for a completed turn. Fire-and-forget — never throws.
   * Called by the turn-completion hook.
   */
  async notifyTurnComplete(opts: { chatId: string; turnId: string; assistantText: string }): Promise<void> {
    const devices = this.registry.lookupByChatId(opts.chatId);
    if (devices.length === 0) return;

    const body = this.preview(opts.assistantText);
    if (!body) return; // no visible text, nothing to say

    const payload: PushPayload = {
      aps: {
        alert: { title: this.agentName, body },
        'mutable-content': 1,
        sound: 'default',
      },
      chatId: opts.chatId,
      turnId: opts.turnId,
      agent: this.agentName,
    };

    await Promise.allSettled(devices.map(async (dev) => {
      try {
        const result = await this.client.send(dev.device_token, payload, dev.env);
        if (result.status === 410) {
          console.log(`[push] ${this.agentName}: device ${dev.device_token.slice(0, 8)}… gone (410), invalidating`);
          this.registry.invalidate(dev.device_token, dev.bundle_id);
        } else if (result.status >= 400) {
          console.warn(`[push] ${this.agentName}: ${result.status} ${result.reason ?? ''} for ${dev.device_token.slice(0, 8)}…`);
        }
      } catch (err) {
        console.warn(`[push] ${this.agentName}: send failed for ${dev.device_token.slice(0, 8)}…:`, err instanceof Error ? err.message : err);
      }
    }));
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run build
```
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/push/apns-pusher.ts
git commit -m "feat(push): ApnsPusher — turn completion → push orchestration"
```

---

## Task 6: Wire push into AgentLoop.runWithTurn

**Files:**
- Modify: `src/agent/loop.ts`

- [ ] **Step 1: Add optional pusher field + setter**

Open `src/agent/loop.ts`. At the top of the `AgentLoop` class, add a new private field:

```typescript
private pusher: import('../push/apns-pusher.js').ApnsPusher | null = null;
```

Add a public setter below the constructor:

```typescript
/** Optional: install an APNs pusher to fire notifications on turn completion. */
setPusher(pusher: import('../push/apns-pusher.js').ApnsPusher | null): void {
  this.pusher = pusher;
}
```

- [ ] **Step 2: Fire push on turn completion**

Find the existing `runWithTurn` method (added in the resumable-chat plan). Find the block:

```typescript
const result = await this.run(chatId, userText, opts.media, persistAndFanOut);
const endEnv = this.turnStore.writeEnd(chatId, turnId, 'complete', { last_seq: seq, stop_reason: 'end_turn' });
turnBus.emit(chatId, turnId, endEnv);
turnBus.close(chatId, turnId);
return result;
```

Insert the pusher call AFTER `turnBus.close` and BEFORE `return result`:

```typescript
if (this.pusher) {
  this.pusher.notifyTurnComplete({
    chatId,
    turnId,
    assistantText: result.text ?? '',
  }).catch(err => console.warn('[push] notifyTurnComplete failed:', err));
}
```

Do NOT fire push in the error/abort branches — stopped turns don't need a notification, error turns shouldn't either (user's app can surface the error next time they look).

- [ ] **Step 3: Typecheck**

```bash
npm run build
```
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add src/agent/loop.ts
git commit -m "feat(loop): fire APNs push on turn complete (when pusher installed)"
```

---

## Task 7: Device routes — POST/DELETE /api/device/register

**Files:**
- Create: `src/routes/device.ts`

- [ ] **Step 1: Write the handlers**

```typescript
import type { Request, Response } from 'express';
import type { DeviceRegistry } from '../push/device-registry.js';

export interface DeviceRouteConfig {
  agentName: string;
  registry: DeviceRegistry;
  token?: string;
}

function checkAuth(req: Request, res: Response, token?: string): boolean {
  if (!token) return true;
  const h = req.headers.authorization;
  if (!h || h !== `Bearer ${token}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

/** POST /api/device/register — register a device for push notifications. */
export function createRegisterDeviceHandler(config: DeviceRouteConfig) {
  return (req: Request, res: Response): void => {
    if (!checkAuth(req, res, config.token)) return;

    const { device_token, chat_ids, bundle_id, env } = req.body ?? {};

    if (!device_token || typeof device_token !== 'string' || !/^[0-9a-fA-F]{32,}$/.test(device_token)) {
      res.status(400).json({ error: 'valid device_token (hex) required' }); return;
    }
    if (!Array.isArray(chat_ids) || !chat_ids.every(c => typeof c === 'string')) {
      res.status(400).json({ error: 'chat_ids: string[] required' }); return;
    }
    if (!bundle_id || typeof bundle_id !== 'string') {
      res.status(400).json({ error: 'bundle_id required' }); return;
    }
    if (env !== 'sandbox' && env !== 'production') {
      res.status(400).json({ error: 'env must be sandbox or production' }); return;
    }

    const result = config.registry.register({ device_token, chat_ids, bundle_id, env });
    res.json({ registered: true, device: result });
  };
}

/** DELETE /api/device/register — unregister a device entirely. */
export function createUnregisterDeviceHandler(config: DeviceRouteConfig) {
  return (req: Request, res: Response): void => {
    if (!checkAuth(req, res, config.token)) return;

    const { device_token, bundle_id } = req.body ?? {};
    if (!device_token || !bundle_id) {
      res.status(400).json({ error: 'device_token and bundle_id required' }); return;
    }
    const removed = config.registry.unregister(device_token, bundle_id);
    res.json({ unregistered: removed });
  };
}

/** GET /api/device/registry — diagnostic, returns the full list. */
export function createListDevicesHandler(config: DeviceRouteConfig) {
  return (_req: Request, res: Response): void => {
    res.json({ devices: config.registry.list() });
  };
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run build
```
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/routes/device.ts
git commit -m "feat(routes): device register/unregister/list"
```

---

## Task 8: History route — GET /api/chat/history

**Files:**
- Create: `src/routes/chat-history.ts`

- [ ] **Step 1: Write the handler**

```typescript
import type { Request, Response } from 'express';
import type { ConversationHistory } from '../agent/history.js';

export interface ChatHistoryConfig {
  agentName: string;
  history: ConversationHistory;
  token?: string;
}

function checkAuth(req: Request, res: Response, token?: string): boolean {
  if (!token) return true;
  const h = req.headers.authorization;
  if (!h || h !== `Bearer ${token}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

/**
 * GET /api/chat/history?chatId=X&limit=50
 * Returns ALL records (messages + session boundaries + turn envelopes + events) in order.
 * Client decides what to render. Limit clamps to last N records; default 200, max 1000.
 */
export function createChatHistoryHandler(config: ChatHistoryConfig) {
  return (req: Request, res: Response): void => {
    if (!checkAuth(req, res, config.token)) return;

    const chatId = String(req.query.chatId || '');
    if (!chatId) { res.status(400).json({ error: 'chatId required' }); return; }

    const rawLimit = Number(req.query.limit ?? 200);
    const limit = Math.max(1, Math.min(1000, Number.isFinite(rawLimit) ? rawLimit : 200));

    const records = config.history.loadRaw(chatId);
    const windowed = records.length > limit ? records.slice(-limit) : records;

    res.json({ chatId, count: windowed.length, total: records.length, records: windowed });
  };
}

/**
 * GET /api/chat/conversations
 * Lists all chatIds present in the conversations directory for this agent,
 * with a basic metadata summary (last record ts, record count).
 */
export function createChatListHandler(config: ChatHistoryConfig) {
  return (_req: Request, res: Response): void => {
    if (!checkAuth(_req, res, config.token)) return;

    const chatIds = config.history.listChatIds?.() ?? [];
    // Best-effort metadata — tolerate missing ConversationHistory.listChatIds.
    const summaries = chatIds.map((cid: string) => {
      const recs = config.history.loadRaw(cid);
      const last = recs[recs.length - 1] as { ts?: string; ended_at?: string; started_at?: string } | undefined;
      const lastTs = last?.ts || last?.ended_at || last?.started_at || null;
      return { chatId: cid, count: recs.length, lastTs };
    });

    res.json({ conversations: summaries });
  };
}
```

Note: this references `ConversationHistory.listChatIds()` which may not exist yet. If it doesn't, stub `listChatIds` as returning `[]` in `history.ts`:

Open `src/agent/history.ts`. Add this method to the `ConversationHistory` class (anywhere inside the class body, near `loadRaw`):

```typescript
import { readdirSync } from 'node:fs';

// ... existing class body ...

/** List all chat IDs present in the conversations directory for this namespace. */
listChatIds(): string[] {
  try {
    const dir = dirname(this.filePath('_probe'));
    if (!existsSync(dir)) return [];
    const prefix = `${this.namespace.replace(/[^a-zA-Z0-9_-]/g, '_')}__`;
    return readdirSync(dir)
      .filter(f => f.startsWith(prefix) && f.endsWith('.jsonl'))
      .map(f => f.slice(prefix.length, -'.jsonl'.length));
  } catch {
    return [];
  }
}
```

Ensure `readdirSync` is imported at the top of `history.ts` alongside existing fs imports. Ensure `dirname` is imported from `node:path` (may already be via existing code).

- [ ] **Step 2: Typecheck**

```bash
npm run build
```
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/routes/chat-history.ts src/agent/history.ts
git commit -m "feat(routes): chat history + conversation listing"
```

---

## Task 9: Config loader for APNs secrets

**Files:**
- Modify: `src/types.ts` (or wherever the `AgentConfig`/`HomeConfig` type lives — find via grep)
- Modify: `config/secrets.yaml.example` (create if not exists)

- [ ] **Step 1: Find where home config types live**

Run:
```bash
grep -n "secrets\|apns\|telegram:.*botToken" src/types.ts src/config/*.ts 2>/dev/null | head -20
```

Identify the type that represents the decoded secrets.yaml. It's likely in `src/types.ts` or `src/config/loader.ts`.

- [ ] **Step 2: Add `apns` block to the secrets type**

In the identified file, add to the secrets type (adapt the exact location to the existing shape):

```typescript
apns?: {
  team_id: string;
  key_id: string;
  key_path: string;
  bundle_id: string;
  default_env: 'sandbox' | 'production';
};
```

- [ ] **Step 3: Document in secrets example**

Check if `config/secrets.yaml.example` exists. If yes, add; if no, create:

```yaml
# APNs (Apple Push Notification service) — iOS app integration.
# Leave commented out if you don't run the iOS app.
# apns:
#   team_id: "ABCDE12345"            # 10-char Apple Team ID
#   key_id: "XYZABC9876"             # 10-char .p8 key ID
#   key_path: "/Users/jtr/secrets/AuthKey_XYZABC9876.p8"
#   bundle_id: "com.regina6.home23"
#   default_env: "production"        # TestFlight + App Store use production; local Xcode dev uses sandbox
```

Do NOT touch `config/secrets.yaml` (actual file, gitignored) — user will fill that in by hand.

- [ ] **Step 4: Typecheck**

```bash
npm run build
```
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts config/secrets.yaml.example
git commit -m "feat(config): apns secrets type + example"
```

---

## Task 10: Wire device registry, APNs client, pusher, and routes into src/home.ts

**Files:**
- Modify: `src/home.ts`

- [ ] **Step 1: Add imports**

At the top of `src/home.ts` alongside existing imports:

```typescript
import { DeviceRegistry } from './push/device-registry.js';
import { ApnsClient } from './push/apns-client.js';
import { ApnsPusher } from './push/apns-pusher.js';
import { createRegisterDeviceHandler, createUnregisterDeviceHandler, createListDevicesHandler } from './routes/device.js';
import { createChatHistoryHandler, createChatListHandler } from './routes/chat-history.js';
import { join } from 'node:path';
```

- [ ] **Step 2: Construct registry + pusher (conditional on apns config)**

Find the "Evobrew Bridge" section in `src/home.ts` (around line 627). BEFORE `const bridgeApp = ...`, add:

```typescript
  // ── Push notifications (APNs) — optional ──
  const apnsConfig = (config as any).apns || (secrets as any).apns; // adapt to the real secrets loader name
  let pusher: ApnsPusher | null = null;
  const registryPath = join(process.env.COSMO_RUNTIME_DIR ?? '', 'device-registry.json');
  const registry = new DeviceRegistry(registryPath);

  if (apnsConfig && apnsConfig.team_id && apnsConfig.key_id && apnsConfig.key_path && apnsConfig.bundle_id) {
    try {
      const apnsClient = new ApnsClient({
        team_id: apnsConfig.team_id,
        key_id: apnsConfig.key_id,
        key_path: apnsConfig.key_path,
        bundle_id: apnsConfig.bundle_id,
        default_env: apnsConfig.default_env ?? 'production',
      });
      pusher = new ApnsPusher(apnsClient, registry, AGENT_NAME);
      agent.setPusher(pusher);
      console.log(`[home] APNs pusher installed — bundle=${apnsConfig.bundle_id}, env=${apnsConfig.default_env ?? 'production'}`);
    } catch (err) {
      console.warn('[home] APNs pusher init failed:', err instanceof Error ? err.message : err);
    }
  } else {
    console.log('[home] APNs pusher not configured — push disabled');
  }
```

**Important:** the `(config as any).apns || (secrets as any).apns` line is a placeholder — adapt to the actual names your config loader exposes (likely `config.secrets.apns` or similar). Before coding, grep for how other secret-derived values (like telegram bot tokens) are accessed and follow the same pattern.

- [ ] **Step 3: Register device + history routes**

In the bridge-routes block (around line 642-653, right after the existing chat-turn routes from the resumable-chat plan), add:

```typescript
  // Device registration routes (iOS push)
  const deviceConfig = { agentName: AGENT_NAME, registry, token: bridgeToken || undefined };
  bridgeApp.post('/api/device/register', createRegisterDeviceHandler(deviceConfig));
  bridgeApp.delete('/api/device/register', createUnregisterDeviceHandler(deviceConfig));
  bridgeApp.get('/api/device/registry', createListDevicesHandler(deviceConfig));

  // Chat history routes (iOS initial load + conversation list)
  const historyRouteConfig = { agentName: AGENT_NAME, history, token: bridgeToken || undefined };
  bridgeApp.get('/api/chat/history', createChatHistoryHandler(historyRouteConfig));
  bridgeApp.get('/api/chat/conversations', createChatListHandler(historyRouteConfig));
```

Update the listen log:

```typescript
    console.log(`[home] Evobrew bridge listening on port ${BRIDGE_PORT} (/api/chat, /api/stop, /api/chat/turn, /api/chat/stream, /api/chat/pending, /api/chat/stop-turn, /api/chat/history, /api/chat/conversations, /api/device/register, /api/device/registry, /health)`);
```

- [ ] **Step 4: Typecheck**

```bash
npm run build
```
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/home.ts
git commit -m "feat(bridge): wire push + device + history routes"
```

---

## Task 11: End-to-end verification (no real device yet)

- [ ] **Step 1: Restart harness**

```bash
pm2 restart home23-jerry-harness
pm2 logs home23-jerry-harness --lines 30 --nostream
```

Expected log lines:
- `[home] APNs pusher not configured — push disabled` (since you haven't added keys yet)
- `[home] Evobrew bridge listening on port 5004 (...including /api/device/register, /api/chat/history...)`

- [ ] **Step 2: Test device register (with a fake hex token)**

```bash
curl -sX POST http://localhost:5004/api/device/register \
  -H 'Content-Type: application/json' \
  -d '{"device_token":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","chat_ids":["ios:test:jerry:001"],"bundle_id":"com.regina6.home23","env":"sandbox"}'
```

Expected: `{"registered":true,"device":{...}}`

- [ ] **Step 3: Verify registry on disk**

```bash
cat instances/jerry/brain/device-registry.json 2>/dev/null || find instances/jerry -name 'device-registry.json'
```

Expected: JSON with the one device you registered.

- [ ] **Step 4: Test history endpoint**

```bash
curl -s 'http://localhost:5004/api/chat/history?chatId=smoke-test-turn-001&limit=10' | head -50
```

Expected: JSON with the turn + event + message records from the earlier smoke test.

- [ ] **Step 5: Test conversation list**

```bash
curl -s http://localhost:5004/api/chat/conversations | head -50
```

Expected: `{"conversations":[{"chatId":"...","count":N,"lastTs":"..."},...]}`

- [ ] **Step 6: Test unregister**

```bash
curl -sX DELETE http://localhost:5004/api/device/register \
  -H 'Content-Type: application/json' \
  -d '{"device_token":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","bundle_id":"com.regina6.home23"}'
```

Expected: `{"unregistered":true}`. Re-check registry.json — should be empty.

- [ ] **Step 7: (Deferred) APNs live test**

This requires a real device token from the iOS app, which doesn't exist yet. Deferred to the iOS plan's push task. Add a note in your session log: "APNs live send untested; will verify during iOS plan Task 17."

- [ ] **Step 8: No final commit needed** — verification only.

---

## Spec coverage self-check

Spec section | Task(s)
--- | ---
`/api/chat/history` | Task 8
`/api/device/register` POST/DELETE | Task 7, Task 10
APNs pusher module | Tasks 4, 5, 10
Turn completion hook | Task 6
Config for APNs secrets | Task 9
Device registry storage | Task 3
Backend works without APNs configured (graceful disable) | Task 10 (conditional init)

All covered. Ships independently of the iOS app.

---

## What's deferred to the iOS plan

- Real APNs send verification (needs a real device token)
- Any UI for the device registry (not needed — diagnostic endpoint is enough)
- TestFlight provisioning, bundle ID registration with Push capability (Apple Developer portal, manual)
- The `.p8` key file — user downloads from Apple Developer portal and puts at `apns.key_path`
