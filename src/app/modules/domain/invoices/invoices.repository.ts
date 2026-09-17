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

// Only create/findById/list are implemented: the current API is POST/GET/GET-by-id only
// (CLAUDE.md sections 25-27), and external_reference has no uniqueness constraint in the
// schema (0005_create_invoices_table.ts), so there is no findByExternalReference/conflict
// lookup to perform yet. Update/delete are intentionally omitted - Invoices become
// auditable financial state once Reservations exist, and unrestricted CRUD editing was
// not requested for this step.
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
