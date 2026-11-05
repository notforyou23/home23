# Dashboard Chat — Image Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users attach images to messages sent through the dashboard chat (tile + standalone `/home23/chat` page) via paperclip, paste, or drag-drop, so vision-capable models can work with them.

**Architecture:** Three layers: (1) bridge route extension to accept base64 images, write them to `instances/<agent>/uploads/chat/`, and pass paths via the existing `media` parameter on `runWithTurn`; (2) shared HTML/CSS markup additions to both the dashboard chat tile and the standalone chat page (both use `id="chat-input"` / `id="chat-send-btn"`); (3) JavaScript in `home23-chat.js` for pending-attachments state, paste/drop/picker handlers, base64 conversion on send, and inline thumbnail rendering in user bubbles. The agent loop, history persistence, and provider routing already handle image content blocks — no engine changes.

**Tech Stack:** TypeScript (`src/routes/chat-turn.ts`, `src/home.ts`), vanilla JavaScript (`engine/src/dashboard/home23-chat.js`), HTML (`engine/src/dashboard/home23-chat.html`, `engine/src/dashboard/home23-dashboard.html`), CSS (`engine/src/dashboard/home23-chat.css`). Tests use `node --test` with `tsx` for TS via the existing `npm test` setup.

**Spec:** `docs/superpowers/specs/2026-04-27-dashboard-chat-image-attachments-design.md`

---

## File Inventory

| File | Change |
|---|---|
| `src/routes/chat-turn.ts` | Modify `ChatTurnConfig` (add `instanceDir`); modify `createTurnStartHandler` to accept `images`, validate, write to disk, pass `media` |
| `src/home.ts` | Pass `instanceDir: INSTANCE_DIR` into `chatTurnConfig` |
| `tests/agent/chat-turn-images.test.ts` | New: bridge-side validation + path-write + media-array tests |
| `engine/src/dashboard/home23-dashboard.html` | Add attach button, hidden file input, pending tray, drop overlay markup to chat tile (~line 507 area) |
| `engine/src/dashboard/home23-chat.html` | Add same markup to standalone chat page (~line 477 area) |
| `engine/src/dashboard/home23-chat.css` | Style attach button, tray, thumbnails, drop overlay |
| `engine/src/dashboard/home23-chat.js` | Pending state, picker/paste/drop handlers, tray render, base64-on-send, image rendering in user bubble |

---

## Task 1: Bridge — accept and validate `images` payload

**Files:**
- Modify: `src/routes/chat-turn.ts:8-14` (extend `ChatTurnConfig`)
- Modify: `src/routes/chat-turn.ts:27-77` (extend `createTurnStartHandler`)
- Modify: `src/home.ts:1051-1057` (pass `instanceDir`)
- Create: `tests/agent/chat-turn-images.test.ts`

- [ ] **Step 1: Read the current `createTurnStartHandler` to understand the existing flow**

Run: `cat src/routes/chat-turn.ts | head -80`

Expected: see the handler that currently reads `{ chatId, message, model }`, validates, builds `modelOverride`, and calls `runWithTurn(chatId, message, { modelOverride })`.

- [ ] **Step 2: Write the failing test**

Create `tests/agent/chat-turn-images.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { createTurnStartHandler } from '../../src/routes/chat-turn.js';

// Minimal stand-ins for the runtime collaborators the handler talks to.
function makeFakeAgent(captured: { media?: unknown }) {
  return {
    isRunning: () => false,
    runWithTurn: async (_chatId: string, _userText: string, opts: any) => {
      captured.media = opts?.media;
      return { turnId: 'turn-test', response: Promise.resolve({}) };
    },
  };
}
function makeFakeHistory() { return {}; }

async function postJson(app: express.Express, body: unknown): Promise<{ status: number; body: any }> {
  return await new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const port = (server.address() as any).port;
        const res = await fetch(`http://127.0.0.1:${port}/api/chat/turn`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const json = await res.json().catch(() => ({}));
        server.close();
        resolve({ status: res.status, body: json });
      } catch (err) { server.close(); reject(err); }
    });
  });
}

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('chat-turn writes image to instanceDir/uploads/chat and passes media to runWithTurn', async () => {
  const root = join(tmpdir(), `chat-turn-images-${Date.now()}`);
  const instanceDir = join(root, 'instances', 'agent-x');
  mkdirSync(instanceDir, { recursive: true });
  const captured: { media?: any[] } = {};
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.post('/api/chat/turn', createTurnStartHandler({
    agentName: 'agent-x',
    agent: makeFakeAgent(captured) as any,
    history: makeFakeHistory() as any,
    instanceDir,
  } as any));

  const res = await postJson(app, {
    chatId: 'c1', message: 'hi',
    images: [{ data: TINY_PNG_B64, mimeType: 'image/png', fileName: 'tiny.png' }],
  });

  assert.equal(res.status, 200);
  assert.equal(captured.media?.length, 1);
  assert.equal(captured.media?.[0].type, 'image');
  assert.equal(captured.media?.[0].mimeType, 'image/png');
  assert.ok(captured.media?.[0].path?.startsWith(join(instanceDir, 'uploads', 'chat')));
  assert.ok(existsSync(captured.media?.[0].path));
  const written = readFileSync(captured.media?.[0].path);
  assert.equal(written.length, Buffer.from(TINY_PNG_B64, 'base64').length);

  rmSync(root, { recursive: true, force: true });
});

