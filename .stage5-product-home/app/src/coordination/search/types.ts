import type {
  MessagingActorContext,
  MessagingParticipantDirectory,
  ResolvedMessagingActor,
} from "../channels/index.js";
import type { SqliteValue } from "../db/index.js";

export type SearchScope =
  | { kind: "all" }
  | { kind: "channel"; channelId: string };

export interface SearchCanary {
  id: string;
  messageId: string;
  channelId: string;
  query: string;
}

export interface SearchResult {
  type: "message";
  id: string;
  conversationId: string;
  channelId: string;
  title: string;
  excerpt: string;
  sequence: number;
  createdAt: string;
}

export interface SearchBoundary {
  createdAt: string;
  messageId: string;
}

export interface SearchCompleteness {
  status: "complete" | "partial";
  respondingRoute: "/api/v1/search";
  authoritativeSource: "coordination.messages";
  sourceEventSequence: number;
  indexRoute: "sqlite_fts5";
  indexedThroughEventSequence: number;
  crossingProof: {
    sourceRows: number;
    indexedRows: number;
    checkedAt: string;
  };
  filters: {
    principalId: string;
    scope: "all" | "channel";
    channelId: string | null;
    sourceClasses: readonly ["coordination.messages"];
    membership: "active";
    visibility: "visible_not_tombstoned";
  };
  samePathCanary: {
    id: string;
    found: boolean;
    checkedAt: string;
  };
  importCoverage: { bodyImported: 0; referenceOnly: 0 };
  verdict: "complete" | "scoped_empty" | "route_blind";
  reason: string;
}

export interface SearchRepositoryResult {
  results: readonly SearchResult[];
  nextBoundary: SearchBoundary | null;
  completeness: SearchCompleteness;
  throughEventSequence: number;
}

export interface CanonicalSearchDatabase {
  readOne<T>(sql: string, ...parameters: SqliteValue[]): T | undefined;
  readAll<T>(sql: string, ...parameters: SqliteValue[]): T[];
}

export interface CanonicalSearchRepository {
  search(input: {
    actor: ResolvedMessagingActor;
    query: string;
    ftsQuery: string;
    scope: SearchScope;
    boundary: SearchBoundary | null;
    limit: number;
    canary: SearchCanary | null;
    checkedAt: string;
  }): SearchRepositoryResult;
}

export interface CreateCanonicalSearchServiceOptions {
  repository: CanonicalSearchRepository;
  participantDirectory: MessagingParticipantDirectory;
  cursorSigningKey: Buffer;
  resolveCanary(input: {
    principalId: string;
    scope: SearchScope;
  }): SearchCanary | null;
  now?: () => Date;
}

export interface CanonicalSearchResponse {
  requestId: string;
  correlationId: string;
  query: string;
  scope: string;
  results: readonly SearchResult[];
  nextCursor: string | null;
  completeness: SearchCompleteness;
  throughEventSequence: number;
}

export interface CanonicalSearchService {
  search(input: {
    context: MessagingActorContext;
    query: string;
    scope: SearchScope;
    cursor: string | null;
    limit: number;
  }): Promise<CanonicalSearchResponse>;
}
