export type OfficeRole = 'headquarters' | 'continuity';
export type OfficeHealth = 'healthy' | 'unavailable';

export type ContinuityCapability =
  | 'conversation'
  | 'continuity_work'
  | 'local_only_work'
  | 'private_brain'
  | 'household_credentials'
  | 'household_machinery';

export type ContinuityWorkKind = 'continuity_capable' | 'local_only';

export type ContinuityWorkState = 'queued' | 'running' | 'succeeded' | 'failed';

export type ContinuityPresentation =
  | 'accepted by a continuity office'
  | 'waiting for headquarters'
  | 'succeeded';

export interface ContinuityOwner {
  token: string;
  principalId: string;
  displayName: string;
}

export interface IsolatedContinuityOfficeOptions {
  now?: () => Date;
  owner?: ContinuityOwner;
}

export interface OfficeRecord {
  officeId: string;
  role: OfficeRole;
  health: OfficeHealth;
  capabilities: readonly ContinuityCapability[];
  holderInstanceId: string;
}

export interface ContinuityIngressRequest {
  token: string;
  channelId: string;
  clientMessageId: string;
  text: string;
}

export interface ContinuityIngressResult {
  accepted: boolean;
  reason?: 'unauthenticated';
  officeId?: string;
  messageId?: string;
  kind?: 'text';
  presentation?: ContinuityPresentation;
  replayed?: boolean;
}

export interface ContinuityMessage {
  messageId: string;
  channelId: string;
  clientMessageId: string;
  kind: 'text';
  text: string;
  authorPrincipalId: string;
  officeId: string;
  createdAt: string;
}

export interface ContinuityConversationTurn {
  messageId: string;
  role: 'owner' | 'resident';
  text: string;
  at: string;
}

export interface ContinuityActiveWorkSummary {
  workId: string;
  kind: ContinuityWorkKind;
  state: string;
  originMessageId: string;
}

export interface ContinuityAuthorityLimits {
  canWriteCanonical: boolean;
  allowedWorkKinds: readonly ContinuityWorkKind[];
  forbiddenExports: readonly ('private_brain' | 'household_credentials')[];
}

export interface ContinuityFreshness {
  contextRevision: number;
  capturedAt: string;
  sourceCursor: string;
}

export interface BoundedContinuityContextInput {
  charterSummary: string;
  relationshipSummary: string;
  recentConversation: readonly ContinuityConversationTurn[];
  activeWork: readonly ContinuityActiveWorkSummary[];
  authorityLimits: ContinuityAuthorityLimits;
  freshness: ContinuityFreshness;
}

export interface BoundedContinuityContext extends BoundedContinuityContextInput {
  recentConversation: readonly ContinuityConversationTurn[];
}

export interface ContinuityWorkAdmitRequest {
  kind: ContinuityWorkKind;
  channelId: string;
  originMessageId: string;
  instruction: string;
  requestId: string;
  correlationId: string;
  epoch: number;
  fencingToken: number;
}

export interface ContinuityWorkRecord {
  workId: string;
  kind: ContinuityWorkKind;
  state: ContinuityWorkState;
  presentation: ContinuityPresentation;
  officeId: string;
  channelId: string;
  originMessageId: string;
  instruction: string;
  attemptId: string | null;
  leaseId: string | null;
  fencingToken: number | null;
  resultText: string | null;
  resultDigest: string | null;
  contextRevision?: number;
  createdAt: string;
  updatedAt: string;
}

export interface CompleteContinuityWorkInput {
  workId: string;
  resultText: string;
  requestId: string;
  correlationId: string;
  epoch: number;
  fencingToken: number;
}

export interface CanonicalWriteAuthority {
  officeId: string;
  epoch: number;
  fencingToken: number;
  leaseId: string;
  holderInstanceId: string;
}

export interface TakeoverInput {
  officeId: string;
  expectedEpoch: number;
}

export interface OfficeFenceBinding {
  officeId: string;
  epoch: number;
  fencingToken: number;
}

export interface ReconciliationDelivery {
  workId: string;
  kind: 'result';
  idempotencyKey: string;
  resultDigest: string;
  replayed: boolean;
}

export interface ReconciliationResult {
  authority: CanonicalWriteAuthority;
  deliveries: readonly ReconciliationDelivery[];
  waitingWorkIds: readonly string[];
  newlyDeliveredCount: number;
}

export interface IsolatedContinuityOffice {
  registerOffice(declaration: OfficeRecord): OfficeRecord;
  declareCapabilities(
    officeId: string,
    capabilities: readonly ContinuityCapability[],
  ): OfficeRecord;
  setOfficeHealth(officeId: string, health: OfficeHealth): OfficeRecord;
  listOffices(): readonly OfficeRecord[];
  office(officeId: string): OfficeRecord | undefined;
  acceptIngress(request: ContinuityIngressRequest): ContinuityIngressResult;
  message(messageId: string): ContinuityMessage | undefined;
  messageCount(): number;
  seedContext(input: BoundedContinuityContextInput): BoundedContinuityContext;
  context(): BoundedContinuityContext | undefined;
  admitWork(request: ContinuityWorkAdmitRequest): ContinuityWorkRecord;
  completeContinuityWork(input: CompleteContinuityWorkInput): ContinuityWorkRecord;
  work(workId: string): ContinuityWorkRecord | undefined;
  currentAuthority(): CanonicalWriteAuthority;
  takeoverCanonicalWrite(input: TakeoverInput): CanonicalWriteAuthority;
  assertCanonicalWrite(binding: OfficeFenceBinding): void;
  reconcileHeadquartersReturn(): ReconciliationResult;
}
