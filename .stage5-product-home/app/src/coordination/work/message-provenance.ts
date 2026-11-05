import type { CoordinationTransaction } from "../db/index.js";
import { MessagingError } from "../channels/index.js";
import type { MessageProvenance, MessageProvenanceAuthorizationTransactionPort } from "../messages/index.js";

/** Authorize a canonical result Message from M11 facts in the M08 transaction. */
export class M11MessageProvenanceAuthority implements MessageProvenanceAuthorizationTransactionPort {
  assertAuthorized(transaction: CoordinationTransaction, input: {
    actor: { principalId: string; kind: "owner" | "bot" };
    channelId: string;
    provenance: MessageProvenance;
  }): void {
    if (input.actor.kind !== "bot" || input.provenance.workId === null) {
      throw new MessagingError("invalid_relation");
    }
    const work = transaction.readOne<{ targetPrincipalId: string; channelId: string; roundId: string | null; state: string }>(
      `SELECT target_principal_id AS targetPrincipalId, channel_id AS channelId,
              round_id AS roundId, state FROM works WHERE id = ?`,
      input.provenance.workId,
    );
    if (!work || work.targetPrincipalId !== input.actor.principalId ||
        work.channelId !== input.channelId || work.roundId !== input.provenance.roundId ||
        !["succeeded", "failed", "cancelled"].includes(work.state)) {
      throw new MessagingError("invalid_relation");
    }
  }
}
