function invalid(field: string, message = `${field}_invalid`): Error {
  return Object.assign(new Error(message), { code: 'invalid_request' });
}

export function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function assertExactKeys(
  value: unknown,
  allowedKeys: readonly string[],
  field: string,
  options: { requireAll?: boolean; requireAny?: boolean } = {},
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(field);
  const keys = Reflect.ownKeys(value);
  const allowed = new Set(allowedKeys);
  if (keys.some((key) => typeof key !== 'string' || !allowed.has(key))) throw invalid(field);
  if (options.requireAll && (keys.length !== allowedKeys.length
      || allowedKeys.some((key) => !hasOwn(value, key)))) {
    throw invalid(field);
  }
  if (options.requireAny && keys.length === 0) throw invalid(field);
}

export function exactProviderModelPair(
  value: unknown,
  field: string,
): { provider: string; model: string } | undefined {
  if (value === undefined) return undefined;
  assertExactKeys(value, ['provider', 'model'], field, { requireAll: true });
  if (typeof value.provider !== 'string' || !value.provider.trim()
      || typeof value.model !== 'string' || !value.model.trim()) {
    throw invalid(field, `${field}_requires_exact_provider_model`);
  }
  return { provider: value.provider, model: value.model };
}

export function optionalFiniteInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw invalid(field);
  }
  return value;
}

export function optionalFiniteNumber(
  value: unknown,
  field: string,
  min: number,
  max: number,
  options: { exclusiveMin?: boolean } = {},
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)
      || (options.exclusiveMin ? value <= min : value < min) || value > max) {
    throw invalid(field);
  }
  return value;
}

export function requiredBoundedText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw invalid(field);
  return value;
}

export function optionalBoundedText(
  value: unknown,
  field: string,
  max: number,
  options: { allowEmpty?: boolean } = {},
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max
      || (!options.allowEmpty && !value.trim())) {
    throw invalid(field);
  }
  return value;
}

export function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw invalid(field);
  return value;
}

export function optionalEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw invalid(field);
  return value as T;
}