test('chat-turn rejects > 6 images with 413', async () => {
  const root = join(tmpdir(), `chat-turn-images-${Date.now()}-cap`);
  const instanceDir = join(root, 'instances', 'agent-x');
  mkdirSync(instanceDir, { recursive: true });
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.post('/api/chat/turn', createTurnStartHandler({
    agentName: 'agent-x',
    agent: makeFakeAgent({}) as any,
    history: makeFakeHistory() as any,
    instanceDir,
  } as any));

  const tooMany = Array.from({ length: 7 }, () => ({ data: TINY_PNG_B64, mimeType: 'image/png' }));
  const res = await postJson(app, { chatId: 'c1', message: 'hi', images: tooMany });
  assert.equal(res.status, 413);

  rmSync(root, { recursive: true, force: true });
});

test('chat-turn rejects unsupported mime with 415', async () => {
  const root = join(tmpdir(), `chat-turn-images-${Date.now()}-mime`);
  const instanceDir = join(root, 'instances', 'agent-x');
  mkdirSync(instanceDir, { recursive: true });
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.post('/api/chat/turn', createTurnStartHandler({
    agentName: 'agent-x',
    agent: makeFakeAgent({}) as any,
    history: makeFakeHistory() as any,
    instanceDir,
  } as any));

  const res = await postJson(app, {
    chatId: 'c1', message: 'hi',
    images: [{ data: TINY_PNG_B64, mimeType: 'application/pdf' }],
  });
  assert.equal(res.status, 415);

  rmSync(root, { recursive: true, force: true });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx tsx --test tests/agent/chat-turn-images.test.ts`

Expected: FAIL — handler doesn't yet read `images`, doesn't accept `instanceDir`, returns 200 with no media captured (and oversize/mime cases also return 200).

- [ ] **Step 4: Extend `ChatTurnConfig` to include `instanceDir`**

Edit `src/routes/chat-turn.ts:8-14` from:

```typescript
export interface ChatTurnConfig {
  agentName: string;
  agent: AgentLoop;
  history: ConversationHistory;
  token?: string;
  modelAliases?: Record<string, { provider: string; model: string }>;
}
```

to:

```typescript
export interface ChatTurnConfig {
  agentName: string;
  agent: AgentLoop;
  history: ConversationHistory;
  token?: string;
  modelAliases?: Record<string, { provider: string; model: string }>;
  /** Absolute path to instances/<agent>/. Used as upload root for chat image attachments. */
  instanceDir?: string;
}
```

- [ ] **Step 5: Implement validation + disk-write + media-passing in `createTurnStartHandler`**

In `src/routes/chat-turn.ts`, add the imports at the top (next to existing imports):

```typescript
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
```

Then, inside `createTurnStartHandler`, between the existing `model` parsing block and the `try { const { turnId, response } = await config.agent.runWithTurn(...)` block, insert the image handling. Replace the entire body of the returned async function with:

```typescript
return async (req: Request, res: Response): Promise<void> => {
  if (!checkAuth(req, res, config.token)) return;

  const { chatId, message, model, images } = req.body ?? {};
  if (!chatId || typeof chatId !== 'string') {
    res.status(400).json({ error: 'chatId required' }); return;
  }
  if (!message || typeof message !== 'string') {
    res.status(400).json({ error: 'message required' }); return;
  }

  // Validate optional images payload
  const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  const MAX_IMAGES = 6;
  const MAX_BYTES = 10 * 1024 * 1024;
  let validatedImages: Array<{ buf: Buffer; mimeType: string; fileName?: string }> = [];
  if (images !== undefined) {
    if (!Array.isArray(images)) {
      res.status(400).json({ error: 'images must be an array' }); return;
    }
    if (images.length > MAX_IMAGES) {
      res.status(413).json({ error: `too many images (max ${MAX_IMAGES})` }); return;
    }
    for (const img of images) {
      if (!img || typeof img.data !== 'string' || typeof img.mimeType !== 'string') {
        res.status(400).json({ error: 'each image needs data (base64) and mimeType' }); return;
      }
      if (!ALLOWED_MIME.has(img.mimeType)) {
        res.status(415).json({ error: `unsupported mime ${img.mimeType}` }); return;
      }
      let buf: Buffer;
      try { buf = Buffer.from(img.data, 'base64'); }
      catch { res.status(400).json({ error: 'invalid base64' }); return; }
      if (buf.length === 0) {
        res.status(400).json({ error: 'empty image' }); return;
      }
      if (buf.length > MAX_BYTES) {
        res.status(413).json({ error: `image exceeds ${MAX_BYTES} bytes` }); return;
      }
      validatedImages.push({ buf, mimeType: img.mimeType, fileName: typeof img.fileName === 'string' ? img.fileName : undefined });
    }
  }

  // Reject concurrent runs for same chatId — surface the already-running turn
  if (config.agent.isRunning(chatId)) {
    const store = new TurnStore(config.history);
    const pending = store.pendingTurns(chatId);
    const existing = pending[pending.length - 1];
    if (existing) {
      res.status(409).json({ error: 'turn in progress', turn_id: existing.turn_id });
      return;
    }
  }

  // Resolve model alias → { model, provider } for per-turn override.
  let modelOverride: { model: string; provider?: string } | undefined;
  if (typeof model === 'string' && model.length > 0) {
    const alias = config.modelAliases?.[model];
    if (alias) {
      modelOverride = { model: alias.model, provider: alias.provider };
    } else {
      modelOverride = { model };
    }
  }

  // Generate turnId early so we can name image files by it.
  const turnId = `t_${Date.now()}_${randomUUID().slice(0, 8)}`;

  // Write images to disk + build media array
  const media: Array<{ type: 'image'; path: string; mimeType: string; fileName?: string }> = [];
  if (validatedImages.length > 0) {
    if (!config.instanceDir) {
      res.status(500).json({ error: 'instanceDir not configured' }); return;
    }
    const uploadDir = join(config.instanceDir, 'uploads', 'chat');
    mkdirSync(uploadDir, { recursive: true });
    const extByMime: Record<string, string> = {
      'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
    };
    for (let i = 0; i < validatedImages.length; i++) {
      const v = validatedImages[i]!;
      const ext = extByMime[v.mimeType] ?? extname(v.fileName ?? '') ?? '.bin';
      const p = join(uploadDir, `${turnId}-${i}${ext}`);
      writeFileSync(p, v.buf);
      media.push({ type: 'image', path: p, mimeType: v.mimeType, fileName: v.fileName });
    }
  }

  try {
    const { turnId: actualTurnId, response } = await config.agent.runWithTurn(chatId, message, {
      turnId,
      modelOverride,
      media: media.length > 0 ? media as any : undefined,
    });

    response.catch(err => {
      console.error(`[chat-turn] ${config.agentName} ${actualTurnId} error:`, err?.message || err);
    });

    res.json({ turn_id: actualTurnId });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.error(`[chat-turn] ${config.agentName} start error:`, m);
    res.status(500).json({ error: m });
  }
};
```

(Note: `media as any` is used because the `MediaAttachment` type lives in `src/types.ts` — if you prefer, import it: `import type { MediaAttachment } from '../types.js';` and type the local array as `MediaAttachment[]`.)

- [ ] **Step 6: Wire `instanceDir` through from `home.ts`**

Edit `src/home.ts` around line 1051. Change:

```typescript
const chatTurnConfig = {
  agentName: AGENT_NAME,
  agent,
  history,
  token: bridgeToken || undefined,
  modelAliases: MODEL_ALIASES,
};
```

to:

```typescript
const chatTurnConfig = {
  agentName: AGENT_NAME,
  agent,
  history,
  token: bridgeToken || undefined,
  modelAliases: MODEL_ALIASES,
  instanceDir: INSTANCE_DIR,
};
```

- [ ] **Step 7: Bump the bridge JSON body limit to fit images**

The bridge currently uses `json({ limit: '10mb' })` at `src/home.ts:802`. With base64 expansion (~33% overhead), 6 × 10 MB images plus envelope would exceed that. Edit `src/home.ts:802`:

```typescript
bridgeApp.use((await import('express')).default.json({ limit: '10mb' }));
```

to:

```typescript
bridgeApp.use((await import('express')).default.json({ limit: '90mb' }));
```

Rationale: 6 images × 10 MB raw × 1.34 base64 overhead ≈ 80 MB. Round to 90 MB for envelope room. The per-image cap in the handler (Step 5) is the real safety; this just lets the body parser see the request before the handler can reject it.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx tsx --test tests/agent/chat-turn-images.test.ts`

Expected: 3 PASS — image written to disk under `instanceDir/uploads/chat/`, oversize array → 413, bad mime → 415.

- [ ] **Step 9: Run `tsc` to verify types**

Run: `npx tsc --noEmit`

Expected: 0 errors. Fix any type errors inline (most likely related to the `MediaAttachment` cast — replace `media as any` with the proper imported type if `tsc` complains).

- [ ] **Step 10: Commit**

```bash
git add src/routes/chat-turn.ts src/home.ts tests/agent/chat-turn-images.test.ts
git commit -m "feat(chat): bridge accepts image attachments for /api/chat/turn"
```

---

## Task 2: Add chat tile composer markup (dashboard)

**Files:**
- Modify: `engine/src/dashboard/home23-dashboard.html:507-509`

- [ ] **Step 1: Read the current chat tile composer**

Run: `sed -n '500,515p' engine/src/dashboard/home23-dashboard.html`

Expected: see the `h23-chat-input-area` div containing the textarea + send button.

- [ ] **Step 2: Replace the composer markup**

Find the block at `engine/src/dashboard/home23-dashboard.html:507-509`:

```html
<div class="h23-chat-input-area" id="chat-input-area">
  <textarea class="h23-chat-input" id="chat-input" placeholder="Message your agent..." rows="1"></textarea>
  <button class="h23-chat-send-btn" id="chat-send-btn" type="button">&#9654;</button>
</div>
```

Replace with:

```html
<div class="h23-chat-input-area" id="chat-input-area">
  <div class="h23-chat-attach-tray" id="chat-attach-tray" hidden></div>
  <div class="h23-chat-input-row">
    <button class="h23-chat-attach-btn" id="chat-attach-btn" type="button" aria-label="Attach image" title="Attach image">📎</button>
    <input type="file" id="chat-attach-input" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden />
    <textarea class="h23-chat-input" id="chat-input" placeholder="Message your agent..." rows="1"></textarea>
    <button class="h23-chat-send-btn" id="chat-send-btn" type="button">&#9654;</button>
  </div>
  <div class="h23-chat-drop-overlay" id="chat-drop-overlay" hidden>Drop images to attach</div>
</div>
```

- [ ] **Step 3: Commit**

```bash
git add engine/src/dashboard/home23-dashboard.html
git commit -m "feat(chat-tile): markup for image attach button + tray + drop overlay"
```

---

## Task 3: Add standalone chat composer markup

**Files:**
- Modify: `engine/src/dashboard/home23-chat.html:477-481`

- [ ] **Step 1: Read the current standalone composer**

Run: `sed -n '475,485p' engine/src/dashboard/home23-chat.html`

Expected: see the `sh-input-bar` div with textarea + send button.

- [ ] **Step 2: Replace the composer markup**

Find:

```html
<div class="sh-input-bar">
  <textarea class="sh-input h23-chat-input" id="chat-input" placeholder="Message your agent…" rows="1" autocapitalize="sentences" autocorrect="on" spellcheck="true"></textarea>
  <button class="sh-send-btn h23-chat-send-btn" id="chat-send-btn" aria-label="Send">&#9654;</button>
</div>
```

Replace with:

```html
<div class="sh-input-bar">
  <div class="h23-chat-attach-tray" id="chat-attach-tray" hidden></div>
  <div class="h23-chat-input-row">
    <button class="h23-chat-attach-btn" id="chat-attach-btn" type="button" aria-label="Attach image" title="Attach image">📎</button>
    <input type="file" id="chat-attach-input" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden />
    <textarea class="sh-input h23-chat-input" id="chat-input" placeholder="Message your agent…" rows="1" autocapitalize="sentences" autocorrect="on" spellcheck="true"></textarea>
    <button class="sh-send-btn h23-chat-send-btn" id="chat-send-btn" aria-label="Send">&#9654;</button>
  </div>
  <div class="h23-chat-drop-overlay" id="chat-drop-overlay" hidden>Drop images to attach</div>
</div>
```

- [ ] **Step 3: Commit**

```bash
git add engine/src/dashboard/home23-chat.html
git commit -m "feat(chat-page): markup for image attach button + tray + drop overlay"
```

---

## Task 4: Add CSS for attach button, tray, thumbnails, drop overlay

**Files:**
- Modify: `engine/src/dashboard/home23-chat.css` (append at end)

- [ ] **Step 1: Append the styles**

Add to the bottom of `engine/src/dashboard/home23-chat.css`:

```css
/* ── Image Attachments ──────────────────────────────────── */

.h23-chat-input-row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  width: 100%;
}

.h23-chat-attach-btn {
  background: transparent;
  border: 1px solid var(--border, rgba(255,255,255,0.12));
  color: var(--text-muted, #888);
  border-radius: 8px;
  width: 36px;
  height: 36px;
  font-size: 18px;
  cursor: pointer;
  flex: 0 0 auto;
  align-self: flex-end;
  transition: background 0.15s ease, color 0.15s ease;
}
.h23-chat-attach-btn:hover {
  background: var(--bg-hover, rgba(255,255,255,0.06));
  color: var(--text, #fff);
}

.h23-chat-attach-tray {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 0;
}
.h23-chat-attach-tray[hidden] { display: none; }

.h23-chat-attach-thumb {
  position: relative;
  width: 56px;
  height: 56px;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid var(--border, rgba(255,255,255,0.12));
  background: var(--bg-elevated, #1a1a1a);
}
.h23-chat-attach-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.h23-chat-attach-thumb-remove {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: rgba(0,0,0,0.7);
  color: #fff;
  border: none;
  font-size: 11px;
  line-height: 18px;
  cursor: pointer;
  padding: 0;
}

.h23-chat-drop-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 100, 200, 0.18);
  border: 2px dashed rgba(80, 160, 230, 0.7);
  color: #fff;
  font-weight: 500;
  pointer-events: none;
  z-index: 50;
  border-radius: 8px;
}
.h23-chat-drop-overlay[hidden] { display: none; }

/* User-bubble image rendering */
.h23-chat-msg.user .h23-chat-msg-images {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 6px;
}
.h23-chat-msg.user .h23-chat-msg-images img {
  max-width: 200px;
  max-height: 200px;
  border-radius: 6px;
  display: block;
}
```

- [ ] **Step 2: Commit**

```bash
git add engine/src/dashboard/home23-chat.css
git commit -m "style(chat): attach button, tray, thumbnails, drop overlay"
```

---

## Task 5: Pending-attachments state + file-picker handler

**Files:**
- Modify: `engine/src/dashboard/home23-chat.js` (top of file for state, near `bindInput` for handler)

- [ ] **Step 1: Add pending state + helpers near the top of the file**

Find the existing top-of-file `let` declarations (around lines 5-20 — look for the comment "The `let` variables"). After the existing state declarations, add:

```javascript
// ── Image attachment state ──
// In-memory pending attachments for the next turn. Cleared after submit.
let pendingAttachments = []; // Array<{ id, file, dataUrl }>

const ATTACH_MAX_IMAGES = 6;
const ATTACH_MAX_BYTES = 10 * 1024 * 1024;
const ATTACH_ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function dataUrlToBase64(dataUrl) {
  const i = dataUrl.indexOf(',');
  return i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
}

async function ingestAttachmentFiles(files) {
  for (const file of files) {
    if (pendingAttachments.length >= ATTACH_MAX_IMAGES) {
      console.warn('[chat] attachment cap reached, dropping', file.name);
      break;
    }
    if (!ATTACH_ALLOWED_MIME.has(file.type)) {
      console.warn('[chat] unsupported mime, dropping', file.type, file.name);
      continue;
    }
    if (file.size > ATTACH_MAX_BYTES) {
      console.warn('[chat] image too big, dropping', file.size, file.name);
      continue;
    }
    try {
      const dataUrl = await readFileAsDataURL(file);
      pendingAttachments.push({
        id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        dataUrl,
      });
    } catch (err) {
      console.warn('[chat] failed to read attachment', err);
    }
  }
  renderAttachmentTray();
}

function removeAttachment(id) {
  pendingAttachments = pendingAttachments.filter(a => a.id !== id);
  renderAttachmentTray();
}

function clearAttachments() {
  pendingAttachments = [];
  renderAttachmentTray();
}

function renderAttachmentTray() {
  const tray = document.getElementById('chat-attach-tray');
  if (!tray) return;
  if (pendingAttachments.length === 0) {
    tray.hidden = true;
    tray.innerHTML = '';
    return;
  }
  tray.hidden = false;
  tray.innerHTML = pendingAttachments.map(a => `
    <div class="h23-chat-attach-thumb">
      <img src="${a.dataUrl}" alt="${a.file.name || 'attachment'}" />
      <button class="h23-chat-attach-thumb-remove" data-att-id="${a.id}" aria-label="Remove">&times;</button>
    </div>
  `).join('');
  tray.querySelectorAll('.h23-chat-attach-thumb-remove').forEach(btn => {
    btn.addEventListener('click', () => removeAttachment(btn.dataset.attId));
  });
}
```

- [ ] **Step 2: Wire the paperclip button + hidden file input inside `bindInput`**

Find `function bindInput(inputId, btnId, source)` at `home23-chat.js:362` and replace it with:

```javascript
function bindInput(inputId, btnId, source) {
  const input = document.getElementById(inputId);
  const btn = document.getElementById(btnId);
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage(source);
      }
    });
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });
  }
  if (btn) btn.addEventListener('click', () => sendMessage(source));

  // Image attachments — file picker
  const attachBtn = document.getElementById('chat-attach-btn');
  const attachInput = document.getElementById('chat-attach-input');
  if (attachBtn && attachInput && !attachBtn.dataset.bound) {
    attachBtn.addEventListener('click', () => attachInput.click());
    attachInput.addEventListener('change', () => {
      const files = Array.from(attachInput.files || []);
      ingestAttachmentFiles(files);
      attachInput.value = '';
    });
    attachBtn.dataset.bound = 'true';
  }
}
```

- [ ] **Step 3: Manual verify — picker**

Run: `pm2 restart home23-jerry-dash` (or whichever dashboard process you're testing against — `pm2 list | grep dash` to find it).

Open the chat tile in the dashboard. Click the paperclip — file dialog opens. Pick a PNG. Confirm: a thumbnail with × appears in the tray above the textarea. Click ×. Confirm: thumbnail vanishes, tray hides.

- [ ] **Step 4: Commit**

```bash
git add engine/src/dashboard/home23-chat.js
git commit -m "feat(chat): pending-attachments state + paperclip file picker"
```

---

## Task 6: Paste-from-clipboard handler

**Files:**
- Modify: `engine/src/dashboard/home23-chat.js` (inside `bindInput`)

- [ ] **Step 1: Add the paste handler inside `bindInput`**

Inside `bindInput`, just before the `if (btn) btn.addEventListener('click', ...)` line, add:

```javascript
  if (input) {
    input.addEventListener('paste', (e) => {
      const items = Array.from(e.clipboardData?.items || []);
      const files = items
        .filter(it => it.kind === 'file' && it.type.startsWith('image/'))
        .map(it => it.getAsFile())
        .filter(f => !!f);
      if (files.length > 0) {
        e.preventDefault();
        ingestAttachmentFiles(files);
      }
    });
  }
```

- [ ] **Step 2: Manual verify — paste**

Reload the dashboard. Take a screenshot (cmd-shift-4 on macOS captures to clipboard with ctrl). Click into the chat textarea, press cmd-V. Confirm: thumbnail appears in tray, textarea is not filled with garbage.

- [ ] **Step 3: Commit**

```bash
git add engine/src/dashboard/home23-chat.js
git commit -m "feat(chat): paste-from-clipboard image handler"
```

---

## Task 7: Drag-and-drop handler

**Files:**
- Modify: `engine/src/dashboard/home23-chat.js` (inside `bindInput`)

- [ ] **Step 1: Add drop handlers inside `bindInput`**

Inside `bindInput`, after the paste handler, add:

```javascript
  // Drag and drop onto the input area
  const inputArea = document.getElementById('chat-input-area') || document.querySelector('.sh-input-bar');
  const dropOverlay = document.getElementById('chat-drop-overlay');
  if (inputArea && dropOverlay && !inputArea.dataset.dropBound) {
    let dragDepth = 0;
    inputArea.addEventListener('dragenter', (e) => {
      if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
      dragDepth++;
      dropOverlay.hidden = false;
    });
    inputArea.addEventListener('dragover', (e) => { e.preventDefault(); });
    inputArea.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) dropOverlay.hidden = true;
    });
    inputArea.addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth = 0;
      dropOverlay.hidden = true;
      const files = Array.from(e.dataTransfer?.files || []).filter(f => f.type.startsWith('image/'));
      if (files.length > 0) ingestAttachmentFiles(files);
    });
    // Suppress browser default of opening dropped images outside the input area
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      // Only suppress if the drop wasn't on our input area (already handled there)
      if (!inputArea.contains(e.target)) e.preventDefault();
    });
    inputArea.dataset.dropBound = 'true';
  }
```

Note: `chat-input-area` lives in `home23-dashboard.html`; `sh-input-bar` is the standalone-page equivalent. The fallback covers both.

- [ ] **Step 2: Verify the input-area on the standalone page also has positioning that supports the absolute overlay**

Run: `grep -n "sh-input-bar" engine/src/dashboard/home23-chat.css | head`

If the rule for `.sh-input-bar` does NOT include `position: relative;`, append a small fix to `home23-chat.css`:

```css
.h23-chat-input-area, .sh-input-bar { position: relative; }
```

(Skip this step if the rule already has `position: relative;`.)

- [ ] **Step 3: Manual verify — drag-and-drop**

Reload dashboard. Drag a `.png` from Finder onto the chat tile. Confirm: a translucent "Drop images to attach" overlay appears while dragging; on release, the thumbnail is in the tray. Drop a non-image (e.g. text file) — confirm it's ignored.

- [ ] **Step 4: Commit**

```bash
git add engine/src/dashboard/home23-chat.js engine/src/dashboard/home23-chat.css
git commit -m "feat(chat): drag-and-drop image attachments"
```

---

## Task 8: Send images with the turn

**Files:**
- Modify: `engine/src/dashboard/home23-chat.js:678-743` (function `sendMessage`)

- [ ] **Step 1: Update `sendMessage` to ship images and clear the tray**

In `engine/src/dashboard/home23-chat.js`, find `async function sendMessage(source)` at ~line 678. Modify two parts:

**(a)** Where the function returns early on empty input, allow sending if there are pending attachments. Replace:

```javascript
const text = input.value.trim();
if (!text || chatStreaming) return;
```

with:

```javascript
const text = input.value.trim();
if ((!text && pendingAttachments.length === 0) || chatStreaming) return;
```

**(b)** Snapshot pending attachments BEFORE clearing UI state, then include them in the user bubble + the POST body. Find the block:

```javascript
input.value = '';
input.style.height = 'auto';
scheduleChatPersist();

// Handle slash commands
if (text.startsWith('/')) {
  handleSlashCommand(text, source);
  return;
}

const empty = document.querySelector('.h23-chat-empty');
if (empty) empty.remove();

// Determine which messages container to use
const containerId = 'chat-messages';
appendMessage('user', text, containerId);
```

Replace with:

```javascript
// Snapshot attachments for this turn before clearing the tray.
const turnAttachments = pendingAttachments.slice();
clearAttachments();

input.value = '';
input.style.height = 'auto';
scheduleChatPersist();

// Handle slash commands (slash commands cannot carry attachments)
if (text.startsWith('/')) {
  handleSlashCommand(text, source);
  return;
}

const empty = document.querySelector('.h23-chat-empty');
if (empty) empty.remove();

// Determine which messages container to use
const containerId = 'chat-messages';
appendUserMessage(text, turnAttachments.map(a => a.dataUrl), containerId);
```

**(c)** Update the POST body. Find:

```javascript
const res = await fetch(`${bridgeBase}/api/chat/turn`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ chatId: activeChatId, message: text }),
});
```

Replace with:

```javascript
const imagesPayload = turnAttachments.map(a => ({
  data: dataUrlToBase64(a.dataUrl),
  mimeType: a.file.type,
  fileName: a.file.name,
}));
const res = await fetch(`${bridgeBase}/api/chat/turn`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    chatId: activeChatId,
    message: text,
    ...(imagesPayload.length > 0 ? { images: imagesPayload } : {}),
  }),
});
```

- [ ] **Step 2: Add `appendUserMessage` helper next to `appendMessage`**

In `engine/src/dashboard/home23-chat.js`, find `function appendMessage(role, content, containerId)` at ~line 938. Immediately after that function, add:

```javascript
function appendUserMessage(text, imageDataUrls, containerId) {
  const container = document.getElementById(containerId || 'chat-messages');
  if (!container) return null;
  const div = document.createElement('div');
  div.className = 'h23-chat-msg user';
  if (imageDataUrls && imageDataUrls.length > 0) {
    const wrap = document.createElement('div');
    wrap.className = 'h23-chat-msg-images';
    for (const url of imageDataUrls) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = 'attachment';
      wrap.appendChild(img);
    }
    div.appendChild(wrap);
  }
  if (text) {
    const textNode = document.createElement('div');
    textNode.textContent = text;
    div.appendChild(textNode);
  }
  container.appendChild(div);
  scheduleChatPersist();
  return div;
}
```

- [ ] **Step 3: Manual verify — end-to-end with vision model**

Reload the dashboard. Switch the chat agent to one with a vision-capable model (Claude Sonnet 4.6 is the default for jerry — verify in the model dropdown). Attach an image (any method) plus type "describe this image". Send.

Confirm:
- User bubble shows the image thumbnail above the text.
- Tray clears immediately on send.
- Assistant streams a description of the image content (proves the model actually saw it, not a hallucination).
- After the turn completes, run: `ls -lh instances/<agent>/uploads/chat/` and confirm the file exists with reasonable bytes.
- Run: `tail -3 instances/<agent>/conversations/*.jsonl | grep -i image` — should see `[image: image/png]` placeholder, NOT raw base64.

- [ ] **Step 4: Manual verify — over-cap rejection**

Attach 7 images, send. Confirm an error surfaces in the chat (red error message in the message list). The bridge should respond 413 — check browser devtools Network tab.

- [ ] **Step 5: Commit**

```bash
git add engine/src/dashboard/home23-chat.js
git commit -m "feat(chat): send attached images with turn + render in user bubble"
```

---

## Task 9: Verify history replay

**Files:**
- None (verification only)

- [ ] **Step 1: Verify history replay still works after a turn with images**

After the successful end-to-end run from Task 8, refresh the dashboard. Open the same conversation from the history drawer. Confirm:

- The previous user message shows up in the transcript (without the inline image — since `appendMessage` reads from server-side history, which strips base64; this is expected and the spec acknowledges this).
- The assistant response is intact.
- No console errors.

If you want the image to persist visually across reloads, that is **out of scope** per the spec — it would require either keeping the upload paths in conversation history and serving them via `/home23/api/media`, or storing thumbnails. Either is a follow-on, not part of this plan.

- [ ] **Step 2: No commit needed for verification step.**

---

## Task 10: Add `instances/<agent>/uploads/` to gitignore (if not already)

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Check whether uploads are already gitignored**

Run: `grep -n "instances/" .gitignore`

Expected: there is already a broad `instances/` ignore (per CLAUDE.md: "Per-agent directories (all gitignored)"). If `instances/` or `instances/*` is already there, skip the rest of this task.

- [ ] **Step 2 (only if needed): Add an explicit upload directory entry**

If for some reason uploads aren't covered, append to `.gitignore`:

```
instances/*/uploads/
```

- [ ] **Step 3: Commit (only if .gitignore changed)**

```bash
git add .gitignore
git commit -m "chore: ignore chat upload directory"
```

---

## Final smoke

- [ ] **Run the full test suite**

Run: `npm test`

Expected: all existing tests still pass; the three new `chat-turn-images.test.ts` tests pass.

- [ ] **Run the build**

Run: `npm run build`

Expected: clean TypeScript build with 0 errors.

- [ ] **Restart the dashboard + harness for the agent you tested with**

Run: `pm2 restart home23-jerry home23-jerry-dash home23-jerry-harness` (substitute your agent name)

- [ ] **Re-run the end-to-end Task 8 verification one more time** to make sure nothing regressed during the build.

- [ ] **Final commit (if any drift from build/format):**

```bash
git status
# if dist/ or other build artifacts changed, do not commit them — they're gitignored.
# if a real source file is dirty, investigate before committing.
```
