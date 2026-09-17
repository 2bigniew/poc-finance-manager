import { Kysely, sql } from 'kysely';

type MigrationDb = Kysely<Record<string, never>>;

// Money/FX precision used throughout this migration series: NUMERIC(19,4) for amounts
// (up to 15 integer digits, 4 decimal places) and NUMERIC(19,6) for FX rates (more decimal
// precision than plain currency amounts). Generous financial-grade precision; the Kysely
// contracts themselves stay unconstrained (`DecimalAmount = string`), so this choice lives
// only here. `treasury_version` uses `integer` rather than `bigint`: it's a per-Program
// monotonic counter (BUSINESS.md), never at risk of exceeding int4 range, and this avoids
// the globally configured int8->Number parser (kysely.provider.ts) entirely.
//
// id/createdAt/updatedAt are application-generated (see existing users/refresh_tokens
// migrations), so no DB-side defaults for those columns.
export async function up(db: MigrationDb): Promise<void> {
  await db.schema
    .createTable('programs')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('original_capacity_amount', 'numeric(19, 4)', (col) =>
      col.notNull(),
    )
    .addColumn('original_capacity_currency', 'text', (col) => col.notNull())
    .addColumn('total_capacity_usd_amount', 'numeric(19, 4)', (col) =>
      col.notNull(),
    )
    .addColumn('treasury_version', 'integer', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull())
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull())
    .addCheckConstraint(
      'programs_original_capacity_amount_non_negative',
      sql`original_capacity_amount >= 0`,
    )
    .addCheckConstraint(
      'programs_total_capacity_usd_amount_non_negative',
      sql`total_capacity_usd_amount >= 0`,
    )
    .addCheckConstraint(
      'programs_treasury_version_non_negative',
      sql`treasury_version >= 0`,
    )
    .execute();
}

export async function down(db: MigrationDb): Promise<void> {
  await db.schema.dropTable('programs').execute();
}
