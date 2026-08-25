import type {
  MessagingIdempotencyClaim,
  MessagingMutationReceipt,
  MessagingParticipantDirectory,
  ResolvedMessagingActor,
} from "../channels/index.js";

export interface UnreadProjection {
  principalId: string;
  channelId: string;
  conversationId: string;
  readThroughSequence: number;
  unreadCount: number;
  latestSequence: number;
  version: number;
  updatedAt: string;
}

export interface InboxLatestMessage {
  id: string;
  sequence: number;
  preview: string | null;
  authorPrincipalId: string;
  createdAt: string;
}

export interface InboxConversation {
  id: string;
  channelId: string;
  kind: "direct" | "group";
  title: string;
  latestMessage: InboxLatestMessage | null;
  unread: {
    count: number;
    readThroughSequence: number;
  };
  activity: {
    state: "idle";
    label: null;
    workId: null;
  };
  pinned: boolean;
  archived: boolean;
  version: number;
  updatedAt: string;
}

export interface AdvanceReadCursorInput {
  actor: ResolvedMessagingActor;
  channelId: string;
  readThroughSequence: number;
  updatedAt: string;
  idempotency: MessagingIdempotencyClaim;
}

export interface AdvanceReadCursorResult {
  outcome: "committed" | "replayed";
  unread: UnreadProjection;
  receipt: MessagingMutationReceipt;
}

export interface UnreadRepository {
  getUnread(channelId: string, actor: ResolvedMessagingActor): Promise<UnreadProjection>;
  advanceReadCursor(input: AdvanceReadCursorInput): Promise<AdvanceReadCursorResult>;
  listInbox(actor: ResolvedMessagingActor): Promise<readonly InboxConversation[]>;
}

export interface CreateUnreadServiceOptions {
  repository: UnreadRepository;
  participantDirectory: MessagingParticipantDirectory;
  now?: () => Date;
}
