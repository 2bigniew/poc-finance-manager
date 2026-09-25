export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Bounded polling: resolves with the first non-null probe result, or throws once the
// deadline passes. Never an unbounded wait and never a single arbitrary long sleep.
export async function waitFor<T>(
  description: string,
  probe: () => Promise<T | null>,
  options: { timeoutMs: number; intervalMs?: number },
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== null) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(options.intervalMs ?? 500);
  }

  const suffix =
    lastError instanceof Error ? ` (last error: ${lastError.message})` : '';
  throw new Error(
    `Timed out after ${options.timeoutMs}ms waiting for ${description}${suffix}`,
  );
}
