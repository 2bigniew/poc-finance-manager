import { Inject, Injectable } from '@nestjs/common';
import { Kysely, Selectable } from 'kysely';
import { KYSELY_CONNECTION } from '@app/modules/database/database.constants';
import { Database } from '@app/modules/database/types/database.interface';
import { ProgramsTable } from '@app/modules/database/types/tables/programs.table';
import { Program } from './program.entity';

interface CreateProgramRow {
  id: string;
  name: string;
  originalCapacityAmount: string;
  originalCapacityCurrency: string;
  totalCapacityUsdAmount: string;
  treasuryVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

interface UpdateProgramRow {
  name?: string;
  updatedAt: Date;
}

interface ApplyReconciliationRow {
  totalCapacityUsdAmount: string;
  treasuryVersion: number;
  updatedAt: Date;
}

@Injectable()
export class ProgramsRepository {
  constructor(
    @Inject(KYSELY_CONNECTION) private readonly db: Kysely<Database>,
  ) {}

  async create(
    row: CreateProgramRow,
    executor: Kysely<Database> = this.db,
  ): Promise<Program> {
    const inserted = await executor
      .insertInto('programs')
      .values(row)
      .returningAll()
      .executeTakeFirstOrThrow();

    return this.toEntity(inserted);
  }

  async findById(
    id: string,
    executor: Kysely<Database> = this.db,
  ): Promise<Program | null> {
    const row = await executor
      .selectFrom('programs')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return row ? this.toEntity(row) : null;
  }

  // Acquires a PostgreSQL row lock (SELECT ... FOR UPDATE) that is held for the
  // remainder of the caller's transaction. The executor is a REQUIRED parameter with no
  // default on purpose: calling this with a plain (non-transactional) connection would
  // still execute, but the lock would be released the instant this single statement
  // completes, giving no real serialization guarantee. Callers MUST obtain `executor`
  // from `db.transaction().execute(async (trx) => ...)` (CODE_STYLE.md Transaction
  // Style). This is the reusable locking seam capacity-changing Reservation/Release
  // transactions will call later (CLAUDE.md: "Do not hide FOR UPDATE behavior inside
  // ordinary findById()").
  async findByIdForUpdate(
    id: string,
    executor: Kysely<Database>,
  ): Promise<Program | null> {
    const row = await executor
      .selectFrom('programs')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();

    return row ? this.toEntity(row) : null;
  }

  // Treasury-owned capacity replacement (BUSINESS.md Bulk Reconciliation: "replace
  // treasury-owned totalCapacityUsd, set treasuryVersion"). The executor is REQUIRED:
  // callers MUST already hold the row lock via findByIdForUpdate in the same
  // transaction (CLAUDE.md: "Program is locked before capacity-affecting state
  // changes"). `fromTreasuryVersion` guards the UPDATE with `WHERE treasury_version = ?`
  // as a defensive backstop on top of the caller's lock+revalidate step - mirrors
  // InvoicesRepository/ReservationsRepository.updateStatus's `WHERE status =
  // fromStatus` convention, just keyed on treasuryVersion instead of a status enum.
  async applyReconciliation(
    id: string,
    fromTreasuryVersion: number,
    row: ApplyReconciliationRow,
    executor: Kysely<Database>,
  ): Promise<Program | null> {
    const updated = await executor
      .updateTable('programs')
      .set(row)
      .where('id', '=', id)
      .where('treasuryVersion', '=', fromTreasuryVersion)
      .returningAll()
      .executeTakeFirst();

    return updated ? this.toEntity(updated) : null;
  }

  async list(executor: Kysely<Database> = this.db): Promise<Program[]> {
    const rows = await executor
      .selectFrom('programs')
      .selectAll()
      .orderBy('createdAt', 'asc')
      .execute();

    return rows.map((row) => this.toEntity(row));
  }

  async update(
    id: string,
    row: UpdateProgramRow,
    executor: Kysely<Database> = this.db,
  ): Promise<Program | null> {
    const updated = await executor
      .updateTable('programs')
      .set(row)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();

    return updated ? this.toEntity(updated) : null;
  }

  async delete(
    id: string,
    executor: Kysely<Database> = this.db,
  ): Promise<boolean> {
    const result = await executor
      .deleteFrom('programs')
      .where('id', '=', id)
      .executeTakeFirst();

    return result.numDeletedRows > 0n;
  }

  private toEntity(row: Selectable<ProgramsTable>): Program {
    return {
      id: row.id,
      name: row.name,
      originalCapacity: {
        amount: row.originalCapacityAmount,
        currency: row.originalCapacityCurrency,
      },
      totalCapacityUsd: {
        amount: row.totalCapacityUsdAmount,
        currency: 'USD',
      },
      treasuryVersion: row.treasuryVersion,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
