export {
  CANONICAL_SEARCH_FAILURE_MATRIX,
  CanonicalSearchError,
  type CanonicalSearchErrorCode,
} from "./errors.js";
export { SqliteCanonicalSearchRepository, toFtsQuery } from "./repository.js";
export {
  CANONICAL_SEARCH_SCHEMA_DELTA_CANONICAL_JSON,
  CANONICAL_SEARCH_INDEX_REBUILD_SQL,
  CANONICAL_SEARCH_SCHEMA_DELTA_PROPOSAL,
  CANONICAL_SEARCH_SCHEMA_DELTA_SHA256,
  CANONICAL_SEARCH_SCHEMA_DELTA_SQL,
  computeCanonicalSearchSchemaDeltaDigest,
} from "./schema-delta.js";
export { createCanonicalSearchService } from "./service.js";
export type {
  CanonicalSearchDatabase,
  CanonicalSearchRepository,
  CanonicalSearchResponse,
  CanonicalSearchService,
  CreateCanonicalSearchServiceOptions,
  SearchBoundary,
  SearchCanary,
  SearchCompleteness,
  SearchRepositoryResult,
  SearchResult,
  SearchScope,
} from "./types.js";
