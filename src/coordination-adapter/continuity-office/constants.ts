import type { ContinuityCapability } from './types.js';

export const HEADQUARTERS_OFFICE_ID = 'headquarters';
export const CONTINUITY_OFFICE_ID = 'continuity-office';

export const WAITING_FOR_HEADQUARTERS = 'waiting for headquarters' as const;
export const ACCEPTED_BY_CONTINUITY_OFFICE = 'accepted by a continuity office' as const;

export const MAX_RECENT_CONVERSATION = 16;

export const FORBIDDEN_CONTINUITY_CAPABILITIES: readonly ContinuityCapability[] = Object.freeze([
  'private_brain',
  'household_credentials',
  'household_machinery',
]);

export const PRIVATE_EXPORT_KEYS = Object.freeze(['privateBrain', 'householdCredentials']);

export const WORK_RESULT_IDEMPOTENCY_PREFIX = 'work-result:';
