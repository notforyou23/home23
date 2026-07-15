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
import { createRequire } from 'node:module';
import type {
  MemoryObject,
  ProblemThread,
  LifecycleLayer,
  NodeProvenanceProfile,
  MemoryAuthorityClass,
  MemoryRetrievalDomain,
} from '../types.js';

const require = createRequire(import.meta.url);
const { isGeneratedMemoryMethod } = require('../../shared/memory-authority.cjs') as {
  isGeneratedMemoryMethod: (method: unknown) => boolean;
};
const { attestMemoryAuthorityIfAvailable } = require('../../shared/memory-authority-attestation.cjs') as {
  attestMemoryAuthorityIfAvailable: (node: unknown) => unknown;
};

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

const CORRECTION_LANGUAGE_PATTERN = /\b(?:correction|incorrect|wrong|not true|actually|you are mistaken)\b/i;

export interface AuthenticatedUserIngress {
  readonly chatId: string;
  readonly messageRef: string;
  readonly userText: string;
}

export interface MemoryObjectStoreOptions {
  validateCorrectionIngress?: (ingress: AuthenticatedUserIngress) => boolean;
}

const AUTHORITY_CLASSES = new Set<MemoryAuthorityClass>([
  'verified_current_state', 'jtr_correction', 'artifact_log',
  'worker_receipt', 'generated_doctrine', 'narrative',
]);
const RETRIEVAL_DOMAINS = new Set<MemoryRetrievalDomain>([
  'current_ops', 'closed_incidents', 'project_history', 'external_intake',
]);

function boundedProvenanceScalar(value: unknown, maxBytes: number): string | null {
  if (typeof value !== 'string' || !value) return null;
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let bounded = value.slice(0, maxBytes);
  while (bounded && Buffer.byteLength(bounded, 'utf8') > maxBytes) bounded = bounded.slice(0, -1);
  return bounded || null;
}

function boundedProvenanceStrings(values: unknown, limit: number): string[] {
  const result: string[] = [];
  for (const value of Array.isArray(values) ? values : []) {
    const bounded = boundedProvenanceScalar(value, 240);
    if (!bounded || result.includes(bounded)) continue;
    result.push(bounded);
    if (result.length >= limit) break;
  }
  return result;
}

function normalizedCorrectionClaim(value: unknown): string | null {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > 16 * 1024) return null;
  const normalized = value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  return normalized || null;
}

function validatedCorrectionIngress(
  partial: Omit<MemoryObject, 'memory_id' | 'created_at' | 'updated_at' | 'reuse_count'>,
  validator: MemoryObjectStoreOptions['validateCorrectionIngress'],
  ingress?: AuthenticatedUserIngress,
): string | null {
  const messageRef = boundedProvenanceScalar(ingress?.messageRef, 240);
  const chatId = boundedProvenanceScalar(ingress?.chatId, 240);
  const statementClaim = normalizedCorrectionClaim(partial.statement);
  const userClaim = normalizedCorrectionClaim(ingress?.userText);
  if (!ingress || !validator || !messageRef || !chatId
      || partial.type !== 'correction' || partial.session_id !== chatId
      || !statementClaim || statementClaim !== userClaim
      || !CORRECTION_LANGUAGE_PATTERN.test(ingress.userText)
      || validator(ingress) !== true) return null;
  return messageRef;
}

function normalizedOrigin(origin: MemoryObject['provenance']['origin']): MemoryObject['provenance']['origin'] {
  if (!origin) return undefined;
  return {
    agent: boundedProvenanceScalar(origin.agent, 240) || undefined,
    peerName: boundedProvenanceScalar(origin.peerName, 240) || undefined,
    peerSource: boundedProvenanceScalar(origin.peerSource, 240),
    url: boundedProvenanceScalar(origin.url, 2048) || undefined,
    snapshotAt: boundedProvenanceScalar(origin.snapshotAt, 64) || undefined,
    protocol: boundedProvenanceScalar(origin.protocol, 120) || undefined,
    protocolVersion: Number.isSafeInteger(origin.protocolVersion) && Number(origin.protocolVersion) >= 0
      ? Number(origin.protocolVersion)
      : undefined,
  };
}

