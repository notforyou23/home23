import assert from "node:assert/strict";
import test from "node:test";

import { catalogAcceptsTurnSelection } from "../../../src/coordination/app/model-selection.js";
import type { ResidentModelCatalog } from "../../../src/coordination-adapter/types.js";

const catalog: ResidentModelCatalog = Object.freeze({
  capabilities: Object.freeze(["messages"]),
  models: Object.freeze([
    Object.freeze({
      alias: "astra",
      provider: "openai-codex",
      model: "gpt-6-astra",
      reasoningEffort: null,
      reasoningEfforts: Object.freeze(["low", "medium", "high", "xhigh", "max"]),
    }),
    Object.freeze({
      alias: "sol",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoningEffort: null,
    }),
  ]),
  defaultModel: "gpt-5.6-sol",
  defaultProvider: "openai-codex",
  defaultReasoningEffort: "high",
  reasoningEfforts: Object.freeze(["none", "low", "medium", "high", "xhigh", "max"]),
});

test('selection validation applies the selected model effort catalog', () => {
  assert.equal(catalogAcceptsTurnSelection(catalog, {
    modelAlias: "astra", reasoningEffort: "none",
  }), false);
  assert.equal(catalogAcceptsTurnSelection(catalog, {
    modelAlias: "astra", reasoningEffort: "max",
  }), true);
  assert.equal(catalogAcceptsTurnSelection(catalog, {
    modelAlias: "sol", reasoningEffort: "none",
  }), true);
  assert.equal(catalogAcceptsTurnSelection(catalog, {
    modelAlias: "missing", reasoningEffort: "high",
  }), false);
});

test('default model validation still applies exact Astra capabilities without an alias row', () => {
  const astraDefault = {
    ...catalog,
    models: Object.freeze([]),
    defaultModel: "gpt-6-astra",
  } satisfies ResidentModelCatalog;
  assert.equal(catalogAcceptsTurnSelection(astraDefault, {
    modelAlias: null, reasoningEffort: "none",
  }), false);
  assert.equal(catalogAcceptsTurnSelection(astraDefault, {
    modelAlias: null, reasoningEffort: "high",
  }), true);
});
