import { createHash } from 'node:crypto';
import {
  ACCEPTED_BY_CONTINUITY_OFFICE,
  CONTINUITY_OFFICE_ID,
  FORBIDDEN_CONTINUITY_CAPABILITIES,
  HEADQUARTERS_OFFICE_ID,
  MAX_RECENT_CONVERSATION,
  PRIVATE_EXPORT_KEYS,
  WAITING_FOR_HEADQUARTERS,
} from './constants.js';
import { workResultIdempotencyKey } from './contract-map.js';
import { ContinuityOfficeError } from './errors.js';
import type {
  BoundedContinuityContext,
  BoundedContinuityContextInput,
  CanonicalWriteAuthority,
  CompleteContinuityWorkInput,
  ContinuityCapability,
  ContinuityIngressRequest,
  ContinuityIngressResult,
  ContinuityMessage,
  ContinuityOwner,
  ContinuityWorkAdmitRequest,
  ContinuityWorkRecord,
  IsolatedContinuityOffice,
  IsolatedContinuityOfficeOptions,
  OfficeFenceBinding,
  OfficeHealth,
  OfficeRecord,
  ReconciliationDelivery,
  TakeoverInput,
} from './types.js';

const DEFAULT_OWNER: ContinuityOwner = Object.freeze({
  token: 'owner-token',
  principalId: 'principal_owner',
  displayName: 'jtr',
});

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function freezeOffice(office: OfficeRecord): OfficeRecord {
  return Object.freeze({
    ...office,
    capabilities: Object.freeze([...office.capabilities]),
  });
}

function freezeWork(work: ContinuityWorkRecord): ContinuityWorkRecord {
  return Object.freeze({ ...work });
}

function freezeAuthority(authority: CanonicalWriteAuthority): CanonicalWriteAuthority {
  return Object.freeze({ ...authority });
}

function assertKnownOffice(offices: Map<string, OfficeRecord>, officeId: string): OfficeRecord {
  const office = offices.get(officeId);
  if (!office) {
    throw new ContinuityOfficeError('unknown_office', `unknown office ${officeId}`);
  }
  return office;
}

function assertContinuityCapabilities(
  role: OfficeRecord['role'],
  capabilities: readonly ContinuityCapability[],
): void {
  if (role !== 'continuity') return;
  const forbidden = capabilities.find((capability) => (
    FORBIDDEN_CONTINUITY_CAPABILITIES.includes(capability)
  ));
  if (forbidden) {
    throw new ContinuityOfficeError(
      'illegal_capability',
      `continuity office cannot declare ${forbidden}`,
    );
  }
}

function rejectPrivateExport(input: object): void {
  for (const key of PRIVATE_EXPORT_KEYS) {
    if (Object.hasOwn(input, key)) {
      throw new ContinuityOfficeError(
        'private_export_forbidden',
        'continuity context cannot export the private brain or household credentials',
      );
    }
  }
}

