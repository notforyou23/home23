import type { ResidentModelCatalog, ResidentTurnSelectionRequest } from "../../coordination-adapter/types.js";
import { modelSupportsReasoningEffort } from "../../agent/reasoning-effort.js";

/** Validate the requested pair, including a model's narrower effort catalog. */
export function catalogAcceptsTurnSelection(
  catalog: ResidentModelCatalog,
  selection: ResidentTurnSelectionRequest,
): boolean {
  const models = catalog.modelOptions ?? catalog.models;
  const selectedModel = selection.modelAlias === null
    ? models.find((candidate) =>
        candidate.model === catalog.defaultModel && candidate.provider === catalog.defaultProvider)
    : models.find((candidate) => candidate.alias === selection.modelAlias);
  if (selection.modelAlias !== null && !selectedModel) return false;
  if (selection.reasoningEffort === null) return true;
  const options = selectedModel?.reasoningEffortOptions ?? selectedModel?.reasoningEfforts;
  if (options) {
    return options.includes(selection.reasoningEffort);
  }
  return modelSupportsReasoningEffort(
    selectedModel?.model ?? catalog.defaultModel,
    selection.reasoningEffort,
    selectedModel?.provider ?? catalog.defaultProvider,
  );
}
