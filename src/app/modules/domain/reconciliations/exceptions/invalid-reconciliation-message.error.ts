// Thrown when a Kafka reconciliation payload fails validation before any domain logic
// runs (CLAUDE.md: "Kafka payloads are untrusted input; validate before invoking domain
// logic. Malformed payloads must fail normal Kafka processing... do not silently skip
// malformed entries"). A plain Error, not a NotFoundError/ConflictError/BadRequestError
// subtype: reconciliation has no HTTP surface, so there is nothing for
// DomainExceptionFilter to map - the Kafka consumer runner treats this exactly like any
// other processing failure (bounded retry, then dead-letter).
export class InvalidReconciliationMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidReconciliationMessageError';
  }
}
