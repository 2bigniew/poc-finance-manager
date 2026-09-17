import { Kysely, sql } from 'kysely';

type MigrationDb = Kysely<Record<string, never>>;

// id/createdAt/updatedAt are application-generated, matching every other table in this
// schema. `attempts` defaults to 0 DB-side since every newly written outbox row starts
// unpublished with zero publish attempts (INFRASTRUCTURE.md outbox_events: attempts).
//
// outbox_events_unpublished_idx is a partial index matching the publisher's expected scan
// (`WHERE published_at IS NULL`, oldest-first via created_at) rather than a full index -
// CLAUDE.md's own example for this table.
export async function up(db: MigrationDb): Promise<void> {
  await db.schema
    .createTable('outbox_events')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('event_id', 'text', (col) => col.notNull())
    .addColumn('topic', 'text', (col) => col.notNull())
    .addColumn('message_key', 'text')
    .addColumn('event_type', 'text', (col) => col.notNull())
    .addColumn('payload', 'jsonb', (col) => col.notNull())
    .addColumn('attempts', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull())
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull())
    .addColumn('published_at', 'timestamptz')
    .addCheckConstraint('outbox_events_event_id_not_empty', sql`event_id <> ''`)
    .addCheckConstraint('outbox_events_topic_not_empty', sql`topic <> ''`)
    .addCheckConstraint(
      'outbox_events_attempts_non_negative',
      sql`attempts >= 0`,
    )
    .execute();

  await db.schema
    .createIndex('outbox_events_event_id_unique')
    .on('outbox_events')
    .column('event_id')
    .unique()
    .execute();

  await db.schema
    .createIndex('outbox_events_unpublished_idx')
    .on('outbox_events')
    .column('created_at')
    .where(sql.ref('published_at'), 'is', null)
    .execute();
}

export async function down(db: MigrationDb): Promise<void> {
  await db.schema.dropTable('outbox_events').execute();
}
