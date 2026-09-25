import { Inject, Injectable } from '@nestjs/common';
import { Kysely, Selectable } from 'kysely';
import { KYSELY_CONNECTION } from '@app/modules/database/database.constants';
import { Database } from '@app/modules/database/types/database.interface';
import { InvoicesTable } from '@app/modules/database/types/tables/invoices.table';
import { Money } from '@app/modules/domain/shared/money/money';
import { Invoice, InvoiceStatus } from './invoice.entity';

interface CreateInvoiceRow {
  id: string;
  externalReference: string;
  originalAmount: string;
  originalCurrency: string;
  convertedAmountUsd: string;
  conversionRate: string;
  conversionRateDate: Date;
  conversionSource: 'frankfurter.dev';
  status: InvoiceStatus;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

// Only create/findById/findByIdForUpdate/updateStatus/list are implemented: the current
// API is POST/GET/GET-by-id only (CLAUDE.md sections 25-27), and external_reference has
// no uniqueness constraint in the schema (0005_create_invoices_table.ts), so there is no
// findByExternalReference/conflict lookup to perform yet. There is no generic `update` -
// updateStatus exists specifically so Reservation creation (and later Release) can
// transition Invoice status atomically inside their own transaction
// (ARCHITECTURE.md: "transaction-aware Invoice persistence method").
@Injectable()
export class InvoicesRepository {
  constructor(
    @Inject(KYSELY_CONNECTION) private readonly db: Kysely<Database>,
  ) {}

  async create(
    row: CreateInvoiceRow,
    executor: Kysely<Database> = this.db,
  ): Promise<Invoice> {
    const inserted = await executor
      .insertInto('invoices')
      .values(row)
      .returningAll()
      .executeTakeFirstOrThrow();

    return this.toEntity(inserted);
  }

  async findById(
    id: string,
    executor: Kysely<Database> = this.db,
  ): Promise<Invoice | null> {
    const row = await executor
      .selectFrom('invoices')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return row ? this.toEntity(row) : null;
  }

  // Acquires a PostgreSQL row lock (SELECT ... FOR UPDATE), held for the remainder of
  // the caller's transaction - same contract as ProgramsRepository.findByIdForUpdate.
  // The executor is REQUIRED (no default): calling this outside an explicit transaction
  // would release the lock the instant this statement completes.
  async findByIdForUpdate(
    id: string,
    executor: Kysely<Database>,
  ): Promise<Invoice | null> {
    const row = await executor
      .selectFrom('invoices')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();

    return row ? this.toEntity(row) : null;
  }

  // Guards the UPDATE with `WHERE status = fromStatus` as a defensive backstop, on top
  // of the caller's own lock+revalidate step - if the row was somehow not in the
  // expected state, this updates zero rows instead of silently overwriting it.
  async updateStatus(
    id: string,
    fromStatus: InvoiceStatus,
    toStatus: InvoiceStatus,
    updatedAt: Date,
    executor: Kysely<Database>,
  ): Promise<Invoice | null> {
    const updated = await executor
      .updateTable('invoices')
      .set({ status: toStatus, updatedAt })
      .where('id', '=', id)
      .where('status', '=', fromStatus)
      .returningAll()
      .executeTakeFirst();

    return updated ? this.toEntity(updated) : null;
  }

  async list(executor: Kysely<Database> = this.db): Promise<Invoice[]> {
    const rows = await executor
      .selectFrom('invoices')
      .selectAll()
      .orderBy('createdAt', 'asc')
      .execute();

    return rows.map((row) => this.toEntity(row));
  }

  private toEntity(row: Selectable<InvoicesTable>): Invoice {
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
      externalReference: row.externalReference,
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
