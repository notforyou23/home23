# Dashboard Chat — Image Attachments

**Date:** 2026-04-27
**Status:** Design approved, ready to plan

## Goal

Let users attach images to messages sent through the dashboard chat tile (and the standalone `/home23/chat` page) so vision-capable models can work with them.

## Why this is small

The agent runtime already accepts image attachments. `runWithTurn(chatId, message, { media })` takes a `MediaAttachment[]`, the agent loop reads image paths and emits Anthropic vision blocks (`engine/src/agent/loop.ts:653-670`), and `history.ts` already strips base64 from persisted messages so context doesn't bloat. Telegram exercises this exact path. The dashboard chat just never plugged into it.

The bridge `POST /api/chat/turn` currently accepts JSON `{ chatId, message, model }` and the chat tile has no attach affordance. Closing that gap is the entire feature.

## Architecture

Three layers, all changes scoped:

### 1. Frontend — `engine/src/dashboard/home23-chat.{html,js,css}`

**Input methods (all three):**
- Paperclip button in the input toolbar, next to send → opens hidden `<input type="file" accept="image/*" multiple>`
- `paste` handler on the textarea — pulls image blobs from `ClipboardEvent.clipboardData.items` (cmd-V on a copied screenshot)
- `dragover`/`drop` on the chat tile — drop overlay highlights on dragenter, drop accepts image files

**State:** `pendingAttachments: File[]` held alongside the existing per-conversation chat state. Cleared after the turn is submitted (or via the × button on each thumbnail).

**Pending tray:** A row above the textarea showing a small thumbnail per pending attachment, each with an × to remove before send. Hidden when empty.

**Send path:** When the user submits, each pending `File` is read with `FileReader.readAsDataURL`, the base64 stripped of its data-URL prefix, and packaged into the existing `POST /api/chat/turn` body as a new `images` field:

```json
{
  "chatId": "...",
  "message": "...",
  "model": "...",
  "images": [
    { "data": "<base64>", "mimeType": "image/png", "fileName": "screenshot.png" }
  ]
}
```

**User bubble:** Render attached images inline as ~200px thumbnails above the message text, so the conversation transcript shows what the user sent.

### 2. Bridge — `src/routes/chat-turn.ts`

`createTurnStartHandler` already builds `modelOverride` and calls `runWithTurn(chatId, message, { modelOverride })`. Extend it:

1. Read optional `images: Array<{ data: string; mimeType: string; fileName?: string }>` from `req.body`.
2. Validate: array length ≤ 6, each `data` decoded length ≤ 10 MB, `mimeType` in the allowed list. On violation respond 413 with a clear error.
3. Generate the turnId early (or accept the one `runWithTurn` would generate — passing `opts.turnId` is supported).
4. For each image, write the decoded bytes to `instances/<agentName>/uploads/chat/<turnId>-<i>.<ext>` (creating the directory with `mkdir({ recursive: true })`).
5. Build `media: MediaAttachment[]` with `{ type: 'image', path, mimeType, fileName }` and pass it as `runWithTurn(chatId, message, { modelOverride, turnId, media })`.

The agent name is already in `ChatTurnConfig.agentName`. Path resolution should use the same `instances/<name>/` root the rest of the harness already uses (look at `agent/history.ts` or wherever the harness derives its instance root, and reuse the same helper if present rather than re-deriving).

### 3. No engine/loop/history changes

- `history.ts:113-117` already replaces base64 image blocks with `[image: <mime>]` placeholders before persistence.
- `loop.ts:653-670` already reads media paths and synthesizes Anthropic vision blocks.
- The persisted `chat-turn` event stream already includes user messages — nothing needs to change for replay.

## Caps

- **Per image:** 10 MB decoded
- **Per turn:** 6 images
- **Accepted MIME types:** `image/png`, `image/jpeg`, `image/webp`, `image/gif`
- **Over-cap behavior:** Bridge returns HTTP 413 with `{ error: "..." }`; frontend surfaces it inline like other turn-start errors

## Model awareness

None. The attach button is always enabled. If the selected model can't see images, the model handles it however it handles it. (Per explicit user direction — keeping the model-capability matrix is more maintenance than the warning is worth right now.)

## Storage

- Path: `instances/<agent>/uploads/chat/<turnId>-<index>.<ext>`
- Extension derived from MIME (`png`/`jpg`/`webp`/`gif`)
- No automatic cleanup in this iteration. Files are small and the directory is gitignored along with the rest of `instances/`. A retention sweep can be bolted on later if needed.

## Data flow

```
User pastes / drops / picks image(s)
    ↓
home23-chat.js: pendingAttachments[] (File objects, with thumbnails in tray)
    ↓ on send: each File → FileReader.readAsDataURL → base64 string
    ↓
POST /api/chat/turn  { chatId, message, model, images: [...] }
    ↓
chat-turn.ts: validate caps → decode → write each to instances/<agent>/uploads/chat/<turnId>-N.<ext>
    ↓
runWithTurn(chatId, message, { modelOverride, turnId, media: [{ type:'image', path, mimeType, fileName }] })
    ↓
loop.ts (existing): readFileSync(path) → base64 → vision block → provider
    ↓
history.ts (existing): persist with [image: <mime>] placeholder, not the base64 bytes
```

## Files touched

| File | Change | Approx LOC |
|---|---|---|
| `engine/src/dashboard/home23-chat.html` | Attach button, hidden file input, drop overlay element, pending tray container | ~15 |
| `engine/src/dashboard/home23-chat.js` | Pending state, file picker / paste / drop handlers, base64 conversion on send, image rendering in user bubble | ~120 |
| `engine/src/dashboard/home23-chat.css` | Attach button styling, tray, thumbnail, drop overlay | ~40 |
| `src/routes/chat-turn.ts` | Accept `images`, validate, write to disk, build `media`, pass to `runWithTurn` | ~30 |

## Out of scope

- Voice and document attachments (different UX, different modality — can plug into the same path later)
- Auto-cleanup / retention sweep on `instances/<agent>/uploads/chat/`
- Browser-side image editing or cropping
- Per-model capability indicator (attach button stays enabled regardless)
- Mobile-specific input handling beyond what the standard file picker gives for free

## Success criteria

- Pasting a screenshot into the chat textarea, dropping a PNG onto the chat tile, and clicking the paperclip all produce identical `pendingAttachments[]` state and identical thumbnails in the tray.
- Submitting a turn with one or more attached images results in a `runWithTurn` call whose `media` array contains valid filesystem paths under `instances/<agent>/uploads/chat/`.
- The user bubble in chat history shows the image(s) above the message text.
- A vision-capable model (e.g., Claude Sonnet 4.6) responds with content that demonstrates it actually saw the image.
- Sending 7+ images, or a >10 MB image, returns 413 from the bridge and surfaces an inline error in the chat UI.
- The persisted JSONL conversation file contains `[image: <mime>]` placeholders, not raw base64 — no context bloat.
