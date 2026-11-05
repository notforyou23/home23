import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const CONVERSATION_METADATA_MAX_TITLE = 200;
export const CONVERSATION_METADATA_MAX_CHAT_ID = 200;

export interface ConversationMetadataRecord {
  title?: string | null;
  pinned?: boolean;
}

interface ConversationMetadataFile {
  version: 1;
  conversations: Record<string, ConversationMetadataRecord>;
}

export function isSafeConversationChatId(chatId: string): boolean {
  const trimmed = String(chatId ?? '').trim();
  if (!trimmed || trimmed.length > CONVERSATION_METADATA_MAX_CHAT_ID) return false;
  if (trimmed.includes('..') || trimmed.includes('/') || trimmed.includes('\\')) return false;
  return /^[A-Za-z0-9_-]+$/.test(trimmed);
}

export function sanitizeConversationTitle(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(/[\r\n]+/g, ' ').trim();
  if (!trimmed) return null;
  return trimmed.slice(0, CONVERSATION_METADATA_MAX_TITLE);
}

export class ConversationMetadataStore {
  constructor(private readonly filePath: string) {}

  loadAll(): Record<string, ConversationMetadataRecord> {
    return { ...this.readFile().conversations };
  }

  get(chatId: string): ConversationMetadataRecord {
    return { ...(this.readFile().conversations[chatId] ?? {}) };
  }

  update(chatId: string, patch: { title?: string | null; pinned?: boolean }): ConversationMetadataRecord {
    if (!isSafeConversationChatId(chatId)) {
      throw new Error('unsafe chat id');
    }
    const current = this.readFile();
    const existing = { ...(current.conversations[chatId] ?? {}) };
    if (patch.title !== undefined) {
      existing.title = patch.title;
    }
    if (patch.pinned !== undefined) {
      existing.pinned = patch.pinned;
    }
    if (existing.title == null && existing.pinned !== true) {
      delete current.conversations[chatId];
    } else {
      current.conversations[chatId] = existing;
    }
    this.writeAtomic(current);
    return { ...existing };
  }

  private readFile(): ConversationMetadataFile {
    try {
      if (!existsSync(this.filePath)) {
        return { version: 1, conversations: {} };
      }
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as ConversationMetadataFile;
      if (!parsed || parsed.version !== 1 || typeof parsed.conversations !== 'object' || !parsed.conversations) {
        return { version: 1, conversations: {} };
      }
      return { version: 1, conversations: { ...parsed.conversations } };
    } catch {
      return { version: 1, conversations: {} };
    }
  }

  private writeAtomic(file: ConversationMetadataFile): void {
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.conversation-metadata.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(tmp, `${JSON.stringify({ version: 1, conversations: file.conversations }, null, 2)}\n`);
    renameSync(tmp, this.filePath);
  }
}
