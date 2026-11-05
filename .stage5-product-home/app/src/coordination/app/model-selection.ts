import type { ResidentModelCatalog, ResidentTurnSelectionRequest } from "../../coordination-adapter/types.js";
import { modelSupportsReasoningEffort } from "../../agent/reasoning-effort.js";

/** Validate the requested pair, including a model's narrower effort catalog. */
export function catalogAcceptsTurnSelection(
  catalog: ResidentModelCatalog,
  selection: ResidentTurnSelectionRequest,
): boolean {
  const selectedModel = selection.modelAlias === null
    ? catalog.models.find((candidate) =>
        candidate.model === catalog.defaultModel && candidate.provider === catalog.defaultProvider)
    : catalog.models.find((candidate) => candidate.alias === selection.modelAlias);
  if (selection.modelAlias !== null && !selectedModel) return false;
  if (selection.reasoningEffort === null) return true;
  if (selectedModel?.reasoningEfforts) {
    return selectedModel.reasoningEfforts.includes(selection.reasoningEffort);
  }
  return modelSupportsReasoningEffort(
    selectedModel?.model ?? catalog.defaultModel,
    selection.reasoningEffort,
  );
}
