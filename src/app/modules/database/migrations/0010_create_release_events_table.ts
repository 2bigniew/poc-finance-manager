import { Kysely, sql } from 'kysely';

type MigrationDb = Kysely<Record<string, never>>;

// See 0009_create_reservation_events_table.ts for the reasoning behind: no
// createdAt/updatedAt (inbox/idempotency state, not a BUSINESS.md domain entity), `offset`
// as `text` (avoids the global int8->Number parser), no FKs to programs/invoices/
// reservations/releases (no documented Kafka-driven flow for this table in BUSINESS.md),
// and per-table UNIQUE(external_event_id) as the idempotency guarantee.
export async function up(db: MigrationDb): Promise<void> {
  await db.schema
    .createTable('release_events')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('external_event_id', 'text', (col) => col.notNull())
    .addColumn('topic', 'text', (col) => col.notNull())
    .addColumn('partition', 'integer', (col) => col.notNull())
    .addColumn('offset', 'text', (col) => col.notNull())
    .addColumn('event_type', 'text', (col) => col.notNull())
    .addColumn('payload', 'jsonb', (col) => col.notNull())
    .addColumn('program_id', 'uuid', (col) => col.notNull())
    .addColumn('invoice_id', 'uuid', (col) => col.notNull())
    .addColumn('reservation_id', 'uuid', (col) => col.notNull())
    .addColumn('release_id', 'uuid', (col) => col.notNull())
    .addColumn('received_at', 'timestamptz', (col) => col.notNull())
    .addColumn('processed_at', 'timestamptz')
    .addCheckConstraint(
      'release_events_external_event_id_not_empty',
      sql`external_event_id <> ''`,
    )
    .addCheckConstraint('release_events_topic_not_empty', sql`topic <> ''`)
    .execute();

  await db.schema
    .createIndex('release_events_external_event_id_unique')
    .on('release_events')
    .column('external_event_id')
    .unique()
    .execute();

  await db.schema
    .createIndex('release_events_release_id_idx')
    .on('release_events')
    .column('release_id')
    .execute();
}

export async function down(db: MigrationDb): Promise<void> {
  await db.schema.dropTable('release_events').execute();
}
