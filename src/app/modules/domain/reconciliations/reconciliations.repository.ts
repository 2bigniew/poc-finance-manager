import { Inject, Injectable } from '@nestjs/common';
import { Kysely, Selectable } from 'kysely';
import { KYSELY_CONNECTION } from '@app/modules/database/database.constants';
import { Database } from '@app/modules/database/types/database.interface';
import { ReconciliationsTable } from '@app/modules/database/types/tables/reconciliations.table';
import { Reconciliation, ReconciliationStatus } from './reconciliation.entity';

const UNIQUE_VIOLATION = '23505';

// Exported so ReconciliationsService can recognize a UNIQUE(external_event_id) race
// AFTER the transaction that hit it has fully rolled back (see that service's comment
// on why recovery cannot happen inside the same transaction: once one statement fails,
// PostgreSQL aborts the whole transaction and every subsequent statement on it fails
// too with "current transaction is aborted" - there is no safe way to catch-and-requery
// on the same `trx` here).
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === UNIQUE_VIOLATION
  );
}

interface CreateReconciliationRow {
  id: string;
  batchId: string;
  externalEventId: string;
  programId: string;
  sourceVersion: number;
  totalCapacityUsd: string;
  effectiveAt: Date;
  status: ReconciliationStatus;
  createdAt: Date;
  updatedAt: Date;
}

// create/findById/findByExternalEventId/findByBatchId/listByProgram are the operations
// actually needed (CLAUDE.md section 17). There is no update/delete: a Reconciliation is
// an immutable audit record once created (BUSINESS.md).
@Injectable()
export class ReconciliationsRepository {
  constructor(
    @Inject(KYSELY_CONNECTION) private readonly db: Kysely<Database>,
  ) {}

  // Deliberately does NOT catch/recover from a UNIQUE(external_event_id) violation here
  // - that recovery (re-fetching the existing row) can only safely happen once the
  // transaction this insert belongs to has fully rolled back, which is the caller's
  // (ReconciliationsService's) responsibility, not this repository's (see
  // isUniqueViolation's comment above).
  async create(
    row: CreateReconciliationRow,
    executor: Kysely<Database> = this.db,
  ): Promise<Reconciliation> {
    const inserted = await executor
      .insertInto('reconciliations')
      .values(row)
      .returningAll()
      .executeTakeFirstOrThrow();

    return this.toEntity(inserted);
  }

  async findById(
    id: string,
    executor: Kysely<Database> = this.db,
  ): Promise<Reconciliation | null> {
    const row = await executor
      .selectFrom('reconciliations')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return row ? this.toEntity(row) : null;
  }

  async findByExternalEventId(
    externalEventId: string,
    executor: Kysely<Database> = this.db,
  ): Promise<Reconciliation | null> {
    const row = await executor
      .selectFrom('reconciliations')
      .selectAll()
      .where('externalEventId', '=', externalEventId)
      .executeTakeFirst();

    return row ? this.toEntity(row) : null;
  }

  async findByBatchId(
    batchId: string,
    executor: Kysely<Database> = this.db,
  ): Promise<Reconciliation[]> {
    const rows = await executor
      .selectFrom('reconciliations')
      .selectAll()
      .where('batchId', '=', batchId)
      .orderBy('createdAt', 'asc')
      .execute();

    return rows.map((row) => this.toEntity(row));
  }

  async listByProgram(
    programId: string,
    executor: Kysely<Database> = this.db,
  ): Promise<Reconciliation[]> {
    const rows = await executor
      .selectFrom('reconciliations')
      .selectAll()
      .where('programId', '=', programId)
      .orderBy('sourceVersion', 'asc')
      .execute();

    return rows.map((row) => this.toEntity(row));
  }

  private toEntity(row: Selectable<ReconciliationsTable>): Reconciliation {
    return {
      id: row.id,
      batchId: row.batchId,
      externalEventId: row.externalEventId,
      programId: row.programId,
      sourceVersion: row.sourceVersion,
      totalCapacityUsd: { amount: row.totalCapacityUsd, currency: 'USD' },
      effectiveAt: row.effectiveAt,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
