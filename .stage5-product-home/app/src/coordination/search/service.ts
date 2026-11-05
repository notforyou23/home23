import { createHash } from "node:crypto";

import { resolveMessagingActor } from "../channels/index.js";
import { assertCoordinationId } from "../ids/index.js";
import { SearchCursorCodec } from "./cursor.js";
import { CanonicalSearchError } from "./errors.js";
import { toFtsQuery } from "./repository.js";
import type {
  CanonicalSearchResponse,
  CanonicalSearchService,
  CreateCanonicalSearchServiceOptions,
} from "./types.js";

function canonicalQuery(value: string): string {
  if (typeof value !== "string") throw new CanonicalSearchError("request_invalid");
  const query = value.trim().replace(/\s+/gu, " ");
  if (query.length < 1 || query.length > 256) {
    throw new CanonicalSearchError("request_invalid");
  }
  return query;
}

export function createCanonicalSearchService(
  options: CreateCanonicalSearchServiceOptions,
): CanonicalSearchService {
  const now = options.now ?? (() => new Date());
  const cursorCodec = new SearchCursorCodec(options.cursorSigningKey);

  async function search(input: Parameters<CanonicalSearchService["search"]>[0]) {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new CanonicalSearchError("request_invalid");
    }
    if (input.scope.kind === "channel") {
      try {
        assertCoordinationId("channel", input.scope.channelId);
      } catch {
        throw new CanonicalSearchError("request_invalid");
      }
    } else if (input.scope.kind !== "all") {
      throw new CanonicalSearchError("request_invalid");
    }
    const actor = await resolveMessagingActor(
      input.context,
      options.participantDirectory,
      "product:read",
    );
    const query = canonicalQuery(input.query);
    const ftsQuery = toFtsQuery(query);
    const queryDigest = createHash("sha256").update(query, "utf8").digest("hex");
    const boundary = cursorCodec.decode(
      input.cursor,
      actor.principalId,
      queryDigest,
      input.scope,
    );
    const result = options.repository.search({
      actor,
      query,
      ftsQuery,
      scope: input.scope,
      boundary,
      limit: input.limit,
      canary: options.resolveCanary({
        principalId: actor.principalId,
        scope: input.scope,
      }),
      checkedAt: now().toISOString(),
    });
    const response: CanonicalSearchResponse = {
      requestId: actor.requestId,
      correlationId: actor.correlationId,
      query,
      scope: input.scope.kind === "all" ? "all" : `channel:${input.scope.channelId}`,
      results: result.results,
      nextCursor: result.nextBoundary
        ? cursorCodec.encode(
            result.nextBoundary,
            actor.principalId,
            queryDigest,
            input.scope,
          )
        : null,
      completeness: result.completeness,
      throughEventSequence: result.throughEventSequence,
    };
    return Object.freeze(response);
  }

  return Object.freeze({ search });
}
