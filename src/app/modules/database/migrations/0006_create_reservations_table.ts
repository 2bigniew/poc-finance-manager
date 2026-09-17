import { Kysely, sql } from 'kysely';

type MigrationDb = Kysely<Record<string, never>>;

// program_id/invoice_id/created_by_user_id use RESTRICT: Reservations are financial
// history and must survive their parent rows (CLAUDE.md FK Delete Behavior).
//
// reservations_invoice_active_unique is the CRITICAL invariant from BUSINESS.md ("The
// same Invoice MUST NOT have more than one active Reservation") - enforced with a partial
// unique index rather than relying only on a service-layer check.
//
// Additional indexes mirror the concrete query patterns called out in the migration task:
//   - reservations_program_active_idx supports the capacity calculation
//     `WHERE program_id = ? AND status = 'ACTIVE'` (reservedCapacityUsd in BUSINESS.md).
//   - reservations_invoice_id_idx / reservations_program_id_idx support general
//     (non-active-only) lookup by invoice/program.
//   - reservations_created_by_user_id_idx supports audit lookup by creator.
export async function up(db: MigrationDb): Promise<void> {
  await db.schema
    .createTable('reservations')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('program_id', 'uuid', (col) =>
      col.notNull().references('programs.id').onDelete('restrict'),
    )
    .addColumn('invoice_id', 'uuid', (col) =>
      col.notNull().references('invoices.id').onDelete('restrict'),
    )
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
      'reservations_original_amount_non_negative',
      sql`original_amount >= 0`,
    )
    .addCheckConstraint(
      'reservations_converted_amount_usd_non_negative',
      sql`converted_amount_usd >= 0`,
    )
    .addCheckConstraint(
      'reservations_conversion_rate_positive',
      sql`conversion_rate > 0`,
    )
    .addCheckConstraint(
      'reservations_conversion_source_valid',
      sql`conversion_source in ('frankfurter.dev')`,
    )
    .addCheckConstraint(
      'reservations_status_valid',
      sql`status in ('ACTIVE', 'RELEASED')`,
    )
    .execute();

  await db.schema
    .createIndex('reservations_invoice_active_unique')
    .on('reservations')
    .column('invoice_id')
    .unique()
    .where(sql.ref('status'), '=', 'ACTIVE')
    .execute();

  await db.schema
    .createIndex('reservations_program_active_idx')
    .on('reservations')
    .column('program_id')
    .where(sql.ref('status'), '=', 'ACTIVE')
    .execute();

  await db.schema
    .createIndex('reservations_invoice_id_idx')
    .on('reservations')
    .column('invoice_id')
    .execute();

  await db.schema
    .createIndex('reservations_program_id_idx')
    .on('reservations')
    .column('program_id')
    .execute();

  await db.schema
    .createIndex('reservations_created_by_user_id_idx')
    .on('reservations')
    .column('created_by_user_id')
    .execute();
}

export async function down(db: MigrationDb): Promise<void> {
  await db.schema.dropTable('reservations').execute();
}
