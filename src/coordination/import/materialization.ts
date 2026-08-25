import {
  createMessagingIdempotencyClaim,
  type MessagingIdempotencyClaim,
  type ResolvedMessagingActor,
} from "../channels/index.js";
import {
  planAliasBinding,
  type AliasBinding,
  type AliasBindingPlan,
} from "../aliases/index.js";
import {
  COORDINATION_SCHEMA_CHECKSUM,
  COORDINATION_SCHEMA_VERSION,
  COORDINATION_SEARCH_ATTACHMENT_SCHEMA_DEPENDENCIES,
} from "../migrations/index.js";
import type { PendingMessage } from "../messages/index.js";
import { validateContractId } from "../schema/contract-registry.js";
import {
  canonicalJson,
  deepFreeze,
  requireCanonicalTimestamp,
  requireSha256,
  sha256,
} from "./canonical.js";
import { planCohortImport } from "./planner.js";
import type {
  CohortManifest,
  ImportLedgerView,
  ImportPlanItem,
  ImportSourceRecord,
  LegacySourceRegistry,
} from "./types.js";

export interface BindCanonicalImportMessageInput {
  readonly planning: {
    readonly manifest: CohortManifest;
    readonly sourceRecords: readonly ImportSourceRecord[];
    readonly ledger: ImportLedgerView;
    readonly sourceRegistry: LegacySourceRegistry;
    readonly itemIndex: number;
  };
  readonly existingAliases: readonly AliasBinding[];
  readonly actor: ResolvedMessagingActor;
  readonly channelId: string;
  readonly messageId: string;
  readonly aliasId: string;
  readonly aliasNamespace: string;
  /** Canonical alias-row creation time. Message time remains source-preserving. */
  readonly materializedAt: string;
}

interface ProposedCanonicalMessage {
  readonly projection: PendingMessage;
  readonly actorBinding: {
    readonly principalId: string;
    readonly kind: "owner" | "bot";
  };
  readonly idempotency: MessagingIdempotencyClaim;
}

export type CanonicalImportMessageBinding =
  | {
      readonly decision: "ready";
      readonly planningReceipt: {
        readonly cohortId: string;
        readonly manifestDigest: string;
        readonly planDigest: string;
        readonly itemIndex: number;
      };
      readonly m04TransactionProposal: {
        readonly owner: "M04";
        readonly status: "proposal_only";
        readonly schema: { readonly version: 3; readonly checksum: string };
        readonly requiredAtomicWrites: readonly [
          "import_items",
          "aliases",
          "messages",
          "events",
          "message_fts",
          "search_watermarks",
          "import_cursors",
        ];
        readonly alias: Extract<AliasBindingPlan, { decision: "create" | "already_bound" }>;
        readonly message: ProposedCanonicalMessage;
        readonly importProvenance: {
          readonly sourceId: string;
          readonly importKeyDigest: string;
          readonly canonicalDigest: string;
        };
        readonly requiredOrderedEvents: readonly ["message.appended", "import.updated"];
        readonly search: {
          readonly sourceClass: "coordination.messages";
          readonly indexTable: "message_fts";
          readonly watermarkTable: "search_watermarks";
          readonly maintenance: "CoordinationDatabase.rebuildCanonicalSearchIndex";
          readonly rebuildSqlSha256: string;
        };
      };
    }
  | {
      readonly decision: "reference_only";
      readonly reason: "reviewed_body_not_selected";
      readonly sourceId: string;
      readonly importKeyDigest: string;
    }
  | {
      readonly decision: "denied";
      readonly reason: string;
      readonly aliasDigest?: string;
    };

function assertCanonicalItem(item: ImportPlanItem): NonNullable<ImportPlanItem["canonical"]> {
  const canonical = item.canonical;
  if (!canonical) throw new Error("import item has no canonical projection");
  requireSha256(item.importKeyDigest, "import item key");
  requireSha256(item.canonicalDigest, "import item canonical digest");
  requireSha256(canonical.normalizedDigest, "canonical normalized digest");
  requireCanonicalTimestamp(canonical.sourceTimestamp, "canonical source timestamp");
  if (
    canonical.importKeyDigest !== item.importKeyDigest
    || canonical.sourceId !== item.sourceId
    || canonical.segmentIdentity !== item.segmentIdentity
    || canonical.recordKey !== item.recordKey
    || sha256(canonicalJson(canonical)) !== item.canonicalDigest
  ) {
    throw new Error("import item differs from its canonical projection identity");
  }
  return canonical;
}

function assertActor(
  actor: ResolvedMessagingActor,
  author: NonNullable<ImportPlanItem["canonical"]>["author"],
): void {
  const expectedKind = author.class === "owner"
    ? "owner"
    : author.class === "bot" ? "bot" : null;
  if (
    !expectedKind
    || actor.kind !== expectedKind
    || actor.principalId !== author.canonicalPrincipalId
  ) {
    throw new Error("canonical import author does not match the resolved M08 actor");
  }
}

/**
 * Re-runs the reviewed planner and emits a non-executable M04 transaction proposal.
 * M17 cannot persist any subset until M04 lands the import-ledger transaction owner.
 */
