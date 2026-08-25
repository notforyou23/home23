import { deepFreeze } from "./canonical.js";

export interface ImportRollbackItem {
  readonly importKeyDigest: string;
  readonly bodyImported: boolean;
  readonly referencedByNewActivity: boolean;
}

export function planImportCohortRollback(input: {
  readonly cohortId: string;
  readonly batchId: string;
  readonly items: readonly ImportRollbackItem[];
}) {
  if (!input.cohortId || !input.batchId) throw new Error("cohort and batch ids are required");
  return deepFreeze({
    rollbackVersion: 1 as const,
    cohortId: input.cohortId,
    batchId: input.batchId,
    batchState: "inactive" as const,
    source: {
      action: "preserve_read_only" as const,
      overwriteAllowed: false as const,
    },
    preserve: [
      "import_ledger",
      "aliases",
      "provenance",
      "event_boundaries",
      "read_cursors",
      "canonical_event_history",
    ] as const,
    items: input.items.map((item) => ({
      importKeyDigest: item.importKeyDigest,
      canonicalRecord: "preserve_audit_stub" as const,
      canonicalAction: item.referencedByNewActivity
        ? "preserve_referenced_record" as const
        : item.bodyImported
          ? "deactivate_projection_and_remove_unreferenced_copied_body" as const
          : "deactivate_unreferenced_projection" as const,
    })),
  });
}
