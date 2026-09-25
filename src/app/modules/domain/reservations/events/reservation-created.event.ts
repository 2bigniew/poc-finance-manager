import { randomUUID } from 'node:crypto';
import { DomainEventEnvelope } from '@app/modules/domain/shared/events/domain-event-envelope';
import { Money } from '@app/modules/domain/shared/money/money';
import { Reservation } from '../reservation.entity';

// This module owns its own outbound topic and event-type naming (CLAUDE.md "Topic
// Ownership": "do not scatter literal topic strings throughout services") - the
// Reservation transaction reads these constants when it writes the outbox row; the
// Outbox Publisher never chooses a topic itself.
export const RESERVATION_EVENTS_TOPIC = 'reservations.events';
export const RESERVATION_CREATED_EVENT_TYPE = 'reservation.created';
const RESERVATION_CREATED_EVENT_VERSION = 1;

// Money is already the decimal-safe string amount+currency shape BUSINESS.md's
// MoneyDto would be - reused directly rather than introducing a redundant duplicate
// type, the same choice every existing HTTP response DTO in this codebase already made
// (e.g. ReservationResponseDto).
export interface ReservationCreatedEventPayload {
  reservationId: string;
  programId: string;
  invoiceId: string;
  originalMoney: Money;
  convertedMoneyUsd: Money;
  conversion: {
    rate: string;
    rateDate: string;
    source: 'frankfurter.dev';
  };
  createdByUserId: string;
}

export type ReservationCreatedEvent = DomainEventEnvelope<
  typeof RESERVATION_CREATED_EVENT_TYPE,
  ReservationCreatedEventPayload
>;

// Called once, inside the SAME PostgreSQL transaction that commits the Reservation.
// `occurredAt` is therefore fixed at business-event creation time, never replaced by
// publisher retry/Kafka-ACK time (CLAUDE.md "occurredAt"). The generated `eventId` is
// persisted into the outbox row and reused for every future publish retry of that row
// (CLAUDE.md "Stable Event ID") - ReservationsService, not the publisher, is the only
// place this ID is ever generated.
export function buildReservationCreatedEvent(
  reservation: Reservation,
  occurredAt: Date,
): ReservationCreatedEvent {
  return {
    eventId: randomUUID(),
    eventType: RESERVATION_CREATED_EVENT_TYPE,
    eventVersion: RESERVATION_CREATED_EVENT_VERSION,
    occurredAt: occurredAt.toISOString(),
    payload: {
      reservationId: reservation.id,
      programId: reservation.programId,
      invoiceId: reservation.invoiceId,
      originalMoney: reservation.originalMoney,
      convertedMoneyUsd: reservation.convertedMoneyUsd,
      conversion: {
        rate: reservation.conversion.rate,
        rateDate: reservation.conversion.rateDate.toISOString(),
        source: reservation.conversion.source,
      },
      createdByUserId: reservation.createdByUserId,
    },
  };
}
