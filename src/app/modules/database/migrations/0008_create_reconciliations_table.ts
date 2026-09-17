import { Kysely, sql } from 'kysely';

type MigrationDb = Kysely<Record<string, never>>;

// program_id uses RESTRICT: Reconciliation history must survive its Program row
// (CLAUDE.md FK Delete Behavior; Reconciliations are audit history, not disposable state).
//
// reconciliations_external_event_id_unique assumes external_event_id identifies exactly
// one Program entry within one bulk reconciliation batch (ReconciliationEventsTable
// carries batchId/programId/sourceVersion alongside the same externalEventId field,
// consistent with BUSINESS.md's "each Program entry MUST be processed independently").
// This gives defense-in-depth alongside the reconciliation_events inbox table: even if a
// duplicate slipped past inbox dedup, it still cannot produce two `reconciliations` rows
// for the same event.
export async function up(db: MigrationDb): Promise<void> {
  await db.schema
    .createTable('reconciliations')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('batch_id', 'text', (col) => col.notNull())
    .addColumn('external_event_id', 'text', (col) => col.notNull())
    .addColumn('program_id', 'uuid', (col) =>
      col.notNull().references('programs.id').onDelete('restrict'),
    )
    .addColumn('source_version', 'integer', (col) => col.notNull())
    .addColumn('total_capacity_usd', 'numeric(19, 4)', (col) => col.notNull())
    .addColumn('effective_at', 'timestamptz', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull())
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull())
    .addCheckConstraint(
      'reconciliations_batch_id_not_empty',
      sql`batch_id <> ''`,
    )
    .addCheckConstraint(
      'reconciliations_external_event_id_not_empty',
      sql`external_event_id <> ''`,
    )
    .addCheckConstraint(
      'reconciliations_source_version_non_negative',
      sql`source_version >= 0`,
    )
    .addCheckConstraint(
      'reconciliations_total_capacity_usd_non_negative',
      sql`total_capacity_usd >= 0`,
    )
    .addCheckConstraint(
      'reconciliations_status_valid',
      sql`status in ('APPLIED', 'IGNORED_STALE', 'FAILED')`,
    )
    .execute();

  await db.schema
    .createIndex('reconciliations_external_event_id_unique')
    .on('reconciliations')
    .column('external_event_id')
    .unique()
    .execute();

  await db.schema
    .createIndex('reconciliations_program_source_version_idx')
    .on('reconciliations')
    .columns(['program_id', 'source_version'])
    .execute();

  await db.schema
    .createIndex('reconciliations_batch_id_idx')
    .on('reconciliations')
    .column('batch_id')
    .execute();
}

export async function down(db: MigrationDb): Promise<void> {
  await db.schema.dropTable('reconciliations').execute();
}
