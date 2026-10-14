export interface OwnerConversationPolicyInput {
  chatId?: unknown;
  sessionId?: unknown;
  sessionRefs?: unknown;
  sourceRefs?: unknown;
  text?: unknown;
  metadata?: unknown;
  provenance?: unknown;
  verification?: unknown;
  nonOwner?: unknown;
  owner?: unknown;
  source?: unknown;
}
export interface OwnerConversationClassification {
  kind: 'substantive' | 'verification' | 'recap' | 'mention';
  verification: boolean;
  ownerEvidence: boolean;
  reasons: string[];
}
export function classifyOwnerConversation(input?: OwnerConversationPolicyInput): OwnerConversationClassification;
export function hasConversationTimeIntent(query: unknown): boolean;
