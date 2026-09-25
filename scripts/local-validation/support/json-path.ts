function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Reads a dotted path out of an untrusted JSON value without casts.
export function at(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split('.')) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

export function stringAt(value: unknown, path: string): string | undefined {
  const found = at(value, path);
  return typeof found === 'string' ? found : undefined;
}

export function numberAt(value: unknown, path: string): number | undefined {
  const found = at(value, path);
  return typeof found === 'number' ? found : undefined;
}

// Recursively collects every object key, used to prove sensitive fields are absent.
export function collectKeys(
  value: unknown,
  keys: Set<string> = new Set(),
): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((item) => collectKeys(item, keys));
  } else if (isRecord(value)) {
    for (const [key, nested] of Object.entries(value)) {
      keys.add(key);
      collectKeys(nested, keys);
    }
  }
  return keys;
}
