import { Kysely, sql } from 'kysely';

type MigrationDb = Kysely<Record<string, never>>;

// See 0009_create_reservation_events_table.ts for the reasoning behind: no
// createdAt/updatedAt, `offset` as `text` (avoids the global int8->Number parser), and
// per-table UNIQUE(external_event_id) as the idempotency guarantee.
//
// Unlike reservation_events/release_events, no FK to programs.id is added here either:
// this is the Kafka-message-level inbox row for the bulk reconciliation flow
// (INFRASTRUCTURE.md's inbox pattern), written to record delivery *before* domain
// processing runs, so it must not be coupled to the Program row's lifecycle. The domain
// audit record in `reconciliations` (0008) is what carries the FK to programs.id.
//
// program_id + source_version index supports duplicate/stale-version detection
// (BUSINESS.md: "incoming sourceVersion <= Program.treasuryVersion -> ignore"). batch_id
// index supports batch-level lookup, since one Kafka message can contain many Program
// entries (BUSINESS.md Bulk Reconciliation).
export async function up(db: MigrationDb): Promise<void> {
  await db.schema
    .createTable('reconciliation_events')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('external_event_id', 'text', (col) => col.notNull())
    .addColumn('topic', 'text', (col) => col.notNull())
    .addColumn('partition', 'integer', (col) => col.notNull())
    .addColumn('offset', 'text', (col) => col.notNull())
    .addColumn('event_type', 'text', (col) => col.notNull())
    .addColumn('payload', 'jsonb', (col) => col.notNull())
    .addColumn('program_id', 'uuid', (col) => col.notNull())
    .addColumn('batch_id', 'text', (col) => col.notNull())
    .addColumn('source_version', 'integer', (col) => col.notNull())
    .addColumn('received_at', 'timestamptz', (col) => col.notNull())
    .addColumn('processed_at', 'timestamptz')
    .addCheckConstraint(
      'reconciliation_events_external_event_id_not_empty',
      sql`external_event_id <> ''`,
    )
    .addCheckConstraint(
      'reconciliation_events_topic_not_empty',
      sql`topic <> ''`,
    )
    .addCheckConstraint(
      'reconciliation_events_source_version_non_negative',
      sql`source_version >= 0`,
    )
    .execute();

  await db.schema
    .createIndex('reconciliation_events_external_event_id_unique')
    .on('reconciliation_events')
    .column('external_event_id')
    .unique()
    .execute();

  await db.schema
    .createIndex('reconciliation_events_program_source_version_idx')
    .on('reconciliation_events')
    .columns(['program_id', 'source_version'])
    .execute();

  await db.schema
    .createIndex('reconciliation_events_batch_id_idx')
    .on('reconciliation_events')
    .column('batch_id')
    .execute();
}

export async function down(db: MigrationDb): Promise<void> {
  await db.schema.dropTable('reconciliation_events').execute();
}
