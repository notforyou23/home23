export interface FeedbackClaim {
  claim: string;
  predictionId?: string;
  createdAt?: string;
  resolvedAt?: string;
  error?: number;
  evidenceRefs?: string[];
  revisesPredictionIds?: string[];
  revisionReason?: string;
  revisionEvidence?: RevisionEvidence;
  claimKind?: 'owner.said' | 'owner.wants' | 'owner.decided';
  ownerEvidence?: FeedbackRef[];
  outcomeCriterion?: 'world' | 'execution' | 'owner-value';
  resolutionEvidence?: { version: 1; verificationStatus?: 'assessed' | 'verified';
    criterion: 'world' | 'execution' | 'owner-value'; reason: string; refs: FeedbackRef[] };
}
export interface FeedbackRef {
  refId?: string;
  sourceRef?: string;
  sourceAuthority?: string;
  flag?: string;
  observedAt?: string;
  head?: string;
  messageId?: string;
  principal?: 'owner';
  teachingAuthority?: 'owner' | 'agent';
  executionOutcome?: {
    schema: 'home23.execution-outcome.v1';
    executionKind: 'action' | 'work';
    status: string;
    verificationStatus: 'unknown' | 'verified';
    receiptEventId: string;
    evidenceRefs: string[];
    taskOutcomeVerified?: boolean;
  };
}
export interface RevisionEvidence {
  version: 1;
  admissionVersion?: 2;
  admittedAt: string;
  failedPredictionIds: string[];
  refs: FeedbackRef[];
}
export interface FeedbackCell {
  predictions?: FeedbackClaim[];
  realityRefs?: FeedbackRef[];
}
export interface ClaimFeedback {
  relatedPredictions: FeedbackClaim[];
  failedPredictions: FeedbackClaim[];
  latestFailureAt: string | null;
  repeatedFailure: boolean;
  hasSupportedRevision: boolean;
  failedHypothesis: boolean;
  freshEvidenceRefs: string[];
}
export function claimsRelated(a: string | FeedbackClaim, b: string | FeedbackClaim): boolean;
export function getClaimFeedback(cell: FeedbackCell, candidate: string | FeedbackClaim): ClaimFeedback;

export function isExternalEvidenceRef(ref: FeedbackRef, criterion?: 'world' | 'execution' | 'owner-value'): boolean;
