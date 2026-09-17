import { Kysely, sql } from 'kysely';

type MigrationDb = Kysely<Record<string, never>>;

// This table is inbox/idempotency-processing state (INFRASTRUCTURE.md), not a "domain
// entity" in the BUSINESS.md sense, so it intentionally has no createdAt/updatedAt -
// matching the existing ReservationEventsTable Kysely contract and the conceptual
// inbox_events shape in INFRASTRUCTURE.md (received_at/processed_at only).
//
// `offset` is `text`, not `bigint`: see ReservationEventsTable.offset - avoids the app's
// global int8->Number parser (kysely.provider.ts) risking precision loss on 64-bit
// Kafka offsets.
//
// No foreign keys to programs/invoices/reservations: BUSINESS.md does not document a
// Kafka-driven flow for this table (Reservations are created via authenticated HTTP
// requests, per "Main Business Workflows"), and unlike the reservations/releases/
// reconciliations table sections, the migration task does not ask for FKs here. Adding
// them would invent referential semantics beyond what either document establishes - this
// gap should be resolved when the owning Kafka consumer/business flow is actually
// designed, not guessed here.
//
// reservation_events_external_event_id_unique is the required idempotency guarantee
// (CLAUDE.md: "same logical event cannot be applied repeatedly") - one dedicated table
// per domain already scopes deduplication the way INFRASTRUCTURE.md's generic
// `UNIQUE (consumer_group, event_id)` pattern would, without needing a redundant
// consumer_group column that isn't part of the current contract.
export async function up(db: MigrationDb): Promise<void> {
  await db.schema
    .createTable('reservation_events')
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
    .addColumn('received_at', 'timestamptz', (col) => col.notNull())
    .addColumn('processed_at', 'timestamptz')
    .addCheckConstraint(
      'reservation_events_external_event_id_not_empty',
      sql`external_event_id <> ''`,
    )
    .addCheckConstraint('reservation_events_topic_not_empty', sql`topic <> ''`)
    .execute();

  await db.schema
    .createIndex('reservation_events_external_event_id_unique')
    .on('reservation_events')
    .column('external_event_id')
    .unique()
    .execute();

  await db.schema
    .createIndex('reservation_events_reservation_id_idx')
    .on('reservation_events')
    .column('reservation_id')
    .execute();
}

export async function down(db: MigrationDb): Promise<void> {
  await db.schema.dropTable('reservation_events').execute();
}
