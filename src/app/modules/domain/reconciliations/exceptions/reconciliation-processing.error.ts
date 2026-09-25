// Thrown for genuine, unexpected processing failures: an invariant that the Program row
// lock should have guaranteed turned out false, an inbox/audit row pair that somehow
// desynchronized, or a bulk batch that had one or more failing entries. Not used for
// expected business outcomes (stale/duplicate sourceVersion is a normal APPLIED/
// IGNORED_STALE result, not an error - CLAUDE.md section 53). Rolls back the whole
// per-entry transaction, so nothing is dedup-recorded and the entry remains safely
// retryable; at the bulk level it causes the Kafka handler to throw, so the consumer
// runner retries the whole message (per-entry idempotency makes that safe).
export class ReconciliationProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReconciliationProcessingError';
  }
}
