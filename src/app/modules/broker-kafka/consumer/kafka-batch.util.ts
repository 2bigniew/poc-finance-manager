export function chunkMessages<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) {
    throw new RangeError('Chunk size must be at least 1.');
  }

  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export interface OffsetOutcome {
  readonly offset: string;
  readonly success: boolean;
}

// Mirrors the Kafka Offset Rules (ARCHITECTURE.md): the committed position for a
// partition can only be the highest offset that is contiguously successful from the
// start of `outcomes`. The first failure stops progression - offsets after it are never
// committed even if a later entry happens to be marked successful, because the runner
// never even attempts them (kafka-consumer-runner.service.ts stops at the first
// non-terminal chunk).
export function computeHighestContiguousOffset(
  outcomes: readonly OffsetOutcome[],
): string | null {
  let lastSuccessful: string | null = null;

  for (const outcome of outcomes) {
    if (!outcome.success) {
      break;
    }
    lastSuccessful = outcome.offset;
  }

  return lastSuccessful;
}
