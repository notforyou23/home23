/**
 * Home23 contact membrane — the contract every world-facing capability
 * must satisfy before it becomes a resident tool.
 *
 * Contact is senses + hands against the actual day (Mac, house, phone,
 * browser, artifacts, conversations). Intelligence already exists.
 */

export type ContactSideEffect = 'read' | 'write' | 'external-send' | 'physical';

export type ContactAuthority =
  | 'autonomous'
  | 'confirm'
  | 'policy';

export type ContactPrivacy = 'internal' | 'personal' | 'sensitive';

export interface ContactCapability {
  id: string;
  source: string;
  version: string;
  sideEffect: ContactSideEffect;
  authority: ContactAuthority;
  privacy: ContactPrivacy;
  dryRun: boolean;
  verification: 'none' | 'state' | 'snapshot' | 'delivery';
}

export interface ContactReceipt {
  schema: 'home23.contact-receipt.v1';
  id: string;
  ts: string;
  agent: string;
  chatId: string;
  capability: string;
  sideEffect: ContactSideEffect;
  authority: ContactAuthority;
  dryRun: boolean;
  confirmed: boolean;
  ok: boolean;
  summary: string;
  before?: unknown;
  after?: unknown;
  verified?: boolean;
  error?: string;
  metadata?: Record<string, unknown>;
}

export type AttentionKind =
  | 'event'
  | 'message'
  | 'person'
  | 'commitment'
  | 'deadline'
  | 'attachment'
  | 'thread'
  | 'artifact';

export interface AttentionItem {
  kind: AttentionKind;
  id: string;
  title: string;
  when?: string;
  who?: string;
  source: string;
  needsOwner?: boolean;
  waitingOn?: string;
  projectHint?: string;
  excerpt?: string;
}

export type HouseLane = 'autonomous' | 'policy' | 'forbidden';

export interface HouseEntityState {
  entity_id: string;
  name: string;
  state: string;
  domain: string;
  updated_at?: string;
  attributes?: Record<string, unknown>;
}

export interface ArtifactRecord {
  id: string;
  archivedAt: string;
  originalName: string;
  originalPath: string;
  archivePath: string;
  mimeGuess: string;
  bytes: number;
  project?: string;
  excerpt?: string;
  actionCandidates: string[];
}
