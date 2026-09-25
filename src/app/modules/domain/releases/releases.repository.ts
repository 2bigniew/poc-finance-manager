import { Inject, Injectable } from '@nestjs/common';
import { Kysely, Selectable } from 'kysely';
import { KYSELY_CONNECTION } from '@app/modules/database/database.constants';
import { Database } from '@app/modules/database/types/database.interface';
import { ReleasesTable } from '@app/modules/database/types/tables/releases.table';
import { Money } from '@app/modules/domain/shared/money/money';
import { Release } from './release.entity';

const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === UNIQUE_VIOLATION
  );
}

interface CreateReleaseRow {
  id: string;
  reservationId: string;
  invoiceId: string;
  programId: string;
  originalAmount: string;
  originalCurrency: string;
  convertedAmountUsd: string;
  conversionRate: string;
  conversionRateDate: Date;
  conversionSource: 'frankfurter.dev';
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

// Only create/findById/findByReservationId are implemented - the operations actually
// needed by this step (CLAUDE.md section 18/36). There is no update/delete: a Release is
// an immutable audit record once created (BUSINESS.md).
@Injectable()
export class ReleasesRepository {
  constructor(
    @Inject(KYSELY_CONNECTION) private readonly db: Kysely<Database>,
  ) {}

  // Maps a UNIQUE(reservation_id) race into the already-committed Release row instead of
  // throwing - Release is an idempotent command, unlike Reservation creation (CLAUDE.md
  // section 15-17: "map the unique-constraint race into the existing Release result
  // rather than leaking a PostgreSQL error"). In practice the Program row lock held by
  // ReleasesService already serializes concurrent releases of the same Reservation
  // before either transaction reaches this insert (see the status revalidation in
  // releases.service.ts) - this catch is the final defense-in-depth layer, not the
  // primary mechanism, mirroring how ReservationsRepository.create defends against the
  // partial unique index race.
  async create(
    row: CreateReleaseRow,
    executor: Kysely<Database> = this.db,
  ): Promise<Release> {
    try {
      const inserted = await executor
        .insertInto('releases')
        .values(row)
        .returningAll()
        .executeTakeFirstOrThrow();

      return this.toEntity(inserted);
    } catch (error) {
      if (isUniqueViolation(error)) {
        const existing = await this.findByReservationId(
          row.reservationId,
          executor,
        );
        if (existing) {
          return existing;
        }
      }

      throw error;
    }
  }

  async findById(
    id: string,
    executor: Kysely<Database> = this.db,
  ): Promise<Release | null> {
    const row = await executor
      .selectFrom('releases')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return row ? this.toEntity(row) : null;
  }

  async findByReservationId(
    reservationId: string,
    executor: Kysely<Database> = this.db,
  ): Promise<Release | null> {
    const row = await executor
      .selectFrom('releases')
      .selectAll()
      .where('reservationId', '=', reservationId)
      .executeTakeFirst();

    return row ? this.toEntity(row) : null;
  }

  private toEntity(row: Selectable<ReleasesTable>): Release {
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
      reservationId: row.reservationId,
      invoiceId: row.invoiceId,
      programId: row.programId,
      originalMoney: original,
      convertedMoneyUsd: converted,
      conversion: {
        original,
        converted,
        rate: row.conversionRate,
        rateDate: row.conversionRateDate,
        source: row.conversionSource,
      },
      createdByUserId: row.createdByUserId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
