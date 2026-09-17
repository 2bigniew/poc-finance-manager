import { Kysely, sql } from 'kysely';

type MigrationDb = Kysely<Record<string, never>>;

// reservation_id is UNIQUE: BUSINESS.md - "A Reservation MUST NOT be released twice" -
// enforced database-side rather than only in service logic.
//
// program_id/invoice_id/reservation_id/created_by_user_id use RESTRICT: Releases are
// financial history and must survive their parent rows (CLAUDE.md FK Delete Behavior).
export async function up(db: MigrationDb): Promise<void> {
  await db.schema
    .createTable('releases')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('reservation_id', 'uuid', (col) =>
      col.notNull().unique().references('reservations.id').onDelete('restrict'),
    )
    .addColumn('invoice_id', 'uuid', (col) =>
      col.notNull().references('invoices.id').onDelete('restrict'),
    )
    .addColumn('program_id', 'uuid', (col) =>
      col.notNull().references('programs.id').onDelete('restrict'),
    )
    .addColumn('original_amount', 'numeric(19, 4)', (col) => col.notNull())
    .addColumn('original_currency', 'text', (col) => col.notNull())
    .addColumn('converted_amount_usd', 'numeric(19, 4)', (col) => col.notNull())
    .addColumn('conversion_rate', 'numeric(19, 6)', (col) => col.notNull())
    .addColumn('conversion_rate_date', 'timestamptz', (col) => col.notNull())
    .addColumn('conversion_source', 'text', (col) => col.notNull())
    .addColumn('created_by_user_id', 'uuid', (col) =>
      col.notNull().references('users.id').onDelete('restrict'),
    )
    .addColumn('created_at', 'timestamptz', (col) => col.notNull())
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull())
    .addCheckConstraint(
      'releases_original_amount_non_negative',
      sql`original_amount >= 0`,
    )
    .addCheckConstraint(
      'releases_converted_amount_usd_non_negative',
      sql`converted_amount_usd >= 0`,
    )
    .addCheckConstraint(
      'releases_conversion_rate_positive',
      sql`conversion_rate > 0`,
    )
    .addCheckConstraint(
      'releases_conversion_source_valid',
      sql`conversion_source in ('frankfurter.dev')`,
    )
    .execute();

  await db.schema
    .createIndex('releases_invoice_id_idx')
    .on('releases')
    .column('invoice_id')
    .execute();

  await db.schema
    .createIndex('releases_program_id_idx')
    .on('releases')
    .column('program_id')
    .execute();

  await db.schema
    .createIndex('releases_created_by_user_id_idx')
    .on('releases')
    .column('created_by_user_id')
    .execute();
}

export async function down(db: MigrationDb): Promise<void> {
  await db.schema.dropTable('releases').execute();
}