export function createIsolatedContinuityOffice(
  options: IsolatedContinuityOfficeOptions = {},
): IsolatedContinuityOffice {
  const now = options.now ?? (() => new Date());
  const owner = options.owner ?? DEFAULT_OWNER;
  const offices = new Map<string, OfficeRecord>([
    [HEADQUARTERS_OFFICE_ID, freezeOffice({
      officeId: HEADQUARTERS_OFFICE_ID,
      role: 'headquarters',
      health: 'healthy',
      capabilities: ['conversation', 'continuity_work', 'local_only_work'],
      holderInstanceId: 'office:headquarters',
    })],
    [CONTINUITY_OFFICE_ID, freezeOffice({
      officeId: CONTINUITY_OFFICE_ID,
      role: 'continuity',
      health: 'healthy',
      capabilities: ['conversation', 'continuity_work'],
      holderInstanceId: 'office:continuity-office',
    })],
  ]);
  const messages = new Map<string, ContinuityMessage>();
  const messagesByClient = new Map<string, string>();
  const works = new Map<string, ContinuityWorkRecord>();
  const deliveredResultKeys = new Set<string>();
  let snapshot: BoundedContinuityContext | undefined;
  let authority: CanonicalWriteAuthority = freezeAuthority({
    officeId: HEADQUARTERS_OFFICE_ID,
    epoch: 1,
    fencingToken: 1,
    leaseId: 'lease_authority_1',
    holderInstanceId: 'office:headquarters',
  });
  let nextMessage = 1;
  let nextWork = 1;
  let nextAttempt = 1;
  let nextLease = 1;

  function timestamp(): string {
    return now().toISOString();
  }

  function nextId(prefix: string, value: number): string {
    return `${prefix}_${String(value).padStart(8, '0')}`;
  }

  function requireCanonicalWrite(officeId: string): void {
    if (authority.officeId !== officeId) {
      throw new ContinuityOfficeError(
        'stale_fence',
        `${officeId} does not hold canonical write authority`,
      );
    }
  }

  const api: IsolatedContinuityOffice = {
    registerOffice(declaration) {
      assertContinuityCapabilities(declaration.role, declaration.capabilities);
      const record = freezeOffice(declaration);
      offices.set(record.officeId, record);
      return record;
    },

    declareCapabilities(officeId, capabilities) {
      const current = assertKnownOffice(offices, officeId);
      assertContinuityCapabilities(current.role, capabilities);
      const updated = freezeOffice({ ...current, capabilities });
      offices.set(officeId, updated);
      return updated;
    },

    setOfficeHealth(officeId, health: OfficeHealth) {
      const current = assertKnownOffice(offices, officeId);
      const updated = freezeOffice({ ...current, health });
      offices.set(officeId, updated);
      return updated;
    },

    listOffices() {
      return Object.freeze([...offices.values()].map((entry) => freezeOffice(entry)));
    },

    office(officeId) {
      const record = offices.get(officeId);
      return record ? freezeOffice(record) : undefined;
    },

    acceptIngress(request: ContinuityIngressRequest): ContinuityIngressResult {
      if (request.token !== owner.token) {
        return Object.freeze({ accepted: false, reason: 'unauthenticated' });
      }
      const clientKey = `${request.channelId}::${request.clientMessageId}`;
      const existingId = messagesByClient.get(clientKey);
      if (existingId) {
        return Object.freeze({
          accepted: true,
          officeId: CONTINUITY_OFFICE_ID,
          messageId: existingId,
          kind: 'text',
          presentation: ACCEPTED_BY_CONTINUITY_OFFICE,
          replayed: true,
        });
      }
      const messageId = nextId('msg', nextMessage++);
      const message: ContinuityMessage = Object.freeze({
        messageId,
        channelId: request.channelId,
        clientMessageId: request.clientMessageId,
        kind: 'text',
        text: request.text,
        authorPrincipalId: owner.principalId,
        officeId: CONTINUITY_OFFICE_ID,
        createdAt: timestamp(),
      });
      messages.set(messageId, message);
      messagesByClient.set(clientKey, messageId);
      return Object.freeze({
        accepted: true,
        officeId: CONTINUITY_OFFICE_ID,
        messageId,
        kind: 'text',
        presentation: ACCEPTED_BY_CONTINUITY_OFFICE,
        replayed: false,
      });
    },

    message(messageId) {
      return messages.get(messageId);
    },

    messageCount() {
      return messages.size;
    },

    seedContext(input: BoundedContinuityContextInput) {
      rejectPrivateExport(input);
      const recent = input.recentConversation.slice(-MAX_RECENT_CONVERSATION);
      snapshot = Object.freeze({
        charterSummary: input.charterSummary,
        relationshipSummary: input.relationshipSummary,
        recentConversation: Object.freeze(recent.map((turn) => Object.freeze({ ...turn }))),
        activeWork: Object.freeze(input.activeWork.map((work) => Object.freeze({ ...work }))),
        authorityLimits: Object.freeze({
          ...input.authorityLimits,
          allowedWorkKinds: Object.freeze([...input.authorityLimits.allowedWorkKinds]),
          forbiddenExports: Object.freeze([...input.authorityLimits.forbiddenExports]),
        }),
        freshness: Object.freeze({ ...input.freshness }),
      });
      return snapshot;
    },

    context() {
      return snapshot;
    },

    admitWork(request: ContinuityWorkAdmitRequest) {
      requireCanonicalWrite(CONTINUITY_OFFICE_ID);
      const createdAt = timestamp();
      const workId = nextId('work', nextWork++);
      const base = {
        workId,
        kind: request.kind,
        officeId: CONTINUITY_OFFICE_ID,
        channelId: request.channelId,
        originMessageId: request.originMessageId,
        instruction: request.instruction,
        resultText: null,
        resultDigest: null,
        contextRevision: snapshot?.freshness.contextRevision,
        createdAt,
        updatedAt: createdAt,
      };
      const record = request.kind === 'local_only'
        ? freezeWork({
            ...base,
            state: 'queued',
            presentation: WAITING_FOR_HEADQUARTERS,
            attemptId: null,
            leaseId: null,
            fencingToken: null,
          })
        : freezeWork({
            ...base,
            state: 'running',
            presentation: ACCEPTED_BY_CONTINUITY_OFFICE,
            attemptId: nextId('attempt', nextAttempt++),
            leaseId: nextId('lease', nextLease++),
            fencingToken: authority.fencingToken,
          });
      works.set(workId, record);
      return record;
    },

    completeContinuityWork(input: CompleteContinuityWorkInput) {
      requireCanonicalWrite(CONTINUITY_OFFICE_ID);
      const current = works.get(input.workId);
      if (!current) {
        throw new ContinuityOfficeError('not_found', `unknown work ${input.workId}`);
      }
      if (current.kind !== 'continuity_capable' || current.state !== 'running') {
        throw new ContinuityOfficeError(
          'illegal_state',
          'local-only work cannot be completed by the continuity office',
        );
      }
      const completed = freezeWork({
        ...current,
        state: 'succeeded',
        presentation: 'succeeded',
        resultText: input.resultText,
        resultDigest: digest(input.resultText),
        updatedAt: timestamp(),
      });
      works.set(input.workId, completed);
      return completed;
    },

    work(workId) {
      const record = works.get(workId);
      return record ? freezeWork(record) : undefined;
    },

    currentAuthority() {
      return freezeAuthority(authority);
    },

    takeoverCanonicalWrite(input: TakeoverInput) {
      const requester = assertKnownOffice(offices, input.officeId);
      if (input.expectedEpoch !== authority.epoch) {
        throw new ContinuityOfficeError('stale_fence', 'office epoch is stale');
      }
      const holder = assertKnownOffice(offices, authority.officeId);
      if (requester.officeId !== authority.officeId && holder.health === 'healthy') {
        throw new ContinuityOfficeError(
          holder.officeId === HEADQUARTERS_OFFICE_ID ? 'headquarters_available' : 'illegal_state',
          'a healthy office already holds canonical write authority',
        );
      }
      if (requester.health === 'unavailable') {
        throw new ContinuityOfficeError('illegal_state', 'an unavailable office cannot take the pen');
      }
      authority = freezeAuthority({
        officeId: requester.officeId,
        epoch: authority.epoch + 1,
        fencingToken: authority.fencingToken + 1,
        leaseId: nextId('lease', nextLease++),
        holderInstanceId: requester.holderInstanceId,
      });
      return freezeAuthority(authority);
    },

    assertCanonicalWrite(binding: OfficeFenceBinding) {
      if (
        binding.officeId !== authority.officeId
        || binding.epoch !== authority.epoch
        || binding.fencingToken !== authority.fencingToken
      ) {
        throw new ContinuityOfficeError('stale_fence', 'office fence is stale');
      }
    },

    reconcileHeadquartersReturn() {
      const headquarters = assertKnownOffice(offices, HEADQUARTERS_OFFICE_ID);
      if (headquarters.health !== 'healthy') {
        throw new ContinuityOfficeError(
          'illegal_state',
          'headquarters must be healthy before reconciliation',
        );
      }
      if (authority.officeId !== HEADQUARTERS_OFFICE_ID) {
        authority = freezeAuthority({
          officeId: HEADQUARTERS_OFFICE_ID,
          epoch: authority.epoch + 1,
          fencingToken: authority.fencingToken + 1,
          leaseId: nextId('lease', nextLease++),
          holderInstanceId: headquarters.holderInstanceId,
        });
      }
      const deliveries: ReconciliationDelivery[] = [];
      const waitingWorkIds: string[] = [];
      let newlyDeliveredCount = 0;
      for (const record of works.values()) {
        if (record.presentation === WAITING_FOR_HEADQUARTERS) {
          waitingWorkIds.push(record.workId);
          continue;
        }
        if (record.state !== 'succeeded' || !record.resultDigest) continue;
        const idempotencyKey = workResultIdempotencyKey(record.workId);
        const replayed = deliveredResultKeys.has(idempotencyKey);
        if (!replayed) {
          deliveredResultKeys.add(idempotencyKey);
          newlyDeliveredCount += 1;
        }
        deliveries.push(Object.freeze({
          workId: record.workId,
          kind: 'result',
          idempotencyKey,
          resultDigest: record.resultDigest,
          replayed,
        }));
      }
      return Object.freeze({
        authority: freezeAuthority(authority),
        deliveries: Object.freeze(deliveries),
        waitingWorkIds: Object.freeze(waitingWorkIds),
        newlyDeliveredCount,
      });
    },
  };

  return Object.freeze(api);
}
