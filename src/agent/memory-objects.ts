/**
 * Home23 — Memory Object Store (Step 20)
 *
 * CRUD for MemoryObjects and ProblemThreads.
 * Stored as JSON files in the brain directory.
 * Includes confidence anti-theater constraints and checkpoint quality floor.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MemoryObject, ProblemThread, LifecycleLayer } from '../types.js';

// ─── Confidence Anti-Theater Constraints ────────────────
const CONFIDENCE_CAPS: Record<string, number> = {
  reflection_synthesis: 0.6,
  document_ingestion: 0.7,
  conversation: 0.8,
  agent_promote: 0.8,
  curator: 0.7,
  runtime_verified: 0.95,
};

export function constrainConfidence(score: number, generationMethod: string): number {
  const cap = CONFIDENCE_CAPS[generationMethod] ?? 0.7;
  return Math.min(score, cap);
}

// ─── Store ──────────────────────────────────────────────

export class MemoryObjectStore {
  private objectsPath: string;
  private threadsPath: string;
  private objects: MemoryObject[] = [];
  private threads: ProblemThread[] = [];

  constructor(brainDir: string) {
    mkdirSync(brainDir, { recursive: true });
    this.objectsPath = join(brainDir, 'memory-objects.json');
    this.threadsPath = join(brainDir, 'problem-threads.json');
    this.load();
  }

  private load(): void {
    if (existsSync(this.objectsPath)) {
      try {
        const raw = JSON.parse(readFileSync(this.objectsPath, 'utf-8'));
        this.objects = raw.objects ?? [];
      } catch { this.objects = []; }
    }
    if (existsSync(this.threadsPath)) {
      try {
        const raw = JSON.parse(readFileSync(this.threadsPath, 'utf-8'));
        this.threads = raw.threads ?? [];
      } catch { this.threads = []; }
    }
    console.log(`[memory-objects] Loaded ${this.objects.length} objects, ${this.threads.length} threads`);
  }

  // Drop pretty-print on hot-path saves: 1.26 MB pretty JSON costs ~50 ms
  // CPU per stringify, blocking the harness event loop. Compact JSON is
  // ~30 % smaller and ~5x faster to serialize. Files remain valid JSON.
  private saveObjects(): void {
    writeFileSync(this.objectsPath, JSON.stringify({ objects: this.objects }));
  }

  private saveThreads(): void {
    writeFileSync(this.threadsPath, JSON.stringify({ threads: this.threads }));
  }

  createObject(partial: Omit<MemoryObject, 'memory_id' | 'created_at' | 'updated_at' | 'reuse_count'>): MemoryObject {
    const now = new Date().toISOString();
    const constrainedConfidence = constrainConfidence(
      partial.confidence.score,
      partial.provenance.generation_method,
    );

    if (partial.type === 'checkpoint') {
      if (!partial.statement || partial.confidence.score <= 0 || partial.provenance.session_refs.length === 0) {
        throw new Error('Checkpoint requires non-empty statement, confidence > 0, and at least one session_ref');
      }
    }

    const obj: MemoryObject = {
      ...partial,
      memory_id: `mo_${randomUUID().slice(0, 12)}`,
      created_at: now,
      updated_at: now,
      confidence: {
        score: constrainedConfidence,
        basis: partial.confidence.basis,
      },
      reuse_count: 0,
    };

    this.objects.push(obj);
    this.saveObjects();
    return obj;
  }

  getObject(memoryId: string): MemoryObject | undefined {
    return this.objects.find(o => o.memory_id === memoryId);
  }

  updateObject(memoryId: string, updates: Partial<MemoryObject>): MemoryObject | undefined {
    const idx = this.objects.findIndex(o => o.memory_id === memoryId);
    if (idx === -1) return undefined;
    this.objects[idx] = { ...this.objects[idx]!, ...updates, updated_at: new Date().toISOString() };
    this.saveObjects();
    return this.objects[idx];
  }

  getObjectsByThread(threadId: string): MemoryObject[] {
    return this.objects.filter(o => o.thread_id === threadId);
  }

  getObjectsByLayer(layer: LifecycleLayer): MemoryObject[] {
    return this.objects.filter(o => o.lifecycle_layer === layer);
  }

  getDurableWithTriggers(): MemoryObject[] {
    return this.objects.filter(o => o.lifecycle_layer === 'durable' && o.triggers.length > 0);
  }

  incrementReuse(memoryId: string): void {
    const obj = this.objects.find(o => o.memory_id === memoryId);
    if (obj) {
      obj.reuse_count++;
      obj.last_reactivated = new Date().toISOString();
      this.saveObjects();
    }
  }

  markActedOn(memoryId: string): void {
    const obj = this.objects.find(o => o.memory_id === memoryId);
    if (obj) {
      obj.last_acted_on = new Date().toISOString();
      this.saveObjects();
    }
  }

  createThread(partial: Omit<ProblemThread, 'thread_id' | 'opened_at' | 'version'>): ProblemThread {
    const thread: ProblemThread = {
      ...partial,
      thread_id: `pt_${randomUUID().slice(0, 12)}`,
      opened_at: new Date().toISOString(),
      version: 1,
    };
    this.threads.push(thread);
    this.saveThreads();
    return thread;
  }

  getThread(threadId: string): ProblemThread | undefined {
    return this.threads.find(t => t.thread_id === threadId);
  }

  updateThread(threadId: string, updates: Partial<ProblemThread>): ProblemThread | undefined {
    const idx = this.threads.findIndex(t => t.thread_id === threadId);
    if (idx === -1) return undefined;
    const current = this.threads[idx]!;
    this.threads[idx] = { ...current, ...updates, version: current.version + 1 };
    this.saveThreads();
    return this.threads[idx];
  }

  getAllThreads(): ProblemThread[] {
    return [...this.threads];
  }

  getOpenThreads(): ProblemThread[] {
    return this.threads.filter(t => t.status === 'open' || t.status === 'progressing');
  }
}
