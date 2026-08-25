export type AliasTargetType = "bot" | "conversation" | "message" | "artifact" | "import_item";

export interface AliasProvenance {
  readonly sourceId: string;
  readonly importKeyDigest: string;
}

export interface AliasBinding {
  readonly aliasId: string;
  readonly namespace: string;
  readonly aliasDigest: string;
  readonly targetType: AliasTargetType;
  readonly targetId: string;
  readonly active: boolean;
  readonly provenance: AliasProvenance;
}

export interface AliasBindingInput {
  readonly aliasId: string;
  readonly namespace: string;
  readonly legacyId: string;
  readonly targetType: AliasTargetType;
  readonly targetId: string;
  readonly provenance: AliasProvenance;
}

export type AliasBindingPlan =
  | { readonly decision: "create" | "already_bound"; readonly binding: AliasBinding }
  | {
      readonly decision: "denied";
      readonly reason:
        | "alias_collision"
        | "alias_id_collision"
        | "inactive_alias_reserved"
        | "invalid_stored_alias"
        | "invalid_alias"
        | "invalid_target"
        | "invalid_provenance";
      readonly aliasDigest: string;
    };

export type AliasResolution =
  | { readonly decision: "resolved"; readonly binding: AliasBinding }
  | { readonly decision: "not_found"; readonly reason: "no_exact_alias" | "alias_inactive" }
  | {
      readonly decision: "denied";
      readonly reason: "stored_alias_collision" | "invalid_stored_alias" | "invalid_lookup";
    };
