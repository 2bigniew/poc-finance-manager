import { Inject, Injectable } from '@nestjs/common';
import { Kysely, Selectable } from 'kysely';
import { KYSELY_CONNECTION } from '@app/modules/database/database.constants';
import { Database } from '@app/modules/database/types/database.interface';
import { ReservationsTable } from '@app/modules/database/types/tables/reservations.table';
import { USD_DECIMAL_SCALE } from '@app/modules/domain/shared/money/decimal-math';
import { Money } from '@app/modules/domain/shared/money/money';
import { ReservationAlreadyExistsError } from './exceptions/reservation-already-exists.error';
import { Reservation, ReservationStatus } from './reservation.entity';

// Postgres SUM() over a NUMERIC(19,4) column already returns a properly-scaled result
// (e.g. '80.0000') for any non-empty set of rows - only the COALESCE fallback for the
// empty-set case needs to be formatted to the same scale explicitly, so callers never see
// an unpadded '0' next to an otherwise-scaled '80.0000' (Money.amount must have a
// consistent decimal representation regardless of how many rows matched).
const ZERO_AT_USD_SCALE = `0.${'0'.repeat(USD_DECIMAL_SCALE)}`;

const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === UNIQUE_VIOLATION
  );
}

interface CreateReservationRow {
  id: string;
  programId: string;
  invoiceId: string;
  originalAmount: string;
  originalCurrency: string;
  convertedAmountUsd: string;
  conversionRate: string;
  conversionRateDate: Date;
  conversionSource: 'frankfurter.dev';
  status: 'ACTIVE';
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

// create/findById/findByIdForUpdate/updateStatus/findActiveByInvoiceId/listByProgram/
// sumActiveByProgram are the operations actually needed by Reservation creation and
// Release (CLAUDE.md section 15). There is no generic update/delete: the only status
// transition (ACTIVE -> RELEASED) goes through updateStatus, driven by the Release
// domain action, not generic CRUD.
@Injectable()
export class ReservationsRepository {
  constructor(
    @Inject(KYSELY_CONNECTION) private readonly db: Kysely<Database>,
  ) {}

  // Maps the partial unique index violation (reservations_invoice_active_unique) to a
  // typed domain error rather than leaking the raw PostgreSQL constraint error
  // (CLAUDE.md section 19). This is the final authority under concurrency; the service
  // also checks the precondition before writing, but only this DB-level mapping is safe
  // against two transactions racing past that pre-check simultaneously.
  async create(
    row: CreateReservationRow,
    executor: Kysely<Database> = this.db,
  ): Promise<Reservation> {
    try {
      const inserted = await executor
        .insertInto('reservations')
        .values(row)
        .returningAll()
        .executeTakeFirstOrThrow();

      return this.toEntity(inserted);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ReservationAlreadyExistsError(row.invoiceId);
      }

      throw error;
    }
  }

  async findById(
    id: string,
    executor: Kysely<Database> = this.db,
  ): Promise<Reservation | null> {
    const row = await executor
      .selectFrom('reservations')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return row ? this.toEntity(row) : null;
  }

  // Acquires a PostgreSQL row lock (SELECT ... FOR UPDATE), held for the remainder of
  // the caller's transaction - same contract as ProgramsRepository/InvoicesRepository's
  // findByIdForUpdate. The executor is REQUIRED (no default): calling this outside an
  // explicit transaction would release the lock the instant this statement completes.
  // Used by ReleasesService to lock/reload/revalidate the Reservation before releasing
  // it (CLAUDE.md section 11).
  async findByIdForUpdate(
    id: string,
    executor: Kysely<Database>,
  ): Promise<Reservation | null> {
    const row = await executor
      .selectFrom('reservations')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();

    return row ? this.toEntity(row) : null;
  }

  // Guards the UPDATE with `WHERE status = fromStatus` as a defensive backstop, on top
  // of the caller's own lock+revalidate step - mirrors InvoicesRepository.updateStatus.
  // The only transition this step's callers use is ACTIVE -> RELEASED (Release).
  async updateStatus(
    id: string,
    fromStatus: ReservationStatus,
    toStatus: ReservationStatus,
    updatedAt: Date,
    executor: Kysely<Database>,
  ): Promise<Reservation | null> {
    const updated = await executor
      .updateTable('reservations')
      .set({ status: toStatus, updatedAt })
      .where('id', '=', id)
      .where('status', '=', fromStatus)
      .returningAll()
      .executeTakeFirst();

    return updated ? this.toEntity(updated) : null;
  }

  async findActiveByInvoiceId(
    invoiceId: string,
    executor: Kysely<Database> = this.db,
  ): Promise<Reservation | null> {
    const row = await executor
      .selectFrom('reservations')
      .selectAll()
      .where('invoiceId', '=', invoiceId)
      .where('status', '=', 'ACTIVE' satisfies ReservationStatus)
      .executeTakeFirst();

    return row ? this.toEntity(row) : null;
  }

  async listByProgram(
    programId: string,
    executor: Kysely<Database> = this.db,
  ): Promise<Reservation[]> {
    const rows = await executor
      .selectFrom('reservations')
      .selectAll()
      .where('programId', '=', programId)
      .orderBy('createdAt', 'asc')
      .execute();

    return rows.map((row) => this.toEntity(row));
  }

  // The single canonical implementation of BUSINESS.md's
  // `reservedCapacityUsd = SUM(active Reservation.convertedMoneyUsd)` - used both by
  // ReservationsService (inside the Program-locked transaction, via `executor`) and, via
  // ReservedCapacityPort, by ProgramsService's capacity-summary read path
  // (CLAUDE.md section 32: "Avoid duplicating the active-reservation SUM query in
  // multiple places"). Postgres performs the exact NUMERIC addition; the result is read
  // back as a decimal string, never converted through a JS number.
  async sumActiveByProgram(
    programId: string,
    executor: Kysely<Database> = this.db,
  ): Promise<Money> {
    const result = await executor
      .selectFrom('reservations')
      .select((eb) =>
        eb.fn
          .coalesce(
            eb.fn.sum<string>('convertedAmountUsd'),
            eb.val(ZERO_AT_USD_SCALE),
          )
          .as('total'),
      )
      .where('programId', '=', programId)
      .where('status', '=', 'ACTIVE' satisfies ReservationStatus)
      .executeTakeFirstOrThrow();

    return { amount: result.total, currency: 'USD' };
  }

  private toEntity(row: Selectable<ReservationsTable>): Reservation {
    const original: Money = {
      amount: row.originalAmount,
      currency: row.originalCurrency,
    };
    const converted: Money = {
      amount: row.convertedAmountUsd,
      currency: 'USD',
    };

    return {
      id: row.id,
      programId: row.programId,
      invoiceId: row.invoiceId,
      originalMoney: original,
      convertedMoneyUsd: converted,
      conversion: {
        original,
        converted,
        rate: row.conversionRate,
        rateDate: row.conversionRateDate,
        source: row.conversionSource,
      },
      status: row.status,
      createdByUserId: row.createdByUserId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
