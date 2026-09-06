import { validateContractId, type ContractIdKind } from "../schema/contract-registry.js";
import {
  canonicalJson,
  deepFreeze,
  requireCanonicalTimestamp,
  sha256,
} from "../import/canonical.js";
import type {
  AliasBinding,
  AliasBindingInput,
  AliasBindingPlan,
  AliasResolution,
  AliasTargetType,
} from "./types.js";

const NAMESPACE_PATTERN = /^[a-z][a-z0-9._-]{1,63}$/;
const TARGET_ID_KIND: Record<AliasTargetType, ContractIdKind> = {
  bot: "bot",
  conversation: "conversation",
  message: "message",
  artifact: "artifact",
  import_item: "importItem",
};

function validLookup(namespace: string, legacyId: string): boolean {
  return NAMESPACE_PATTERN.test(namespace)
    && legacyId.length > 0
    && legacyId.length <= 4_096
    && !legacyId.includes("\0");
}

function immutableBinding(binding: AliasBinding): AliasBinding {
  return deepFreeze({ ...binding });
}

function validTimestamp(value: string): boolean {
  try {
    requireCanonicalTimestamp(value, "canonical alias timestamp");
    return value.length === 24;
  } catch {
    return false;
  }
}

function validStoredBinding(
  binding: AliasBinding,
  expectedNamespace: string,
  expectedDigest: string,
): boolean {
  const idKind = TARGET_ID_KIND[binding.targetType];
  return binding.namespace === expectedNamespace
    && binding.aliasDigest === expectedDigest
    && NAMESPACE_PATTERN.test(binding.namespace)
    && /^[a-f0-9]{64}$/.test(binding.aliasDigest)
    && validateContractId("alias", binding.id)
    && idKind !== undefined
    && validateContractId(idKind, binding.targetId)
    && typeof binding.active === "boolean"
    && validTimestamp(binding.createdAt)
    && validTimestamp(binding.updatedAt)
    && binding.updatedAt >= binding.createdAt;
}

export function digestLegacyAlias(namespace: string, legacyId: string): string {
  if (!validLookup(namespace, legacyId)) throw new Error("invalid exact legacy alias lookup");
  return sha256(canonicalJson({
    aliasCanonicalizationVersion: 1,
    namespace,
    legacyId,
  }));
}

function validateCandidate(input: AliasBindingInput, aliasDigest: string): AliasBindingPlan | null {
  if (!validateContractId("alias", input.id)) {
    return deepFreeze({ decision: "denied", reason: "invalid_alias", aliasDigest });
  }
  const idKind = TARGET_ID_KIND[input.targetType];
  if (!idKind || !validateContractId(idKind, input.targetId)) {
    return deepFreeze({ decision: "denied", reason: "invalid_target", aliasDigest });
  }
  if (
    !validTimestamp(input.createdAt)
    || !validTimestamp(input.updatedAt)
    || input.updatedAt < input.createdAt
  ) {
    return deepFreeze({ decision: "denied", reason: "invalid_timestamp", aliasDigest });
  }
  return null;
}

export function planAliasBinding(
  existingBindings: readonly AliasBinding[],
  input: AliasBindingInput,
): AliasBindingPlan {
  let aliasDigest: string;
  try {
    aliasDigest = digestLegacyAlias(input.namespace, input.legacyId);
  } catch {
    aliasDigest = sha256(canonicalJson({ namespace: input.namespace, legacyId: input.legacyId }));
    return deepFreeze({ decision: "denied", reason: "invalid_alias", aliasDigest });
  }
  const invalid = validateCandidate(input, aliasDigest);
  if (invalid) return invalid;

  const exact = existingBindings.filter((binding) => (
    binding.namespace === input.namespace && binding.aliasDigest === aliasDigest
  ));
  if (exact.length > 1) {
    return deepFreeze({ decision: "denied", reason: "alias_collision", aliasDigest });
  }
  if (exact[0] && !validStoredBinding(exact[0], input.namespace, aliasDigest)) {
    return deepFreeze({ decision: "denied", reason: "invalid_stored_alias", aliasDigest });
  }
  if (exact[0] && !exact[0].active) {
    return deepFreeze({ decision: "denied", reason: "inactive_alias_reserved", aliasDigest });
  }
  if (exact.length > 0) {
    const sameTarget = exact[0]?.targetType === input.targetType
      && exact[0]?.targetId === input.targetId;
    if (!sameTarget) {
      return deepFreeze({ decision: "denied", reason: "alias_collision", aliasDigest });
    }
    return deepFreeze({ decision: "already_bound", binding: immutableBinding(exact[0]!) });
  }
  const reusedId = existingBindings.find((binding) => binding.id === input.id);
  if (reusedId) {
    return deepFreeze({ decision: "denied", reason: "alias_id_collision", aliasDigest });
  }
  return deepFreeze({
    decision: "create",
    binding: immutableBinding({
      id: input.id,
      namespace: input.namespace,
      aliasDigest,
      targetType: input.targetType,
      targetId: input.targetId,
      active: true,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    }),
  });
}

export function resolveAlias(
  bindings: readonly AliasBinding[],
  namespace: string,
  legacyId: string,
): AliasResolution {
  let digest: string;
  try {
    digest = digestLegacyAlias(namespace, legacyId);
  } catch {
    return deepFreeze({ decision: "denied", reason: "invalid_lookup" });
  }
  const exact = bindings.filter((binding) => (
    binding.namespace === namespace && binding.aliasDigest === digest
  ));
  if (exact.length > 1) {
    return deepFreeze({ decision: "denied", reason: "stored_alias_collision" });
  }
  const stored = exact[0];
  if (stored && !validStoredBinding(stored, namespace, digest)) {
    return deepFreeze({ decision: "denied", reason: "invalid_stored_alias" });
  }
  if (stored?.active) {
    return deepFreeze({ decision: "resolved", binding: immutableBinding(stored) });
  }
  if (stored) return deepFreeze({ decision: "not_found", reason: "alias_inactive" });
  return deepFreeze({ decision: "not_found", reason: "no_exact_alias" });
}
