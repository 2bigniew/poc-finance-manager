// Common outbound domain-event envelope (CLAUDE.md "Event Envelope"). Every concrete
// outbound event type (ReservationCreatedEvent, ReleaseCreatedEvent,
// ReconciliationAppliedEvent) wraps its own payload in this shape before it is written
// into the transactional outbox as JSON (outbox_events.payload).
//
// Kafka transport metadata (topic/partition/offset) is deliberately NOT part of this
// envelope - that is owned by the outbox row / broker, not event semantics
// (CLAUDE.md: "Keep transport metadata... OUT of the domain payload").
export interface DomainEventEnvelope<TType extends string, TPayload> {
  eventId: string;
  eventType: TType;
  eventVersion: number;
  // Fixed once, inside the same business transaction that creates the outbox row - never
  // replaced by publisher retry time or Kafka ACK time (CLAUDE.md "occurredAt").
  occurredAt: string;
  payload: TPayload;
}
