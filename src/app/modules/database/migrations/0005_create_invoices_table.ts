import { Kysely, sql } from 'kysely';

type MigrationDb = Kysely<Record<string, never>>;

// created_by_user_id uses RESTRICT: Invoices are financial/audit history and must not be
// silently deleted because a User row disappears (CLAUDE.md FK Delete Behavior: "Default
// preference for financial/audit domain data: RESTRICT/NO ACTION").
//
// external_reference has a lookup index but no uniqueness constraint: neither
// InvoicesTable nor BUSINESS.md establishes global uniqueness for it, and the task
// explicitly warns against inventing uniqueness rules the existing design doesn't support.
//
// conversion_source is checked against the single currently-supported value
// ('frankfurter.dev', ConversionSource in money.types.ts) rather than left unconstrained -
// same treatment as `status`. Widening it is a normal future migration, exactly like
// adding a new status value would be.
export async function up(db: MigrationDb): Promise<void> {
  await db.schema
    .createTable('invoices')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('external_reference', 'text', (col) => col.notNull())
    .addColumn('original_amount', 'numeric(19, 4)', (col) => col.notNull())
    .addColumn('original_currency', 'text', (col) => col.notNull())
    .addColumn('converted_amount_usd', 'numeric(19, 4)', (col) => col.notNull())
    .addColumn('conversion_rate', 'numeric(19, 6)', (col) => col.notNull())
    .addColumn('conversion_rate_date', 'timestamptz', (col) => col.notNull())
    .addColumn('conversion_source', 'text', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull())
    .addColumn('created_by_user_id', 'uuid', (col) =>
      col.notNull().references('users.id').onDelete('restrict'),
    )
    .addColumn('created_at', 'timestamptz', (col) => col.notNull())
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull())
    .addCheckConstraint(
      'invoices_external_reference_not_empty',
      sql`external_reference <> ''`,
    )
    .addCheckConstraint(
      'invoices_original_amount_non_negative',
      sql`original_amount >= 0`,
    )
    .addCheckConstraint(
      'invoices_converted_amount_usd_non_negative',
      sql`converted_amount_usd >= 0`,
    )
    .addCheckConstraint(
      'invoices_conversion_rate_positive',
      sql`conversion_rate > 0`,
    )
    .addCheckConstraint(
      'invoices_conversion_source_valid',
      sql`conversion_source in ('frankfurter.dev')`,
    )
    .addCheckConstraint(
      'invoices_status_valid',
      sql`status in ('OPEN', 'RESERVED', 'REPAID')`,
    )
    .execute();

  await db.schema
    .createIndex('invoices_external_reference_idx')
    .on('invoices')
    .column('external_reference')
    .execute();

  await db.schema
    .createIndex('invoices_created_by_user_id_idx')
    .on('invoices')
    .column('created_by_user_id')
    .execute();
}

export async function down(db: MigrationDb): Promise<void> {
  await db.schema.dropTable('invoices').execute();
}
