import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Kysely } from 'kysely';
import { KYSELY_CONNECTION } from '@app/modules/database/database.constants';
import { Database } from '@app/modules/database/types/database.interface';
import { OutboxRepository } from '@app/modules/database/outbox/outbox.repository';
import { CurrencyExchangeService } from '@app/modules/domain/shared/money/currency-exchange.service';
import {
  compareDecimalStrings,
  subtractDecimal,
  USD_DECIMAL_SCALE,
} from '@app/modules/domain/shared/money/decimal-math';
import { InvoiceNotFoundError } from '@app/modules/domain/invoices/exceptions/invoice-not-found.error';
import { InvoicesService } from '@app/modules/domain/invoices/invoices.service';
import { ProgramNotFoundError } from '@app/modules/domain/programs/exceptions/program-not-found.error';
import { ProgramsService } from '@app/modules/domain/programs/programs.service';
import { CreateReservationDto } from './dto/create-reservation.dto';
import {
  buildReservationCreatedEvent,
  RESERVATION_EVENTS_TOPIC,
} from './events/reservation-created.event';
import { InsufficientCapacityError } from './exceptions/insufficient-capacity.error';
import { InvoiceNotReservableError } from './exceptions/invoice-not-reservable.error';
import { ReservationNotFoundError } from './exceptions/reservation-not-found.error';
import { Reservation } from './reservation.entity';
import { ReservationsRepository } from './reservations.repository';

@Injectable()
export class ReservationsService {
  private readonly logger = new Logger(ReservationsService.name);

  constructor(
    @Inject(KYSELY_CONNECTION) private readonly db: Kysely<Database>,
    private readonly reservationsRepository: ReservationsRepository,
    private readonly programsService: ProgramsService,
    private readonly invoicesService: InvoicesService,
    private readonly currencyExchangeService: CurrencyExchangeService,
    private readonly outboxRepository: OutboxRepository,
  ) {}

  async create(
    programId: string,
    dto: CreateReservationDto,
    createdByUserId: string,
  ): Promise<Reservation> {
    // Step 1: load + pre-validate the Invoice OUTSIDE any transaction/lock. This is a
    // cheap fail-fast check; the authoritative check happens again after the Program
    // lock is held (step 3), since the Invoice can change between now and then
    // (CLAUDE.md section 8: "do not rely only on pre-transaction validation").
    const invoice = await this.invoicesService.get(dto.invoiceId);
    if (invoice.status !== 'OPEN') {
      throw new InvoiceNotReservableError(invoice.id, invoice.status);
    }

    // Step 2: perform the reservation-time FX conversion BEFORE opening the
    // transaction/acquiring the Program lock (CLAUDE.md section 7/28: "DO NOT call
    // Frankfurter while holding the Program row lock"). This is the Reservation's OWN
    // FX snapshot - never the Invoice's stored conversion (BUSINESS.md section 2/3).
    const conversion = await this.currencyExchangeService.convertToUsd(
      invoice.originalMoney,
    );

    const reservationId = randomUUID();
    const now = new Date();

    // Step 3: short, DB-only critical section. Lock order: Program first, then Invoice
    // (CLAUDE.md section 10) - both locked/reloaded and revalidated inside the same
    // transaction as the writes, so the whole thing commits or rolls back atomically.
    return this.db.transaction().execute(async (trx) => {
      const program = await this.programsService.findByIdForUpdate(
        programId,
        trx,
      );
      if (!program) {
        throw new ProgramNotFoundError(programId);
      }

      const lockedInvoice = await this.invoicesService.findByIdForUpdate(
        dto.invoiceId,
        trx,
      );
      if (!lockedInvoice) {
        throw new InvoiceNotFoundError(dto.invoiceId);
      }
      if (lockedInvoice.status !== 'OPEN') {
        throw new InvoiceNotReservableError(
          lockedInvoice.id,
          lockedInvoice.status,
        );
      }

      const reservedCapacityUsd =
        await this.reservationsRepository.sumActiveByProgram(programId, trx);
      const availableCapacityUsd = subtractDecimal(
        program.totalCapacityUsd.amount,
        reservedCapacityUsd.amount,
        USD_DECIMAL_SCALE,
      );

      if (
        compareDecimalStrings(
          conversion.converted.amount,
          availableCapacityUsd,
        ) > 0
      ) {
        this.logger.warn(
          `Insufficient capacity for program ${programId}: requested ${conversion.converted.amount} USD, available ${availableCapacityUsd} USD`,
        );
        throw new InsufficientCapacityError(
          programId,
          conversion.converted.amount,
          availableCapacityUsd,
        );
      }

      const reservation = await this.reservationsRepository.create(
        {
          id: reservationId,
          programId,
          invoiceId: dto.invoiceId,
          originalAmount: conversion.original.amount,
          originalCurrency: conversion.original.currency,
          convertedAmountUsd: conversion.converted.amount,
          conversionRate: conversion.rate,
          conversionRateDate: conversion.rateDate,
          conversionSource: conversion.source,
          status: 'ACTIVE',
          createdByUserId,
          createdAt: now,
          updatedAt: now,
        },
        trx,
      );

      const updatedInvoice = await this.invoicesService.markReserved(
        dto.invoiceId,
        trx,
      );
      if (!updatedInvoice) {
        // The lock+revalidate above already confirmed status === 'OPEN', so this would
        // only happen if something changed the row through a path that bypassed the
        // lock - an invariant violation worth failing loudly on rather than silently
        // committing a Reservation without a matching Invoice transition.
        throw new InvoiceNotReservableError(
          dto.invoiceId,
          lockedInvoice.status,
        );
      }

      // Transactional outbox write, not a direct Kafka publish (CLAUDE.md "No Direct
      // Domain Publishing") - commits atomically with the Reservation/Invoice state
      // above. OutboxPublisherService picks this row up and publishes it later.
      const event = buildReservationCreatedEvent(reservation, now);
      await this.outboxRepository.create(
        {
          id: event.eventId,
          eventId: event.eventId,
          topic: RESERVATION_EVENTS_TOPIC,
          messageKey: programId,
          eventType: event.eventType,
          payload: event,
          createdAt: now,
          updatedAt: now,
        },
        trx,
      );

      this.logger.log(
        `Reservation created: ${reservation.id} (program=${programId}, invoice=${dto.invoiceId}, createdByUserId=${createdByUserId})`,
      );

      return reservation;
    });
  }

  async get(id: string): Promise<Reservation> {
    const reservation = await this.reservationsRepository.findById(id);
    if (!reservation) {
      throw new ReservationNotFoundError(id);
    }

    return reservation;
  }

  // Transaction-aware contracts for other modules' capacity-changing transactions
  // (currently Release) - ReservationsRepository stays private to this module
  // (ARCHITECTURE.md), so these narrow pass-throughs are how a caller-owned `trx`
  // participates in an atomic Reservation state transition. Both mirror
  // InvoicesService.findByIdForUpdate/markReserved exactly, including returning null on
  // failure (not found / precondition not met) rather than throwing a Release-specific
  // error: which typed error is appropriate is the caller's business decision, not this
  // module's (Reservations does not know Releases exists).
  async findByIdForUpdate(
    id: string,
    executor: Kysely<Database>,
  ): Promise<Reservation | null> {
    return this.reservationsRepository.findByIdForUpdate(id, executor);
  }

  async markReleased(
    id: string,
    executor: Kysely<Database>,
  ): Promise<Reservation | null> {
    return this.reservationsRepository.updateStatus(
      id,
      'ACTIVE',
      'RELEASED',
      new Date(),
      executor,
    );
  }
}
