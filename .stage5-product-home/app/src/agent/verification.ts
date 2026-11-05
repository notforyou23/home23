/**
 * VerificationFlag — the evidence contract for every observation flowing
 * through the OS engine's channel bus.
 *
 * COLLECTED     — direct evidence from a primary source; crystallize freely.
 * UNCERTIFIED   — derived, filtered, or second-hand; crystallize at reduced
 *                 confidence (never above 0.6 for UNCERTIFIED-flagged work).
 * ZERO_CONTEXT  — the channel was queried and returned nothing. A legal
 *                 terminal output, not a license to invent fact.
 * UNKNOWN       — the channel failed (network, parse, permission). Not
 *                 crystallized; bus retries with jitter.
 *
 * See docs/design/STEP24-OS-ENGINE-REDESIGN.md §The Verification Gate.
 */
export enum VerificationFlag {
  COLLECTED = 'COLLECTED',
  UNCERTIFIED = 'UNCERTIFIED',
  ZERO_CONTEXT = 'ZERO_CONTEXT',
  UNKNOWN = 'UNKNOWN',
}

export interface VerifiedObservation<T = unknown> {
  channelId: string;
  sourceRef: string;
  receivedAt: string;
  producedAt: string;
  flag: VerificationFlag;
  confidence: number;
  payload: T;
  verifierId?: string | null;
}

const FLAG_VALUES = new Set<string>(Object.values(VerificationFlag));

export function isVerifiedObservation(x: unknown): x is VerifiedObservation {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.channelId === 'string' &&
    typeof o.sourceRef === 'string' &&
    typeof o.receivedAt === 'string' &&
    typeof o.producedAt === 'string' &&
    typeof o.confidence === 'number' &&
    typeof o.flag === 'string' &&
    FLAG_VALUES.has(o.flag as string)
  );
}

export function isZeroContext(obs: Pick<VerifiedObservation, 'flag'>): boolean {
  return obs.flag === VerificationFlag.ZERO_CONTEXT;
}

export function isCollected(obs: Pick<VerifiedObservation, 'flag'>): boolean {
  return obs.flag === VerificationFlag.COLLECTED;
}
