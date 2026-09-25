import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Kysely } from 'kysely';
import { KYSELY_CONNECTION } from '@app/modules/database/database.constants';
import { Database } from '@app/modules/database/types/database.interface';
import { OutboxRepository } from '@app/modules/database/outbox/outbox.repository';
import { InvoiceNotFoundError } from '@app/modules/domain/invoices/exceptions/invoice-not-found.error';
import { InvoicesService } from '@app/modules/domain/invoices/invoices.service';
import { ProgramNotFoundError } from '@app/modules/domain/programs/exceptions/program-not-found.error';
import { ProgramsService } from '@app/modules/domain/programs/programs.service';
import { ReservationNotFoundError } from '@app/modules/domain/reservations/exceptions/reservation-not-found.error';
import { ReservationsService } from '@app/modules/domain/reservations/reservations.service';
import { InvoiceNotReleasableError } from './exceptions/invoice-not-releasable.error';
import {
  buildReleaseCreatedEvent,
  RELEASE_EVENTS_TOPIC,
} from './events/release-created.event';
import { ReleaseNotFoundError } from './exceptions/release-not-found.error';
import { ReservationNotActiveError } from './exceptions/reservation-not-active.error';
import { Release } from './release.entity';
import { ReleasesRepository } from './releases.repository';

// No CurrencyExchangeService/FrankfurterClient dependency anywhere in this class - the
// strongest way to guarantee Release never performs a new FX conversion is to make that
// impossible at the type level, not merely mock-and-assert-zero-calls (CLAUDE.md section
// 31: "Prefer not injecting FX dependencies into ReleasesService at all").
@Injectable()
export class ReleasesService {
  private readonly logger = new Logger(ReleasesService.name);

  constructor(
    @Inject(KYSELY_CONNECTION) private readonly db: Kysely<Database>,
    private readonly releasesRepository: ReleasesRepository,
    private readonly programsService: ProgramsService,
    private readonly reservationsService: ReservationsService,
    private readonly invoicesService: InvoicesService,
    private readonly outboxRepository: OutboxRepository,
  ) {}

  async release(
    reservationId: string,
    createdByUserId: string,
  ): Promise<Release> {
    // Step 1: pre-read the Reservation OUTSIDE any transaction, only to learn programId
    // for lock ordering (CLAUDE.md section 9). This pre-read is NOT trusted as final
    // state - it is reloaded and revalidated under lock inside the transaction below
    // (CLAUDE.md section 8: "do not create a Release based on stale pre-transaction
    // Reservation data").
    const reservation = await this.reservationsService.get(reservationId);

    const now = new Date();

    // Step 2: short, DB-only critical section. Lock order: Program, then Reservation,
    // then Invoice (CLAUDE.md section 9) - the same order established by Reservation
    // creation (Program before Invoice), extended with the Reservation lock in between
    // so that Program and Reservation locking share one consistent order project-wide.
    return this.db.transaction().execute(async (trx) => {
      const program = await this.programsService.findByIdForUpdate(
        reservation.programId,
        trx,
      );
      if (!program) {
        throw new ProgramNotFoundError(reservation.programId);
      }

      const lockedReservation =
        await this.reservationsService.findByIdForUpdate(reservationId, trx);
      if (!lockedReservation) {
        throw new ReservationNotFoundError(reservationId);
      }

      if (lockedReservation.status !== 'ACTIVE') {
        // Not ACTIVE: either this exact release already committed (a retried command)
        // or a concurrent release for the same Reservation won the race for the Program
        // lock above and already committed - both share the same Program row, so they
        // are fully serialized by the lock acquired above. Either way, return the
        // existing Release rather than erroring: Release is idempotent on reservationId
        // (BUSINESS.md; CLAUDE.md section 15-17).
        const existingRelease =
          await this.releasesRepository.findByReservationId(reservationId, trx);
        if (existingRelease) {
          return existingRelease;
        }

        // Not ACTIVE with no matching Release row is an invariant violation, not a
        // retry - fail loudly instead of silently fabricating a Release or forcing an
        // arbitrary state transition (CLAUDE.md section 14).
        throw new ReservationNotActiveError(
          reservationId,
          lockedReservation.status,
        );
      }

      const lockedInvoice = await this.invoicesService.findByIdForUpdate(
        lockedReservation.invoiceId,
        trx,
      );
      if (!lockedInvoice) {
        throw new InvoiceNotFoundError(lockedReservation.invoiceId);
      }
      if (lockedInvoice.status !== 'RESERVED') {
        throw new InvoiceNotReleasableError(
          lockedInvoice.id,
          lockedInvoice.status,
        );
      }

      // Release values are copied EXACTLY from the locked Reservation's own stored FX
      // snapshot - never recomputed, never read from the Invoice's conversion, never
      // re-fetched from any current rate (BUSINESS.md: "A Release MUST use the exact
      // monetary values and FX conversion stored on the Reservation"; CLAUDE.md section
      // 3/19/30).
      const release = await this.releasesRepository.create(
        {
          id: randomUUID(),
          reservationId: lockedReservation.id,
          invoiceId: lockedReservation.invoiceId,
          programId: lockedReservation.programId,
          originalAmount: lockedReservation.originalMoney.amount,
          originalCurrency: lockedReservation.originalMoney.currency,
          convertedAmountUsd: lockedReservation.convertedMoneyUsd.amount,
          conversionRate: lockedReservation.conversion.rate,
          conversionRateDate: lockedReservation.conversion.rateDate,
          conversionSource: lockedReservation.conversion.source,
          createdByUserId,
          createdAt: now,
          updatedAt: now,
        },
        trx,
      );

      const releasedReservation = await this.reservationsService.markReleased(
        reservationId,
        trx,
      );
      if (!releasedReservation) {
        // The lock+revalidate above already confirmed status === 'ACTIVE', so this
        // would only happen if something changed the row through a path that bypassed
        // the lock - an invariant violation worth failing loudly on rather than
        // silently committing a Release without a matching Reservation transition.
        throw new ReservationNotActiveError(
          reservationId,
          lockedReservation.status,
        );
      }

      const repaidInvoice = await this.invoicesService.markRepaid(
        lockedReservation.invoiceId,
        trx,
      );
      if (!repaidInvoice) {
        throw new InvoiceNotReleasableError(
          lockedInvoice.id,
          lockedInvoice.status,
        );
      }

      // Transactional outbox write (CLAUDE.md "No Direct Domain Publishing") - only
      // reached on the fresh-Release success path above, never on the idempotent-retry
      // path (the early `return existingRelease` for an already-RELEASED Reservation),
      // so a duplicate/idempotent Release retry never creates a second logical outbox
      // event (CLAUDE.md "Release Workflow Review").
      const event = buildReleaseCreatedEvent(release, now);
      await this.outboxRepository.create(
        {
          id: event.eventId,
          eventId: event.eventId,
          topic: RELEASE_EVENTS_TOPIC,
          messageKey: lockedReservation.programId,
          eventType: event.eventType,
          payload: event,
          createdAt: now,
          updatedAt: now,
        },
        trx,
      );

      this.logger.log(
        `Release created: ${release.id} (reservation=${reservationId}, program=${lockedReservation.programId}, invoice=${lockedReservation.invoiceId}, createdByUserId=${createdByUserId})`,
      );

      return release;
    });
  }

  async get(id: string): Promise<Release> {
    const release = await this.releasesRepository.findById(id);
    if (!release) {
      throw new ReleaseNotFoundError(id);
    }

    return release;
  }
}
