/** Deterministic JSON for recipe fingerprints. Sorted object keys; array order kept. */

export function canonicalize(value) {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item === undefined) continue;
      out[key] = canonicalize(item);
    }
    return out;
  }
  throw new TypeError(`Cannot canonicalize ${typeof value}`);
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}
