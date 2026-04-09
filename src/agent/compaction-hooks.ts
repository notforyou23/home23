import type { StoredMessage } from './history.js';
import type { MemoryManager } from './memory.js';

export interface PreCompactionContext {
  chatId: string;
  olderMessages: StoredMessage[];
  currentModel?: string;
  memory: MemoryManager;
}

export interface PostCompactionContext {
  chatId: string;
  olderMessages: StoredMessage[];
  recentMessages: StoredMessage[];
  summary?: string;
  compacted: boolean;
  currentModel?: string;
  memory: MemoryManager;
}

export interface PostCompactionHookResult {
  recoveryBundle?: string | null;
}

export interface CompactionHooks {
  preCompaction(ctx: PreCompactionContext): Promise<{ extractedLearnings: boolean }>;
  postCompaction(ctx: PostCompactionContext): Promise<PostCompactionHookResult>;
}

export class DefaultCompactionHooks implements CompactionHooks {
  async preCompaction(ctx: PreCompactionContext): Promise<{ extractedLearnings: boolean }> {
    if (!(ctx.currentModel ?? 'claude').includes('claude')) {
      return { extractedLearnings: false };
    }

    const extracted = await ctx.memory.preCompactionExtract(
      ctx.chatId,
      ctx.olderMessages,
      ctx.currentModel,
    );

    return { extractedLearnings: !!extracted };
  }

  async postCompaction(ctx: PostCompactionContext): Promise<PostCompactionHookResult> {
    if (!ctx.compacted) return {};

    return {
      recoveryBundle: ctx.memory.buildRecoveryBundle(),
    };
  }
}
