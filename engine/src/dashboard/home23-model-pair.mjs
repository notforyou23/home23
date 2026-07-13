function invalidModelPair(message = 'Select an exact provider and model') {
  return Object.assign(new Error(message), {
    code: 'model_pair_invalid',
    retryable: false,
  });
}

export function exactModelPair(pair) {
  if (!pair || Array.isArray(pair) || typeof pair !== 'object'
      || typeof pair.provider !== 'string' || pair.provider.trim() !== pair.provider
      || !pair.provider
      || typeof pair.model !== 'string' || pair.model.trim() !== pair.model
      || !pair.model) {
    throw invalidModelPair();
  }
  return Object.freeze({ provider: pair.provider, model: pair.model });
}

export function encodeModelPair(pair) {
  const exact = exactModelPair(pair);
  return `${encodeURIComponent(exact.provider)}::${encodeURIComponent(exact.model)}`;
}

export function decodeModelPair(value) {
  if (typeof value !== 'string') throw invalidModelPair();
  const splitAt = value.indexOf('::');
  if (splitAt < 1 || value.indexOf('::', splitAt + 2) !== -1) {
    throw invalidModelPair();
  }
  try {
    return exactModelPair({
      provider: decodeURIComponent(value.slice(0, splitAt)),
      model: decodeURIComponent(value.slice(splitAt + 2)),
    });
  } catch (error) {
    if (error?.code === 'model_pair_invalid') throw error;
    throw invalidModelPair();
  }
}
