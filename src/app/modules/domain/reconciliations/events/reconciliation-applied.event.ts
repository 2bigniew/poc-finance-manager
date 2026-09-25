import { randomUUID } from 'node:crypto';
import { DomainEventEnvelope } from '@app/modules/domain/shared/events/domain-event-envelope';
import { Money } from '@app/modules/domain/shared/money/money';
import { Reconciliation } from '../reconciliation.entity';

export const RECONCILIATION_EVENTS_TOPIC = 'reconciliations.events';
export const RECONCILIATION_APPLIED_EVENT_TYPE = 'reconciliation.applied';
const RECONCILIATION_APPLIED_EVENT_VERSION = 1;

export interface ReconciliationAppliedEventPayload {
  reconciliationId: string;
  batchId: string;
  externalEventId: string;
  programId: string;
  sourceVersion: number;
  totalCapacityUsd: Money;
  effectiveAt: string;
}

export type ReconciliationAppliedEvent = DomainEventEnvelope<
  typeof RECONCILIATION_APPLIED_EVENT_TYPE,
  ReconciliationAppliedEventPayload
>;

// Only ever called for a Reconciliation whose status is APPLIED (CLAUDE.md
// "Reconciliation Event Contract": "Do not emit APPLIED events for stale/ignored
// reconciliation") - the caller (ReconciliationsService) is responsible for that check;
// this builder does not re-validate status itself. Called once, inside the same
// transaction that commits the Reconciliation/Program update, for the same
// stable-eventId reasons as the Reservation/Release builders.
export function buildReconciliationAppliedEvent(
  reconciliation: Reconciliation,
  occurredAt: Date,
): ReconciliationAppliedEvent {
  return {
    eventId: randomUUID(),
    eventType: RECONCILIATION_APPLIED_EVENT_TYPE,
    eventVersion: RECONCILIATION_APPLIED_EVENT_VERSION,
    occurredAt: occurredAt.toISOString(),
    payload: {
      reconciliationId: reconciliation.id,
      batchId: reconciliation.batchId,
      externalEventId: reconciliation.externalEventId,
      programId: reconciliation.programId,
      sourceVersion: reconciliation.sourceVersion,
      totalCapacityUsd: reconciliation.totalCapacityUsd,
      effectiveAt: reconciliation.effectiveAt.toISOString(),
    },
  };
}