function normalizeNodeProvenance(
  partial: Omit<MemoryObject, 'memory_id' | 'created_at' | 'updated_at' | 'reuse_count'>,
  correctionMessageRef: string | null = null,
): NodeProvenanceProfile {
  const supplied = partial.provenance.node_profile;
  const method = boundedProvenanceScalar(partial.provenance.generation_method, 120) || 'unknown';
  const generated = isGeneratedMemoryMethod(method);
  const directSourceRefs = boundedProvenanceStrings([
    ...(correctionMessageRef ? [correctionMessageRef] : []),
    ...partial.provenance.source_refs,
  ], 8);
  const directEvidenceRefs = boundedProvenanceStrings([
    ...(correctionMessageRef ? [correctionMessageRef] : []),
    ...partial.evidence.evidence_links,
  ], 8);
  const sourceRefs = boundedProvenanceStrings([
    ...directSourceRefs,
    ...(supplied?.sourceRefs || []),
  ], 8);
  const evidenceRefs = boundedProvenanceStrings([
    ...directEvidenceRefs,
    ...(supplied?.evidenceRefs || []),
  ], 8);
  const verifierRefs = boundedProvenanceStrings(
    partial.evidence.evidence_links.filter((ref) => ref.startsWith('verifier:')),
    8,
  );
  let authorityClass: MemoryAuthorityClass = AUTHORITY_CLASSES.has(supplied?.authorityClass as MemoryAuthorityClass)
    ? supplied!.authorityClass
    : sourceRefs.length ? 'artifact_log' : 'narrative';
  if (authorityClass === 'jtr_correction' && !correctionMessageRef) {
    authorityClass = sourceRefs.length ? 'artifact_log' : 'narrative';
  }
  if (authorityClass === 'verified_current_state' && verifierRefs.length === 0) {
    authorityClass = sourceRefs.length ? 'artifact_log' : 'narrative';
  }
  const adoptedDoctrine = supplied?.authorityClass === 'generated_doctrine'
    && directEvidenceRefs.some((ref) => ref.startsWith('adopted-doctrine-receipt:'));
  if (correctionMessageRef) authorityClass = 'jtr_correction';
  if (method === 'runtime_verified' && verifierRefs.length > 0) {
    authorityClass = 'verified_current_state';
  }
  // Generated output can cite authority, but cannot become operational authority
  // merely by repeating it. An independently adopted doctrine is the sole lift.
  if (generated) authorityClass = adoptedDoctrine ? 'generated_doctrine' : 'narrative';
  const operationalAuthority = authorityClass === 'verified_current_state'
    && verifierRefs.length > 0;
  const suppliedDomain = supplied?.retrievalDomain as MemoryRetrievalDomain;
  const retrievalDomain = authorityClass === 'jtr_correction'
    ? 'current_ops'
    : RETRIEVAL_DOMAINS.has(suppliedDomain)
      ? suppliedDomain
      : 'project_history';
  return {
    schema: 'home23.node-provenance.v1',
    authorityClass,
    retrievalDomain,
    semanticTime: boundedProvenanceScalar(supplied?.semanticTime, 64),
    sourceRefs,
    evidenceRefs,
    generationMethod: method,
    sourcePath: boundedProvenanceScalar(supplied?.sourcePath, 2048),
    contentHash: boundedProvenanceScalar(supplied?.contentHash, 128),
    derivedNodeIds: boundedProvenanceStrings(supplied?.derivedNodeIds || [], 64),
    scope: boundedProvenanceStrings(supplied?.scope || partial.scope.applies_to, 8),
    expiresAt: boundedProvenanceScalar(supplied?.expiresAt, 64),
    operationalAuthority,
    requiresFreshVerification: !operationalAuthority,
    missingEvidence: operationalAuthority ? [] : ['fresh_verification'],
  };
}

// ─── Store ──────────────────────────────────────────────

