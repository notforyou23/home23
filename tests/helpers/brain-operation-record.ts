import type {
  BrainCatalogEntry,
  BrainOperationRecord,
  CanonicalBrainOperationTarget,
} from '../../src/agent/brain-operations/types.js';

type MutationBoundaries = BrainCatalogEntry['mutationBoundaries'];
type OperationTarget = BrainOperationRecord['target'];

function mutationBoundaries(root: string, brainRoot = root): MutationBoundaries {
  return [
    { kind: 'brain', path: brainRoot },
    { kind: 'run', path: root },
    { kind: 'pgs', path: `${root}/pgs-sessions` },
    { kind: 'session', path: `${root}/sessions` },
    { kind: 'cache', path: `${root}/cache` },
    { kind: 'export', path: `${root}/exports` },
    { kind: 'agency', path: `${root}/agency` },
  ];
}

function displayName(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

export function canonicalCatalogEntry(agent: string): BrainCatalogEntry {
  const canonicalRoot = `/fixture/${agent}`;
  return {
    id: `brain-${agent}`,
    displayName: displayName(agent),
    ownerAgent: agent,
    kind: 'resident',
    lifecycle: 'resident',
    canonicalRoot,
    sourceType: 'resident',
    nodeCount: 42,
    modifiedAt: '2026-07-09T12:00:00.000Z',
    route: `/api/brain/brain-${agent}`,
    mutationBoundaries: mutationBoundaries(canonicalRoot),
  };
}

export function canonicalBrainTarget(
  agent: string,
  accessMode: CanonicalBrainOperationTarget['accessMode'],
): CanonicalBrainOperationTarget {
  const entry = canonicalCatalogEntry(agent);
  return {
    domain: 'brain',
    brainId: entry.id,
    ownerAgent: entry.ownerAgent,
    displayName: entry.displayName,
    kind: entry.kind,
    lifecycle: entry.lifecycle,
    catalogRevision: 'catalog-fixture',
    route: entry.route,
    canonicalRoot: entry.canonicalRoot,
    accessMode,
    mutationBoundaries: entry.mutationBoundaries.map((boundary) => ({ ...boundary })),
  };
}

export function canonicalResearchTarget(brainId: string): CanonicalBrainOperationTarget {
  const canonicalRoot = `/fixture/research/${brainId}`;
  return {
    domain: 'brain',
    brainId,
    ownerAgent: null,
    displayName: `Research ${brainId}`,
    kind: 'research',
    lifecycle: 'completed',
    catalogRevision: 'catalog-fixture',
    route: `/api/brain/${brainId}`,
    canonicalRoot,
    accessMode: 'read-only',
    mutationBoundaries: mutationBoundaries(canonicalRoot, `${canonicalRoot}/brain`),
  };
}

export function canonicalOwnedRunTarget(runId: string): Extract<OperationTarget, { domain: 'owned-run' }> {
  const canonicalRoot = `/fixture/runs/${runId}`;
  return {
    domain: 'owned-run',
    runId,
    canonicalRoot,
    ownerAgent: 'jerry',
    runState: 'active',
    catalogRevision: 'catalog-fixture',
    route: `/api/research/runs/${runId}`,
    mutationBoundaries: mutationBoundaries(canonicalRoot, `${canonicalRoot}/brain`),
  };
}

function cloneTarget(target: OperationTarget): OperationTarget {
  if (target.domain === 'brain') {
    return {
      domain: 'brain',
      brainId: target.brainId,
      ownerAgent: target.ownerAgent,
      displayName: target.displayName,
      kind: target.kind,
      lifecycle: target.lifecycle,
      catalogRevision: target.catalogRevision,
      route: target.route,
      canonicalRoot: target.canonicalRoot,
      accessMode: target.accessMode,
      mutationBoundaries: target.mutationBoundaries.map((boundary) => ({ ...boundary })),
    };
  }
  if (target.domain === 'owned-run') {
    return {
      domain: 'owned-run',
      runId: target.runId,
      canonicalRoot: target.canonicalRoot,
      ownerAgent: target.ownerAgent,
      runState: target.runState,
      catalogRevision: target.catalogRevision,
      route: target.route,
      mutationBoundaries: target.mutationBoundaries.map((boundary) => ({ ...boundary })),
    };
  }
  return { domain: 'requester', requesterAgent: target.requesterAgent };
}

export type BrainOperationRecordOverrides = Partial<Omit<BrainOperationRecord, 'target'>> & {
  target?: OperationTarget;
};

export function makeBrainOperationRecord(
  overrides: BrainOperationRecordOverrides = {},
): BrainOperationRecord {
  const base = {
    operationId: 'brop_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    requestId: 'request-fixture',
    operationType: 'query',
    requestParameters: { query: 'fixture query' },
    parameters: { query: 'fixture query' },
    canonicalEvidence: true,
    recordVersion: 1,
    eventSequence: 1,
    requesterAgent: 'jerry',
    target: canonicalBrainTarget('jerry', 'own'),
    state: 'running',
    phase: 'provider',
    startedAt: '2026-07-09T12:00:00.000Z',
    updatedAt: '2026-07-09T12:00:01.000Z',
    completedAt: null,
    lastProviderActivityAt: '2026-07-09T12:00:01.000Z',
    lastProgressAt: null,
    result: null,
    resultHandle: null,
    resultArtifact: null,
    error: null,
    sourceEvidence: null,
    sourcePinDescriptor: null,
    sourcePinDigest: null,
    sourcePinReleasedAt: null,
    resultExpiresAt: null,
    resultExpiredAt: null,
    metadataExpiresAt: null,
  } satisfies BrainOperationRecord;
  const value = {
    operationId: overrides.operationId ?? base.operationId,
    requestId: overrides.requestId ?? base.requestId,
    operationType: overrides.operationType ?? base.operationType,
    requestParameters: overrides.requestParameters ?? base.requestParameters,
    parameters: overrides.parameters ?? base.parameters,
    canonicalEvidence: overrides.canonicalEvidence ?? base.canonicalEvidence,
    recordVersion: overrides.recordVersion ?? base.recordVersion,
    eventSequence: overrides.eventSequence ?? base.eventSequence,
    requesterAgent: overrides.requesterAgent ?? base.requesterAgent,
    target: cloneTarget(overrides.target ?? base.target),
    state: overrides.state ?? base.state,
    phase: Object.hasOwn(overrides, 'phase') ? overrides.phase! : base.phase,
    startedAt: Object.hasOwn(overrides, 'startedAt') ? overrides.startedAt! : base.startedAt,
    updatedAt: overrides.updatedAt ?? base.updatedAt,
    completedAt: Object.hasOwn(overrides, 'completedAt') ? overrides.completedAt! : base.completedAt,
    lastProviderActivityAt: Object.hasOwn(overrides, 'lastProviderActivityAt')
      ? overrides.lastProviderActivityAt! : base.lastProviderActivityAt,
    lastProgressAt: Object.hasOwn(overrides, 'lastProgressAt')
      ? overrides.lastProgressAt! : base.lastProgressAt,
    result: Object.hasOwn(overrides, 'result') ? overrides.result! : base.result,
    resultHandle: Object.hasOwn(overrides, 'resultHandle')
      ? overrides.resultHandle! : base.resultHandle,
    resultArtifact: Object.hasOwn(overrides, 'resultArtifact')
      ? overrides.resultArtifact! : base.resultArtifact,
    error: Object.hasOwn(overrides, 'error') ? overrides.error! : base.error,
    sourceEvidence: Object.hasOwn(overrides, 'sourceEvidence')
      ? overrides.sourceEvidence! : base.sourceEvidence,
    sourcePinDescriptor: Object.hasOwn(overrides, 'sourcePinDescriptor')
      ? overrides.sourcePinDescriptor! : base.sourcePinDescriptor,
    sourcePinDigest: Object.hasOwn(overrides, 'sourcePinDigest')
      ? overrides.sourcePinDigest! : base.sourcePinDigest,
    sourcePinReleasedAt: Object.hasOwn(overrides, 'sourcePinReleasedAt')
      ? overrides.sourcePinReleasedAt! : base.sourcePinReleasedAt,
    resultExpiresAt: Object.hasOwn(overrides, 'resultExpiresAt')
      ? overrides.resultExpiresAt! : base.resultExpiresAt,
    resultExpiredAt: Object.hasOwn(overrides, 'resultExpiredAt')
      ? overrides.resultExpiredAt! : base.resultExpiredAt,
    metadataExpiresAt: Object.hasOwn(overrides, 'metadataExpiresAt')
      ? overrides.metadataExpiresAt! : base.metadataExpiresAt,
  } satisfies BrainOperationRecord;
  return value;
}
