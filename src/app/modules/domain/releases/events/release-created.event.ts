import { randomUUID } from 'node:crypto';
import { DomainEventEnvelope } from '@app/modules/domain/shared/events/domain-event-envelope';
import { Money } from '@app/modules/domain/shared/money/money';
import { Release } from '../release.entity';

export const RELEASE_EVENTS_TOPIC = 'releases.events';
export const RELEASE_CREATED_EVENT_TYPE = 'release.created';
const RELEASE_CREATED_EVENT_VERSION = 1;

export interface ReleaseCreatedEventPayload {
  releaseId: string;
  reservationId: string;
  invoiceId: string;
  programId: string;
  originalMoney: Money;
  convertedMoneyUsd: Money;
  conversion: {
    rate: string;
    rateDate: string;
    source: 'frankfurter.dev';
  };
  createdByUserId: string;
}

export type ReleaseCreatedEvent = DomainEventEnvelope<
  typeof RELEASE_CREATED_EVENT_TYPE,
  ReleaseCreatedEventPayload
>;

// `release.originalMoney`/`convertedMoneyUsd`/`conversion` are already the EXACT values
// ReleasesService copied from the Reservation being released (BUSINESS.md: "A Release
// MUST use the exact monetary values and FX conversion stored on the Reservation") - this
// builder does not re-derive or revalue them, only reads what the Release entity already
// holds. Called once, inside the same transaction that commits the Release, for the same
// stable-eventId reasons as buildReservationCreatedEvent.
export function buildReleaseCreatedEvent(
  release: Release,
  occurredAt: Date,
): ReleaseCreatedEvent {
  return {
    eventId: randomUUID(),
    eventType: RELEASE_CREATED_EVENT_TYPE,
    eventVersion: RELEASE_CREATED_EVENT_VERSION,
    occurredAt: occurredAt.toISOString(),
    payload: {
      releaseId: release.id,
      reservationId: release.reservationId,
      invoiceId: release.invoiceId,
      programId: release.programId,
      originalMoney: release.originalMoney,
      convertedMoneyUsd: release.convertedMoneyUsd,
      conversion: {
        rate: release.conversion.rate,
        rateDate: release.conversion.rateDate.toISOString(),
        source: release.conversion.source,
      },
      createdByUserId: release.createdByUserId,
    },
  };
}