export class MemoryObjectStore {
  private objectsPath: string;
  private threadsPath: string;
  private correctionIngressValidator?: MemoryObjectStoreOptions['validateCorrectionIngress'];
  private objects: MemoryObject[] = [];
  private threads: ProblemThread[] = [];

  constructor(brainDir: string, options: MemoryObjectStoreOptions = {}) {
    mkdirSync(brainDir, { recursive: true });
    this.objectsPath = join(brainDir, 'memory-objects.json');
    this.threadsPath = join(brainDir, 'problem-threads.json');
    this.correctionIngressValidator = options.validateCorrectionIngress;
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

  createObject(
    partial: Omit<MemoryObject, 'memory_id' | 'created_at' | 'updated_at' | 'reuse_count'>,
    ingress?: AuthenticatedUserIngress,
  ): MemoryObject {
    const now = new Date().toISOString();
    const generationMethod = boundedProvenanceScalar(partial.provenance.generation_method, 120) || 'unknown';
    const correctionMessageRef = validatedCorrectionIngress(
      partial,
      this.correctionIngressValidator,
      ingress,
    );
    const sourceRefs = boundedProvenanceStrings([
      ...(correctionMessageRef ? [correctionMessageRef] : []),
      ...partial.provenance.source_refs,
    ], 8);
    const sessionRefs = boundedProvenanceStrings(partial.provenance.session_refs, 8);
    const evidenceLinks = boundedProvenanceStrings([
      ...(correctionMessageRef ? [correctionMessageRef] : []),
      ...partial.evidence.evidence_links,
    ], 8);
    const constrainedConfidence = constrainConfidence(
      partial.confidence.score,
      generationMethod,
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
      actor: correctionMessageRef && !isGeneratedMemoryMethod(generationMethod)
        ? 'jtr'
        : partial.actor === 'jtr' ? 'agent' : partial.actor,
      confidence: {
        score: constrainedConfidence,
        basis: partial.confidence.basis,
      },
      provenance: {
        ...partial.provenance,
        source_refs: sourceRefs,
        session_refs: sessionRefs,
        generation_method: generationMethod,
        ...(partial.provenance.origin ? { origin: normalizedOrigin(partial.provenance.origin) } : {}),
        node_profile: normalizeNodeProvenance(partial, correctionMessageRef),
      },
      evidence: {
        ...partial.evidence,
        evidence_links: evidenceLinks,
      },
      reuse_count: 0,
    };

    // Only the one-use, recorded user-turn correction path is independently
    // authenticated here. Generic verifier/adoption strings remain unsigned.
    if (correctionMessageRef) attestMemoryAuthorityIfAvailable(obj);

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
    const current = this.objects[idx]!;
    const merged: MemoryObject = {
      ...current,
      ...updates,
      memory_id: current.memory_id,
      provenance: updates.provenance
        ? { ...current.provenance, ...updates.provenance }
        : current.provenance,
      evidence: updates.evidence ? { ...current.evidence, ...updates.evidence } : current.evidence,
      scope: updates.scope ? { ...current.scope, ...updates.scope } : current.scope,
      updated_at: new Date().toISOString(),
    };
    const provenanceInputsChanged = Boolean(
      updates.provenance || updates.evidence || updates.scope
      || updates.type || updates.session_id || updates.actor,
    );
    if (provenanceInputsChanged) {
      const generationMethod = boundedProvenanceScalar(merged.provenance.generation_method, 120) || 'unknown';
      merged.provenance = {
        ...merged.provenance,
        source_refs: boundedProvenanceStrings(merged.provenance.source_refs, 8),
        session_refs: boundedProvenanceStrings(merged.provenance.session_refs, 8),
        generation_method: generationMethod,
        ...(merged.provenance.origin ? { origin: normalizedOrigin(merged.provenance.origin) } : {}),
        node_profile: normalizeNodeProvenance(merged),
      };
      merged.evidence = {
        ...merged.evidence,
        evidence_links: boundedProvenanceStrings(merged.evidence.evidence_links, 8),
      };
      if (updates.actor === 'jtr' && current.actor !== 'jtr') merged.actor = current.actor;
    }
    this.objects[idx] = merged;
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
