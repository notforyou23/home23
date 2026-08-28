(function connectedAgentsSelectionModule(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ConnectedAgentsSelection = api;
})(typeof window === "undefined" ? globalThis : window, () => {
  "use strict";

  const EFFORTS = Object.freeze(["none", "low", "medium", "high", "xhigh", "max"]);
  const EFFORT_SET = new Set(EFFORTS);
  const STORAGE_PREFIX = "home23:connected-agents:execution:";
  const EMPTY = Object.freeze({ modelAlias: null, reasoningEffort: null });

  function record(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError(`${label} must be an object`);
    }
    return value;
  }

  function text(value, label) {
    if (typeof value !== "string" || !value || value.length > 256 || /[\0\r\n]/u.test(value)) {
      throw new TypeError(`${label} is invalid`);
    }
    return value;
  }

  function effort(value, nullable, label) {
    if (nullable && value === null) return null;
    if (typeof value !== "string" || !EFFORT_SET.has(value)) {
      throw new TypeError(`${label} is invalid`);
    }
    return value;
  }

  function normalizeOptions(value, expectedChannelId) {
    const source = record(value, "execution options");
    const channelId = text(source.channelId, "execution options channelId");
    if (expectedChannelId && channelId !== expectedChannelId) {
      throw new TypeError("execution options belong to a different Channel");
    }
    if (!Array.isArray(source.models) || !Array.isArray(source.reasoningEfforts)) {
      throw new TypeError("execution option lists are invalid");
    }
    const aliases = new Set();
    const models = source.models.map((raw) => {
      const model = record(raw, "execution model");
      const alias = text(model.alias, "execution model alias");
      if (aliases.has(alias)) throw new TypeError("execution model aliases must be unique");
      aliases.add(alias);
      return Object.freeze({
        alias,
        provider: text(model.provider, "execution model provider"),
        model: text(model.model, "execution model"),
        reasoningEffort: effort(model.reasoningEffort, true, "execution model effort"),
      });
    });
    const reasoningEfforts = source.reasoningEfforts.map((value) =>
      effort(value, false, "execution effort"));
    if (new Set(reasoningEfforts).size !== reasoningEfforts.length) {
      throw new TypeError("execution efforts must be unique");
    }
    const defaultReasoningEffort = effort(
      source.defaultReasoningEffort,
      false,
      "default execution effort",
    );
    if (!reasoningEfforts.includes(defaultReasoningEffort)) {
      throw new TypeError("default execution effort is unavailable");
    }
    return Object.freeze({
      channelId,
      conversationId: text(source.conversationId, "execution options conversationId"),
      targetBotId: text(source.targetBotId, "execution options targetBotId"),
      models: Object.freeze(models),
      defaultModel: text(source.defaultModel, "default execution model"),
      defaultProvider: text(source.defaultProvider, "default execution provider"),
      defaultReasoningEffort,
      reasoningEfforts: Object.freeze(reasoningEfforts),
    });
  }

  function normalizePreference(value, options) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return EMPTY;
    const modelAlias = value.modelAlias === null ? null : value.modelAlias;
    const reasoningEffort = value.reasoningEffort === null ? null : value.reasoningEffort;
    if (
      (modelAlias !== null &&
        (typeof modelAlias !== "string" || !options.models.some((model) => model.alias === modelAlias))) ||
      (reasoningEffort !== null &&
        (typeof reasoningEffort !== "string" || !options.reasoningEfforts.includes(reasoningEffort)))
    ) return EMPTY;
    return Object.freeze({ modelAlias, reasoningEffort });
  }

  function storageKey(channelId) {
    return `${STORAGE_PREFIX}${text(channelId, "preference channelId")}`;
  }

  function loadPreference(storage, channelId, options) {
    try {
      const encoded = storage?.getItem(storageKey(channelId));
      return encoded ? normalizePreference(JSON.parse(encoded), options) : EMPTY;
    } catch {
      return EMPTY;
    }
  }

  function savePreference(storage, channelId, selection, options) {
    const exact = normalizePreference(selection, options);
    try {
      storage?.setItem(storageKey(channelId), JSON.stringify(exact));
      return true;
    } catch {
      return false;
    }
  }

  function capture(selection) {
    return Object.freeze({
      modelAlias: selection?.modelAlias ?? null,
      reasoningEffort: selection?.reasoningEffort ?? null,
    });
  }

  function requestFields(captured) {
    return {
      modelAlias: captured.modelAlias,
      reasoningEffort: captured.reasoningEffort,
    };
  }

  return Object.freeze({
    EFFORTS,
    EMPTY,
    normalizeOptions,
    normalizePreference,
    storageKey,
    loadPreference,
    savePreference,
    capture,
    requestFields,
  });
});
