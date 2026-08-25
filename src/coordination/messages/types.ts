import type {
  MessagingParticipantDirectory,
  MessagingMutationReceipt,
  MessagingIdempotencyClaim,
  ResolvedMessagingActor,
} from "../channels/index.js";
import type { CoordinationTransaction } from "../db/index.js";

export type MessageKind = "text" | "system" | "result";
export type MessageVisibility = "visible" | "tombstoned";

export interface MessageAuthor {
  principalId: string;
  kind: "owner" | "bot";
  displayName: string;
}

export interface MessageProvenance {
  roundId: string | null;
  workId: string | null;
}

export interface PendingMessage {
  id: string;
  channelId: string;
  author: MessageAuthor;
  kind: MessageKind;
  text: string | null;
  mentions: readonly string[];
  clientMessageId: string | null;
  replyToMessageId: string | null;
  tombstonesMessageId: string | null;
  provenance: MessageProvenance;
  createdAt: string;
}

export interface MessageProjection extends PendingMessage {
  conversationId: string;
  sequence: number;
  attachments: readonly never[];
  visibility: MessageVisibility;
}

export interface AppendMessageCommit {
  message: PendingMessage;
  actor: ResolvedMessagingActor;
  idempotency: MessagingIdempotencyClaim;
}

export interface AppendMessageResult {
  outcome: "committed" | "replayed";
  message: MessageProjection;
  receipt: MessagingMutationReceipt;
}

export interface ListMessagesInput {
  channelId: string;
  actor: ResolvedMessagingActor;
  beforeSequence?: number;
  limit: number;
}

/**
 * M11 integration seam for non-null terminal provenance. M08 supplies no permissive
 * implementation: the Work owner must prove the exact actor/Channel/Round/Work binding
 * through the same M04 transaction that appends the Message.
 */
export interface MessageProvenanceAuthorizationTransactionPort {
  assertAuthorized(
    transaction: CoordinationTransaction,
    input: {
      actor: ResolvedMessagingActor;
      channelId: string;
      provenance: MessageProvenance;
    },
  ): void;
}

export interface ListMessagesResult {
  messages: readonly MessageProjection[];
  nextBeforeSequence: number | null;
}

export interface MessageRepository {
  appendMessage(input: AppendMessageCommit): Promise<AppendMessageResult>;
  listMessages(input: ListMessagesInput): Promise<ListMessagesResult>;
}

export interface CreateMessageServiceOptions {
  repository: MessageRepository;
  participantDirectory: MessagingParticipantDirectory;
  now?: () => Date;
}