export function bindCanonicalImportMessage(
  input: BindCanonicalImportMessageInput,
): CanonicalImportMessageBinding {
  if (
    COORDINATION_SCHEMA_VERSION !== 3
    || COORDINATION_SCHEMA_CHECKSUM
      !== "ddac2fb83bf73837f5200725697eff7d55a685f18a6c144fc33df17b75f113c2"
  ) {
    throw new Error("M17 canonical materialization requires the reviewed schema-v3 base");
  }
  if (
    !Number.isSafeInteger(input.planning.itemIndex)
    || input.planning.itemIndex < 0
  ) {
    throw new Error("reviewed import plan item index is invalid");
  }
  const plan = planCohortImport(
    input.planning.manifest,
    input.planning.sourceRecords,
    input.planning.ledger,
    input.planning.sourceRegistry,
  );
  const item = plan.items[input.planning.itemIndex];
  if (!item) throw new Error("reviewed import plan item does not exist");
  if (item.action === "already_imported") {
    return deepFreeze({
      decision: "denied" as const,
      reason: "m04_materialization_lookup_required",
    });
  }
  if (item.action !== "insert") {
    return deepFreeze({
      decision: "denied" as const,
      reason: `import_item_${item.action}`,
    });
  }
  const canonical = assertCanonicalItem(item);
  if (canonical.canonicalKind !== "message") {
    return deepFreeze({ decision: "denied" as const, reason: "not_a_canonical_message" });
  }
  if (!canonical.bodyImported) {
    return deepFreeze({
      decision: "reference_only" as const,
      reason: "reviewed_body_not_selected" as const,
      sourceId: item.sourceId,
      importKeyDigest: item.importKeyDigest,
    });
  }
  if (
    canonical.visibleBody === null
    || !canonical.visibleBody.trim()
    || canonical.visibleBody.includes("\0")
    || Buffer.byteLength(canonical.visibleBody, "utf8") > 65_536
  ) {
    throw new Error("reviewed canonical Message body is invalid for M08");
  }
  if (
    !validateContractId("channel", input.channelId)
    || !validateContractId("message", input.messageId)
  ) {
    throw new Error("canonical import target ids are invalid");
  }
  assertActor(input.actor, canonical.author);
  requireCanonicalTimestamp(input.materializedAt, "canonical alias materializedAt");

  const alias = planAliasBinding(input.existingAliases, {
    id: input.aliasId,
    namespace: input.aliasNamespace,
    legacyId: canonical.sourceObjectKey,
    targetType: "message",
    targetId: input.messageId,
    createdAt: input.materializedAt,
    updatedAt: input.materializedAt,
  });
  if (alias.decision === "denied") {
    return deepFreeze({
      decision: "denied" as const,
      reason: alias.reason,
      aliasDigest: alias.aliasDigest,
    });
  }

  const projection: PendingMessage = deepFreeze({
    id: input.messageId,
    channelId: input.channelId,
    author: {
      principalId: input.actor.principalId,
      kind: input.actor.kind,
      displayName: input.actor.displayName,
    },
    kind: "text" as const,
    text: canonical.visibleBody,
    mentions: [] as readonly string[],
    clientMessageId: `m17:${item.importKeyDigest}`,
    replyToMessageId: null,
    tombstonesMessageId: null,
    provenance: { roundId: null, workId: null },
    createdAt: canonical.sourceTimestamp,
  });
  const idempotency = createMessagingIdempotencyClaim(
    "message.append",
    input.actor.principalId,
    `m17-import-message:${item.importKeyDigest}`,
    {
      channelId: projection.channelId,
      messageId: projection.id,
      authorPrincipalId: projection.author.principalId,
      kind: projection.kind,
      text: projection.text,
      mentions: [],
      clientMessageId: projection.clientMessageId,
      replyToMessageId: null,
      tombstonesMessageId: null,
      provenance: { roundId: null, workId: null },
    },
  );
  return deepFreeze({
    decision: "ready" as const,
    planningReceipt: {
      cohortId: plan.cohortId,
      manifestDigest: plan.manifestDigest,
      planDigest: sha256(canonicalJson(plan)),
      itemIndex: input.planning.itemIndex,
    },
    m04TransactionProposal: {
      owner: "M04" as const,
      status: "proposal_only" as const,
      schema: {
        version: COORDINATION_SCHEMA_VERSION as 3,
        checksum: COORDINATION_SCHEMA_CHECKSUM,
      },
      requiredAtomicWrites: [
        "import_items",
        "aliases",
        "messages",
        "events",
        "message_fts",
        "search_watermarks",
        "import_cursors",
      ] as const,
      alias,
      message: {
        projection,
        actorBinding: {
          principalId: input.actor.principalId,
          kind: input.actor.kind,
        },
        idempotency,
      },
      importProvenance: {
        sourceId: item.sourceId,
        importKeyDigest: item.importKeyDigest,
        canonicalDigest: item.canonicalDigest,
      },
      requiredOrderedEvents: ["message.appended", "import.updated"] as const,
      search: {
        sourceClass: "coordination.messages" as const,
        indexTable: "message_fts" as const,
        watermarkTable: "search_watermarks" as const,
        maintenance: "CoordinationDatabase.rebuildCanonicalSearchIndex" as const,
        rebuildSqlSha256:
          COORDINATION_SEARCH_ATTACHMENT_SCHEMA_DEPENDENCIES.m09SearchRebuildSql,
      },
    },
  });
}
